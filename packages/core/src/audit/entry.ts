import { createHash, sign, verify, type KeyObject } from "node:crypto";
import type { AuditEntry, UnsignedAuditEntry, Violation } from "../types.js";

const SIGNED_FIELDS = [
  "id", "seq", "ts", "kind", "agent", "vendor", "vendorNormalized", "rail",
  "amountMinor", "currency", "reason", "outcome", "txSig", "prevHash",
] as const;

export interface VerifyResult {
  ok: boolean;
  checked: number;
  failure?: { seq: number; reason: string };
}

function canonicalViolation(violation: Violation | null): unknown {
  if (violation === null) {
    return null;
  }
  const detail = violation.detail
    ? Object.keys(violation.detail).sort().map((key) => [key, violation.detail![key]])
    : null;
  return [violation.code, violation.message, detail];
}

export function canonicalize(entry: UnsignedAuditEntry): string {
  const ordered = SIGNED_FIELDS.map((field) => entry[field]);
  return JSON.stringify([...ordered, canonicalViolation(entry.violation)]);
}

export function hashEntry(entry: UnsignedAuditEntry): string {
  return createHash("sha256").update(canonicalize(entry), "utf8").digest("hex");
}

export function signHash(hash: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(hash, "utf8"), privateKey).toString("base64");
}

export function verifyEntry(entry: AuditEntry, publicKey: KeyObject): boolean {
  if (hashEntry(entry) !== entry.hash) {
    return false;
  }
  try {
    return verify(null, Buffer.from(entry.hash, "utf8"), publicKey, Buffer.from(entry.sig, "base64"));
  } catch {
    return false;
  }
}

export async function verifyAuditLog(
  entries: Iterable<AuditEntry> | AsyncIterable<AuditEntry>,
  publicKey: KeyObject,
): Promise<VerifyResult> {
  let expectedSeq = 0;
  let prevHash = "";
  let checked = 0;

  for await (const entry of entries as AsyncIterable<AuditEntry>) {
    if (entry.seq !== expectedSeq) {
      return { ok: false, checked, failure: { seq: entry.seq, reason: "sequence gap" } };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, checked, failure: { seq: entry.seq, reason: "chain broken" } };
    }
    if (hashEntry(entry) !== entry.hash) {
      return { ok: false, checked, failure: { seq: entry.seq, reason: "content modified" } };
    }
    if (!verifyEntry(entry, publicKey)) {
      return { ok: false, checked, failure: { seq: entry.seq, reason: "invalid signature" } };
    }
    prevHash = entry.hash;
    expectedSeq++;
    checked++;
  }

  return { ok: true, checked };
}

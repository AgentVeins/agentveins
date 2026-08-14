import { createHash, sign, verify, type KeyObject } from "node:crypto";
import type { AuditEntry, PaymentError, UnsignedAuditEntry, Violation } from "../types.js";

const SIGNED_FIELDS = [
  "id", "logId", "seq", "ts", "kind", "agent", "vendor", "vendorNormalized", "rail",
  "amountMinor", "currency", "reason", "outcome", "txSig", "prevHash",
] as const;

const SIG_DOMAIN_PREFIX = "agentveins.audit.v1\n";

export interface VerifyResult {
  ok: boolean;
  checked: number;
  failure?: { seq: number; reason: string };
}

export interface VerifyOptions {
  logId?: string;
  anchor?: { seq: number; hash: string };
}

function canonicalViolation(violation: Violation | null): unknown {
  if (violation == null) {
    return null;
  }
  const detail = violation.detail
    ? Object.keys(violation.detail).sort().map((key) => [key, violation.detail![key]])
    : null;
  return [violation.code, violation.message, detail];
}

function canonicalError(error: PaymentError | null | undefined): unknown {
  if (error == null) {
    return null;
  }
  return [error.code, error.message, error.txSig ?? null];
}

export function canonicalize(entry: UnsignedAuditEntry): string {
  const ordered = SIGNED_FIELDS.map((field) => entry[field]);
  return JSON.stringify([...ordered, canonicalViolation(entry.violation), canonicalError(entry.error)]);
}

export function hashEntry(entry: UnsignedAuditEntry): string {
  return createHash("sha256").update(canonicalize(entry), "utf8").digest("hex");
}

export function signHash(hash: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(SIG_DOMAIN_PREFIX + hash, "utf8"), privateKey).toString("base64");
}

export function verifyEntry(entry: AuditEntry, publicKey: KeyObject): boolean {
  try {
    if (hashEntry(entry) !== entry.hash) {
      return false;
    }
    return verify(
      null,
      Buffer.from(SIG_DOMAIN_PREFIX + entry.hash, "utf8"),
      publicKey,
      Buffer.from(entry.sig, "base64"),
    );
  } catch {
    return false;
  }
}

export async function verifyAuditLog(
  entries: Iterable<AuditEntry> | AsyncIterable<AuditEntry>,
  publicKey: KeyObject,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  let expectedSeq = 0;
  let prevHash = "";
  let checked = 0;
  let expectedLogId = options?.logId;
  let anchorMatched = false;

  for await (const entry of entries as AsyncIterable<AuditEntry>) {
    try {
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
      if (expectedLogId === undefined) {
        expectedLogId = entry.logId;
      } else if (entry.logId !== expectedLogId) {
        const reason = options?.logId !== undefined ? "log identity mismatch" : "log identity changed";
        return { ok: false, checked, failure: { seq: entry.seq, reason } };
      }
      if (options?.anchor && entry.seq === options.anchor.seq) {
        if (entry.hash !== options.anchor.hash) {
          return { ok: false, checked, failure: { seq: options.anchor.seq, reason: "log truncated" } };
        }
        anchorMatched = true;
      }
    } catch {
      return { ok: false, checked, failure: { seq: expectedSeq, reason: "malformed entry" } };
    }

    prevHash = entry.hash;
    expectedSeq++;
    checked++;
  }

  if (options?.anchor && !anchorMatched) {
    return { ok: false, checked, failure: { seq: options.anchor.seq, reason: "log truncated" } };
  }

  return { ok: true, checked };
}

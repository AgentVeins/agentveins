import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashEntry, signHash, verifyAuditLog, verifyEntry } from "../src/audit/entry.js";
import type { AuditEntry, UnsignedAuditEntry } from "../src/types.js";

const keys = generateKeyPairSync("ed25519");

function unsigned(seq: number, prevHash: string, amountMinor: string, logId = "log-alpha"): UnsignedAuditEntry {
  return {
    id: `id-${seq}`,
    logId,
    seq,
    ts: `2026-08-13T10:0${seq}:00.000Z`,
    kind: "payment",
    agent: "demo-agent",
    vendor: "https://api.weather.com/forecast",
    vendorNormalized: "api.weather.com",
    rail: "solana",
    amountMinor,
    currency: "USDC",
    reason: "forecast query",
    outcome: "settled",
    violation: null,
    txSig: `sig-${seq}`,
    prevHash,
  };
}

function seal(entry: UnsignedAuditEntry): AuditEntry {
  const hash = hashEntry(entry);
  return { ...entry, hash, sig: signHash(hash, keys.privateKey) };
}

function chain(count: number, logId = "log-alpha"): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prevHash = "";
  for (let seq = 0; seq < count; seq++) {
    const entry = seal(unsigned(seq, prevHash, "50000", logId));
    entries.push(entry);
    prevHash = entry.hash;
  }
  return entries;
}

describe("hashEntry", () => {
  it("is stable regardless of key insertion order", () => {
    const a = unsigned(0, "", "50000");
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as UnsignedAuditEntry;
    expect(hashEntry(reordered)).toBe(hashEntry(a));
  });

  it("is stable regardless of violation detail key order", () => {
    const base = unsigned(0, "", "50000");
    const a: UnsignedAuditEntry = {
      ...base,
      outcome: "blocked",
      violation: { code: "budget_exceeded", message: "over", detail: { limit: "1", spent: "2" } },
    };
    const b: UnsignedAuditEntry = {
      ...base,
      outcome: "blocked",
      violation: { code: "budget_exceeded", message: "over", detail: { spent: "2", limit: "1" } },
    };
    expect(hashEntry(a)).toBe(hashEntry(b));
  });

  it("changes when any signed field changes", () => {
    expect(hashEntry(unsigned(0, "", "50000"))).not.toBe(hashEntry(unsigned(0, "", "50001")));
  });
});

describe("verifyEntry", () => {
  it("accepts a correctly signed entry", () => {
    expect(verifyEntry(seal(unsigned(0, "", "50000")), keys.publicKey)).toBe(true);
  });

  it("rejects an entry signed by a different key", () => {
    const other = generateKeyPairSync("ed25519");
    expect(verifyEntry(seal(unsigned(0, "", "50000")), other.publicKey)).toBe(false);
  });

  it("rejects a signature produced without the domain-separation prefix", () => {
    const entry = unsigned(0, "", "50000");
    const hash = hashEntry(entry);
    const bareSig = sign(null, Buffer.from(hash, "utf8"), keys.privateKey).toString("base64");
    const sealed: AuditEntry = { ...entry, hash, sig: bareSig };
    expect(verifyEntry(sealed, keys.publicKey)).toBe(false);
  });
});

describe("verifyAuditLog", () => {
  it("accepts an intact chain", async () => {
    const result = await verifyAuditLog(chain(4), keys.publicKey);
    expect(result).toEqual({ ok: true, checked: 4 });
  });

  it("accepts an empty log", async () => {
    const result = await verifyAuditLog([], keys.publicKey);
    expect(result).toEqual({ ok: true, checked: 0 });
  });

  it("detects an edited amount", async () => {
    const entries = chain(4);
    entries[2] = { ...entries[2]!, amountMinor: "1" };
    const result = await verifyAuditLog(entries, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ seq: 2, reason: "content modified" });
  });

  it("detects a deleted entry", async () => {
    const entries = chain(4);
    entries.splice(2, 1);
    const result = await verifyAuditLog(entries, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("sequence gap");
  });

  it("detects reordered entries", async () => {
    const entries = chain(4);
    [entries[1], entries[2]] = [entries[2]!, entries[1]!];
    const result = await verifyAuditLog(entries, keys.publicKey);
    expect(result.ok).toBe(false);
  });

  it("detects a forged entry appended with the wrong key", async () => {
    const entries = chain(3);
    const forger = generateKeyPairSync("ed25519");
    const forged = unsigned(3, entries[2]!.hash, "50000");
    const hash = hashEntry(forged);
    entries.push({ ...forged, hash, sig: signHash(hash, forger.privateKey) });
    const result = await verifyAuditLog(entries, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ seq: 3, reason: "invalid signature" });
  });

  it("detects a broken chain link", async () => {
    const entries = chain(3);
    const tampered = { ...entries[1]!, prevHash: "0".repeat(64) };
    entries[1] = { ...tampered, hash: hashEntry(tampered), sig: signHash(hashEntry(tampered), keys.privateKey) };
    const result = await verifyAuditLog(entries, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ seq: 1, reason: "chain broken" });
  });

  it("rejects an entry substituted from a log with a different logId", async () => {
    const entriesAlpha = chain(4, "log-alpha");
    const entriesBeta = chain(4, "log-beta");
    const mixed = [...entriesAlpha];
    mixed[2] = entriesBeta[2]!;
    const result = await verifyAuditLog(mixed, keys.publicKey);
    expect(result.ok).toBe(false);
  });

  it("fails with 'log truncated' when an anchor points past the last checked entry", async () => {
    const entries = chain(6);
    const anchorEntry = entries[5]!;
    const truncated = entries.slice(0, 3);
    const result = await verifyAuditLog(truncated, keys.publicKey, {
      anchor: { seq: anchorEntry.seq, hash: anchorEntry.hash },
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("log truncated");
  });

  // Documents a known limitation rather than hiding it: without an out-of-band
  // anchor, a strict prefix of a valid chain is itself indistinguishable from a
  // complete, untampered chain — tail truncation alone cannot be detected here.
  it("does not detect tail truncation when no anchor is supplied", async () => {
    const truncated = chain(6).slice(0, 3);
    const result = await verifyAuditLog(truncated, keys.publicKey);
    expect(result).toEqual({ ok: true, checked: 3 });
  });

  it("returns ok:false rather than throwing when a violation-bearing entry has its violation key deleted", async () => {
    const withViolation: UnsignedAuditEntry = {
      ...unsigned(0, "", "50000"),
      outcome: "blocked",
      violation: { code: "budget_exceeded", message: "over" },
    };
    const sealed = seal(withViolation);
    const malformed = { ...sealed } as Partial<AuditEntry>;
    delete malformed.violation;
    const result = await verifyAuditLog([malformed as AuditEntry], keys.publicKey);
    expect(result.ok).toBe(false);
  });

  it("round-trips a sealed entry carrying a non-null violation", async () => {
    const withViolation: UnsignedAuditEntry = {
      ...unsigned(0, "", "50000"),
      outcome: "blocked",
      violation: { code: "vendor_not_allowed", message: "not on allowlist", detail: { vendor: "evil.example" } },
    };
    const result = await verifyAuditLog([seal(withViolation)], keys.publicKey);
    expect(result).toEqual({ ok: true, checked: 1 });
  });
});

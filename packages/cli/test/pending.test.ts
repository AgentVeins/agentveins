import { memoryApprovalStore } from "@agentveins/core";
import type { AuditEntry } from "@agentveins/core";
import { describe, expect, it } from "vitest";
import { readPending } from "../src/pending.js";

const now = new Date("2026-08-30T12:00:00.000Z");

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "e1", logId: "log", seq: 0, ts: "2026-08-30T11:59:00.000Z", kind: "payment",
    agent: "research-agent", vendor: "https://api.weather.com/f", vendorNormalized: "api.weather.com",
    rail: "solana", amountMinor: "25000000", currency: "USDC", reason: "dataset",
    outcome: "blocked",
    violation: { code: "approval_required", message: "needs a human" },
    txSig: null, prevHash: "", hash: "h", sig: "s",
    ...overrides,
  };
}

describe("readPending", () => {
  it("reports a payment waiting on a person", async () => {
    const pending = await readPending([entry()], memoryApprovalStore([]), now);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.amountMinor).toBe(25_000_000n);
    expect(pending[0]?.attempts).toBe(1);
  });

  it("ignores blocks that are not approval requests", async () => {
    const budget = entry({ violation: { code: "budget_exceeded", message: "over" } });
    expect(await readPending([budget], memoryApprovalStore([]), now)).toHaveLength(0);
  });

  it("ignores settled payments", async () => {
    const settled = entry({ outcome: "settled", violation: null });
    expect(await readPending([settled], memoryApprovalStore([]), now)).toHaveLength(0);
  });

  it("folds an agent's retries into one decision", async () => {
    const pending = await readPending(
      [entry({ id: "a" }), entry({ id: "b", ts: "2026-08-30T11:59:30.000Z" })],
      memoryApprovalStore([]),
      now,
    );

    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(2);
    // The newest attempt is the one a human can quote back.
    expect(pending[0]?.auditId).toBe("b");
  });

  it("keeps different amounts apart, since an approval binds one exact amount", async () => {
    const pending = await readPending(
      [entry({ amountMinor: "25000000" }), entry({ id: "b", amountMinor: "25000001" })],
      memoryApprovalStore([]),
      now,
    );
    expect(pending).toHaveLength(2);
  });

  it("drops a payment an unspent approval already covers", async () => {
    const store = memoryApprovalStore([]);
    await store.grant({
      agent: "research-agent",
      vendorNormalized: "api.weather.com",
      amountMinor: 25_000_000n,
      expiresAt: "2026-08-30T12:30:00.000Z",
    });

    expect(await readPending([entry()], store, now)).toHaveLength(0);
  });

  it("still reports it when the covering approval has expired", async () => {
    const store = memoryApprovalStore([]);
    await store.grant({
      agent: "research-agent",
      vendorNormalized: "api.weather.com",
      amountMinor: 25_000_000n,
      expiresAt: "2026-08-30T11:00:00.000Z",
    });

    expect(await readPending([entry()], store, now)).toHaveLength(1);
  });

  it("still reports it when the covering approval was already spent", async () => {
    const store = memoryApprovalStore([]);
    const granted = await store.grant({
      agent: "research-agent",
      vendorNormalized: "api.weather.com",
      amountMinor: 25_000_000n,
      expiresAt: "2026-08-30T12:30:00.000Z",
    });
    await store.consume(granted.id);

    expect(await readPending([entry()], store, now)).toHaveLength(1);
  });

  it("puts the longest-waiting payment first", async () => {
    const older = entry({ id: "old", agent: "a", ts: "2026-08-30T10:00:00.000Z" });
    const newer = entry({ id: "new", agent: "b", ts: "2026-08-30T11:00:00.000Z" });

    const pending = await readPending([newer, older], memoryApprovalStore([]), now);
    expect(pending.map((p) => p.agent)).toEqual(["a", "b"]);
  });
});

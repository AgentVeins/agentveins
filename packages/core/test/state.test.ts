import { describe, expect, it } from "vitest";
import { applyEntry, emptyState, replay, spentInWindow, windowKey } from "../src/state.js";
import type { AuditEntry, AuditOutcome, Policy } from "../src/types.js";

const policy: Policy = {
  budgets: [{ period: "daily", limit: "0.50", currency: "USDC" }],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
};

function payment(seq: number, ts: string, amountMinor: string, outcome: AuditOutcome): AuditEntry {
  return {
    id: `id-${seq}`, logId: "log-alpha", seq, ts, kind: "payment", agent: "a",
    vendor: "api.weather.com", vendorNormalized: "api.weather.com", rail: "solana",
    amountMinor, currency: "USDC", reason: "r", outcome,
    violation: null, txSig: outcome === "settled" ? "sig" : null,
    prevHash: "", hash: `h-${seq}`, sig: "s",
  };
}

function control(seq: number, ts: string, action: "freeze" | "unfreeze"): AuditEntry {
  return {
    id: `id-${seq}`, logId: "log-alpha", seq, ts, kind: "control", agent: "a",
    vendor: "", vendorNormalized: "", rail: null,
    amountMinor: "0", currency: "USDC", reason: action, outcome: "settled",
    violation: null, txSig: null, prevHash: "", hash: `h-${seq}`, sig: "s",
  };
}

describe("windowKey", () => {
  it("keys daily windows by UTC calendar day", () => {
    expect(windowKey("daily", new Date("2026-08-13T23:59:59.999Z"))).toBe("2026-08-13");
    expect(windowKey("daily", new Date("2026-08-14T00:00:00.000Z"))).toBe("2026-08-14");
  });

  it("uses UTC even when the host is not", () => {
    expect(windowKey("daily", new Date("2026-08-13T18:30:00.000Z"))).toBe("2026-08-13");
  });

  it("has no window for per_tx", () => {
    expect(windowKey("per_tx", new Date())).toBe("");
  });
});

describe("applyEntry", () => {
  it("accrues only settled payments", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T10:00:00.000Z", "50000", "settled"));
    state = applyEntry(state, payment(1, "2026-08-13T10:01:00.000Z", "90000", "blocked"));
    state = applyEntry(state, payment(2, "2026-08-13T10:02:00.000Z", "90000", "failed"));
    expect(spentInWindow(state, "daily", new Date("2026-08-13T12:00:00.000Z"))).toBe(50_000n);
  });

  it("advances seq and prevHash on every entry regardless of outcome", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T10:00:00.000Z", "50000", "blocked"));
    expect(state.seq).toBe(1);
    expect(state.prevHash).toBe("h-0");
  });

  it("resets spend when the UTC day rolls over", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T23:59:00.000Z", "400000", "settled"));
    state = applyEntry(state, payment(1, "2026-08-14T00:01:00.000Z", "50000", "settled"));
    expect(spentInWindow(state, "daily", new Date("2026-08-14T00:02:00.000Z"))).toBe(50_000n);
  });

  it("reports zero spend once the stored window is stale", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T10:00:00.000Z", "400000", "settled"));
    expect(spentInWindow(state, "daily", new Date("2026-08-14T00:00:00.000Z"))).toBe(0n);
  });

  it("applies control entries to frozen state", () => {
    let state = emptyState(policy);
    state = applyEntry(state, control(0, "2026-08-13T10:00:00.000Z", "freeze"));
    expect(state.frozen).toBe(true);
    state = applyEntry(state, control(1, "2026-08-13T10:05:00.000Z", "unfreeze"));
    expect(state.frozen).toBe(false);
  });
});

describe("replay", () => {
  it("takes the initial frozen value from the policy", async () => {
    const frozenPolicy: Policy = { ...policy, killSwitch: { frozen: true } };
    expect((await replay(frozenPolicy, [])).frozen).toBe(true);
  });

  it("lets the log override the policy's frozen value", async () => {
    const state = await replay(policy, [control(0, "2026-08-13T10:00:00.000Z", "freeze")]);
    expect(state.frozen).toBe(true);
  });

  it("reconstructs spend and position across a mixed log", async () => {
    const state = await replay(policy, [
      payment(0, "2026-08-13T10:00:00.000Z", "50000", "settled"),
      payment(1, "2026-08-13T10:01:00.000Z", "50000", "settled"),
      control(2, "2026-08-13T10:02:00.000Z", "freeze"),
    ]);
    expect(spentInWindow(state, "daily", new Date("2026-08-13T11:00:00.000Z"))).toBe(100_000n);
    expect(state.frozen).toBe(true);
    expect(state.seq).toBe(3);
    expect(state.prevHash).toBe("h-2");
  });
});

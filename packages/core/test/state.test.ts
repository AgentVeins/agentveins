import { describe, expect, it } from "vitest";
import { CorruptLogError, applyEntry, emptyState, replay, spentInWindow, windowKey } from "../src/state.js";
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
    violation: null, error: null, txSig: outcome === "blocked" ? null : "sig",
    prevHash: "", hash: `h-${seq}`, sig: "s",
  };
}

function control(seq: number, ts: string, action: string): AuditEntry {
  return {
    id: `id-${seq}`, logId: "log-alpha", seq, ts, kind: "control", agent: "a",
    vendor: "", vendorNormalized: "", rail: null,
    amountMinor: "0", currency: "USDC", reason: action, outcome: "settled",
    violation: null, error: null, txSig: null, prevHash: "", hash: `h-${seq}`, sig: "s",
  };
}

describe("windowKey", () => {
  it("keys daily windows by UTC calendar day", () => {
    expect(windowKey("daily", new Date("2026-08-13T23:59:59.999Z"))).toBe("daily:2026-08-13");
    expect(windowKey("daily", new Date("2026-08-14T00:00:00.000Z"))).toBe("daily:2026-08-14");
  });

  it("uses UTC even when the host is not", () => {
    expect(windowKey("daily", new Date("2026-08-13T18:30:00.000Z"))).toBe("daily:2026-08-13");
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

  it("keeps a backdated settled entry in its own day without disturbing the later one", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-14T09:00:00.000Z", "490000", "settled"));
    state = applyEntry(state, payment(1, "2026-08-13T23:59:59.000Z", "10", "settled"));
    expect(spentInWindow(state, "daily", new Date("2026-08-14T09:01:00.000Z"))).toBe(490_000n);
    expect(spentInWindow(state, "daily", new Date("2026-08-13T23:59:59.500Z"))).toBe(10n);
  });

  // C1: a clock that runs fast writes an entry into tomorrow. Under one rolling window that
  // entry replaced the slot, and every later read against the true day found nothing.
  it("still enforces today after an entry lands in a future day", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-14T00:30:00.000Z", "10000", "settled"));
    state = applyEntry(state, payment(1, "2026-08-13T23:05:00.000Z", "400000", "settled"));
    expect(spentInWindow(state, "daily", new Date("2026-08-13T23:06:00.000Z"))).toBe(400_000n);
    expect(spentInWindow(state, "daily", new Date("2026-08-14T00:31:00.000Z"))).toBe(10_000n);
  });

  it("accrues an uncertain payment, which may have moved money, exactly like a settled one", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T10:00:00.000Z", "50000", "uncertain"));
    expect(spentInWindow(state, "daily", new Date("2026-08-13T12:00:00.000Z"))).toBe(50_000n);
  });

  for (const reason of ["", "FREEZE", "freeze ", "rotate-key"]) {
    it(`leaves frozen true for an unrecognized control reason ${JSON.stringify(reason)}`, () => {
      let state = emptyState(policy);
      state = applyEntry(state, control(0, "2026-08-13T10:00:00.000Z", "freeze"));
      state = applyEntry(state, control(1, "2026-08-13T10:05:00.000Z", reason));
      expect(state.frozen).toBe(true);
    });
  }

  it("accrues by the entry's UTC day even when ts carries a non-Z offset", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T23:00:00.000-05:00", "50000", "settled"));
    expect(spentInWindow(state, "daily", new Date("2026-08-14T00:00:00.000Z"))).toBe(50_000n);
  });

  it("throws CorruptLogError with the offending seq for a malformed ts", () => {
    const state = emptyState(policy);
    let caught: unknown;
    try {
      applyEntry(state, payment(3, "not-a-date-at-all", "50000", "settled"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CorruptLogError);
    expect((caught as CorruptLogError).seq).toBe(3);
  });

  for (const amountMinor of ["", "0x10", " 500 ", "-1", "1.5", "abc"]) {
    it(`throws CorruptLogError with the offending seq for a malformed amountMinor ${JSON.stringify(amountMinor)}`, () => {
      const state = emptyState(policy);
      let caught: unknown;
      try {
        applyEntry(state, payment(4, "2026-08-13T10:00:00.000Z", amountMinor, "settled"));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CorruptLogError);
      expect((caught as CorruptLogError).seq).toBe(4);
    });
  }

  it("counts seq internally even when the log carries duplicated seq values", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T10:00:00.000Z", "50000", "settled"));
    state = applyEntry(state, payment(0, "2026-08-13T10:01:00.000Z", "50000", "settled"));
    expect(state.seq).toBe(2);
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

describe("recent payments", () => {
  it("records a settled entry's time and amount", () => {
    const next = applyEntry(emptyState(policy), payment(0, "2026-09-02T10:00:00.000Z", "50000", "settled"));
    expect(next.recent).toEqual([{ ts: "2026-09-02T10:00:00.000Z", amountMinor: 50_000n }]);
  });

  it("records uncertain, which consumes budget, and ignores blocked and failed, which do not", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T10:00:00.000Z", "50000", "uncertain"));
    state = applyEntry(state, payment(1, "2026-08-13T10:01:00.000Z", "50000", "blocked"));
    state = applyEntry(state, payment(2, "2026-08-13T10:02:00.000Z", "50000", "failed"));
    expect(state.recent).toHaveLength(1);
  });

  it("prunes entries older than 24h before the newest entry, not before the wall clock", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-09-01T09:00:00.000Z", "50000", "settled"));
    state = applyEntry(state, payment(1, "2026-09-02T10:00:00.000Z", "50000", "settled"));
    expect(state.recent.map((r) => r.ts)).toEqual(["2026-09-02T10:00:00.000Z"]);
  });

  it("keeps an entry aged exactly 24h at the boundary", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-09-01T10:00:00.000Z", "50000", "settled"));
    state = applyEntry(state, payment(1, "2026-09-02T10:00:00.000Z", "50000", "settled"));
    expect(state.recent).toHaveLength(2);
  });

  it("does not let an out-of-order older entry evict newer ones", () => {
    let state = applyEntry(emptyState(policy), payment(0, "2026-09-02T10:00:00.000Z", "50000", "settled"));
    state = applyEntry(state, payment(1, "2026-09-02T09:00:00.000Z", "50000", "settled"));
    expect(state.recent).toHaveLength(2);
  });

  it("replays deterministically: same log, same recent list", async () => {
    const entries = [
      payment(0, "2026-09-02T10:00:00.000Z", "50000", "settled"),
      payment(1, "2026-09-02T10:01:00.000Z", "50000", "settled"),
    ];
    const a = await replay(policy, entries);
    const b = await replay(policy, entries);
    expect(a.recent).toEqual(b.recent);
  });
});

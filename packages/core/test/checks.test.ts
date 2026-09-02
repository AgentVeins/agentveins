import { describe, expect, it } from "vitest";
import { CHECKS, allowlistCheck, budgetCheck, killSwitchCheck, velocityCheck } from "../src/checks/index.js";
import { emptyState } from "../src/state.js";
import type { PaymentContext, Policy, SpendState, Violation } from "../src/types.js";

const policy: Policy = {
  budgets: [
    { period: "per_tx", limit: "0.10", currency: "USDC" },
    { period: "daily", limit: "0.50", currency: "USDC" },
  ],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
};

const now = new Date("2026-08-13T12:00:00.000Z");

function ctx(overrides: Partial<PaymentContext> = {}): PaymentContext {
  return {
    vendor: "https://api.weather.com/forecast",
    vendorNormalized: "api.weather.com",
    amountMinor: 50_000n,
    currency: "USDC",
    reason: "forecast query",
    now,
    ...overrides,
  };
}

function stateWithSpend(spentMinor: bigint): SpendState {
  return { ...emptyState(policy), windows: { "daily:2026-08-13": { start: "2026-08-13", spentMinor } } };
}

describe("killSwitchCheck", () => {
  it("passes when the agent is not frozen", () => {
    expect(killSwitchCheck(ctx(), policy, emptyState(policy))).toBeNull();
  });

  it("blocks when frozen", () => {
    const frozen = { ...emptyState(policy), frozen: true };
    expect(killSwitchCheck(ctx(), policy, frozen)?.code).toBe("kill_switch");
  });
});

describe("allowlistCheck", () => {
  it("passes an allowlisted vendor", () => {
    expect(allowlistCheck(ctx(), policy, emptyState(policy))).toBeNull();
  });

  it("blocks an unknown vendor without echoing it into the message", () => {
    const violation = allowlistCheck(ctx({ vendorNormalized: "evil.example" }), policy, emptyState(policy));
    expect(violation?.code).toBe("vendor_not_allowed");
    expect(violation?.message).not.toContain("evil.example");
    expect(violation?.detail?.vendor).toBe("evil.example");
  });
});

describe("budgetCheck", () => {
  it("passes a payment inside both limits", () => {
    expect(budgetCheck(ctx(), policy, emptyState(policy))).toBeNull();
  });

  it("blocks a payment over the per-transaction limit", () => {
    const violation = budgetCheck(ctx({ amountMinor: 250_000n }), policy, emptyState(policy));
    expect(violation?.code).toBe("budget_exceeded");
    expect(violation?.detail?.period).toBe("per_tx");
  });

  it("treats the limit as an inclusive maximum", () => {
    expect(budgetCheck(ctx({ amountMinor: 100_000n }), policy, emptyState(policy))).toBeNull();
    expect(budgetCheck(ctx({ amountMinor: 50_000n }), policy, stateWithSpend(450_000n))).toBeNull();
  });

  it("blocks when the daily budget would be exceeded", () => {
    const violation = budgetCheck(ctx({ amountMinor: 50_000n }), policy, stateWithSpend(460_000n));
    expect(violation?.code).toBe("budget_exceeded");
    expect(violation?.detail).toMatchObject({ period: "daily", limit: "0.50", spent: "0.460000" });
  });

  it("ignores spend recorded on a previous UTC day", () => {
    const stale: SpendState = {
      ...emptyState(policy),
      windows: { "daily:2026-08-12": { start: "2026-08-12", spentMinor: 500_000n } },
    };
    expect(budgetCheck(ctx(), policy, stale)).toBeNull();
  });
});

describe("CHECKS ordering", () => {
  it("reports kill_switch first when several rules would fire", () => {
    const frozen: SpendState = { ...stateWithSpend(500_000n), frozen: true };
    const hostile = ctx({ vendorNormalized: "evil.example", amountMinor: 900_000n });
    const first = CHECKS.map((check) => check(hostile, policy, frozen)).find((v) => v !== null);
    expect(first?.code).toBe("kill_switch");
  });

  it("reports vendor_not_allowed before budget_exceeded", () => {
    const hostile = ctx({ vendorNormalized: "evil.example", amountMinor: 900_000n });
    const first = CHECKS.map((check) => check(hostile, policy, emptyState(policy))).find((v) => v !== null);
    expect(first?.code).toBe("vendor_not_allowed");
  });

  it("contains exactly killSwitchCheck, allowlistCheck, budgetCheck, velocityCheck in that order", () => {
    expect(CHECKS).toEqual([killSwitchCheck, allowlistCheck, budgetCheck, velocityCheck]);
  });

  it("reports budget_exceeded when it is the only rule that fires", () => {
    const overBudget = ctx({ amountMinor: 250_000n });
    const first = CHECKS.map((check) => check(overBudget, policy, emptyState(policy))).find((v) => v !== null);
    expect(first?.code).toBe("budget_exceeded");
  });
});

describe("velocityCheck", () => {
  const vPolicy: Policy = { ...policy, velocity: [{ window: "10m", maxPayments: 2, maxAmount: "0.20" }] };

  function stateWith(recent: Array<{ ts: string; amountMinor: bigint }>): SpendState {
    return { ...emptyState(vPolicy), recent };
  }

  const inWindow = (minutesAgo: number, amountMinor = 50_000n) => ({
    ts: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    amountMinor,
  });

  it("passes when the policy has no velocity rules", () => {
    expect(velocityCheck(ctx(), policy, emptyState(policy))).toBeNull();
  });

  it("permits the payment that lands exactly on the count cap", () => {
    expect(velocityCheck(ctx(), vPolicy, stateWith([inWindow(1)]))).toBeNull();
  });

  it("blocks the payment that would exceed the count cap", () => {
    const violation = velocityCheck(ctx(), vPolicy, stateWith([inWindow(1), inWindow(2)]));
    expect(violation?.code).toBe("velocity_exceeded");
    expect(violation?.detail?.["window"]).toBe("10m");
  });

  it("stops counting an entry once it slides out of the window", () => {
    expect(velocityCheck(ctx(), vPolicy, stateWith([inWindow(1), inWindow(11)]))).toBeNull();
  });

  it("treats an entry aged exactly one window as gone", () => {
    expect(velocityCheck(ctx(), vPolicy, stateWith([inWindow(1), inWindow(10)]))).toBeNull();
  });

  it("permits an amount landing exactly on the cap and blocks one minor unit over", () => {
    expect(velocityCheck(ctx({ amountMinor: 150_000n }), vPolicy, stateWith([inWindow(1)]))).toBeNull();
    const violation = velocityCheck(ctx({ amountMinor: 150_001n }), vPolicy, stateWith([inWindow(1)]));
    expect(violation?.code).toBe("velocity_exceeded");
  });

  it("counts the candidate payment itself toward the amount cap", () => {
    const state = stateWith([inWindow(1, 199_000n)]);
    expect(velocityCheck(ctx({ amountMinor: 2_000n }), vPolicy, state)?.code).toBe("velocity_exceeded");
  });

  it("evaluates every rule and the strictest binds", () => {
    const two: Policy = {
      ...policy,
      velocity: [
        { window: "1h", maxAmount: "100.00" },
        { window: "10m", maxPayments: 1 },
      ],
    };
    const violation = velocityCheck(ctx(), two, stateWith([inWindow(1)]));
    expect(violation?.code).toBe("velocity_exceeded");
    expect(violation?.detail?.["window"]).toBe("10m");
  });

  it("over-counts under a backward clock rather than under-counting", () => {
    const violation = velocityCheck(
      ctx({ now: new Date(now.getTime() - 5 * 60_000) }),
      vPolicy,
      stateWith([inWindow(2), inWindow(3)]),
    );
    expect(violation?.code).toBe("velocity_exceeded");
  });

  it("runs last in CHECKS", () => {
    expect(CHECKS[CHECKS.length - 1]).toBe(velocityCheck);
  });

  it("reports budget, not velocity, when a payment would exceed both", () => {
    const state = stateWith([inWindow(1), inWindow(2)]);
    let violation: Violation | null = null;
    for (const check of CHECKS) {
      violation = check(ctx({ amountMinor: 150_000n }), vPolicy, state);
      if (violation !== null) break;
    }
    expect(violation?.code).toBe("budget_exceeded");
  });
});

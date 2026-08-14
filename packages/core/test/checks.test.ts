import { describe, expect, it } from "vitest";
import { CHECKS, allowlistCheck, budgetCheck, killSwitchCheck } from "../src/checks/index.js";
import { emptyState } from "../src/state.js";
import type { PaymentContext, Policy, SpendState } from "../src/types.js";

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
  return { ...emptyState(policy), windows: { daily: { start: "2026-08-13", spentMinor } } };
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
      windows: { daily: { start: "2026-08-12", spentMinor: 500_000n } },
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

  it("contains exactly killSwitchCheck, allowlistCheck, budgetCheck in that order", () => {
    expect(CHECKS).toEqual([killSwitchCheck, allowlistCheck, budgetCheck]);
  });

  it("reports budget_exceeded when it is the only rule that fires", () => {
    const overBudget = ctx({ amountMinor: 250_000n });
    const first = CHECKS.map((check) => check(overBudget, policy, emptyState(policy))).find((v) => v !== null);
    expect(first?.code).toBe("budget_exceeded");
  });
});

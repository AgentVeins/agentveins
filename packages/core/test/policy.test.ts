import { describe, expect, it } from "vitest";
import { validatePolicy } from "../src/policy.js";
import type { Policy } from "../src/types.js";

function valid(): Policy {
  return {
    budgets: [
      { period: "daily", limit: "0.50", currency: "USDC" },
      { period: "per_tx", limit: "0.10", currency: "USDC" },
    ],
    vendors: { mode: "allowlist", entries: ["api.weather.com"] },
    killSwitch: { frozen: false },
  };
}

describe("validatePolicy", () => {
  it("accepts a well-formed policy", () => {
    expect(() => validatePolicy(valid())).not.toThrow();
  });

  it("rejects an empty recipient allowlist", () => {
    const p = valid();
    p.recipients = { mode: "allowlist", entries: [] };
    expect(() => validatePolicy(p)).toThrow(/recipient/);
  });

  it("rejects a blank recipient entry", () => {
    const p = valid();
    p.recipients = { mode: "allowlist", entries: ["   "] };
    expect(() => validatePolicy(p)).toThrow(/recipient/);
  });

  it("rejects an unknown budget period", () => {
    const p = valid();
    (p.budgets[0] as { period: string }).period = "weekly";
    expect(() => validatePolicy(p)).toThrow(/unknown budget period/);
  });

  it("rejects duplicate budget periods", () => {
    const p = valid();
    p.budgets = [
      { period: "daily", limit: "1.00", currency: "USDC" },
      { period: "daily", limit: "2.00", currency: "USDC" },
    ];
    expect(() => validatePolicy(p)).toThrow(/duplicate budget period/);
  });

  it("rejects an empty budget list", () => {
    const p = valid();
    p.budgets = [];
    expect(() => validatePolicy(p)).toThrow(/non-empty/);
  });

  it("rejects unparseable, negative, and over-precise limits", () => {
    for (const limit of ["abc", "-1.00", "0.0000001"]) {
      const p = valid();
      p.budgets = [{ period: "daily", limit, currency: "USDC" }];
      expect(() => validatePolicy(p), limit).toThrow(RangeError);
    }
  });

  it("rejects an unsupported currency", () => {
    const p = valid();
    (p.budgets[0] as { currency: string }).currency = "EUR";
    expect(() => validatePolicy(p)).toThrow(/unsupported currency/);
  });

  it("rejects allowlist mode with no entries", () => {
    const p = valid();
    p.vendors.entries = [];
    expect(() => validatePolicy(p)).toThrow(/at least one vendor/);
  });

  it("rejects a non-string vendor entry", () => {
    const p = valid();
    p.vendors.entries = [123 as unknown as string];
    expect(() => validatePolicy(p)).toThrow(RangeError);
  });

  it("rejects an empty-string vendor entry", () => {
    const p = valid();
    p.vendors.entries = ["   "];
    expect(() => validatePolicy(p)).toThrow(RangeError);
  });

  it("rejects a non-boolean kill switch", () => {
    const p = valid();
    (p.killSwitch as { frozen: unknown }).frozen = "yes";
    expect(() => validatePolicy(p)).toThrow(TypeError);
  });
});

describe("approval policy", () => {
  it("accepts a well-formed threshold", () => {
    expect(() => validatePolicy({ ...valid(), approvals: { above: "5.00" } })).not.toThrow();
  });

  it("accepts a policy with no approvals at all", () => {
    expect(() => validatePolicy(valid())).not.toThrow();
  });

  it("rejects a threshold that is not an object", () => {
    expect(() => validatePolicy({ ...valid(), approvals: "5.00" as never })).toThrow(RangeError);
  });

  it("rejects an unparseable threshold", () => {
    expect(() => validatePolicy({ ...valid(), approvals: { above: "five" } })).toThrow();
  });

  it("rejects a negative threshold, which parseAmount refuses as a non-decimal", () => {
    expect(() => validatePolicy({ ...valid(), approvals: { above: "-1.00" } })).toThrow(/non-negative decimal/);
  });
});

describe("velocity policy", () => {
  it("accepts count, amount, and both on one rule", () => {
    expect(() => validatePolicy({ ...valid(), velocity: [{ window: "10m", maxPayments: 20 }] })).not.toThrow();
    expect(() => validatePolicy({ ...valid(), velocity: [{ window: "1h", maxAmount: "5.00" }] })).not.toThrow();
    expect(() =>
      validatePolicy({ ...valid(), velocity: [{ window: "10m", maxPayments: 20, maxAmount: "5.00" }] }),
    ).not.toThrow();
  });

  it("accepts several rules", () => {
    expect(() =>
      validatePolicy({
        ...valid(),
        velocity: [
          { window: "10m", maxPayments: 20 },
          { window: "1h", maxAmount: "5.00" },
        ],
      }),
    ).not.toThrow();
  });

  it("refuses a rule with neither cap, which would govern nothing", () => {
    expect(() => validatePolicy({ ...valid(), velocity: [{ window: "10m" }] })).toThrow(RangeError);
  });

  it("refuses an empty array; omit the field instead", () => {
    expect(() => validatePolicy({ ...valid(), velocity: [] })).toThrow(RangeError);
  });

  it("refuses a window over 24h — that is a budget in disguise", () => {
    expect(() => validatePolicy({ ...valid(), velocity: [{ window: "25h", maxPayments: 5 }] })).toThrow(/24h/);
    expect(() => validatePolicy({ ...valid(), velocity: [{ window: "24h", maxPayments: 5 }] })).not.toThrow();
  });

  it("refuses malformed windows and caps", () => {
    expect(() => validatePolicy({ ...valid(), velocity: [{ window: "soon", maxPayments: 5 }] })).toThrow();
    expect(() => validatePolicy({ ...valid(), velocity: [{ window: "10m", maxPayments: 0 }] })).toThrow(RangeError);
    expect(() => validatePolicy({ ...valid(), velocity: [{ window: "10m", maxPayments: 2.5 }] })).toThrow(RangeError);
    expect(() => validatePolicy({ ...valid(), velocity: [{ window: "10m", maxAmount: "zero" }] })).toThrow();
    expect(() => validatePolicy({ ...valid(), velocity: [{ window: "10m", maxAmount: "0" }] })).toThrow(RangeError);
  });
});

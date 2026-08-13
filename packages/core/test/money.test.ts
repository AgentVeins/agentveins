import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount } from "../src/money.js";

describe("parseAmount", () => {
  it("parses whole and fractional amounts to 6-decimal minor units", () => {
    expect(parseAmount("25.00")).toBe(25_000_000n);
    expect(parseAmount("0.05")).toBe(50_000n);
    expect(parseAmount("1")).toBe(1_000_000n);
    expect(parseAmount("0.000001")).toBe(1n);
    expect(parseAmount("0")).toBe(0n);
  });

  it("trims surrounding whitespace", () => {
    expect(parseAmount("  1.5  ")).toBe(1_500_000n);
  });

  it("rejects anything that is not a plain non-negative decimal", () => {
    for (const bad of ["", "   ", "abc", "1e3", "-1.00", "1.", ".5", "1,000", "NaN", "Infinity"]) {
      expect(() => parseAmount(bad), bad).toThrow(RangeError);
    }
  });

  it("rejects more precision than the currency has", () => {
    expect(() => parseAmount("0.0000001")).toThrow(RangeError);
  });

  it("rejects non-string input", () => {
    expect(() => parseAmount(5 as unknown as string)).toThrow(TypeError);
  });
});

describe("formatAmount", () => {
  it("renders minor units as a decimal string", () => {
    expect(formatAmount(25_000_000n)).toBe("25.000000");
    expect(formatAmount(50_000n)).toBe("0.050000");
    expect(formatAmount(0n)).toBe("0.000000");
    expect(formatAmount(1n)).toBe("0.000001");
  });

  it("round-trips through parseAmount", () => {
    for (const minor of [0n, 1n, 50_000n, 25_000_000n, 999_999_999_999n]) {
      expect(parseAmount(formatAmount(minor))).toBe(minor);
    }
  });
});

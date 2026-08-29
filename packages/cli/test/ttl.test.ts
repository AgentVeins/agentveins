import { describe, expect, it } from "vitest";
import { parseTtl } from "../src/ttl.js";

describe("parseTtl", () => {
  it("reads each unit", () => {
    expect(parseTtl("30s")).toBe(30_000);
    expect(parseTtl("15m")).toBe(900_000);
    expect(parseTtl("2h")).toBe(7_200_000);
    expect(parseTtl("1d")).toBe(86_400_000);
  });

  it("refuses a bare number rather than guessing minutes or seconds", () => {
    expect(() => parseTtl("15")).toThrow(RangeError);
  });

  it("refuses zero and nonsense", () => {
    expect(() => parseTtl("0m")).toThrow(RangeError);
    expect(() => parseTtl("soon")).toThrow(RangeError);
  });

  it("caps a grant at seven days", () => {
    expect(parseTtl("7d")).toBe(7 * 86_400_000);
    expect(() => parseTtl("8d")).toThrow(/7d/);
  });
});

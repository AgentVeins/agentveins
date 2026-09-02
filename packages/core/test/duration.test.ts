import { describe, expect, it } from "vitest";
import { parseDuration } from "../src/duration.js";

const DAY = 86_400_000;

describe("parseDuration", () => {
  it("reads each unit", () => {
    expect(parseDuration("30s", DAY, "window")).toBe(30_000);
    expect(parseDuration("10m", DAY, "window")).toBe(600_000);
    expect(parseDuration("2h", DAY, "window")).toBe(7_200_000);
    expect(parseDuration("1d", DAY, "window")).toBe(DAY);
  });

  it("refuses a bare number rather than guessing the unit", () => {
    expect(() => parseDuration("15", DAY, "window")).toThrow(RangeError);
  });

  it("refuses zero, negatives-by-format, and nonsense", () => {
    expect(() => parseDuration("0m", DAY, "window")).toThrow(RangeError);
    expect(() => parseDuration("-5m", DAY, "window")).toThrow(RangeError);
    expect(() => parseDuration("soon", DAY, "window")).toThrow(RangeError);
  });

  it("enforces the ceiling it was given, inclusively", () => {
    expect(parseDuration("24h", DAY, "window")).toBe(DAY);
    expect(() => parseDuration("25h", DAY, "window")).toThrow(/window/);
  });

  it("names the field in every error, since callers have different fields", () => {
    expect(() => parseDuration("nope", DAY, "velocity window")).toThrow(/velocity window/);
  });
});

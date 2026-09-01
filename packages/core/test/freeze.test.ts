import { describe, expect, it } from "vitest";
import { deepFreeze } from "../src/freeze.js";

describe("deepFreeze", () => {
  it("freezes a nested object", () => {
    const value = deepFreeze({ outer: { inner: "x" } });
    expect(() => {
      (value.outer as { inner: string }).inner = "y";
    }).toThrow();
    expect(value.outer.inner).toBe("x");
  });

  it("freezes an array reachable from the object", () => {
    const value = deepFreeze({ items: ["a", "b"] });
    expect(() => {
      (value.items as string[]).push("c");
    }).toThrow();
    expect(value.items).toEqual(["a", "b"]);
  });

  it("leaves an already-frozen value frozen without throwing", () => {
    const inner = Object.freeze({ x: 1 });
    expect(() => deepFreeze({ inner })).not.toThrow();
    expect(Object.isFrozen(inner)).toBe(true);
  });
});

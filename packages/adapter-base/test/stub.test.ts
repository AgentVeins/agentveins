import { describe, expect, it } from "vitest";
import { baseAdapter } from "../src/index.js";

describe("baseAdapter", () => {
  it("throws at construction rather than pretending to work", () => {
    expect(() => baseAdapter({ rpcUrl: "https://example.invalid" })).toThrow(/not implemented/i);
  });
});

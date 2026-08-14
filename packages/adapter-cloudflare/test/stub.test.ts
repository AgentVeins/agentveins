import { describe, expect, it } from "vitest";
import { cloudflareAdapter } from "../src/index.js";

describe("cloudflareAdapter", () => {
  it("throws at construction rather than pretending to work", () => {
    expect(() => cloudflareAdapter({ walletHandle: "example-handle" })).toThrow(/not implemented/i);
  });
});

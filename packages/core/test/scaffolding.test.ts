import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("scaffolding", () => {
  it("exports a version and compiles under strict mode", () => {
    expect(VERSION).toBe("0.0.1");
  });
});

import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("scaffolding", () => {
  // VERSION is a literal because tsconfig sets rootDir to src, which puts
  // package.json outside the compilation and out of reach of library code.
  it("exports a version that matches package.json", async () => {
    const manifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const { version } = JSON.parse(manifest) as { version: string };
    expect(VERSION).toBe(version);
  });
});

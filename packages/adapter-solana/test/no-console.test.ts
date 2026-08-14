import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// "types": [] does not keep node's global `console` out of this package: undici-types, pulled
// in transitively by @solana/kit, references all of @types/node. This test enforces the rule
// the compiler cannot. Paths are relative to the repo root, which is vitest's cwd.
const srcDir = "packages/adapter-solana/src";

describe("library code", () => {
  it("never reaches for console", async () => {
    const files = (await readdir(srcDir)).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"),
    );
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      const source = await readFile(`${srcDir}/${name}`, "utf8");
      expect(source, `${name} must not use console`).not.toMatch(/\bconsole\s*\./);
    }
  });
});

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// "types": [] does not keep node's global `console` out of this package: undici-types, pulled
// in transitively by @solana/kit, references all of @types/node. This test enforces the rule
// the compiler cannot. The directory resolves from this file rather than from the process
// cwd, so the scan finds the same sources however vitest was invoked.
const srcDir = new URL("../src/", import.meta.url);

async function listTsFiles(dir: string | URL): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"),
  );
}

describe("library code", () => {
  it("never reaches for console", async () => {
    const files = await listTsFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      const source = await readFile(new URL(name, srcDir), "utf8");
      expect(source, `${name} must not use console`).not.toMatch(/\bconsole\s*\./);
    }
  });

  it("scans nested directories, not just the top level", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "no-console-fixture-"));
    try {
      await mkdir(join(fixture, "nested", "deeper"), { recursive: true });
      const nestedFile = join("nested", "deeper", "leaf.ts");
      await writeFile(join(fixture, nestedFile), "export const value = 1;\n");

      const files = await listTsFiles(fixture);

      expect(files).toContain(nestedFile);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

import { readFile, rename, writeFile } from "node:fs/promises";
import type { Anchor, AnchorStore } from "../types.js";

export function memoryAnchorStore(seed: Anchor | null = null): AnchorStore {
  let current: Anchor | null = seed;
  return {
    async read(): Promise<Anchor | null> {
      return current;
    },
    async write(next: Anchor): Promise<void> {
      current = next;
    },
  };
}

export function fileAnchorStore(path: string): AnchorStore {
  return {
    async read(): Promise<Anchor | null> {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return null;
        }
        throw error;
      }
      if (raw.trim() === "") {
        return null;
      }
      try {
        return JSON.parse(raw) as Anchor;
      } catch {
        throw new SyntaxError(`anchor file ${path} is corrupt`);
      }
    },

    // Write to a temp file and rename, so a crash mid-write cannot leave a half-written anchor
    // that would strand the guard between "no anchor" and "valid anchor".
    async write(next: Anchor): Promise<void> {
      const temp = `${path}.tmp`;
      await writeFile(temp, JSON.stringify(next), "utf8");
      await rename(temp, path);
    },
  };
}

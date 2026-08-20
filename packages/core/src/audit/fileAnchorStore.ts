import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Anchor, AnchorStore } from "../types.js";
import { isValidAnchor } from "./anchor.js";

export function fileAnchorStore(path: string): AnchorStore {
  // Write to a temp file and rename, so a crash mid-write cannot leave a half-written anchor
  // that would strand the guard between "no anchor" and "valid anchor". The temp name is
  // unique per call so concurrent writers never collide on the same rename target.
  async function writeNow(next: Anchor): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(next), "utf8");
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  // The guard writes the anchor after every append, so concurrent guard.pay() calls mean
  // concurrent write()s on the same store. Unique temp names alone stop them from throwing,
  // but the OS is free to finish those independent renames in any order — this queue chains
  // writes onto one another so they land in call order, and the last call always wins.
  let queue: Promise<void> = Promise.resolve();

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
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new SyntaxError(`anchor file ${path} is corrupt`);
      }
      if (!isValidAnchor(parsed)) {
        throw new SyntaxError(`anchor file ${path} is corrupt`);
      }
      return parsed;
    },

    write(next: Anchor): Promise<void> {
      const scheduled = queue.then(() => writeNow(next));
      queue = scheduled.then(
        () => undefined,
        () => undefined,
      );
      return scheduled;
    },
  };
}

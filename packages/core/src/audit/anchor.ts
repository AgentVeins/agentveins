import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID, sign, verify, type KeyObject } from "node:crypto";
import type { Anchor, AnchorStore } from "../types.js";

const SIG_DOMAIN_PREFIX = "agentveins.anchor.v1\n";

export interface AnchorInput {
  logId: string;
  seq: number;
  hash: string;
}

function canonicalize(input: AnchorInput): string {
  return JSON.stringify([input.logId, input.seq, input.hash]);
}

export function sealAnchor(input: AnchorInput, privateKey: KeyObject): Anchor {
  const sig = sign(
    null,
    Buffer.from(SIG_DOMAIN_PREFIX + canonicalize(input), "utf8"),
    privateKey,
  ).toString("base64");
  return { logId: input.logId, seq: input.seq, hash: input.hash, sig };
}

export function verifyAnchor(anchor: Anchor, publicKey: KeyObject): boolean {
  try {
    return verify(
      null,
      Buffer.from(SIG_DOMAIN_PREFIX + canonicalize(anchor), "utf8"),
      publicKey,
      Buffer.from(anchor.sig, "base64"),
    );
  } catch {
    return false;
  }
}

function isValidAnchor(value: unknown): value is Anchor {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.logId !== "string" || candidate.logId === "") {
    return false;
  }
  if (
    typeof candidate.seq !== "number" ||
    !Number.isSafeInteger(candidate.seq) ||
    candidate.seq < 0
  ) {
    return false;
  }
  if (typeof candidate.hash !== "string" || !/^[0-9a-f]{64}$/.test(candidate.hash)) {
    return false;
  }
  if (typeof candidate.sig !== "string" || candidate.sig === "") {
    return false;
  }
  return true;
}

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

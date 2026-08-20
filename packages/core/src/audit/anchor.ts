import { sign, verify, type KeyObject } from "node:crypto";
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

export function isValidAnchor(value: unknown): value is Anchor {
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

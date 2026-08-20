import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryAnchorStore, sealAnchor, verifyAnchor } from "../src/audit/anchor.js";
import { fileAnchorStore } from "../src/audit/fileAnchorStore.js";
import type { AnchorInput } from "../src/audit/anchor.js";
import type { Anchor } from "../src/types.js";

const anchor: Anchor = { logId: "log-alpha", seq: 4, hash: "a".repeat(64), sig: "s" };

describe("memoryAnchorStore", () => {
  it("reads null before anything is written", async () => {
    expect(await memoryAnchorStore().read()).toBeNull();
  });

  it("round-trips a written anchor", async () => {
    const store = memoryAnchorStore();
    await store.write(anchor);
    expect(await store.read()).toEqual(anchor);
  });

  it("starts from a seed", async () => {
    expect(await memoryAnchorStore(anchor).read()).toEqual(anchor);
  });
});

describe("fileAnchorStore", () => {
  it("reads null when the file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    expect(await fileAnchorStore(join(dir, "missing.json")).read()).toBeNull();
  });

  it("round-trips a written anchor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const store = fileAnchorStore(join(dir, "anchor.json"));
    await store.write(anchor);
    expect(await store.read()).toEqual(anchor);
  });

  it("overwrites a previous anchor and leaves no temp file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const store = fileAnchorStore(join(dir, "anchor.json"));
    await store.write(anchor);
    await store.write({ ...anchor, seq: 9 });

    expect((await store.read())?.seq).toBe(9);
    expect(await readdir(dir)).toEqual(["anchor.json"]);
  });

  it("reads null on an empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "anchor.json");
    await writeFile(path, "", "utf8");
    expect(await fileAnchorStore(path).read()).toBeNull();
  });

  it("throws a clear error on a corrupt anchor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "anchor.json");
    await writeFile(path, "{not json}", "utf8");
    await expect(fileAnchorStore(path).read()).rejects.toThrow(/corrupt/);
  });

  it("writes valid JSON on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "anchor.json");
    await fileAnchorStore(path).write(anchor);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(anchor);
  });
});

describe("sealAnchor / verifyAnchor", () => {
  const keys = generateKeyPairSync("ed25519");
  const input: AnchorInput = { logId: "log-alpha", seq: 4, hash: "a".repeat(64) };

  it("round-trips: a sealed anchor verifies under the signing key", () => {
    const sealed = sealAnchor(input, keys.privateKey);
    expect(verifyAnchor(sealed, keys.publicKey)).toBe(true);
  });

  it("rejects a sealed anchor with its seq altered", () => {
    const sealed = sealAnchor(input, keys.privateKey);
    expect(verifyAnchor({ ...sealed, seq: 5 }, keys.publicKey)).toBe(false);
  });

  it("rejects a sealed anchor with its hash altered", () => {
    const sealed = sealAnchor(input, keys.privateKey);
    expect(verifyAnchor({ ...sealed, hash: "b".repeat(64) }, keys.publicKey)).toBe(false);
  });

  it("rejects a sealed anchor with its logId altered", () => {
    const sealed = sealAnchor(input, keys.privateKey);
    expect(verifyAnchor({ ...sealed, logId: "log-beta" }, keys.publicKey)).toBe(false);
  });

  it("rejects a correctly sealed anchor under a different public key", () => {
    const sealed = sealAnchor(input, keys.privateKey);
    const other = generateKeyPairSync("ed25519");
    expect(verifyAnchor(sealed, other.publicKey)).toBe(false);
  });

  it("returns false, not a throw, for a malformed signature", () => {
    const sealed = sealAnchor(input, keys.privateKey);
    expect(verifyAnchor({ ...sealed, sig: "not-a-valid-signature" }, keys.publicKey)).toBe(false);
  });

  it("rejects a signature produced without the domain-separation prefix", () => {
    const canonical = JSON.stringify([input.logId, input.seq, input.hash]);
    const bareSig = sign(null, Buffer.from(canonical, "utf8"), keys.privateKey).toString("base64");
    const bareSealed: Anchor = { ...input, sig: bareSig };
    expect(verifyAnchor(bareSealed, keys.publicKey)).toBe(false);
  });
});

describe("fileAnchorStore validation", () => {
  const validAnchor: Anchor = { logId: "log-alpha", seq: 1, hash: "a".repeat(64), sig: "s" };

  async function expectCorrupt(content: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "anchor.json");
    await writeFile(path, content, "utf8");
    await expect(fileAnchorStore(path).read()).rejects.toThrow(/corrupt/);
  }

  it("throws on the literal null, rather than reading as absent", async () => {
    await expectCorrupt("null");
  });

  it("throws on a bare number", async () => {
    await expectCorrupt("5");
  });

  it("throws on a bare array", async () => {
    await expectCorrupt(JSON.stringify([1, 2, 3]));
  });

  it("throws when seq is missing", async () => {
    await expectCorrupt(JSON.stringify({ logId: "log-alpha", hash: "a".repeat(64), sig: "s" }));
  });

  it("throws when seq is a string", async () => {
    await expectCorrupt(JSON.stringify({ ...validAnchor, seq: "1" }));
  });

  it("throws when seq is negative", async () => {
    await expectCorrupt(JSON.stringify({ ...validAnchor, seq: -1 }));
  });

  it("throws when hash is not 64 hex characters", async () => {
    await expectCorrupt(JSON.stringify({ ...validAnchor, hash: "not-hex" }));
  });

  it("throws when sig is missing", async () => {
    await expectCorrupt(JSON.stringify({ logId: "log-alpha", seq: 1, hash: "a".repeat(64) }));
  });
});

describe("fileAnchorStore concurrency", () => {
  function anchors(): Anchor[] {
    return [0, 1, 2, 3, 4].map((seq) => ({ logId: "log-alpha", seq, hash: "a".repeat(64), sig: "s" }));
  }

  it("does not reject under concurrent writes, and read() returns the last-issued anchor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const store = fileAnchorStore(join(dir, "anchor.json"));
    await Promise.all(anchors().map((next) => store.write(next)));
    expect((await store.read())?.seq).toBe(4);
  });

  it("leaves no temp file behind after a concurrent write burst", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const store = fileAnchorStore(join(dir, "anchor.json"));
    await Promise.all(anchors().map((next) => store.write(next)));
    expect(await readdir(dir)).toEqual(["anchor.json"]);
  });
});

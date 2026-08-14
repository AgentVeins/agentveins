import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileAnchorStore, memoryAnchorStore } from "../src/audit/anchor.js";
import type { Anchor } from "../src/types.js";

const anchor: Anchor = { logId: "log-alpha", seq: 4, hash: "a".repeat(64) };

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

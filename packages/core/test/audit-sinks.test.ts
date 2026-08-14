import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileAuditSink } from "../src/audit/fileSink.js";
import { memoryAuditSink } from "../src/audit/memorySink.js";
import type { AuditEntry } from "../src/types.js";

function entry(seq: number): AuditEntry {
  return {
    id: `id-${seq}`, logId: "log-alpha", seq, ts: "2026-08-13T10:00:00.000Z", kind: "payment",
    agent: "a", vendor: "v", vendorNormalized: "v", rail: "solana",
    amountMinor: "50000", currency: "USDC", reason: "r", outcome: "settled",
    violation: null, txSig: "sig", prevHash: "", hash: `h-${seq}`, sig: "s",
  };
}

async function collect(sink: { read?(): AsyncIterable<AuditEntry> }): Promise<AuditEntry[]> {
  const out: AuditEntry[] = [];
  for await (const e of sink.read!()) out.push(e);
  return out;
}

describe("memoryAuditSink", () => {
  it("appends and reads back in order", async () => {
    const sink = memoryAuditSink();
    await sink.append(entry(0));
    await sink.append(entry(1));
    expect((await collect(sink)).map((e) => e.seq)).toEqual([0, 1]);
  });

  it("starts from a seed", async () => {
    const sink = memoryAuditSink([entry(0)]);
    expect(sink.entries).toHaveLength(1);
  });
});

describe("fileAuditSink", () => {
  it("writes one JSON object per line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "audit.jsonl");
    const sink = fileAuditSink(path);
    await sink.append(entry(0));
    await sink.append(entry(1));

    const raw = await readFile(path, "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
    expect((await collect(sink)).map((e) => e.seq)).toEqual([0, 1]);
  });

  it("reads an empty stream when the file does not exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const sink = fileAuditSink(join(dir, "missing.jsonl"));
    expect(await collect(sink)).toEqual([]);
  });

  it("ignores blank lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "audit.jsonl");
    await writeFile(path, `${JSON.stringify(entry(0))}\n\n`, "utf8");
    expect(await collect(fileAuditSink(path))).toHaveLength(1);
  });

  it("throws a clear error on a corrupt line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "audit.jsonl");
    await writeFile(path, "{not json}\n", "utf8");
    await expect(collect(fileAuditSink(path))).rejects.toThrow(/line 1/);
  });
});

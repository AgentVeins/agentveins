import { describe, expect, it } from "vitest";
import { memoryApprovalStore } from "../src/approvals/memoryStore.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileApprovalStore } from "../src/approvals/fileStore.js";
import type { Approval, ApprovalKey, ApprovalStore } from "../src/types.js";

const key: ApprovalKey = {
  agent: "research-agent",
  vendorNormalized: "api.weather.com",
  amountMinor: 25_000_000n,
};

function approval(overrides: Partial<Approval> = {}): Approval {
  return { ...key, id: "apr_1", expiresAt: "2026-08-28T12:30:00.000Z", usedAt: null, ...overrides };
}

function contract(name: string, make: (seed: Approval[]) => Promise<ApprovalStore>): void {
  describe(name, () => {
    it("finds an approval by its exact key", async () => {
      const store = await make([approval()]);
      expect((await store.find(key))?.id).toBe("apr_1");
    });

    it("returns null when nothing matches", async () => {
      const store = await make([approval()]);
      expect(await store.find({ ...key, amountMinor: 1n })).toBeNull();
    });

    it("returns null on an empty store", async () => {
      const store = await make([]);
      expect(await store.find(key)).toBeNull();
    });

    it("returns a spent approval rather than hiding it, leaving the judgment to the guard", async () => {
      const store = await make([approval({ usedAt: "2026-08-28T11:00:00.000Z" })]);
      expect((await store.find(key))?.usedAt).toBe("2026-08-28T11:00:00.000Z");
    });

    it("marks an approval spent when consumed", async () => {
      const store = await make([approval()]);
      await store.consume("apr_1");
      expect((await store.find(key))?.usedAt).not.toBeNull();
    });

    it("refuses to consume the same approval twice", async () => {
      const store = await make([approval()]);
      await store.consume("apr_1");
      await expect(store.consume("apr_1")).rejects.toThrow();
    });

    it("grants an approval a later find can see", async () => {
      const store = await make([]);
      const granted = await store.grant({ ...key, expiresAt: "2099-01-01T00:00:00.000Z" });

      expect(granted.id).not.toBe("");
      expect(granted.usedAt).toBeNull();
      expect((await store.find(key))?.id).toBe(granted.id);
    });

    it("grants an approval the guard can then spend exactly once", async () => {
      const store = await make([]);
      const granted = await store.grant({ ...key, expiresAt: "2099-01-01T00:00:00.000Z" });

      await store.consume(granted.id);

      expect((await store.find(key))?.usedAt).not.toBeNull();
      await expect(store.consume(granted.id)).rejects.toThrow();
    });

    it("gives each grant its own id, so two humans approving twice authorise twice", async () => {
      const store = await make([]);
      const first = await store.grant({ ...key, expiresAt: "2099-01-01T00:00:00.000Z" });
      const second = await store.grant({ ...key, expiresAt: "2099-01-01T00:00:00.000Z" });

      expect(second.id).not.toBe(first.id);
      await store.consume(first.id);
      await expect(store.consume(second.id)).resolves.toBeUndefined();
    });

    it("refuses a grant whose expiry is not a date", async () => {
      const store = await make([]);
      await expect(store.grant({ ...key, expiresAt: "whenever" })).rejects.toThrow();
    });

    it("refuses a grant for a non-positive amount", async () => {
      const store = await make([]);
      await expect(
        store.grant({ ...key, amountMinor: 0n, expiresAt: "2099-01-01T00:00:00.000Z" }),
      ).rejects.toThrow();
    });

    it("refuses a grant with no agent named", async () => {
      const store = await make([]);
      await expect(
        store.grant({ ...key, agent: "  ", expiresAt: "2099-01-01T00:00:00.000Z" }),
      ).rejects.toThrow();
    });

    it("refuses to consume an approval it does not have", async () => {
      const store = await make([]);
      await expect(store.consume("apr_missing")).rejects.toThrow();
    });
  });
}

contract("memoryApprovalStore", async (seed) => memoryApprovalStore(seed));

contract("fileApprovalStore", async (seed) => {
  const dir = await mkdtemp(join(tmpdir(), "av-approvals-"));
  const path = join(dir, "approvals.json");
  await writeFile(
    path,
    JSON.stringify(seed.map((a) => ({ ...a, amountMinor: a.amountMinor.toString() }))),
    "utf8",
  );
  return fileApprovalStore(path);
});

describe("fileApprovalStore persistence", () => {
  it("survives a reopen, so a restart does not resurrect a spent approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-approvals-"));
    const path = join(dir, "approvals.json");
    await writeFile(path, JSON.stringify([{ ...approval(), amountMinor: "25000000" }]), "utf8");

    await fileApprovalStore(path).consume("apr_1");

    expect((await fileApprovalStore(path).find(key))?.usedAt).not.toBeNull();
  });

  it("treats a missing file as an empty store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-approvals-"));
    expect(await fileApprovalStore(join(dir, "absent.json")).find(key)).toBeNull();
  });
});

describe("fileApprovalStore concurrency", () => {
  it("lets only one of two overlapping consumes spend an approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-approvals-"));
    const path = join(dir, "approvals.json");
    await writeFile(path, JSON.stringify([{ ...approval(), amountMinor: "25000000" }]), "utf8");
    const store = fileApprovalStore(path);

    // Both calls are in flight before either resolves: without the queue both read the same
    // unspent record and both write it back spent, so one approval pays twice.
    const results = await Promise.allSettled([store.consume("apr_1"), store.consume("apr_1")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});

describe("fileApprovalStore validation", () => {
  async function storeWith(records: unknown[]): Promise<ApprovalStore> {
    const dir = await mkdtemp(join(tmpdir(), "av-approvals-"));
    const path = join(dir, "approvals.json");
    await writeFile(path, JSON.stringify(records), "utf8");
    return fileApprovalStore(path);
  }

  function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...approval(), amountMinor: "25000000", ...overrides };
  }

  it("refuses an omitted usedAt rather than reading it as spent", async () => {
    const { usedAt: _omitted, ...withoutUsedAt } = record();
    const store = await storeWith([withoutUsedAt]);

    await expect(store.find(key)).rejects.toThrow(/usedAt must be null/);
  });

  it("refuses a numeric amountMinor", async () => {
    const store = await storeWith([record({ amountMinor: 25_000_000 })]);

    await expect(store.find(key)).rejects.toThrow(/amountMinor/);
  });

  it("refuses an amountMinor that is not a whole number of minor units", async () => {
    const store = await storeWith([record({ amountMinor: "25.00" })]);

    await expect(store.find(key)).rejects.toThrow(/whole number of minor units/);
  });

  it("refuses a record missing a string field, naming the file and the record", async () => {
    const store = await storeWith([record(), record({ expiresAt: null })]);

    await expect(store.find(key)).rejects.toThrow(/approval file .*approvals\.json, record 1: expiresAt/);
  });

  it("names the SyntaxError so a malformed file is never read as a denial", async () => {
    const store = await storeWith([record({ id: 7 })]);

    await expect(store.find(key)).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("memoryApprovalStore isolation", () => {
  it("leaves the caller's seed objects untouched when it consumes", async () => {
    const seed = [approval()];
    const store = memoryApprovalStore(seed);

    await store.consume("apr_1");

    expect(seed[0]?.usedAt).toBeNull();
    expect(store.approvals[0]?.usedAt).not.toBeNull();
  });
});

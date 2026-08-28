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

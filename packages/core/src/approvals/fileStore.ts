import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Approval, ApprovalKey, ApprovalStore } from "../types.js";

interface StoredApproval extends Omit<Approval, "amountMinor"> {
  amountMinor: string;
}

export function fileApprovalStore(path: string): ApprovalStore {
  async function readAll(): Promise<Approval[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    if (raw.trim() === "") {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SyntaxError(`approval file ${path} is corrupt`);
    }
    if (!Array.isArray(parsed)) {
      throw new SyntaxError(`approval file ${path} is corrupt`);
    }
    return (parsed as StoredApproval[]).map((stored) => ({
      ...stored,
      amountMinor: BigInt(stored.amountMinor),
    }));
  }

  // Temp file plus rename, as fileAnchorStore does: a crash mid-write must not leave a
  // half-written file that loses which approvals were already spent.
  async function writeAll(approvals: Approval[]): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    const stored: StoredApproval[] = approvals.map((approval) => ({
      ...approval,
      amountMinor: approval.amountMinor.toString(),
    }));
    try {
      await writeFile(temp, JSON.stringify(stored), "utf8");
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  // Consuming is read-modify-write, so two overlapping consumes could otherwise both read an
  // unspent approval and both spend it. Chaining them makes the second read the first's result.
  let queue: Promise<void> = Promise.resolve();

  return {
    async find(key: ApprovalKey): Promise<Approval | null> {
      const approvals = await readAll();
      return (
        approvals.find(
          (candidate) =>
            candidate.agent === key.agent &&
            candidate.vendorNormalized === key.vendorNormalized &&
            candidate.amountMinor === key.amountMinor,
        ) ?? null
      );
    },

    consume(id: string): Promise<void> {
      const scheduled = queue.then(async () => {
        const approvals = await readAll();
        const approval = approvals.find((candidate) => candidate.id === id);
        if (approval === undefined) {
          throw new RangeError(`no approval with id ${id}`);
        }
        if (approval.usedAt !== null) {
          throw new RangeError(`approval ${id} was already consumed`);
        }
        approval.usedAt = new Date().toISOString();
        await writeAll(approvals);
      });
      queue = scheduled.then(
        () => undefined,
        () => undefined,
      );
      return scheduled;
    },
  };
}

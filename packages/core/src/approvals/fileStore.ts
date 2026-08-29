import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { assertGrantable } from "./grant.js";
import type { Approval, ApprovalGrant, ApprovalKey, ApprovalStore } from "../types.js";

interface StoredApproval extends Omit<Approval, "amountMinor"> {
  amountMinor: string;
}

function requireString(value: unknown, at: string, field: string): string {
  if (typeof value !== "string") {
    throw new SyntaxError(`${at}: ${field} must be a string`);
  }
  return value;
}

// A hand-written file is the only way an approval exists, so a malformed record fails loudly.
// Silently skipping one would deny a payment a person did approve, with nothing to explain why —
// and an omitted `usedAt` in particular would read as spent rather than as unspent.
function toApproval(record: unknown, path: string, index: number): Approval {
  const at = `approval file ${path}, record ${index}`;
  const fields = (typeof record === "object" && record !== null ? record : {}) as Partial<StoredApproval>;
  const id = requireString(fields.id, at, "id");
  const agent = requireString(fields.agent, at, "agent");
  const vendorNormalized = requireString(fields.vendorNormalized, at, "vendorNormalized");
  const expiresAt = requireString(fields.expiresAt, at, "expiresAt");
  const rawAmount = requireString(fields.amountMinor, at, "amountMinor (a decimal minor-unit string)");
  if (fields.usedAt !== null && typeof fields.usedAt !== "string") {
    throw new SyntaxError(`${at}: usedAt must be null while unspent, or an ISO 8601 string once spent`);
  }
  let amountMinor: bigint;
  try {
    amountMinor = BigInt(rawAmount);
  } catch {
    throw new SyntaxError(`${at}: amountMinor is not a whole number of minor units`);
  }
  return { id, agent, vendorNormalized, expiresAt, usedAt: fields.usedAt, amountMinor };
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
    return parsed.map((record, index) => toApproval(record, path, index));
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

  // Every mutation shares the queue, not just consume: granting is read-modify-write on the same
  // file, so a grant racing a consume would otherwise read the file before the other's write and
  // drop it — losing either a human's decision or the record that one was spent.
  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = queue.then(operation, operation);
    queue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  return {
    // `async` so a rejected grant is a rejected promise, never a synchronous throw: a method
    // typed Promise<Approval> that throws before returning one would slip past every caller
    // that handles failure with .catch().
    async grant(input: ApprovalGrant): Promise<Approval> {
      assertGrantable(input);
      return mutate(async () => {
        const approvals = await readAll();
        const approval: Approval = {
          agent: input.agent,
          vendorNormalized: input.vendorNormalized,
          amountMinor: input.amountMinor,
          id: randomUUID(),
          expiresAt: input.expiresAt,
          usedAt: null,
        };
        approvals.push(approval);
        await writeAll(approvals);
        return { ...approval };
      });
    },

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
      return mutate(async () => {
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
    },
  };
}

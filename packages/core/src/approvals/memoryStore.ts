import { randomUUID } from "node:crypto";
import { assertGrantable } from "./grant.js";
import type { Approval, ApprovalGrant, ApprovalKey, ApprovalStore } from "../types.js";

export interface MemoryApprovalStore extends ApprovalStore {
  readonly approvals: Approval[];
}

export function memoryApprovalStore(seed: Approval[] = []): MemoryApprovalStore {
  // Each record is copied: consuming marks `usedAt`, and a store must not write through into
  // the caller's own objects.
  const approvals = seed.map((record) => ({ ...record }));
  return {
    approvals,
    async grant(input: ApprovalGrant): Promise<Approval> {
      assertGrantable(input);
      const approval: Approval = {
        agent: input.agent,
        vendorNormalized: input.vendorNormalized,
        amountMinor: input.amountMinor,
        id: randomUUID(),
        expiresAt: input.expiresAt,
        usedAt: null,
      };
      approvals.push(approval);
      return { ...approval };
    },
    async find(key: ApprovalKey): Promise<Approval | null> {
      return (
        approvals.find(
          (candidate) =>
            candidate.agent === key.agent &&
            candidate.vendorNormalized === key.vendorNormalized &&
            candidate.amountMinor === key.amountMinor,
        ) ?? null
      );
    },
    async consume(id: string): Promise<void> {
      const approval = approvals.find((candidate) => candidate.id === id);
      if (approval === undefined) {
        throw new RangeError(`no approval with id ${id}`);
      }
      if (approval.usedAt !== null) {
        throw new RangeError(`approval ${id} was already consumed`);
      }
      approval.usedAt = new Date().toISOString();
    },
  };
}

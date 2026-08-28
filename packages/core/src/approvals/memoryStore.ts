import type { Approval, ApprovalKey, ApprovalStore } from "../types.js";

export interface MemoryApprovalStore extends ApprovalStore {
  readonly approvals: Approval[];
}

export function memoryApprovalStore(seed: Approval[] = []): MemoryApprovalStore {
  const approvals = [...seed];
  return {
    approvals,
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

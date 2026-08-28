import type { Approval, ApprovalKey } from "../types.js";

export type ApprovalDecision = "grant" | "missing" | "expired" | "used";

export function decideApproval(
  approval: Approval | null,
  key: ApprovalKey,
  now: Date,
): ApprovalDecision {
  if (approval === null) {
    return "missing";
  }
  // A store that answers with terms other than the ones asked for is buggy or hostile, and the
  // difference does not matter here: the guard must not spend against it either way.
  if (
    approval.agent !== key.agent ||
    approval.vendorNormalized !== key.vendorNormalized ||
    approval.amountMinor !== key.amountMinor
  ) {
    return "missing";
  }
  if (approval.usedAt !== null) {
    return "used";
  }
  const expiresAt = Date.parse(approval.expiresAt);
  // An expiry that cannot be read is not evidence of validity.
  if (Number.isNaN(expiresAt) || expiresAt <= now.getTime()) {
    return "expired";
  }
  return "grant";
}

import type { ApprovalGrant } from "../types.js";

/**
 * Checked when a human's decision is recorded rather than when it is spent. A grant nobody can
 * ever use — a zero amount, an unreadable expiry — is an operator mistake, and the moment to say
 * so is while a person is still watching, not later as a denial the agent reports.
 */
export function assertGrantable(input: ApprovalGrant): void {
  if (typeof input.agent !== "string" || input.agent.trim() === "") {
    throw new RangeError("an approval must name the agent it authorises");
  }
  if (typeof input.vendorNormalized !== "string" || input.vendorNormalized.trim() === "") {
    throw new RangeError("an approval must name the vendor it authorises");
  }
  if (typeof input.amountMinor !== "bigint" || input.amountMinor <= 0n) {
    throw new RangeError("an approval must authorise an amount greater than zero");
  }
  if (typeof input.expiresAt !== "string" || Number.isNaN(Date.parse(input.expiresAt))) {
    throw new RangeError("an approval must carry an ISO 8601 expiry");
  }
}

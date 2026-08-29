import type { Approval, ApprovalKey } from "../types.js";

/**
 * Picks which approval to hand the guard when several share the same terms.
 *
 * A key can match more than one record: a human who approves the same payment twice has issued
 * two authorisations. Returning whichever happened to be stored first is not a choice a store may
 * make — once one is spent it would shadow every later grant, and the guard would report `used`
 * forever while a person kept approving into a void.
 *
 * Unspent wins. Expiry stays the guard's judgment, so an unspent-but-expired record is still
 * preferred over a spent one: both are refused, and "expired" tells the operator more than
 * "used". When every match is spent, the first is returned so the guard can say so honestly.
 */
export function selectApproval(matches: readonly Approval[]): Approval | null {
  return matches.find((candidate) => candidate.usedAt === null) ?? matches[0] ?? null;
}

export function matchesKey(candidate: Approval, key: ApprovalKey): boolean {
  return (
    candidate.agent === key.agent &&
    candidate.vendorNormalized === key.vendorNormalized &&
    candidate.amountMinor === key.amountMinor
  );
}

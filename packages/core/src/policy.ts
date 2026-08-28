import { parseAmount } from "./money.js";
import type { Policy } from "./types.js";

const PERIODS = new Set(["per_tx", "daily"]);

export function validatePolicy(policy: Policy): void {
  if (policy === null || typeof policy !== "object") {
    throw new TypeError("policy must be an object");
  }
  if (!Array.isArray(policy.budgets) || policy.budgets.length === 0) {
    throw new RangeError("policy.budgets must be a non-empty array");
  }

  const seen = new Set<string>();
  for (const budget of policy.budgets) {
    if (!PERIODS.has(budget.period)) {
      throw new RangeError(`unknown budget period: ${String(budget.period)}`);
    }
    if (seen.has(budget.period)) {
      throw new RangeError(`duplicate budget period: ${budget.period}`);
    }
    seen.add(budget.period);
    if (budget.currency !== "USDC") {
      throw new RangeError(`unsupported currency: ${String(budget.currency)}`);
    }
    parseAmount(budget.limit);
  }

  if (policy.vendors === null || typeof policy.vendors !== "object" || policy.vendors.mode !== "allowlist") {
    throw new RangeError('policy.vendors.mode must be "allowlist"');
  }
  if (!Array.isArray(policy.vendors.entries) || policy.vendors.entries.length === 0) {
    throw new RangeError("allowlist mode requires at least one vendor entry");
  }
  for (const entry of policy.vendors.entries) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new RangeError(`vendor allowlist entries must be non-empty strings, received: ${String(entry)}`);
    }
  }

  if (policy.recipients !== undefined) {
    if (policy.recipients === null || typeof policy.recipients !== "object" || policy.recipients.mode !== "allowlist") {
      throw new RangeError('policy.recipients.mode must be "allowlist"');
    }
    if (!Array.isArray(policy.recipients.entries) || policy.recipients.entries.length === 0) {
      throw new RangeError("a recipient allowlist requires at least one entry; omit policy.recipients to leave recipients ungoverned");
    }
    for (const entry of policy.recipients.entries) {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new RangeError(`recipient allowlist entries must be non-empty strings, received: ${String(entry)}`);
      }
    }
  }

  if (policy.approvals !== undefined) {
    if (policy.approvals === null || typeof policy.approvals !== "object") {
      throw new RangeError("policy.approvals must be an object with an `above` threshold");
    }
    parseAmount(policy.approvals.above);
  }

  if (policy.killSwitch === null || typeof policy.killSwitch !== "object" || typeof policy.killSwitch.frozen !== "boolean") {
    throw new TypeError("policy.killSwitch.frozen must be a boolean");
  }
}

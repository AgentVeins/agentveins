import { parseDuration } from "../duration.js";
import { formatAmount, parseAmount } from "../money.js";
import { MAX_VELOCITY_WINDOW_MS } from "../policy.js";
import type { Check } from "../types.js";

/**
 * Is this normal behavior, or a runaway loop? Counts what settled inside each rule's sliding
 * window — plus the candidate payment, since the question is whether making it would exceed
 * the cap. Only money that moved counts: refusals never extend a window, so the guard's own
 * blocks cannot spiral into a lockout longer than the window itself.
 */
export const velocityCheck: Check = (ctx, policy, state) => {
  if (policy.velocity === undefined) {
    return null;
  }
  for (const rule of policy.velocity) {
    const windowMs = parseDuration(rule.window, MAX_VELOCITY_WINDOW_MS, "velocity window");
    const cutoff = ctx.now.getTime() - windowMs;
    let count = 1n;
    let sum = ctx.amountMinor;
    for (const item of state.recent) {
      if (Date.parse(item.ts) > cutoff) {
        count += 1n;
        sum += item.amountMinor;
      }
    }
    if (rule.maxPayments !== undefined && count > BigInt(rule.maxPayments)) {
      const detail: Record<string, string> = {
        window: rule.window,
        maxPayments: String(rule.maxPayments),
        held: String(count - 1n),
      };
      return {
        code: "velocity_exceeded",
        message: `more than ${rule.maxPayments} payments would have settled inside ${rule.window}`,
        detail,
      };
    }
    if (rule.maxAmount !== undefined && sum > parseAmount(rule.maxAmount)) {
      const detail: Record<string, string> = {
        window: rule.window,
        maxAmount: rule.maxAmount,
        held: formatAmount(sum - ctx.amountMinor),
        attempted: formatAmount(ctx.amountMinor),
      };
      return {
        code: "velocity_exceeded",
        message: `more than ${rule.maxAmount} would have settled inside ${rule.window}`,
        detail,
      };
    }
  }
  return null;
};

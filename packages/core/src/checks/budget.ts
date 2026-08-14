import { formatAmount, parseAmount } from "../money.js";
import { spentInWindow } from "../state.js";
import type { Check } from "../types.js";

export const budgetCheck: Check = (ctx, policy, state) => {
  for (const budget of policy.budgets) {
    const limit = parseAmount(budget.limit);

    if (budget.period === "per_tx") {
      if (ctx.amountMinor > limit) {
        const detail: Record<string, string> = {
          period: "per_tx",
          limit: budget.limit,
          attempted: formatAmount(ctx.amountMinor),
        };
        return {
          code: "budget_exceeded",
          message: "the payment exceeds the per-transaction limit",
          detail,
        };
      }
      continue;
    }

    const spent = spentInWindow(state, budget.period, ctx.now);
    if (spent + ctx.amountMinor > limit) {
      const detail: Record<string, string> = {
        period: "daily",
        limit: budget.limit,
        spent: formatAmount(spent),
        attempted: formatAmount(ctx.amountMinor),
        remaining: formatAmount(limit - spent),
      };
      return {
        code: "budget_exceeded",
        message: "the payment exceeds the daily budget",
        detail,
      };
    }
  }
  return null;
};

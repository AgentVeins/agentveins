import { z } from "zod";
import { formatAmount, parseAmount, spentInWindow } from "@agentveins/core";
import type { CheckResult, Guard, PayResult } from "@agentveins/core";
import type { Rail } from "./rail.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  config: { title: string; description: string; inputSchema: z.ZodRawShape };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const paymentShape = {
  to: z.string().describe("The vendor URL or address being paid."),
  amount: z.string().describe('Decimal string in the policy currency, e.g. "1.50". Never a number.'),
  currency: z.literal("USDC"),
  reason: z.string().describe("Why this payment is being made. Recorded in the audit log."),
};

function text(body: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: "text", text: body }], isError: true }
    : { content: [{ type: "text", text: body }] };
}

function mockNote(rail: Rail): string {
  return rail === "mock" ? "\n\nThis server is on the mock rail: no money moved and the signature is not real." : "";
}

function describePay(result: PayResult, rail: Rail): ToolResult {
  if (result.status === "settled") {
    return text(`settled — ${result.txSig}\naudit ${result.auditId}${mockNote(rail)}`);
  }
  if (result.status === "failed") {
    // A rail that broke is a malfunction, unlike a refusal.
    return text(`failed — ${result.error.code}: ${result.error.message}\naudit ${result.auditId}`, true);
  }
  const base = `blocked — ${result.violation.code}: ${result.violation.message}\naudit ${result.auditId}`;
  if (result.violation.code === "approval_required") {
    return text(
      `${base}\n\nA person must approve this payment before it can go through. Do not retry it until they have; the answer will not change on its own. Quote the audit id above when asking.`,
    );
  }
  return text(`${base}\n\nThis is the policy working, not a failure. Choose a cheaper vendor, a smaller amount, or ask a person.`);
}

function describeCheck(result: CheckResult): ToolResult {
  if (result.status === "allowed") {
    return text("allowed — the policy permits this payment right now.\n\nThis is advisory: a payment made between this check and that one can consume the budget or the approval.");
  }
  return text(`blocked — ${result.violation.code}: ${result.violation.message}`);
}

export function toolDefinitions(guard: Guard, rail: Rail): ToolDefinition[] {
  return [
    {
      name: "pay",
      config: {
        title: "Make a governed payment",
        description:
          "Attempts a payment through the spend policy. Returns settled with a transaction signature, or blocked with the rule that refused it. A blocked payment is the policy working, not an error.",
        inputSchema: paymentShape,
      },
      handler: async (args) => describePay(await guard.pay(args as never), rail),
    },
    {
      name: "check",
      config: {
        title: "Check a payment without making it",
        description:
          "Answers whether a payment would be allowed, moving no money and consuming no budget or approval. Advisory: an allowed answer is a snapshot, not a promise.",
        inputSchema: paymentShape,
      },
      handler: async (args) => describeCheck(await guard.check(args as never)),
    },
    {
      name: "spend_state",
      config: {
        title: "Report remaining budget",
        description: "Reports every budget in the policy with what is spent and what remains, and whether the agent is frozen.",
        inputSchema: {},
      },
      handler: async () => {
        const state = guard.state();
        const now = new Date();
        const budgets = guard.policy.budgets.map((budget) => {
          const limit = parseAmount(budget.limit);
          const spent = budget.period === "per_tx" ? 0n : spentInWindow(state, budget.period, now);
          return {
            period: budget.period,
            limit: budget.limit,
            spent: formatAmount(spent),
            remaining: formatAmount(limit - spent),
          };
        });
        return text(JSON.stringify({ frozen: state.frozen, budgets }, null, 2));
      },
    },
  ];
}

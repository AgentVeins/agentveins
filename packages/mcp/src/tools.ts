import { z } from "zod";
import { formatAmount, parseAmount, spentInWindow } from "@agentveins/core";
import type { CheckResult, Guard, PayResult, ViolationCode } from "@agentveins/core";
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

const MOCK_LABEL = "This server is on the mock rail: no money moved and the signature is not real.";

// A different closing line per code. The generic advice — try a cheaper vendor, a smaller
// amount — is only actionable for the rules an agent can satisfy by choosing differently.
// Handed to a frozen or latched guard it walks the allowlist downward, one refusal at a
// time, which is the retry loop this server exists to prevent.
const BLOCK_GUIDANCE: Record<ViolationCode, string> = {
  budget_exceeded:
    "This is the policy working, not a failure. Choose a cheaper vendor, a smaller amount, or ask a person.",
  vendor_not_allowed:
    "This is the policy working, not a failure. Choose a cheaper vendor, a smaller amount, or ask a person.",
  velocity_exceeded:
    "The pace cap was hit, not the budget: too much settled inside a short window. Wait for the window named in the detail to pass, then continue. A different vendor or a smaller amount does not reset the clock.",
  kill_switch:
    "The kill switch is closed: every payment from this agent is refused until an operator lifts it. No vendor is cheap enough and no amount is small enough. Stop trying to pay and tell a person.",
  audit_unavailable:
    "The audit log cannot be written, and a payment that cannot be recorded is one this guard will not make. Every payment is refused until an operator fixes the log. Nothing you change about the request will help. Stop trying to pay and tell a person.",
  approval_unavailable:
    "The approval store could not be reached, so no payment above the threshold can be approved. A different vendor or a smaller amount will not fix it. Stop trying to pay and tell a person.",
  approval_required:
    "A person must approve this payment before it can go through. Do not retry it until they have; the answer will not change on its own. Quote the audit id above when asking.",
  invalid_request:
    "The request itself was malformed — no rule refused it. Read the message above, correct the field it names, and send it again. A different vendor or amount will not fix it.",
};

function text(body: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: "text", text: body }], isError: true }
    : { content: [{ type: "text", text: body }] };
}

function mockNote(rail: Rail): string {
  return rail === "mock" ? `\n\n${MOCK_LABEL}` : "";
}

// A latched guard returns an empty audit id: the attempt could not be recorded anywhere.
// Printing the label with nothing after it would read as a lost id rather than an unwritten one.
function auditLine(auditId: string): string {
  return auditId === "" ? "\nThe attempt could not be recorded." : `\naudit ${auditId}`;
}

function describePay(result: PayResult, rail: Rail): ToolResult {
  if (result.status === "settled") {
    return text(`settled — ${result.txSig}${auditLine(result.auditId)}${mockNote(rail)}`);
  }
  if (result.status === "failed") {
    // A rail that broke is a malfunction, unlike a refusal.
    return text(`failed — ${result.error.code}: ${result.error.message}${auditLine(result.auditId)}${mockNote(rail)}`, true);
  }
  const base = `blocked — ${result.violation.code}: ${result.violation.message}${auditLine(result.auditId)}`;
  return text(`${base}\n\n${BLOCK_GUIDANCE[result.violation.code]}${mockNote(rail)}`);
}

function describeCheck(result: CheckResult, rail: Rail): ToolResult {
  if (result.status === "allowed") {
    return text(`allowed — the policy permits this payment right now.\n\nThis is advisory: a payment made between this check and that one can consume the budget or the approval.${mockNote(rail)}`);
  }
  return text(`blocked — ${result.violation.code}: ${result.violation.message}${mockNote(rail)}`);
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
      handler: async (args) => describeCheck(await guard.check(args as never), rail),
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
            limit: formatAmount(limit),
            spent: formatAmount(spent),
            remaining: formatAmount(limit - spent),
          };
        });
        // The label rides inside the payload rather than after it: this result is JSON, and
        // a sentence appended to it would stop it parsing.
        return text(
          JSON.stringify(
            { frozen: state.frozen, budgets, ...(rail === "mock" ? { note: MOCK_LABEL } : {}) },
            null,
            2,
          ),
        );
      },
    },
  ];
}

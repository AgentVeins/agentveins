---
name: agentveins
description: Use when this project's agent spends money — paying an API per call, buying data, settling an x402 quote — or when setting up spend limits, budgets, vendor allowlists, human approval for large payments, or a payment audit trail. Also use when a payment comes back blocked and you need to know what to do about it.
---

# Spending money through a guard

AgentVeins puts a policy between an agent and its wallet. Every payment is checked before
money moves: is the vendor allowed, is it within budget, is the agent frozen, does a human
need to approve this. Every attempt — allowed or refused — is appended to a signed,
hash-chained log.

You reach it through three MCP tools. The wallet key lives in that server, not here, so
paying around the guard is not something you can do; there is no key on this side to do it
with.

## Before you start spending

Call `check` before committing to a plan that involves several payments, or one large one.
It answers whether a payment would be allowed without moving anything, so you can plan
against the real limits instead of discovering them by hitting them.

Its answer is a snapshot, not a promise — a payment made in between can consume the budget.
Treat it as information, not a reservation.

`spend_state` reports every budget with what is left, which is the better call when you want
to size a plan rather than test one payment.

## When a payment is blocked

A refusal is not an error. It is the policy working, and the tool result tells you which rule
refused you. What to do depends on which:

| Refused by | What to do |
| --- | --- |
| `budget_exceeded` | Try a smaller amount, or stop and tell the user the budget is spent |
| `velocity_exceeded` | **Wait.** The pace cap was hit — the detail names the window. Do not switch vendors or shrink the amount; neither resets the clock. Continue after the window passes |
| `vendor_not_allowed` | This vendor is not approved. Do not try a different URL for the same vendor — ask the user to add it |
| `approval_required` | **Stop and tell the user.** A person must approve this exact payment. Retrying will not help; quote the audit id so they can find it |
| `kill_switch` | **Stop entirely.** The agent is frozen and every payment will be refused. Tell the user |
| `audit_unavailable` | **Stop entirely.** The guard cannot record, so it will not authorise. Tell the user |
| `approval_unavailable` | The approval store could not be read. Tell the user; a different amount will not help |

Two refusals stop everything: a frozen guard and a latched one refuse every payment, so
walking down the vendor list just produces a long row of refusals in the audit log — stop
and tell the user. One stops a single payment: `approval_required` parks that payment until
a person decides, and other work continues. And one means wait: a velocity block clears on
its own — the only refusal that does — so waiting is the correct move and the only one that
works.

## Writing a good reason

Every `pay` call takes a `reason`, and it goes in the audit log permanently. Someone
reconciling spend later reads it. Say what was bought and why, not what the tool did:

- Good: `"Q3 pricing data for the EU competitor report"`
- Useless: `"API call"`, `"payment"`, `"user asked me to"`

## Approvals

When the policy sets a threshold, a payment above it is held until a person approves those
exact terms — one agent, one vendor, one exact amount, once. Tell the user they can review
and approve with:

```bash
npx @agentveins/cli pending
npx @agentveins/cli approve 1 --ttl 15m
```

After they approve, retry the payment unchanged. Changing the amount by even one minor unit
means the approval no longer matches and it will be refused again.

## Setting it up

If the tools are not available, the server needs configuring. It takes two things.

**A policy** — the rules, which have no default because they are the product:

```json
{
  "budgets": [
    { "period": "per_tx", "limit": "1.00",  "currency": "USDC" },
    { "period": "daily",  "limit": "10.00", "currency": "USDC" }
  ],
  "vendors": { "mode": "allowlist", "entries": ["api.weather.com"] },
  "killSwitch": { "frozen": false }
}
```

**Where it is** — set `AGENTVEINS_POLICY` to that file's absolute path in the environment.
The audit log, its anchor, the approval store and the signing key are all created beside it
on first run; the key is kept and reused, because a log signed by a key that changed cannot
be verified.

If this plugin's bundled server does not pick the variable up, add it directly to
`.mcp.json` in the project:

```json
{
  "mcpServers": {
    "agentveins": {
      "command": "npx",
      "args": ["-y", "@agentveins/mcp"],
      "env": {
        "AGENTVEINS_POLICY": "/absolute/path/to/policy.json",
        "AGENTVEINS_RAIL": "mock"
      }
    }
  }
}
```

`mock` governs payments that never move money — the policy runs in full and nothing settles,
which is the right setting until the rules are what you want. For real settlement set
`AGENTVEINS_RAIL` to `solana` and give `SOLANA_KEYPAIR_PATH` a funded devnet keypair.
**Devnet only**: this project has no mainnet configuration.

## What this does not do

It never asks anyone for approval on your behalf, and it does not notify anyone. It records
the decision and enforces it. Carrying the question to a person is your job — say plainly
that a payment is waiting and what it is for.

Full documentation: https://docs.agentveins.com

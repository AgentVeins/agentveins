# AgentVeins

**Spending firewall for AI agents. Budgets, allowlists, kill switch, audit.**

> Your agent can spend money. AgentVeins decides how much, where, and proves it.

---

## The problem

AI agents are getting wallets. With x402 now under Linux Foundation governance (Visa, Stripe, Google, Solana Foundation and 40+ members) and the web moving to pay-per-crawl, agents that pay for APIs, data, and services are becoming normal infrastructure.

But nobody sane gives an agent an uncapped wallet. One bug — or one prompt injection — and an agent can drain its balance across thousands of micro-payments overnight, with no record of where the money went or why.

There is no standard way to limit, supervise, or audit agent spending. AgentVeins is that layer.

## What it does

Every payment your agent attempts passes through the guard **before money moves**:

| Check | Question it answers |
|---|---|
| **Allowlist** | Is this vendor approved by the owner? |
| **Budget** | Is it within per-payment / daily / periodic limits? |
| **Velocity** | Is this normal behavior, or a runaway loop? |
| **Kill switch** | Is this agent still authorized at all? |

Payments that pass proceed untouched — the agent never notices. Payments that fail return a structured violation the agent can handle gracefully. Every attempt, allowed or blocked, lands in a tamper-evident audit log: what was paid, to whom, when, and the stated reason.

Corporate card controls, for AI agents.

## Quickstart

```typescript
import { createGuard, Policy } from "@agentveins/core";

const policy: Policy = {
  budgets: [
    { period: "daily", limit: "25.00", currency: "USDC" },
    { period: "per_tx", limit: "1.00", currency: "USDC" },
  ],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { enabled: true },
};

const guard = createGuard({
  policy,
  chain: solanaAdapter({ keypair }),
  audit: fileAuditSink("./audit.jsonl"),
});

// Wrap your agent's payment path — the only integration point
const result = await guard.pay({
  to: "api.weather.com",
  amount: "0.05",
  currency: "USDC",
  reason: "forecast query",
});
// { status: "settled" | "blocked", violation?, txSig?, auditId }

await guard.freeze(); // emergency stop, instantly
```

Integration target: under 10 minutes from `npm install` to your first governed payment.

## What AgentVeins is NOT

- **Not a wallet** — it never holds funds
- **Not a payment rail** — x402/Solana/Base move the money
- **Not an agent framework** — bring your own agent

It sits between your agent and its money. Every wallet, rail, and framework is an integration, not a competitor.

## How it's built

- **Policy is data, not code** — JSON-serializable, versionable, diffable; dashboards can edit it without SDK changes
- **Chain adapters** — Solana first (devnet live), Base next; policy logic never touches chain code
- **Blocked ≠ thrown** — structured violations so agents can retry a cheaper vendor or escalate to a human
- **Audit log** — append-only JSONL with signed entries; boring, dependency-free, verifiable

## Roadmap

- [x] Policy engine: budgets, allowlist, kill switch
- [x] Solana devnet payment path (x402)
- [x] Signed audit log
- [ ] Base adapter
- [ ] Velocity rules
- [ ] Hosted dashboard: team policies, alerts, compliance exports
- [ ] Privacy: payment-metadata redaction

## Why now

Cloudflare measured bot traffic passing 57% of web requests in mid-2026, driven by AI agents — and launched pay-per-crawl to charge them. 31% of enterprises already run agents in production, yet 60% lack formal governance. The rails exist. The seatbelts don't.

## Status

Early and moving fast. Built on Solana (Alpenglow-era, ~150ms finality) by a builder in the Superteam Malaysia ecosystem. Issues, PRs, and hard questions welcome.

**agentveins.com** · MIT License

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
| **Velocity** *(roadmap)* | Is this normal behavior, or a runaway loop? |
| **Kill switch** | Is this agent still authorized at all? |

Payments that pass proceed untouched — the agent never notices. Payments that fail return a structured violation the agent can handle gracefully. Every attempt, allowed or blocked, lands in a tamper-evident audit log: what was paid, to whom, when, and the stated reason.

Corporate card controls, for AI agents.

## Quickstart

```typescript
import { createGuard, fileAuditSink, type Policy } from "@agentveins/core";
import { solanaAdapter } from "@agentveins/adapter-solana";

const policy: Policy = {
  budgets: [
    { period: "daily", limit: "25.00", currency: "USDC" },
    { period: "per_tx", limit: "1.00", currency: "USDC" },
  ],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
};

const guard = await createGuard({
  policy,
  agent: "research-agent",
  adapters: [solanaAdapter({ keypair, rpcUrl, mode: "x402" })],
  audit: fileAuditSink("./audit.jsonl"),
  signingKey,
});

// Wrap your agent's payment path — the only integration point
const result = await guard.pay({
  to: "https://api.weather.com/forecast",
  amount: "0.05",
  currency: "USDC",
  reason: "forecast query",
});
// { status: "settled" | "blocked" | "failed", txSig?, violation?, error?, auditId }

await guard.freeze(); // emergency stop, instantly
```

`signingKey` is an ed25519 private key you own (`generateKeyPairSync("ed25519")`); it signs audit entries and never leaves your process.

Integration target: under 10 minutes from `npm install` to your first governed payment. The guard, policy engine, and signed audit log are live today; `@agentveins/adapter-solana` is still landing — track it on the roadmap below.

## What AgentVeins is NOT

- **Not a wallet** — it never holds funds
- **Not a payment rail** — x402/Solana/Base move the money
- **Not an agent framework** — bring your own agent

It sits between your agent and its money. Every wallet, rail, and framework is an integration, not a competitor.

## How it's built

- **Policy is data, not code** — JSON-serializable, versionable, diffable; dashboards can edit it without SDK changes
- **Chain adapters** — Solana first (devnet live), Base next; policy logic never touches chain code
- **Blocked ≠ thrown** — structured violations so agents can retry a cheaper vendor or escalate to a human; rail errors return `failed` separately, so a network hiccup never looks like a policy denial
- **Audit log** — append-only JSONL with hash-chained, signed entries; boring, dependency-free, verifiable. It detects edits, deletions, reordering, and forged entries outright, and detects truncation as long as the signed anchor file survives. Restoring an older matching snapshot of *both* the log and its anchor is not detected — closing that needs append-only or remote storage, which is post-MVP.

## Roadmap

- [x] Policy engine: budgets, allowlist, kill switch
- [ ] Solana devnet payment path (x402)
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

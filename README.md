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
import { createGuard, fileAnchorStore, fileAuditSink, type Policy } from "@agentveins/core";
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
  logId: "research-agent-main", // names this agent's log; a log that claims another id is refused
  adapters: [solanaAdapter({ keypair, rpcUrl, mode: "x402" })],
  audit: fileAuditSink("./audit.jsonl"),
  anchor: fileAnchorStore("./audit.anchor.json"), // detects a truncated or deleted log
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
// auditId is "" when the guard is latched (see below) and this attempt was blocked
// before it could be recorded at all

await guard.freeze(); // emergency stop, instantly
```

`signingKey` is an ed25519 private key you own (`generateKeyPairSync("ed25519")`); it signs audit entries and the anchor, and never leaves your process. Keep the `anchor` store: without it a deleted `audit.jsonl` looks like a fresh start and silently restores the full budget. If the audit log cannot be written, the guard latches: the payment in flight when the write fails still settles and is still reported `settled` with its real signature, but every payment *after* that is blocked with an `audit_unavailable` violation — a guard that cannot record does not authorize what comes next, though it cannot undo what it already did. See "Audit log" below for what that latch does and does not guarantee.

Integration target: under 10 minutes from `npm install` to your first governed payment. The guard, policy engine, and signed audit log are live today, and `@agentveins/adapter-solana` carries both settlement modes — a direct USDC transfer and x402. The x402 payload is checked against the reference facilitator's own verifier in the test suite; no payment has been settled against a live facilitator on devnet yet.

## See it work

```
git clone <this repo> && cd agentveins
npm install
npm run demo -- --mock
```

`npm run demo` builds the workspace automatically the first time, so this is the whole path from
clone to a governed agent loop — no separate build step required. It plays out five acts offline:
an agent spending normally, hitting its per-tx and daily budgets, getting blocked, getting frozen,
and a signed audit log that catches a tampered entry live.

Drop `-- --mock` to run the same five acts as real USDC transfers on Solana devnet — set
`SOLANA_KEYPAIR_PATH`, `VENDOR_ADDRESS`, and (optionally) `SOLANA_RPC_URL` first, either in your
shell or in `examples/demo/.env` (copy `examples/demo/.env.example` to `examples/demo/.env` and
fill it in; loaded automatically if present, never committed). `npm run demo -- --x402` runs a
separate, sixth act: a vendor quotes more than the guard approved, and the adapter refuses to sign
before anything moves.

## What AgentVeins is NOT

- **Not a wallet** — it never holds funds
- **Not a payment rail** — x402/Solana/Base move the money
- **Not an agent framework** — bring your own agent

It sits between your agent and its money. Every wallet, rail, and framework is an integration, not a competitor.

## How it's built

- **Policy is data, not code** — JSON-serializable, versionable, diffable; dashboards can edit it without SDK changes
- **Chain adapters** — Solana devnet first, Base next; policy logic never touches chain code. In x402 mode the adapter re-checks the vendor's 402 quote against the amount the guard approved and signs nothing if the vendor asks for more
- **What policy does not cover in x402 mode** — the allowlist matches the vendor's URL, but the money goes to the `payTo` address that endpoint returns in its 402 response. AgentVeins checks that address is well formed, never that it belongs to the vendor. An allowlisted endpoint that is compromised or DNS-hijacked can name an attacker's address at or under the approved amount, and the allowlist, the budget, and the audit log will all record a normal governed payment. The amount is governed; the recipient is not. Closing that needs a recipient allowlist or a signed vendor identity in the policy
- **Blocked ≠ thrown** — structured violations so agents can retry a cheaper vendor or escalate to a human; rail errors return `failed` separately, so a network hiccup never looks like a policy denial
- **Audit log** — append-only JSONL with hash-chained, signed entries; boring, dependency-free, verifiable. Configured as in the quickstart — log plus anchor — it detects edits, reordering, forged entries, and a log swapped in from another agent outright, and it detects truncation or deletion as long as the signed anchor survives. Limits stated plainly: drop the `anchor` and truncation stops being detectable; restoring an older matching snapshot of *both* files is not detected either way — closing that needs append-only or remote storage, which is post-MVP. And when the sink itself cannot be written — disk full, permissions, a network filesystem hiccup — the guard latches closed rather than paying ungoverned: the payment in flight when the write fails still settles and is reported back to the caller as `settled` with its real transaction signature, but every payment after that is blocked with `audit_unavailable` and an empty `auditId`, because it was never written anywhere. Those blocked attempts leave no trace in `audit.jsonl` itself, so an operator reconciling the log afterward cannot tell whether 1 payment or 10,000 were turned away while the sink was down — only that the tail of the log ends where the outage began. The latch is also process-scoped: it lives in memory, so a restart clears it along with everything the broken sink never recorded. Each fresh process replays whatever the log *does* contain, then authorizes exactly one more payment — up to the per-transaction cap — before its own write to the still-dead sink fails and it latches again. A crash-restart loop against a dead sink can therefore spend one per-transaction cap per restart; strictly better than a guard with no latch at all, but worth writing down rather than assuming away.

## Roadmap

- [x] Policy engine: budgets, allowlist, kill switch
- [x] Solana devnet payment path (x402) — the transaction that x402 mode builds passes x402's own facilitator `verify()` offline; it has not yet been settled against a live facilitator on devnet, so read this row as "verified", not "settled"
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

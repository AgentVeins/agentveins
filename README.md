# AgentVeins

**Spending firewall for AI agents. Budgets, allowlists, kill switch, audit.**

> Your agent can spend money. AgentVeins decides how much, where, and proves it.

---

## The problem

AI agents are getting wallets. With x402 now under Linux Foundation governance (Visa, Stripe, Google, Solana Foundation and 40+ members) and the web moving to pay-per-crawl, agents that pay for APIs, data, and services are becoming normal infrastructure.

But nobody sane gives an agent an uncapped wallet. One bug, or one prompt injection, and an agent can drain its balance across thousands of micro-payments overnight, with no record of where the money went or why.

There is no standard way to limit, supervise, or audit agent spending. AgentVeins is that layer.

## What it does

Every payment your agent attempts passes through the guard **before money moves**:

| Check | Question it answers |
|---|---|
| **Allowlist** | Is this vendor approved by the owner? |
| **Budget** | Is it within per-payment / daily / periodic limits? |
| **Recipients** | Is the money going to an address you approved, not one the vendor named? |
| **Kill switch** | Is this agent still authorized at all? |
| **Velocity** *(roadmap)* | Is this normal behavior, or a runaway loop? |

Payments that pass proceed untouched. The agent never notices. Payments that fail return a structured violation the agent can handle gracefully. Every attempt, allowed or blocked, lands in a tamper-evident audit log: what was paid, to whom, when, and the stated reason.

Corporate card controls, for AI agents.

## Install

```bash
npm install @agentveins/core @agentveins/adapter-solana
```

`@agentveins/core` has **zero runtime dependencies**: it is the policy engine and the audit log, and it knows nothing about any chain. The Solana adapter ships separately so a project governing a different rail never installs 47MB of Solana and x402 machinery it will not call.

## Quickstart

```typescript
import { createGuard, type Policy } from "@agentveins/core";
import { fileAnchorStore, fileAuditSink } from "@agentveins/core/fs";
import { solanaAdapter } from "@agentveins/adapter-solana";

const policy: Policy = {
  budgets: [
    { period: "daily", limit: "25.00", currency: "USDC" },
    { period: "per_tx", limit: "1.00", currency: "USDC" },
  ],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  recipients: { mode: "allowlist", entries: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"] },
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

// Wrap your agent's payment path: the only integration point
const result = await guard.pay({
  to: "https://api.weather.com/forecast",
  amount: "0.05",
  currency: "USDC",
  reason: "forecast query",
});
// { status: "settled" | "blocked" | "failed", txSig?, violation?, error?, auditId }
// auditId is "" when the guard is latched (see below) and this attempt was blocked
// before it could be recorded at all
// a "failed" result carries error.txSig when the rail broadcast a transaction it could not
// confirm: the money may have moved, so reconcile that signature against an explorer

await guard.freeze(); // emergency stop, instantly: see below
await guard.flush();  // optional: waits for queued audit writes to reach the sink
```

`freeze()` means it: it closes the kill switch in memory before it returns, so every later `pay` is already blocked even while a payment is still waiting on a slow rail. Only its audit entry is queued behind that payment, which is what `flush()` waits for. Call it before exiting a process that just froze. Payments themselves stay strictly serialized, so two concurrent calls can never race the same budget. `unfreeze()` is queued in full: the switch may snap shut out of turn, never open out of turn.

`signingKey` is an ed25519 private key you own (`generateKeyPairSync("ed25519")`); it signs audit entries and the anchor, and never leaves your process. Keep the `anchor` store: without it a deleted `audit.jsonl` looks like a fresh start and silently restores the full budget. If the audit log cannot be written, the guard latches: the payment in flight when the write fails still settles and is still reported `settled` with its real signature, but every payment *after* that is blocked with an `audit_unavailable` violation. A guard that cannot record does not authorize what comes next, though it cannot undo what it already did. See "Audit log" below for what that latch does and does not guarantee.

Integration target: under 10 minutes from `npm install` to your first governed payment. The guard, policy engine, and signed audit log are live today, and `@agentveins/adapter-solana` carries both settlement modes. A direct USDC transfer and x402. The x402 payload is checked against the reference facilitator's own verifier in the test suite; no payment has been settled against a live facilitator on devnet yet.

## See it work

```
git clone https://github.com/AgentVeins/agentveins.git && cd agentveins
npm install
npm run demo -- --mock
```

`npm run demo` builds the workspace automatically the first time, so this is the whole path from
clone to a governed agent loop: no separate build step required. It plays out five acts offline:
an agent spending normally, hitting its per-tx and daily budgets, getting blocked, getting frozen,
and a signed audit log that catches a tampered entry live.

Drop `-- --mock` to run the same five acts as real USDC transfers on Solana devnet: set
`SOLANA_KEYPAIR_PATH`, `VENDOR_ADDRESS`, and (optionally) `SOLANA_RPC_URL` first, either in your
shell or in `examples/demo/.env` (copy `examples/demo/.env.example` to `examples/demo/.env` and
fill it in; loaded automatically if present, never committed). `npm run demo -- --x402` runs a
separate, sixth act: a vendor quotes more than the guard approved, and the adapter refuses to sign
before anything moves.

## What AgentVeins is NOT

- **Not a wallet**: it never holds funds
- **Not a payment rail**: x402/Solana/Base move the money
- **Not an agent framework**: bring your own agent

It sits between your agent and its money. Every wallet, rail, and framework is an integration, not a competitor.

## How it's built

- **Policy is data, not code**: JSON-serializable, versionable, diffable; dashboards can edit it without SDK changes
- **Chain adapters**: Solana devnet first, Base next; policy logic never touches chain code. In x402 mode the adapter re-checks the vendor's 402 quote against the amount the guard approved and signs nothing if the vendor asks for more
- **Who ends up holding the money, in x402 mode**, the vendor allowlist matches the endpoint's URL, but the funds go to the `payTo` address that endpoint returns in its 402 response, and a well-formed address is not the same thing as the vendor's address. Set `policy.recipients` and the adapter refuses any quote naming a destination you did not approve, before it signs anything, an allowlisted endpoint that is compromised or DNS-hijacked cannot redirect the payment. Leave `policy.recipients` out and that check does not run: the amount is still governed, the payee is not, and the allowlist, the budget and the audit log will all record a normal governed payment to an attacker. Recipients are matched exactly and base58 is case-sensitive. What this still does not prove is that an approved address *belongs to* the vendor. It proves only that you named it in advance; binding an address to a vendor identity needs a signed vendor record, which is post-MVP
- **Blocked ≠ thrown**: structured violations so agents can retry a cheaper vendor or escalate to a human; rail errors return `failed` separately, so a network hiccup never looks like a policy denial
- **A payment that cannot be confirmed is not a payment that failed**: direct mode gives up on confirmation after a bounded wall clock and attempt count (90s and 300 polls by default, both configurable), rather than polling a lagging node forever. The caller gets `failed` with `error.code: "timeout"`, because nothing may be treated as delivered; the audit log records the attempt as `uncertain` with its signature, and it consumes budget exactly like a settlement. Under-counting spend the cluster may have accepted would let the agent send the same money twice, so the guard rounds against the agent and leaves the operator a signature to reconcile
- **Audit log**, append-only JSONL with hash-chained, signed entries; boring, dependency-free, verifiable. Configured as in the quickstart, log plus anchor, it detects edits, reordering, forged entries, and a log swapped in from another agent outright, and it detects truncation or deletion as long as the signed anchor survives. Limits stated plainly: drop the `anchor` and truncation stops being detectable; restoring an older matching snapshot of *both* files is not detected either way, closing that needs append-only or remote storage, which is post-MVP. And when the sink itself cannot be written, disk full, permissions, a network filesystem hiccup, the guard latches closed rather than paying ungoverned: the payment in flight when the write fails still settles and is reported back to the caller as `settled` with its real transaction signature, but every payment after that is blocked with `audit_unavailable` and an empty `auditId`, because it was never written anywhere. Those blocked attempts leave no trace in `audit.jsonl` itself, so an operator reconciling the log afterward cannot tell whether 1 payment or 10,000 were turned away while the sink was down, only that the tail of the log ends where the outage began. The latch is also process-scoped: it lives in memory, so a restart clears it along with everything the broken sink never recorded. Each fresh process replays whatever the log *does* contain, then authorizes exactly one more payment, up to the per-transaction cap, before its own write to the still-dead sink fails and it latches again. A crash-restart loop against a dead sink can therefore spend one per-transaction cap per restart; strictly better than a guard with no latch at all, but worth writing down rather than assuming away.

## Roadmap

- [x] Policy engine: budgets, allowlist, kill switch
- [x] Solana devnet payment path (x402): the transaction that x402 mode builds passes x402's own facilitator `verify()` offline; it has not yet been settled against a live facilitator on devnet, so read this row as "verified", not "settled"
- [x] Signed audit log
- [ ] Base adapter
- [ ] Velocity rules
- [ ] Hosted dashboard: team policies, alerts, compliance exports
- [ ] Privacy: payment-metadata redaction

## Why now

Cloudflare measured bot traffic passing 57% of web requests in mid-2026, driven by AI agents, and launched pay-per-crawl to charge them. 31% of enterprises already run agents in production, yet 60% lack formal governance. The rails exist. The seatbelts don't.

## Status

Early and moving fast. Built on Solana (Alpenglow-era, ~150ms finality). Issues, PRs, and hard questions welcome.

**agentveins.com** · MIT License

# @agentveins/core

**Spending firewall for AI agents.** Budgets, allowlists, approved recipients, kill switch, signed audit log.

Your agent calls `guard.pay()` instead of paying directly. Every attempt, allowed or refused, is checked against one policy and appended to a tamper-evident log. The guard holds no funds and moves no money itself; a wallet adapter does that.

Zero runtime dependencies, and the main entry point never touches the filesystem: `node:crypto` only. The disk-backed sink and anchor store live behind `@agentveins/core/fs`, so a consumer running entirely in memory is never handed filesystem reach it did not ask for.

```bash
npm install @agentveins/core
```

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
  logId: "research-agent-main",
  adapters: [solanaAdapter({ keypair, rpcUrl, mode: "direct" })],
  audit: fileAuditSink("./audit.jsonl"),
  anchor: fileAnchorStore("./audit.anchor.json"),
  signingKey,
});

const result = await guard.pay({
  to: "https://api.weather.com/forecast",
  amount: "0.05",
  currency: "USDC",
  reason: "forecast query",
});

await guard.freeze(); // emergency stop
```

## What `pay()` returns

```typescript
{ status: "settled";  txSig: string;        auditId: string }
{ status: "blocked";  violation: Violation; auditId: string }
{ status: "failed";   error: PaymentError;  auditId: string }
```

**A refused payment never reaches an adapter**: the guard returns before any network call, so nothing is built, signed, or broadcast.

`blocked` means policy said no (`kill_switch`, `vendor_not_allowed`, `budget_exceeded`, `invalid_request`, `audit_unavailable`); retrying will fail the same way. `failed` means the rail failed, not the policy. Policy denial **never throws**: only invalid configuration does, at construction.

## How it enforces

Checks run in a fixed order — kill switch, allowlist, budget, then approval — and the first failure stops everything. The order is a security property twice over: a frozen agent paying an unapproved vendor reports `kill_switch`, so you learn the most fundamental reason first, and approval runs last because routing a payment to a person when the budget already forbids it asks them to rule on a decision policy has made.

**The policy is a frozen copy.** `createGuard` takes a deep copy at construction and enforces that, so neither the object you passed in nor `guard.policy` can be edited afterwards to widen a rule. A limit that could be raised without a violation and without an audit entry is not a limit.

**There is no spend counter.** On startup the guard replays the audit log and reconstructs both spend totals and frozen state from it, so restarting an agent cannot reset its budget. The log is not just evidence: it is enforcement.

Money is `bigint` minor units end to end. Limits are decimal strings at the API boundary, parsed once, and `Number` never touches an amount.

## Approvals

Set a threshold and a payment above it is held until a person authorises those exact terms:

```typescript
approvals: { above: "5.00" }
```

`pay()` does not wait. It returns `blocked` with `approval_required`, so `PayResult` keeps its three states and one held payment cannot stall the others. An approval binds one agent, one vendor and one exact amount, once, until it expires, and it is consumed *before* the rail — a rail failure burns it and the person is asked again, the same direction the guard already rounds for a settlement it cannot confirm.

Grant one through `ApprovalStore.grant()`, or with [`@agentveins/cli`](https://www.npmjs.com/package/@agentveins/cli). AgentVeins never asks anyone: it records the decision and enforces it, and the audit log is the queue of what is waiting.

## Checking without paying

```typescript
const verdict = await guard.check({ to, amount, currency, reason });
```

Answers whether a payment would pass, moving no money, writing no audit entry, consuming no budget and spending no approval. It runs the same admission path `pay()` does rather than a second implementation, so the two agree. Its answer is a snapshot, not a promise — a payment made in between can take the budget.

## The audit log

Append-only JSONL. Every line is hash-chained to the previous and signed with your Ed25519 key. `verifyAuditLog()` is exported so anyone can check a log independently.

It detects edits, deletions, reordering, forged entries, and whole-log substitution. Tail truncation is detected **only** with the anchor: a signed record of the log's expected head, written after every append. Configure `anchor` and the guard refuses to start on a truncated log.

Known limits, stated plainly: deleting the anchor makes truncation undetectable again, and restoring an older *matching* snapshot of both files is not detected. Closing that needs storage the operator cannot rewrite.

## Status

Pre-1.0. Devnet only: no mainnet configuration exists. Breaking changes are allowed and marked with `!` in commit subjects.

Full documentation, including every guarantee and every limit: **[docs.agentveins.com](https://docs.agentveins.com)**

MIT

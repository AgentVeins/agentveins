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

Checks run in a fixed order, kill switch, then allowlist, then budget, and the first failure stops everything. The order is a security property: a frozen agent paying an unapproved vendor reports `kill_switch`, so you learn the most fundamental reason first.

**There is no spend counter.** On startup the guard replays the audit log and reconstructs both spend totals and frozen state from it, so restarting an agent cannot reset its budget. The log is not just evidence: it is enforcement.

Money is `bigint` minor units end to end. Limits are decimal strings at the API boundary, parsed once, and `Number` never touches an amount.

## The audit log

Append-only JSONL. Every line is hash-chained to the previous and signed with your Ed25519 key. `verifyAuditLog()` is exported so anyone can check a log independently.

It detects edits, deletions, reordering, forged entries, and whole-log substitution. Tail truncation is detected **only** with the anchor: a signed record of the log's expected head, written after every append. Configure `anchor` and the guard refuses to start on a truncated log.

Known limits, stated plainly: deleting the anchor makes truncation undetectable again, and restoring an older *matching* snapshot of both files is not detected. Closing that needs storage the operator cannot rewrite.

## Status

Pre-1.0. Devnet only: no mainnet configuration exists. Breaking changes are allowed and marked with `!` in commit subjects.

Full documentation, including every guarantee and every limit: **[docs/how-it-works.md](https://github.com/AgentVeins/agentveins/blob/main/docs/how-it-works.md)**

MIT

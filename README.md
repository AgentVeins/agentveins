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
| **Approval** | Is this above the amount a human must sign off on? |
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
import { fileAnchorStore, fileApprovalStore, fileAuditSink } from "@agentveins/core/fs";
import { solanaAdapter } from "@agentveins/adapter-solana";

const policy: Policy = {
  budgets: [
    { period: "daily", limit: "25.00", currency: "USDC" },
    { period: "per_tx", limit: "1.00", currency: "USDC" },
  ],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  recipients: { mode: "allowlist", entries: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"] },
  killSwitch: { frozen: false },
  approvals: { above: "5.00" },      // above this, a human must approve
};

const guard = await createGuard({
  policy,
  agent: "research-agent",
  logId: "research-agent-main", // names this agent's log; a log that claims another id is refused
  adapters: [solanaAdapter({ keypair, rpcUrl, mode: "x402" })],
  audit: fileAuditSink("./audit.jsonl"),
  anchor: fileAnchorStore("./audit.anchor.json"), // detects a truncated or deleted log
  approvals: fileApprovalStore("./approvals.json"), // required when policy.approvals is set
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

A payment above `approvals.above` with no matching approval on file returns `blocked` with `approval_required` and never reaches the rail. It is a denial, not a suspended call: `pay()` does not wait, because payments are serialized and one pending approval would otherwise stall every other payment the agent makes. Approve those exact terms in the store and the agent's retry settles. An approval is bound to one agent, one vendor and one exact amount, is spent on use, and is consumed *before* the rail is called — so a rail failure burns it and the human is asked again, which is the same direction the guard already rounds for an unconfirmed settlement.

If the store cannot be read, or the approval cannot be claimed — a peer process may have taken it, or the store may be down — the payment blocks with `approval_unavailable` rather than `approval_required`. The guard cannot tell those two apart, so it asserts neither into a log whose entries are signed and permanent. Neither case latches the guard: payments below the threshold keep settling. A `freeze()` that lands while the gate is waiting on the store also stops the payment, with `kill_switch`, because the switch is re-read before the rail is called; an approval already spent by then stays spent and the human is asked again. One limit stated plainly: `fileApprovalStore` serializes consumes within a process, not across them, so two processes sharing one approval file can both spend one approval. Run one process per policy, or back the store with a database that locks.

**Writing approvals is your job.** `fileApprovalStore` reads approvals and spends them; it has no write API, because deciding to release money is the human half of this feature and an agent's own process should not hold a pen for it. The file is a JSON array:

```json
[
  {
    "id": "apr_1",
    "agent": "research-agent",
    "vendorNormalized": "api.weather.com",
    "amountMinor": "7500000",
    "expiresAt": "2026-09-01T00:00:00.000Z",
    "usedAt": null
  }
]
```

`amountMinor` is a **decimal string of USDC minor units** (`"7500000"` is 7.50), never a JSON number — a number cannot carry a u64 exactly. `agent` must match the guard's `agent`, and `vendorNormalized` must match what `normalizeVendor()` returns for the vendor URL. `expiresAt` is ISO 8601. `usedAt` must be present and explicitly `null` while unspent; the store stamps it with an ISO timestamp when the guard spends it. A record missing a field or carrying the wrong type throws a `SyntaxError` naming the file and the record — a malformed approval is never read as a quiet denial.

`freeze()` means it: it closes the kill switch in memory before it returns, so every later `pay` is already blocked even while a payment is still waiting on a slow rail. Only its audit entry is queued behind that payment, which is what `flush()` waits for. Call it before exiting a process that just froze. Payments themselves stay strictly serialized, so two concurrent calls can never race the same budget. `unfreeze()` is queued in full: the switch may snap shut out of turn, never open out of turn.

`signingKey` is an ed25519 private key you own (`generateKeyPairSync("ed25519")`); it signs audit entries and the anchor, and never leaves your process. Keep the `anchor` store: without it a deleted `audit.jsonl` looks like a fresh start and silently restores the full budget. If the audit log cannot be written, the guard latches: the payment in flight when the write fails still settles and is still reported `settled` with its real signature, but every payment *after* that is blocked with an `audit_unavailable` violation. A guard that cannot record does not authorize what comes next, though it cannot undo what it already did. See "Audit log" below for what that latch does and does not guarantee.

Integration target: under 10 minutes from `npm install` to your first governed payment. The guard, policy engine, and signed audit log are live today, and `@agentveins/adapter-solana` carries both settlement modes. A direct USDC transfer and x402. Both have settled real USDC on devnet: x402 mode settles through x402's own reference facilitator, run in-process against devnet rather than hosted by a third party, and `examples/demo/test/devnet-x402.test.ts` reproduces it and reads the signature back from the chain.

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
before anything moves. That act prints the x402 handshake as it happens — the 402 quote, its
price, its `payTo` and its fee payer — because x402 negotiates over HTTP and none of it is visible
on-chain, where an explorer sees an ordinary token transfer and cannot label it x402.

Every command in this repo, including settling on devnet, is listed under [Commands](#commands).

## Commands

Every command runs from the repo root. `npm install` once, at the root — the workspaces link to
each other, so installing inside a package instead will pull published copies from the registry
and you will be testing the wrong code.

### Build and check

```
npm run build                                     # tsc --build, all packages
npx tsc --build --force                           # clean rebuild; use after deleting any dist/
npm test                                          # whole repo; skips everything that spends money
npm run typecheck --workspace=@agentveins/core    # covers tests, which the build does not
```

`--force` is not superstition: `tsc --build` trusts its `.tsbuildinfo` and silently skips a
project whose `dist/` was removed by hand, which surfaces as type errors in whatever package
depends on it rather than in the one that is actually stale.

### Demo

```
npm run demo -- --mock                            # five acts, no network, no keys
npm run demo -- --x402                            # the x402 act, printing the HTTP handshake
npm run demo -- --approvals                       # the approval act: blocked, approved, settled
npm run demo                                      # direct mode against devnet; needs .env
npm run vendor --workspace=@agentveins/demo       # the 402 vendor alone, on VENDOR_PORT
```

### Settling on devnet

```
npm run test:devnet --workspace=@agentveins/demo            # x402 settlement, ~0.01 USDC
npm run test:devnet:approvals --workspace=@agentveins/demo  # approval gate over x402, ~0.01 USDC
```

Skipped unless `DEVNET_SETTLE=1`, which those scripts set for the one run. The flag exists because
the tests spend real money and `prepublishOnly` runs the full suite — publishing must never move
funds as a side effect of a configured machine.

The approval run is the one that proves the gate and the rail compose. Every other approval test
stubs the adapter, so it can only show what the guard returned; this one counts the calls the
adapter makes and shows what it did. A payment blocked for approval reaches the vendor zero times
— no quote fetched, nothing signed — and the replay after settlement is refused before the chain
is touched again, not merely reported as refused. Three payments, one settlement, and the
recipient's balance moves exactly once.

### Publishing

```
npm publish --workspace=@agentveins/core --access public
npm publish --workspace=@agentveins/adapter-solana --access public
npm publish --workspace=@agentveins/core --dry-run     # runs the gate, uploads nothing
```

Core first; the adapter depends on it. `prepublishOnly` forces a clean build and runs the suite,
so a stale `dist/` cannot ship.

### Inspecting what settled

```
solana confirm -v <SIGNATURE> --url devnet
solana transaction-history <TOKEN_ACCOUNT> --url devnet --limit 5
spl-token balance --address <TOKEN_ACCOUNT> --url devnet
```

`solana confirm -v` is what shows the x402 shape: `Account 0` is the facilitator, marked
`(fee payer)`, and the agent is `Account 1` marked `sr--` — a signer that is not writable, so its
SOL balance cannot be touched. An agent paying over x402 needs the asset it spends and no gas.

### Devnet keys

x402 needs two funded keypairs, because the agent signs a transfer it cannot broadcast and the
facilitator pays the fee and submits it.

```
solana-keygen new --no-bip39-passphrase -s -o examples/demo/devnet-keypair.json
solana-keygen new --no-bip39-passphrase -s -o examples/demo/devnet-facilitator.json
spl-token create-account <USDC_MINT> --owner <VENDOR_WALLET> \
  --fee-payer examples/demo/devnet-keypair.json --url devnet
```

SOL from [faucet.solana.com](https://faucet.solana.com) for both keys, devnet USDC from
[faucet.circle.com](https://faucet.circle.com) for the agent only. `solana airdrop` works when the
public endpoint is not rate-limited, which is rarely. Create the vendor's token account before
settling: the transaction carries only `TransferChecked` and never creates one, so a missing
destination account fails on-chain rather than politely.

### Environment

`examples/demo/.env`, read by the demo and the devnet test. Copy `.env.example` and fill it in.

| Variable | Purpose |
| --- | --- |
| `SOLANA_RPC_URL` | Defaults to `https://api.devnet.solana.com` |
| `SOLANA_KEYPAIR_PATH` | The agent — signs the transfer |
| `FACILITATOR_KEYPAIR_PATH` | The fee payer — broadcasts it |
| `VENDOR_ADDRESS` | A wallet address, **not** a token account; the adapter derives the token account itself |
| `VENDOR_PORT` | The demo's local vendor; defaults to 3001 |
| `DEVNET_SETTLE` | Set to `1` to let the settlement test run. Leave it out of `.env` |

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
- [x] Solana devnet payment path (x402): **settled**, not merely verified — [`43ctpPA1…FmNte`](https://explorer.solana.com/tx/43ctpPA1RDqyoPoaTaJXngbot7TowVbUX6SQpmH9z5UQjT92AGFNA7kxasf4HTUVgaPHGL78gVdTvPLmn24FmNte?cluster=devnet) moved 0.01 USDC on devnet with the agent signing the transfer and the facilitator paying the fee. The facilitator is x402's reference implementation run in-process (`examples/demo/src/facilitator.ts`), not a hosted third party; settlement against someone else's facilitator is untested
- [x] Signed audit log
- [x] Approval workflows: a threshold above which a human must approve, bound to exact terms and spent on use
- [ ] Base adapter
- [ ] Velocity rules
- [ ] Hosted dashboard: team policies, alerts, compliance exports
- [ ] Privacy: payment-metadata redaction

## Why now

Cloudflare measured bot traffic passing 57% of web requests in mid-2026, driven by AI agents, and launched pay-per-crawl to charge them. 31% of enterprises already run agents in production, yet 60% lack formal governance. The rails exist. The seatbelts don't.

## Status

Early and moving fast. Built on Solana (Alpenglow-era, ~150ms finality). Issues, PRs, and hard questions welcome.

**agentveins.com** · MIT License

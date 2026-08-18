# How AgentVeins works

What the code in this repo actually does today, including what it does **not** do. The README is the pitch; this is the description.

---

## The idea in one paragraph

An AI agent with a wallet can spend money. AgentVeins sits between the agent and its money: the agent calls `guard.pay()` instead of paying directly, and the guard decides whether the payment happens. Every attempt, allowed or refused, is appended to a signed, hash-chained log. The guard holds no funds and moves no money itself; a **wallet adapter** does that, and the policy engine has no idea what a blockchain is.

## The only integration point

```ts
const result = await guard.pay({
  to: "https://api.weather.com/forecast",
  amount: "0.05",
  currency: "USDC",
  reason: "forecast query",
});
```

That is the entire surface an agent touches. Everything else, policy, budgets, the log, the kill switch, is configuration the operator sets up once.

## What happens on a payment

The guard evaluates checks **in a fixed order**, and the first failure stops everything:

| # | Check | Question |
|---|---|---|
| 1 | Kill switch | Is this agent authorised at all? |
| 2 | Allowlist | Is this vendor approved? |
| 3 | Budget | Is this within the per-transaction and daily limits? |

The order is a security property, not a style choice. A frozen agent paying an unapproved vendor reports `kill_switch`, not `vendor_not_allowed`: you learn the most fundamental reason first.

**A refused payment never reaches an adapter.** The guard returns before any network call, so no transaction is built, signed, or broadcast. A test asserts exactly this for every refusal reason.

Only if all three pass does the adapter run and money move.

## The three results

`pay()` never throws on a refusal. It returns one of three shapes, and the distinction matters because an agent has to decide what to do next:

```ts
{ status: "settled";  txSig: string;      auditId: string }
{ status: "blocked";  violation: Violation; auditId: string }
{ status: "failed";   error: PaymentError;  auditId: string }
```

- **`settled`**: money moved and the transaction is confirmed on chain.
- **`blocked`**: policy said no. Codes: `kill_switch`, `vendor_not_allowed`, `budget_exceeded`, `invalid_request`, `audit_unavailable`. Retrying the same payment will fail the same way; the agent should adapt (cheaper vendor, escalate to a human, stop).
- **`failed`**: the rail failed, not the policy. Codes: `adapter_error`, `price_mismatch`, `recipient_not_allowed`, `insufficient_funds`, `timeout`. Some of these are worth retrying and some are not: `price_mismatch` and `recipient_not_allowed` mean the vendor asked for something you did not approve, so retrying hits the same refusal. See also the `timeout` exception below.

Keeping `blocked` and `failed` apart is deliberate. Collapsing them would leave an agent unable to tell "you are out of budget, stop" from "the network hiccuped, try again."

## Policy is data

A policy is a plain JSON-serialisable object. No code, no callbacks, so it can be versioned, diffed, and eventually edited by a dashboard without touching the SDK.

```ts
const policy: Policy = {
  budgets: [
    { period: "per_tx", limit: "0.10", currency: "USDC" },
    { period: "daily",  limit: "0.50", currency: "USDC" },
  ],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
};
```

`validatePolicy` rejects malformed shapes **at construction time**: unknown periods, duplicate periods, unparseable or negative limits, over-precise amounts, an empty allowlist, a non-boolean kill switch. Bad configuration fails immediately and loudly; bad payments fail softly with a structured violation.

**Money is never a floating-point number.** Limits are decimal strings at the API boundary (`"25.00"`), parsed exactly once into `bigint` minor units, and stay `bigint` everywhere after that. USDC has 6 decimals, and amounts up to the u64 maximum survive the round trip byte-exact.

**Budget windows are UTC calendar days**, keyed as `daily:YYYY-MM-DD`. Not local time, not a rolling 24 hours. Only `settled` payments consume budget: refused and failed attempts are logged but never counted.

## Where the spend counter lives

There isn't one. That is the design.

On startup the guard **replays the audit log** and reconstructs both the spend totals and the frozen state from it. There is no separate counter file that could drift from the record, and restarting an agent cannot reset its budget, because the budget *is* the log.

This is also why the log's integrity matters so much: it is not just evidence, it is enforcement.

## The audit log

Append-only JSONL. Every line is hash-chained to the previous one and signed with the operator's Ed25519 key.

```
prevHash ← the previous entry's hash, verbatim
hash     ← sha256 over a fixed-order canonical form of every signed field
sig      ← ed25519 over "agentveins.audit.v1\n" + hash
```

Each entry records the timestamp, agent, vendor (raw and normalised), rail, amount, reason, outcome, any violation or error, and the transaction signature.

`verifyAuditLog()` is exported so anyone, you, an auditor, a grant reviewer, can check a log independently.

### What it detects

| Attack | Detected? | How |
|---|---|---|
| Edit any signed field | ✅ | the hash no longer matches |
| Delete an entry from the middle | ✅ | the next entry's `prevHash` dangles |
| Reorder entries | ✅ | sequence gap |
| Forge a new entry | ✅ | no valid signature without the operator key |
| Substitute another log entirely | ✅ | `logId` is signed into every entry |
| Truncate the tail | ✅ **only with the anchor** | see below |

### The anchor

Truncation is the hard one: a strict prefix of a valid chain is itself a valid chain, so the log cannot detect its own tail being cut. And because spend replays from the log, deleting trailing lines would silently restore budget.

So the guard keeps a tiny out-of-band **anchor**, a signed record of the log's expected head, written after every append and checked at startup. A truncated log no longer reaches the anchored position, and the guard refuses to start.

The guard fails closed on every ambiguous case: an absent anchor beside a non-empty log, a bad anchor signature, a `logId` mismatch, or a log that ends short of the anchor all throw at construction rather than being treated as a fresh start.

### What it does not detect

Stated plainly, because "tamper-evident" should not imply more than it delivers:

- **Delete the anchor and truncation becomes undetectable again.** An unauthenticated file on the same disk can always be removed. The guard refuses to start when the anchor is missing but the log is not, but if both go, it looks like a first run.
- **Rolling *both* files back to an older matching snapshot is not detected.** Signing stops an attacker *fabricating* an anchor; it does not stop them replaying a genuine older one alongside a matching log. Detecting that needs monotonic state outside both files, and same-disk state rolls back with them. Closing it properly means append-only or remote storage: post-MVP.

## The kill switch

`freeze()` closes the switch **immediately in memory**, so the very next `pay()` is already blocked, and queues its control entry to the log behind whatever payment was in flight. That ordering is deliberate: an emergency stop should not wait on a rail call that might take 90 seconds.

The trade-off is that `freeze()` resolves before its entry is durable. `flush()` exists to wait for that, and you should call it before exiting a process that just froze: otherwise a crash inside that window loses the record, and a restart replays as unfrozen.

Freezing is **sticky from either source**: a policy set to `frozen: true` cannot be defeated by a stale `unfreeze` in the log, and `unfreeze()` refuses to clear a policy-level freeze. Both directions resolve toward more restrictive.

## When the log cannot be written

A governance tool that cannot record cannot authorise. If an audit write fails, disk full, read-only mount, a remote sink down, the guard **latches closed**: every later `pay()` returns `blocked` with `audit_unavailable` before touching an adapter.

Two honest caveats:

- **Latched refusals leave no trace.** They produce no audit entry and their `auditId` is the empty string, so an operator reconciling the log cannot tell whether one payment or ten thousand were refused while the sink was down.
- **The latch is process-scoped.** A restart clears it, so with a persistently dead sink each fresh process authorises exactly one payment before latching again.

If a payment settles on chain and only the *recording* fails, the guard still returns `settled` with the real signature, it will not tell you money stayed put when it did not, and then latches.

## Settlement on Solana

`@agentveins/adapter-solana` implements the `WalletAdapter` interface twice over one shared signing path.

### `direct` mode: proven, and what the demo uses

Builds an SPL USDC transfer, signs it, submits it, and then **waits for confirmation** by polling `getSignatureStatuses`, bounded by the transaction's `lastValidBlockHeight` and by a wall clock (90s) and attempt ceiling (300) you can configure.

Confirmation is not optional detail. `sendTransaction` returns as soon as a node *accepts* the transaction, which is not the same as it landing: blockhash expiry and congestion drops are ordinary on Solana. Returning success at acceptance would record `settled` for money that never moved and burn budget permanently, with no reversal path.

If confirmation times out while the transaction is still plausibly in flight, the guard records a fourth audit outcome, **`uncertain`**, carrying the signature, and **consumes the budget** while returning `failed` with `error.code: "timeout"` and `error.txSig`. Rounding against the agent is deliberate: it can never under-count, so a retry that moves money a second time is matched by a second budget unit.

> ⚠️ **Sharp edge.** An agent that retries on a bare `status === "failed"` without inspecting `error.code` will spend budget twice for one uncertain payment. Check the code.

### `x402` mode: spec-conforming, not yet settled live

x402 is the HTTP 402 payment protocol. The agent requests a resource, receives a `402` quote, and pays by attaching a signed transaction in an `X-PAYMENT` header.

The adapter builds a transaction the `exact` SVM scheme accepts: fee payer taken from the quote's `extra.feePayer` (the **facilitator** pays gas, not you), instructions ordered `[SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked]`, and only *partially* signed so the facilitator can sign slot 0 and broadcast.

**The price-mismatch guard is the point of this mode.** In x402 the vendor declares the price *after* the guard already approved an amount. The adapter compares the quote against what was approved and **signs nothing** if the vendor asks for more. A cheaper quote pays the cheaper price. A malformed or missing quote fails closed.

**Status, precisely:** the transaction is accepted by the shipped `ExactSvmSchemeV1.verify()` from `@x402/svm`, run offline as a test. **Nothing has been settled against a live facilitator on devnet.** The roadmap reflects that distinction.

One limit worth knowing: **policy governs the vendor URL, not the recipient.** The allowlist matches `api.weather.com`, but the funds go to whatever `payTo` address that endpoint returns. A compromised or DNS-hijacked allowlisted vendor could name an attacker's address at or under the approved amount, and the allowlist, budget, and audit log would all report a normal governed payment. Only the amount is governed today.

## What is real and what is a stub

| Package | Status |
|---|---|
| `@agentveins/core` | Working. Zero runtime dependencies. |
| `@agentveins/adapter-solana` | Working. `direct` settles and confirms; `x402` builds valid payloads, unverified against a live facilitator. |
| `@agentveins/adapter-base` | Stub: throws `NotImplementedError` **at construction**. |
| `@agentveins/adapter-cloudflare` | Stub: same. |

The stubs throw when you build them, not when you pay. A stub that returns an object and fails later is exactly the thing that gets mistaken for working code.

## The demo

`npm run demo -- --mock` runs offline in five acts: the policy, ten normal payments, three refusals (per-transaction cap, unapproved vendor, daily budget exhausted), the kill switch, then the proof. It prints the log, verifies it, then alters one entry and shows verification failing at that sequence number.

The tamper reveal is real. Stub `verifyAuditLog` to always return OK and the output visibly changes while the test suite fails.

`npm run demo -- --x402` runs the price-mismatch demonstration against a local 402 vendor: the vendor quotes above what the agent requested, the adapter refuses to sign, and nothing moves.

## Known open item

`sendTransaction` throwing **after** broadcast (`packages/adapter-solana/src/index.ts`) records `failed` with `txSig: null` and consumes no budget, but the transaction may already be on its way. It is the same "money may have moved" class as the confirmation gap that was fixed, and it is the first thing on the post-MVP list.

## Verifying any of this yourself

```bash
npm install
npm run build
npm test                    # 267 pass, 1 skipped (network-gated devnet test)
npm run demo -- --mock      # the full loop, offline
```

The whole suite runs with no network access. The single skipped test is the devnet integration check, gated behind environment variables and excluded from CI.

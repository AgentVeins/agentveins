# AgentVeins MVP — Design Spec

**Date:** 2026-08-12
**Scope:** Weeks 0–6 MVP — policy engine, signed audit log, Solana devnet adapter, demo.
**Status:** Approved for planning.

---

## 1. Goal

Ship `@agentveins/core` plus a working Solana devnet adapter and a two-minute terminal demo that proves the pitch: an agent spends normally, hits its aggregate daily budget mid-loop, gets blocked with a structured violation, gets frozen by a kill switch, and every attempt lands in a tamper-evident audit log whose tampering is *demonstrated*, not asserted.

Non-goals for this spec: velocity rules, approval workflows, Base and Cloudflare adapter implementations, hosted dashboard, metadata redaction.

## 2. Settled decisions

These came out of brainstorming and are not open for relitigation during implementation.

| Decision | Choice | Why |
|---|---|---|
| Spend counter persistence | Derived by replaying the audit log | One source of truth; the counter inherits the log's tamper-evidence. No second store to drift. |
| Engine structure | Ordered array of pure check functions | Velocity and approvals become additive. Each check is unit-testable with plain objects. |
| Solana settlement | One adapter, two modes (`x402` \| `direct`) | Both share the build-and-sign path; they differ only in who submits. `direct` is demo insurance against facilitator downtime; `x402` makes the protocol claim literally true. |
| Budget window | UTC calendar day | "Daily" meaning different things per deployment is a support nightmare. |
| `docs/6-week-plan.md` | Will not exist | Duplicates CLAUDE.md's scope section and the implementation plan. Remove the CLAUDE.md reference instead. |

### 2.1 Approved deviations from current README/CLAUDE.md

1. **`pay()` returns three statuses**, not two: `settled | blocked | failed`. An RPC timeout is not a policy denial. Collapsing them would leave agents unable to distinguish "out of budget, stop" from "network hiccup, retry". `failed` does **not** consume budget.
2. **`createGuard()` is async.** Restart-safe budgets require replaying the audit log at startup. The alternative — lazy init on first `pay()` — buries I/O and error handling somewhere surprising.
3. **`killSwitch: { frozen: boolean }`**, replacing the ambiguous `enabled`. The policy field is the *initial* value; `freeze()`/`unfreeze()` append control entries to the audit log, so replay reconstructs both spend counters and frozen state from one source, and every freeze is itself signed and timestamped.

All three require README updates in the same commit that introduces them. The quickstart must never lie.

## 3. Architecture

```
packages/core/                 zero runtime dependencies
  types.ts        Policy, Violation, PayRequest, PayResult, WalletAdapter, AuditSink
  money.ts        parseAmount("25.00") -> bigint minor units; formatAmount(bigint)
  policy.ts       validatePolicy() — throws at construction
  vendor.ts       normalizeVendor()
  checks/         killSwitch.ts, allowlist.ts, budget.ts
  state.ts        SpendState, replay(), UTC window math
  audit/          entry.ts (canonicalize, hash chain, sign/verify), fileSink.ts, memorySink.ts
  guard.ts        createGuard(), pay(), freeze(), unfreeze(), state()
packages/adapter-solana/       @x402/core, @x402/svm, @solana/kit, @solana-program/token
packages/adapter-base/         interface stub only
packages/adapter-cloudflare/   interface stub only
examples/demo/                 402-protected vendor server + agent loop
```

**Dependency rules.** `core` imports nothing chain-specific and nothing beyond `node:crypto` and (in the file sink only) `node:fs`. The guard knows the `AuditSink` interface and never assumes a filesystem. Adapters never import each other.

**Money.** `bigint` minor units at every internal seam. Decimal strings exist only at the public API boundary and are parsed once, in `money.ts`. `Number` never touches an amount.

### 3.1 Rail interfaces

```ts
interface WalletAdapter {
  readonly name: string;            // "solana"
  readonly currency: "USDC";
  execute(req: SettlementRequest): Promise<SettlementReceipt>;
}
interface SettlementRequest  { to: string; amountMinor: bigint; reason: string }
interface SettlementReceipt  { txSig: string; rail: string; raw?: unknown }

interface AuditSink {
  append(entry: AuditEntry): Promise<void>;
  read?(): AsyncIterable<AuditEntry>;   // optional; required for restart-safe budgets
}
```

A sink without `read()` yields an empty starting state. `createGuard()` accepts `requirePersistedState: true` to turn that silent degradation into a construction-time throw.

`auditId` on every `PayResult` is the `id` of the entry written for that attempt. `signingKey` is an ed25519 private key in PKCS#8 PEM, read from the environment.

### 3.2 Public API

```ts
const guard = await createGuard({ policy, adapters, audit, agent, signingKey });

const result = await guard.pay({ to, amount, currency, reason, via? });
// { status: "settled"; txSig: string;       auditId: string }
// { status: "blocked"; violation: Violation; auditId: string }
// { status: "failed";  error: PaymentError;  auditId: string }

interface PaymentError {
  code: "adapter_error" | "price_mismatch" | "insufficient_funds" | "timeout";
  message: string;
}

await guard.freeze();
await guard.unfreeze();
guard.state();   // { frozen, windows } — for demos and dashboards
```

`via` selects an adapter by name when more than one is registered; with a single adapter it is optional. Budgets aggregate across all adapters — that is the product thesis, not an implementation detail.

## 4. Policy engine

```ts
const CHECKS = [killSwitchCheck, allowlistCheck, budgetCheck];
type Check = (ctx: PaymentContext, policy: Policy, state: SpendState) => Violation | null;
```

The guard runs checks in order and returns on the first violation. **No adapter method is called on a blocked payment** — this is the security property the ordering exists to guarantee, and it is asserted by test.

`ctx` carries an injected `now: Date`, keeping checks pure and midnight-rollover tests deterministic.

```ts
interface Violation {
  code: "kill_switch" | "vendor_not_allowed" | "budget_exceeded" | "invalid_request";
  message: string;
  detail?: Record<string, string>;   // { period: "daily", limit: "25.00", spent: "24.80", attempted: "0.50" }
}
```

**Validation.** `validatePolicy()` throws at construction on unknown periods, unparseable limits, negative amounts, more than six decimal places, and `allowlist` mode with no entries. Fail fast on shape; fail soft on payments.

**Budget semantics.** `spent + amount <= limit` passes; the limit is an inclusive maximum. Only `settled` payments accrue. `blocked` and `failed` attempts are logged but never consume budget.

**Windows.** `per_tx` is stateless. `daily` is a UTC calendar day, keyed by `YYYY-MM-DD`.

## 5. Audit log

Append-only JSONL. Every line is hash-chained and signed.

```ts
interface AuditEntry {
  id: string;            // uuid
  seq: number;           // monotonic from 0
  ts: string;            // ISO 8601 UTC
  kind: "payment" | "control";
  agent: string;
  vendor: string;        // raw, as supplied — untrusted
  vendorNormalized: string;
  rail: string | null;
  amountMinor: string;   // bigint serialized as string
  currency: "USDC";
  reason: string;        // untrusted
  outcome: "settled" | "blocked" | "failed";
  violation: Violation | null;
  txSig: string | null;
  prevHash: string;      // the previous entry's `hash` value verbatim; "" at genesis
  hash: string;          // sha256 over canonical JSON of every field above
  sig: string;           // ed25519 over hash, operator key, node:crypto
}
```

**Why both a chain and a signature.** They stop different attacks and neither is sufficient alone: `prevHash` makes deletion and reordering detectable; the signature makes forging new entries impossible without the operator key. `verifyAuditLog()` is a public export so the demo — and any third-party auditor — can run it.

**Canonicalization.** Fields are serialized in a fixed key order with no insignificant whitespace, so the hash is reproducible across Node versions and platforms.

**Control entries.** `freeze()` and `unfreeze()` append `kind: "control"` entries carrying `amountMinor: "0"`, an empty `vendor`, a null `rail` and `txSig`, and `outcome: "settled"`. Replay therefore reconstructs frozen state and spend counters in a single pass.

**Frozen-state precedence.** `policy.killSwitch.frozen` supplies the value at genesis only. Any control entry in the log overrides it, and the most recent control entry wins. A policy that says `frozen: false` therefore cannot silently un-freeze an agent that an operator froze — the log is authoritative.

**Untrusted input.** `vendor` and `reason` are stored verbatim and never interpolated into shell, SQL, or markup. The demo truncates and escapes them on display.

**Signing key.** Read from the environment; never bundled, never committed. Devnet keys only.

## 6. adapter-solana

```ts
solanaAdapter({
  keypair,          // devnet only
  rpcUrl,
  mode: "x402" | "direct",
  usdcMint?,        // default devnet: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
  facilitatorUrl?,  // default: x402.org facilitator (no signup, testnet only)
})
```

Shared path: resolve the associated token account, build the SPL USDC transfer for `amountMinor`, sign. Then:

- **`direct`** — submit via RPC, confirm, return the signature.
- **`x402`** — GET the vendor URL, expect `402` plus payment requirements, base64-encode the signed transaction into the `X-PAYMENT` header, re-request, and read the signature off the receipt.

**Price-mismatch guard.** In x402 the server declares the price, but policy was evaluated against the amount the agent requested. A vendor returning a 402 that demands more than was approved must never be paid silently. The adapter compares the stated requirements against the approved `amountMinor` and hard-fails on any excess, surfacing as `status: "failed"` with a `price_mismatch` reason and a normal audit entry.

**Vendor normalization.** `to` is a URL in x402 mode and a base58 address in direct mode. `normalizeVendor()` reduces URLs to their hostname and passes addresses through unchanged, so allowlisting `api.weather.com` matches `https://api.weather.com/forecast`. The allowlist check runs on the normalized value; the audit log records both forms.

**Version risk.** `@x402/svm` published 2.22.0 on 2026-08-11 — the API is moving fast. Mitigation: pin exact versions, and confine every x402 import to this package so churn never reaches `core` or the demo.

**Stubs.** `adapter-base` and `adapter-cloudflare` export typed factories that throw `NotImplementedError` at construction. They compile and document the seam; they cannot be mistaken for working code.

## 7. Demo

`examples/demo`, five acts, about two minutes:

1. **Setup** — print the policy: daily `0.50`, per-tx `0.10`, allowlist `[api.weather.com]`.
2. **Normal operation** — the agent loop settles `0.05` devnet payments, remaining budget ticking down, explorer links printed. Nothing feels governed.
3. **Blocks** — a `0.25` payment trips the per-tx cap; a call to an unapproved vendor trips the allowlist; the eleventh `0.05` payment exhausts the daily budget. Each prints the structured violation and states explicitly that no chain call was made.

The demo runs at demo scale, not README scale: ten settled payments reach the daily limit inside the two-minute budget, where the README's illustrative 25.00/1.00 would need hundreds. Devnet USDC still has to be funded, so small amounts also keep the faucet loop short.
4. **Kill switch** — the operator freezes; the next payment dies instantly.
5. **Proof** — print the audit log and run `verifyAuditLog()` → OK. Tamper with one line, re-run → **FAILS at seq N**.

Act 5 is the closer: the difference between claiming tamper-evidence and showing it.

`npm run demo -- --mock` swaps in a fake adapter so CI runs the full loop with no network. The 402-protected vendor lives in `examples/demo/vendor.ts` (Express).

## 8. Testing

Vitest. Core tests require no network and no chain access.

**Core.** Money parsing edges: the six-decimal boundary, `>6dp` rejection, negatives, `"1e3"`, empty and whitespace strings. Each check in isolation. Check *ordering* — a frozen agent paying an unapproved vendor must report `kill_switch`, not `vendor_not_allowed`. Budget boundary at exactly the limit. Window rollover across UTC midnight via injected `now`. Audit verification against four attacks: edited amount, deleted line, reordered lines, forged append.

Two tests carry the product's security claims and must exist before anything is called done:

- **Restart does not reset the budget.** Write a log, construct a fresh guard, assert the counter survived.
- **Blocked payments never reach the adapter.** A spy asserting exactly zero `execute()` calls.

**adapter-solana.** Mocked facilitator and RPC in CI, including the price-mismatch abort. Real devnet runs live behind a `test:devnet` script gated on environment variables.

**CI.** Build, test, and `npm run demo -- --mock` on every PR. No network required.

## 9. Repo work this implies

**Scaffolding.** Root `package.json` with workspaces, strict `tsconfig` base, `.claude/settings.json` carrying the attribution suppression, `.env.example`, Vitest config, CI workflow.

**Corrections**, each landing in the commit that earns it:

- `CLAUDE.md` — remove the `docs/6-week-plan.md` reference.
- `README.md` — un-check the three roadmap items currently claiming done; update the quickstart to `await createGuard()`, `killSwitch: { frozen: false }`, and the three-state result.

**New dependencies** (approved during brainstorming): `core` takes none. `adapter-solana` takes `@x402/core`, `@x402/svm`, `@solana/kit`, `@solana-program/token`. The demo takes `express`. Anything beyond this list needs a fresh decision.

## 10. Definition of done

Core compiles under TS strict with policy tests passing offline. The demo completes the full loop on Solana devnet: repeated payments, daily budget exceeded, blocked with a structured violation, kill switch flipped, audit log showing every attempt with verifiable signatures and a demonstrated tamper failure. A stranger completes the README quickstart in under ten minutes.

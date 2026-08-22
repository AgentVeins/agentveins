# @agentveins/adapter-solana

Solana wallet adapter for [AgentVeins](https://github.com/AgentVeins/agentveins). Settles USDC on **devnet**, either as a direct transfer or over [x402](https://docs.x402.org).

The adapter moves the money. It does not decide whether the money should move: `@agentveins/core` does that, before this package is ever called.

```bash
npm install @agentveins/core @agentveins/adapter-solana
```

## Usage

```typescript
import { createGuard, type Policy } from "@agentveins/core";
import { fileAnchorStore, fileAuditSink } from "@agentveins/core/fs";
import { solanaAdapter } from "@agentveins/adapter-solana";

const guard = await createGuard({
  policy,
  agent: "research-agent",
  logId: "research-agent-main",
  adapters: [
    solanaAdapter({
      keypair,                 // webcrypto.CryptoKeyPair: devnet only
      rpcUrl: "https://api.devnet.solana.com",
      mode: "direct",          // or "x402"
    }),
  ],
  audit: fileAuditSink("./audit.jsonl"),
  anchor: fileAnchorStore("./audit.anchor.json"),
  signingKey,
});
```

## The two modes

### `direct`: settles today

Builds an SPL USDC transfer, signs it, submits it, and **waits for confirmation** by polling `getSignatureStatuses`, bounded by the transaction's `lastValidBlockHeight` and by a wall clock (90s) and attempt ceiling (300), both configurable.

Confirmation is not a detail. `sendTransaction` returns when a node *accepts* a transaction, which is not the same as it landing: blockhash expiry and congestion drops are ordinary on Solana. Returning success at acceptance would record a settlement for money that never moved and burn budget permanently, with no way to reverse it.

If confirmation times out while the transaction is still plausibly in flight, the guard records an `uncertain` audit entry carrying the signature and **consumes the budget**, while returning `failed` with `error.code: "timeout"` and `error.txSig`. Rounding against the agent means the count can never come in low.

> ⚠️ An agent that retries on a bare `status === "failed"` without reading `error.code` will spend budget twice for one uncertain payment. Check the code.

### `x402`: builds valid payloads, not yet settled live

Requests the resource, receives a `402` quote, and pays by attaching a signed transaction in an `X-PAYMENT` header. The transaction is built the way the `exact` SVM scheme requires: fee payer taken from the quote's `extra.feePayer` (the **facilitator** pays gas), instructions ordered `[SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked]`, and only *partially* signed so the facilitator can sign slot 0 and broadcast.

Two refusals happen **before anything is signed**:

- **Price**: the vendor declares the price *after* the guard already approved an amount. A quote asking for more is refused. A cheaper quote pays the cheaper price.
- **Recipient**: if `policy.recipients` is set, a quote naming a destination you did not approve is refused. Without it, a compromised or DNS-hijacked endpoint can redirect the payment and every record still reads as a normal governed payment.

**Status, precisely:** the transaction is accepted by the shipped `ExactSvmSchemeV1.verify()` from `@x402/svm`, run offline as a test. **Nothing has been settled against a live facilitator on devnet yet.**

## Scope

Devnet only. No mainnet configuration exists in this package, and no key controlling real value belongs anywhere near it.

Full documentation, including every guarantee and every limit: **[docs.agentveins.com](https://docs.agentveins.com)**

MIT

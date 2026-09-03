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

When a transaction has been broadcast and the adapter cannot establish what became of it, the guard records an `uncertain` audit entry carrying the signature and **consumes the budget**, while returning `failed` with `error.txSig` set. Rounding against the agent means the count can never come in low.

Two things produce that state, and the distinction is not one an agent needs to make: confirmation timing out while the transaction is still plausibly in flight (`error.code: "timeout"`), and the rpc call *itself* failing — a rate limit, a dropped socket — so that no ruling could be read at all (`error.code: "adapter_error"`). Failing to look at a broadcast transaction is not evidence it did not happen. A cluster that actually ruled is different: a rejection or an expired blockhash is a definite non-event, sets no signature, and consumes nothing.

> ⚠️ An agent that retries on a bare `status === "failed"` will spend budget twice for one uncertain payment. **Check `error.txSig`**: its presence means the money may already have moved, whatever the code says. Reconcile that signature before sending again.

### `x402`: settles through a facilitator

Requests the resource, receives a `402` quote, and pays by attaching a signed transaction in an `X-PAYMENT` header. The transaction is built the way the `exact` SVM scheme requires: fee payer taken from the quote's `extra.feePayer` (the **facilitator** pays gas), instructions ordered `[SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked]`, and only *partially* signed so the facilitator can sign slot 0 and broadcast.

Two refusals happen **before anything is signed**:

- **Price**: the vendor declares the price *after* the guard already approved an amount. A quote asking for more is refused. A cheaper quote pays the cheaper price.
- **Recipient**: if `policy.recipients` is set, a quote naming a destination you did not approve is refused. Without it, a compromised or DNS-hijacked endpoint can redirect the payment and every record still reads as a normal governed payment.

**Status, precisely:** this settles real USDC on devnet. The facilitator is x402's own reference implementation run in process, not a hosted third party, so settlement against someone else's facilitator remains untested. On a settled transaction the agent's SOL balance does not move — the facilitator pays the fee — which is the split the scheme depends on and the thing worth checking on an explorer.

## Scope

Devnet only. No mainnet configuration exists in this package, and no key controlling real value belongs anywhere near it.

Full documentation, including every guarantee and every limit: **[docs.agentveins.com](https://docs.agentveins.com)**

MIT

// The quote is validated with @x402/core's own zod schemas (PaymentRequiredSchema), the payment
// payload with PaymentPayloadV1Schema, and the header is encoded with safeBase64Encode — the same
// function x402's own header codec calls. @x402/svm's client is deliberately NOT used: its
// createPaymentPayload builds and signs its own transaction from a TransactionSigner and fetches
// its own blockhash and mint metadata, which would put an rpc call inside every code path here.
// buildX402Transfer reproduces the layout that scheme's verifier requires instead, and
// test/x402-transfer.test.ts proves it by running the shipped verifier over the result.
// Note the transaction x402 mode sends is NOT the one direct mode sends: here the facilitator is
// the fee payer and this wallet signs only as the transfer authority, so there is no locally
// computable transaction signature and the facilitator's settlement response is the only source
// of one.
import type { SettlementReceipt } from "@agentveins/core";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { PaymentPayloadV1Schema, PaymentRequiredSchema } from "@x402/core/schemas";
import type { PaymentRequirementsV1 } from "@x402/core/schemas";
import { safeBase64Encode } from "@x402/core/utils";
import type { ExactSvmPayloadV1 } from "@x402/svm";
import { isAddress } from "@solana/kit";
import type { X402Transfer, X402TransferRequest } from "./transfer.js";

const EXACT_SCHEME = "exact";
const DEFAULT_NETWORK = "solana-devnet";
const DEFAULT_TIMEOUT_MS = 30_000;
const MINOR_UNITS = /^[0-9]+$/;
const SETTLEMENT_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export class PriceMismatchError extends Error {
  readonly code = "price_mismatch";
  constructor(approvedMinor: bigint, quotedMinor: bigint) {
    super(`the vendor quoted ${quotedMinor} minor units but only ${approvedMinor} was approved`);
    this.name = "PriceMismatchError";
  }
}

export class RecipientNotAllowedError extends Error {
  readonly code = "recipient_not_allowed";
  /** Named by the endpoint, so untrusted: carried here rather than in the message. */
  readonly payTo: string;
  constructor(payTo: string) {
    super("the endpoint named a recipient that is not on the allowlist");
    this.name = "RecipientNotAllowedError";
    this.payTo = payTo;
  }
}

export interface FacilitatorInput {
  vendorUrl: string;
  approvedAmountMinor: bigint;
  /** The only mint this adapter will pay in; a quote naming any other asset is refused. */
  expectedAsset: string;
  /**
   * The addresses the policy approved as recipients. A quote naming anything else is refused
   * before signing. Omitted means the recipient is ungoverned — the amount is still checked,
   * but a hijacked endpoint can redirect the money.
   */
  allowedRecipients?: readonly string[];
  /** Called only after the quote clears every check, so a rejected quote never gets signed. */
  signTransfer: (request: X402TransferRequest) => Promise<X402Transfer>;
  network?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function settleViaFacilitator(input: FacilitatorInput): Promise<SettlementReceipt> {
  const doFetch = input.fetchImpl ?? fetch;
  const network = input.network ?? DEFAULT_NETWORK;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const quoteResponse = await doFetch(input.vendorUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (quoteResponse.status !== 402) {
    throw new Error(`the endpoint did not request payment (status ${quoteResponse.status})`);
  }

  const accepted = selectRequirement(await readQuote(quoteResponse), network);

  // The vendor states the price only after the guard has already approved an amount, so the
  // approval is re-checked here against what the vendor actually demands.
  const quotedMinor = readQuotedMinor(accepted.maxAmountRequired);
  if (quotedMinor > input.approvedAmountMinor) {
    throw new PriceMismatchError(input.approvedAmountMinor, quotedMinor);
  }
  if (quotedMinor <= 0n) {
    throw new Error("the endpoint quoted a price of zero");
  }
  if (accepted.asset !== input.expectedAsset) {
    throw new Error("the endpoint quoted an asset this adapter is not configured to pay");
  }
  // `isAddress` proves the address is well formed, never that it is the vendor's: policy governs
  // the vendor URL, and the money goes wherever the quote's `payTo` names. Without
  // `allowedRecipients` a compromised or hijacked endpoint can still redirect any amount at or
  // under the approval, and the allowlist, the budget and the audit log all record a normal
  // governed payment. Base58 is case-sensitive, so these compare exactly.
  if (!isAddress(accepted.payTo)) {
    throw new Error("the endpoint quoted an unusable solana payment address");
  }
  if (input.allowedRecipients !== undefined && !input.allowedRecipients.includes(accepted.payTo)) {
    throw new RecipientNotAllowedError(accepted.payTo);
  }

  const signed = await input.signTransfer({
    payTo: accepted.payTo,
    amountMinor: quotedMinor,
    feePayer: readFeePayer(accepted),
    ...readMemo(accepted),
  });

  const payload: ExactSvmPayloadV1 = { transaction: signed.wireTransaction };
  const header = safeBase64Encode(
    JSON.stringify(
      PaymentPayloadV1Schema.parse({ x402Version: 1, scheme: EXACT_SCHEME, network, payload }),
    ),
  );

  const paidResponse = await doFetch(input.vendorUrl, {
    headers: { "X-PAYMENT": header },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!paidResponse.ok) {
    throw new Error(`the vendor rejected the payment (status ${paidResponse.status})`);
  }

  return { txSig: settledSignature(paidResponse), rail: "solana" };
}

async function readQuote(response: Response): Promise<PaymentRequirementsV1[]> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("the endpoint returned a malformed x402 payment quote");
  }

  const parsed = PaymentRequiredSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("the endpoint returned a malformed x402 payment quote");
  }
  if (parsed.data.x402Version !== 1) {
    throw new Error("the endpoint speaks an x402 version this adapter cannot pay");
  }
  return parsed.data.accepts;
}

function selectRequirement(accepts: PaymentRequirementsV1[], network: string): PaymentRequirementsV1 {
  const accepted = accepts.find(
    (candidate) => candidate.scheme === EXACT_SCHEME && candidate.network === network,
  );
  if (accepted === undefined) {
    throw new Error(`the endpoint offers no "${EXACT_SCHEME}" payment on ${network}`);
  }
  return accepted;
}

function readQuotedMinor(maxAmountRequired: string): bigint {
  // BigInt() would happily read "0x10" as 16 and " 12 " as 12, so the digits are checked first.
  if (!MINOR_UNITS.test(maxAmountRequired)) {
    throw new Error("the endpoint's quoted price is not a whole number of minor units");
  }
  return BigInt(maxAmountRequired);
}

function readFeePayer(accepted: PaymentRequirementsV1): string {
  const feePayer = accepted.extra?.["feePayer"];
  if (typeof feePayer !== "string" || !isAddress(feePayer)) {
    throw new Error("the endpoint named no facilitator fee payer to build the transaction around");
  }
  return feePayer;
}

function readMemo(accepted: PaymentRequirementsV1): { memo?: string } {
  const memo = accepted.extra?.["memo"];
  if (memo === undefined || memo === null) {
    return {};
  }
  if (typeof memo !== "string") {
    throw new Error("the endpoint quoted a memo that is not a string");
  }
  return { memo };
}

function settledSignature(response: Response): string {
  const header =
    response.headers.get("x-payment-response") ?? response.headers.get("payment-response");
  if (header === null) {
    throw new Error("the vendor returned no x402 settlement response");
  }

  // decodePaymentResponseHeader is base64 plus JSON.parse with no schema behind it, so everything
  // read out of it is untrusted until checked here. An unverifiable signature must never reach the
  // audit log, which signs whatever it is handed.
  let decoded: unknown;
  try {
    decoded = decodePaymentResponseHeader(header);
  } catch {
    throw new Error("the vendor returned a malformed x402 settlement response");
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("the vendor returned a malformed x402 settlement response");
  }

  const settled = decoded as { success?: unknown; transaction?: unknown };
  if (settled.success !== true) {
    throw new Error("the facilitator did not settle the payment");
  }
  if (typeof settled.transaction !== "string" || !SETTLEMENT_SIGNATURE.test(settled.transaction)) {
    throw new Error("the vendor reported a settlement without a usable transaction signature");
  }
  return settled.transaction;
}

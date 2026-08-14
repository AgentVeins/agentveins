// Payload construction goes through @x402/core rather than hand-rolled JSON: the 402 quote is
// validated with PaymentRequiredSchema, the payment payload with PaymentPayloadV1Schema, and the
// header is encoded with safeBase64Encode — the same function x402's own header codec calls.
// @x402/svm's ExactSvmScheme is deliberately NOT used: its createPaymentPayload builds and signs
// its own transaction from a TransactionSigner, and this adapter must sign through Task 10's
// buildSignedTransfer so that direct mode and x402 mode send byte-identical transfers.
import type { SettlementReceipt } from "@agentveins/core";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { PaymentPayloadV1Schema, PaymentRequiredSchema } from "@x402/core/schemas";
import type { PaymentRequirementsV1 } from "@x402/core/schemas";
import { safeBase64Encode } from "@x402/core/utils";
import type { ExactSvmPayloadV1 } from "@x402/svm";
import { isAddress } from "@solana/kit";
import type { SignedTransfer } from "./transfer.js";

const EXACT_SCHEME = "exact";
const DEFAULT_NETWORK = "solana-devnet";
const MINOR_UNITS = /^[0-9]+$/;

export class PriceMismatchError extends Error {
  readonly code = "price_mismatch";
  constructor(approvedMinor: bigint, quotedMinor: bigint) {
    super(`the vendor quoted ${quotedMinor} minor units but only ${approvedMinor} was approved`);
    this.name = "PriceMismatchError";
  }
}

export interface FacilitatorInput {
  vendorUrl: string;
  approvedAmountMinor: bigint;
  /** Called only after the quote clears the price check, so a rejected quote never gets signed. */
  signTransfer: (payTo: string, amountMinor: bigint) => Promise<SignedTransfer>;
  /** The resource server settles with its own facilitator; the client never calls one directly. */
  facilitatorUrl?: string;
  network?: string;
  fetchImpl?: typeof fetch;
}

export async function settleViaFacilitator(input: FacilitatorInput): Promise<SettlementReceipt> {
  const doFetch = input.fetchImpl ?? fetch;
  const network = input.network ?? DEFAULT_NETWORK;

  const quoteResponse = await doFetch(input.vendorUrl);
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
  if (!isAddress(accepted.payTo)) {
    throw new Error("the endpoint quoted an unusable solana payment address");
  }

  const signed = await input.signTransfer(accepted.payTo, quotedMinor);
  const payload: ExactSvmPayloadV1 = { transaction: signed.wireTransaction };
  const header = safeBase64Encode(
    JSON.stringify(
      PaymentPayloadV1Schema.parse({ x402Version: 1, scheme: EXACT_SCHEME, network, payload }),
    ),
  );

  const paidResponse = await doFetch(input.vendorUrl, { headers: { "X-PAYMENT": header } });
  if (!paidResponse.ok) {
    throw new Error(`the vendor rejected the payment (status ${paidResponse.status})`);
  }

  return { txSig: settledSignature(paidResponse, signed.signature), rail: "solana" };
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

function settledSignature(response: Response, signedSignature: string): string {
  const header = response.headers.get("x-payment-response") ?? response.headers.get("payment-response");
  if (header === null) {
    return signedSignature;
  }

  let settled;
  try {
    settled = decodePaymentResponseHeader(header);
  } catch {
    return signedSignature;
  }
  if (settled.success === false) {
    throw new Error("the facilitator did not settle the payment");
  }
  return typeof settled.transaction === "string" && settled.transaction.length > 0
    ? settled.transaction
    : signedSignature;
}

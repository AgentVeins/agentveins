import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Address } from "@solana/kit";
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS as X402_COMPUTE_BUDGET_PROGRAM_ADDRESS,
  DEFAULT_COMPUTE_UNIT_LIMIT,
  DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES as X402_MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS as X402_MEMO_PROGRAM_ADDRESS,
} from "@x402/svm";
import { ExactSvmSchemeV1 } from "@x402/svm/exact/v1/facilitator";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildX402Transfer,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS,
} from "../src/transfer.js";
import type { BlockhashLifetime, TransferDeps } from "../src/transfer.js";

const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const NETWORK = "solana-devnet";
const AMOUNT_MINOR = 50_000n;

const lifetime: BlockhashLifetime = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 200n,
};

let deps: TransferDeps;
let feePayer: Address;

// The facilitator's own verifier is the oracle here. Everything it needs beyond pure decoding is
// stubbed, so the assertion is about the transaction's shape and never about the network.
function facilitator(feePayerAddress: Address): ExactSvmSchemeV1 {
  return new ExactSvmSchemeV1({
    getAddresses: () => [feePayerAddress],
    signTransaction: async (transaction: string) => transaction,
    simulateTransaction: async () => {},
    sendTransaction: async () => "unused",
    confirmTransaction: async () => {},
  });
}

function requirements(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: AMOUNT_MINOR.toString(),
    resource: "https://api.weather.com/forecast",
    description: "a weather forecast",
    mimeType: "application/json",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    asset: DEVNET_USDC_MINT,
    extra: { feePayer },
    ...overrides,
  };
}

function payload(wireTransaction: string): Record<string, unknown> {
  return {
    x402Version: 1,
    scheme: "exact",
    network: NETWORK,
    payload: { transaction: wireTransaction },
  };
}

function verify(wireTransaction: string, overrides: Record<string, unknown> = {}) {
  // The facilitator scheme is typed against @x402/core's v2 shapes but branches on v1 at runtime,
  // exactly as its own v1 client feeds it.
  const scheme = facilitator(feePayer) as unknown as {
    verify(p: unknown, r: unknown): Promise<{ isValid: boolean; invalidReason?: string }>;
  };
  return scheme.verify(payload(wireTransaction), requirements(overrides));
}

beforeAll(async () => {
  const signer = await generateKeyPairSigner();
  const facilitatorSigner = await generateKeyPairSigner();
  feePayer = facilitatorSigner.address;
  deps = {
    rpcUrl: "http://rpc.invalid",
    signer,
    usdcMint: DEVNET_USDC_MINT,
    decimals: 6,
    latestBlockhash: async () => lifetime,
  };
});

describe("buildX402Transfer", () => {
  it("builds a transaction the x402 facilitator's own verifier accepts", async () => {
    const transfer = await buildX402Transfer(deps, {
      payTo: PAY_TO,
      amountMinor: AMOUNT_MINOR,
      feePayer,
    });

    await expect(verify(transfer.wireTransaction)).resolves.toEqual({
      isValid: true,
      invalidReason: undefined,
      payer: deps.signer.address,
    });
  });

  it("carries the seller's memo through when the quote names one", async () => {
    const transfer = await buildX402Transfer(deps, {
      payTo: PAY_TO,
      amountMinor: AMOUNT_MINOR,
      feePayer,
      memo: "order-1234",
    });

    await expect(verify(transfer.wireTransaction, { extra: { feePayer, memo: "order-1234" } })).resolves.toMatchObject(
      { isValid: true },
    );
  });

  it("is rejected by the verifier when the compute-budget instructions are missing", async () => {
    const mint = address(DEVNET_USDC_MINT);
    const [source] = await findAssociatedTokenPda({
      owner: deps.signer.address,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destination] = await findAssociatedTokenPda({
      owner: address(PAY_TO),
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getTransferCheckedInstruction({
              source,
              mint,
              destination,
              authority: deps.signer,
              amount: AMOUNT_MINOR,
              decimals: 6,
            }),
          ],
          m,
        ),
    );
    const bare = getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));

    await expect(verify(bare)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_svm_payload_transaction_instructions_length",
    });
  });

  it("is rejected by the verifier when the quoted amount does not match the transfer", async () => {
    const transfer = await buildX402Transfer(deps, {
      payTo: PAY_TO,
      amountMinor: 10_000n,
      feePayer,
    });

    await expect(verify(transfer.wireTransaction)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_svm_payload_amount_mismatch",
    });
  });

  it("is rejected by the verifier when the transfer pays the wrong recipient", async () => {
    const transfer = await buildX402Transfer(deps, {
      payTo: "3Nb2Y5aMBpqZ1vPnJLnHYxTFkGiwGXVQxHwR9nrqYzQd",
      amountMinor: AMOUNT_MINOR,
      feePayer,
    });

    await expect(verify(transfer.wireTransaction)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_svm_payload_recipient_mismatch",
    });
  });

  it("refuses a non-positive amount and an oversized memo before signing anything", async () => {
    await expect(
      buildX402Transfer(deps, { payTo: PAY_TO, amountMinor: 0n, feePayer }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      buildX402Transfer(deps, {
        payTo: PAY_TO,
        amountMinor: AMOUNT_MINOR,
        feePayer,
        memo: "x".repeat(MAX_MEMO_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("keeps the copied scheme constants equal to x402's own", () => {
    expect(COMPUTE_BUDGET_PROGRAM_ADDRESS).toBe(X402_COMPUTE_BUDGET_PROGRAM_ADDRESS);
    expect(MEMO_PROGRAM_ADDRESS).toBe(X402_MEMO_PROGRAM_ADDRESS);
    expect(COMPUTE_UNIT_LIMIT).toBe(DEFAULT_COMPUTE_UNIT_LIMIT);
    expect(COMPUTE_UNIT_PRICE_MICROLAMPORTS).toBe(BigInt(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS));
    expect(MAX_MEMO_BYTES).toBe(X402_MAX_MEMO_BYTES);
  });
});

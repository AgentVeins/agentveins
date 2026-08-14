import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  address,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getStructEncoder,
  getTransactionEncoder,
  getU32Encoder,
  getU64Encoder,
  getU8Encoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import type { Address, Blockhash, Instruction, KeyPairSigner } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

// x402's exact-svm scheme fixes these values; test/x402-transfer.test.ts pins every one of them
// against @x402/svm's own exports. They are copied rather than imported because importing them
// would drag the whole 14 MB @x402/svm runtime into every consumer for four constants.
export const COMPUTE_BUDGET_PROGRAM_ADDRESS = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const COMPUTE_UNIT_LIMIT = 20_000;
export const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1n;
export const MAX_MEMO_BYTES = 256;
const SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR = 2;
const SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR = 3;

export interface BlockhashLifetime {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

export interface TransferDeps {
  rpcUrl: string;
  signer: KeyPairSigner;
  usdcMint: string;
  decimals: number;
  /** Seam so a build can be exercised without an rpc; defaults to `getLatestBlockhash`. */
  latestBlockhash?: () => Promise<BlockhashLifetime>;
}

export interface SignedTransfer {
  signedTransaction: Uint8Array;
  wireTransaction: string;
  signature: string;
  lastValidBlockHeight: bigint;
}

export interface X402TransferRequest {
  payTo: string;
  amountMinor: bigint;
  /** The facilitator's address, taken from the quote's `extra.feePayer`; it pays the network fee. */
  feePayer: string;
  memo?: string;
}

export interface X402Transfer {
  wireTransaction: string;
  lastValidBlockHeight: bigint;
}

/** Direct mode: this wallet pays the fee, signs in full, and submits the transaction itself. */
export async function buildSignedTransfer(
  deps: TransferDeps,
  to: string,
  amountMinor: bigint,
): Promise<SignedTransfer> {
  if (amountMinor <= 0n) {
    throw new RangeError("transfer amount must be greater than zero");
  }

  const instruction = await transferInstruction(deps, to, amountMinor);
  const lifetime = await readLifetime(deps);

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(deps.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstruction(instruction, m),
  );

  const signed = await signTransactionMessageWithSigners(message);

  return {
    // The full wire transaction, not `signed.messageBytes` — direct mode submits these bytes and
    // derives the signature from them.
    signedTransaction: new Uint8Array(getTransactionEncoder().encode(signed)),
    wireTransaction: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
  };
}

/**
 * x402 mode: the facilitator pays the fee and broadcasts, so this wallet signs only as the
 * transfer authority and the instruction layout must match what the scheme's verifier accepts —
 * `[SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked, Memo]`.
 */
export async function buildX402Transfer(
  deps: TransferDeps,
  request: X402TransferRequest,
): Promise<X402Transfer> {
  if (request.amountMinor <= 0n) {
    throw new RangeError("transfer amount must be greater than zero");
  }

  const memo = request.memo ?? randomBytes(16).toString("hex");
  if (Buffer.byteLength(memo, "utf8") > MAX_MEMO_BYTES) {
    throw new RangeError(`transfer memo must not exceed ${MAX_MEMO_BYTES} bytes`);
  }

  const transfer = await transferInstruction(deps, request.payTo, request.amountMinor);
  const lifetime = await readLifetime(deps);

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(request.feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) =>
      appendTransactionMessageInstructions(
        [computeUnitLimitInstruction(), computeUnitPriceInstruction(), transfer, memoInstruction(memo)],
        m,
      ),
  );

  // Partial signing is the whole point: slot 0 belongs to the facilitator's fee payer, and this
  // wallet holds no key for it. A fully signed transaction has no signature to derive locally.
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);

  return {
    wireTransaction: getBase64EncodedWireTransaction(partiallySigned),
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
  };
}

async function transferInstruction(deps: TransferDeps, to: string, amountMinor: bigint) {
  const mint = address(deps.usdcMint);

  const [source] = await findAssociatedTokenPda({
    owner: deps.signer.address,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [destination] = await findAssociatedTokenPda({
    owner: address(to),
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  return getTransferCheckedInstruction({
    source,
    mint,
    destination,
    authority: deps.signer,
    amount: amountMinor,
    decimals: deps.decimals,
  });
}

async function readLifetime(deps: TransferDeps): Promise<BlockhashLifetime> {
  if (deps.latestBlockhash !== undefined) {
    return deps.latestBlockhash();
  }
  const { value } = await createSolanaRpc(deps.rpcUrl).getLatestBlockhash().send();
  return value;
}

function computeUnitLimitInstruction(): Instruction<Address> {
  return {
    programAddress: address(COMPUTE_BUDGET_PROGRAM_ADDRESS),
    data: getStructEncoder([
      ["discriminator", getU8Encoder()],
      ["units", getU32Encoder()],
    ]).encode({ discriminator: SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR, units: COMPUTE_UNIT_LIMIT }),
  };
}

function computeUnitPriceInstruction(): Instruction<Address> {
  return {
    programAddress: address(COMPUTE_BUDGET_PROGRAM_ADDRESS),
    data: getStructEncoder([
      ["discriminator", getU8Encoder()],
      ["microLamports", getU64Encoder()],
    ]).encode({
      discriminator: SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR,
      microLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    }),
  };
}

function memoInstruction(memo: string): Instruction<Address> {
  return { programAddress: address(MEMO_PROGRAM_ADDRESS), data: new Uint8Array(Buffer.from(memo, "utf8")) };
}

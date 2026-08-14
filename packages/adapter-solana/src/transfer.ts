import {
  address,
  appendTransactionMessageInstruction,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import type { KeyPairSigner } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

export interface TransferDeps {
  rpcUrl: string;
  signer: KeyPairSigner;
  usdcMint: string;
  decimals: number;
}

export interface SignedTransfer {
  signedTransaction: Uint8Array;
  wireTransaction: string;
  signature: string;
  lastValidBlockHeight: bigint;
}

export async function buildSignedTransfer(
  deps: TransferDeps,
  to: string,
  amountMinor: bigint,
): Promise<SignedTransfer> {
  if (amountMinor <= 0n) {
    throw new RangeError("transfer amount must be greater than zero");
  }

  const rpc = createSolanaRpc(deps.rpcUrl);
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

  const instruction = getTransferCheckedInstruction({
    source,
    mint,
    destination,
    authority: deps.signer,
    amount: amountMinor,
    decimals: deps.decimals,
  });

  const { value: lifetime } = await rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(deps.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstruction(instruction, m),
  );

  const signed = await signTransactionMessageWithSigners(message);

  return {
    // The full wire transaction, not `signed.messageBytes` — the facilitator in x402 mode
    // needs the signatures attached, and direct mode sends the same bytes.
    signedTransaction: new Uint8Array(getTransactionEncoder().encode(signed)),
    wireTransaction: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
  };
}

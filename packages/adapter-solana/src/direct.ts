import { createSolanaRpc } from "@solana/kit";
import type { Base64EncodedWireTransaction } from "@solana/kit";

export async function sendTransaction(rpcUrl: string, wireTransaction: string): Promise<string> {
  const rpc = createSolanaRpc(rpcUrl);
  return rpc
    .sendTransaction(wireTransaction as Base64EncodedWireTransaction, {
      encoding: "base64",
      preflightCommitment: "confirmed",
    })
    .send();
}

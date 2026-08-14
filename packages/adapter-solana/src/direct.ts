import { setTimeout as delay } from "node:timers/promises";
import { createSolanaRpc } from "@solana/kit";
import type { Base64EncodedWireTransaction, Signature } from "@solana/kit";

export type ConfirmationLevel = "processed" | "confirmed" | "finalized";

export interface SignatureStatus {
  confirmationStatus: ConfirmationLevel | null;
  err: unknown;
}

export interface DirectRail {
  sendTransaction(wireTransaction: string): Promise<string>;
  getSignatureStatus(signature: string): Promise<SignatureStatus | null>;
  getBlockHeight(): Promise<bigint>;
}

export interface ConfirmDeps {
  getSignatureStatus(signature: string): Promise<SignatureStatus | null>;
  getBlockHeight(): Promise<bigint>;
  pollIntervalMs: number;
}

export function createDirectRail(rpcUrl: string): DirectRail {
  const rpc = createSolanaRpc(rpcUrl);

  return {
    async sendTransaction(wireTransaction: string): Promise<string> {
      return rpc
        .sendTransaction(wireTransaction as Base64EncodedWireTransaction, {
          encoding: "base64",
          preflightCommitment: "confirmed",
        })
        .send();
    },
    async getSignatureStatus(signature: string): Promise<SignatureStatus | null> {
      const { value } = await rpc.getSignatureStatuses([signature as Signature]).send();
      const status = value[0];
      if (status === undefined || status === null) {
        return null;
      }
      return { confirmationStatus: status.confirmationStatus, err: status.err };
    },
    async getBlockHeight(): Promise<bigint> {
      return rpc.getBlockHeight({ commitment: "confirmed" }).send();
    },
  };
}

export class TransactionNotConfirmedError extends Error {
  readonly signature: string;

  constructor(signature: string, detail: string, options?: ErrorOptions) {
    super(`transaction ${signature} did not confirm: ${detail}`, options);
    this.name = "TransactionNotConfirmedError";
    this.signature = signature;
  }
}

// rpc.sendTransaction resolves as soon as a node accepts the transaction, which is not a
// guarantee that it lands. The guard treats a resolved receipt as settled spend and has no
// reversal path, so direct mode confirms over HTTP before returning.
export async function confirmSignature(
  deps: ConfirmDeps,
  signature: string,
  lastValidBlockHeight: bigint,
): Promise<void> {
  for (;;) {
    const status = await deps.getSignatureStatus(signature);

    if (status !== null) {
      if (status.err !== null && status.err !== undefined) {
        throw new TransactionNotConfirmedError(signature, "the cluster rejected it", {
          cause: status.err,
        });
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return;
      }
    }

    const blockHeight = await deps.getBlockHeight();
    if (blockHeight > lastValidBlockHeight) {
      throw new TransactionNotConfirmedError(signature, "its blockhash expired before it landed");
    }

    await delay(deps.pollIntervalMs);
  }
}

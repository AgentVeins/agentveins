import type { SettlementReceipt, SettlementRequest, WalletAdapter } from "@agentveins/core";
import { createSignerFromKeyPair } from "@solana/kit";
import { sendTransaction as sendTransactionToRpc } from "./direct.js";
import { buildSignedTransfer } from "./transfer.js";
import type { SignedTransfer } from "./transfer.js";
import { settleViaFacilitator } from "./x402.js";

export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
const USDC_DECIMALS = 6;

export interface SolanaAdapterConfig {
  keypair: CryptoKeyPair;
  rpcUrl: string;
  mode: "x402" | "direct";
  usdcMint?: string;
  facilitatorUrl?: string;
  buildSignedTransfer?: (to: string, amountMinor: bigint) => Promise<SignedTransfer>;
  sendTransaction?: (wireTransaction: string) => Promise<string>;
}

export function solanaAdapter(config: SolanaAdapterConfig): WalletAdapter {
  if (config.mode !== "x402" && config.mode !== "direct") {
    throw new RangeError(`unknown solana adapter mode: ${String(config.mode)}`);
  }

  const usdcMint = config.usdcMint ?? DEVNET_USDC_MINT;
  const build =
    config.buildSignedTransfer ??
    (async (to: string, amountMinor: bigint) => {
      const signer = await createSignerFromKeyPair(config.keypair);
      return buildSignedTransfer(
        { rpcUrl: config.rpcUrl, signer, usdcMint, decimals: USDC_DECIMALS },
        to,
        amountMinor,
      );
    });
  const send =
    config.sendTransaction ??
    ((wireTransaction: string) => sendTransactionToRpc(config.rpcUrl, wireTransaction));

  return {
    name: "solana",
    currency: "USDC",
    async execute(req: SettlementRequest): Promise<SettlementReceipt> {
      if (req.amountMinor <= 0n) {
        throw new RangeError("settlement amount must be greater than zero");
      }
      const signed = await build(req.to, req.amountMinor);

      if (config.mode === "direct") {
        await send(signed.wireTransaction);
        return { txSig: signed.signature, rail: "solana" };
      }

      return settleViaFacilitator({
        vendorUrl: req.to,
        approvedAmountMinor: req.amountMinor,
        signed,
        facilitatorUrl: config.facilitatorUrl ?? DEFAULT_FACILITATOR_URL,
      });
    },
  };
}

export { buildSignedTransfer } from "./transfer.js";
export type { SignedTransfer, TransferDeps } from "./transfer.js";

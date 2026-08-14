import type { webcrypto } from "node:crypto";
import type { SettlementReceipt, SettlementRequest, WalletAdapter } from "@agentveins/core";
import { createSignerFromKeyPair } from "@solana/kit";
import { confirmSignature, createDirectRail } from "./direct.js";
import type { DirectRail, SignatureStatus } from "./direct.js";
import { buildSignedTransfer, buildX402Transfer } from "./transfer.js";
import type { SignedTransfer, TransferDeps, X402Transfer, X402TransferRequest } from "./transfer.js";
import { settleViaFacilitator } from "./x402.js";

export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDC_DECIMALS = 6;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface SolanaAdapterConfig {
  keypair: webcrypto.CryptoKeyPair;
  rpcUrl: string;
  mode: "x402" | "direct";
  usdcMint?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  buildSignedTransfer?: (to: string, amountMinor: bigint) => Promise<SignedTransfer>;
  buildX402Transfer?: (request: X402TransferRequest) => Promise<X402Transfer>;
  sendTransaction?: (wireTransaction: string) => Promise<string>;
  getSignatureStatus?: (signature: string) => Promise<SignatureStatus | null>;
  getBlockHeight?: () => Promise<bigint>;
}

export function solanaAdapter(config: SolanaAdapterConfig): WalletAdapter {
  if (config.mode !== "x402" && config.mode !== "direct") {
    throw new RangeError(`unknown solana adapter mode: ${String(config.mode)}`);
  }

  const usdcMint = config.usdcMint ?? DEVNET_USDC_MINT;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Build the rpc client on first use so an adapter whose seams are all injected never
  // constructs one, which keeps the tests entirely off the network.
  let rail: DirectRail | undefined;
  const useRail = (): DirectRail => (rail ??= createDirectRail(config.rpcUrl));

  const transferDeps = async (): Promise<TransferDeps> => ({
    rpcUrl: config.rpcUrl,
    signer: await createSignerFromKeyPair(config.keypair),
    usdcMint,
    decimals: USDC_DECIMALS,
  });

  const build =
    config.buildSignedTransfer ??
    (async (to: string, amountMinor: bigint) => buildSignedTransfer(await transferDeps(), to, amountMinor));
  const buildX402 =
    config.buildX402Transfer ??
    (async (request: X402TransferRequest) => buildX402Transfer(await transferDeps(), request));
  const send =
    config.sendTransaction ?? ((wireTransaction: string) => useRail().sendTransaction(wireTransaction));
  const getSignatureStatus =
    config.getSignatureStatus ?? ((signature: string) => useRail().getSignatureStatus(signature));
  const getBlockHeight = config.getBlockHeight ?? (() => useRail().getBlockHeight());

  return {
    name: "solana",
    currency: "USDC",
    async execute(req: SettlementRequest): Promise<SettlementReceipt> {
      if (req.amountMinor <= 0n) {
        throw new RangeError("settlement amount must be greater than zero");
      }

      if (config.mode === "x402") {
        // Nothing is signed until the 402 quote clears the price check, so `req.to` here is the
        // vendor's URL and the on-chain destination comes from the quote's `payTo`.
        return settleViaFacilitator({
          vendorUrl: req.to,
          approvedAmountMinor: req.amountMinor,
          expectedAsset: usdcMint,
          signTransfer: buildX402,
          ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
          ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
        });
      }

      const signed = await build(req.to, req.amountMinor);
      await send(signed.wireTransaction);
      await confirmSignature(
        { getSignatureStatus, getBlockHeight, pollIntervalMs },
        signed.signature,
        signed.lastValidBlockHeight,
      );
      return { txSig: signed.signature, rail: "solana" };
    },
  };
}

export { buildSignedTransfer, buildX402Transfer } from "./transfer.js";
export type {
  BlockhashLifetime,
  SignedTransfer,
  TransferDeps,
  X402Transfer,
  X402TransferRequest,
} from "./transfer.js";
export { TransactionNotConfirmedError } from "./direct.js";
export { PriceMismatchError, settleViaFacilitator } from "./x402.js";
export type { FacilitatorInput } from "./x402.js";
export type { ConfirmationLevel, SignatureStatus } from "./direct.js";

import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { SOLANA_DEVNET_CAIP2, toFacilitatorSvmSigner } from "@x402/svm";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";

/**
 * The facilitator half of an x402 payment, run in-process against Solana devnet.
 *
 * x402 splits the payment across three parties: the client signs a transfer it cannot
 * broadcast, the vendor quotes the price, and the facilitator pays the network fee and
 * submits the transaction. `@agentveins/adapter-solana` implements the client half and
 * talks only to the vendor, so a vendor with no facilitator behind it can quote a price
 * but can never settle. That gap is why the roadmap reads "verified", not "settled".
 *
 * This wires x402's own reference facilitator to a devnet keypair rather than
 * reimplementing settlement. The signature it returns comes from a real devnet
 * broadcast, so it can be checked against the chain independently of anything said here.
 */
export interface DevnetFacilitatorOptions {
  /** Ed25519 secret key bytes for the fee payer. Devnet only; it must hold SOL for fees. */
  secretKey: Uint8Array;
  /** Defaults to whatever RPC `@x402/svm` uses for devnet. */
  rpcUrl?: string;
}

export interface DevnetFacilitator {
  facilitator: x402Facilitator;
  /**
   * The address a quote must name in `extra.feePayer`: the client builds its transfer
   * around this account holding slot 0, and signs only its own slot.
   */
  feePayer: string;
}

export async function devnetFacilitator(
  options: DevnetFacilitatorOptions,
): Promise<DevnetFacilitator> {
  const signer = await createKeyPairSignerFromBytes(options.secretKey);
  const facilitator = new x402Facilitator();

  registerExactSvmScheme(facilitator, {
    signer: toFacilitatorSvmSigner(
      signer,
      options.rpcUrl === undefined ? undefined : { defaultRpcUrl: options.rpcUrl },
    ),
    networks: SOLANA_DEVNET_CAIP2,
  });

  return { facilitator, feePayer: signer.address };
}

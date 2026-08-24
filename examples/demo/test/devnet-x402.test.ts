import { readFile } from "node:fs/promises";
import process from "node:process";
import { solanaAdapter } from "@agentveins/adapter-solana";
import { createKeyPairFromBytes, createSolanaRpc, devnet, signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { loadEnvFile, resolveFromPackage } from "../src/env.js";
import { devnetFacilitator } from "../src/facilitator.js";
import { createVendorApp } from "../src/vendor.js";
import { fetchImplFor } from "./support/expressHarness.js";

// Before the gate below reads them: vitest does not load the demo's .env the way the demo
// runner does, so without this the test silently skips on a fully configured machine.
await loadEnvFile();

const agentKeypairPath = process.env["SOLANA_KEYPAIR_PATH"];
const facilitatorKeypairPath = process.env["FACILITATOR_KEYPAIR_PATH"];
const vendorAddress = process.env["VENDOR_ADDRESS"];
const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com";
// Opt-in by an explicit flag, not by the mere presence of a configured .env: this test spends
// real devnet USDC every run, and `npm test` — which prepublishOnly also runs — must never move
// money as a side effect of being configured.
const configured =
  process.env["DEVNET_SETTLE"] === "1" &&
  agentKeypairPath !== undefined &&
  facilitatorKeypairPath !== undefined &&
  vendorAddress !== undefined;

const PRICE_MINOR = 10_000n;
const VENDOR_URL = "https://vendor.devnet/forecast";
const FORECAST_PATH = "/forecast";

async function keypairBytes(path: string): Promise<Uint8Array> {
  return Uint8Array.from(JSON.parse(await readFile(resolveFromPackage(path), "utf8")) as number[]);
}

/**
 * The claim the README's roadmap stops short of: that x402 mode settles, not merely verifies.
 *
 * Everything here is real except the transport — the vendor runs in-process so the test needs no
 * public endpoint, while the facilitator signs as fee payer and broadcasts to devnet for real.
 * The agent and the facilitator must be different keys: the agent signs the transfer it cannot
 * pay for, and the facilitator pays and submits it.
 */
describe.skipIf(!configured)("x402 devnet settlement", () => {
  it("settles through the facilitator and the signature confirms on devnet", async () => {
    const agentKeypair = await createKeyPairFromBytes(await keypairBytes(agentKeypairPath ?? ""));
    const { facilitator, feePayer } = await devnetFacilitator({
      secretKey: await keypairBytes(facilitatorKeypairPath ?? ""),
      rpcUrl,
    });

    const vendor = createVendorApp({
      priceMinor: PRICE_MINOR,
      payTo: vendorAddress ?? "",
      feePayer,
      facilitator,
    });

    const adapter = solanaAdapter({
      keypair: agentKeypair,
      rpcUrl,
      mode: "x402",
      fetchImpl: fetchImplFor(vendor, FORECAST_PATH),
    });

    const receipt = await adapter.execute({
      to: VENDOR_URL,
      amountMinor: PRICE_MINOR,
      reason: "x402 devnet smoke test",
    });

    expect(receipt.txSig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);

    // The facilitator's own response is the only place that signature comes from, so read the
    // chain back independently. Without this the test would prove the facilitator answered,
    // not that anything settled.
    const rpc = createSolanaRpc(devnet(rpcUrl));
    const confirmed = await rpc
      .getTransaction(signature(receipt.txSig), {
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send();

    expect(confirmed).not.toBeNull();
    expect(confirmed?.meta?.err).toBeNull();
  }, 120_000);
});

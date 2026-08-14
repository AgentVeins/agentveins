import process from "node:process";
import { createKeyPairFromBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { solanaAdapter } from "../src/index.js";

const keypairJson = process.env["SOLANA_KEYPAIR"];
const rpcUrl = process.env["SOLANA_RPC_URL"];
const vendorAddress = process.env["VENDOR_ADDRESS"];
const configured = keypairJson !== undefined && rpcUrl !== undefined && vendorAddress !== undefined;

describe.skipIf(!configured)("devnet settlement", () => {
  it("settles a real USDC transfer in direct mode", async () => {
    const secretKey = Uint8Array.from(JSON.parse(keypairJson ?? "[]") as number[]);
    const adapter = solanaAdapter({
      keypair: await createKeyPairFromBytes(secretKey),
      rpcUrl: rpcUrl ?? "",
      mode: "direct",
    });

    const receipt = await adapter.execute({
      to: vendorAddress ?? "",
      amountMinor: 10_000n,
      reason: "devnet smoke test",
    });

    expect(receipt.txSig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);
  }, 60_000);
});

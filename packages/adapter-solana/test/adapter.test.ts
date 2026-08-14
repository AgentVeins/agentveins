import { describe, expect, it, vi } from "vitest";
import { solanaAdapter } from "../src/index.js";

const config = {
  keypair: {} as CryptoKeyPair,
  rpcUrl: "https://api.devnet.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

describe("solanaAdapter", () => {
  it("reports its name and currency", () => {
    const adapter = solanaAdapter({ ...config, mode: "direct" });
    expect(adapter.name).toBe("solana");
    expect(adapter.currency).toBe("USDC");
  });

  it("rejects an unknown mode at construction", () => {
    expect(() => solanaAdapter({ ...config, mode: "carrier-pigeon" as "direct" })).toThrow(RangeError);
  });

  it("rejects a non-positive amount before touching the network", async () => {
    const send = vi.fn();
    const adapter = solanaAdapter({ ...config, mode: "direct", sendTransaction: send });
    await expect(adapter.execute({ to: "addr", amountMinor: 0n, reason: "r" })).rejects.toThrow(RangeError);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("returns the confirmed signature in direct mode", async () => {
    const adapter = solanaAdapter({
      ...config,
      mode: "direct",
      buildSignedTransfer: vi.fn(async () => ({
        signedTransaction: new Uint8Array([1]),
        wireTransaction: "AQID",
        signature: "sig-abc",
      })),
      sendTransaction: vi.fn(async () => "sig-abc"),
    });
    const receipt = await adapter.execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" });
    expect(receipt).toEqual({ txSig: "sig-abc", rail: "solana" });
  });
});

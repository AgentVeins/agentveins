import type { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { solanaAdapter } from "../src/index.js";
import type { SignatureStatus } from "../src/index.js";

const config = {
  keypair: {} as webcrypto.CryptoKeyPair,
  rpcUrl: "https://api.devnet.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

const signedTransfer = {
  signedTransaction: new Uint8Array([1]),
  wireTransaction: "AQID",
  signature: "sig-abc",
  lastValidBlockHeight: 100n,
};

const confirmed: SignatureStatus = { confirmationStatus: "confirmed", err: null };

function buildSpy() {
  return vi.fn(async () => signedTransfer);
}

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
    const build = buildSpy();
    const send = vi.fn();
    const getSignatureStatus = vi.fn();
    const getBlockHeight = vi.fn();
    const adapter = solanaAdapter({
      ...config,
      mode: "direct",
      buildSignedTransfer: build,
      sendTransaction: send,
      getSignatureStatus,
      getBlockHeight,
    });
    await expect(adapter.execute({ to: "addr", amountMinor: 0n, reason: "r" })).rejects.toThrow(RangeError);
    expect(build).toHaveBeenCalledTimes(0);
    expect(send).toHaveBeenCalledTimes(0);
    expect(getSignatureStatus).toHaveBeenCalledTimes(0);
    expect(getBlockHeight).toHaveBeenCalledTimes(0);
  });

  it("submits the signed transaction and returns the confirmed signature in direct mode", async () => {
    const build = buildSpy();
    const send = vi.fn(async () => "sig-abc");
    const getSignatureStatus = vi.fn(async () => confirmed);
    const getBlockHeight = vi.fn(async () => 1n);
    const adapter = solanaAdapter({
      ...config,
      mode: "direct",
      buildSignedTransfer: build,
      sendTransaction: send,
      getSignatureStatus,
      getBlockHeight,
    });

    const receipt = await adapter.execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" });

    expect(build).toHaveBeenCalledExactlyOnceWith("addr", 50_000n);
    expect(send).toHaveBeenCalledExactlyOnceWith("AQID");
    expect(getSignatureStatus).toHaveBeenCalledExactlyOnceWith("sig-abc");
    expect(getBlockHeight).toHaveBeenCalledTimes(0);
    expect(receipt).toEqual({ txSig: "sig-abc", rail: "solana" });
  });

  it("keeps polling while the transaction is only processed", async () => {
    const statuses: (SignatureStatus | null)[] = [
      null,
      { confirmationStatus: "processed", err: null },
      confirmed,
    ];
    const getSignatureStatus = vi.fn(async () => {
      const next = statuses.shift();
      return next === undefined ? confirmed : next;
    });
    const getBlockHeight = vi.fn(async () => 1n);
    const adapter = solanaAdapter({
      ...config,
      mode: "direct",
      pollIntervalMs: 0,
      buildSignedTransfer: buildSpy(),
      sendTransaction: vi.fn(async () => "sig-abc"),
      getSignatureStatus,
      getBlockHeight,
    });

    const receipt = await adapter.execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" });

    expect(getSignatureStatus).toHaveBeenCalledTimes(3);
    expect(getBlockHeight).toHaveBeenCalledTimes(2);
    expect(receipt).toEqual({ txSig: "sig-abc", rail: "solana" });
  });

  it("throws when the cluster reports a transaction error", async () => {
    const adapter = solanaAdapter({
      ...config,
      mode: "direct",
      pollIntervalMs: 0,
      buildSignedTransfer: buildSpy(),
      sendTransaction: vi.fn(async () => "sig-abc"),
      getSignatureStatus: vi.fn(async () => ({
        confirmationStatus: "processed" as const,
        err: { InstructionError: [0, "Custom"] },
      })),
      getBlockHeight: vi.fn(async () => 1n),
    });

    await expect(adapter.execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" })).rejects.toThrow(
      /did not confirm/,
    );
  });

  it("throws once the blockhash expires without the transaction landing", async () => {
    const getSignatureStatus = vi.fn(async () => null);
    const adapter = solanaAdapter({
      ...config,
      mode: "direct",
      pollIntervalMs: 0,
      buildSignedTransfer: buildSpy(),
      sendTransaction: vi.fn(async () => "sig-abc"),
      getSignatureStatus,
      getBlockHeight: vi.fn(async () => 101n),
    });

    await expect(adapter.execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" })).rejects.toThrow(
      /blockhash expired/,
    );
    expect(getSignatureStatus).toHaveBeenCalledTimes(1);
  });

  it("does not return a receipt when confirmation fails", async () => {
    const adapter = solanaAdapter({
      ...config,
      mode: "direct",
      pollIntervalMs: 0,
      buildSignedTransfer: buildSpy(),
      sendTransaction: vi.fn(async () => "sig-abc"),
      getSignatureStatus: vi.fn(async () => null),
      getBlockHeight: vi.fn(async () => 101n),
    });

    const outcome = await adapter
      .execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" })
      .then(() => "resolved" as const)
      .catch(() => "rejected" as const);

    expect(outcome).toBe("rejected");
  });
});

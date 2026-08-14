import type { webcrypto } from "node:crypto";
import { safeBase64Encode } from "@x402/core/utils";
import { describe, expect, it, vi } from "vitest";
import { PriceMismatchError, solanaAdapter } from "../src/index.js";
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

const PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FEE_PAYER = "3Nb2Y5aMBpqZ1vPnJLnHYxTFkGiwGXVQxHwR9nrqYzQd";
const SETTLED_SIG =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

const x402Transfer = { wireTransaction: "AQID", lastValidBlockHeight: 100n };

function quoteResponse(maxAmountRequired: string): Response {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "solana-devnet",
          maxAmountRequired,
          resource: "https://api.weather.com/forecast",
          description: "a weather forecast",
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          asset: config.usdcMint,
          extra: { feePayer: FEE_PAYER },
        },
      ],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

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

  it("pays a vendor's 402 quote in x402 mode without submitting to the rpc itself", async () => {
    const buildX402 = vi.fn(async () => x402Transfer);
    const send = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(quoteResponse("40000"))
      .mockResolvedValueOnce(
        new Response("{}", {
          status: 200,
          headers: {
            "x-payment-response": safeBase64Encode(
              JSON.stringify({ success: true, transaction: SETTLED_SIG, network: "solana-devnet" }),
            ),
          },
        }),
      );
    const adapter = solanaAdapter({
      ...config,
      mode: "x402",
      buildX402Transfer: buildX402,
      sendTransaction: send,
      fetchImpl,
    });

    const receipt = await adapter.execute({
      to: "https://api.weather.com/forecast",
      amountMinor: 50_000n,
      reason: "forecast",
    });

    expect(receipt).toEqual({ txSig: SETTLED_SIG, rail: "solana" });
    expect(buildX402).toHaveBeenCalledExactlyOnceWith({
      payTo: PAY_TO,
      amountMinor: 40_000n,
      feePayer: FEE_PAYER,
    });
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("signs nothing in x402 mode when the vendor quotes more than the guard approved", async () => {
    const buildX402 = vi.fn(async () => x402Transfer);
    const fetchImpl = vi.fn().mockResolvedValueOnce(quoteResponse("500000"));
    const adapter = solanaAdapter({ ...config, mode: "x402", buildX402Transfer: buildX402, fetchImpl });

    await expect(
      adapter.execute({ to: "https://api.weather.com/forecast", amountMinor: 50_000n, reason: "forecast" }),
    ).rejects.toBeInstanceOf(PriceMismatchError);
    expect(buildX402).toHaveBeenCalledTimes(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

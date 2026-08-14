import { generateKeyPairSync, type webcrypto } from "node:crypto";
import { createGuard, memoryAuditSink } from "@agentveins/core";
import type { Policy } from "@agentveins/core";
import { safeBase64Encode } from "@x402/core/utils";
import { describe, expect, it, vi } from "vitest";
import {
  ConfirmationTimeoutError, PriceMismatchError, TransactionNotConfirmedError, confirmSignature,
  solanaAdapter,
} from "../src/index.js";
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
    // Once the cluster acknowledges the signature the transaction is in flight, so block height
    // stops being consulted: a lagging node's height is not evidence the transaction died.
    expect(getBlockHeight).toHaveBeenCalledTimes(1);
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

// C2: the confirmation loop was `for(;;)` with no ceiling, so an rpc node whose block height
// never advances kept a payment — and, through the guard's queue, everything behind it — running
// forever. Both ceilings are proved here, plus the hung-socket case between two polls.
describe("confirmSignature is bounded", () => {
  const processed: SignatureStatus = { confirmationStatus: "processed", err: null };

  function stuckAdapter(overrides: Partial<Parameters<typeof solanaAdapter>[0]> = {}) {
    return solanaAdapter({
      ...config,
      mode: "direct",
      pollIntervalMs: 0,
      confirmMaxAttempts: 5,
      confirmTimeoutMs: 5_000,
      buildSignedTransfer: buildSpy(),
      sendTransaction: vi.fn(async () => "sig-abc"),
      getSignatureStatus: vi.fn(async () => processed),
      getBlockHeight: vi.fn(async () => 1n),
      ...overrides,
    });
  }

  it("gives up after the attempt ceiling instead of spinning forever", async () => {
    const getSignatureStatus = vi.fn(async () => processed);
    const adapter = stuckAdapter({ getSignatureStatus });

    const error = await adapter
      .execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfirmationTimeoutError);
    expect(getSignatureStatus).toHaveBeenCalledTimes(5);
  });

  it("gives up on the wall clock even when the rpc answers instantly", async () => {
    let ticks = 0;
    const error = await confirmSignature(
      {
        getSignatureStatus: async () => processed,
        getBlockHeight: async () => 1n,
        pollIntervalMs: 0,
        timeoutMs: 1_000,
        maxAttempts: Number.MAX_SAFE_INTEGER,
        now: () => (ticks += 400),
      },
      "sig-abc",
      100n,
    )
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfirmationTimeoutError);
    expect((error as Error).message).toContain("1000ms");
  });

  it("gives up on an rpc call that never answers at all", async () => {
    const started = Date.now();
    const error = await confirmSignature(
      {
        getSignatureStatus: () => new Promise<SignatureStatus | null>(() => {}),
        getBlockHeight: async () => 1n,
        pollIntervalMs: 0,
        timeoutMs: 30,
      },
      "sig-abc",
      100n,
    )
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfirmationTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("hands the guard a signature to reconcile, and calls the failure a timeout", async () => {
    const error = (await stuckAdapter()
      .execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" })
      .catch((caught: unknown) => caught)) as ConfirmationTimeoutError;

    expect(error.code).toBe("timeout");
    expect(error.unconfirmedSignature).toBe("sig-abc");
    expect(error.signature).toBe("sig-abc");
  });

  // I2: a transaction the cluster had already acknowledged was declared expired — and reported
  // with no signature — because a lagging node's block height ran past the blockhash lifetime.
  it("does not call an acknowledged transaction expired when block height runs past", async () => {
    const statuses: (SignatureStatus | null)[] = [processed, processed, confirmed];
    const adapter = stuckAdapter({
      getSignatureStatus: vi.fn(async () => statuses.shift() ?? confirmed),
      getBlockHeight: vi.fn(async () => 101n),
    });

    await expect(adapter.execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" })).resolves.toEqual({
      txSig: "sig-abc",
      rail: "solana",
    });
  });

  it("still calls an unacknowledged transaction expired, with no signature to reconcile", async () => {
    const adapter = stuckAdapter({
      getSignatureStatus: vi.fn(async () => null),
      getBlockHeight: vi.fn(async () => 101n),
    });

    const error = (await adapter
      .execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" })
      .catch((caught: unknown) => caught)) as TransactionNotConfirmedError & { unconfirmedSignature?: string };

    expect(error).toBeInstanceOf(TransactionNotConfirmedError);
    expect(error).not.toBeInstanceOf(ConfirmationTimeoutError);
    expect(error.unconfirmedSignature).toBeUndefined();
  });
});

// C2 end to end: a lagging node must not be able to wedge the guard, and the kill switch must
// stay usable while a payment is stuck on it.
describe("a stuck rail cannot wedge the guard", () => {
  const policy: Policy = {
    budgets: [{ period: "daily", limit: "0.50", currency: "USDC" }],
    vendors: { mode: "allowlist", entries: ["addr"] },
    killSwitch: { frozen: false },
  };

  async function guardOnStuckRail(confirmTimeoutMs: number, hold?: Promise<void>) {
    const keys = generateKeyPairSync("ed25519");
    const audit = memoryAuditSink();
    let reached: () => void = () => {};
    const reachedRail = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const adapter = solanaAdapter({
      ...config,
      mode: "direct",
      pollIntervalMs: 1,
      confirmTimeoutMs,
      buildSignedTransfer: buildSpy(),
      sendTransaction: vi.fn(async () => "sig-abc"),
      // A node that has the transaction but never advances past `processed`.
      getSignatureStatus: vi.fn(async () => {
        reached();
        await hold;
        return { confirmationStatus: "processed" as const, err: null };
      }),
      getBlockHeight: vi.fn(async () => 1n),
    });
    const guard = await createGuard({
      policy, adapters: [adapter], audit,
      agent: "stuck-agent", logId: "stuck-agent-log", signingKey: keys.privateKey,
    });
    return { guard, audit, reachedRail };
  }

  it("terminates the payment and records it as uncertain with its signature", async () => {
    const { guard, audit } = await guardOnStuckRail(150);
    const result = await guard.pay({
      to: "addr", amount: "0.05", currency: "USDC", reason: "forecast",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("timeout");
      expect(result.error.txSig).toBe("sig-abc");
    }
    expect(audit.entries.at(-1)!.outcome).toBe("uncertain");
    expect(audit.entries.at(-1)!.txSig).toBe("sig-abc");
  });

  it("lets freeze return while that payment is still stuck", async () => {
    // The rail hangs mid-poll and is released only after the kill switch has closed, so a
    // freeze queued behind the payment would never return at all.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { guard, reachedRail } = await guardOnStuckRail(30_000, held);
    const pending = guard.pay({ to: "addr", amount: "0.05", currency: "USDC", reason: "forecast" });
    await reachedRail;

    await guard.freeze();
    expect(guard.state().frozen).toBe(true);

    release();
    expect((await pending).status).toBe("failed");
    expect(guard.state().frozen).toBe(true);
  });
});

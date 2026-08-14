import { decodePaymentSignatureHeader } from "@x402/core/http";
import { safeBase64Encode } from "@x402/core/utils";
import { describe, expect, it, vi } from "vitest";
import type { X402Transfer } from "../src/transfer.js";
import { PriceMismatchError, settleViaFacilitator } from "../src/x402.js";

const VENDOR_URL = "https://api.weather.com/forecast";
const PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FEE_PAYER = "3Nb2Y5aMBpqZ1vPnJLnHYxTFkGiwGXVQxHwR9nrqYzQd";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SETTLED_SIG =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

const transfer: X402Transfer = { wireTransaction: "AQID", lastValidBlockHeight: 100n };

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "solana-devnet",
    maxAmountRequired: "50000",
    resource: VENDOR_URL,
    description: "a weather forecast",
    mimeType: "application/json",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    asset: USDC,
    extra: { feePayer: FEE_PAYER },
    ...overrides,
  };
}

function quote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { x402Version: 1, accepts: [requirement(overrides)] };
}

function settlement(fields: Record<string, unknown>): string {
  return safeBase64Encode(JSON.stringify({ network: "solana-devnet", payer: PAY_TO, ...fields }));
}

function paid(header?: string): Response {
  return response(200, { data: "ok" }, header === undefined ? {} : { "x-payment-response": header });
}

function callSettle(
  fetchImpl: typeof fetch,
  signTransfer: () => Promise<X402Transfer>,
  approvedAmountMinor = 50_000n,
): Promise<{ txSig: string; rail: string }> {
  return settleViaFacilitator({
    vendorUrl: VENDOR_URL,
    approvedAmountMinor,
    expectedAsset: USDC,
    signTransfer,
    fetchImpl,
  });
}

function signTransferSpy() {
  return vi.fn(async () => transfer);
}

describe("settleViaFacilitator", () => {
  it("pays and returns the facilitator's signature when the quote matches the approved amount", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(paid(settlement({ success: true, transaction: SETTLED_SIG })));
    const signTransfer = signTransferSpy();

    const receipt = await callSettle(fetchImpl, signTransfer);

    expect(receipt).toEqual({ txSig: SETTLED_SIG, rail: "solana" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signTransfer).toHaveBeenCalledExactlyOnceWith({
      payTo: PAY_TO,
      amountMinor: 50_000n,
      feePayer: FEE_PAYER,
    });

    const init = fetchImpl.mock.calls[1]?.[1] as { headers: Record<string, string> };
    expect(decodePaymentSignatureHeader(init.headers["X-PAYMENT"] ?? "")).toEqual({
      x402Version: 1,
      scheme: "exact",
      network: "solana-devnet",
      payload: { transaction: "AQID" },
    });
  });

  it("passes the seller's memo through to the transfer builder", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote({ extra: { feePayer: FEE_PAYER, memo: "order-1234" } })))
      .mockResolvedValueOnce(paid(settlement({ success: true, transaction: SETTLED_SIG })));
    const signTransfer = signTransferSpy();

    await callSettle(fetchImpl, signTransfer);

    expect(signTransfer).toHaveBeenCalledExactlyOnceWith({
      payTo: PAY_TO,
      amountMinor: 50_000n,
      feePayer: FEE_PAYER,
      memo: "order-1234",
    });
  });

  it("times out both requests instead of hanging on a silent vendor", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(paid(settlement({ success: true, transaction: SETTLED_SIG })));

    await settleViaFacilitator({
      vendorUrl: VENDOR_URL,
      approvedAmountMinor: 50_000n,
      expectedAsset: USDC,
      signTransfer: signTransferSpy(),
      timeoutMs: 1_234,
      fetchImpl,
    });

    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as { signal?: AbortSignal };
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("refuses to pay more than the guard approved", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ maxAmountRequired: "500000" })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toBeInstanceOf(PriceMismatchError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("compares prices as bigint, so a quote one minor unit over 2^53 is still refused", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote({ maxAmountRequired: "9007199254740993" })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer, 9_007_199_254_740_992n)).rejects.toBeInstanceOf(
      PriceMismatchError,
    );
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("accepts a quote cheaper than the approved amount and signs for the quoted amount", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote({ maxAmountRequired: "10000" })))
      .mockResolvedValueOnce(paid(settlement({ success: true, transaction: SETTLED_SIG })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).resolves.toMatchObject({ txSig: SETTLED_SIG });
    expect(signTransfer).toHaveBeenCalledExactlyOnceWith({
      payTo: PAY_TO,
      amountMinor: 10_000n,
      feePayer: FEE_PAYER,
    });
  });

  it("refuses a quote of zero rather than signing an empty transfer", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ maxAmountRequired: "0" })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/price of zero/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses a quote in an asset this adapter is not configured to pay", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote({ asset: "So11111111111111111111111111111111111111112" })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/asset this adapter/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses a quote that names no facilitator fee payer", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ extra: null })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/fee payer/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses a quote whose fee payer is not a solana address", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote({ extra: { feePayer: "not-an-address" } })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/fee payer/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses a quote whose memo is not a string", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote({ extra: { feePayer: FEE_PAYER, memo: { evil: true } } })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/memo/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("throws when the endpoint never asks for payment", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, { data: "free" }));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/did not request payment/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("throws when the vendor rejects the payment", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(response(402, { error: "payment invalid" }));

    await expect(callSettle(fetchImpl, signTransferSpy())).rejects.toThrow(/rejected the payment/);
  });

  it("refuses a settlement response that omits success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(paid(settlement({ transaction: SETTLED_SIG })));

    await expect(callSettle(fetchImpl, signTransferSpy())).rejects.toThrow(/did not settle/);
  });

  it("refuses a settlement response that reports failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(paid(settlement({ success: false, transaction: SETTLED_SIG })));

    await expect(callSettle(fetchImpl, signTransferSpy())).rejects.toThrow(/did not settle/);
  });

  it.each([
    ["injected text", "<script>alert(1)</script> ../../etc/passwd"],
    ["an overlong string", "1".repeat(5000)],
    ["a truncated signature", "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9Cos"],
    ["a non-base58 signature", `${"1".repeat(63)}0`],
    ["an empty signature", ""],
  ])("refuses a settlement signature that is %s", async (_label, transaction) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(paid(settlement({ success: true, transaction })));

    await expect(callSettle(fetchImpl, signTransferSpy())).rejects.toThrow(/usable transaction signature/);
  });

  it("refuses a settlement response that is not a decodable header", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(paid("sig-abc"));

    await expect(callSettle(fetchImpl, signTransferSpy())).rejects.toThrow(/malformed x402 settlement/);
  });

  it("refuses a 200 that reports no settlement at all", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(paid());

    await expect(callSettle(fetchImpl, signTransferSpy())).rejects.toThrow(/no x402 settlement response/);
  });

  it("refuses a quote that is not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("not json", { status: 402 }));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/malformed/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses a quote missing required x402 fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      response(402, {
        x402Version: 1,
        accepts: [{ scheme: "exact", network: "solana-devnet", maxAmountRequired: "50000", payTo: PAY_TO }],
      }),
    );
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/malformed/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses a well-formed x402 v2 quote instead of guessing at its shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      response(402, {
        x402Version: 2,
        resource: { url: VENDOR_URL, description: "a weather forecast" },
        accepts: [
          {
            scheme: "exact",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            amount: "50000",
            asset: USDC,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
          },
        ],
      }),
    );
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/cannot pay/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses an x402 version it cannot speak", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, { ...quote(), x402Version: 3 }));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/malformed/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses a quote with an empty price", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ maxAmountRequired: "" })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/malformed/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it.each(["0x10", "1e3", " 50000", "-1", "50_000"])(
    "refuses a quoted amount that is not a plain integer: %j",
    async (maxAmountRequired) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ maxAmountRequired })));
      const signTransfer = signTransferSpy();

      await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/quoted price/);
      expect(signTransfer).toHaveBeenCalledTimes(0);
    },
  );

  it("refuses a quote that offers no exact scheme on the network", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ network: "base-sepolia" })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/no "exact" payment/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses to sign a transfer to something that is not a solana address", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ payTo: "not-an-address" })));
    const signTransfer = signTransferSpy();

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/payment address/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("never repeats the vendor's own text back in an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      response(402, quote({ description: "<script>alert(1)</script>", maxAmountRequired: "500000" })),
    );

    const error = await callSettle(fetchImpl, signTransferSpy()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PriceMismatchError);
    expect((error as Error).message).not.toMatch(/script/);
  });
});

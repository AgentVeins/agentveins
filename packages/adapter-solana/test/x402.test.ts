import { decodePaymentSignatureHeader } from "@x402/core/http";
import { safeBase64Encode } from "@x402/core/utils";
import { describe, expect, it, vi } from "vitest";
import type { SignedTransfer } from "../src/transfer.js";
import { PriceMismatchError, settleViaFacilitator } from "../src/x402.js";

const VENDOR_URL = "https://api.weather.com/forecast";
const PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const signed: SignedTransfer = {
  signedTransaction: new Uint8Array([1]),
  wireTransaction: "AQID",
  signature: "sig-abc",
  lastValidBlockHeight: 100n,
};

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
    ...overrides,
  };
}

function quote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { x402Version: 1, accepts: [requirement(overrides)] };
}

function settlement(transaction: string, success = true): string {
  return safeBase64Encode(
    JSON.stringify({ success, transaction, network: "solana-devnet", payer: PAY_TO }),
  );
}

function callSettle(
  fetchImpl: typeof fetch,
  signTransfer: (payTo: string, amountMinor: bigint) => Promise<SignedTransfer>,
): Promise<{ txSig: string; rail: string }> {
  return settleViaFacilitator({
    vendorUrl: VENDOR_URL,
    approvedAmountMinor: 50_000n,
    signTransfer,
    facilitatorUrl: "https://x402.org/facilitator",
    fetchImpl,
  });
}

describe("settleViaFacilitator", () => {
  it("pays and returns the signature when the quote matches the approved amount", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(response(200, { data: "ok" }));
    const signTransfer = vi.fn().mockResolvedValue(signed);

    const receipt = await callSettle(fetchImpl, signTransfer);

    expect(receipt).toEqual({ txSig: "sig-abc", rail: "solana" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signTransfer).toHaveBeenCalledExactlyOnceWith(PAY_TO, 50_000n);

    const init = fetchImpl.mock.calls[1]?.[1] as { headers: Record<string, string> };
    expect(decodePaymentSignatureHeader(init.headers["X-PAYMENT"] ?? "")).toEqual({
      x402Version: 1,
      scheme: "exact",
      network: "solana-devnet",
      payload: { transaction: "AQID" },
    });
  });

  it("refuses to pay more than the guard approved", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ maxAmountRequired: "500000" })));
    const signTransfer = vi.fn().mockResolvedValue(signed);

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toBeInstanceOf(PriceMismatchError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("accepts a quote cheaper than the approved amount and signs for the quoted amount", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote({ maxAmountRequired: "10000" })))
      .mockResolvedValueOnce(response(200, { data: "ok" }));
    const signTransfer = vi.fn().mockResolvedValue(signed);

    await expect(callSettle(fetchImpl, signTransfer)).resolves.toMatchObject({ txSig: "sig-abc" });
    expect(signTransfer).toHaveBeenCalledExactlyOnceWith(PAY_TO, 10_000n);
  });

  it("throws when the endpoint never asks for payment", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, { data: "free" }));
    const signTransfer = vi.fn().mockResolvedValue(signed);

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/did not request payment/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("throws when the vendor rejects the payment", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(response(402, { error: "payment invalid" }));

    await expect(callSettle(fetchImpl, vi.fn().mockResolvedValue(signed))).rejects.toThrow(
      /rejected the payment/,
    );
  });

  it("returns the signature the facilitator settled, not the locally signed one", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(
        response(200, { data: "ok" }, { "x-payment-response": settlement("settled-sig") }),
      );

    await expect(callSettle(fetchImpl, vi.fn().mockResolvedValue(signed))).resolves.toEqual({
      txSig: "settled-sig",
      rail: "solana",
    });
  });

  it("throws when the settlement response reports a failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, quote()))
      .mockResolvedValueOnce(
        response(200, { data: "ok" }, { "x-payment-response": settlement("", false) }),
      );

    await expect(callSettle(fetchImpl, vi.fn().mockResolvedValue(signed))).rejects.toThrow(
      /did not settle the payment/,
    );
  });

  it("refuses a quote that is not valid JSON", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("not json", { status: 402 }));
    const signTransfer = vi.fn().mockResolvedValue(signed);

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
    const signTransfer = vi.fn().mockResolvedValue(signed);

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
    const signTransfer = vi.fn().mockResolvedValue(signed);

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/cannot pay/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses an x402 version it cannot speak", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, { ...quote(), x402Version: 3 }));
    const signTransfer = vi.fn().mockResolvedValue(signed);

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/malformed/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses a quote with an empty price", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ maxAmountRequired: "" })));
    const signTransfer = vi.fn().mockResolvedValue(signed);

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/malformed/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it.each(["0x10", "1e3", " 50000", "-1", "50_000"])(
    "refuses a quoted amount that is not a plain integer: %j",
    async (maxAmountRequired) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ maxAmountRequired })));
      const signTransfer = vi.fn().mockResolvedValue(signed);

      await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/quoted price/);
      expect(signTransfer).toHaveBeenCalledTimes(0);
    },
  );

  it("refuses a quote that offers no exact scheme on the network", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ network: "base-sepolia" })));
    const signTransfer = vi.fn().mockResolvedValue(signed);

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/no "exact" payment/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("refuses to sign a transfer to something that is not a solana address", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, quote({ payTo: "not-an-address" })));
    const signTransfer = vi.fn().mockResolvedValue(signed);

    await expect(callSettle(fetchImpl, signTransfer)).rejects.toThrow(/payment address/);
    expect(signTransfer).toHaveBeenCalledTimes(0);
  });

  it("never repeats the vendor's own text back in an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      response(402, quote({ description: "<script>alert(1)</script>", maxAmountRequired: "500000" })),
    );

    const error = await callSettle(fetchImpl, vi.fn().mockResolvedValue(signed)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PriceMismatchError);
    expect((error as Error).message).not.toMatch(/script/);
  });
});

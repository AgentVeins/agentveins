import { PriceMismatchError, settleViaFacilitator } from "@agentveins/adapter-solana";
import { describe, expect, it, vi } from "vitest";
import { createVendorApp, type VendorFacilitator } from "../src/vendor.js";
import { driveRequest, fetchImplFor } from "./support/expressHarness.js";

const PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/** A well-formed address standing in for the facilitator's fee payer. */
const FEE_PAYER = "3Nb2Y5aMBpqZ1vPnJLnHYxTFkGiwGXVQxHwR9nrqYzQd";
const VENDOR_URL = "https://vendor.demo/forecast";
const FORECAST_PATH = "/forecast";

describe("vendor server", () => {
  it("answers 402 with a spec-conforming payment quote when unpaid", async () => {
    const app = createVendorApp({ priceMinor: 50_000n, payTo: PAY_TO });
    const { status, body } = await driveRequest(app, FORECAST_PATH);

    expect(status).toBe(402);
    expect(body).toMatchObject({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "solana-devnet",
          maxAmountRequired: "50000",
          payTo: PAY_TO,
          extra: { feePayer: expect.any(String) as unknown as string },
        },
      ],
    });
  });

  it("serves the resource when an X-PAYMENT header is present", async () => {
    const app = createVendorApp({ priceMinor: 50_000n, payTo: PAY_TO });
    const payment = Buffer.from(JSON.stringify({ payload: { transaction: "AQID" } })).toString("base64");
    const { status, body, headers } = await driveRequest(app, FORECAST_PATH, { "X-PAYMENT": payment });

    expect(status).toBe(200);
    expect(body).toHaveProperty("forecast");
    expect(headers.get("x-payment-response")).toBeTruthy();
  });

  it("rejects a malformed payment header", async () => {
    const app = createVendorApp({ priceMinor: 50_000n, payTo: PAY_TO });
    const { status } = await driveRequest(app, FORECAST_PATH, { "X-PAYMENT": "not-base64-json" });

    expect(status).toBe(402);
  });

  it("parses as a real x402 quote and trips the price-mismatch guard before anything is signed", async () => {
    const app = createVendorApp({ priceMinor: 50_000n, payTo: PAY_TO });
    const signTransfer = vi.fn();

    await expect(
      settleViaFacilitator({
        vendorUrl: VENDOR_URL,
        approvedAmountMinor: 40_000n,
        expectedAsset: USDC,
        signTransfer,
        fetchImpl: fetchImplFor(app, FORECAST_PATH),
      }),
    ).rejects.toBeInstanceOf(PriceMismatchError);

    expect(signTransfer).not.toHaveBeenCalled();
  });

  it("clears the price, asset, and address checks and reaches signing when the quote is within budget", async () => {
    const app = createVendorApp({ priceMinor: 50_000n, payTo: PAY_TO });
    const signTransfer = vi.fn().mockResolvedValue({ wireTransaction: "AQID", lastValidBlockHeight: 100n });

    const settlement = settleViaFacilitator({
      vendorUrl: VENDOR_URL,
      approvedAmountMinor: 50_000n,
      expectedAsset: USDC,
      signTransfer,
      fetchImpl: fetchImplFor(app, FORECAST_PATH),
    });

    // The vendor's X-PAYMENT branch is a stub that never returns a spec-conforming settlement
    // receipt, so the call still rejects overall — just not for a price reason, which is the
    // point: it proves the quote made it past every pre-signing check.
    await expect(settlement).rejects.not.toBeInstanceOf(PriceMismatchError);
    expect(signTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ payTo: PAY_TO, amountMinor: 50_000n }),
    );
  });
});

describe("vendor server with a facilitator", () => {
  const SETTLED_SIG = "5".repeat(88);

  it("settles the payment and hands back the facilitator's signature", async () => {
    const settle = vi.fn(async () => ({
      success: true,
      transaction: SETTLED_SIG,
      network: "solana-devnet",
    }));
    const app = createVendorApp({
      priceMinor: 50_000n,
      payTo: PAY_TO,
      feePayer: FEE_PAYER,
      facilitator: { settle } as unknown as VendorFacilitator,
    });

    const receipt = await settleViaFacilitator({
      vendorUrl: VENDOR_URL,
      approvedAmountMinor: 50_000n,
      expectedAsset: USDC,
      signTransfer: async () => ({ wireTransaction: "AQID", lastValidBlockHeight: 100n }),
      fetchImpl: fetchImplFor(app, FORECAST_PATH),
    });

    expect(receipt.txSig).toBe(SETTLED_SIG);
    // The facilitator must settle against the same terms the client was quoted, not a
    // re-derived copy that could drift from them.
    const [, requirements] = settle.mock.calls[0] as unknown as [unknown, { payTo: string; maxAmountRequired: string }];
    expect(requirements.payTo).toBe(PAY_TO);
    expect(requirements.maxAmountRequired).toBe("50000");
  });

  it("answers 402 rather than serving the resource when settlement fails", async () => {
    const app = createVendorApp({
      priceMinor: 50_000n,
      payTo: PAY_TO,
      feePayer: FEE_PAYER,
      facilitator: {
        settle: async () => ({
          success: false,
          errorMessage: "insufficient funds",
          transaction: "",
          network: "solana-devnet",
        }),
      } as unknown as VendorFacilitator,
    });

    await expect(
      settleViaFacilitator({
        vendorUrl: VENDOR_URL,
        approvedAmountMinor: 50_000n,
        expectedAsset: USDC,
        signTransfer: async () => ({ wireTransaction: "AQID", lastValidBlockHeight: 100n }),
        fetchImpl: fetchImplFor(app, FORECAST_PATH),
      }),
    ).rejects.toThrow(/rejected the payment/);
  });
});

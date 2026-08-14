import express from "express";

const DEFAULT_NETWORK = "solana-devnet";
// System Program address (32 zero bytes) — a well-formed placeholder. The demo's price-mismatch
// guard rejects the quote before a fee payer is ever read, so this value is never used to build
// a transaction.
const DEFAULT_FEE_PAYER = "11111111111111111111111111111111";
// SPL Token program address — a distinct well-formed placeholder from DEFAULT_FEE_PAYER; a real
// vendor's payTo is unrelated to its facilitator's fee payer.
const DEFAULT_PAY_TO = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RESOURCE_PATH = "/forecast";
const RESOURCE_DESCRIPTION = "a weather forecast";
const RESOURCE_MIME_TYPE = "application/json";
const MAX_TIMEOUT_SECONDS = 60;

export interface VendorOptions {
  priceMinor: bigint;
  payTo: string;
  network?: string;
  /** The facilitator fee payer a spec-conforming quote must carry in `extra.feePayer`. */
  feePayer?: string;
}

export function createVendorApp(options: VendorOptions): express.Express {
  const app = express();
  const network = options.network ?? DEFAULT_NETWORK;
  const feePayer = options.feePayer ?? DEFAULT_FEE_PAYER;

  app.get("/forecast", (req, res) => {
    const header = req.get("X-PAYMENT");

    if (header === undefined) {
      res.status(402).json({
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network,
            maxAmountRequired: options.priceMinor.toString(),
            resource: RESOURCE_PATH,
            description: RESOURCE_DESCRIPTION,
            mimeType: RESOURCE_MIME_TYPE,
            payTo: options.payTo,
            maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
            asset: DEVNET_USDC_MINT,
            extra: { feePayer },
          },
        ],
      });
      return;
    }

    let transaction: string | undefined;
    try {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        payload?: { transaction?: string };
      };
      transaction = decoded.payload?.transaction;
    } catch {
      transaction = undefined;
    }

    if (transaction === undefined) {
      res.status(402).json({ error: "the X-PAYMENT header is not a valid x402 payload" });
      return;
    }

    // Stub only: the demo settles in direct mode and never sends X-PAYMENT to this vendor. Real
    // settlement would need this vendor's own funded keypair and a facilitator implementation —
    // see docs/superpowers/plans/2026-08-13-agentveins-mvp.md for the price-mismatch guard this
    // server exists to demonstrate instead.
    res.setHeader("x-payment-response", `demo-${transaction.slice(0, 12)}`);
    res.status(200).json({ forecast: "22C, light rain", issuedAt: new Date().toISOString() });
  });

  return app;
}

if (process.argv[1]?.endsWith("vendor.ts")) {
  const port = Number(process.env["VENDOR_PORT"] ?? 3001);
  createVendorApp({ priceMinor: 50_000n, payTo: process.env["VENDOR_ADDRESS"] ?? DEFAULT_PAY_TO }).listen(
    port,
    () => process.stdout.write(`vendor listening on http://localhost:${port}\n`),
  );
}

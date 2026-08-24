import express from "express";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { PaymentPayloadV1Schema } from "@x402/core/schemas";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";

/**
 * The quote this vendor serves, spelled out rather than borrowed from `PaymentRequirementsV1`:
 * that type declares `network` as CAIP-2 (`${string}:${string}`), which no v1 network id
 * satisfies — x402's own v1 facilitator registers the colon-free `solana-devnet`.
 */
interface VendorQuote {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { feePayer: string };
}

const DEFAULT_NETWORK = "solana-devnet";
// System Program address (32 zero bytes) — a well-formed placeholder used only when no
// facilitator is wired up. With one, `feePayer` is that facilitator's real address, because
// the client builds its transfer around whatever account this names.
const DEFAULT_FEE_PAYER = "11111111111111111111111111111111";
// SPL Token program address — a distinct well-formed placeholder from DEFAULT_FEE_PAYER; a real
// vendor's payTo is unrelated to its facilitator's fee payer.
const DEFAULT_PAY_TO = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RESOURCE_PATH = "/forecast";
const RESOURCE_DESCRIPTION = "a weather forecast";
const RESOURCE_MIME_TYPE = "application/json";
const MAX_TIMEOUT_SECONDS = 60;

/**
 * The settlement half of x402, narrowed to the one call this vendor makes. `x402Facilitator`
 * from `@x402/core/facilitator` satisfies it; see `facilitator.ts` for the devnet wiring.
 */
export interface VendorFacilitator {
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export interface VendorOptions {
  priceMinor: bigint;
  payTo: string;
  network?: string;
  /** The facilitator fee payer a spec-conforming quote must carry in `extra.feePayer`. */
  feePayer?: string;
  /**
   * Settles payments for real when supplied. Without it the vendor quotes prices but cannot
   * settle, which is enough for the price-mismatch act and keeps the demo off the network.
   */
  facilitator?: VendorFacilitator;
}

export function createVendorApp(options: VendorOptions): express.Express {
  const app = express();
  const network = options.network ?? DEFAULT_NETWORK;
  const feePayer = options.feePayer ?? DEFAULT_FEE_PAYER;
  const facilitator = options.facilitator;

  // One object serves both roles: the quote the client is offered, and the requirements the
  // facilitator settles against. They must not drift, or the facilitator would validate a
  // payment for terms the client was never shown.
  const requirements: VendorQuote = {
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
  };

  app.get("/forecast", (req, res) => {
    const header = req.get("X-PAYMENT");

    if (header === undefined) {
      res.status(402).json({ x402Version: 1, accepts: [requirements] });
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

    if (facilitator === undefined) {
      // No facilitator: the demo settles in direct mode and never sends X-PAYMENT here, so this
      // branch exists to demonstrate the price-mismatch guard — it quotes above the approved
      // amount and the adapter refuses to sign. The header below is a placeholder, not a
      // settlement; nothing decodes it.
      res.setHeader("x-payment-response", `demo-${transaction.slice(0, 12)}`);
      res.status(200).json({ forecast: "22C, light rain", issuedAt: new Date().toISOString() });
      return;
    }

    settlePayment(facilitator, header, requirements)
      .then((settled) => {
        res.setHeader("x-payment-response", encodePaymentResponseHeader(settled));
        res.status(200).json({ forecast: "22C, light rain", issuedAt: new Date().toISOString() });
      })
      .catch((error: unknown) => {
        // Express 4 does not route a rejected promise to its error handler, so the settlement
        // path answers for itself rather than leaving the client waiting on a dead socket.
        res.status(402).json({ error: error instanceof Error ? error.message : "settlement failed" });
      });
  });

  return app;
}

async function settlePayment(
  facilitator: VendorFacilitator,
  header: string,
  requirements: VendorQuote,
): Promise<SettleResponse> {
  // The strict parse happens only on this path: the stub path above accepts the looser shape its
  // own tests send, but nothing reaches a real chain without passing x402's schema first.
  const parsed = PaymentPayloadV1Schema.safeParse(
    JSON.parse(Buffer.from(header, "base64").toString("utf8")),
  );
  if (!parsed.success) {
    throw new Error("the X-PAYMENT header is not a valid x402 payload");
  }

  // settle() is typed for v2, but registerExactSvmScheme registers a v1 handler alongside the v2
  // one and dispatch keys off x402Version, so a v1 payload settles. The cast marks the version
  // boundary rather than papering over a mismatch; both objects are schema-valid v1.
  const settled = await facilitator.settle(
    parsed.data as unknown as PaymentPayload,
    requirements as unknown as PaymentRequirements,
  );
  if (!settled.success) {
    throw new Error(settled.errorMessage ?? settled.errorReason ?? "the facilitator did not settle");
  }
  return settled;
}

if (process.argv[1]?.endsWith("vendor.ts")) {
  const port = Number(process.env["VENDOR_PORT"] ?? 3001);
  createVendorApp({ priceMinor: 50_000n, payTo: process.env["VENDOR_ADDRESS"] ?? DEFAULT_PAY_TO }).listen(
    port,
    () => process.stdout.write(`vendor listening on http://localhost:${port}\n`),
  );
}

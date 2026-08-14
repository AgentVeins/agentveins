import { EventEmitter } from "node:events";
import { PriceMismatchError, settleViaFacilitator } from "@agentveins/adapter-solana";
import type { Express, Request, Response as ExpressResponse } from "express";
import { describe, expect, it, vi } from "vitest";
import { createVendorApp } from "../src/vendor.js";

const PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const VENDOR_URL = "https://vendor.demo/forecast";
const FORECAST_PATH = "/forecast";

// The suite runs with fetch/http.request/https.request/net.connect/tls.connect/dns.lookup all
// blocked (including a plain `app.listen(0, "127.0.0.1")`, since Node resolves even a literal IP
// through dns.lookup before binding). Driving the Express app in-process — building the minimal
// req/res shape Express needs and calling the app as a plain function — exercises the exact same
// routing and handler code a real request would, without touching any network primitive.
interface FakeRequest extends EventEmitter {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string>;
}

interface FakeExpressResponse extends EventEmitter {
  statusCode: number;
  headersSent: boolean;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
  removeHeader(name: string): void;
  hasHeader(name: string): boolean;
  write(chunk?: unknown): boolean;
  end(chunk?: unknown, encoding?: unknown): void;
}

interface DrivenResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

function driveRequest(
  app: Express,
  path: string,
  requestHeaders: Record<string, string> = {},
): Promise<DrivenResponse> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as FakeRequest;
    req.method = "GET";
    req.url = path;
    req.httpVersion = "1.1";
    req.headers = Object.fromEntries(
      Object.entries(requestHeaders).map(([name, value]) => [name.toLowerCase(), value]),
    );

    const outHeaders: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const res = new EventEmitter() as FakeExpressResponse;
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = (name, value) => {
      outHeaders[name.toLowerCase()] = String(value);
    };
    res.getHeader = (name) => outHeaders[name.toLowerCase()];
    res.removeHeader = (name) => {
      delete outHeaders[name.toLowerCase()];
    };
    res.hasHeader = (name) => name.toLowerCase() in outHeaders;
    res.write = (chunk) => {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return true;
    };
    res.end = (chunk) => {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      res.headersSent = true;
      res.emit("finish");
    };
    res.on("finish", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
        resolve({ status: res.statusCode, body, headers: new Headers(outHeaders) });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    app(req as unknown as Request, res as unknown as ExpressResponse, (err?: unknown) => {
      if (err !== undefined) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

function fetchImplFor(app: Express): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const requestHeaders: Record<string, string> = {};
    if (init?.headers !== undefined) {
      new Headers(init.headers).forEach((value, key) => {
        requestHeaders[key] = value;
      });
    }
    const driven = await driveRequest(app, FORECAST_PATH, requestHeaders);
    return new Response(JSON.stringify(driven.body), {
      status: driven.status,
      headers: driven.headers,
    });
  }) as typeof fetch;
}

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
        fetchImpl: fetchImplFor(app),
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
      fetchImpl: fetchImplFor(app),
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

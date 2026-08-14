import { describe, expect, it } from "vitest";
import { createVendorApp } from "../src/vendor.js";
import { runDemo } from "../src/demo.js";
import { fetchImplFor } from "./support/expressHarness.js";

describe("runDemo", () => {
  it("completes the full governed loop offline in mock mode", async () => {
    const summary = await runDemo({ mock: true, quiet: true });
    if (summary.kind !== "five-act") {
      throw new Error(`expected the five-act path, got ${summary.kind}`);
    }

    expect(summary.settled).toBe(10);
    expect(summary.blocked).toBeGreaterThanOrEqual(3);
    expect(summary.failed).toBe(0);
    expect(summary.verified).toBe(true);
    expect(summary.tamperDetected).toBe(true);
  });

  it("catches a vendor overcharge before signing anything, offline", async () => {
    // The x402 act requests exactly its guard's per-tx limit (0.10 USDC = 100_000 minor units),
    // so the injected vendor must quote strictly more than that for the mismatch to fire.
    const vendorApp = createVendorApp({ priceMinor: 150_000n, payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" });
    const summary = await runDemo({ x402: true, quiet: true, fetchImpl: fetchImplFor(vendorApp, "/forecast") });
    if (summary.kind !== "x402-act") {
      throw new Error(`expected the x402 act, got ${summary.kind}`);
    }

    expect(summary.result.status).toBe("failed");
    if (summary.result.status === "failed") {
      expect(summary.result.error.code).toBe("price_mismatch");
    }
  });
});

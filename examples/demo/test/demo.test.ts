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

  it("blocks for approval, then settles once a human approves", async () => {
    const lines: string[] = [];
    const summary = await runDemo({ mock: true, approvals: true, logImpl: (line) => lines.push(line) });

    const text = lines.join("\n");
    expect(text).toContain("approval_required");
    expect(text).toContain("operator approves");
    expect(text).toContain("the approval is spent");

    expect(summary.kind).toBe("approval-act");
    if (summary.kind !== "approval-act") {
      throw new Error("expected the approval act");
    }
    expect(summary.result.status).toBe("settled");
  });
});

// I1: the demo printed violation.message straight to stdout, so an ANSI erase-line reaching the
// message forged a transcript line. Every rendered message now goes through the same escape the
// audit trail uses, which shows up as quoting.
describe("the transcript never emits raw terminal control sequences", () => {
  function hasControlChars(value: string): boolean {
    return [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    });
  }

  it("escapes every violation message it renders", async () => {
    const lines: string[] = [];
    await runDemo({ mock: true, logImpl: (line) => lines.push(line) });

    const blocked = lines.filter((line) => line.includes("BLOCKED"));
    expect(blocked.length).toBeGreaterThan(0);
    for (const line of blocked) {
      expect(line).toMatch(/BLOCKED {2}\w+ — "/);
    }
    for (const line of lines) {
      // The demo's own act headers open with a literal newline; nothing after it may carry a
      // control character, because every value on a line is escaped before it is rendered.
      expect(hasControlChars(line.replace(/^\n+/, ""))).toBe(false);
    }
  });
});

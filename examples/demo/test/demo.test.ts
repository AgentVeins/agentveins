import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileApprovalStore } from "@agentveins/core/fs";
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

  it("settles to the pace cap, then blocks with velocity", async () => {
    const summary = await runDemo({ velocity: true, quiet: true });
    if (summary.kind !== "velocity-act") throw new Error("expected the velocity act");
    expect(summary.result.status).toBe("blocked");
    if (summary.result.status !== "blocked") throw new Error("expected blocked");
    expect(summary.result.violation.code).toBe("velocity_exceeded");
    expect(summary.settled).toBe(3);
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

describe("hold mode", () => {
  it("stops at the block, then settles once a person has approved between runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veins-hold-"));
    const paths = {
      auditPath: join(dir, "audit.jsonl"),
      approvalsPath: join(dir, "approvals.json"),
      publicKeyPath: join(dir, "operator.pub.pem"),
      privateKeyPath: join(dir, "operator.key.pem"),
    };

    const first = await runDemo({ hold: true, quiet: true, ...paths });
    if (first.kind !== "hold-act") throw new Error("expected the hold act");
    expect(first.result.status).toBe("blocked");

    // The operator's step, done the way the CLI does it — through the store's own API.
    const store = fileApprovalStore(paths.approvalsPath);
    await store.grant({
      agent: "weather-agent",
      vendorNormalized: "api.weather.com",
      amountMinor: 100_000n,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });

    // A second guard over the same files: the log must verify under the persisted key, or this
    // throws rather than settling.
    const second = await runDemo({ hold: true, quiet: true, ...paths });
    if (second.kind !== "hold-act") throw new Error("expected the hold act");
    expect(second.result.status).toBe("settled");

    // Single-use holds across processes too.
    const third = await runDemo({ hold: true, quiet: true, ...paths });
    if (third.kind !== "hold-act") throw new Error("expected the hold act");
    expect(third.result.status).toBe("blocked");
  });

  it("clears everything on --reset so the next run starts from nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veins-hold-"));
    const paths = {
      auditPath: join(dir, "audit.jsonl"),
      approvalsPath: join(dir, "approvals.json"),
      publicKeyPath: join(dir, "operator.pub.pem"),
      privateKeyPath: join(dir, "operator.key.pem"),
    };

    await runDemo({ hold: true, quiet: true, ...paths });
    const store = fileApprovalStore(paths.approvalsPath);
    await store.grant({
      agent: "weather-agent",
      vendorNormalized: "api.weather.com",
      amountMinor: 100_000n,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });

    const afterReset = await runDemo({ hold: true, reset: true, quiet: true, ...paths });
    if (afterReset.kind !== "hold-act") throw new Error("expected the hold act");
    // The approval went with the reset, so the agent is asking again rather than settling.
    expect(afterReset.result.status).toBe("blocked");
  });
});

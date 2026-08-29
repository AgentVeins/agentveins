import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  createGuard,
  formatAmount,
  memoryApprovalStore,
  memoryAuditSink,
  normalizeVendor,
  type Policy,
} from "@agentveins/core";
import { solanaAdapter } from "@agentveins/adapter-solana";
import { createKeyPairFromBytes, createSolanaRpc, devnet, signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { loadEnvFile, resolveFromPackage } from "../src/env.js";
import { devnetFacilitator } from "../src/facilitator.js";
import { explorerUrl } from "../src/trace.js";
import { createVendorApp } from "../src/vendor.js";
import { fetchImplFor } from "./support/expressHarness.js";

// Before the gate below reads them: vitest does not load the demo's .env the way the demo
// runner does, so without this the test silently skips on a fully configured machine.
await loadEnvFile();

const agentKeypairPath = process.env["SOLANA_KEYPAIR_PATH"];
const facilitatorKeypairPath = process.env["FACILITATOR_KEYPAIR_PATH"];
const vendorAddress = process.env["VENDOR_ADDRESS"];
const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com";
const configured =
  process.env["DEVNET_SETTLE"] === "1" &&
  agentKeypairPath !== undefined &&
  facilitatorKeypairPath !== undefined &&
  vendorAddress !== undefined;

const PRICE_MINOR = 10_000n;
const THRESHOLD = "0.005";
const VENDOR_URL = "https://vendor.devnet/forecast";
const FORECAST_PATH = "/forecast";
const AGENT = "devnet-approval-agent";

async function keypairBytes(path: string): Promise<Uint8Array> {
  return Uint8Array.from(JSON.parse(await readFile(resolveFromPackage(path), "utf8")) as number[]);
}

/**
 * The approval gate against a real rail.
 *
 * Every other approval test stubs the adapter, which proves the policy decision but leaves the
 * composition untested: that a denial really does stop short of the chain, and that a granted
 * approval really does release a settlement. Both halves need a rail that can actually move
 * money to mean anything.
 *
 * The blocked half is the one worth the setup. Asserting "blocked" only proves what the guard
 * returned; counting the vendor calls proves what it did — an approval-blocked payment never
 * reaches the endpoint at all, so no quote is fetched and nothing is signed.
 */
describe.skipIf(!configured)("approval gate over devnet x402", () => {
  it("blocks without touching the chain, then settles for real once approved", async () => {
    const agentKeypair = await createKeyPairFromBytes(await keypairBytes(agentKeypairPath ?? ""));
    const { facilitator, feePayer } = await devnetFacilitator({
      secretKey: await keypairBytes(facilitatorKeypairPath ?? ""),
      rpcUrl,
    });

    const vendor = createVendorApp({
      priceMinor: PRICE_MINOR,
      payTo: vendorAddress ?? "",
      feePayer,
      facilitator,
    });

    // The adapter's only route to the outside world, so this counter is a complete record of
    // whether the payment path was entered.
    let vendorCalls = 0;
    const innerFetch = fetchImplFor(vendor, FORECAST_PATH);
    const countingFetch: typeof fetch = (input, init) => {
      vendorCalls += 1;
      return innerFetch(input, init);
    };

    const approvals = memoryApprovalStore([]);
    const policy: Policy = {
      budgets: [
        { period: "per_tx", limit: "1.00", currency: "USDC" },
        { period: "daily", limit: "1.00", currency: "USDC" },
      ],
      vendors: { mode: "allowlist", entries: [normalizeVendor(VENDOR_URL)] },
      recipients: { mode: "allowlist", entries: [vendorAddress ?? ""] },
      approvals: { above: THRESHOLD },
      killSwitch: { frozen: false },
    };

    const guard = await createGuard({
      policy,
      adapters: [
        solanaAdapter({ keypair: agentKeypair, rpcUrl, mode: "x402", fetchImpl: countingFetch }),
      ],
      audit: memoryAuditSink(),
      agent: AGENT,
      logId: "devnet-approval-test",
      signingKey: generateKeyPairSync("ed25519").privateKey,
      approvals,
    });

    const request = {
      to: VENDOR_URL,
      amount: formatAmount(PRICE_MINOR),
      currency: "USDC" as const,
      reason: "approval gate devnet smoke test",
    };

    const blocked = await guard.pay(request);

    expect(blocked.status).toBe("blocked");
    if (blocked.status !== "blocked") {
      throw new Error("expected the first payment to be blocked");
    }
    expect(blocked.violation.code).toBe("approval_required");
    // The claim the mocked tests cannot make: the vendor was never contacted, so no quote was
    // requested, no transfer was signed, and no facilitator was asked to broadcast.
    expect(vendorCalls).toBe(0);

    approvals.approvals.push({
      agent: AGENT,
      vendorNormalized: normalizeVendor(VENDOR_URL),
      amountMinor: PRICE_MINOR,
      id: "apr_devnet",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      usedAt: null,
    });

    const settled = await guard.pay(request);

    expect(settled.status).toBe("settled");
    if (settled.status !== "settled") {
      throw new Error("expected the approved payment to settle");
    }
    expect(settled.txSig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);
    expect(vendorCalls).toBeGreaterThan(0);

    // The facilitator's response is the only place that signature comes from, so read the chain
    // back independently. Without this the test proves the facilitator answered, not that
    // anything settled.
    const rpc = createSolanaRpc(devnet(rpcUrl));
    const confirmed = await rpc
      .getTransaction(signature(settled.txSig), {
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send();

    expect(confirmed).not.toBeNull();
    expect(confirmed?.meta?.err).toBeNull();

    // An approval authorises one payment. Proving that against a real rail is the point: a
    // replay must be refused before the chain is touched again, not merely reported as refused.
    const callsAfterSettlement = vendorCalls;
    const replay = await guard.pay(request);

    expect(replay.status).toBe("blocked");
    if (replay.status !== "blocked") {
      throw new Error("expected the replay to be blocked");
    }
    expect(replay.violation.code).toBe("approval_required");
    expect(vendorCalls).toBe(callsAfterSettlement);

    process.stdout.write(
      `\n  approval gate settled ${formatAmount(PRICE_MINOR)} USDC on devnet\n` +
        `  ${explorerUrl(settled.txSig)}\n` +
        `  blocked before approval with no vendor call; replay after refused the same way\n\n`,
    );
  }, 180_000);
});

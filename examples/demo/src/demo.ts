import { generateKeyPairSync } from "node:crypto";
import type { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import {
  createGuard,
  formatAmount,
  memoryAuditSink,
  verifyAuditLog,
  type AuditEntry,
  type PayResult,
  type Policy,
  type WalletAdapter,
} from "@agentveins/core";
import { solanaAdapter } from "@agentveins/adapter-solana";
import { createKeyPairFromBytes } from "@solana/kit";
import { mockAdapter } from "./mockAdapter.js";
import { createVendorApp } from "./vendor.js";

export interface DemoOptions {
  mock?: boolean;
  x402?: boolean;
  quiet?: boolean;
  /** Test-only seam: routes the x402 act's vendor call through this instead of a real listener. */
  fetchImpl?: typeof fetch;
}

export interface FiveActSummary {
  kind: "five-act";
  settled: number;
  blocked: number;
  failed: number;
  verified: boolean;
  tamperDetected: boolean;
}

export interface X402ActSummary {
  kind: "x402-act";
  result: PayResult;
}

export type DemoSummary = FiveActSummary | X402ActSummary;

type Logger = (line: string) => void;

const MESSAGE_MAX = 200;

function truncate(value: string, max = 32): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safe(value: string, max = 32): string {
  return JSON.stringify(truncate(value, max));
}

function safeDetail(detail: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, truncate(value, 64)]));
}

function buildPolicy(allowedVendor: string): Policy {
  return {
    budgets: [
      { period: "per_tx", limit: "0.10", currency: "USDC" },
      { period: "daily", limit: "0.50", currency: "USDC" },
    ],
    vendors: { mode: "allowlist", entries: [allowedVendor] },
    killSwitch: { frozen: false },
  };
}

function record(log: Logger, counts: { settled: number; blocked: number; failed: number }) {
  return (label: string, result: PayResult): void => {
    counts[result.status]++;
    if (result.status === "settled") {
      log(`  ✓ ${label} settled  tx=${result.txSig}`);
    } else if (result.status === "blocked") {
      log(`  ✗ ${label} BLOCKED  ${result.violation.code} — ${result.violation.message}`);
      if (result.violation.detail !== undefined) {
        // The violation's detail can carry the raw vendor string an agent requested, which is
        // untrusted and unbounded in length; it is escaped and truncated the same way Act 5's
        // audit trail is.
        log(`      ${JSON.stringify(safeDetail(result.violation.detail))}`);
      }
      log("      no chain call was made");
    } else {
      // The adapter's error can wrap an arbitrary rail exception, and its message is untrusted
      // the same way a vendor string is — escaped and truncated before it reaches stdout.
      log(`  ! ${label} failed   ${result.error.code} — ${safe(result.error.message, MESSAGE_MAX)}`);
    }
  };
}

// A minimal, dependency-free .env reader: KEY=VALUE lines, optional quotes, "#" comments. Only
// fills in variables the shell has not already set, so a real environment always wins over the
// file. Silently does nothing when the file is absent, which is every --mock run and every fresh
// clone before an operator creates one.
async function loadEnvFile(path = ".env"): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function loadDirectKeypair(): Promise<webcrypto.CryptoKeyPair> {
  const path = process.env["SOLANA_KEYPAIR_PATH"];
  if (path === undefined) {
    throw new Error(
      "direct mode needs a funded devnet keypair: set SOLANA_KEYPAIR_PATH to a Solana keypair " +
        "JSON file (see .env.example — examples/demo/.env is loaded automatically if present), " +
        "or run with --mock",
    );
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `could not read the keypair file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
  return createKeyPairFromBytes(bytes);
}

// Acts 1-5: an agent spends normally, hits its per-tx and daily budgets, gets blocked, gets
// frozen, and the audit log proves every attempt. `--mock` keeps this offline for CI; without it,
// this settles genuine USDC transfers on Solana devnet.
async function runFiveActs(options: DemoOptions, log: Logger): Promise<FiveActSummary> {
  const keys = generateKeyPairSync("ed25519");
  const audit = memoryAuditSink();

  let vendorId: string;
  let allowedVendor: string;
  let adapter: WalletAdapter;
  if (options.mock === true) {
    vendorId = "https://api.weather.com/forecast";
    allowedVendor = new URL(vendorId).hostname;
    adapter = mockAdapter();
  } else {
    const vendorAddress = process.env["VENDOR_ADDRESS"];
    if (vendorAddress === undefined) {
      throw new Error(
        "direct mode needs a devnet USDC recipient: set VENDOR_ADDRESS (see .env.example — " +
          "examples/demo/.env is loaded automatically if present), or run with --mock",
      );
    }
    const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com";
    vendorId = vendorAddress;
    allowedVendor = vendorAddress;
    adapter = solanaAdapter({ keypair: await loadDirectKeypair(), rpcUrl, mode: "direct" });
  }

  const policy = buildPolicy(allowedVendor);
  const guard = await createGuard({
    policy,
    adapters: [adapter],
    audit,
    agent: "weather-agent",
    logId: "weather-agent-demo",
    signingKey: keys.privateKey,
  });

  const counts = { settled: 0, blocked: 0, failed: 0 };
  const recordResult = record(log, counts);

  log("\n── Act 1: the policy ─────────────────────");
  log("  per-tx limit  0.10 USDC");
  log("  daily limit   0.50 USDC");
  // allowedVendor is operator config (VENDOR_ADDRESS or a literal), but it still comes from the
  // environment, so it is displayed the same escaped, truncated way as any other vendor string.
  log(`  allowlist     ${policy.vendors.entries.map((entry) => safe(entry)).join(", ")}`);

  log("\n── Act 2: the agent works normally ─────────────");
  for (let i = 1; i <= 10; i++) {
    const result = await guard.pay({
      to: vendorId,
      amount: "0.05",
      currency: "USDC",
      reason: `forecast query ${i}`,
    });
    recordResult(`payment ${i} (0.05)`, result);
  }

  log("\n── Act 3: the guard says no ────────────────");
  recordResult(
    "oversized payment (0.25)",
    await guard.pay({ to: vendorId, amount: "0.25", currency: "USDC", reason: "bulk forecast" }),
  );
  recordResult(
    "unapproved vendor",
    await guard.pay({ to: "https://evil.example/drain", amount: "0.01", currency: "USDC", reason: "unknown" }),
  );
  recordResult(
    "payment 11 (0.05)",
    await guard.pay({ to: vendorId, amount: "0.05", currency: "USDC", reason: "forecast query 11" }),
  );

  log("\n── Act 4: the kill switch ──────────────────");
  await guard.freeze();
  log("  operator froze the agent");
  recordResult(
    "payment after freeze",
    await guard.pay({ to: vendorId, amount: "0.01", currency: "USDC", reason: "retry" }),
  );

  log("\n── Act 5: proof ────────────────────────");
  for (const entry of audit.entries) {
    if (entry.kind === "control") {
      // Freeze/unfreeze entries are not payments: labeling them "settled" next to a real
      // settlement misreads as a payment that went through.
      log(`  #${entry.seq} control ${entry.reason}`);
    } else {
      log(
        `  #${entry.seq} ${entry.outcome.padEnd(7)} ${formatAmount(BigInt(entry.amountMinor))} ` +
          `${safe(entry.vendorNormalized)} ${safe(entry.reason)}`,
      );
    }
  }

  const verified = await verifyAuditLog(audit.entries, keys.publicKey);
  log(`\n  verifyAuditLog → ${verified.ok ? "OK" : "FAILED"} (${verified.checked} entries checked)`);

  const tampered: AuditEntry[] = audit.entries.map((entry, index) =>
    index === 3 ? { ...entry, amountMinor: "1" } : entry,
  );
  const afterTamper = await verifyAuditLog(tampered, keys.publicKey);
  log(
    `  after editing one amount → ${
      afterTamper.ok ? "OK" : `FAILED at seq ${afterTamper.failure?.seq} (${afterTamper.failure?.reason})`
    }`,
  );

  return {
    kind: "five-act",
    settled: counts.settled,
    blocked: counts.blocked,
    failed: counts.failed,
    verified: verified.ok,
    tamperDetected: !afterTamper.ok,
  };
}

// A sixth, standalone act: the agent requests exactly the guard's per-tx limit, and the vendor
// quotes more than both that request and the limit itself. The guard approves the request — it is
// within every policy check — and the adapter's settleViaFacilitator is the component that
// re-checks the vendor's 402 quote against what was actually approved and refuses to sign. This
// never touches devnet: the price mismatch trips before the adapter needs a real signer.
async function runX402Act(options: DemoOptions, log: Logger): Promise<X402ActSummary> {
  const keys = generateKeyPairSync("ed25519");
  const audit = memoryAuditSink();

  const quotedMinor = 150_000n; // 0.15 USDC — genuinely above the per-tx limit below
  const payTo = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  let vendorUrl: string;
  let vendorServer: Server | undefined;
  const fetchImpl = options.fetchImpl;
  if (fetchImpl === undefined) {
    const port = Number(process.env["VENDOR_PORT"] ?? 3001);
    vendorServer = createVendorApp({ priceMinor: quotedMinor, payTo }).listen(port);
    vendorUrl = `http://localhost:${port}/forecast`;
    log(`  vendor listening on http://localhost:${port}`);
  } else {
    vendorUrl = "https://vendor.demo/forecast";
  }

  const policy = buildPolicy(new URL(vendorUrl).hostname);
  const perTxBudget = policy.budgets.find((budget) => budget.period === "per_tx");
  if (perTxBudget === undefined) {
    throw new Error("buildPolicy must define a per_tx budget for this act to make sense");
  }
  // The agent asks for the most a single payment may be approved for under this policy, so the
  // only reason the payment can fail is the vendor's own quote — never a policy limit.
  const requestedAmount = perTxBudget.limit;

  const adapter = solanaAdapter({
    keypair: {} as webcrypto.CryptoKeyPair,
    rpcUrl: process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com",
    mode: "x402",
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  const guard = await createGuard({
    policy,
    adapters: [adapter],
    audit,
    agent: "weather-agent",
    logId: "weather-agent-x402-demo",
    signingKey: keys.privateKey,
  });

  log("\n── The x402 act: a vendor tries to overcharge ────");
  log(`  guard's per-tx limit  ${perTxBudget.limit} USDC`);
  log(`  the agent requests    ${requestedAmount} USDC`);
  log(`  the vendor quotes     ${formatAmount(quotedMinor)} USDC`);

  const result = await guard.pay({
    to: vendorUrl,
    amount: requestedAmount,
    currency: "USDC",
    reason: "forecast query",
  });

  if (result.status === "failed") {
    log(`  ! payment failed   ${result.error.code} — ${safe(result.error.message, MESSAGE_MAX)}`);
    log("  the guard approved the request — the adapter refused to sign once the vendor's quote exceeded it");
  } else if (result.status === "blocked") {
    log(`  ✗ payment BLOCKED  ${result.violation.code} — ${result.violation.message}`);
  } else {
    log(`  ✓ payment settled  tx=${result.txSig}`);
  }

  vendorServer?.close();

  return { kind: "x402-act", result };
}

export async function runDemo(options: DemoOptions): Promise<DemoSummary> {
  const log: Logger = options.quiet === true ? () => {} : (line) => process.stdout.write(`${line}\n`);
  if (options.x402 === true) {
    return runX402Act(options, log);
  }
  return runFiveActs(options, log);
}

if (process.argv[1]?.endsWith("demo.ts")) {
  await loadEnvFile();
  const summary = await runDemo({
    mock: process.argv.includes("--mock"),
    x402: process.argv.includes("--x402"),
  });
  if (summary.kind === "x402-act") {
    if (summary.result.status !== "failed" || summary.result.error.code !== "price_mismatch") {
      process.exitCode = 1;
    }
  } else if (!summary.verified || !summary.tamperDetected || summary.failed > 0) {
    // The primary deliverable failing silently is worse than it failing loudly.
    process.exitCode = 1;
  }
}

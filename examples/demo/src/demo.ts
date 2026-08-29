import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { webcrypto } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import {
  createGuard,
  formatAmount,
  memoryApprovalStore,
  memoryAuditSink,
  verifyAuditLog,
  type AuditEntry,
  type PayResult,
  type Policy,
  type WalletAdapter,
} from "@agentveins/core";
import { solanaAdapter } from "@agentveins/adapter-solana";
import { createKeyPairFromBytes } from "@solana/kit";
import { loadEnvFile } from "./env.js";
import { tracingFetch } from "./trace.js";
import { fileApprovalStore, fileAuditSink } from "@agentveins/core/fs";
import { mockAdapter } from "./mockAdapter.js";
import { createVendorApp } from "./vendor.js";

export interface DemoOptions {
  mock?: boolean;
  x402?: boolean;
  approvals?: boolean;
  /**
   * Where the approval act keeps its log and store. Left unset the act runs in memory, which is
   * what the tests want; set, it leaves the artifacts `@agentveins/cli` reads.
   */
  auditPath?: string;
  approvalsPath?: string;
  /** Where to leave the public key, so `veins --verify` can be demonstrated against the log. */
  publicKeyPath?: string;
  quiet?: boolean;
  /** Test-only seam: routes the x402 act's vendor call through this instead of a real listener. */
  fetchImpl?: typeof fetch;
  /** Test-only seam: captures the transcript instead of writing it to stdout. */
  logImpl?: (line: string) => void;
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

export interface ApprovalActSummary {
  kind: "approval-act";
  result: PayResult;
}

export type DemoSummary = FiveActSummary | X402ActSummary | ApprovalActSummary;

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
      // The message can quote a rule the caller broke; the guard keeps caller-supplied values
      // out of it, and this escapes and truncates it anyway rather than trusting that twice.
      log(`  ✗ ${label} BLOCKED  ${result.violation.code} — ${safe(result.violation.message, MESSAGE_MAX)}`);
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


async function loadDirectKeypair(): Promise<webcrypto.CryptoKeyPair> {
  const path = process.env["SOLANA_KEYPAIR_PATH"];
  if (path === undefined) {
    throw new Error(
      "direct mode needs a funded devnet keypair: set SOLANA_KEYPAIR_PATH to a Solana keypair " +
        "JSON file (see examples/demo/.env.example — copy it to examples/demo/.env, which is " +
        "loaded automatically if present), or run with --mock",
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
        "direct mode needs a devnet USDC recipient: set VENDOR_ADDRESS (see " +
          "examples/demo/.env.example — copy it to examples/demo/.env, which is loaded " +
          "automatically if present), or run with --mock",
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
        `  #${entry.seq} ${entry.outcome.padEnd(9)} ${formatAmount(BigInt(entry.amountMinor))} ` +
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
    // Always wrapped, so the handshake is on screen whether the vendor is a real listener or the
    // in-process app the tests drive.
    fetchImpl: tracingFetch(fetchImpl ?? fetch, log),
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
  log("\n  the x402 exchange, as it happens over HTTP:");

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
    log(`  ✗ payment BLOCKED  ${result.violation.code} — ${safe(result.violation.message, MESSAGE_MAX)}`);
  } else {
    log(`  ✓ payment settled  tx=${result.txSig}`);
  }

  vendorServer?.close();

  return { kind: "x402-act", result };
}

// A seventh, standalone act: the agent asks for more than the approval threshold allows. The
// guard blocks it with nothing signed, an operator approves those exact terms, and the identical
// request settles. The approval is spent on use, so replaying the same request blocks again.
async function runApprovalAct(options: DemoOptions, log: Logger): Promise<ApprovalActSummary> {
  const store =
    options.approvalsPath === undefined
      ? memoryApprovalStore([])
      : fileApprovalStore(options.approvalsPath);
  const policy: Policy = { ...buildPolicy("api.weather.com"), approvals: { above: "0.05" } };
  const keys = generateKeyPairSync("ed25519");

  // Each run starts clean. The signing key is generated per run, so a log left by a previous run
  // was signed by a key that no longer exists and the guard would refuse to start on it — rightly,
  // since that is indistinguishable from a forged log. Keeping the key instead would trade this
  // for a slower failure: the daily budget replays too, and the act would eventually block on
  // spend rather than on approval, which demonstrates the wrong thing.
  if (options.auditPath !== undefined) {
    await rm(options.auditPath, { force: true });
  }
  if (options.approvalsPath !== undefined) {
    await rm(options.approvalsPath, { force: true });
  }
  if (options.publicKeyPath !== undefined) {
    await writeFile(
      options.publicKeyPath,
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      "utf8",
    );
  }
  const audit =
    options.auditPath === undefined ? memoryAuditSink() : fileAuditSink(options.auditPath);
  const guard = await createGuard({
    policy,
    adapters: [mockAdapter()],
    audit,
    agent: "weather-agent",
    logId: "weather-agent-approval-demo",
    signingKey: keys.privateKey,
    approvals: store,
  });

  const request = { to: "https://api.weather.com/forecast", amount: "0.10", currency: "USDC" as const, reason: "bulk forecast" };

  log("\n── The approval act: the agent asks permission ────");
  log(`  approval threshold    ${policy.approvals?.above} USDC`);
  log(`  the agent requests    ${request.amount} USDC`);

  const first = await guard.pay(request);
  if (first.status === "blocked") {
    log(`  ✗ payment BLOCKED  ${first.violation.code} — awaiting a human`);
    log("      no chain call was made — the attempt is in the audit log, signed");
  }

  log("\n  operator approves 0.10 USDC to api.weather.com, once");
  await store.grant({
    agent: "weather-agent",
    vendorNormalized: "api.weather.com",
    amountMinor: 100_000n,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  const second = await guard.pay(request);
  if (second.status === "settled") {
    log(`  ✓ payment settled  tx=${second.txSig}`);
  }
  log("  the approval is spent: an identical payment would be blocked again");

  if (options.auditPath !== undefined && options.approvalsPath !== undefined) {
    log("\n  the operator's side of this is a real log on disk, not a fixture:");
    log(`      ${options.auditPath}`);
    log(`      ${options.approvalsPath}`);
    log("\n  review it the way an operator would:");
    const verify = options.publicKeyPath === undefined ? "" : ` --verify ${options.publicKeyPath}`;
    log(
      `      npx @agentveins/cli pending --log ${options.auditPath} --approvals ${options.approvalsPath}${verify}`,
    );
  }

  return { kind: "approval-act", result: second };
}

export async function runDemo(options: DemoOptions): Promise<DemoSummary> {
  const log: Logger =
    options.logImpl ?? (options.quiet === true ? () => {} : (line) => process.stdout.write(`${line}\n`));
  if (options.x402 === true) {
    return runX402Act(options, log);
  }
  if (options.approvals === true) {
    return runApprovalAct(options, log);
  }
  return runFiveActs(options, log);
}

if (process.argv[1]?.endsWith("demo.ts")) {
  await loadEnvFile();
  const summary = await runDemo({
    mock: process.argv.includes("--mock"),
    x402: process.argv.includes("--x402"),
    approvals: process.argv.includes("--approvals"),
    // Resolved against this file, not the cwd: `npm run demo` starts in the package while a
    // developer may not, and artifacts landing somewhere different each time is its own bug.
    ...(process.argv.includes("--approvals")
      ? {
          auditPath: fileURLToPath(new URL("../audit.jsonl", import.meta.url)),
          approvalsPath: fileURLToPath(new URL("../approvals.json", import.meta.url)),
          publicKeyPath: fileURLToPath(new URL("../operator.pub.pem", import.meta.url)),
        }
      : {}),
  });
  if (summary.kind === "x402-act") {
    if (summary.result.status !== "failed" || summary.result.error.code !== "price_mismatch") {
      process.exitCode = 1;
    }
  } else if (summary.kind === "approval-act") {
    if (summary.result.status !== "settled") {
      process.exitCode = 1;
    }
  } else if (!summary.verified || !summary.tamperDetected || summary.failed > 0) {
    // The primary deliverable failing silently is worse than it failing loudly.
    process.exitCode = 1;
  }
}

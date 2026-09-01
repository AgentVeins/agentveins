import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { createGuard } from "@agentveins/core";
import { fileAnchorStore, fileApprovalStore, fileAuditSink } from "@agentveins/core/fs";
import { solanaAdapter } from "@agentveins/adapter-solana";
import { createKeyPairFromBytes } from "@solana/kit";
import type { Guard, Policy, SettlementReceipt, WalletAdapter } from "@agentveins/core";
import type { Rail } from "./rail.js";

export type { Rail } from "./rail.js";

export interface BuiltGuard {
  guard: Guard;
  rail: Rail;
}

function required(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is not set: ${why}`);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parsed here rather than inside the guard so a missing or malformed file is refused by the
 * name of the variable that points at it, not by a JSON error naming nothing.
 */
async function readPolicy(path: string): Promise<Policy> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`AGENTVEINS_POLICY points at ${path}, which cannot be read: ${message(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`AGENTVEINS_POLICY points at ${path}, which is not valid JSON: ${message(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`AGENTVEINS_POLICY points at ${path}, which is not a JSON object describing a policy`);
  }
  return parsed as Policy;
}

/**
 * A rail that governs payments without moving money. The signature is deliberately not
 * base58-shaped: nothing that reaches a log or a model should be mistakable for a real one.
 */
function mockAdapter(): WalletAdapter {
  let counter = 0;
  return {
    name: "mock",
    currency: "USDC",
    async execute(req): Promise<SettlementReceipt> {
      counter += 1;
      return { txSig: `mock-${counter}-${req.amountMinor}`, rail: "mock" };
    },
  };
}

async function buildAdapter(env: NodeJS.ProcessEnv, rail: Rail): Promise<WalletAdapter> {
  if (rail === "mock") {
    return mockAdapter();
  }
  const keypairPath = required(env, "SOLANA_KEYPAIR_PATH", "the solana rail needs a funded keypair");
  const rpcUrl = env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com";
  const mode = env["SOLANA_MODE"] ?? "direct";
  if (mode !== "direct" && mode !== "x402") {
    throw new Error(`SOLANA_MODE must be "direct" or "x402", received ${JSON.stringify(mode)}`);
  }
  const secret = Uint8Array.from(JSON.parse(await readFile(keypairPath, "utf8")) as number[]);
  return solanaAdapter({ keypair: await createKeyPairFromBytes(secret), rpcUrl, mode });
}

export async function buildGuard(env: NodeJS.ProcessEnv): Promise<BuiltGuard> {
  const rail = required(
    env,
    "AGENTVEINS_RAIL",
    'set it to "solana", or to "mock" to govern payments that never move money',
  );
  if (rail !== "solana" && rail !== "mock") {
    throw new Error(`AGENTVEINS_RAIL must be "solana" or "mock", received ${JSON.stringify(rail)}`);
  }

  const policyPath = required(env, "AGENTVEINS_POLICY", "the guard needs a policy to enforce");
  const policy = await readPolicy(policyPath);

  // A guard replays its audit log at startup and refuses one it cannot verify, so a key
  // generated per launch would work exactly once. An MCP client restarts its servers often.
  const keyPath = required(
    env,
    "AGENTVEINS_SIGNING_KEY",
    "the audit log is signed, and a key that changes between runs makes the log unverifiable",
  );
  const signingKey = createPrivateKey(await readFile(keyPath, "utf8"));

  // An MCP client launches this server with a working directory the operator neither picks
  // nor sees, and a missing log reads as a first run rather than an error. A relative
  // default would hand back the whole daily budget on every launch from a new directory.
  const auditPath = required(
    env,
    "AGENTVEINS_AUDIT",
    "the audit log holds the spend counter, and a path that moves with the working directory silently resets it; give an absolute path",
  );
  const anchorPath = env["AGENTVEINS_ANCHOR"];
  const approvalsPath = env["AGENTVEINS_APPROVALS"];

  if (anchorPath === undefined) {
    // A warning, not a refusal: core treats the anchor as optional and this server should
    // not be stricter than the library it serves.
    process.stderr.write(
      "agentveins-mcp: AGENTVEINS_ANCHOR is not set — without an anchor, a deleted audit log reads as a fresh start and restores the full budget\n",
    );
  }

  const guard = await createGuard({
    policy,
    adapters: [await buildAdapter(env, rail)],
    audit: fileAuditSink(auditPath),
    agent: env["AGENTVEINS_AGENT"] ?? "mcp-agent",
    logId: env["AGENTVEINS_LOG_ID"] ?? "mcp",
    signingKey,
    ...(anchorPath === undefined ? {} : { anchor: fileAnchorStore(anchorPath) }),
    ...(approvalsPath === undefined ? {} : { approvals: fileApprovalStore(approvalsPath) }),
  });

  return { guard, rail };
}

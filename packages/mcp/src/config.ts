import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  const policy = JSON.parse(await readFile(policyPath, "utf8")) as Policy;

  // A guard replays its audit log at startup and refuses one it cannot verify, so a key
  // generated per launch would work exactly once. An MCP client restarts its servers often.
  const keyPath = required(
    env,
    "AGENTVEINS_SIGNING_KEY",
    "the audit log is signed, and a key that changes between runs makes the log unverifiable",
  );
  const signingKey = createPrivateKey(await readFile(keyPath, "utf8"));

  const auditPath = env["AGENTVEINS_AUDIT"] ?? "./audit.jsonl";
  const anchorPath = env["AGENTVEINS_ANCHOR"];
  const approvalsPath = env["AGENTVEINS_APPROVALS"];

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

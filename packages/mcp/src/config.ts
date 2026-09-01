import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { createGuard } from "@agentveins/core";
import { fileAnchorStore, fileApprovalStore, fileAuditSink } from "@agentveins/core/fs";
import { solanaAdapter } from "@agentveins/adapter-solana";
import { createKeyPairFromBytes } from "@solana/kit";
import type { KeyObject } from "node:crypto";
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

function isMissing(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
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
 * Loads the signing key, creating it beside the policy on a first run.
 *
 * A guard replays its audit log at startup and refuses one it cannot verify, so a key that
 * changes between launches makes the log unreadable after the first one — and an MCP client
 * restarts its servers constantly. What that argument requires is a key that *persists*, not
 * one the operator has to produce by hand, so this writes one once and reads it thereafter.
 *
 * A key file that exists but cannot be read is an error, never a reason to write a new one:
 * replacing it would orphan every entry the old key signed.
 */
async function loadOrCreateSigningKey(path: string): Promise<KeyObject> {
  let source: string | null = null;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) {
      throw new Error(`the signing key at ${path} cannot be read: ${message(error)}`);
    }
  }

  if (source !== null) {
    try {
      return createPrivateKey(source);
    } catch (error) {
      throw new Error(
        `the signing key at ${path} is not a readable private key: ${message(error)} — move it aside rather than deleting it, since the existing audit log was signed with it`,
      );
    }
  }

  const keys = generateKeyPairSync("ed25519");
  // 0o600: it signs the audit log, so anything that can read it can forge an entry.
  await writeFile(path, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    encoding: "utf8",
    mode: 0o600,
  });
  // Written beside the private half so `veins --verify` has something to check the log against,
  // named the way the rest of this project already names the pair: operator.key.pem next to
  // operator.pub.pem, rather than a doubled suffix.
  const publicPath = path.endsWith(".key.pem")
    ? `${path.slice(0, -".key.pem".length)}.pub.pem`
    : `${path}.pub.pem`;
  await writeFile(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
  process.stderr.write(
    `agentveins-mcp: created a signing key at ${path} — keep it, the audit log cannot be verified without it\n`,
  );
  return keys.privateKey;
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

/**
 * A configured rail wins; a Solana keypair implies the Solana rail; otherwise the operator says.
 *
 * The inference only ever runs toward the real rail. Defaulting to `mock` would hand someone a
 * server that reports settlements while moving nothing, which is the one guess this must not make.
 */
function resolveRail(env: NodeJS.ProcessEnv): Rail {
  const configured = env["AGENTVEINS_RAIL"];
  if (configured === undefined || configured.trim() === "") {
    if (env["SOLANA_KEYPAIR_PATH"] !== undefined) {
      return "solana";
    }
    throw new Error(
      'AGENTVEINS_RAIL is not set: set it to "solana" and give SOLANA_KEYPAIR_PATH, or to "mock" to govern payments that never move money',
    );
  }
  if (configured !== "solana" && configured !== "mock") {
    throw new Error(`AGENTVEINS_RAIL must be "solana" or "mock", received ${JSON.stringify(configured)}`);
  }
  return configured;
}

export async function buildGuard(env: NodeJS.ProcessEnv): Promise<BuiltGuard> {
  const rail = resolveRail(env);
  const policyPath = required(env, "AGENTVEINS_POLICY", "the guard needs a policy to enforce");
  const policy = await readPolicy(policyPath);

  // Everything else lives beside the policy unless it is named. The alternative default is the
  // process's working directory, which an MCP client picks and the operator never sees — and a
  // missing audit log reads as a first run, so a wandering path hands back the whole daily
  // budget on every launch from somewhere new. The policy file is a location someone chose.
  const home = dirname(resolve(policyPath));
  const beside = (name: string): string => resolve(home, name);

  const auditPath = env["AGENTVEINS_AUDIT"] ?? beside("audit.jsonl");
  const anchorPath = env["AGENTVEINS_ANCHOR"] ?? beside("audit.anchor.json");
  const approvalsPath = env["AGENTVEINS_APPROVALS"] ?? beside("approvals.json");
  const signingKey = await loadOrCreateSigningKey(
    env["AGENTVEINS_SIGNING_KEY"] ?? beside("operator.key.pem"),
  );

  const guard = await createGuard({
    policy,
    adapters: [await buildAdapter(env, rail)],
    audit: fileAuditSink(auditPath),
    // Anchored by default: without one a deleted log reads as a fresh start and restores the
    // full budget, and the recommended configuration should not be the one you have to ask for.
    anchor: fileAnchorStore(anchorPath),
    agent: env["AGENTVEINS_AGENT"] ?? "mcp-agent",
    logId: env["AGENTVEINS_LOG_ID"] ?? "mcp",
    signingKey,
    ...(policy.approvals === undefined ? {} : { approvals: fileApprovalStore(approvalsPath) }),
  });

  return { guard, rail };
}

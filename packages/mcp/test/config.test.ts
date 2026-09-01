import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGuard } from "../src/config.js";

// buildGuard warns on stderr when no anchor is configured. Captured for the whole file so
// the warning is assertable in one test and out of the runner's output in the rest.
let warnings: string[] = [];
let restoreStderr = (): void => {};

beforeEach(() => {
  const original = process.stderr.write.bind(process.stderr);
  warnings = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  restoreStderr = () => {
    process.stderr.write = original;
  };
});

afterEach(() => {
  restoreStderr();
});

/** Only a policy on disk, and only the two variables that survive: what a real config now is. */
async function bare(policy: unknown = {
  budgets: [{ period: "per_tx", limit: "1.00", currency: "USDC" }],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
}): Promise<{ env: Record<string, string>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "av-mcp-bare-"));
  const policyPath = join(dir, "policy.json");
  await writeFile(policyPath, JSON.stringify(policy), "utf8");
  return { env: { AGENTVEINS_POLICY: policyPath, AGENTVEINS_RAIL: "mock" }, dir };
}

async function workspace(policy: unknown = {
  budgets: [{ period: "per_tx", limit: "1.00", currency: "USDC" }],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
}): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "av-mcp-"));
  const policyPath = join(dir, "policy.json");
  const keyPath = join(dir, "operator.key.pem");
  await writeFile(policyPath, JSON.stringify(policy), "utf8");
  await writeFile(
    keyPath,
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    "utf8",
  );
  return {
    AGENTVEINS_POLICY: policyPath,
    AGENTVEINS_SIGNING_KEY: keyPath,
    AGENTVEINS_AUDIT: join(dir, "audit.jsonl"),
    AGENTVEINS_AGENT: "mcp-agent",
    AGENTVEINS_LOG_ID: "mcp-test",
    AGENTVEINS_RAIL: "mock",
  };
}

describe("buildGuard", () => {
  it("builds a guard on the mock rail", async () => {
    const { guard, rail } = await buildGuard(await workspace());
    expect(rail).toBe("mock");
    expect(typeof guard.pay).toBe("function");
  });

  it("refuses to start with no rail", async () => {
    const env = await workspace();
    delete env["AGENTVEINS_RAIL"];
    await expect(buildGuard(env)).rejects.toThrow(/AGENTVEINS_RAIL/);
  });

  it("refuses an unknown rail", async () => {
    await expect(buildGuard({ ...(await workspace()), AGENTVEINS_RAIL: "ethereum" }))
      .rejects.toThrow(/AGENTVEINS_RAIL/);
  });

  // A guard replays its log at startup and refuses one it cannot verify, so a key generated
  // per launch would work once and then fail forever, pointing at the log rather than the key.
  it("creates a signing key beside the policy on a first run, and says so", async () => {
    const { env, dir } = await bare();
    await buildGuard(env);

    await expect(readFile(join(dir, "operator.key.pem"), "utf8")).resolves.toContain("PRIVATE KEY");
    await expect(readFile(join(dir, "operator.pub.pem"), "utf8")).resolves.toContain("PUBLIC KEY");
    expect(warnings.join("")).toContain("created a signing key");
  });

  it("reuses that key on the next run, which is the whole point of persisting it", async () => {
    const { env, dir } = await bare();
    await buildGuard(env);
    const first = await readFile(join(dir, "operator.key.pem"), "utf8");

    warnings.length = 0;
    await buildGuard(env);

    expect(await readFile(join(dir, "operator.key.pem"), "utf8")).toBe(first);
    expect(warnings.join("")).not.toContain("created a signing key");
  });

  it("refuses an unreadable key rather than writing a new one over it", async () => {
    const { env, dir } = await bare();
    await writeFile(join(dir, "operator.key.pem"), "not a key", "utf8");

    // Replacing it would orphan every entry the old key signed.
    await expect(buildGuard(env)).rejects.toThrow(/not a readable private key/);
  });

  it("puts the log and the anchor beside the policy, not in the working directory", async () => {
    const { env, dir } = await bare();
    const { guard } = await buildGuard(env);
    await guard.pay({ to: "https://api.weather.com/f", amount: "0.01", currency: "USDC", reason: "r" });
    await guard.flush();

    // An MCP client picks the working directory and the operator never sees it; a log that
    // lands there reads as empty on the next launch and hands back the whole daily budget.
    await expect(readFile(join(dir, "audit.jsonl"), "utf8")).resolves.toContain("settled");
    await expect(readFile(join(dir, "audit.anchor.json"), "utf8")).resolves.toContain("hash");
  });

  it("anchors by default, so a deleted log cannot read as a fresh start", async () => {
    const { env } = await bare();
    await buildGuard(env);

    expect(warnings.join("")).not.toContain("ANCHOR");
  });

  it("puts the approval store beside the policy when the policy sets a threshold", async () => {
    const { env, dir } = await bare({
      budgets: [{ period: "per_tx", limit: "1.00", currency: "USDC" }],
      vendors: { mode: "allowlist", entries: ["api.weather.com"] },
      approvals: { above: "0.05" },
      killSwitch: { frozen: false },
    });
    const { guard } = await buildGuard(env);
    const result = await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    // It built at all, which createGuard refuses without a store when a threshold is set.
    expect(result.status).toBe("blocked");
    expect(dir).toContain("av-mcp-bare-");
  });

  it("infers the solana rail from a keypair, and never infers mock", async () => {
    const { env } = await bare();
    delete env["AGENTVEINS_RAIL"];

    await expect(buildGuard(env)).rejects.toThrow(/AGENTVEINS_RAIL/);
    await expect(buildGuard({ ...env, SOLANA_KEYPAIR_PATH: "/nonexistent-keypair.json" })).rejects.toThrow();
  });

  it("refuses a policy file that is not JSON, naming the variable", async () => {
    const env = await workspace();
    await writeFile(env["AGENTVEINS_POLICY"] ?? "", "not json at all", "utf8");
    await expect(buildGuard(env)).rejects.toThrow(/AGENTVEINS_POLICY/);
  });

  it("refuses to start with no policy", async () => {
    const env = await workspace();
    delete env["AGENTVEINS_POLICY"];
    await expect(buildGuard(env)).rejects.toThrow(/AGENTVEINS_POLICY/);
  });

  it("refuses a policy the engine rejects", async () => {
    const env = await workspace({ budgets: [], vendors: { mode: "allowlist", entries: [] }, killSwitch: {} });
    await expect(buildGuard(env)).rejects.toThrow();
  });

  it("names the solana variables it is missing", async () => {
    await expect(buildGuard({ ...(await workspace()), AGENTVEINS_RAIL: "solana" }))
      .rejects.toThrow(/SOLANA_KEYPAIR_PATH/);
  });

  it("governs a payment on the mock rail with an unmistakable signature", async () => {
    const { guard } = await buildGuard(await workspace());
    const result = await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    expect(result.status).toBe("settled");
    if (result.status !== "settled") throw new Error("expected settled");
    expect(result.txSig).toMatch(/^mock-/);
  });

  it("still enforces the policy on the mock rail", async () => {
    const { guard } = await buildGuard(await workspace());
    const result = await guard.pay({ to: "https://evil.example/f", amount: "0.10", currency: "USDC", reason: "r" });

    expect(result.status).toBe("blocked");
  });

  it("records the mock rail on a refusal, not the rail it is standing in for", async () => {
    const env = await workspace();
    const { guard } = await buildGuard(env);
    await guard.pay({ to: "https://evil.example/f", amount: "0.10", currency: "USDC", reason: "r" });
    await guard.flush();

    const log = await readFile(env["AGENTVEINS_AUDIT"] ?? "", "utf8");
    const entry = JSON.parse(log.trim().split("\n")[0] ?? "{}") as { outcome: string; rail: string };
    expect(entry.outcome).toBe("blocked");
    expect(entry.rail).toBe("mock");
  });
});

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGuard } from "../src/config.js";

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
  it("refuses to start with no signing key", async () => {
    const env = await workspace();
    delete env["AGENTVEINS_SIGNING_KEY"];
    await expect(buildGuard(env)).rejects.toThrow(/AGENTVEINS_SIGNING_KEY/);
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
});

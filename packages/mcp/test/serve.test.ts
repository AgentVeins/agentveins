import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGuard, memoryAuditSink } from "@agentveins/core";
import type { Policy } from "@agentveins/core";
import { describe, expect, it } from "vitest";
import { buildServer, SERVER_VERSION } from "../src/serve.js";

const policy: Policy = {
  budgets: [{ period: "per_tx", limit: "1.00", currency: "USDC" }],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
};

async function connected() {
  const guard = await createGuard({
    policy,
    adapters: [{ name: "solana", currency: "USDC", async execute() { return { txSig: "mock-1", rail: "mock" }; } }],
    audit: memoryAuditSink(),
    agent: "mcp-agent",
    logId: "mcp-test",
    signingKey: generateKeyPairSync("ed25519").privateKey,
  });
  const server = buildServer(guard, "mock");
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("the server", () => {
  // The constant cannot import the manifest — rootDir is src, so package.json is outside the
  // compilation — and a version bump that misses it makes the handshake report a version the
  // package no longer is. The manifest resolves from this file, not from the process cwd.
  it("reports the package's own version", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(SERVER_VERSION).toBe(manifest.version);
  });

  it("advertises the three tools", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check", "pay", "spend_state"]);
  });

  it("pays over the protocol", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "pay",
      arguments: { to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" },
    });
    expect(JSON.stringify(result.content)).toContain("settled");
  });

  it("returns a refusal as a result rather than a protocol error", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "pay",
      arguments: { to: "https://evil.example/f", amount: "0.10", currency: "USDC", reason: "r" },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("vendor_not_allowed");
  });
});

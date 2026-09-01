import { generateKeyPairSync } from "node:crypto";
import { createGuard, memoryApprovalStore, memoryAuditSink } from "@agentveins/core";
import type { Guard, Policy, WalletAdapter } from "@agentveins/core";
import { describe, expect, it } from "vitest";
import { toolDefinitions } from "../src/tools.js";

const policy: Policy = {
  budgets: [
    { period: "per_tx", limit: "1.00", currency: "USDC" },
    { period: "daily", limit: "2.00", currency: "USDC" },
  ],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
};

function adapter(execute?: WalletAdapter["execute"]): WalletAdapter {
  return {
    name: "solana",
    currency: "USDC",
    execute: execute ?? (async () => ({ txSig: "mock-1", rail: "mock" })),
  };
}

async function guardWith(overrides: Partial<Parameters<typeof createGuard>[0]> = {}): Promise<Guard> {
  return createGuard({
    policy,
    adapters: [adapter()],
    audit: memoryAuditSink(),
    agent: "mcp-agent",
    logId: "mcp-test",
    signingKey: generateKeyPairSync("ed25519").privateKey,
    ...overrides,
  });
}

function tool(defs: ReturnType<typeof toolDefinitions>, name: string) {
  const found = defs.find((d) => d.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}

// currency is pinned to the literal so `guard.pay(request)` type-checks directly, without
// widening the rest of the object into readonly literals it doesn't need.
const request = { to: "https://api.weather.com/forecast", amount: "0.10", currency: "USDC" as const, reason: "forecast" };

describe("tools", () => {
  it("exposes exactly pay, check and spend_state", async () => {
    const defs = toolDefinitions(await guardWith(), "mock");
    expect(defs.map((d) => d.name).sort()).toEqual(["check", "pay", "spend_state"]);
  });

  it("settles and reports the signature", async () => {
    const defs = toolDefinitions(await guardWith(), "mock");
    const result = await tool(defs, "pay").handler(request);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("settled");
    expect(result.content[0]?.text).toContain("mock-1");
  });

  // A denial is the system working. Reporting it as a tool error teaches an agent to treat
  // governance as a malfunction and retry against it.
  it("reports a blocked payment as a result, not an error", async () => {
    const defs = toolDefinitions(await guardWith(), "mock");
    const result = await tool(defs, "pay").handler({ ...request, to: "https://evil.example/f" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("blocked");
    expect(result.content[0]?.text).toContain("vendor_not_allowed");
  });

  it("reports a rail failure as an error", async () => {
    const guard = await guardWith({
      adapters: [adapter(async () => { throw new Error("rail down"); })],
    });
    const result = await tool(toolDefinitions(guard, "mock"), "pay").handler(request);

    expect(result.isError).toBe(true);
  });

  it("tells an agent not to retry a payment waiting on a person", async () => {
    const guard = await guardWith({
      policy: { ...policy, approvals: { above: "0.05" } },
      approvals: memoryApprovalStore([]),
    });
    const result = await tool(toolDefinitions(guard, "mock"), "pay").handler(request);

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("approval_required");
    expect(text).toMatch(/do not retry/i);
  });

  it("labels every result on the mock rail", async () => {
    const defs = toolDefinitions(await guardWith(), "mock");
    expect((await tool(defs, "pay").handler(request)).content[0]?.text).toMatch(/mock/i);
  });

  it("does not label results on a real rail", async () => {
    const defs = toolDefinitions(await guardWith(), "solana");
    expect((await tool(defs, "pay").handler(request)).content[0]?.text ?? "").not.toMatch(/no money moved/i);
  });

  it("checks without paying", async () => {
    const guard = await guardWith();
    const defs = toolDefinitions(guard, "mock");
    const result = await tool(defs, "check").handler(request);

    expect(result.content[0]?.text).toContain("allowed");
    expect(guard.state().windows).toEqual({});
  });

  it("reports what a check refuses", async () => {
    const defs = toolDefinitions(await guardWith(), "mock");
    const result = await tool(defs, "check").handler({ ...request, to: "https://evil.example/f" });

    expect(result.content[0]?.text).toContain("vendor_not_allowed");
  });

  it("reports the budgets as strings", async () => {
    const guard = await guardWith();
    await guard.pay(request);
    const result = await tool(toolDefinitions(guard, "mock"), "spend_state").handler({});
    const state = JSON.parse(result.content[0]?.text ?? "{}") as {
      frozen: boolean;
      budgets: Array<{ period: string; limit: string; spent: string; remaining: string }>;
    };

    expect(state.frozen).toBe(false);
    const daily = state.budgets.find((b) => b.period === "daily");
    expect(daily).toEqual({ period: "daily", limit: "2.00", spent: "0.100000", remaining: "1.900000" });
  });

  it("reports a frozen guard", async () => {
    const guard = await guardWith();
    await guard.freeze();
    const result = await tool(toolDefinitions(guard, "mock"), "spend_state").handler({});

    expect((JSON.parse(result.content[0]?.text ?? "{}") as { frozen: boolean }).frozen).toBe(true);
  });
});

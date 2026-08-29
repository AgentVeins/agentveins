import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuard, memoryApprovalStore } from "@agentveins/core";
import { fileAuditSink } from "@agentveins/core/fs";
import type { Policy, WalletAdapter } from "@agentveins/core";
import { describe, expect, it } from "vitest";
import { parseArgs, resolveOptions } from "../src/args.js";
import { run, type Io } from "../src/run.js";

/** The tests drive fully-specified command lines, so no config participates. */
function opts(argv: string[]) {
  return resolveOptions(parseArgs(argv), { config: {}, dir: null, path: null });
}

const now = new Date("2026-08-30T12:00:00.000Z");

function recorder(answers: string[] = []): Io & { text: string } {
  const queued = [...answers];
  return {
    text: "",
    out(text: string): void {
      this.text += text;
    },
    async ask(): Promise<string | null> {
      return queued.shift() ?? null;
    },
    now: () => now,
  };
}

const policy: Policy = {
  budgets: [{ period: "per_tx", limit: "1.00", currency: "USDC" }],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  approvals: { above: "0.05" },
  killSwitch: { frozen: false },
};

const adapter: WalletAdapter = {
  name: "solana",
  currency: "USDC",
  async execute() {
    return { txSig: "sig", rail: "solana" };
  },
};

/** Produces a real signed log holding one payment blocked for approval. */
async function workspace(): Promise<{ log: string; approvals: string; publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), "veins-cli-"));
  const log = join(dir, "audit.jsonl");
  const keys = generateKeyPairSync("ed25519");
  const guard = await createGuard({
    policy,
    adapters: [adapter],
    audit: fileAuditSink(log),
    agent: "weather-agent",
    logId: "cli-test",
    signingKey: keys.privateKey,
    approvals: memoryApprovalStore([]),
  });
  await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "forecast" });
  await guard.flush();

  const publicKey = join(dir, "operator.pub.pem");
  await writeFile(publicKey, keys.publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
  return { log, approvals: join(dir, "approvals.json"), publicKey };
}

describe("veins", () => {
  it("lists what is waiting", async () => {
    const { log, approvals } = await workspace();
    const io = recorder();

    const code = await run(opts(["pending", "--log", log, "--approvals", approvals]), io);

    expect(code).toBe(0);
    expect(io.text).toContain("pending approvals — 1");
    expect(io.text).toContain("weather-agent");
    expect(io.text).toContain("0.100000 USDC");
  });

  it("grants the chosen row and writes it where the guard will look", async () => {
    const { log, approvals } = await workspace();
    const io = recorder(["1", "y"]);

    await run(opts(["approve", "--log", log, "--approvals", approvals, "--ttl", "15m"]), io);

    expect(io.text).toContain("granted");
    const written = JSON.parse(await readFile(approvals, "utf8")) as Array<Record<string, unknown>>;
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      agent: "weather-agent",
      vendorNormalized: "api.weather.com",
      amountMinor: "100000",
      usedAt: null,
    });
  });

  it("grants nothing when the operator declines", async () => {
    const { log, approvals } = await workspace();
    const io = recorder(["1", "n"]);

    await run(opts(["approve", "--log", log, "--approvals", approvals]), io);

    expect(io.text).toContain("nothing granted");
    await expect(readFile(approvals, "utf8")).rejects.toThrow();
  });

  it("grants nothing when there is nobody to ask", async () => {
    const { log, approvals } = await workspace();
    const io = recorder([]);

    await run(opts(["approve", "--log", log, "--approvals", approvals]), io);

    expect(io.text).toContain("nothing granted");
  });

  it("stops showing a payment once it is approved", async () => {
    const { log, approvals } = await workspace();
    await run(opts(["approve", "1", "--yes", "--log", log, "--approvals", approvals]), recorder());

    const io = recorder();
    await run(opts(["pending", "--log", log, "--approvals", approvals]), io);

    expect(io.text).toContain("pending approvals — 0");
    expect(io.text).toContain("nothing is waiting on you");
  });

  it("verifies the log when given a key", async () => {
    const { log, approvals, publicKey } = await workspace();
    const io = recorder();

    await run(opts(["pending", "--log", log, "--approvals", approvals, "--verify", publicKey]), io);

    expect(io.text).toContain("log verified");
  });

  it("refuses to approve against a tampered log", async () => {
    const { log, approvals, publicKey } = await workspace();
    const raw = await readFile(log, "utf8");
    await writeFile(log, raw.replace('"amountMinor":"100000"', '"amountMinor":"1"'), "utf8");

    await expect(
      run(opts(["approve", "--log", log, "--approvals", approvals, "--verify", publicKey]), recorder(["1", "y"])),
    ).rejects.toThrow(/failed verification/);
  });

  it("refuses --yes without a row rather than choosing for the operator", async () => {
    const { log, approvals } = await workspace();

    await expect(
      run(opts(["approve", "--yes", "--log", log, "--approvals", approvals]), recorder()),
    ).rejects.toThrow(/needs a row number/);
  });
});

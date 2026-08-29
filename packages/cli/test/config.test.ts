import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, resolveOptions } from "../src/args.js";
import { loadConfig } from "../src/config.js";

async function workspace(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "veins-config-"));
  await writeFile(join(dir, "veins.config.json"), JSON.stringify(config), "utf8");
  return dir;
}

describe("loadConfig", () => {
  it("finds a config in the directory it starts from", async () => {
    const dir = await workspace({ ttl: "30m" });
    expect((await loadConfig(dir)).config.ttl).toBe("30m");
  });

  it("walks up, so the tool works from anywhere under a service directory", async () => {
    const dir = await workspace({ ttl: "45m" });
    const nested = join(dir, "a", "b");
    await mkdir(nested, { recursive: true });

    const loaded = await loadConfig(nested);
    expect(loaded.config.ttl).toBe("45m");
    expect(loaded.dir).toBe(dir);
  });

  it("reports no config rather than failing when there is none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veins-none-"));
    const loaded = await loadConfig(dir);
    expect(loaded.config).toEqual({});
    expect(loaded.path).toBeNull();
  });

  it("refuses an unknown key instead of ignoring it", async () => {
    const dir = await workspace({ verfiy: "./key.pem" });
    await expect(loadConfig(dir)).rejects.toThrow(/unknown option/);
  });

  it("refuses a non-string value", async () => {
    const dir = await workspace({ ttl: 30 });
    await expect(loadConfig(dir)).rejects.toThrow(/must be a non-empty string/);
  });

  it("refuses malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veins-bad-"));
    await writeFile(join(dir, "veins.config.json"), "{ not json", "utf8");
    await expect(loadConfig(dir)).rejects.toThrow(/not valid JSON/);
  });

  it("refuses an explicit --config that is not there, rather than falling back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veins-missing-"));
    await expect(loadConfig(dir, "./absent.json")).rejects.toThrow(/no config at/);
  });
});

describe("resolveOptions", () => {
  it("takes paths from the config when no flag gives them", async () => {
    const dir = await workspace({ log: "./a.jsonl", approvals: "./b.json", ttl: "1h" });
    const options = resolveOptions(parseArgs(["pending"]), await loadConfig(dir));

    expect(options.log).toBe(join(dir, "a.jsonl"));
    expect(options.approvals).toBe(join(dir, "b.json"));
    expect(options.ttlMs).toBe(3_600_000);
  });

  it("resolves config paths against the config, not the working directory", async () => {
    const dir = await workspace({ log: "./audit.jsonl" });
    const nested = join(dir, "deep");
    await mkdir(nested, { recursive: true });

    // Found by walking up from `nested`; the log still belongs to the directory that declared it.
    const options = resolveOptions(parseArgs(["pending"]), await loadConfig(nested));
    expect(options.log).toBe(join(dir, "audit.jsonl"));
  });

  it("lets a flag beat the config", async () => {
    const dir = await workspace({ log: "./from-config.jsonl", ttl: "1h" });
    const options = resolveOptions(
      parseArgs(["pending", "--log", "./from-flag.jsonl", "--ttl", "5m"]),
      await loadConfig(dir),
    );

    expect(options.log).toBe("./from-flag.jsonl");
    expect(options.ttlMs).toBe(300_000);
  });

  it("keeps an absolute config path as written", async () => {
    const dir = await workspace({ verify: "/etc/pricewatch/operator.pub.pem" });
    const options = resolveOptions(parseArgs(["pending"]), await loadConfig(dir));

    expect(options.verifyKey).toBe("/etc/pricewatch/operator.pub.pem");
  });

  it("falls back to the defaults with no config and no flags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veins-defaults-"));
    const options = resolveOptions(parseArgs(["pending"]), await loadConfig(dir));

    expect(options.log).toBe("./audit.jsonl");
    expect(options.approvals).toBe("./approvals.json");
    expect(options.ttlMs).toBe(900_000);
    expect(options.configPath).toBeNull();
  });

  it("rejects a bad --ttl before anything is read", () => {
    expect(() => parseArgs(["approve", "--ttl", "15"])).toThrow(RangeError);
  });
});

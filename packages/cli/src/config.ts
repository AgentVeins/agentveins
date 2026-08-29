import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

export interface Config {
  log?: string;
  approvals?: string;
  ttl?: string;
  verify?: string;
}

export interface LoadedConfig {
  config: Config;
  /** Where it was found. Relative paths inside resolve against this, never the cwd. */
  dir: string | null;
  path: string | null;
}

const FILENAME = "veins.config.json";
const KEYS = new Set(["log", "approvals", "ttl", "verify"]);

/**
 * An unknown key is refused rather than ignored.
 *
 * A misspelled `verfiy` silently dropped would leave an operator believing every approval was
 * checked against a signed log when none of them were — the exact assurance this tool exists to
 * provide, quietly absent. Failing on a typo costs one correction; ignoring it costs the guarantee.
 */
function validate(raw: unknown, path: string): Config {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SyntaxError(`${path} must contain a JSON object`);
  }
  const config: Config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KEYS.has(key)) {
      throw new SyntaxError(
        `${path} sets unknown option ${JSON.stringify(key)}; known options are ${[...KEYS].join(", ")}`,
      );
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new SyntaxError(`${path}: ${key} must be a non-empty string`);
    }
    config[key as keyof Config] = value;
  }
  return config;
}

async function read(path: string): Promise<Config | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  // Parsed and validated in separate steps: JSON.parse throws SyntaxError too, so catching
  // around both would report a malformed file with whichever message came last and no filename.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyntaxError(`${path} is not valid JSON`);
  }
  return validate(parsed, path);
}

/**
 * Walks up from `from` looking for the config, so an operator can run the tool from anywhere
 * under a service's directory rather than only from its root.
 */
export async function loadConfig(from: string, explicit?: string): Promise<LoadedConfig> {
  if (explicit !== undefined) {
    const path = isAbsolute(explicit) ? explicit : resolvePath(from, explicit);
    const config = await read(path);
    if (config === null) {
      // Silence here would mean running with defaults while believing the file was in force.
      throw new Error(`no config at ${path}`);
    }
    return { config, dir: dirname(path), path };
  }

  let dir = resolvePath(from);
  for (;;) {
    const path = resolvePath(dir, FILENAME);
    const config = await read(path);
    if (config !== null) {
      return { config, dir, path };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return { config: {}, dir: null, path: null };
    }
    dir = parent;
  }
}

/** Resolves a path from the config against the file that declared it. */
export function fromConfigDir(value: string, dir: string | null): string {
  if (dir === null || isAbsolute(value)) {
    return value;
  }
  return resolvePath(dir, value);
}

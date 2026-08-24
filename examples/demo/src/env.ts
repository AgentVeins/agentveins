import { readFile } from "node:fs/promises";
import { URL } from "node:url";

/** The demo package's own `.env`, resolved from this file so the caller's cwd cannot move it. */
const DEFAULT_ENV = new URL("../.env", import.meta.url);

/**
 * A minimal, dependency-free .env reader: KEY=VALUE lines, optional quotes, "#" comments. Only
 * fills in variables the shell has not already set, so a real environment always wins over the
 * file. Silently does nothing when the file is absent, which is every --mock run and every fresh
 * clone before an operator creates one.
 */
export async function loadEnvFile(path: URL | string = DEFAULT_ENV): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Resolves a path read out of the environment. Relative entries in `.env` are written relative to
 * the demo package — `./devnet-keypair.json` sits beside the `.env` that names it — so they must
 * not be left to resolve against whatever directory the process happens to start in.
 */
export function resolveFromPackage(path: string): URL {
  return new URL(path, DEFAULT_ENV);
}

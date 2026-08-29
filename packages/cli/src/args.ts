import { fromConfigDir, type Config, type LoadedConfig } from "./config.js";
import { parseTtl } from "./ttl.js";

/** What the command line actually said. Absent means "not given", so config can supply it. */
export interface ParsedArgs {
  command: "pending" | "approve" | "help";
  log?: string;
  approvals?: string;
  ttl?: string;
  verify?: string;
  config?: string;
  yes: boolean;
  index?: number;
}

export interface Options {
  command: "pending" | "approve" | "help";
  log: string;
  approvals: string;
  ttlMs: number;
  yes: boolean;
  verifyKey?: string;
  index?: number;
  /** Reported so the operator can see which file, if any, shaped this run. */
  configPath: string | null;
}

const DEFAULTS = { log: "./audit.jsonl", approvals: "./approvals.json", ttl: "15m" };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  if (command !== "pending" && command !== "approve" && command !== "help") {
    throw new RangeError(`unknown command ${JSON.stringify(command)}; try: veins help`);
  }

  const parsed: ParsedArgs = { command, yes: false };

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] ?? "";
    if (flag === "--yes" || flag === "-y") {
      parsed.yes = true;
      continue;
    }
    if (/^\d+$/.test(flag)) {
      parsed.index = Number(flag);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new RangeError(`${flag} needs a value`);
    }
    i += 1;
    switch (flag) {
      case "--log":
        parsed.log = value;
        break;
      case "--approvals":
        parsed.approvals = value;
        break;
      case "--ttl":
        parsed.ttl = value;
        break;
      case "--verify":
        parsed.verify = value;
        break;
      case "--config":
        parsed.config = value;
        break;
      default:
        throw new RangeError(`unknown option ${JSON.stringify(flag)}; try: veins help`);
    }
  }

  // Parsed here so a bad --ttl fails before any file is read or any list is printed.
  if (parsed.ttl !== undefined) {
    parseTtl(parsed.ttl);
  }
  return parsed;
}

/**
 * Flags beat the config file, which beats the defaults.
 *
 * Config paths resolve against the file that declared them rather than the cwd: the file is found
 * by walking up, so the same config read from two directories must not point at two different
 * logs. A flag is typed in the moment and resolves against the cwd, which is what the person
 * typing it means.
 */
export function resolveOptions(parsed: ParsedArgs, loaded: LoadedConfig): Options {
  const config: Config = loaded.config;
  const fromConfig = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : fromConfigDir(value, loaded.dir);

  const verifyKey = parsed.verify ?? fromConfig(config.verify);
  const options: Options = {
    command: parsed.command,
    log: parsed.log ?? fromConfig(config.log) ?? DEFAULTS.log,
    approvals: parsed.approvals ?? fromConfig(config.approvals) ?? DEFAULTS.approvals,
    ttlMs: parseTtl(parsed.ttl ?? config.ttl ?? DEFAULTS.ttl),
    yes: parsed.yes,
    configPath: loaded.path,
  };
  if (verifyKey !== undefined) {
    options.verifyKey = verifyKey;
  }
  if (parsed.index !== undefined) {
    options.index = parsed.index;
  }
  return options;
}

export const HELP = `veins — review and approve the payments an AgentVeins guard is holding

  veins pending              list what is waiting on a person
  veins approve              pick one and grant it
  veins approve 2 --yes      grant the second row without prompting
  veins help                 this

Options
  --log <path>         audit log to read      (default ${DEFAULTS.log})
  --approvals <path>   approval store to write (default ${DEFAULTS.approvals})
  --ttl <duration>     how long a grant stands (default ${DEFAULTS.ttl}, max 7d)
  --verify <path>      ed25519 public key (PEM); checks the log's signatures first
  --config <path>      use this config instead of searching
  --yes, -y            skip the confirmation prompt

Config
  A veins.config.json found here or in any parent directory supplies the same
  options, so a service directory can carry its own paths:

    { "log": "./audit.jsonl", "approvals": "./approvals.json",
      "verify": "/etc/pricewatch/operator.pub.pem", "ttl": "30m" }

  Flags beat the file. Relative paths in it resolve against the file itself,
  not your working directory. An unknown key is an error rather than ignored:
  a misspelled "verify" would otherwise leave you believing a log was checked
  when it never was.

Without --verify the log is read but not verified, so this tool trusts a file
it cannot prove is intact. Pass the operator's public key when the decision
matters — approving on the strength of a tampered log is the failure this
project exists to make visible.

An approval authorises one agent, one vendor and one exact amount, once, until
it expires. Granting twice authorises twice.
`;

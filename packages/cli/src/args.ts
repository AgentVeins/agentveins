import { parseTtl } from "./ttl.js";

export interface Options {
  command: "pending" | "approve" | "help";
  log: string;
  approvals: string;
  ttlMs: number;
  /** Grants without prompting. Off by default: the point of this tool is a person deciding. */
  yes: boolean;
  /** Verifies the log's signatures against this public key before trusting what it says. */
  verifyKey?: string;
  index?: number;
}

const DEFAULTS = { log: "./audit.jsonl", approvals: "./approvals.json", ttl: "15m" };

export function parseArgs(argv: readonly string[]): Options {
  const [command = "help", ...rest] = argv;
  if (command !== "pending" && command !== "approve" && command !== "help") {
    throw new RangeError(`unknown command ${JSON.stringify(command)}; try: veins help`);
  }

  const options: Options = {
    command,
    log: DEFAULTS.log,
    approvals: DEFAULTS.approvals,
    ttlMs: parseTtl(DEFAULTS.ttl),
    yes: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] ?? "";
    if (flag === "--yes" || flag === "-y") {
      options.yes = true;
      continue;
    }
    if (/^\d+$/.test(flag)) {
      options.index = Number(flag);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new RangeError(`${flag} needs a value`);
    }
    i += 1;
    switch (flag) {
      case "--log":
        options.log = value;
        break;
      case "--approvals":
        options.approvals = value;
        break;
      case "--ttl":
        options.ttlMs = parseTtl(value);
        break;
      case "--verify":
        options.verifyKey = value;
        break;
      default:
        throw new RangeError(`unknown option ${JSON.stringify(flag)}; try: veins help`);
    }
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
  --yes, -y            skip the confirmation prompt

Without --verify the log is read but not verified, so this tool trusts a file
it cannot prove is intact. Pass the operator's public key when the decision
matters — approving on the strength of a tampered log is the failure this
project exists to make visible.

An approval authorises one agent, one vendor and one exact amount, once, until
it expires. Granting twice authorises twice.
`;

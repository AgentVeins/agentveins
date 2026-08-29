import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { formatAmount, verifyAuditLog } from "@agentveins/core";
import { fileApprovalStore, fileAuditSink } from "@agentveins/core/fs";
import type { ApprovalStore, AuditEntry } from "@agentveins/core";
import { HELP, type Options } from "./args.js";
import { renderPending, safe } from "./format.js";
import { readPending, type PendingApproval } from "./pending.js";

export interface Io {
  out(text: string): void;
  /** Returns the operator's answer, or null when there is no one to ask. */
  ask(question: string): Promise<string | null>;
  now(): Date;
}

async function collect(sink: { read?(): AsyncIterable<AuditEntry> }): Promise<AuditEntry[]> {
  if (sink.read === undefined) {
    return [];
  }
  const entries: AuditEntry[] = [];
  for await (const entry of sink.read()) {
    entries.push(entry);
  }
  return entries;
}

/**
 * Reads the log once and hands back the entries, refusing to continue when a key was supplied
 * and the log does not verify. A tampered log is exactly the situation where an operator must
 * not be shown a tidy list of approvals to wave through.
 */
async function loadEntries(options: Options, io: Io): Promise<AuditEntry[]> {
  const entries = await collect(fileAuditSink(options.log));

  if (options.verifyKey === undefined) {
    return entries;
  }
  const publicKey = createPublicKey(await readFile(options.verifyKey, "utf8"));
  const result = await verifyAuditLog(entries, publicKey);
  if (!result.ok) {
    const where = result.failure === undefined ? "" : ` at seq ${result.failure.seq}`;
    throw new Error(
      `the audit log failed verification${where}: ${result.failure?.reason ?? "unknown"} — refusing to approve against it`,
    );
  }
  io.out(`  log verified — ${result.checked} entries\n`);
  return entries;
}

function describe(item: PendingApproval): string {
  return `${formatAmount(item.amountMinor)} ${item.currency} to ${safe(item.vendorNormalized, 40)} for ${item.agent}`;
}

export async function run(options: Options, io: Io): Promise<number> {
  if (options.command === "help") {
    io.out(HELP);
    return 0;
  }

  if (options.configPath !== null) {
    io.out(`  config ${options.configPath}\n`);
  }
  const approvals: ApprovalStore = fileApprovalStore(options.approvals);
  const entries = await loadEntries(options, io);
  const pending = await readPending(entries, approvals, io.now());

  io.out(`\n  pending approvals — ${pending.length}\n\n`);
  io.out(renderPending(pending, io.now()));

  if (options.command === "pending" || pending.length === 0) {
    return 0;
  }

  const chosen = await choose(options, pending, io);
  if (chosen === null) {
    io.out("  nothing granted\n");
    return 0;
  }

  const expiresAt = new Date(io.now().getTime() + options.ttlMs).toISOString();
  if (!options.yes) {
    const answer = await io.ask(`  approve ${describe(chosen)} until ${expiresAt}? [y/N] `);
    if (answer === null || answer.trim().toLowerCase() !== "y") {
      io.out("  nothing granted\n");
      return 0;
    }
  }

  const granted = await approvals.grant({
    agent: chosen.agent,
    vendorNormalized: chosen.vendorNormalized,
    amountMinor: chosen.amountMinor,
    expiresAt,
  });

  io.out(`\n  granted ${granted.id}\n  ${describe(chosen)}\n  expires ${expiresAt}\n`);
  io.out("  the agent's next attempt on these exact terms will settle, once\n\n");
  return 0;
}

async function choose(
  options: Options,
  pending: PendingApproval[],
  io: Io,
): Promise<PendingApproval | null> {
  if (options.index !== undefined) {
    const chosen = pending[options.index - 1];
    if (chosen === undefined) {
      throw new RangeError(`there is no row ${options.index}; ${pending.length} are pending`);
    }
    return chosen;
  }
  // --yes without a row would pick for the operator. Refusing is the safer half of the ambiguity:
  // it costs a rerun, where guessing costs a payment nobody chose.
  if (options.yes) {
    throw new RangeError("--yes needs a row number, e.g. veins approve 1 --yes");
  }

  const answer = await io.ask(`  approve which? [1-${pending.length}, or blank to cancel] `);
  if (answer === null || answer.trim() === "") {
    return null;
  }
  const index = Number(answer.trim());
  const chosen = Number.isInteger(index) ? pending[index - 1] : undefined;
  if (chosen === undefined) {
    throw new RangeError(`there is no row ${answer.trim()}; ${pending.length} are pending`);
  }
  return chosen;
}

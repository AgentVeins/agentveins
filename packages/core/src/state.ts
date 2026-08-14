import type { AuditEntry, BudgetPeriod, Policy, SpendState } from "./types.js";

const AMOUNT_MINOR_PATTERN = /^\d+$/;

export class CorruptLogError extends Error {
  constructor(
    readonly seq: number,
    message: string,
  ) {
    super(message);
    this.name = "CorruptLogError";
  }
}

export function windowKey(period: BudgetPeriod, now: Date): string {
  if (period !== "daily") {
    return "";
  }
  return now.toISOString().slice(0, 10);
}

export function emptyState(policy: Policy): SpendState {
  return { frozen: policy.killSwitch.frozen, windows: {}, seq: 0, prevHash: "" };
}

export function spentInWindow(state: SpendState, period: BudgetPeriod, now: Date): bigint {
  if (period !== "daily") {
    return 0n;
  }
  const current = state.windows["daily"];
  if (current === undefined || current.start !== windowKey("daily", now)) {
    return 0n;
  }
  return current.spentMinor;
}

export function applyEntry(state: SpendState, entry: AuditEntry): SpendState {
  const next: SpendState = {
    frozen: state.frozen,
    windows: { ...state.windows },
    seq: state.seq + 1,
    prevHash: entry.hash,
  };

  if (entry.kind === "control") {
    if (entry.reason === "freeze") {
      next.frozen = true;
    } else if (entry.reason === "unfreeze") {
      next.frozen = false;
    }
    return next;
  }

  if (entry.outcome !== "settled") {
    return next;
  }

  const parsedTs = new Date(entry.ts);
  if (Number.isNaN(parsedTs.getTime())) {
    throw new CorruptLogError(entry.seq, `entry ${entry.seq} has a malformed ts`);
  }
  if (!AMOUNT_MINOR_PATTERN.test(entry.amountMinor)) {
    throw new CorruptLogError(entry.seq, `entry ${entry.seq} has a malformed amountMinor`);
  }

  const day = windowKey("daily", parsedTs);
  const amount = BigInt(entry.amountMinor);
  const current = next.windows["daily"];
  if (current === undefined || day > current.start) {
    next.windows["daily"] = { start: day, spentMinor: amount };
  } else if (day === current.start) {
    next.windows["daily"] = { start: day, spentMinor: current.spentMinor + amount };
  }

  return next;
}

/**
 * Replays a log into spend state. This performs no verification of the log
 * itself — callers must run the log through `verifyAuditLog` (or an
 * equivalent check) before calling `replay`; a tampered or unsigned entry
 * here silently corrupts spend and frozen state.
 */
export async function replay(
  policy: Policy,
  entries: Iterable<AuditEntry> | AsyncIterable<AuditEntry>,
): Promise<SpendState> {
  let state = emptyState(policy);
  for await (const entry of entries as AsyncIterable<AuditEntry>) {
    state = applyEntry(state, entry);
  }
  return state;
}

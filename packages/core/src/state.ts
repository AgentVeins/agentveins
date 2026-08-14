import type { AuditEntry, BudgetPeriod, Policy, SpendState } from "./types.js";

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
    seq: entry.seq + 1,
    prevHash: entry.hash,
  };

  if (entry.kind === "control") {
    next.frozen = entry.reason === "freeze";
    return next;
  }

  if (entry.outcome !== "settled") {
    return next;
  }

  const day = entry.ts.slice(0, 10);
  const current = next.windows["daily"];
  next.windows["daily"] =
    current !== undefined && current.start === day
      ? { start: day, spentMinor: current.spentMinor + BigInt(entry.amountMinor) }
      : { start: day, spentMinor: BigInt(entry.amountMinor) };

  return next;
}

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

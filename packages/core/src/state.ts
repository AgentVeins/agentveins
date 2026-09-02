import { MAX_VELOCITY_WINDOW_MS } from "./policy.js";
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

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function windowKey(period: BudgetPeriod, now: Date): string {
  if (period !== "daily") {
    return "";
  }
  return `daily:${utcDay(now)}`;
}

export function emptyState(policy: Policy): SpendState {
  return { frozen: policy.killSwitch.frozen, windows: {}, recent: [], seq: 0, prevHash: "" };
}

export function spentInWindow(state: SpendState, period: BudgetPeriod, now: Date): bigint {
  if (period !== "daily") {
    return 0n;
  }
  return state.windows[windowKey("daily", now)]?.spentMinor ?? 0n;
}

export function applyEntry(state: SpendState, entry: AuditEntry): SpendState {
  const next: SpendState = {
    frozen: state.frozen,
    windows: { ...state.windows },
    recent: [...state.recent],
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

  // An `uncertain` payment reached the rail and may have landed, so it consumes budget: a
  // governor that under-counts unproven spend lets an agent re-spend money it already sent.
  if (entry.outcome !== "settled" && entry.outcome !== "uncertain") {
    return next;
  }

  const parsedTs = new Date(entry.ts);
  if (Number.isNaN(parsedTs.getTime())) {
    throw new CorruptLogError(entry.seq, `entry ${entry.seq} has a malformed ts`);
  }
  if (!AMOUNT_MINOR_PATTERN.test(entry.amountMinor)) {
    throw new CorruptLogError(entry.seq, `entry ${entry.seq} has a malformed amountMinor`);
  }

  // Every day owns its own bucket. Accruing into the entry's own day rather than into a single
  // rolling slot is what makes a clock that runs ahead — or an entry that arrives out of order —
  // unable to zero the day being enforced. Key growth is one small record per day the log spent
  // in (a decade of daily payments is well under a thousand), so nothing is evicted: dropping a
  // key would reintroduce exactly the read-returns-zero failure this replaces.
  const key = windowKey("daily", parsedTs);
  const amount = BigInt(entry.amountMinor);
  const current = next.windows[key];
  next.windows[key] = {
    start: utcDay(parsedTs),
    spentMinor: current === undefined ? amount : current.spentMinor + amount,
  };

  // The velocity horizon. Pruned against the newest entry seen rather than the wall clock, so
  // replay stays a pure fold: two replays of one log always produce one state. An out-of-order
  // older entry can therefore never evict newer ones — the horizon only moves forward.
  next.recent.push({ ts: entry.ts, amountMinor: amount });
  let newestMs = 0;
  for (const item of next.recent) {
    const ms = Date.parse(item.ts);
    if (ms > newestMs) {
      newestMs = ms;
    }
  }
  const horizon = newestMs - MAX_VELOCITY_WINDOW_MS;
  next.recent = next.recent.filter((item) => Date.parse(item.ts) >= horizon);

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

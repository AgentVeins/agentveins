import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { sealAnchor, verifyAnchor } from "./audit/anchor.js";
import { hashEntry, signHash, verifyAuditLog } from "./audit/entry.js";
import { CHECKS } from "./checks/index.js";
import { parseAmount } from "./money.js";
import { validatePolicy } from "./policy.js";
import { applyEntry, emptyState, replay } from "./state.js";
import type {
  Anchor, AnchorStore, AuditEntry, AuditOutcome, AuditSink, PayRequest, PayResult, PaymentError,
  Policy, SpendState, UnsignedAuditEntry, Violation, WalletAdapter, WindowState,
} from "./types.js";
import { normalizeVendor } from "./vendor.js";

export interface GuardOptions {
  policy: Policy;
  adapters: WalletAdapter[];
  audit: AuditSink;
  agent: string;
  signingKey: KeyObject;
  logId?: string;
  verifyingKey?: KeyObject;
  anchor?: AnchorStore;
  requirePersistedState?: boolean;
  now?: () => Date;
}

export interface Guard {
  pay(req: PayRequest): Promise<PayResult>;
  freeze(): Promise<void>;
  unfreeze(): Promise<void>;
  state(): SpendState;
}

interface WriteInput {
  kind: "payment" | "control";
  vendor: string;
  vendorNormalized: string;
  amountMinor: bigint;
  reason: string;
  outcome: AuditOutcome;
  violation: Violation | null;
  txSig: string | null;
  rail: string | null;
  ts: Date;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPaymentError(error: unknown): PaymentError {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (code === "price_mismatch" || code === "insufficient_funds" || code === "timeout") {
      return { code, message: messageOf(error) };
    }
  }
  return { code: "adapter_error", message: messageOf(error) };
}

function snapshot(state: SpendState): SpendState {
  const windows: Record<string, WindowState> = {};
  for (const [key, window] of Object.entries(state.windows)) {
    windows[key] = { ...window };
  }
  return { frozen: state.frozen, windows, seq: state.seq, prevHash: state.prevHash };
}

export async function createGuard(options: GuardOptions): Promise<Guard> {
  validatePolicy(options.policy);
  if (!Array.isArray(options.adapters) || options.adapters.length === 0) {
    throw new RangeError("createGuard requires at least one adapter");
  }
  if (typeof options.agent !== "string" || options.agent.trim() === "") {
    throw new RangeError("createGuard requires a non-empty agent name");
  }
  if (options.logId !== undefined && (typeof options.logId !== "string" || options.logId.trim() === "")) {
    throw new RangeError("logId must be a non-empty string");
  }
  if (options.audit === null || typeof options.audit !== "object" || typeof options.audit.append !== "function") {
    throw new TypeError("createGuard requires an audit sink with an append function");
  }

  const { policy, adapters, audit, agent, signingKey } = options;
  const anchorStore = options.anchor;
  const verifyingKey = options.verifyingKey ?? createPublicKey(signingKey);
  const clock = options.now ?? (() => new Date());
  const readLog = audit.read?.bind(audit);

  if (options.requirePersistedState === true && readLog === undefined) {
    throw new RangeError("the audit sink cannot replay entries, so budgets would reset on restart");
  }
  if (anchorStore !== undefined && readLog === undefined) {
    throw new RangeError("an anchor store needs an audit sink that can replay entries, or truncation goes undetected");
  }

  let observedLogId: string | undefined;
  async function* observing(entries: AsyncIterable<AuditEntry>): AsyncIterable<AuditEntry> {
    for await (const entry of entries) {
      observedLogId ??= entry.logId;
      yield entry;
    }
  }

  let state: SpendState;
  let anchorRecord: Anchor | null = null;
  if (readLog === undefined) {
    state = emptyState(policy);
  } else {
    anchorRecord = anchorStore === undefined ? null : await anchorStore.read();
    if (anchorRecord !== null) {
      if (!verifyAnchor(anchorRecord, verifyingKey)) {
        throw new Error("the audit anchor carries an invalid signature; refusing to start");
      }
      if (options.logId !== undefined && anchorRecord.logId !== options.logId) {
        throw new Error(`the audit anchor belongs to log ${anchorRecord.logId}, not ${options.logId}; refusing to start`);
      }
    }

    const expectedLogId = options.logId ?? anchorRecord?.logId;
    const verification = await verifyAuditLog(observing(readLog()), verifyingKey, {
      logId: expectedLogId,
      anchor: anchorRecord ?? undefined,
    });
    if (!verification.ok) {
      const failure = verification.failure;
      throw new Error(
        `the audit log failed verification at seq ${failure?.seq ?? verification.checked}: ${failure?.reason ?? "unknown"}; refusing to start`,
      );
    }
    // An AnchorStore reports "deleted", "emptied", and "never existed" identically, so a
    // non-empty log with no anchor is treated as tampering rather than as a first run.
    if (anchorStore !== undefined && anchorRecord === null && verification.checked > 0) {
      throw new Error("the audit log has entries but no anchor; refusing to start");
    }

    state = await replay(policy, readLog());
  }

  // Freezing is sticky from either source: a policy that says frozen cannot be cleared by a
  // logged unfreeze, and a policy that says unfrozen cannot clear a freeze an operator logged.
  state = { ...state, frozen: policy.killSwitch.frozen || state.frozen };

  const logId = options.logId ?? anchorRecord?.logId ?? observedLogId ?? randomUUID();

  // Payments are serialized so two concurrent calls cannot both pass the same budget check.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function write(input: WriteInput): Promise<string> {
    const unsignedEntry: UnsignedAuditEntry = {
      id: randomUUID(),
      logId,
      seq: state.seq,
      ts: input.ts.toISOString(),
      kind: input.kind,
      agent,
      vendor: input.vendor,
      vendorNormalized: input.vendorNormalized,
      rail: input.rail,
      amountMinor: input.amountMinor.toString(),
      currency: "USDC",
      reason: input.reason,
      outcome: input.outcome,
      violation: input.violation,
      txSig: input.txSig,
      prevHash: state.prevHash,
    };
    const hash = hashEntry(unsignedEntry);
    const entry: AuditEntry = { ...unsignedEntry, hash, sig: signHash(hash, signingKey) };

    await audit.append(entry);
    state = applyEntry(state, entry);
    // The anchor lands after the append: an anchor ahead of the log reads as truncation,
    // whereas an anchor behind it is a benign stale floor.
    if (anchorStore !== undefined) {
      await anchorStore.write(sealAnchor({ logId, seq: entry.seq, hash: entry.hash }, signingKey));
    }
    return entry.id;
  }

  function pickAdapter(via: string | undefined): WalletAdapter {
    if (via === undefined) {
      return adapters[0]!;
    }
    const adapter = adapters.find((candidate) => candidate.name === via);
    if (adapter === undefined) {
      throw new RangeError(`no adapter named ${via} is registered`);
    }
    return adapter;
  }

  function readClock(): Date {
    const value = clock();
    return value instanceof Date ? value : new Date(Number.NaN);
  }

  async function runPayment(req: PayRequest): Promise<PayResult> {
    const ts = readClock();
    // A broken clock cannot block the audit write, so the entry falls back to system time
    // while the request itself fails soft below.
    const auditTs = Number.isNaN(ts.getTime()) ? new Date() : ts;
    const fields = (typeof req === "object" && req !== null ? req : {}) as Partial<PayRequest>;

    let amountMinor: bigint;
    let vendorNormalized: string;
    let adapter: WalletAdapter;
    try {
      if (Number.isNaN(ts.getTime())) {
        throw new RangeError("the clock returned an invalid Date");
      }
      if (req.currency !== "USDC") {
        throw new RangeError(`unsupported currency: ${String(req.currency)}`);
      }
      if (typeof req.reason !== "string") {
        throw new TypeError("reason must be a string");
      }
      amountMinor = parseAmount(req.amount);
      if (amountMinor <= 0n) {
        throw new RangeError(`amount must be greater than zero, received: ${req.amount}`);
      }
      vendorNormalized = normalizeVendor(req.to);
      adapter = pickAdapter(req.via);
    } catch (error) {
      const violation: Violation = { code: "invalid_request", message: messageOf(error) };
      const auditId = await write({
        kind: "payment",
        vendor: typeof fields.to === "string" ? fields.to : "",
        vendorNormalized: "",
        amountMinor: 0n,
        reason: typeof fields.reason === "string" ? fields.reason : "",
        outcome: "blocked",
        violation,
        txSig: null,
        rail: null,
        ts: auditTs,
      });
      return { status: "blocked", violation, auditId };
    }

    const ctx = {
      vendor: req.to,
      vendorNormalized,
      amountMinor,
      currency: req.currency,
      reason: req.reason,
      now: ts,
    };

    // A check that throws is a policy problem, not an exception the agent should catch:
    // payment-time failures return violations.
    let violation: Violation | null = null;
    try {
      for (const check of CHECKS) {
        violation = check(ctx, policy, state);
        if (violation !== null) {
          break;
        }
      }
    } catch (error) {
      violation = { code: "invalid_request", message: `the policy could not be evaluated: ${messageOf(error)}` };
    }

    if (violation !== null) {
      const auditId = await write({
        kind: "payment", vendor: req.to, vendorNormalized, amountMinor,
        reason: req.reason, outcome: "blocked", violation,
        txSig: null, rail: adapter.name, ts: auditTs,
      });
      return { status: "blocked", violation, auditId };
    }

    try {
      const receipt = await adapter.execute({ to: req.to, amountMinor, reason: req.reason });
      if (receipt === null || typeof receipt !== "object" || typeof receipt.txSig !== "string" || receipt.txSig === "") {
        throw new TypeError(`adapter ${adapter.name} returned no transaction signature`);
      }
      const auditId = await write({
        kind: "payment", vendor: req.to, vendorNormalized, amountMinor,
        reason: req.reason, outcome: "settled", violation: null,
        txSig: receipt.txSig, rail: typeof receipt.rail === "string" ? receipt.rail : adapter.name,
        ts: auditTs,
      });
      return { status: "settled", txSig: receipt.txSig, auditId };
    } catch (error) {
      const paymentError = toPaymentError(error);
      const auditId = await write({
        kind: "payment", vendor: req.to, vendorNormalized, amountMinor,
        reason: req.reason, outcome: "failed", violation: null,
        txSig: null, rail: adapter.name, ts: auditTs,
      });
      return { status: "failed", error: paymentError, auditId };
    }
  }

  async function setFrozen(action: "freeze" | "unfreeze"): Promise<void> {
    const ts = readClock();
    await write({
      kind: "control", vendor: "", vendorNormalized: "", amountMinor: 0n,
      reason: action, outcome: "settled", violation: null,
      txSig: null, rail: null, ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
    });
  }

  return {
    pay: (req) => serialize(() => runPayment(req)),
    freeze: () => serialize(() => setFrozen("freeze")),
    unfreeze: () => serialize(() => setFrozen("unfreeze")),
    state: () => snapshot(state),
  };
}

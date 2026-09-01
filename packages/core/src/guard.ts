import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { decideApproval, type ApprovalDecision } from "./approvals/decide.js";
import { sealAnchor, verifyAnchor } from "./audit/anchor.js";
import { hashEntry, signHash, verifyAuditLog } from "./audit/entry.js";
import { CHECKS, killSwitchCheck } from "./checks/index.js";
import { InvalidRequestError } from "./errors.js";
import { formatAmount, parseAmount } from "./money.js";
import { validatePolicy } from "./policy.js";
import { sanitizePaymentError, sanitizeSignature, sanitizeViolation } from "./sanitize.js";
import { applyEntry, emptyState, replay } from "./state.js";
import type {
  Anchor, AnchorStore, Approval, ApprovalStore, AuditEntry, AuditOutcome, AuditSink, CheckResult,
  PayRequest, PayResult, PaymentContext, PaymentError, Policy, SpendState, UnsignedAuditEntry,
  Violation, WalletAdapter, WindowState,
} from "./types.js";
import { normalizeVendor } from "./vendor.js";

export interface GuardOptions {
  policy: Policy;
  adapters: WalletAdapter[];
  audit: AuditSink;
  agent: string;
  logId: string;
  signingKey: KeyObject;
  verifyingKey?: KeyObject;
  anchor?: AnchorStore;
  approvals?: ApprovalStore;
  requirePersistedState?: boolean;
  now?: () => Date;
}

export interface Guard {
  pay(req: PayRequest): Promise<PayResult>;
  /**
   * Evaluates a payment without making it: no rail call, no audit entry, no budget consumed,
   * and no approval consumed. Deliberately not serialized — `pay` runs through one queue that
   * may be waiting on a slow rail, and an advisory read must not wait behind it.
   */
  check(req: PayRequest): Promise<CheckResult>;
  /**
   * Closes the kill switch. It resolves as soon as the switch is closed — every later `pay`
   * is already blocked — while the control entry it appends is written behind whatever
   * payment was in flight. Await `flush` to know that entry reached the sink.
   */
  freeze(): Promise<void>;
  unfreeze(): Promise<void>;
  state(): SpendState;
  /** Resolves once every queued payment and control write has finished. */
  flush(): Promise<void>;
}

interface WriteInput {
  kind: "payment" | "control";
  vendor: string;
  vendorNormalized: string;
  amountMinor: bigint;
  reason: string;
  outcome: AuditOutcome;
  violation: Violation | null;
  error: PaymentError | null;
  txSig: string | null;
  rail: string | null;
  ts: Date;
  applyWhenUnrecorded: boolean;
}

interface WriteOutcome {
  id: string;
  recorded: boolean;
}

type Prepared =
  | { ok: false; violation: Violation }
  | {
      ok: true;
      amountMinor: bigint;
      vendorNormalized: string;
      adapter: WalletAdapter;
      ctx: PaymentContext;
    };

interface Evaluated {
  violation: Violation | null;
  approvalThreshold: bigint | null;
}

const AUDIT_UNAVAILABLE_MESSAGE =
  "the audit log cannot be written, so no payment can be authorized";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// An adapter that broadcast a transaction it could not confirm reports the signature on
// `unconfirmedSignature`. The name is the contract: an error that merely knows a signature —
// a cluster rejection, say — must not set it, because that money never moved.
function toPaymentError(error: unknown): PaymentError {
  const fields = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    unconfirmedSignature?: unknown;
  };
  const code = fields.code;
  const known =
    code === "price_mismatch" ||
    code === "recipient_not_allowed" ||
    code === "insufficient_funds" ||
    code === "timeout";
  const paymentError: PaymentError = {
    code: known ? code : "adapter_error",
    message: messageOf(error),
  };
  const txSig = sanitizeSignature(fields.unconfirmedSignature);
  if (txSig !== undefined) {
    paymentError.txSig = txSig;
  }
  return sanitizePaymentError(paymentError);
}

function invalidRequest(error: unknown): Violation {
  const violation: Violation =
    error instanceof InvalidRequestError && Object.keys(error.detail).length > 0
      ? { code: "invalid_request", message: error.message, detail: error.detail }
      : { code: "invalid_request", message: messageOf(error) };
  return sanitizeViolation(violation);
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
  if (typeof options.logId !== "string" || options.logId.trim() === "") {
    throw new RangeError("createGuard requires a non-empty logId that names this agent's audit log");
  }
  if (options.audit === null || typeof options.audit !== "object" || typeof options.audit.append !== "function") {
    throw new TypeError("createGuard requires an audit sink with an append function");
  }
  if (options.signingKey === null || typeof options.signingKey !== "object" || options.signingKey.type !== "private") {
    throw new TypeError("signingKey must be a private KeyObject; audit entries cannot be signed without one");
  }
  if (options.verifyingKey !== undefined && options.verifyingKey.type !== "public") {
    throw new TypeError("verifyingKey must be a public KeyObject");
  }
  if (options.policy.approvals !== undefined && options.approvals === undefined) {
    throw new RangeError(
      "policy.approvals sets a threshold but no approval store was supplied; every payment above it would block with no way to approve one",
    );
  }

  const { policy, adapters, audit, agent, logId, signingKey } = options;
  const anchorStore = options.anchor;
  const approvalStore = options.approvals;
  const verifyingKey = options.verifyingKey ?? createPublicKey(signingKey);
  const clock = options.now ?? (() => new Date());
  const readLog = audit.read?.bind(audit);

  if (options.requirePersistedState === true && readLog === undefined) {
    throw new RangeError("the audit sink cannot replay entries, so budgets would reset on restart");
  }
  if (anchorStore !== undefined && readLog === undefined) {
    throw new RangeError("an anchor store needs an audit sink that can replay entries, or truncation goes undetected");
  }

  // The log names the agent it governs: replaying another agent's log would import its spend
  // and its frozen state. The foreign name never travels into the message.
  async function* enforceAgent(entries: AsyncIterable<AuditEntry>): AsyncIterable<AuditEntry> {
    for await (const entry of entries) {
      if (entry.agent !== agent) {
        throw new Error(`the audit log entry at seq ${entry.seq} belongs to a different agent; refusing to start`);
      }
      yield entry;
    }
  }

  let state: SpendState;
  if (readLog === undefined) {
    state = emptyState(policy);
  } else {
    const anchorRecord: Anchor | null = anchorStore === undefined ? null : await anchorStore.read();
    if (anchorRecord !== null) {
      if (!verifyAnchor(anchorRecord, verifyingKey)) {
        throw new Error("the audit anchor carries an invalid signature; refusing to start");
      }
      if (anchorRecord.logId !== logId) {
        throw new Error(`the audit anchor belongs to log ${anchorRecord.logId}, not ${logId}; refusing to start`);
      }
    }

    const verification = await verifyAuditLog(enforceAgent(readLog()), verifyingKey, {
      logId,
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

  // A guard that cannot record cannot authorize: once an append or an anchor write fails, the
  // latch stays closed and every later payment is blocked before it reaches an adapter.
  let auditBroken = false;

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

  // Recording an attempt never throws; it latches instead, so a sink failure can neither
  // reject a payment that settled nor relabel it.
  async function write(input: WriteInput): Promise<WriteOutcome> {
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
      error: input.error,
      txSig: input.txSig,
      prevHash: state.prevHash,
    };
    const hash = hashEntry(unsignedEntry);
    const entry: AuditEntry = { ...unsignedEntry, hash, sig: signHash(hash, signingKey) };

    // Appending onto an already-broken chain would corrupt verification for good, so a latched
    // guard records nothing further and only carries the effect in memory.
    if (!auditBroken) {
      try {
        await audit.append(entry);
      } catch {
        auditBroken = true;
      }
    }

    if (auditBroken) {
      if (input.applyWhenUnrecorded) {
        state = applyEntry(state, entry);
      }
      return { id: entry.id, recorded: false };
    }

    state = applyEntry(state, entry);
    // The anchor lands after the append: an anchor ahead of the log reads as truncation,
    // whereas an anchor behind it is a benign stale floor.
    if (anchorStore !== undefined) {
      try {
        await anchorStore.write(sealAnchor({ logId, seq: entry.seq, hash: entry.hash }, signingKey));
      } catch {
        auditBroken = true;
      }
    }
    return { id: entry.id, recorded: true };
  }

  function pickAdapter(via: string | undefined): WalletAdapter {
    if (via === undefined) {
      return adapters[0]!;
    }
    const adapter = adapters.find((candidate) => candidate.name === via);
    if (adapter === undefined) {
      throw new InvalidRequestError("no adapter with that name is registered", { via });
    }
    return adapter;
  }

  function readClock(): Date {
    const value = clock();
    return value instanceof Date ? value : new Date(Number.NaN);
  }

  // Request validation, lifted out of runPayment so `check` runs exactly the same admission
  // rules as `pay` rather than a second implementation of them.
  function prepare(req: PayRequest, ts: Date): Prepared {
    try {
      if (Number.isNaN(ts.getTime())) {
        throw new RangeError("the clock returned an invalid Date");
      }
      if (req.currency !== "USDC") {
        throw new InvalidRequestError("unsupported currency", { currency: String(req.currency) });
      }
      if (typeof req.reason !== "string") {
        throw new TypeError("reason must be a string");
      }
      const amountMinor = parseAmount(req.amount);
      if (amountMinor <= 0n) {
        throw new InvalidRequestError("amount must be greater than zero", { amount: req.amount });
      }
      const vendorNormalized = normalizeVendor(req.to);
      const adapter = pickAdapter(req.via);
      return {
        ok: true,
        amountMinor,
        vendorNormalized,
        adapter,
        ctx: {
          vendor: req.to,
          vendorNormalized,
          amountMinor,
          currency: req.currency,
          reason: req.reason,
          now: ts,
        },
      };
    } catch (error) {
      return { ok: false, violation: invalidRequest(error) };
    }
  }

  // A check that throws is a policy problem, not an exception the agent should catch:
  // payment-time failures return violations. The approval threshold is parsed inside the same
  // guarded read, so a malformed policy blocks rather than throwing out of `pay` or `check`.
  function evaluateChecks(ctx: PaymentContext): Evaluated {
    let violation: Violation | null = null;
    let approvalThreshold: bigint | null = null;
    try {
      for (const check of CHECKS) {
        violation = check(ctx, policy, state);
        if (violation !== null) {
          break;
        }
      }
      if (violation === null && policy.approvals !== undefined) {
        approvalThreshold = parseAmount(policy.approvals.above);
      }
    } catch (error) {
      violation = {
        code: "invalid_request",
        message: `the policy could not be evaluated: ${messageOf(error)}`,
      };
    }
    return { violation, approvalThreshold };
  }

  async function runCheck(req: PayRequest): Promise<CheckResult> {
    if (auditBroken) {
      return {
        status: "blocked",
        violation: sanitizeViolation({ code: "audit_unavailable", message: AUDIT_UNAVAILABLE_MESSAGE }),
      };
    }

    const prepared = prepare(req, readClock());
    if (!prepared.ok) {
      return { status: "blocked", violation: sanitizeViolation(prepared.violation) };
    }

    const { violation, approvalThreshold } = evaluateChecks(prepared.ctx);
    if (violation !== null) {
      return { status: "blocked", violation: sanitizeViolation(violation) };
    }

    if (approvalThreshold === null || prepared.amountMinor <= approvalThreshold) {
      return { status: "allowed" };
    }
    if (approvalStore === undefined || policy.approvals === undefined) {
      return {
        status: "blocked",
        violation: sanitizeViolation({
          code: "approval_unavailable",
          message: "no approval store is configured",
        }),
      };
    }

    const key = {
      agent,
      vendorNormalized: prepared.vendorNormalized,
      amountMinor: prepared.amountMinor,
    };
    let found: Approval | null;
    try {
      found = await approvalStore.find(key);
    } catch {
      return {
        status: "blocked",
        violation: sanitizeViolation({
          code: "approval_unavailable",
          message: "the approval store could not be reached",
        }),
      };
    }

    // The store lookup above is the only await in this branch, so the switch is re-read here:
    // a freeze landing while it was in flight must still block, matching what `pay` does after
    // its own awaits.
    const frozen = killSwitchCheck(prepared.ctx, policy, state);
    if (frozen !== null) {
      return { status: "blocked", violation: sanitizeViolation(frozen) };
    }

    // find, never consume: a dry run must not cost a person's decision.
    const decision = decideApproval(found, key, prepared.ctx.now);
    // A grant with no id has nothing to spend, so it is not honoured, matching `pay`.
    if (decision !== "grant" || found === null || found.id === "") {
      return {
        status: "blocked",
        violation: sanitizeViolation({
          code: "approval_required",
          message: "this payment is above the approval threshold and needs a human approval",
          detail: {
            threshold: policy.approvals.above,
            attempted: formatAmount(prepared.amountMinor),
            reason: decision === "grant" ? "missing" : decision,
          },
        }),
      };
    }
    return { status: "allowed" };
  }

  async function runPayment(req: PayRequest): Promise<PayResult> {
    if (auditBroken) {
      // No audit id: the attempt could not be recorded, which is exactly why it was blocked.
      return {
        status: "blocked",
        violation: { code: "audit_unavailable", message: AUDIT_UNAVAILABLE_MESSAGE },
        auditId: "",
      };
    }

    const ts = readClock();
    // A broken clock cannot block the audit write, so the entry falls back to system time
    // while the request itself fails soft below.
    const auditTs = Number.isNaN(ts.getTime()) ? new Date() : ts;
    const fields = (typeof req === "object" && req !== null ? req : {}) as Partial<PayRequest>;

    const prepared = prepare(req, ts);
    if (!prepared.ok) {
      const violation = prepared.violation;
      const outcome = await write({
        kind: "payment",
        vendor: typeof fields.to === "string" ? fields.to : "",
        vendorNormalized: "",
        amountMinor: 0n,
        reason: typeof fields.reason === "string" ? fields.reason : "",
        outcome: "blocked",
        violation,
        error: null,
        txSig: null,
        rail: null,
        ts: auditTs,
        applyWhenUnrecorded: true,
      });
      return { status: "blocked", violation, auditId: outcome.id };
    }
    const { amountMinor, vendorNormalized, adapter, ctx } = prepared;

    const { violation, approvalThreshold } = evaluateChecks(ctx);

    // Every refusal crosses this one boundary, so a check that puts an untrusted vendor in
    // `detail` and the guard's own request errors are bounded and de-escaped identically.
    const block = async (raw: Violation): Promise<PayResult> => {
      const safe = sanitizeViolation(raw);
      const outcome = await write({
        kind: "payment", vendor: req.to, vendorNormalized, amountMinor,
        reason: req.reason, outcome: "blocked", violation: safe, error: null,
        txSig: null, rail: adapter.name, ts: auditTs, applyWhenUnrecorded: true,
      });
      return { status: "blocked", violation: safe, auditId: outcome.id };
    };

    if (violation !== null) {
      return block(violation);
    }

    // Approval runs after the checks and never as one of them: `Check` is synchronous and pure,
    // which is why the policy suite needs no I/O, and a store lookup is I/O. It runs last because
    // asking a person to rule on a payment the budget already forbids is asking the wrong
    // question.
    if (
      policy.approvals !== undefined &&
      approvalStore !== undefined &&
      approvalThreshold !== null &&
      amountMinor > approvalThreshold
    ) {
      const key = { agent, vendorNormalized, amountMinor };
      let decision: ApprovalDecision;
      let approvalId: string | null = null;
      try {
        const found = await approvalStore.find(key);
        decision = decideApproval(found, key, ts);
        approvalId = found === null ? null : found.id;
      } catch {
        // Unlike the audit sink this does not latch: only payments above the threshold are
        // affected, and everything below stays governed by the checks that already ran.
        return block({
          code: "approval_unavailable",
          message: "the approval store could not be reached, so this payment cannot be authorized",
        });
      }

      // A grant with no id has nothing to spend, so it is not honoured.
      if (decision !== "grant" || approvalId === null) {
        return block({
          code: "approval_required",
          message: "this payment is above the approval threshold and needs a human approval",
          detail: {
            threshold: policy.approvals.above,
            attempted: formatAmount(amountMinor),
            reason: decision === "grant" ? "missing" : decision,
          },
        });
      }

      try {
        // Before the rail, never after: a crash between broadcast and consume would leave the
        // approval unspent and let the agent replay a payment a person sanctioned once. The
        // cost is that a rail failure burns it and the person is asked again.
        await approvalStore.consume(approvalId);
      } catch {
        // A peer that won the race and a broken store are indistinguishable from here, so the
        // guard asserts neither: signing "a human's approval was already spent" into the audit
        // log would make that claim permanent and it may be false.
        return block({
          code: "approval_unavailable",
          message: "the approval could not be claimed, so this payment cannot be authorized",
        });
      }
    }

    // The approval gate holds the first awaits between the kill-switch check and the rail, so
    // the switch is re-read here: a freeze landing during a slow store call must still stop the
    // broadcast. An approval consumed a moment ago stays consumed — the guard rounds against
    // the agent here as everywhere else, and the person is asked again.
    const frozen = killSwitchCheck(ctx, policy, state);
    if (frozen !== null) {
      return block(frozen);
    }

    // The rail call owns this try and nothing else: a failure to record the result must never
    // be reported as a failure to pay.
    let txSig: string;
    let rail: string;
    try {
      const receipt = await adapter.execute({
        to: req.to,
        amountMinor,
        reason: req.reason,
        ...(policy.recipients === undefined ? {} : { allowedRecipients: policy.recipients.entries }),
      });
      if (receipt === null || typeof receipt !== "object" || typeof receipt.txSig !== "string" || receipt.txSig === "") {
        throw new TypeError(`adapter ${adapter.name} returned no transaction signature`);
      }
      txSig = receipt.txSig;
      rail = typeof receipt.rail === "string" ? receipt.rail : adapter.name;
    } catch (error) {
      const paymentError = toPaymentError(error);
      // A rail that broadcast without confirming leaves the money's fate unknown, so the log
      // records `uncertain` with the signature to reconcile against, and the amount consumes
      // budget. Reporting `failed` while spending nothing would let the agent send it twice.
      const unconfirmed = paymentError.txSig !== undefined;
      const outcome = await write({
        kind: "payment", vendor: req.to, vendorNormalized, amountMinor,
        reason: req.reason, outcome: unconfirmed ? "uncertain" : "failed", violation: null,
        error: paymentError, txSig: paymentError.txSig ?? null,
        rail: adapter.name, ts: auditTs, applyWhenUnrecorded: true,
      });
      return { status: "failed", error: paymentError, auditId: outcome.id };
    }

    // The money moved. Recording it can fail and latch the guard, but the caller still learns
    // the payment settled — an agent that never hears about a settlement retries it.
    const settlement = await write({
      kind: "payment", vendor: req.to, vendorNormalized, amountMinor,
      reason: req.reason, outcome: "settled", violation: null, error: null,
      txSig, rail, ts: auditTs, applyWhenUnrecorded: true,
    });
    return { status: "settled", txSig, auditId: settlement.id };
  }

  async function setFrozen(action: "freeze" | "unfreeze"): Promise<void> {
    if (action === "unfreeze" && policy.killSwitch.frozen) {
      throw new Error("the policy freezes this agent; change policy.killSwitch.frozen to lift it");
    }
    const ts = readClock();
    // A freeze that cannot be recorded still takes effect, and an unfreeze that cannot be
    // recorded does not: the kill switch always fails toward the more restrictive state.
    await write({
      kind: "control", vendor: "", vendorNormalized: "", amountMinor: 0n,
      reason: action, outcome: "settled", violation: null, error: null,
      txSig: null, rail: null, ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
      applyWhenUnrecorded: action === "freeze",
    });
  }

  return {
    pay: (req) => serialize(() => runPayment(req)),
    check: runCheck,
    // The kill switch closes before it is written, not after: queuing the flag behind an
    // in-flight payment would bound an emergency stop by the rail's slowest call. Only the
    // control entry's write is serialized, so it still lands in chain order. Unfreezing stays
    // fully queued — the switch may snap shut out of turn, never open out of turn.
    freeze: async () => {
      state = { ...state, frozen: true };
      void serialize(() => setFrozen("freeze")).catch(() => undefined);
    },
    unfreeze: () => serialize(() => setFrozen("unfreeze")),
    state: () => snapshot(state),
    flush: () => serialize(async () => undefined),
  };
}

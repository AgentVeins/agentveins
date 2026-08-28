export type Currency = "USDC";
export type BudgetPeriod = "per_tx" | "daily";

export interface Budget {
  period: BudgetPeriod;
  limit: string;
  currency: Currency;
}

export interface VendorPolicy {
  mode: "allowlist";
  entries: string[];
}

export interface RecipientPolicy {
  mode: "allowlist";
  entries: string[];
}

export interface ApprovalPolicy {
  /** Payments strictly greater than this need a human approval. Minor-unit string, e.g. "5.00". */
  above: string;
}

/** The exact terms a human approved. An approval authorises these terms and nothing else. */
export interface ApprovalKey {
  agent: string;
  vendorNormalized: string;
  amountMinor: bigint;
}

export interface Approval extends ApprovalKey {
  id: string;
  /** ISO 8601. Compared against the guard's clock, not the wall clock. */
  expiresAt: string;
  /** ISO 8601 once spent, null while unspent. */
  usedAt: string | null;
}

export interface ApprovalStore {
  /** Matches on the key alone. Expiry and prior use are the guard's to judge. */
  find(key: ApprovalKey): Promise<Approval | null>;
  /** Atomic. Throws if this approval was already consumed. */
  consume(id: string): Promise<void>;
}

export interface KillSwitch {
  frozen: boolean;
}

export interface Policy {
  budgets: Budget[];
  vendors: VendorPolicy;
  /**
   * The destinations an adapter may pay. The vendor allowlist governs who is asked for a price;
   * this governs who ends up holding the money, which on a quoted rail like x402 is not the same
   * question. Omitting it leaves the recipient ungoverned: an allowlisted endpoint that has been
   * compromised can name any destination at or under the approved amount.
   */
  recipients?: RecipientPolicy;
  approvals?: ApprovalPolicy;
  killSwitch: KillSwitch;
}

export type ViolationCode =
  | "kill_switch"
  | "vendor_not_allowed"
  | "budget_exceeded"
  | "invalid_request"
  | "audit_unavailable"
  | "approval_required"
  | "approval_unavailable";

export interface Violation {
  code: ViolationCode;
  message: string;
  detail?: Record<string, string>;
}

export type PaymentErrorCode =
  | "adapter_error"
  | "price_mismatch"
  | "recipient_not_allowed"
  | "insufficient_funds"
  | "timeout";

export interface PaymentError {
  code: PaymentErrorCode;
  message: string;
  /**
   * Set only when the rail broadcast a transaction whose fate it could not determine. Its
   * presence means the money may have moved: reconcile the signature against an explorer.
   */
  txSig?: string;
}

export interface PayRequest {
  to: string;
  amount: string;
  currency: Currency;
  reason: string;
  via?: string;
}

export type PayResult =
  | { status: "settled"; txSig: string; auditId: string }
  | { status: "blocked"; violation: Violation; auditId: string }
  | { status: "failed"; error: PaymentError; auditId: string };

export interface SettlementRequest {
  to: string;
  amountMinor: bigint;
  reason: string;
  /**
   * The destinations `policy.recipients` approved, or undefined when the policy names none.
   * On a rail where the payee is quoted rather than addressed — x402 names it in the 402
   * response — the adapter must refuse anything outside this list before it signs.
   */
  allowedRecipients?: readonly string[];
}

export interface SettlementReceipt {
  txSig: string;
  rail: string;
  raw?: unknown;
}

export interface WalletAdapter {
  readonly name: string;
  readonly currency: Currency;
  execute(req: SettlementRequest): Promise<SettlementReceipt>;
}

/**
 * `uncertain` records a payment the rail broadcast but could not confirm. It consumes budget
 * exactly as `settled` does — a governor that cannot rule out a transfer must assume it
 * happened — while still telling an operator the settlement was never proven.
 */
export type AuditOutcome = "settled" | "blocked" | "failed" | "uncertain";
export type AuditKind = "payment" | "control";

export interface AuditEntry {
  id: string;
  logId: string;
  seq: number;
  ts: string;
  kind: AuditKind;
  agent: string;
  vendor: string;
  vendorNormalized: string;
  rail: string | null;
  amountMinor: string;
  currency: Currency;
  reason: string;
  outcome: AuditOutcome;
  violation: Violation | null;
  /** The rail error behind a `failed` or `uncertain` outcome; absent on every other outcome. */
  error?: PaymentError | null;
  txSig: string | null;
  prevHash: string;
  hash: string;
  sig: string;
}

export type UnsignedAuditEntry = Omit<AuditEntry, "hash" | "sig">;

export interface AuditSink {
  append(entry: AuditEntry): Promise<void>;
  read?(): AsyncIterable<AuditEntry>;
}

export interface WindowState {
  /** The UTC calendar day this window covers, as `YYYY-MM-DD`. */
  start: string;
  spentMinor: bigint;
}

export interface SpendState {
  frozen: boolean;
  /**
   * One entry per window the log has spent in, keyed by `windowKey` (`daily:YYYY-MM-DD`).
   * Every day keeps its own total, so a clock that jumps forward and back never hides spend.
   */
  windows: Record<string, WindowState>;
  seq: number;
  prevHash: string;
}

export interface PaymentContext {
  vendor: string;
  vendorNormalized: string;
  amountMinor: bigint;
  currency: Currency;
  reason: string;
  now: Date;
}

export type Check = (
  ctx: PaymentContext,
  policy: Policy,
  state: SpendState,
) => Violation | null;

export interface Anchor {
  logId: string;
  seq: number;
  hash: string;
  sig: string;
}

export interface AnchorStore {
  read(): Promise<Anchor | null>;
  write(anchor: Anchor): Promise<void>;
}

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

export interface KillSwitch {
  frozen: boolean;
}

export interface Policy {
  budgets: Budget[];
  vendors: VendorPolicy;
  killSwitch: KillSwitch;
}

export type ViolationCode =
  | "kill_switch"
  | "vendor_not_allowed"
  | "budget_exceeded"
  | "invalid_request"
  | "audit_unavailable";

export interface Violation {
  code: ViolationCode;
  message: string;
  detail?: Record<string, string>;
}

export type PaymentErrorCode =
  | "adapter_error"
  | "price_mismatch"
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

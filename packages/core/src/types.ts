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
  | "invalid_request";

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

export type AuditOutcome = "settled" | "blocked" | "failed";
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
  start: string;
  spentMinor: bigint;
}

export interface SpendState {
  frozen: boolean;
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

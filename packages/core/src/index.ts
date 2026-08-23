export const VERSION = "0.1.0";

export { InvalidRequestError, NotImplementedError } from "./errors.js";
export { createGuard, type Guard, type GuardOptions } from "./guard.js";
export { validatePolicy } from "./policy.js";
export { normalizeVendor } from "./vendor.js";
export { formatAmount, parseAmount, USDC_DECIMALS } from "./money.js";
export { memoryAuditSink, type MemoryAuditSink } from "./audit/memorySink.js";
export {
  canonicalize, hashEntry, signHash, verifyAuditLog, verifyEntry,
  type VerifyOptions, type VerifyResult,
} from "./audit/entry.js";
export {
  memoryAnchorStore, sealAnchor, verifyAnchor, type AnchorInput,
} from "./audit/anchor.js";
export { CorruptLogError, applyEntry, emptyState, replay, spentInWindow, windowKey } from "./state.js";
export { CHECKS, allowlistCheck, budgetCheck, killSwitchCheck } from "./checks/index.js";
export type {
  Anchor, AnchorStore, AuditEntry, AuditKind, AuditOutcome, AuditSink, Budget, BudgetPeriod,
  Check, Currency, KillSwitch, PayRequest, PayResult, PaymentContext, PaymentError,
  PaymentErrorCode, Policy, SettlementReceipt, SettlementRequest, SpendState,
  UnsignedAuditEntry, VendorPolicy, Violation, ViolationCode, WalletAdapter, WindowState,
} from "./types.js";

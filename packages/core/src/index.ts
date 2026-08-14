export const VERSION = "0.0.1";

export { createGuard, type Guard, type GuardOptions } from "./guard.js";
export { validatePolicy } from "./policy.js";
export { normalizeVendor } from "./vendor.js";
export { formatAmount, parseAmount, USDC_DECIMALS } from "./money.js";
export { memoryAuditSink, type MemoryAuditSink } from "./audit/memorySink.js";
export { fileAuditSink } from "./audit/fileSink.js";
export {
  canonicalize, hashEntry, signHash, verifyAuditLog, verifyEntry, type VerifyResult,
} from "./audit/entry.js";
export {
  fileAnchorStore, memoryAnchorStore, sealAnchor, verifyAnchor, type AnchorInput,
} from "./audit/anchor.js";
export { applyEntry, emptyState, replay, spentInWindow, windowKey } from "./state.js";
export { CHECKS, allowlistCheck, budgetCheck, killSwitchCheck } from "./checks/index.js";
export type {
  Anchor, AnchorStore, AuditEntry, AuditKind, AuditOutcome, AuditSink, Budget, BudgetPeriod,
  Check, Currency, KillSwitch, PayRequest, PayResult, PaymentContext, PaymentError,
  PaymentErrorCode, Policy, SettlementReceipt, SettlementRequest, SpendState,
  UnsignedAuditEntry, VendorPolicy, Violation, ViolationCode, WalletAdapter, WindowState,
} from "./types.js";

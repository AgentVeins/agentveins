/**
 * The filesystem-backed sink, anchor store, and approval store, kept off the package's main
 * entry point on purpose.
 *
 * `@agentveins/core` is the policy engine and the audit format: it decides
 * whether a payment may happen and how an entry is signed, and neither of those
 * needs a disk. Importing `node:fs` from the main entry would hand every
 * consumer filesystem reach they may never use, including one running entirely
 * on `memoryAuditSink`, and would show up as a filesystem capability in any
 * supply-chain scan of the package.
 *
 * Reach for a disk deliberately:
 *
 * ```ts
 * import { createGuard } from "@agentveins/core";
 * import { fileAuditSink, fileAnchorStore, fileApprovalStore } from "@agentveins/core/fs";
 * ```
 */
export { fileAuditSink } from "./audit/fileSink.js";
export { fileAnchorStore } from "./audit/fileAnchorStore.js";
export { fileApprovalStore } from "./approvals/fileStore.js";

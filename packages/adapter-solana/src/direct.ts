import { setTimeout as delay } from "node:timers/promises";
import { createSolanaRpc } from "@solana/kit";
import type { Base64EncodedWireTransaction, Signature } from "@solana/kit";

export type ConfirmationLevel = "processed" | "confirmed" | "finalized";

export interface SignatureStatus {
  confirmationStatus: ConfirmationLevel | null;
  err: unknown;
}

export interface DirectRail {
  sendTransaction(wireTransaction: string): Promise<string>;
  getSignatureStatus(signature: string): Promise<SignatureStatus | null>;
  getBlockHeight(): Promise<bigint>;
}

export const DEFAULT_CONFIRM_TIMEOUT_MS = 90_000;
export const DEFAULT_CONFIRM_MAX_ATTEMPTS = 300;

export interface ConfirmDeps {
  getSignatureStatus(signature: string): Promise<SignatureStatus | null>;
  getBlockHeight(): Promise<bigint>;
  pollIntervalMs: number;
  /** Wall-clock ceiling on the whole confirmation, including a single hung rpc call. */
  timeoutMs?: number;
  /** Ceiling on status checks, for an rpc that answers instantly and never advances. */
  maxAttempts?: number;
  /** Test seam for the wall clock. */
  now?: () => number;
}

export function createDirectRail(rpcUrl: string): DirectRail {
  const rpc = createSolanaRpc(rpcUrl);

  return {
    async sendTransaction(wireTransaction: string): Promise<string> {
      return rpc
        .sendTransaction(wireTransaction as Base64EncodedWireTransaction, {
          encoding: "base64",
          preflightCommitment: "confirmed",
        })
        .send();
    },
    async getSignatureStatus(signature: string): Promise<SignatureStatus | null> {
      const { value } = await rpc.getSignatureStatuses([signature as Signature]).send();
      const status = value[0];
      if (status === undefined || status === null) {
        return null;
      }
      return { confirmationStatus: status.confirmationStatus, err: status.err };
    },
    async getBlockHeight(): Promise<bigint> {
      return rpc.getBlockHeight({ commitment: "confirmed" }).send();
    },
  };
}

export class TransactionNotConfirmedError extends Error {
  readonly signature: string;

  constructor(signature: string, detail: string, options?: ErrorOptions) {
    super(`transaction ${signature} did not confirm: ${detail}`, options);
    this.name = "TransactionNotConfirmedError";
    this.signature = signature;
  }
}

/**
 * The transaction was broadcast and the cluster never ruled on it, so it may still land.
 * `unconfirmedSignature` is the guard's cue to record the attempt as spent-but-unproven rather
 * than as a clean failure; a rejection or an expired blockhash is a definite non-event and
 * deliberately omits it.
 *
 * Failing to *look* belongs here too. A rate-limited or unreachable rpc tells us nothing about
 * where the money went, and reporting that as a clean failure is how a governor comes to
 * believe it spent less than it did.
 */
export class ConfirmationUnknownError extends TransactionNotConfirmedError {
  readonly unconfirmedSignature: string;

  constructor(signature: string, detail: string, options?: ErrorOptions) {
    super(signature, detail, options);
    this.name = "ConfirmationUnknownError";
    this.unconfirmedSignature = signature;
  }
}

/** The cluster stayed silent until the deadline. A timeout is one way not to know. */
export class ConfirmationTimeoutError extends ConfirmationUnknownError {
  readonly code = "timeout";

  constructor(signature: string, detail: string) {
    super(signature, detail);
    this.name = "ConfirmationTimeoutError";
  }
}

const DEADLINE = Symbol("deadline");

/**
 * Runs one rpc call on behalf of a transaction already on the wire. Any rejection — a 429, a
 * dropped socket, a synchronous throw before the promise exists — becomes an unknown outcome
 * carrying the signature, never a clean failure: we are asking about money that has already left.
 */
async function observe<T>(work: () => Promise<T>, signature: string, what: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfirmationUnknownError(signature, `${what} failed: ${detail}`, { cause: error });
  }
}

// Bounds one rpc call, not just the gap between calls: a socket that never answers would
// otherwise hold the loop open past every attempt and wall-clock ceiling below.
async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  const controller = new AbortController();
  const timer: Promise<typeof DEADLINE> = delay(ms, DEADLINE, {
    ref: false,
    signal: controller.signal,
  }).catch((): typeof DEADLINE => DEADLINE);
  try {
    return await Promise.race([work, timer]);
  } finally {
    controller.abort();
  }
}

// rpc.sendTransaction resolves as soon as a node accepts the transaction, which is not a
// guarantee that it lands. The guard treats a resolved receipt as settled spend and has no
// reversal path, so direct mode confirms over HTTP before returning.
export async function confirmSignature(
  deps: ConfirmDeps,
  signature: string,
  lastValidBlockHeight: bigint,
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_CONFIRM_MAX_ATTEMPTS;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const remaining = (): number => timeoutMs - (now() - startedAt);
  const expired = (detail: string): ConfirmationTimeoutError =>
    new ConfirmationTimeoutError(signature, detail);

  let acknowledged = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (remaining() <= 0) {
      throw expired(`the cluster did not confirm it within ${timeoutMs}ms`);
    }

    const status = await observe(
      () => withinDeadline(deps.getSignatureStatus(signature), remaining()),
      signature,
      "the status check",
    );
    if (status === DEADLINE) {
      throw expired(`the cluster did not confirm it within ${timeoutMs}ms`);
    }

    if (status !== null) {
      if (status.err !== null && status.err !== undefined) {
        throw new TransactionNotConfirmedError(signature, "the cluster rejected it", {
          cause: status.err,
        });
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return;
      }
      // A node has the signature, so it was accepted and is in flight. Block height read from a
      // lagging node is no longer evidence it died — treating it as such reported transactions
      // that went on to finalize as failures, with no signature to reconcile against.
      acknowledged = true;
    }

    if (!acknowledged) {
      if (remaining() <= 0) {
        throw expired(`the cluster did not confirm it within ${timeoutMs}ms`);
      }
      const blockHeight = await observe(
        () => withinDeadline(deps.getBlockHeight(), remaining()),
        signature,
        "the block-height check",
      );
      if (blockHeight === DEADLINE) {
        throw expired(`the cluster did not confirm it within ${timeoutMs}ms`);
      }
      if (blockHeight > lastValidBlockHeight) {
        throw new TransactionNotConfirmedError(signature, "its blockhash expired before it landed");
      }
    }

    await delay(Math.max(0, Math.min(deps.pollIntervalMs, remaining())));
  }

  throw expired(`the cluster did not confirm it within ${maxAttempts} status checks`);
}

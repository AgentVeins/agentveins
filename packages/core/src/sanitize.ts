import type { PaymentError, Violation } from "./types.js";

export const MESSAGE_MAX = 200;
export const DETAIL_MAX = 120;
export const TXSIG_MAX = 128;

// C0 controls, DEL, C1 controls, and the bidi/zero-width range: every character that can erase a
// line, reorder it, or hide text once a violation reaches a terminal or a log viewer.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;

// A rail signature is opaque to core, so it is accepted only as base58/base64url-shaped text.
const SIGNATURE_SHAPE = /^[A-Za-z0-9_-]+$/;

export function sanitizeText(value: string, max: number): string {
  const stripped = value.replace(UNSAFE_CHARS, " ");
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

export function sanitizeDetail(detail: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(detail)) {
    out[sanitizeText(key, 64)] = sanitizeText(typeof value === "string" ? value : String(value), DETAIL_MAX);
  }
  return out;
}

export function sanitizeViolation(violation: Violation): Violation {
  const sanitized: Violation = {
    code: violation.code,
    message: sanitizeText(violation.message, MESSAGE_MAX),
  };
  if (violation.detail !== undefined && violation.detail !== null) {
    sanitized.detail = sanitizeDetail(violation.detail);
  }
  return sanitized;
}

export function sanitizeSignature(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value.length > TXSIG_MAX) {
    return undefined;
  }
  return SIGNATURE_SHAPE.test(value) ? value : undefined;
}

export function sanitizePaymentError(error: PaymentError): PaymentError {
  const sanitized: PaymentError = {
    code: error.code,
    message: sanitizeText(error.message, MESSAGE_MAX),
  };
  const txSig = sanitizeSignature(error.txSig);
  if (txSig !== undefined) {
    sanitized.txSig = txSig;
  }
  return sanitized;
}

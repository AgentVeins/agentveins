import { sanitizeDetail } from "./sanitize.js";

export class NotImplementedError extends Error {
  constructor(rail: string) {
    super(`the ${rail} adapter is not implemented yet; only the interface is defined`);
    this.name = "NotImplementedError";
  }
}

/**
 * A malformed payment request. The message states the rule and nothing else: the offending
 * value is caller-controlled, so it travels in `detail`, bounded and stripped of control
 * characters, exactly as the policy checks carry a vendor string.
 */
export class InvalidRequestError extends RangeError {
  readonly detail: Record<string, string>;

  constructor(message: string, detail: Record<string, string> = {}) {
    super(message);
    this.name = "InvalidRequestError";
    this.detail = sanitizeDetail(detail);
  }
}

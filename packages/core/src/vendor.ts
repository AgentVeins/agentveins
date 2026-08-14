import { URL } from "node:url";
import { InvalidRequestError } from "./errors.js";

const HTTP_SCHEME = /^https?:/i;

export function normalizeVendor(to: string): string {
  if (typeof to !== "string") {
    throw new TypeError("vendor must be a string");
  }
  const trimmed = to.trim();
  if (trimmed === "") {
    throw new InvalidRequestError("vendor must not be empty");
  }
  if (!HTTP_SCHEME.test(trimmed)) {
    // http(s) auto-inserts "//" as a special scheme, but other schemes (solana:...) and
    // bare vendors do not; only http(s)-prefixed strings get parsed as URLs. Base58
    // addresses are case-sensitive, so anything that falls through here stays untouched.
    return trimmed;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidRequestError("vendor is not a valid URL", { vendor: trimmed });
  }
  if (url.hostname === "") {
    throw new InvalidRequestError("vendor URL has no host", { vendor: trimmed });
  }
  return url.hostname.toLowerCase();
}

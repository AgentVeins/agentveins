import { URL } from "node:url";

const HTTP_SCHEME = /^https?:/i;

export function normalizeVendor(to: string): string {
  if (typeof to !== "string") {
    throw new TypeError("vendor must be a string");
  }
  const trimmed = to.trim();
  if (trimmed === "") {
    throw new RangeError("vendor must not be empty");
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
    throw new RangeError(`vendor is not a valid URL: ${trimmed}`);
  }
  if (url.hostname === "") {
    throw new RangeError(`vendor URL has no host: ${trimmed}`);
  }
  return url.hostname.toLowerCase();
}

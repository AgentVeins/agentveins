import { URL } from "node:url";

const URL_PREFIX = /^https?:\/\//i;

export function normalizeVendor(to: string): string {
  if (typeof to !== "string") {
    throw new TypeError("vendor must be a string");
  }
  const trimmed = to.trim();
  if (trimmed === "") {
    throw new RangeError("vendor must not be empty");
  }
  if (!URL_PREFIX.test(trimmed)) {
    // Base58 addresses are case-sensitive, so bare vendors pass through untouched.
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

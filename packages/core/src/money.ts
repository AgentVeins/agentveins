export const USDC_DECIMALS = 6;

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

export function parseAmount(value: string, decimals: number = USDC_DECIMALS): bigint {
  if (typeof value !== "string") {
    throw new TypeError("amount must be a string");
  }
  const trimmed = value.trim();
  if (!PLAIN_DECIMAL.test(trimmed)) {
    throw new RangeError(`amount must be a plain non-negative decimal, received: ${value}`);
  }
  const [whole = "", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new RangeError(`amount carries more than ${decimals} decimal places: ${value}`);
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

export function formatAmount(minor: bigint, decimals: number = USDC_DECIMALS): string {
  const sign = minor < 0n ? "-" : "";
  const digits = (minor < 0n ? -minor : minor).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  if (decimals === 0) {
    return `${sign}${whole}`;
  }
  return `${sign}${whole}.${digits.slice(-decimals)}`;
}

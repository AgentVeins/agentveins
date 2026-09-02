const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parses "30s", "10m", "2h", "1d" into milliseconds, bounded by a caller-supplied ceiling.
 *
 * A bare number is refused rather than guessed at: "15" could mean minutes or seconds, and
 * the two differ by a factor of sixty on how long a rule holds. The error names the field
 * the caller passes, because this is shared by fields with different ceilings and docs.
 */
export function parseDuration(value: string, maxMs: number, name: string): number {
  const match = /^(\d+)([smhd])$/.exec(typeof value === "string" ? value.trim() : "");
  if (match === null) {
    throw new RangeError(`${name} must look like 30s, 10m, 2h or 1d; received ${JSON.stringify(value)}`);
  }
  const ms = Number(match[1]) * (UNITS[match[2] ?? ""] ?? 0);
  if (ms <= 0) {
    throw new RangeError(`${name} must be greater than zero`);
  }
  if (ms > maxMs) {
    throw new RangeError(`${name} must not exceed ${maxMs / 3_600_000}h`);
  }
  return ms;
}

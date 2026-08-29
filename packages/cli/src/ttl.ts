const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MAX_TTL_MS = 7 * 86_400_000;

/**
 * Parses "15m", "2h", "30s" into milliseconds.
 *
 * A bare number is rejected rather than guessed at. An operator typing `--ttl 15` may mean
 * minutes or seconds, and the two differ by a factor of sixty on how long an agent holds
 * permission to move money — the wrong guess is not a small mistake.
 */
export function parseTtl(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (match === null) {
    throw new RangeError(`--ttl must look like 30s, 15m, 2h or 1d; received ${JSON.stringify(value)}`);
  }
  const amount = Number(match[1]);
  const unit = UNITS[match[2] ?? ""];
  if (amount <= 0 || unit === undefined) {
    throw new RangeError("--ttl must be greater than zero");
  }
  const ms = amount * unit;
  // An approval is a standing permission to spend. One that outlives the conversation that
  // produced it is the thing this whole feature exists to prevent, so the ceiling is deliberate.
  if (ms > MAX_TTL_MS) {
    throw new RangeError("--ttl must not exceed 7d; grant again rather than granting for longer");
  }
  return ms;
}

import { formatAmount } from "@agentveins/core";
import type { PendingApproval } from "./pending.js";

const MAX_REASON = 60;
const MAX_VENDOR = 40;

/**
 * Everything shown here came from the agent or the endpoint it called, so it is truncated and
 * quoted on the way to a terminal — the same treatment the guard gives a violation detail. A
 * vendor string carrying control characters must not be able to redraw the screen a person is
 * reading before they decide to move money.
 */
export function safe(value: string, max: number): string {
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return JSON.stringify(stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped);
}

export function ago(from: string, now: Date): string {
  const then = Date.parse(from);
  if (Number.isNaN(then)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h ago`;
  }
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function renderPending(pending: PendingApproval[], now: Date): string {
  if (pending.length === 0) {
    return "  nothing is waiting on you\n";
  }

  const lines: string[] = [];
  pending.forEach((item, index) => {
    const attempts = item.attempts === 1 ? "1 attempt" : `${item.attempts} attempts`;
    lines.push(
      `  ${String(index + 1).padStart(2)}  ${item.agent} → ${safe(item.vendorNormalized, MAX_VENDOR)}`,
    );
    lines.push(
      `      ${formatAmount(item.amountMinor)} ${item.currency}   ${safe(item.reasons[0] ?? "", MAX_REASON)}`,
    );
    lines.push(`      ${attempts}, last ${ago(item.lastSeen, now)}   audit ${item.auditId}`);
    lines.push("");
  });
  return lines.join("\n");
}

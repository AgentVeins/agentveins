import { describe, expect, it } from "vitest";
import { decideApproval } from "../src/approvals/decide.js";
import type { Approval, ApprovalKey } from "../src/types.js";

const now = new Date("2026-08-28T12:00:00.000Z");

const key: ApprovalKey = {
  agent: "research-agent",
  vendorNormalized: "api.weather.com",
  amountMinor: 25_000_000n,
};

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    ...key,
    id: "apr_1",
    expiresAt: "2026-08-28T12:30:00.000Z",
    usedAt: null,
    ...overrides,
  };
}

describe("decideApproval", () => {
  it("grants an unused, unexpired approval matching the key", () => {
    expect(decideApproval(approval(), key, now)).toBe("grant");
  });

  it("reports a missing approval", () => {
    expect(decideApproval(null, key, now)).toBe("missing");
  });

  it("reports one already spent", () => {
    expect(decideApproval(approval({ usedAt: "2026-08-28T11:00:00.000Z" }), key, now)).toBe("used");
  });

  it("reports one that has expired", () => {
    expect(decideApproval(approval({ expiresAt: "2026-08-28T11:59:59.000Z" }), key, now)).toBe("expired");
  });

  it("treats an approval expiring exactly now as expired", () => {
    expect(decideApproval(approval({ expiresAt: "2026-08-28T12:00:00.000Z" }), key, now)).toBe("expired");
  });

  it("treats an unparseable expiry as expired rather than valid", () => {
    expect(decideApproval(approval({ expiresAt: "not a date" }), key, now)).toBe("expired");
  });

  it("refuses an approval for a different amount", () => {
    expect(decideApproval(approval({ amountMinor: 25_000_001n }), key, now)).toBe("missing");
  });

  it("refuses an approval for a different vendor", () => {
    expect(decideApproval(approval({ vendorNormalized: "evil.example" }), key, now)).toBe("missing");
  });

  it("refuses an approval for a different agent", () => {
    expect(decideApproval(approval({ agent: "other-agent" }), key, now)).toBe("missing");
  });
});

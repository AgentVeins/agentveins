import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { memoryApprovalStore } from "../src/approvals/memoryStore.js";
import { memoryAnchorStore, sealAnchor, verifyAnchor } from "../src/audit/anchor.js";
import { verifyAuditLog } from "../src/audit/entry.js";
import { memoryAuditSink, type MemoryAuditSink } from "../src/audit/memorySink.js";
import { createGuard, type Guard, type GuardOptions } from "../src/guard.js";
import type {
  Anchor, AnchorStore, Approval, ApprovalStore, AuditEntry, PayResult, Policy, SettlementReceipt,
  SettlementRequest, WalletAdapter,
} from "../src/types.js";

const keys = generateKeyPairSync("ed25519");
const LOG_ID = "log-demo-agent";

function policy(): Policy {
  return {
    budgets: [
      { period: "per_tx", limit: "0.10", currency: "USDC" },
      { period: "daily", limit: "0.50", currency: "USDC" },
    ],
    vendors: { mode: "allowlist", entries: ["api.weather.com"] },
    killSwitch: { frozen: false },
  };
}

function fakeAdapter(overrides: Partial<WalletAdapter> = {}): WalletAdapter {
  return {
    name: "fake",
    currency: "USDC",
    execute: vi.fn(async (req: SettlementRequest) => ({
      txSig: `sig-${req.amountMinor}`,
      rail: "fake",
    })),
    ...overrides,
  };
}

const clock = () => new Date("2026-08-13T12:00:00.000Z");

/**
 * The one place `GuardOptions` defaults are defined. `guardWith` below delegates here rather
 * than keeping its own copy: two copies of `agent` in particular could drift silently, and a
 * drifted `agent` breaks approval-key matching without the compiler ever noticing.
 */
function makeGuard(overrides: Partial<GuardOptions> = {}): Promise<Guard> {
  return createGuard({
    policy: policy(),
    adapters: [fakeAdapter()],
    audit: memoryAuditSink(),
    agent: "demo-agent",
    logId: LOG_ID,
    signingKey: keys.privateKey,
    now: clock,
    ...overrides,
  });
}

async function guardWith(adapter: WalletAdapter, sink: MemoryAuditSink = memoryAuditSink()) {
  const guard = await makeGuard({ adapters: [adapter], audit: sink });
  return { guard, sink };
}

/** A `fakeAdapter` whose `execute` is supplied directly, for tests that only care about timing. */
function stubAdapter(execute: (req: SettlementRequest) => Promise<SettlementReceipt>): WalletAdapter {
  return fakeAdapter({ execute: vi.fn(execute) });
}

/** A sink whose append fails whenever the predicate says so; failures leave no entry behind. */
function flakySink(shouldFail: (entry: AuditEntry, attempt: number) => boolean): MemoryAuditSink {
  const entries: AuditEntry[] = [];
  let attempt = 0;
  return {
    entries,
    async append(entry: AuditEntry): Promise<void> {
      attempt += 1;
      if (shouldFail(entry, attempt)) {
        throw new Error("audit sink is unavailable");
      }
      entries.push(entry);
    },
    async *read(): AsyncIterable<AuditEntry> {
      yield* entries;
    },
  };
}

function blockedCode(result: PayResult): string {
  return result.status === "blocked" ? result.violation.code : `not blocked: ${result.status}`;
}

const request = { to: "https://api.weather.com/forecast", amount: "0.05", currency: "USDC" as const, reason: "forecast query" };

describe("createGuard", () => {
  it("rejects an invalid policy at construction", async () => {
    await expect(
      createGuard({
        policy: { ...policy(), budgets: [] },
        adapters: [fakeAdapter()],
        audit: memoryAuditSink(),
        agent: "a",
        logId: LOG_ID,
        signingKey: keys.privateKey,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects a sink that cannot replay when persistence is required", async () => {
    const writeOnly = { append: async () => {} };
    await expect(
      createGuard({
        policy: policy(),
        adapters: [fakeAdapter()],
        audit: writeOnly,
        agent: "a",
        logId: LOG_ID,
        signingKey: keys.privateKey,
        requirePersistedState: true,
      }),
    ).rejects.toThrow(/replay/);
  });

  it("requires a logId", async () => {
    await expect(
      createGuard({
        policy: policy(),
        adapters: [fakeAdapter()],
        audit: memoryAuditSink(),
        agent: "a",
        logId: "  ",
        signingKey: keys.privateKey,
      }),
    ).rejects.toThrow(/logId/);
  });

  it("rejects a public key where the signing key belongs", async () => {
    await expect(
      createGuard({
        policy: policy(),
        adapters: [fakeAdapter()],
        audit: memoryAuditSink(),
        agent: "a",
        logId: LOG_ID,
        signingKey: keys.publicKey,
        verifyingKey: keys.publicKey,
      }),
    ).rejects.toThrow(/private/);
  });

  it("exposes the policy it was constructed with", async () => {
    const p = policy();
    const guard = await makeGuard({ policy: p });
    expect(guard.policy).toEqual(p);
  });

  // 0.30 sits strictly between the original per_tx limit (0.10) and the daily limit (0.50):
  // if the mutation below reached enforcement, this payment would clear both budgets and
  // settle, rather than being blocked by the untouched per_tx check.
  it("enforces a copy, so mutating the caller's policy afterwards changes nothing", async () => {
    const original = policy();
    const guard = await makeGuard({ policy: original });
    original.budgets[0]!.limit = "999999.00";

    const result = await guard.pay({ to: "https://api.weather.com/f", amount: "0.30", currency: "USDC", reason: "r" });
    expect(result.status).toBe("blocked");
  });

  it("hands out a policy that cannot be used to widen a rule", async () => {
    const guard = await makeGuard({});
    expect(() => {
      (guard.policy.vendors.entries as string[]).push("evil.example");
    }).toThrow();

    const result = await guard.pay({ to: "https://evil.example/f", amount: "0.01", currency: "USDC", reason: "r" });
    expect(result.status).toBe("blocked");
  });
});

describe("guard.pay", () => {
  it("settles an allowed payment and returns the signature", async () => {
    const { guard } = await guardWith(fakeAdapter());
    const result = await guard.pay(request);
    expect(result.status).toBe("settled");
    if (result.status === "settled") {
      expect(result.txSig).toBe("sig-50000");
      expect(result.auditId).toBeTruthy();
    }
  });

  it("hands the adapter the policy's recipient allowlist", async () => {
    const adapter = fakeAdapter();
    const guard = await createGuard({
      policy: { ...policy(), recipients: { mode: "allowlist", entries: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"] } },
      adapters: [adapter],
      audit: memoryAuditSink(),
      agent: "demo-agent",
      logId: LOG_ID,
      signingKey: keys.privateKey,
      now: clock,
    });

    await guard.pay(request);

    expect(adapter.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        allowedRecipients: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
      }),
    );
  });

  it("leaves allowedRecipients undefined when the policy names none", async () => {
    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter);

    await guard.pay(request);

    const sent = (adapter.execute as unknown as { mock: { calls: SettlementRequest[][] } }).mock.calls[0]?.[0];
    expect(sent?.allowedRecipients).toBeUndefined();
  });

  it("never calls the adapter on a blocked payment", async () => {
    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter);
    const result = await guard.pay({ ...request, to: "https://evil.example/x" });
    expect(result.status).toBe("blocked");
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("blocks once the daily budget is exhausted", async () => {
    const { guard } = await guardWith(fakeAdapter());
    for (let i = 0; i < 10; i++) {
      expect((await guard.pay(request)).status).toBe("settled");
    }
    const blocked = await guard.pay(request);
    expect(blocked.status).toBe("blocked");
    if (blocked.status === "blocked") {
      expect(blocked.violation.code).toBe("budget_exceeded");
      expect(blocked.violation.detail?.period).toBe("daily");
    }
  });

  it("returns failed on an adapter error without consuming budget", async () => {
    const adapter = fakeAdapter({
      execute: vi.fn(async () => {
        throw new Error("rpc timeout");
      }),
    });
    const { guard } = await guardWith(adapter);
    const result = await guard.pay(request);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("adapter_error");
    }
    expect(guard.state().windows["daily:2026-08-13"]?.spentMinor ?? 0n).toBe(0n);
  });

  it("preserves a recipient refusal as its own code so a retry loop can tell it apart", async () => {
    const adapter = fakeAdapter({
      execute: vi.fn(async () => {
        throw Object.assign(new Error("the endpoint named a recipient that is not on the allowlist"), {
          code: "recipient_not_allowed",
        });
      }),
    });
    const { guard, sink } = await guardWith(adapter);
    const result = await guard.pay(request);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("recipient_not_allowed");
    }
    expect(sink.entries.at(-1)!.error?.code).toBe("recipient_not_allowed");
    expect(guard.state().windows["daily:2026-08-13"]?.spentMinor ?? 0n).toBe(0n);
  });

  it("treats a receipt without a transaction signature as failed", async () => {
    const adapter = fakeAdapter({
      execute: vi.fn(async () => ({ rail: "fake" }) as unknown as SettlementReceipt),
    });
    const { guard, sink } = await guardWith(adapter);
    const result = await guard.pay(request);

    expect(result.status).toBe("failed");
    expect(sink.entries.map((e) => e.outcome)).toEqual(["failed"]);
    expect(sink.entries[0]!.txSig).toBeNull();
    expect(guard.state().windows["daily:2026-08-13"]?.spentMinor ?? 0n).toBe(0n);
  });

  it("returns an invalid_request violation for an unparseable amount", async () => {
    const { guard } = await guardWith(fakeAdapter());
    const result = await guard.pay({ ...request, amount: "-1.00" });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.violation.code).toBe("invalid_request");
    }
  });

  it("serializes concurrent payments so the budget cannot be raced", async () => {
    const { guard } = await guardWith(fakeAdapter());
    const results = await Promise.all(Array.from({ length: 15 }, () => guard.pay(request)));
    expect(results.filter((r) => r.status === "settled")).toHaveLength(10);
    expect(results.filter((r) => r.status === "blocked")).toHaveLength(5);
  });

  it("returns a state snapshot that callers cannot mutate", async () => {
    const { guard } = await guardWith(fakeAdapter());
    await guard.pay(request);

    const taken = guard.state();
    taken.frozen = true;
    taken.seq = 99;
    taken.windows["daily:2026-08-13"]!.spentMinor = 0n;

    expect(guard.state().frozen).toBe(false);
    expect(guard.state().seq).toBe(1);
    expect(guard.state().windows["daily:2026-08-13"]?.spentMinor).toBe(50_000n);
    expect((await guard.pay(request)).status).toBe("settled");
  });
});

describe("no adapter call on any violation code", () => {
  it("blocks kill_switch before the adapter", async () => {
    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter);
    await guard.freeze();
    expect(blockedCode(await guard.pay(request))).toBe("kill_switch");
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("blocks vendor_not_allowed before the adapter", async () => {
    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter);
    expect(blockedCode(await guard.pay({ ...request, to: "https://evil.example/x" }))).toBe("vendor_not_allowed");
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("blocks a per_tx budget_exceeded before the adapter", async () => {
    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter);
    const result = await guard.pay({ ...request, amount: "0.50" });
    expect(blockedCode(result)).toBe("budget_exceeded");
    if (result.status === "blocked") {
      expect(result.violation.detail?.period).toBe("per_tx");
    }
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("blocks a daily budget_exceeded before the adapter", async () => {
    const sink = memoryAuditSink();
    const spender = await guardWith(fakeAdapter(), sink);
    for (let i = 0; i < 10; i++) {
      await spender.guard.pay(request);
    }

    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter, sink);
    const result = await guard.pay(request);
    expect(blockedCode(result)).toBe("budget_exceeded");
    if (result.status === "blocked") {
      expect(result.violation.detail?.period).toBe("daily");
    }
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("blocks invalid_request before the adapter", async () => {
    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter);
    expect(blockedCode(await guard.pay({ ...request, amount: "0.00" }))).toBe("invalid_request");
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("blocks audit_unavailable before the adapter", async () => {
    const adapter = fakeAdapter();
    const guard = await createGuard({
      policy: policy(), adapters: [adapter], audit: flakySink(() => true),
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey, now: clock,
    });

    // The first attempt is blocked on its vendor, so the adapter is untouched; recording that
    // block is what breaks the log and latches the guard.
    expect(blockedCode(await guard.pay({ ...request, to: "https://evil.example/x" }))).toBe("vendor_not_allowed");
    expect(blockedCode(await guard.pay(request))).toBe("audit_unavailable");
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });
});

describe("a guard that cannot record cannot authorize", () => {
  it("returns settled with the real signature when only the audit write fails", async () => {
    const adapter = fakeAdapter();
    const sink = flakySink((_entry, attempt) => attempt === 1);
    const guard = await createGuard({
      policy: policy(), adapters: [adapter], audit: sink,
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey, now: clock,
    });

    const result = await guard.pay(request);
    expect(result.status).toBe("settled");
    if (result.status === "settled") {
      expect(result.txSig).toBe("sig-50000");
    }
    expect(sink.entries).toHaveLength(0);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    // The money moved, so the in-memory window counts it even though the log does not.
    expect(guard.state().windows["daily:2026-08-13"]?.spentMinor).toBe(50_000n);
  });

  it("latches after one audit failure and stops calling the adapter", async () => {
    const adapter = fakeAdapter();
    const guard = await createGuard({
      policy: policy(), adapters: [adapter], audit: flakySink(() => true),
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey, now: clock,
    });

    expect((await guard.pay(request)).status).toBe("settled");
    for (let i = 0; i < 5; i++) {
      const result = await guard.pay(request);
      expect(blockedCode(result)).toBe("audit_unavailable");
      expect(result.auditId).toBe("");
    }
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });

  it("freezes even when the control entry cannot be written", async () => {
    const guard = await createGuard({
      policy: policy(), adapters: [fakeAdapter()], audit: flakySink(() => true),
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey, now: clock,
    });

    await expect(guard.freeze()).resolves.toBeUndefined();
    expect(guard.state().frozen).toBe(true);
    expect((await guard.pay(request)).status).toBe("blocked");
  });

  it("leaves the agent frozen when the unfreeze cannot be written", async () => {
    const guard = await createGuard({
      policy: policy(), adapters: [fakeAdapter()],
      audit: flakySink((entry) => entry.reason === "unfreeze"),
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey, now: clock,
    });

    await guard.freeze();
    await expect(guard.unfreeze()).resolves.toBeUndefined();
    expect(guard.state().frozen).toBe(true);
  });

  it("keeps exactly one entry and does not reject when the anchor write fails", async () => {
    const sink = memoryAuditSink();
    const store: AnchorStore = {
      async read(): Promise<Anchor | null> {
        return null;
      },
      async write(): Promise<void> {
        throw new Error("anchor store is unavailable");
      },
    };
    const guard = await createGuard({
      policy: policy(), adapters: [fakeAdapter()], audit: sink, anchor: store,
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey, now: clock,
    });

    const result = await guard.pay(request);
    expect(result.status).toBe("settled");
    if (result.status === "settled") {
      expect(result.txSig).toBe("sig-50000");
    }
    expect(sink.entries.map((e) => e.outcome)).toEqual(["settled"]);
    expect(blockedCode(await guard.pay(request))).toBe("audit_unavailable");
  });
});

describe("guard.freeze", () => {
  it("blocks every subsequent payment", async () => {
    const { guard } = await guardWith(fakeAdapter());
    await guard.freeze();
    const result = await guard.pay(request);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.violation.code).toBe("kill_switch");
    }
  });

  it("is reversible", async () => {
    const { guard } = await guardWith(fakeAdapter());
    await guard.freeze();
    await guard.unfreeze();
    expect((await guard.pay(request)).status).toBe("settled");
  });

  it("refuses to unfreeze an agent the policy freezes", async () => {
    const guard = await createGuard({
      policy: { ...policy(), killSwitch: { frozen: true } },
      adapters: [fakeAdapter()], audit: memoryAuditSink(),
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey, now: clock,
    });

    await expect(guard.unfreeze()).rejects.toThrow(/policy/);
    expect(guard.state().frozen).toBe(true);
    expect(blockedCode(await guard.pay(request))).toBe("kill_switch");
  });
});

describe("restart safety", () => {
  it("does not reset the budget when a new guard reads the same log", async () => {
    const sink = memoryAuditSink();
    const first = await guardWith(fakeAdapter(), sink);
    for (let i = 0; i < 10; i++) {
      await first.guard.pay(request);
    }

    const second = await guardWith(fakeAdapter(), sink);
    const result = await second.guard.pay(request);
    expect(result.status).toBe("blocked");
  });

  it("restores frozen state across a restart", async () => {
    const sink = memoryAuditSink();
    const first = await guardWith(fakeAdapter(), sink);
    await first.guard.freeze();
    await first.guard.flush();

    const second = await guardWith(fakeAdapter(), sink);
    expect(second.guard.state().frozen).toBe(true);
  });

  it("keeps appending to the same log identity after a restart", async () => {
    const sink = memoryAuditSink();
    const first = await guardWith(fakeAdapter(), sink);
    await first.guard.pay(request);

    const second = await guardWith(fakeAdapter(), sink);
    await second.guard.pay(request);

    expect(new Set(sink.entries.map((e) => e.logId))).toEqual(new Set([LOG_ID]));
    expect(await verifyAuditLog(sink.entries, keys.publicKey, { logId: LOG_ID })).toEqual({ ok: true, checked: 2 });
  });
});

describe("log substitution", () => {
  async function foreignLog(overrides: { logId?: string; agent?: string }): Promise<MemoryAuditSink> {
    const sink = memoryAuditSink();
    const guard = await createGuard({
      policy: policy(), adapters: [fakeAdapter()], audit: sink,
      agent: overrides.agent ?? "demo-agent",
      logId: overrides.logId ?? LOG_ID,
      signingKey: keys.privateKey, now: clock,
    });
    for (let i = 0; i < 8; i++) {
      await guard.pay(request);
    }
    return sink;
  }

  it("refuses a genuine log that names a different logId", async () => {
    const substituted = await foreignLog({ logId: "log-other-agent" });
    await expect(guardWith(fakeAdapter(), substituted)).rejects.toThrow(/identity/);
  });

  it("refuses a genuine log that names a different agent", async () => {
    const substituted = await foreignLog({ agent: "agent-b" });
    await expect(guardWith(fakeAdapter(), substituted)).rejects.toThrow(/different agent/);
  });
});

describe("audit trail", () => {
  it("writes a verifiable entry for settled, blocked, and failed attempts", async () => {
    const sink = memoryAuditSink();
    const { guard } = await guardWith(fakeAdapter(), sink);
    await guard.pay(request);
    await guard.pay({ ...request, to: "https://evil.example/x" });
    await guard.freeze();
    await guard.flush();

    expect(sink.entries.map((e) => e.outcome)).toEqual(["settled", "blocked", "settled"]);
    expect(sink.entries.map((e) => e.kind)).toEqual(["payment", "payment", "control"]);
    expect(await verifyAuditLog(sink.entries, keys.publicKey)).toEqual({ ok: true, checked: 3 });
  });

  it("audits a failed attempt without consuming budget", async () => {
    const sink = memoryAuditSink();
    const { guard } = await guardWith(
      fakeAdapter({
        execute: vi.fn(async () => {
          throw new Error("rpc timeout");
        }),
      }),
      sink,
    );
    await guard.pay(request);

    expect(sink.entries.map((e) => e.outcome)).toEqual(["failed"]);
    expect(await verifyAuditLog(sink.entries, keys.publicKey)).toEqual({ ok: true, checked: 1 });
  });
});

describe("hardening", () => {
  it("keeps a policy freeze sticky over a logged unfreeze", async () => {
    const sink = memoryAuditSink();
    const first = await guardWith(fakeAdapter(), sink);
    await first.guard.freeze();
    await first.guard.flush();
    await first.guard.unfreeze();
    expect(first.guard.state().frozen).toBe(false);

    const second = await createGuard({
      policy: { ...policy(), killSwitch: { frozen: true } },
      adapters: [fakeAdapter()],
      audit: sink,
      agent: "demo-agent",
      logId: LOG_ID,
      signingKey: keys.privateKey,
      now: clock,
    });
    expect(second.state().frozen).toBe(true);
    const result = await second.pay(request);
    expect(blockedCode(result)).toBe("kill_switch");
  });

  it("keeps a logged freeze sticky over a policy that claims unfrozen", async () => {
    const sink = memoryAuditSink();
    const first = await guardWith(fakeAdapter(), sink);
    await first.guard.freeze();
    await first.guard.flush();

    const second = await guardWith(fakeAdapter(), sink);
    expect(second.guard.state().frozen).toBe(true);
  });

  // The guard now enforces a frozen copy taken at construction, so a mutation to the caller's
  // object — even one that would fail validation — cannot reach evaluation at all: not as a
  // corrupted value the checks must survive, and not as a widened rule either.
  it("ignores a policy mutated after construction, rather than reading the corrupted value", async () => {
    const live = policy();
    const adapter = fakeAdapter();
    const guard = await createGuard({
      policy: live,
      adapters: [adapter],
      audit: memoryAuditSink(),
      agent: "demo-agent",
      logId: LOG_ID,
      signingKey: keys.privateKey,
      now: clock,
    });

    live.budgets[0]!.limit = "not-a-number";
    const result = await guard.pay(request);
    expect(result.status).toBe("settled");
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-positive amount at the boundary", async () => {
    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter);
    expect(blockedCode(await guard.pay({ ...request, amount: "0.00" }))).toBe("invalid_request");
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("returns invalid_request for an unknown adapter name", async () => {
    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter);
    expect(blockedCode(await guard.pay({ ...request, via: "nope" }))).toBe("invalid_request");
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("refuses to start when the log fails verification", async () => {
    const sink = memoryAuditSink();
    const first = await guardWith(fakeAdapter(), sink);
    await first.guard.pay(request);
    sink.entries[0]!.amountMinor = "999999";

    await expect(guardWith(fakeAdapter(), sink)).rejects.toThrow(/verification/);
  });
});

describe("the anchor invariant", () => {
  function anchored(
    sink: MemoryAuditSink,
    anchor: AnchorStore,
    extra: Partial<GuardOptions> = {},
  ): Promise<Guard> {
    return createGuard({
      policy: policy(),
      adapters: [fakeAdapter()],
      audit: sink,
      agent: "demo-agent",
      logId: LOG_ID,
      signingKey: keys.privateKey,
      anchor,
      now: clock,
      ...extra,
    });
  }

  it("treats an absent anchor over an empty log as a first run and seals after the first append", async () => {
    const sink = memoryAuditSink();
    const store = memoryAnchorStore();
    const guard = await anchored(sink, store);
    await guard.pay(request);

    const anchor = await store.read();
    expect(anchor).not.toBeNull();
    expect(anchor!.seq).toBe(0);
    expect(anchor!.hash).toBe(sink.entries[0]!.hash);
    expect(anchor!.logId).toBe(LOG_ID);
    expect(verifyAnchor(anchor!, keys.publicKey)).toBe(true);
  });

  it("seals the anchor only after the entry is in the log", async () => {
    const events: string[] = [];
    const entries: AuditEntry[] = [];
    const sink: MemoryAuditSink = {
      entries,
      async append(entry: AuditEntry): Promise<void> {
        events.push("append");
        entries.push(entry);
      },
      async *read(): AsyncIterable<AuditEntry> {
        yield* entries;
      },
    };
    let current: Anchor | null = null;
    const store: AnchorStore = {
      async read(): Promise<Anchor | null> {
        return current;
      },
      async write(next: Anchor): Promise<void> {
        events.push(`anchor@${entries.length}`);
        current = next;
      },
    };

    const guard = await createGuard({
      policy: policy(), adapters: [fakeAdapter()], audit: sink, anchor: store,
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey, now: clock,
    });
    await guard.pay(request);
    await guard.freeze();
    await guard.flush();

    // Each anchor write sees its own entry already appended; an anchor ahead of the log would
    // read as truncation on the next start.
    expect(events).toEqual(["append", "anchor@1", "append", "anchor@2"]);
  });

  it("fails closed when the anchor is absent but the log is not empty", async () => {
    const sink = memoryAuditSink();
    const first = await guardWith(fakeAdapter(), sink);
    await first.guard.pay(request);

    await expect(anchored(sink, memoryAnchorStore())).rejects.toThrow(/anchor/);
  });

  it("fails closed on an anchor with an invalid signature", async () => {
    const sink = memoryAuditSink();
    const store = memoryAnchorStore();
    const guard = await anchored(sink, store);
    await guard.pay(request);

    const head = sink.entries[0]!;
    const foreign = generateKeyPairSync("ed25519");
    await store.write(sealAnchor({ logId: head.logId, seq: head.seq, hash: head.hash }, foreign.privateKey));

    await expect(anchored(sink, store)).rejects.toThrow(/signature/);
  });

  it("fails closed when the anchor names a different log", async () => {
    const sink = memoryAuditSink();
    const store = memoryAnchorStore();
    const guard = await anchored(sink, store);
    await guard.pay(request);

    await expect(anchored(sink, store, { logId: "some-other-log" })).rejects.toThrow(/anchor/);
  });

  it("proceeds and keeps the spend window when the anchor matches the head", async () => {
    const sink = memoryAuditSink();
    const store = memoryAnchorStore();
    const guard = await anchored(sink, store);
    for (let i = 0; i < 10; i++) {
      expect((await guard.pay(request)).status).toBe("settled");
    }

    const second = await anchored(sink, store);
    expect((await second.pay(request)).status).toBe("blocked");

    const anchor = await store.read();
    expect(anchor!.seq).toBe(sink.entries.length - 1);
    expect(anchor!.hash).toBe(sink.entries[sink.entries.length - 1]!.hash);
  });

  it("fails closed when the log is truncated below the anchor", async () => {
    const sink = memoryAuditSink();
    const store = memoryAnchorStore();
    const guard = await anchored(sink, store);
    await guard.pay(request);
    await guard.pay(request);
    await guard.pay(request);

    const truncated = memoryAuditSink(sink.entries.slice(0, 1));
    await expect(anchored(truncated, store)).rejects.toThrow(/truncat/);
  });

  it("re-seals the anchor after a control entry too", async () => {
    const sink = memoryAuditSink();
    const store = memoryAnchorStore();
    const guard = await anchored(sink, store);
    await guard.freeze();
    await guard.flush();

    const anchor = await store.read();
    expect(anchor!.seq).toBe(0);
    expect(anchor!.hash).toBe(sink.entries[0]!.hash);
  });

  it("refuses an anchor store when the sink cannot replay the log", async () => {
    await expect(
      createGuard({
        policy: policy(),
        adapters: [fakeAdapter()],
        audit: { append: async () => {} },
        agent: "demo-agent",
        logId: LOG_ID,
        signingKey: keys.privateKey,
        anchor: memoryAnchorStore(),
      }),
    ).rejects.toThrow(/anchor/);
  });
});

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
/** An ANSI erase-line plus carriage return: the sequence that forges a transcript line. */
const ANSI_FORGE = `${ESC}[2K${CR}payment 12 (0.05) settled  tx=forged`;

function hasControlChars(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

// C1: one daily slot let a log entry dated in the future zero the budget for the real day.
describe("a clock that runs ahead cannot clear the daily budget", () => {
  it("enforces today's cap after an entry landed in tomorrow", async () => {
    const sink = memoryAuditSink();
    const fast = await createGuard({
      policy: policy(), adapters: [fakeAdapter()], audit: sink,
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey,
      now: () => new Date("2026-08-15T00:30:00.000Z"),
    });
    expect((await fast.pay({ ...request, amount: "0.01" })).status).toBe("settled");

    // The operator restarts the process with a correct clock, still inside 2026-08-14.
    const corrected = await createGuard({
      policy: policy(), adapters: [fakeAdapter()], audit: sink,
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey,
      now: () => new Date("2026-08-14T23:05:00.000Z"),
    });

    const results: PayResult[] = [];
    for (let i = 0; i < 50; i++) {
      results.push(await corrected.pay(request));
    }

    expect(results.filter((result) => result.status === "settled")).toHaveLength(10);
    expect(results.filter((result) => result.status === "blocked")).toHaveLength(40);
    expect(corrected.state().windows["daily:2026-08-14"]?.spentMinor).toBe(500_000n);
    expect(corrected.state().windows["daily:2026-08-15"]?.spentMinor).toBe(10_000n);
  });

  it("keeps each day's spend separate as the clock moves back and forth", async () => {
    const sink = memoryAuditSink();
    let at = new Date("2026-08-14T12:00:00.000Z");
    const guard = await createGuard({
      policy: policy(), adapters: [fakeAdapter()], audit: sink,
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey, now: () => at,
    });

    await guard.pay({ ...request, amount: "0.10" });
    at = new Date("2026-08-16T12:00:00.000Z");
    await guard.pay({ ...request, amount: "0.10" });
    at = new Date("2026-08-14T13:00:00.000Z");
    await guard.pay({ ...request, amount: "0.10" });

    expect(guard.state().windows["daily:2026-08-14"]?.spentMinor).toBe(200_000n);
    expect(guard.state().windows["daily:2026-08-16"]?.spentMinor).toBe(100_000n);
  });
});

// I1: a caller-supplied value in violation.message reached stdout unescaped and unbounded.
describe("hostile request values never travel in a violation message", () => {
  const hostile: [string, Record<string, unknown>][] = [
    ["amount", { amount: `1.00${ANSI_FORGE}` }],
    ["currency", { currency: `USDC${ANSI_FORGE}` }],
    ["to", { to: `https://${ANSI_FORGE}` }],
    ["via", { via: `fake${ANSI_FORGE}` }],
  ];

  for (const [field, override] of hostile) {
    it(`keeps a hostile ${field} out of the message and out of the log`, async () => {
      const sink = memoryAuditSink();
      const { guard } = await guardWith(fakeAdapter(), sink);
      const result = await guard.pay({ ...request, ...override } as never);

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        return;
      }
      expect(hasControlChars(result.violation.message)).toBe(false);
      expect(result.violation.message).not.toContain("forged");
      expect(result.violation.message.length).toBeLessThanOrEqual(201);

      for (const value of Object.values(result.violation.detail ?? {})) {
        expect(hasControlChars(value)).toBe(false);
        expect(value.length).toBeLessThanOrEqual(121);
      }

      expect(hasControlChars(JSON.stringify(sink.entries.at(-1)!.violation))).toBe(false);
    });
  }

  it("bounds and de-escapes an unbounded vendor a check reports", async () => {
    const sink = memoryAuditSink();
    const { guard } = await guardWith(fakeAdapter(), sink);
    const result = await guard.pay({ ...request, to: `evil${ANSI_FORGE}${"x".repeat(5000)}` });

    expect(blockedCode(result)).toBe("vendor_not_allowed");
    if (result.status === "blocked") {
      expect(result.violation.detail?.["vendor"]?.length).toBeLessThanOrEqual(121);
      expect(hasControlChars(result.violation.detail?.["vendor"] ?? "")).toBe(false);
    }
    expect(hasControlChars(JSON.stringify(sink.entries.at(-1)!.violation))).toBe(false);
  });
});

// I2: a broadcast the rail could not confirm was logged as failed with no signature at all.
describe("an unconfirmed broadcast is recorded as uncertain", () => {
  function timeoutAdapter(): WalletAdapter {
    return fakeAdapter({
      execute: vi.fn(async () => {
        throw Object.assign(new Error("transaction sig-xyz did not confirm: no ruling within 90000ms"), {
          code: "timeout",
          unconfirmedSignature: "sig-xyz",
        });
      }),
    });
  }

  it("records the signature, the error, and the spend", async () => {
    const sink = memoryAuditSink();
    const { guard } = await guardWith(timeoutAdapter(), sink);
    const result = await guard.pay(request);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("timeout");
      expect(result.error.txSig).toBe("sig-xyz");
    }
    const entry = sink.entries.at(-1)!;
    expect(entry.outcome).toBe("uncertain");
    expect(entry.txSig).toBe("sig-xyz");
    expect(entry.error?.code).toBe("timeout");
    expect(entry.error?.message).toContain("did not confirm");
    expect(guard.state().windows["daily:2026-08-13"]?.spentMinor).toBe(50_000n);
    expect(await verifyAuditLog(sink.entries, keys.publicKey)).toEqual({ ok: true, checked: 1 });
  });

  it("survives a restart with the uncertain spend still counted", async () => {
    const sink = memoryAuditSink();
    const { guard } = await guardWith(timeoutAdapter(), sink);
    await guard.pay(request);

    const restarted = await createGuard({
      policy: policy(), adapters: [fakeAdapter()], audit: sink,
      agent: "demo-agent", logId: LOG_ID, signingKey: keys.privateKey, now: clock,
    });
    expect(restarted.state().windows["daily:2026-08-13"]?.spentMinor).toBe(50_000n);
  });

  it("still records a definite rail failure as failed and spends nothing", async () => {
    const sink = memoryAuditSink();
    const { guard } = await guardWith(
      fakeAdapter({
        execute: vi.fn(async () => {
          throw Object.assign(new Error("the cluster rejected it"), { signature: "sig-rejected" });
        }),
      }),
      sink,
    );
    await guard.pay(request);

    expect(sink.entries.at(-1)!.outcome).toBe("failed");
    expect(sink.entries.at(-1)!.txSig).toBeNull();
    expect(sink.entries.at(-1)!.error?.code).toBe("adapter_error");
    expect(guard.state().windows["daily:2026-08-13"]?.spentMinor ?? 0n).toBe(0n);
  });

  it("refuses a signature shaped like an injected line rather than logging it", async () => {
    const sink = memoryAuditSink();
    const { guard } = await guardWith(
      fakeAdapter({
        execute: vi.fn(async () => {
          throw Object.assign(new Error("no ruling"), {
            code: "timeout",
            unconfirmedSignature: `sig${ANSI_FORGE}`,
          });
        }),
      }),
      sink,
    );
    const result = await guard.pay(request);

    expect(result.status).toBe("failed");
    expect(sink.entries.at(-1)!.outcome).toBe("failed");
    expect(sink.entries.at(-1)!.txSig).toBeNull();
    expect(hasControlChars(JSON.stringify(sink.entries.at(-1)))).toBe(false);
  });
});

// I3: the kill switch was queued behind whatever payment the rail was still working on.
describe("guard.freeze closes before it is written", () => {
  it("returns while a payment is still in flight, and blocks what follows", async () => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedRail = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const adapter = fakeAdapter({
      execute: vi.fn(async (req: SettlementRequest) => {
        entered();
        await held;
        return { txSig: `sig-${req.amountMinor}`, rail: "fake" };
      }),
    });
    const sink = memoryAuditSink();
    const { guard } = await guardWith(adapter, sink);

    const inFlight = guard.pay(request);
    await reachedRail;
    const queued = guard.pay(request);

    let paymentResolved = false;
    void inFlight.then(() => {
      paymentResolved = true;
    });

    // Queued behind the payment, this await would never return until `release` below.
    await guard.freeze();
    expect(paymentResolved).toBe(false);
    expect(guard.state().frozen).toBe(true);

    release();
    expect((await inFlight).status).toBe("settled");
    expect(blockedCode(await queued)).toBe("kill_switch");
    await guard.flush();
    expect(sink.entries.map((entry) => entry.outcome)).toEqual(["settled", "blocked", "settled"]);
    expect(await verifyAuditLog(sink.entries, keys.publicKey)).toEqual({ ok: true, checked: 3 });
  });

  it("keeps payments serialized: 40 racing pays against a budget of 10 settle exactly 10", async () => {
    const { guard } = await guardWith(fakeAdapter());
    const results = await Promise.all(Array.from({ length: 40 }, () => guard.pay(request)));
    expect(results.filter((result) => result.status === "settled")).toHaveLength(10);
    expect(results.filter((result) => result.status === "blocked")).toHaveLength(30);
  });
});

/**
 * A store for the tests that never grant, so adding a method to ApprovalStore does not mean
 * editing every literal in this file. It meant exactly that once: `npm test` stayed green
 * because vitest transpiles without type-checking, and only `tsc` noticed.
 */
function stubApprovalStore(overrides: Partial<ApprovalStore>): ApprovalStore {
  return {
    async grant() {
      throw new Error("this stub does not grant");
    },
    async find() {
      return null;
    },
    async consume() {},
    ...overrides,
  };
}

describe("approval gate", () => {
  const approvalPolicy = { ...policy(), approvals: { above: "0.05" } };

  function pendingApproval(): Approval {
    return {
      agent: "demo-agent",
      vendorNormalized: "api.weather.com",
      amountMinor: 100_000n,
      id: "apr_1",
      expiresAt: "2999-01-01T00:00:00.000Z",
      usedAt: null,
    };
  }

  it("blocks a payment above the threshold when no approval exists", async () => {
    const guard = await makeGuard({ policy: approvalPolicy, approvals: memoryApprovalStore([]) });
    const result = await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.violation.code).toBe("approval_required");
    expect(result.auditId).not.toBe("");
  });

  it("lets a payment at exactly the threshold through untouched", async () => {
    const guard = await makeGuard({ policy: approvalPolicy, approvals: memoryApprovalStore([]) });
    const result = await guard.pay({ to: "https://api.weather.com/f", amount: "0.05", currency: "USDC", reason: "r" });

    expect(result.status).toBe("settled");
  });

  it("settles one minor unit below the threshold and blocks one above", async () => {
    const guard = await makeGuard({ policy: approvalPolicy, approvals: memoryApprovalStore([]) });
    const req = { to: "https://api.weather.com/f", currency: "USDC" as const, reason: "r" };

    const below = await guard.pay({ ...req, amount: "0.049999" });
    const above = await guard.pay({ ...req, amount: "0.050001" });

    expect(below.status).toBe("settled");
    expect(above.status).toBe("blocked");
    if (above.status !== "blocked") throw new Error("expected blocked");
    expect(above.violation.code).toBe("approval_required");
  });

  it("settles once an approval exists and spends it", async () => {
    const store = memoryApprovalStore([pendingApproval()]);
    const guard = await makeGuard({ policy: approvalPolicy, approvals: store });
    const result = await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    expect(result.status).toBe("settled");
    expect(store.approvals[0]?.usedAt).not.toBeNull();
  });

  it("blocks a second payment on a spent approval", async () => {
    const store = memoryApprovalStore([pendingApproval()]);
    const guard = await makeGuard({ policy: approvalPolicy, approvals: store });
    const req = { to: "https://api.weather.com/f", amount: "0.10", currency: "USDC" as const, reason: "r" };

    expect((await guard.pay(req)).status).toBe("settled");
    const second = await guard.pay(req);

    expect(second.status).toBe("blocked");
    if (second.status !== "blocked") throw new Error("expected blocked");
    expect(second.violation.code).toBe("approval_required");
  });

  it("consumes the approval before the rail is called", async () => {
    const order: string[] = [];
    const store = memoryApprovalStore([pendingApproval()]);
    const wrapped = stubApprovalStore({
      find: store.find.bind(store),
      consume: async (id: string) => {
        order.push("consume");
        await store.consume(id);
      },
    });
    const adapter = stubAdapter(async () => {
      order.push("execute");
      return { txSig: "sig", rail: "solana" };
    });
    const guard = await makeGuard({ policy: approvalPolicy, approvals: wrapped, adapters: [adapter] });

    await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    expect(order).toEqual(["consume", "execute"]);
  });

  it("keeps the approval spent when the rail then fails", async () => {
    const store = memoryApprovalStore([pendingApproval()]);
    const adapter = stubAdapter(async () => {
      throw new Error("rail down");
    });
    const guard = await makeGuard({ policy: approvalPolicy, approvals: store, adapters: [adapter] });

    expect((await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" })).status).toBe("failed");
    expect(store.approvals[0]?.usedAt).not.toBeNull();
  });

  it("blocks with approval_unavailable when the store cannot be read", async () => {
    const broken = stubApprovalStore({
      find: async () => {
        throw new Error("store down");
      },
      consume: async () => undefined,
    });
    const guard = await makeGuard({ policy: approvalPolicy, approvals: broken });
    const result = await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.violation.code).toBe("approval_unavailable");
  });

  it("keeps paying below the threshold while the store is down", async () => {
    const broken = stubApprovalStore({
      find: async () => {
        throw new Error("store down");
      },
      consume: async () => undefined,
    });
    const guard = await makeGuard({ policy: approvalPolicy, approvals: broken });

    expect((await guard.pay({ to: "https://api.weather.com/f", amount: "0.01", currency: "USDC", reason: "r" })).status).toBe("settled");
  });

  it("blocks with approval_unavailable when the approval cannot be claimed", async () => {
    const store = memoryApprovalStore([pendingApproval()]);
    const adapter = fakeAdapter();
    const wrapped = stubApprovalStore({
      find: store.find.bind(store),
      consume: async () => {
        throw new Error("store down");
      },
    });
    const guard = await makeGuard({ policy: approvalPolicy, approvals: wrapped, adapters: [adapter] });

    const result = await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    // Not `approval_required`: the guard cannot tell a lost race from a broken store, and that
    // violation is signed into the audit log as a claim about a human's approval.
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.violation.code).toBe("approval_unavailable");
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("keeps paying below the threshold after a claim failed, so nothing latches", async () => {
    const store = memoryApprovalStore([pendingApproval()]);
    const wrapped = stubApprovalStore({
      find: store.find.bind(store),
      consume: async () => {
        throw new Error("store down");
      },
    });
    const guard = await makeGuard({ policy: approvalPolicy, approvals: wrapped });

    await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    expect((await guard.pay({ to: "https://api.weather.com/f", amount: "0.01", currency: "USDC", reason: "r" })).status).toBe("settled");
  });

  it("blocks a payment frozen while the approval gate was still running", async () => {
    const store = memoryApprovalStore([pendingApproval()]);
    const adapter = fakeAdapter();
    let guard: Guard;
    const wrapped = stubApprovalStore({
      find: async (key) => {
        const found = await store.find(key);
        await guard.freeze();
        return found;
      },
      consume: store.consume.bind(store),
    });
    guard = await makeGuard({ policy: approvalPolicy, approvals: wrapped, adapters: [adapter] });

    const result = await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.violation.code).toBe("kill_switch");
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("refuses to construct a guard whose threshold has no store behind it", async () => {
    await expect(makeGuard({ policy: approvalPolicy })).rejects.toThrow(/approval/i);
  });

  it("ignores a store when the policy sets no threshold", async () => {
    const store = memoryApprovalStore([]);
    const guard = await makeGuard({ policy: policy(), approvals: store });

    expect((await guard.pay({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" })).status).toBe("settled");
  });
});

describe("check", () => {
  const approvalPolicy = { ...policy(), approvals: { above: "0.05" } };

  it("allows a payment the policy permits", async () => {
    const guard = await makeGuard({});
    expect(await guard.check({ to: "https://api.weather.com/f", amount: "0.01", currency: "USDC", reason: "r" }))
      .toEqual({ status: "allowed" });
  });

  it("reports the same violation pay would", async () => {
    const guard = await makeGuard({});
    const result = await guard.check({ to: "https://evil.example/f", amount: "0.01", currency: "USDC", reason: "r" });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.violation.code).toBe("vendor_not_allowed");
  });

  it("reports approval_required for a payment that would be held", async () => {
    const guard = await makeGuard({ policy: approvalPolicy, approvals: memoryApprovalStore([]) });
    const result = await guard.check({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.violation.code).toBe("approval_required");
  });

  it("allows a payment an unspent approval covers, and does not spend it", async () => {
    const store = memoryApprovalStore([]);
    const guard = await makeGuard({ policy: approvalPolicy, approvals: store });
    await store.grant({
      agent: "demo-agent",
      vendorNormalized: "api.weather.com",
      amountMinor: 100_000n,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    expect((await guard.check({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" })).status)
      .toBe("allowed");
    expect(store.approvals[0]?.usedAt).toBeNull();
  });

  it("writes nothing to the audit log", async () => {
    const sink = memoryAuditSink();
    const guard = await makeGuard({ audit: sink });
    await guard.check({ to: "https://api.weather.com/f", amount: "0.01", currency: "USDC", reason: "r" });

    expect(sink.entries).toHaveLength(0);
  });

  it("consumes no budget", async () => {
    const guard = await makeGuard({});
    const before = guard.state();
    await guard.check({ to: "https://api.weather.com/f", amount: "0.01", currency: "USDC", reason: "r" });

    expect(guard.state()).toEqual(before);
  });

  it("reports an invalid request rather than throwing", async () => {
    const guard = await makeGuard({});
    const result = await guard.check({ to: "https://api.weather.com/f", amount: "-1", currency: "USDC", reason: "r" });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.violation.code).toBe("invalid_request");
  });

  // The reason this exists at all: a dry run that disagrees with the real thing is worse
  // than no dry run.
  it("agrees with pay across every refusal", async () => {
    const cases = [
      { name: "fine", amount: "0.01", to: "https://api.weather.com/f" },
      { name: "over per-tx", amount: "9.99", to: "https://api.weather.com/f" },
      { name: "vendor", amount: "0.01", to: "https://evil.example/f" },
    ];

    for (const c of cases) {
      const guard = await makeGuard({});
      const req = { to: c.to, amount: c.amount, currency: "USDC" as const, reason: "r" };
      const checked = await guard.check(req);
      const paid = await guard.pay(req);

      if (checked.status === "allowed") {
        expect(paid.status, c.name).toBe("settled");
      } else {
        expect(paid.status, c.name).toBe("blocked");
        if (paid.status !== "blocked") throw new Error("expected blocked");
        expect(checked.violation.code, c.name).toBe(paid.violation.code);
      }
    }
  });

  it("agrees with pay when the payment needs approval", async () => {
    const guard = await makeGuard({ policy: approvalPolicy, approvals: memoryApprovalStore([]) });
    const req = { to: "https://api.weather.com/f", amount: "0.10", currency: "USDC" as const, reason: "r" };
    const checked = await guard.check(req);
    const paid = await guard.pay(req);

    if (checked.status !== "blocked" || paid.status !== "blocked") throw new Error("expected both blocked");
    expect(checked.violation.code).toBe(paid.violation.code);
  });

  it("blocks when the guard is frozen", async () => {
    const guard = await makeGuard({});
    await guard.freeze();
    const result = await guard.check({ to: "https://api.weather.com/f", amount: "0.01", currency: "USDC", reason: "r" });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.violation.code).toBe("kill_switch");
  });

  it("blocks when a freeze lands while the store is being read", async () => {
    const store = memoryApprovalStore([]);
    let guard: Guard;
    const racing: ApprovalStore = {
      grant: store.grant.bind(store),
      consume: store.consume.bind(store),
      find: async (key) => {
        await guard.freeze();
        return store.find(key);
      },
    };
    guard = await makeGuard({ policy: approvalPolicy, approvals: racing });

    const result = await guard.check({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.violation.code).toBe("kill_switch");
  });

  it("refuses a granted approval carrying no id, as pay does", async () => {
    const store = memoryApprovalStore([]);
    const granted = await store.grant({
      agent: "demo-agent",
      vendorNormalized: "api.weather.com",
      amountMinor: 100_000n,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    const broken: ApprovalStore = {
      grant: store.grant.bind(store),
      consume: store.consume.bind(store),
      find: async () => ({ ...granted, id: "" }),
    };
    const guard = await makeGuard({ policy: approvalPolicy, approvals: broken });

    const result = await guard.check({ to: "https://api.weather.com/f", amount: "0.10", currency: "USDC", reason: "r" });
    expect(result.status).toBe("blocked");
  });
});

describe("velocity through the guard", () => {
  const vPolicy = { ...policy(), velocity: [{ window: "10m", maxPayments: 2 }] };
  const req = { to: "https://api.weather.com/f", amount: "0.01", currency: "USDC" as const, reason: "r" };

  it("blocks the payment past the cap, and refusals do not extend the window", async () => {
    const guard = await makeGuard({ policy: vPolicy });
    expect((await guard.pay(req)).status).toBe("settled");
    expect((await guard.pay(req)).status).toBe("settled");
    const third = await guard.pay(req);
    expect(third.status).toBe("blocked");
    if (third.status !== "blocked") throw new Error("expected blocked");
    expect(third.violation.code).toBe("velocity_exceeded");
    // Hammering while blocked must not change the answer's cause: still velocity, not worse.
    for (let i = 0; i < 5; i += 1) {
      const again = await guard.pay(req);
      expect(again.status).toBe("blocked");
      if (again.status !== "blocked") throw new Error("expected blocked");
      expect(again.violation.code).toBe("velocity_exceeded");
    }
  });

  it("survives a restart: a fresh guard over the same log starts blocked", async () => {
    const sink = memoryAuditSink();
    const first = await makeGuard({ policy: vPolicy, audit: sink });
    await first.pay(req);
    await first.pay(req);
    await first.flush();

    const second = await makeGuard({ policy: vPolicy, audit: sink });
    const result = await second.pay(req);
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.violation.code).toBe("velocity_exceeded");
  });

  it("check agrees with pay", async () => {
    const guard = await makeGuard({ policy: vPolicy });
    await guard.pay(req);
    await guard.pay(req);
    const checked = await guard.check(req);
    const paid = await guard.pay(req);
    if (checked.status !== "blocked" || paid.status !== "blocked") throw new Error("expected both blocked");
    expect(checked.violation.code).toBe(paid.violation.code);
  });
});

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { memoryAnchorStore, sealAnchor, verifyAnchor } from "../src/audit/anchor.js";
import { verifyAuditLog } from "../src/audit/entry.js";
import { memoryAuditSink, type MemoryAuditSink } from "../src/audit/memorySink.js";
import { createGuard, type Guard, type GuardOptions } from "../src/guard.js";
import type { AnchorStore, Policy, SettlementRequest, WalletAdapter } from "../src/types.js";

const keys = generateKeyPairSync("ed25519");

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

async function guardWith(adapter: WalletAdapter, sink = memoryAuditSink()) {
  const guard = await createGuard({
    policy: policy(),
    adapters: [adapter],
    audit: sink,
    agent: "demo-agent",
    signingKey: keys.privateKey,
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  return { guard, sink };
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
        signingKey: keys.privateKey,
        requirePersistedState: true,
      }),
    ).rejects.toThrow(/replay/);
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
    expect(guard.state().windows["daily"]?.spentMinor ?? 0n).toBe(0n);
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

    const second = await guardWith(fakeAdapter(), sink);
    expect(second.guard.state().frozen).toBe(true);
  });

  it("keeps appending to the same log identity after a restart", async () => {
    const sink = memoryAuditSink();
    const first = await guardWith(fakeAdapter(), sink);
    await first.guard.pay(request);

    const second = await guardWith(fakeAdapter(), sink);
    await second.guard.pay(request);

    expect(new Set(sink.entries.map((e) => e.logId)).size).toBe(1);
    expect(await verifyAuditLog(sink.entries, keys.publicKey)).toEqual({ ok: true, checked: 2 });
  });
});

describe("audit trail", () => {
  it("writes a verifiable entry for settled, blocked, and failed attempts", async () => {
    const sink = memoryAuditSink();
    const { guard } = await guardWith(fakeAdapter(), sink);
    await guard.pay(request);
    await guard.pay({ ...request, to: "https://evil.example/x" });
    await guard.freeze();

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
  const clock = () => new Date("2026-08-13T12:00:00.000Z");

  it("keeps a policy freeze sticky over a logged unfreeze", async () => {
    const sink = memoryAuditSink();
    const first = await guardWith(fakeAdapter(), sink);
    await first.guard.freeze();
    await first.guard.unfreeze();
    expect(first.guard.state().frozen).toBe(false);

    const second = await createGuard({
      policy: { ...policy(), killSwitch: { frozen: true } },
      adapters: [fakeAdapter()],
      audit: sink,
      agent: "demo-agent",
      signingKey: keys.privateKey,
      now: clock,
    });
    expect(second.state().frozen).toBe(true);
    const result = await second.pay(request);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.violation.code).toBe("kill_switch");
    }
  });

  it("keeps a logged freeze sticky over a policy that claims unfrozen", async () => {
    const sink = memoryAuditSink();
    const first = await guardWith(fakeAdapter(), sink);
    await first.guard.freeze();

    const second = await guardWith(fakeAdapter(), sink);
    expect(second.guard.state().frozen).toBe(true);
  });

  it("returns invalid_request when a check throws on a policy mutated after construction", async () => {
    const live = policy();
    const adapter = fakeAdapter();
    const guard = await createGuard({
      policy: live,
      adapters: [adapter],
      audit: memoryAuditSink(),
      agent: "demo-agent",
      signingKey: keys.privateKey,
      now: clock,
    });

    live.budgets[0]!.limit = "not-a-number";
    const result = await guard.pay(request);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.violation.code).toBe("invalid_request");
    }
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("rejects a non-positive amount at the boundary", async () => {
    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter);
    const result = await guard.pay({ ...request, amount: "0.00" });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.violation.code).toBe("invalid_request");
    }
    expect(adapter.execute).toHaveBeenCalledTimes(0);
  });

  it("returns invalid_request for an unknown adapter name", async () => {
    const adapter = fakeAdapter();
    const { guard } = await guardWith(adapter);
    const result = await guard.pay({ ...request, via: "nope" });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.violation.code).toBe("invalid_request");
    }
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
  const clock = () => new Date("2026-08-13T12:00:00.000Z");

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
    expect(anchor!.logId).toBe(sink.entries[0]!.logId);
    expect(verifyAnchor(anchor!, keys.publicKey)).toBe(true);
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
        signingKey: keys.privateKey,
        anchor: memoryAnchorStore(),
      }),
    ).rejects.toThrow(/anchor/);
  });
});

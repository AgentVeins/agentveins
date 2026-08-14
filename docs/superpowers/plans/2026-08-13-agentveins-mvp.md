# AgentVeins MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@agentveins/core` plus a Solana devnet adapter and a two-minute terminal demo proving that an agent hits its aggregate daily budget, gets blocked with a structured violation, gets frozen by a kill switch, and that every attempt lands in an audit log whose tampering is demonstrably detected.

**Architecture:** A monorepo of npm workspaces. `packages/core` is a pure-TypeScript policy engine with zero runtime dependencies: an ordered array of pure check functions evaluates every payment before any chain call happens. Spend counters are not stored separately — they are replayed from the signed, hash-chained JSONL audit log at startup, so restarting an agent cannot reset its budget. Chains plug in behind a `WalletAdapter` interface; `adapter-solana` implements it twice over one shared signing path (`direct` submits the transaction itself, `x402` hands it to a facilitator).

**Tech Stack:** TypeScript 5 (strict, ESM/NodeNext), Node 20+, Vitest, tsx, `node:crypto` (ed25519 + sha256), `@solana/kit`, `@solana-program/token`, `@x402/core`, `@x402/svm`, Express (demo only).

**Source spec:** `docs/superpowers/specs/2026-08-12-agentveins-mvp-design.md`. Read it before Task 1.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 20+**, TypeScript **strict**, ESM throughout (`"type": "module"`, `module`/`moduleResolution` = `NodeNext`).
- **Money is `bigint` minor units at every internal seam.** USDC has 6 decimals. `Number` never touches an amount. Decimal strings (`"25.00"`) exist only at the public API boundary and are parsed exactly once, in `money.ts`.
- **`packages/core` has zero runtime dependencies.** It may import `node:crypto` and — in the file sink only — `node:fs/promises`. It imports nothing chain-specific: no `viem`, no `@solana/*`, no fetch to any rail.
- **Adapters never import each other.** They depend only on `@agentveins/core` types.
- **No `console.log` in library code.** `examples/demo` may write to stdout — that is its UI.
- **Fail fast on shape, fail soft on payments.** Invalid policy shapes throw at construction. Payment-time problems return structured results; policy denial never throws.
- **Approved dependency list, exhaustive.** `core`: none. `adapter-solana`: `@x402/core`, `@x402/svm`, `@solana/kit`, `@solana-program/token`. `examples/demo`: `express`. Dev-only, root: `typescript`, `vitest`, `tsx`, `@types/node`, `@types/express`. **Anything else requires asking the user first.**
- **Conventional Commits.** `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `build:`, `ci:`. Scope where it clarifies (`feat(core):`). Breaking pre-1.0 changes use `!`.
- **No AI attribution anywhere** in commits, git history, or PR descriptions.
- **No inline comments** except short ones explaining a genuinely non-obvious choice, plus `// TODO` markers.
- Active voice in prose. `camelCase` for variables, `PascalCase` for types and interfaces.
- **Untrusted input:** `vendor` and `reason` come from callers. Store them verbatim, never interpolate them into violation *messages* (structured `detail` fields are fine), and escape/truncate them on display.
- Budget windows are **UTC calendar days**. Never local time, never rolling 24h.

## File Structure

```
package.json                        workspaces root, dev deps, scripts
tsconfig.base.json                  strict compiler options shared by all packages
vitest.config.ts                    test discovery
.gitignore  .env.example
.claude/settings.json               attribution suppression
.github/workflows/ci.yml

packages/core/
  package.json  tsconfig.json
  src/index.ts                      public surface — the only file consumers import
  src/types.ts                      every shared type and interface; no logic
  src/money.ts                      parseAmount / formatAmount
  src/policy.ts                     validatePolicy
  src/vendor.ts                     normalizeVendor
  src/state.ts                      SpendState, windowKey, emptyState, applyEntry, replay
  src/checks/killSwitch.ts          killSwitchCheck
  src/checks/allowlist.ts           allowlistCheck
  src/checks/budget.ts              budgetCheck
  src/checks/index.ts               CHECKS — the ordered array
  src/audit/entry.ts                canonicalize, hashEntry, signHash, verifyEntry, verifyAuditLog
  src/audit/memorySink.ts           memoryAuditSink
  src/audit/fileSink.ts             fileAuditSink (touches node:fs)
  src/audit/anchor.ts               AnchorStore impls: memoryAnchorStore, fileAnchorStore
  src/guard.ts                      createGuard, pay, freeze, unfreeze, state
  test/*.test.ts                    one test file per src module

packages/adapter-solana/
  src/index.ts                      solanaAdapter factory, mode dispatch
  src/transfer.ts                   shared: resolve ATA, build + sign the USDC transfer
  src/direct.ts                     submit via RPC, confirm
  src/x402.ts                       402 handshake, price-mismatch guard, X-PAYMENT
  test/*.test.ts

packages/adapter-base/src/index.ts        stub, throws NotImplementedError
packages/adapter-cloudflare/src/index.ts  stub, throws NotImplementedError

examples/demo/
  src/vendor.ts                     Express server exposing a 402-protected endpoint
  src/mockAdapter.ts                offline WalletAdapter for --mock and CI
  src/demo.ts                       the five-act agent loop
```

Each `src` file owns one responsibility and stays small enough to read in one sitting. `types.ts` holds no logic, so every other module can import from it without cycles.

---

### Task 1: Repo scaffolding

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `.claude/settings.json`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `packages/core/test/scaffolding.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm install` / `npm run build` / `npm test` loop that every later task relies on.

- [ ] **Step 1: Create the workspace root**

`package.json`:

```json
{
  "name": "agentveins",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "workspaces": ["packages/*", "examples/*"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "demo": "npm run demo --workspace=@agentveins/demo"
  }
}
```

- [ ] **Step 2: Install dev dependencies**

Run: `npm install -D typescript vitest tsx @types/node`

Let npm resolve current versions rather than pinning by hand. Do not add anything not on the approved dependency list.

- [ ] **Step 3: Create the shared compiler config**

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "skipLibCheck": true
  }
}
```

`noUncheckedIndexedAccess` is deliberate: it forces every lookup of a budget window to handle "this window does not exist yet", which is exactly the bug class that would silently grant an agent unlimited spend.

`tsconfig.json` at the root, for `tsc --build`:

```json
{
  "files": [],
  "references": [{ "path": "packages/core" }]
}
```

- [ ] **Step 4: Create the core package**

`packages/core/package.json`:

```json
{
  "name": "@agentveins/core",
  "version": "0.0.1",
  "description": "Spend governance for AI agents: budgets, allowlists, kill switch, signed audit log.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./sinks/file": "./dist/audit/fileSink.js"
  },
  "files": ["dist"],
  "scripts": { "build": "tsc --build" }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/core/src/index.ts`:

```ts
export const VERSION = "0.0.1";
```

- [ ] **Step 5: Create the test config and a scaffolding test**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
  },
});
```

`packages/core/test/scaffolding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("scaffolding", () => {
  it("exports a version and compiles under strict mode", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
```

- [ ] **Step 6: Create the ignore and env files**

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.env
audit.jsonl
operator.key.pem
```

`.env.example`:

```
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_KEYPAIR_PATH=./devnet-keypair.json
USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
X402_FACILITATOR_URL=https://x402.org/facilitator
VENDOR_PORT=3001
VENDOR_ADDRESS=
```

The demo generates its own ephemeral operator signing key, so no key path appears here. A production operator supplies a persistent `signingKey`; nothing in this repo ever holds one.

`.claude/settings.json`:

```json
{ "attribution": { "commit": "", "pr": "" } }
```

- [ ] **Step 7: Verify the whole loop**

Run: `npm run build && npm test`
Expected: build succeeds, one passing test.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "build: scaffold npm workspaces, strict tsconfig, and vitest"
```

---

### Task 2: Money parsing

Every downstream module depends on this being exactly right, so it goes first.

**Files:**
- Create: `packages/core/src/money.ts`
- Test: `packages/core/test/money.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseAmount(value: string, decimals?: number): bigint`, `formatAmount(minor: bigint, decimals?: number): string`, `USDC_DECIMALS: number`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount } from "../src/money.js";

describe("parseAmount", () => {
  it("parses whole and fractional amounts to 6-decimal minor units", () => {
    expect(parseAmount("25.00")).toBe(25_000_000n);
    expect(parseAmount("0.05")).toBe(50_000n);
    expect(parseAmount("1")).toBe(1_000_000n);
    expect(parseAmount("0.000001")).toBe(1n);
    expect(parseAmount("0")).toBe(0n);
  });

  it("trims surrounding whitespace", () => {
    expect(parseAmount("  1.5  ")).toBe(1_500_000n);
  });

  it("rejects anything that is not a plain non-negative decimal", () => {
    for (const bad of ["", "   ", "abc", "1e3", "-1.00", "1.", ".5", "1,000", "NaN", "Infinity"]) {
      expect(() => parseAmount(bad), bad).toThrow(RangeError);
    }
  });

  it("rejects more precision than the currency has", () => {
    expect(() => parseAmount("0.0000001")).toThrow(RangeError);
  });

  it("rejects non-string input", () => {
    expect(() => parseAmount(5 as unknown as string)).toThrow(TypeError);
  });
});

describe("formatAmount", () => {
  it("renders minor units as a decimal string", () => {
    expect(formatAmount(25_000_000n)).toBe("25.000000");
    expect(formatAmount(50_000n)).toBe("0.050000");
    expect(formatAmount(0n)).toBe("0.000000");
    expect(formatAmount(1n)).toBe("0.000001");
  });

  it("round-trips through parseAmount", () => {
    for (const minor of [0n, 1n, 50_000n, 25_000_000n, 999_999_999_999n]) {
      expect(parseAmount(formatAmount(minor))).toBe(minor);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/money.test.ts`
Expected: FAIL — cannot resolve `../src/money.js`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/money.ts`:

```ts
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
  const digits = minor.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
```

The regex rejects negatives, exponent notation, thousands separators, and the empty string in one pass, which is why no separate checks appear below it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/money.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/money.ts packages/core/test/money.test.ts
git commit -m "feat(core): parse and format USDC amounts as bigint minor units"
```

---

### Task 3: Types, policy validation, and vendor normalization

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/policy.ts`, `packages/core/src/vendor.ts`
- Test: `packages/core/test/policy.test.ts`, `packages/core/test/vendor.test.ts`

**Interfaces:**
- Consumes: `parseAmount` from Task 2.
- Produces: every shared type (below), plus `validatePolicy(policy: Policy): void` and `normalizeVendor(to: string): string`.

- [ ] **Step 1: Write the type module**

`packages/core/src/types.ts` — no logic lives here, so nothing imports it circularly:

```ts
export type Currency = "USDC";
export type BudgetPeriod = "per_tx" | "daily";

export interface Budget {
  period: BudgetPeriod;
  limit: string;
  currency: Currency;
}

export interface VendorPolicy {
  mode: "allowlist";
  entries: string[];
}

export interface KillSwitch {
  frozen: boolean;
}

export interface Policy {
  budgets: Budget[];
  vendors: VendorPolicy;
  killSwitch: KillSwitch;
}

export type ViolationCode =
  | "kill_switch"
  | "vendor_not_allowed"
  | "budget_exceeded"
  | "invalid_request";

export interface Violation {
  code: ViolationCode;
  message: string;
  detail?: Record<string, string>;
}

export type PaymentErrorCode =
  | "adapter_error"
  | "price_mismatch"
  | "insufficient_funds"
  | "timeout";

export interface PaymentError {
  code: PaymentErrorCode;
  message: string;
}

export interface PayRequest {
  to: string;
  amount: string;
  currency: Currency;
  reason: string;
  via?: string;
}

export type PayResult =
  | { status: "settled"; txSig: string; auditId: string }
  | { status: "blocked"; violation: Violation; auditId: string }
  | { status: "failed"; error: PaymentError; auditId: string };

export interface SettlementRequest {
  to: string;
  amountMinor: bigint;
  reason: string;
}

export interface SettlementReceipt {
  txSig: string;
  rail: string;
  raw?: unknown;
}

export interface WalletAdapter {
  readonly name: string;
  readonly currency: Currency;
  execute(req: SettlementRequest): Promise<SettlementReceipt>;
}

export type AuditOutcome = "settled" | "blocked" | "failed";
export type AuditKind = "payment" | "control";

export interface AuditEntry {
  id: string;
  seq: number;
  ts: string;
  kind: AuditKind;
  agent: string;
  vendor: string;
  vendorNormalized: string;
  rail: string | null;
  amountMinor: string;
  currency: Currency;
  reason: string;
  outcome: AuditOutcome;
  violation: Violation | null;
  txSig: string | null;
  prevHash: string;
  hash: string;
  sig: string;
}

export type UnsignedAuditEntry = Omit<AuditEntry, "hash" | "sig">;

export interface AuditSink {
  append(entry: AuditEntry): Promise<void>;
  read?(): AsyncIterable<AuditEntry>;
}

export interface WindowState {
  start: string;
  spentMinor: bigint;
}

export interface SpendState {
  frozen: boolean;
  windows: Record<string, WindowState>;
  seq: number;
  prevHash: string;
}

export interface PaymentContext {
  vendor: string;
  vendorNormalized: string;
  amountMinor: bigint;
  currency: Currency;
  reason: string;
  now: Date;
}

export type Check = (
  ctx: PaymentContext,
  policy: Policy,
  state: SpendState,
) => Violation | null;
```

Control entries carry the action in `reason` (`"freeze"` or `"unfreeze"`), `amountMinor: "0"`, an empty `vendor`, null `rail` and `txSig`, and `outcome: "settled"`.

- [ ] **Step 2: Write the failing validation tests**

`packages/core/test/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validatePolicy } from "../src/policy.js";
import type { Policy } from "../src/types.js";

function valid(): Policy {
  return {
    budgets: [
      { period: "daily", limit: "0.50", currency: "USDC" },
      { period: "per_tx", limit: "0.10", currency: "USDC" },
    ],
    vendors: { mode: "allowlist", entries: ["api.weather.com"] },
    killSwitch: { frozen: false },
  };
}

describe("validatePolicy", () => {
  it("accepts a well-formed policy", () => {
    expect(() => validatePolicy(valid())).not.toThrow();
  });

  it("rejects an unknown budget period", () => {
    const p = valid();
    (p.budgets[0] as { period: string }).period = "weekly";
    expect(() => validatePolicy(p)).toThrow(/unknown budget period/);
  });

  it("rejects duplicate budget periods", () => {
    const p = valid();
    p.budgets = [
      { period: "daily", limit: "1.00", currency: "USDC" },
      { period: "daily", limit: "2.00", currency: "USDC" },
    ];
    expect(() => validatePolicy(p)).toThrow(/duplicate budget period/);
  });

  it("rejects an empty budget list", () => {
    const p = valid();
    p.budgets = [];
    expect(() => validatePolicy(p)).toThrow(/non-empty/);
  });

  it("rejects unparseable, negative, and over-precise limits", () => {
    for (const limit of ["abc", "-1.00", "0.0000001"]) {
      const p = valid();
      p.budgets = [{ period: "daily", limit, currency: "USDC" }];
      expect(() => validatePolicy(p), limit).toThrow(RangeError);
    }
  });

  it("rejects an unsupported currency", () => {
    const p = valid();
    (p.budgets[0] as { currency: string }).currency = "EUR";
    expect(() => validatePolicy(p)).toThrow(/unsupported currency/);
  });

  it("rejects allowlist mode with no entries", () => {
    const p = valid();
    p.vendors.entries = [];
    expect(() => validatePolicy(p)).toThrow(/at least one vendor/);
  });

  it("rejects a non-boolean kill switch", () => {
    const p = valid();
    (p.killSwitch as { frozen: unknown }).frozen = "yes";
    expect(() => validatePolicy(p)).toThrow(TypeError);
  });
});
```

`packages/core/test/vendor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeVendor } from "../src/vendor.js";

describe("normalizeVendor", () => {
  it("reduces URLs to their lowercased hostname", () => {
    expect(normalizeVendor("https://api.weather.com/forecast?q=1")).toBe("api.weather.com");
    expect(normalizeVendor("HTTPS://API.WEATHER.COM/forecast")).toBe("api.weather.com");
    expect(normalizeVendor("http://localhost:3001/forecast")).toBe("localhost");
  });

  it("passes bare hostnames through unchanged", () => {
    expect(normalizeVendor("api.weather.com")).toBe("api.weather.com");
  });

  it("preserves the case of base58 addresses", () => {
    const address = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    expect(normalizeVendor(address)).toBe(address);
  });

  it("rejects empty vendors", () => {
    expect(() => normalizeVendor("   ")).toThrow(RangeError);
  });

  it("rejects malformed URLs", () => {
    expect(() => normalizeVendor("https://")).toThrow(RangeError);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/policy.test.ts packages/core/test/vendor.test.ts`
Expected: FAIL — cannot resolve `../src/policy.js` and `../src/vendor.js`.

- [ ] **Step 4: Write the implementations**

`packages/core/src/policy.ts`:

```ts
import { parseAmount } from "./money.js";
import type { Policy } from "./types.js";

const PERIODS = new Set(["per_tx", "daily"]);

export function validatePolicy(policy: Policy): void {
  if (policy === null || typeof policy !== "object") {
    throw new TypeError("policy must be an object");
  }
  if (!Array.isArray(policy.budgets) || policy.budgets.length === 0) {
    throw new RangeError("policy.budgets must be a non-empty array");
  }

  const seen = new Set<string>();
  for (const budget of policy.budgets) {
    if (!PERIODS.has(budget.period)) {
      throw new RangeError(`unknown budget period: ${String(budget.period)}`);
    }
    if (seen.has(budget.period)) {
      throw new RangeError(`duplicate budget period: ${budget.period}`);
    }
    seen.add(budget.period);
    if (budget.currency !== "USDC") {
      throw new RangeError(`unsupported currency: ${String(budget.currency)}`);
    }
    parseAmount(budget.limit);
  }

  if (policy.vendors === null || typeof policy.vendors !== "object" || policy.vendors.mode !== "allowlist") {
    throw new RangeError('policy.vendors.mode must be "allowlist"');
  }
  if (!Array.isArray(policy.vendors.entries) || policy.vendors.entries.length === 0) {
    throw new RangeError("allowlist mode requires at least one vendor entry");
  }

  if (policy.killSwitch === null || typeof policy.killSwitch !== "object" || typeof policy.killSwitch.frozen !== "boolean") {
    throw new TypeError("policy.killSwitch.frozen must be a boolean");
  }
}
```

`packages/core/src/vendor.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/policy.test.ts packages/core/test/vendor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/policy.ts packages/core/src/vendor.ts packages/core/test/policy.test.ts packages/core/test/vendor.test.ts
git commit -m "feat(core): add shared types, policy validation, and vendor normalization"
```

---

### Task 4: Signed, hash-chained audit entries

**Files:**
- Create: `packages/core/src/audit/entry.ts`
- Test: `packages/core/test/audit-entry.test.ts`

**Interfaces:**
- Consumes: types from Task 3.
- Produces: `canonicalize(entry: UnsignedAuditEntry): string`, `hashEntry(entry: UnsignedAuditEntry): string`, `signHash(hash: string, key: KeyObject): string`, `verifyEntry(entry: AuditEntry, publicKey: KeyObject): boolean`, `verifyAuditLog(entries, publicKey): Promise<VerifyResult>`, and `interface VerifyResult { ok: boolean; checked: number; failure?: { seq: number; reason: string } }`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/audit-entry.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashEntry, signHash, verifyAuditLog, verifyEntry } from "../src/audit/entry.js";
import type { AuditEntry, UnsignedAuditEntry } from "../src/types.js";

const keys = generateKeyPairSync("ed25519");

function unsigned(seq: number, prevHash: string, amountMinor: string): UnsignedAuditEntry {
  return {
    id: `id-${seq}`,
    seq,
    ts: `2026-08-13T10:0${seq}:00.000Z`,
    kind: "payment",
    agent: "demo-agent",
    vendor: "https://api.weather.com/forecast",
    vendorNormalized: "api.weather.com",
    rail: "solana",
    amountMinor,
    currency: "USDC",
    reason: "forecast query",
    outcome: "settled",
    violation: null,
    txSig: `sig-${seq}`,
    prevHash,
  };
}

function seal(entry: UnsignedAuditEntry): AuditEntry {
  const hash = hashEntry(entry);
  return { ...entry, hash, sig: signHash(hash, keys.privateKey) };
}

function chain(count: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prevHash = "";
  for (let seq = 0; seq < count; seq++) {
    const entry = seal(unsigned(seq, prevHash, "50000"));
    entries.push(entry);
    prevHash = entry.hash;
  }
  return entries;
}

describe("hashEntry", () => {
  it("is stable regardless of key insertion order", () => {
    const a = unsigned(0, "", "50000");
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as UnsignedAuditEntry;
    expect(hashEntry(reordered)).toBe(hashEntry(a));
  });

  it("is stable regardless of violation detail key order", () => {
    const base = unsigned(0, "", "50000");
    const a: UnsignedAuditEntry = {
      ...base,
      outcome: "blocked",
      violation: { code: "budget_exceeded", message: "over", detail: { limit: "1", spent: "2" } },
    };
    const b: UnsignedAuditEntry = {
      ...base,
      outcome: "blocked",
      violation: { code: "budget_exceeded", message: "over", detail: { spent: "2", limit: "1" } },
    };
    expect(hashEntry(a)).toBe(hashEntry(b));
  });

  it("changes when any signed field changes", () => {
    expect(hashEntry(unsigned(0, "", "50000"))).not.toBe(hashEntry(unsigned(0, "", "50001")));
  });
});

describe("verifyEntry", () => {
  it("accepts a correctly signed entry", () => {
    expect(verifyEntry(seal(unsigned(0, "", "50000")), keys.publicKey)).toBe(true);
  });

  it("rejects an entry signed by a different key", () => {
    const other = generateKeyPairSync("ed25519");
    expect(verifyEntry(seal(unsigned(0, "", "50000")), other.publicKey)).toBe(false);
  });
});

describe("verifyAuditLog", () => {
  it("accepts an intact chain", async () => {
    const result = await verifyAuditLog(chain(4), keys.publicKey);
    expect(result).toEqual({ ok: true, checked: 4 });
  });

  it("accepts an empty log", async () => {
    const result = await verifyAuditLog([], keys.publicKey);
    expect(result).toEqual({ ok: true, checked: 0 });
  });

  it("detects an edited amount", async () => {
    const entries = chain(4);
    entries[2] = { ...entries[2]!, amountMinor: "1" };
    const result = await verifyAuditLog(entries, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ seq: 2, reason: "content modified" });
  });

  it("detects a deleted entry", async () => {
    const entries = chain(4);
    entries.splice(2, 1);
    const result = await verifyAuditLog(entries, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("sequence gap");
  });

  it("detects reordered entries", async () => {
    const entries = chain(4);
    [entries[1], entries[2]] = [entries[2]!, entries[1]!];
    const result = await verifyAuditLog(entries, keys.publicKey);
    expect(result.ok).toBe(false);
  });

  it("detects a forged entry appended with the wrong key", async () => {
    const entries = chain(3);
    const forger = generateKeyPairSync("ed25519");
    const forged = unsigned(3, entries[2]!.hash, "50000");
    const hash = hashEntry(forged);
    entries.push({ ...forged, hash, sig: signHash(hash, forger.privateKey) });
    const result = await verifyAuditLog(entries, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ seq: 3, reason: "invalid signature" });
  });

  it("detects a broken chain link", async () => {
    const entries = chain(3);
    const tampered = { ...entries[1]!, prevHash: "0".repeat(64) };
    entries[1] = { ...tampered, hash: hashEntry(tampered), sig: signHash(hashEntry(tampered), keys.privateKey) };
    const result = await verifyAuditLog(entries, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ seq: 1, reason: "chain broken" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/audit-entry.test.ts`
Expected: FAIL — cannot resolve `../src/audit/entry.js`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/audit/entry.ts`:

```ts
import { createHash, sign, verify, type KeyObject } from "node:crypto";
import type { AuditEntry, UnsignedAuditEntry, Violation } from "../types.js";

const SIGNED_FIELDS = [
  "id", "seq", "ts", "kind", "agent", "vendor", "vendorNormalized", "rail",
  "amountMinor", "currency", "reason", "outcome", "txSig", "prevHash",
] as const;

export interface VerifyResult {
  ok: boolean;
  checked: number;
  failure?: { seq: number; reason: string };
}

function canonicalViolation(violation: Violation | null): unknown {
  if (violation === null) {
    return null;
  }
  const detail = violation.detail
    ? Object.keys(violation.detail).sort().map((key) => [key, violation.detail![key]])
    : null;
  return [violation.code, violation.message, detail];
}

export function canonicalize(entry: UnsignedAuditEntry): string {
  const ordered = SIGNED_FIELDS.map((field) => entry[field]);
  return JSON.stringify([...ordered, canonicalViolation(entry.violation)]);
}

export function hashEntry(entry: UnsignedAuditEntry): string {
  return createHash("sha256").update(canonicalize(entry), "utf8").digest("hex");
}

export function signHash(hash: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(hash, "utf8"), privateKey).toString("base64");
}

export function verifyEntry(entry: AuditEntry, publicKey: KeyObject): boolean {
  if (hashEntry(entry) !== entry.hash) {
    return false;
  }
  try {
    return verify(null, Buffer.from(entry.hash, "utf8"), publicKey, Buffer.from(entry.sig, "base64"));
  } catch {
    return false;
  }
}

export async function verifyAuditLog(
  entries: Iterable<AuditEntry> | AsyncIterable<AuditEntry>,
  publicKey: KeyObject,
): Promise<VerifyResult> {
  let expectedSeq = 0;
  let prevHash = "";
  let checked = 0;

  for await (const entry of entries as AsyncIterable<AuditEntry>) {
    if (entry.seq !== expectedSeq) {
      return { ok: false, checked, failure: { seq: entry.seq, reason: "sequence gap" } };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, checked, failure: { seq: entry.seq, reason: "chain broken" } };
    }
    if (hashEntry(entry) !== entry.hash) {
      return { ok: false, checked, failure: { seq: entry.seq, reason: "content modified" } };
    }
    if (!verifyEntry(entry, publicKey)) {
      return { ok: false, checked, failure: { seq: entry.seq, reason: "invalid signature" } };
    }
    prevHash = entry.hash;
    expectedSeq++;
    checked++;
  }

  return { ok: true, checked };
}
```

`canonicalize` serializes an array in a fixed order rather than an object, so no runtime key ordering can change the hash. `violation` goes last as a flattened tuple with sorted detail keys for the same reason. `for await` iterates synchronous iterables too, which lets one function verify both an in-memory array and a streaming file sink.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/audit-entry.test.ts`
Expected: PASS, all fourteen cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/audit/entry.ts packages/core/test/audit-entry.test.ts
git commit -m "feat(core): add hash-chained, ed25519-signed audit entries"
```

---

### Task 5: Audit sinks

**Files:**
- Create: `packages/core/src/audit/memorySink.ts`, `packages/core/src/audit/fileSink.ts`, `packages/core/src/audit/anchor.ts`
- Modify: `packages/core/src/types.ts` (add the `Anchor` and `AnchorStore` types)
- Test: `packages/core/test/audit-sinks.test.ts`, `packages/core/test/anchor.test.ts`

**Interfaces:**
- Consumes: `AuditEntry`, `AuditSink` from Task 3.
- Produces: `memoryAuditSink(seed?: AuditEntry[]): MemoryAuditSink` where `MemoryAuditSink extends AuditSink` and adds `readonly entries: AuditEntry[]`; `fileAuditSink(path: string): AuditSink`; `memoryAnchorStore(seed?: Anchor | null): AnchorStore`; `fileAnchorStore(path: string): AnchorStore`.

**Why the anchor exists.** Tail truncation cannot be detected from the log alone — a strict prefix of a valid chain is itself a valid chain. Because the spend counter replays from the log, deleting trailing lines silently restores budget while `verifyAuditLog` still reports OK. The anchor is the out-of-band memory that closes this: a tiny record of the log's expected head, written after every append and checked at startup. It is an integrity checkpoint, not a second copy of the spend counter — the counter still derives from the log alone.

Add to `packages/core/src/types.ts`:

```ts
export interface Anchor {
  logId: string;
  seq: number;
  hash: string;
}

export interface AnchorStore {
  read(): Promise<Anchor | null>;
  write(anchor: Anchor): Promise<void>;
}
```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/audit-sinks.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileAuditSink } from "../src/audit/fileSink.js";
import { memoryAuditSink } from "../src/audit/memorySink.js";
import type { AuditEntry } from "../src/types.js";

function entry(seq: number): AuditEntry {
  return {
    id: `id-${seq}`, seq, ts: "2026-08-13T10:00:00.000Z", kind: "payment",
    agent: "a", vendor: "v", vendorNormalized: "v", rail: "solana",
    amountMinor: "50000", currency: "USDC", reason: "r", outcome: "settled",
    violation: null, txSig: "sig", prevHash: "", hash: `h-${seq}`, sig: "s",
  };
}

async function collect(sink: { read?(): AsyncIterable<AuditEntry> }): Promise<AuditEntry[]> {
  const out: AuditEntry[] = [];
  for await (const e of sink.read!()) out.push(e);
  return out;
}

describe("memoryAuditSink", () => {
  it("appends and reads back in order", async () => {
    const sink = memoryAuditSink();
    await sink.append(entry(0));
    await sink.append(entry(1));
    expect((await collect(sink)).map((e) => e.seq)).toEqual([0, 1]);
  });

  it("starts from a seed", async () => {
    const sink = memoryAuditSink([entry(0)]);
    expect(sink.entries).toHaveLength(1);
  });
});

describe("fileAuditSink", () => {
  it("writes one JSON object per line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "audit.jsonl");
    const sink = fileAuditSink(path);
    await sink.append(entry(0));
    await sink.append(entry(1));

    const raw = await readFile(path, "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
    expect((await collect(sink)).map((e) => e.seq)).toEqual([0, 1]);
  });

  it("reads an empty stream when the file does not exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const sink = fileAuditSink(join(dir, "missing.jsonl"));
    expect(await collect(sink)).toEqual([]);
  });

  it("ignores blank lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "audit.jsonl");
    await writeFile(path, `${JSON.stringify(entry(0))}\n\n`, "utf8");
    expect(await collect(fileAuditSink(path))).toHaveLength(1);
  });

  it("throws a clear error on a corrupt line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "audit.jsonl");
    await writeFile(path, "{not json}\n", "utf8");
    await expect(collect(fileAuditSink(path))).rejects.toThrow(/line 1/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/audit-sinks.test.ts`
Expected: FAIL — cannot resolve the sink modules.

- [ ] **Step 3: Write the implementations**

`packages/core/src/audit/memorySink.ts`:

```ts
import type { AuditEntry, AuditSink } from "../types.js";

export interface MemoryAuditSink extends AuditSink {
  readonly entries: AuditEntry[];
  read(): AsyncIterable<AuditEntry>;
}

export function memoryAuditSink(seed: AuditEntry[] = []): MemoryAuditSink {
  const entries = [...seed];
  return {
    entries,
    async append(entry: AuditEntry): Promise<void> {
      entries.push(entry);
    },
    async *read(): AsyncIterable<AuditEntry> {
      yield* entries;
    },
  };
}
```

`packages/core/src/audit/fileSink.ts` — the only module in `core` that touches the filesystem:

```ts
import { appendFile, readFile } from "node:fs/promises";
import type { AuditEntry, AuditSink } from "../types.js";

export function fileAuditSink(path: string): AuditSink {
  return {
    async append(entry: AuditEntry): Promise<void> {
      await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
    },
    // TODO: stream line-by-line once logs outgrow memory; whole-file reads are fine at MVP scale.
    async *read(): AsyncIterable<AuditEntry> {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return;
        }
        throw error;
      }
      const lines = raw.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!.trim();
        if (line === "") {
          continue;
        }
        try {
          yield JSON.parse(line) as AuditEntry;
        } catch {
          throw new SyntaxError(`audit log ${path} is corrupt at line ${index + 1}`);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/audit-sinks.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing anchor tests**

`packages/core/test/anchor.test.ts`:

```ts
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileAnchorStore, memoryAnchorStore } from "../src/audit/anchor.js";
import type { Anchor } from "../src/types.js";

const anchor: Anchor = { logId: "log-alpha", seq: 4, hash: "a".repeat(64) };

describe("memoryAnchorStore", () => {
  it("reads null before anything is written", async () => {
    expect(await memoryAnchorStore().read()).toBeNull();
  });

  it("round-trips a written anchor", async () => {
    const store = memoryAnchorStore();
    await store.write(anchor);
    expect(await store.read()).toEqual(anchor);
  });

  it("starts from a seed", async () => {
    expect(await memoryAnchorStore(anchor).read()).toEqual(anchor);
  });
});

describe("fileAnchorStore", () => {
  it("reads null when the file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    expect(await fileAnchorStore(join(dir, "missing.json")).read()).toBeNull();
  });

  it("round-trips a written anchor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const store = fileAnchorStore(join(dir, "anchor.json"));
    await store.write(anchor);
    expect(await store.read()).toEqual(anchor);
  });

  it("overwrites a previous anchor and leaves no temp file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const store = fileAnchorStore(join(dir, "anchor.json"));
    await store.write(anchor);
    await store.write({ ...anchor, seq: 9 });

    expect((await store.read())?.seq).toBe(9);
    expect(await readdir(dir)).toEqual(["anchor.json"]);
  });

  it("reads null on an empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "anchor.json");
    await writeFile(path, "", "utf8");
    expect(await fileAnchorStore(path).read()).toBeNull();
  });

  it("throws a clear error on a corrupt anchor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "anchor.json");
    await writeFile(path, "{not json}", "utf8");
    await expect(fileAnchorStore(path).read()).rejects.toThrow(/corrupt/);
  });

  it("writes valid JSON on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-"));
    const path = join(dir, "anchor.json");
    await fileAnchorStore(path).write(anchor);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(anchor);
  });
});
```

- [ ] **Step 6: Run the anchor tests to verify they fail**

Run: `npx vitest run packages/core/test/anchor.test.ts`
Expected: FAIL — cannot resolve `../src/audit/anchor.js`.

- [ ] **Step 7: Write the anchor stores**

`packages/core/src/audit/anchor.ts`:

```ts
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Anchor, AnchorStore } from "../types.js";

export function memoryAnchorStore(seed: Anchor | null = null): AnchorStore {
  let current: Anchor | null = seed;
  return {
    async read(): Promise<Anchor | null> {
      return current;
    },
    async write(next: Anchor): Promise<void> {
      current = next;
    },
  };
}

export function fileAnchorStore(path: string): AnchorStore {
  return {
    async read(): Promise<Anchor | null> {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return null;
        }
        throw error;
      }
      if (raw.trim() === "") {
        return null;
      }
      try {
        return JSON.parse(raw) as Anchor;
      } catch {
        throw new SyntaxError(`anchor file ${path} is corrupt`);
      }
    },

    // Write to a temp file and rename, so a crash mid-write cannot leave a half-written anchor
    // that would strand the guard between "no anchor" and "valid anchor".
    async write(next: Anchor): Promise<void> {
      const temp = `${path}.tmp`;
      await writeFile(temp, JSON.stringify(next), "utf8");
      await rename(temp, path);
    },
  };
}
```

- [ ] **Step 8: Run the anchor tests to verify they pass**

Run: `npx vitest run packages/core/test/anchor.test.ts && npx vitest run && npm run build`
Expected: PASS, full suite green, clean build.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/audit packages/core/src/types.ts packages/core/test/audit-sinks.test.ts packages/core/test/anchor.test.ts
git commit -m "feat(core): add audit sinks and the out-of-band truncation anchor"
```

---

### Task 6: Spend state and replay

This is where restart-safety is won or lost.

**Files:**
- Create: `packages/core/src/state.ts`
- Test: `packages/core/test/state.test.ts`

**Interfaces:**
- Consumes: types from Task 3.
- Produces: `windowKey(period: BudgetPeriod, now: Date): string`, `emptyState(policy: Policy): SpendState`, `applyEntry(state: SpendState, entry: AuditEntry): SpendState`, `replay(policy: Policy, entries): Promise<SpendState>`, `spentInWindow(state: SpendState, period: BudgetPeriod, now: Date): bigint`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyEntry, emptyState, replay, spentInWindow, windowKey } from "../src/state.js";
import type { AuditEntry, AuditOutcome, Policy } from "../src/types.js";

const policy: Policy = {
  budgets: [{ period: "daily", limit: "0.50", currency: "USDC" }],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
};

function payment(seq: number, ts: string, amountMinor: string, outcome: AuditOutcome): AuditEntry {
  return {
    id: `id-${seq}`, seq, ts, kind: "payment", agent: "a",
    vendor: "api.weather.com", vendorNormalized: "api.weather.com", rail: "solana",
    amountMinor, currency: "USDC", reason: "r", outcome,
    violation: null, txSig: outcome === "settled" ? "sig" : null,
    prevHash: "", hash: `h-${seq}`, sig: "s",
  };
}

function control(seq: number, ts: string, action: "freeze" | "unfreeze"): AuditEntry {
  return {
    id: `id-${seq}`, seq, ts, kind: "control", agent: "a",
    vendor: "", vendorNormalized: "", rail: null,
    amountMinor: "0", currency: "USDC", reason: action, outcome: "settled",
    violation: null, txSig: null, prevHash: "", hash: `h-${seq}`, sig: "s",
  };
}

describe("windowKey", () => {
  it("keys daily windows by UTC calendar day", () => {
    expect(windowKey("daily", new Date("2026-08-13T23:59:59.999Z"))).toBe("2026-08-13");
    expect(windowKey("daily", new Date("2026-08-14T00:00:00.000Z"))).toBe("2026-08-14");
  });

  it("uses UTC even when the host is not", () => {
    expect(windowKey("daily", new Date("2026-08-13T18:30:00.000Z"))).toBe("2026-08-13");
  });

  it("has no window for per_tx", () => {
    expect(windowKey("per_tx", new Date())).toBe("");
  });
});

describe("applyEntry", () => {
  it("accrues only settled payments", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T10:00:00.000Z", "50000", "settled"));
    state = applyEntry(state, payment(1, "2026-08-13T10:01:00.000Z", "90000", "blocked"));
    state = applyEntry(state, payment(2, "2026-08-13T10:02:00.000Z", "90000", "failed"));
    expect(spentInWindow(state, "daily", new Date("2026-08-13T12:00:00.000Z"))).toBe(50_000n);
  });

  it("advances seq and prevHash on every entry regardless of outcome", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T10:00:00.000Z", "50000", "blocked"));
    expect(state.seq).toBe(1);
    expect(state.prevHash).toBe("h-0");
  });

  it("resets spend when the UTC day rolls over", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T23:59:00.000Z", "400000", "settled"));
    state = applyEntry(state, payment(1, "2026-08-14T00:01:00.000Z", "50000", "settled"));
    expect(spentInWindow(state, "daily", new Date("2026-08-14T00:02:00.000Z"))).toBe(50_000n);
  });

  it("reports zero spend once the stored window is stale", () => {
    let state = emptyState(policy);
    state = applyEntry(state, payment(0, "2026-08-13T10:00:00.000Z", "400000", "settled"));
    expect(spentInWindow(state, "daily", new Date("2026-08-14T00:00:00.000Z"))).toBe(0n);
  });

  it("applies control entries to frozen state", () => {
    let state = emptyState(policy);
    state = applyEntry(state, control(0, "2026-08-13T10:00:00.000Z", "freeze"));
    expect(state.frozen).toBe(true);
    state = applyEntry(state, control(1, "2026-08-13T10:05:00.000Z", "unfreeze"));
    expect(state.frozen).toBe(false);
  });
});

describe("replay", () => {
  it("takes the initial frozen value from the policy", async () => {
    const frozenPolicy: Policy = { ...policy, killSwitch: { frozen: true } };
    expect((await replay(frozenPolicy, [])).frozen).toBe(true);
  });

  it("lets the log override the policy's frozen value", async () => {
    const state = await replay(policy, [control(0, "2026-08-13T10:00:00.000Z", "freeze")]);
    expect(state.frozen).toBe(true);
  });

  it("reconstructs spend and position across a mixed log", async () => {
    const state = await replay(policy, [
      payment(0, "2026-08-13T10:00:00.000Z", "50000", "settled"),
      payment(1, "2026-08-13T10:01:00.000Z", "50000", "settled"),
      control(2, "2026-08-13T10:02:00.000Z", "freeze"),
    ]);
    expect(spentInWindow(state, "daily", new Date("2026-08-13T11:00:00.000Z"))).toBe(100_000n);
    expect(state.frozen).toBe(true);
    expect(state.seq).toBe(3);
    expect(state.prevHash).toBe("h-2");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/state.test.ts`
Expected: FAIL — cannot resolve `../src/state.js`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/state.ts`:

```ts
import type { AuditEntry, BudgetPeriod, Policy, SpendState } from "./types.js";

export function windowKey(period: BudgetPeriod, now: Date): string {
  if (period !== "daily") {
    return "";
  }
  return now.toISOString().slice(0, 10);
}

export function emptyState(policy: Policy): SpendState {
  return { frozen: policy.killSwitch.frozen, windows: {}, seq: 0, prevHash: "" };
}

export function spentInWindow(state: SpendState, period: BudgetPeriod, now: Date): bigint {
  if (period !== "daily") {
    return 0n;
  }
  const current = state.windows["daily"];
  if (current === undefined || current.start !== windowKey("daily", now)) {
    return 0n;
  }
  return current.spentMinor;
}

export function applyEntry(state: SpendState, entry: AuditEntry): SpendState {
  const next: SpendState = {
    frozen: state.frozen,
    windows: { ...state.windows },
    seq: entry.seq + 1,
    prevHash: entry.hash,
  };

  if (entry.kind === "control") {
    next.frozen = entry.reason === "freeze";
    return next;
  }

  if (entry.outcome !== "settled") {
    return next;
  }

  const day = entry.ts.slice(0, 10);
  const current = next.windows["daily"];
  next.windows["daily"] =
    current !== undefined && current.start === day
      ? { start: day, spentMinor: current.spentMinor + BigInt(entry.amountMinor) }
      : { start: day, spentMinor: BigInt(entry.amountMinor) };

  return next;
}

export async function replay(
  policy: Policy,
  entries: Iterable<AuditEntry> | AsyncIterable<AuditEntry>,
): Promise<SpendState> {
  let state = emptyState(policy);
  for await (const entry of entries as AsyncIterable<AuditEntry>) {
    state = applyEntry(state, entry);
  }
  return state;
}
```

`spentInWindow` returning `0n` for a stale window is what makes rollover work without a scheduler: the state simply stops counting once the day changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/state.ts packages/core/test/state.test.ts
git commit -m "feat(core): derive spend state and frozen state by replaying the audit log"
```

---

### Task 7: Policy checks

**Files:**
- Create: `packages/core/src/checks/killSwitch.ts`, `packages/core/src/checks/allowlist.ts`, `packages/core/src/checks/budget.ts`, `packages/core/src/checks/index.ts`
- Test: `packages/core/test/checks.test.ts`

**Interfaces:**
- Consumes: `Check`, `PaymentContext` from Task 3; `spentInWindow` from Task 6; `parseAmount`/`formatAmount` from Task 2.
- Produces: `killSwitchCheck`, `allowlistCheck`, `budgetCheck`, and `CHECKS: readonly Check[]` in that exact order.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/checks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CHECKS, allowlistCheck, budgetCheck, killSwitchCheck } from "../src/checks/index.js";
import { emptyState } from "../src/state.js";
import type { PaymentContext, Policy, SpendState } from "../src/types.js";

const policy: Policy = {
  budgets: [
    { period: "per_tx", limit: "0.10", currency: "USDC" },
    { period: "daily", limit: "0.50", currency: "USDC" },
  ],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
};

const now = new Date("2026-08-13T12:00:00.000Z");

function ctx(overrides: Partial<PaymentContext> = {}): PaymentContext {
  return {
    vendor: "https://api.weather.com/forecast",
    vendorNormalized: "api.weather.com",
    amountMinor: 50_000n,
    currency: "USDC",
    reason: "forecast query",
    now,
    ...overrides,
  };
}

function stateWithSpend(spentMinor: bigint): SpendState {
  return { ...emptyState(policy), windows: { daily: { start: "2026-08-13", spentMinor } } };
}

describe("killSwitchCheck", () => {
  it("passes when the agent is not frozen", () => {
    expect(killSwitchCheck(ctx(), policy, emptyState(policy))).toBeNull();
  });

  it("blocks when frozen", () => {
    const frozen = { ...emptyState(policy), frozen: true };
    expect(killSwitchCheck(ctx(), policy, frozen)?.code).toBe("kill_switch");
  });
});

describe("allowlistCheck", () => {
  it("passes an allowlisted vendor", () => {
    expect(allowlistCheck(ctx(), policy, emptyState(policy))).toBeNull();
  });

  it("blocks an unknown vendor without echoing it into the message", () => {
    const violation = allowlistCheck(ctx({ vendorNormalized: "evil.example" }), policy, emptyState(policy));
    expect(violation?.code).toBe("vendor_not_allowed");
    expect(violation?.message).not.toContain("evil.example");
    expect(violation?.detail?.vendor).toBe("evil.example");
  });
});

describe("budgetCheck", () => {
  it("passes a payment inside both limits", () => {
    expect(budgetCheck(ctx(), policy, emptyState(policy))).toBeNull();
  });

  it("blocks a payment over the per-transaction limit", () => {
    const violation = budgetCheck(ctx({ amountMinor: 250_000n }), policy, emptyState(policy));
    expect(violation?.code).toBe("budget_exceeded");
    expect(violation?.detail?.period).toBe("per_tx");
  });

  it("treats the limit as an inclusive maximum", () => {
    expect(budgetCheck(ctx({ amountMinor: 100_000n }), policy, emptyState(policy))).toBeNull();
    expect(budgetCheck(ctx({ amountMinor: 50_000n }), policy, stateWithSpend(450_000n))).toBeNull();
  });

  it("blocks when the daily budget would be exceeded", () => {
    const violation = budgetCheck(ctx({ amountMinor: 50_000n }), policy, stateWithSpend(460_000n));
    expect(violation?.code).toBe("budget_exceeded");
    expect(violation?.detail).toMatchObject({ period: "daily", limit: "0.50", spent: "0.460000" });
  });

  it("ignores spend recorded on a previous UTC day", () => {
    const stale: SpendState = {
      ...emptyState(policy),
      windows: { daily: { start: "2026-08-12", spentMinor: 500_000n } },
    };
    expect(budgetCheck(ctx(), policy, stale)).toBeNull();
  });
});

describe("CHECKS ordering", () => {
  it("reports kill_switch first when several rules would fire", () => {
    const frozen: SpendState = { ...stateWithSpend(500_000n), frozen: true };
    const hostile = ctx({ vendorNormalized: "evil.example", amountMinor: 900_000n });
    const first = CHECKS.map((check) => check(hostile, policy, frozen)).find((v) => v !== null);
    expect(first?.code).toBe("kill_switch");
  });

  it("reports vendor_not_allowed before budget_exceeded", () => {
    const hostile = ctx({ vendorNormalized: "evil.example", amountMinor: 900_000n });
    const first = CHECKS.map((check) => check(hostile, policy, emptyState(policy))).find((v) => v !== null);
    expect(first?.code).toBe("vendor_not_allowed");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/checks.test.ts`
Expected: FAIL — cannot resolve `../src/checks/index.js`.

- [ ] **Step 3: Write the implementations**

`packages/core/src/checks/killSwitch.ts`:

```ts
import type { Check } from "../types.js";

export const killSwitchCheck: Check = (_ctx, _policy, state) => {
  if (!state.frozen) {
    return null;
  }
  return { code: "kill_switch", message: "the agent is frozen; every payment is blocked" };
};
```

`packages/core/src/checks/allowlist.ts`:

```ts
import type { Check } from "../types.js";

export const allowlistCheck: Check = (ctx, policy) => {
  if (policy.vendors.entries.includes(ctx.vendorNormalized)) {
    return null;
  }
  // The vendor is untrusted input, so it travels in `detail` and never in the message.
  return {
    code: "vendor_not_allowed",
    message: "the vendor is not on the allowlist",
    detail: { vendor: ctx.vendorNormalized },
  };
};
```

`packages/core/src/checks/budget.ts`:

```ts
import { formatAmount, parseAmount } from "../money.js";
import { spentInWindow } from "../state.js";
import type { Check } from "../types.js";

export const budgetCheck: Check = (ctx, policy, state) => {
  for (const budget of policy.budgets) {
    const limit = parseAmount(budget.limit);

    if (budget.period === "per_tx") {
      if (ctx.amountMinor > limit) {
        return {
          code: "budget_exceeded",
          message: "the payment exceeds the per-transaction limit",
          detail: {
            period: "per_tx",
            limit: budget.limit,
            attempted: formatAmount(ctx.amountMinor),
          },
        };
      }
      continue;
    }

    const spent = spentInWindow(state, budget.period, ctx.now);
    if (spent + ctx.amountMinor > limit) {
      return {
        code: "budget_exceeded",
        message: "the payment exceeds the daily budget",
        detail: {
          period: "daily",
          limit: budget.limit,
          spent: formatAmount(spent),
          attempted: formatAmount(ctx.amountMinor),
          remaining: formatAmount(limit - spent),
        },
      };
    }
  }
  return null;
};
```

`packages/core/src/checks/index.ts`:

```ts
import { allowlistCheck } from "./allowlist.js";
import { budgetCheck } from "./budget.js";
import { killSwitchCheck } from "./killSwitch.js";
import type { Check } from "../types.js";

// Order is a security property: authorization, then destination, then amount.
export const CHECKS: readonly Check[] = [killSwitchCheck, allowlistCheck, budgetCheck];

export { allowlistCheck, budgetCheck, killSwitchCheck };
```

Budgets are evaluated in the order they appear in `policy.budgets`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/checks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/checks packages/core/test/checks.test.ts
git commit -m "feat(core): add kill switch, allowlist, and budget checks"
```

---

### Task 8: The guard, the public surface, and the README correction

The three breaking API changes land here, so the README must change in the same commit.

**Files:**
- Create: `packages/core/src/guard.ts`
- Modify: `packages/core/src/index.ts` (replace the placeholder from Task 1)
- Modify: `README.md` (quickstart and roadmap)
- Test: `packages/core/test/guard.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces: `createGuard(options: GuardOptions): Promise<Guard>`; `interface Guard { pay(req: PayRequest): Promise<PayResult>; freeze(): Promise<void>; unfreeze(): Promise<void>; state(): SpendState }`; `interface GuardOptions { policy: Policy; adapters: WalletAdapter[]; audit: AuditSink; agent: string; logId: string; signingKey: KeyObject; verifyingKey: KeyObject; anchor?: AnchorStore; requirePersistedState?: boolean; now?: () => Date }`.

## The anchor invariant — the whole point of the anchor

An `AnchorStore` cannot distinguish "never existed" from "deleted", "emptied", or "set to `null`" — every one of those collapses to a single signal. So the guard, not the store, has to carry the integrity rule. Get this wrong and deleting one file restores an agent's entire budget.

At startup, when an `anchor` store is supplied:

| Anchor | Log | Guard behavior |
|---|---|---|
| absent | absent or empty | **First run.** Proceed, seal and write the anchor after the first append. |
| absent | **non-empty** | **Fail closed.** Throw at construction — the anchor was deleted or the log was substituted. Never treat this as a first run. |
| present, signature invalid | any | **Fail closed.** Throw — the anchor was forged or corrupted. |
| present, `logId` ≠ the guard's `logId` | any | **Fail closed.** Throw — wrong log. |
| present, valid | log reaches the anchored `seq`/`hash` | Proceed. |
| present, valid | log ends before it, or hash differs at that `seq` | **Fail closed.** Throw — the log was truncated. |

Pass the verified anchor into `verifyAuditLog(entries, verifyingKey, { logId, anchor })` during replay so one pass covers chain integrity and truncation together.

After every appended entry — payments and control events alike — seal a fresh anchor with `sealAnchor({ logId, seq, hash }, signingKey)` and write it. Write the anchor *after* the log append: an anchor ahead of the log looks like truncation, whereas an anchor behind the log is a benign stale floor.

Construction failures here throw rather than returning a violation. A tampered environment is not a payment the agent can handle gracefully — it is a refusal to start.

### What the signed anchor does and does not buy

Signing stops an attacker **fabricating** an anchor: without the operator key they cannot name an arbitrary head. It does not stop them **replaying a genuine older one**. An attacker who kept a copy of a real signed anchor from when the head was `seq 1`, restores it, and truncates the log to match passes every check — verified empirically.

That residual is inherent, not a bug to fix here. Detecting rollback needs monotonic state outside both files, and any such state living on the same disk can be rolled back with them. Closing it properly means append-only or remote storage, which is post-MVP.

So the honest claim, and the one the README must make: the audit log detects edits, deletions, reordering, and forgery outright; truncation is detected as long as the anchor is intact; **restoring an older matching snapshot of both files is not detected.** State that limitation plainly rather than letting "tamper-evident" imply more than it delivers.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/guard.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyAuditLog } from "../src/audit/entry.js";
import { memoryAuditSink } from "../src/audit/memorySink.js";
import { createGuard } from "../src/guard.js";
import type { Policy, SettlementRequest, WalletAdapter } from "../src/types.js";

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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/guard.test.ts`
Expected: FAIL — cannot resolve `../src/guard.js`.

- [ ] **Step 3: Write the guard**

`packages/core/src/guard.ts`:

```ts
import { randomUUID, type KeyObject } from "node:crypto";
import { hashEntry, signHash } from "./audit/entry.js";
import { CHECKS } from "./checks/index.js";
import { parseAmount } from "./money.js";
import { validatePolicy } from "./policy.js";
import { applyEntry, emptyState, replay } from "./state.js";
import type {
  AuditEntry, AuditOutcome, AuditSink, PayRequest, PayResult, PaymentError,
  Policy, SpendState, UnsignedAuditEntry, Violation, WalletAdapter,
} from "./types.js";
import { normalizeVendor } from "./vendor.js";

export interface GuardOptions {
  policy: Policy;
  adapters: WalletAdapter[];
  audit: AuditSink;
  agent: string;
  signingKey: KeyObject;
  requirePersistedState?: boolean;
  now?: () => Date;
}

export interface Guard {
  pay(req: PayRequest): Promise<PayResult>;
  freeze(): Promise<void>;
  unfreeze(): Promise<void>;
  state(): SpendState;
}

interface WriteInput {
  kind: "payment" | "control";
  vendor: string;
  vendorNormalized: string;
  amountMinor: bigint;
  reason: string;
  outcome: AuditOutcome;
  violation: Violation | null;
  txSig: string | null;
  rail: string | null;
  ts: Date;
}

function toPaymentError(error: unknown): PaymentError {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (code === "price_mismatch" || code === "insufficient_funds" || code === "timeout") {
      return { code, message: error instanceof Error ? error.message : String(error) };
    }
  }
  return { code: "adapter_error", message: error instanceof Error ? error.message : String(error) };
}

export async function createGuard(options: GuardOptions): Promise<Guard> {
  validatePolicy(options.policy);
  if (options.adapters.length === 0) {
    throw new RangeError("createGuard requires at least one adapter");
  }
  if (options.requirePersistedState === true && options.audit.read === undefined) {
    throw new RangeError("the audit sink cannot replay entries, so budgets would reset on restart");
  }

  const { policy, adapters, audit, agent, signingKey } = options;
  const clock = options.now ?? (() => new Date());

  let state: SpendState = audit.read !== undefined
    ? await replay(policy, audit.read())
    : emptyState(policy);

  // Payments are serialized so two concurrent calls cannot both pass the same budget check.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function write(input: WriteInput): Promise<string> {
    const unsignedEntry: UnsignedAuditEntry = {
      id: randomUUID(),
      seq: state.seq,
      ts: input.ts.toISOString(),
      kind: input.kind,
      agent,
      vendor: input.vendor,
      vendorNormalized: input.vendorNormalized,
      rail: input.rail,
      amountMinor: input.amountMinor.toString(),
      currency: "USDC",
      reason: input.reason,
      outcome: input.outcome,
      violation: input.violation,
      txSig: input.txSig,
      prevHash: state.prevHash,
    };
    const hash = hashEntry(unsignedEntry);
    const entry: AuditEntry = { ...unsignedEntry, hash, sig: signHash(hash, signingKey) };

    await audit.append(entry);
    state = applyEntry(state, entry);
    return entry.id;
  }

  function pickAdapter(via: string | undefined): WalletAdapter {
    if (via === undefined) {
      return adapters[0]!;
    }
    const adapter = adapters.find((candidate) => candidate.name === via);
    if (adapter === undefined) {
      throw new RangeError(`no adapter named ${via} is registered`);
    }
    return adapter;
  }

  async function runPayment(req: PayRequest): Promise<PayResult> {
    const ts = clock();

    let amountMinor: bigint;
    let vendorNormalized: string;
    let adapter: WalletAdapter;
    try {
      if (req.currency !== "USDC") {
        throw new RangeError(`unsupported currency: ${String(req.currency)}`);
      }
      amountMinor = parseAmount(req.amount);
      vendorNormalized = normalizeVendor(req.to);
      adapter = pickAdapter(req.via);
    } catch (error) {
      const violation: Violation = {
        code: "invalid_request",
        message: error instanceof Error ? error.message : String(error),
      };
      const auditId = await write({
        kind: "payment", vendor: String(req.to ?? ""), vendorNormalized: "",
        amountMinor: 0n, reason: String(req.reason ?? ""), outcome: "blocked",
        violation, txSig: null, rail: null, ts,
      });
      return { status: "blocked", violation, auditId };
    }

    const ctx = {
      vendor: req.to,
      vendorNormalized,
      amountMinor,
      currency: req.currency,
      reason: req.reason,
      now: ts,
    };

    for (const check of CHECKS) {
      const violation = check(ctx, policy, state);
      if (violation !== null) {
        const auditId = await write({
          kind: "payment", vendor: req.to, vendorNormalized, amountMinor,
          reason: req.reason, outcome: "blocked", violation,
          txSig: null, rail: adapter.name, ts,
        });
        return { status: "blocked", violation, auditId };
      }
    }

    try {
      const receipt = await adapter.execute({ to: req.to, amountMinor, reason: req.reason });
      const auditId = await write({
        kind: "payment", vendor: req.to, vendorNormalized, amountMinor,
        reason: req.reason, outcome: "settled", violation: null,
        txSig: receipt.txSig, rail: receipt.rail, ts,
      });
      return { status: "settled", txSig: receipt.txSig, auditId };
    } catch (error) {
      const paymentError = toPaymentError(error);
      const auditId = await write({
        kind: "payment", vendor: req.to, vendorNormalized, amountMinor,
        reason: req.reason, outcome: "failed", violation: null,
        txSig: null, rail: adapter.name, ts,
      });
      return { status: "failed", error: paymentError, auditId };
    }
  }

  async function setFrozen(action: "freeze" | "unfreeze"): Promise<void> {
    await write({
      kind: "control", vendor: "", vendorNormalized: "", amountMinor: 0n,
      reason: action, outcome: "settled", violation: null,
      txSig: null, rail: null, ts: clock(),
    });
  }

  return {
    pay: (req) => serialize(() => runPayment(req)),
    freeze: () => serialize(() => setFrozen("freeze")),
    unfreeze: () => serialize(() => setFrozen("unfreeze")),
    state: () => state,
  };
}
```

- [ ] **Step 4: Write the public surface**

Replace `packages/core/src/index.ts` entirely:

```ts
export { createGuard, type Guard, type GuardOptions } from "./guard.js";
export { validatePolicy } from "./policy.js";
export { normalizeVendor } from "./vendor.js";
export { formatAmount, parseAmount, USDC_DECIMALS } from "./money.js";
export { memoryAuditSink, type MemoryAuditSink } from "./audit/memorySink.js";
export { fileAuditSink } from "./audit/fileSink.js";
export {
  canonicalize, hashEntry, signHash, verifyAuditLog, verifyEntry, type VerifyResult,
} from "./audit/entry.js";
export { applyEntry, emptyState, replay, spentInWindow, windowKey } from "./state.js";
export { CHECKS, allowlistCheck, budgetCheck, killSwitchCheck } from "./checks/index.js";
export type {
  AuditEntry, AuditKind, AuditOutcome, AuditSink, Budget, BudgetPeriod, Check, Currency,
  KillSwitch, PayRequest, PayResult, PaymentContext, PaymentError, PaymentErrorCode, Policy,
  SettlementReceipt, SettlementRequest, SpendState, UnsignedAuditEntry, VendorPolicy,
  Violation, ViolationCode, WalletAdapter, WindowState,
} from "./types.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npm run build`
Expected: every test passes and the build succeeds.

- [ ] **Step 6: Correct the README**

In `README.md`, replace the Quickstart code block with:

```typescript
import { createGuard, fileAuditSink, type Policy } from "@agentveins/core";
import { solanaAdapter } from "@agentveins/adapter-solana";

const policy: Policy = {
  budgets: [
    { period: "daily", limit: "25.00", currency: "USDC" },
    { period: "per_tx", limit: "1.00", currency: "USDC" },
  ],
  vendors: { mode: "allowlist", entries: ["api.weather.com"] },
  killSwitch: { frozen: false },
};

const guard = await createGuard({
  policy,
  agent: "research-agent",
  adapters: [solanaAdapter({ keypair, rpcUrl, mode: "x402" })],
  audit: fileAuditSink("./audit.jsonl"),
  signingKey,
});

// Wrap your agent's payment path — the only integration point
const result = await guard.pay({
  to: "https://api.weather.com/forecast",
  amount: "0.05",
  currency: "USDC",
  reason: "forecast query",
});
// { status: "settled" | "blocked" | "failed", txSig?, violation?, error?, auditId }

await guard.freeze(); // emergency stop, instantly
```

In the Roadmap section, change the three `- [x]` entries to `- [ ]`; they claim work that does not exist yet. Re-check each one in the task that actually delivers it (policy engine here, Solana path in Task 11, signed audit log here).

Update the "Blocked ≠ thrown" bullet under "How it's built" to mention the third state:

```markdown
- **Blocked ≠ thrown** — structured violations so agents can retry a cheaper vendor or escalate to a human; rail errors return `failed` separately, so a network hiccup never looks like a policy denial
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/guard.ts packages/core/src/index.ts packages/core/test/guard.test.ts README.md
git commit -m "feat(core)!: add the guard with async createGuard, three-state results, and log-derived state"
```

---

### Task 9: Adapter stubs

**Files:**
- Create: `packages/adapter-base/package.json`, `packages/adapter-base/tsconfig.json`, `packages/adapter-base/src/index.ts`
- Create: `packages/adapter-cloudflare/package.json`, `packages/adapter-cloudflare/tsconfig.json`, `packages/adapter-cloudflare/src/index.ts`
- Modify: `tsconfig.json` (add project references)
- Test: `packages/adapter-base/test/stub.test.ts`

**Interfaces:**
- Consumes: `WalletAdapter` from `@agentveins/core`.
- Produces: `baseAdapter(config: BaseAdapterConfig): WalletAdapter` and `cloudflareAdapter(config: CloudflareAdapterConfig): WalletAdapter`, both throwing `NotImplementedError` at construction.

- [ ] **Step 1: Write the failing test**

`packages/adapter-base/test/stub.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { baseAdapter } from "../src/index.js";

describe("baseAdapter", () => {
  it("throws at construction rather than pretending to work", () => {
    expect(() => baseAdapter({ rpcUrl: "https://example.invalid" })).toThrow(/not implemented/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/adapter-base/test/stub.test.ts`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 3: Write the stubs**

`packages/adapter-base/package.json` (mirror it for `adapter-cloudflare`, changing the name):

```json
{
  "name": "@agentveins/adapter-base",
  "version": "0.0.1",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "dependencies": { "@agentveins/core": "0.0.1" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/adapter-base/tsconfig.json` (mirror for cloudflare):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

`packages/adapter-base/src/index.ts`:

```ts
import type { WalletAdapter } from "@agentveins/core";

export interface BaseAdapterConfig {
  rpcUrl: string;
}

export class NotImplementedError extends Error {
  constructor(rail: string) {
    super(`the ${rail} adapter is not implemented yet; only the interface is defined`);
    this.name = "NotImplementedError";
  }
}

export function baseAdapter(_config: BaseAdapterConfig): WalletAdapter {
  throw new NotImplementedError("Base");
}
```

`packages/adapter-cloudflare/src/index.ts`:

```ts
import type { WalletAdapter } from "@agentveins/core";

export interface CloudflareAdapterConfig {
  walletHandle: string;
}

export class NotImplementedError extends Error {
  constructor(rail: string) {
    super(`the ${rail} adapter is not implemented yet; only the interface is defined`);
    this.name = "NotImplementedError";
  }
}

export function cloudflareAdapter(_config: CloudflareAdapterConfig): WalletAdapter {
  throw new NotImplementedError("Cloudflare Wallets");
}
```

Add both to the root `tsconfig.json` references array alongside `packages/core`.

- [ ] **Step 4: Run the test and build**

Run: `npx vitest run packages/adapter-base/test/stub.test.ts && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-base packages/adapter-cloudflare tsconfig.json
git commit -m "feat: stub the Base and Cloudflare adapters behind the WalletAdapter interface"
```

---

### Task 10: Solana adapter — shared signing and direct mode

**Files:**
- Create: `packages/adapter-solana/package.json`, `packages/adapter-solana/tsconfig.json`
- Create: `packages/adapter-solana/src/transfer.ts`, `packages/adapter-solana/src/direct.ts`, `packages/adapter-solana/src/index.ts`
- Modify: `tsconfig.json` (add the reference)
- Test: `packages/adapter-solana/test/adapter.test.ts`

**Interfaces:**
- Consumes: `WalletAdapter`, `SettlementRequest`, `SettlementReceipt` from `@agentveins/core`.
- Produces: `solanaAdapter(config: SolanaAdapterConfig): WalletAdapter` and `interface SolanaAdapterConfig { keypair: CryptoKeyPair; rpcUrl: string; mode: "x402" | "direct"; usdcMint?: string; facilitatorUrl?: string }`; `buildSignedTransfer(deps, req): Promise<{ signedTransaction: Uint8Array; signature: string }>`.

- [ ] **Step 1: Confirm the installed API surface before writing code**

Run: `npm install --workspace=@agentveins/adapter-solana @solana/kit @solana-program/token`
Then read the installed type declarations:

```bash
ls node_modules/@solana/kit/dist/types/index.d.ts
grep -rn "export declare function getTransferCheckedInstruction\|export declare function findAssociatedTokenPda" node_modules/@solana-program/token/dist/types/ | head
```

The code below targets `@solana/kit` v5's functional transaction API. If the installed version exports different names, adapt the calls and keep the module's exported signatures unchanged — later tasks depend only on `solanaAdapter` and `buildSignedTransfer`.

- [ ] **Step 2: Write the failing tests**

`packages/adapter-solana/test/adapter.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { solanaAdapter } from "../src/index.js";

const config = {
  keypair: {} as CryptoKeyPair,
  rpcUrl: "https://api.devnet.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

describe("solanaAdapter", () => {
  it("reports its name and currency", () => {
    const adapter = solanaAdapter({ ...config, mode: "direct" });
    expect(adapter.name).toBe("solana");
    expect(adapter.currency).toBe("USDC");
  });

  it("rejects an unknown mode at construction", () => {
    expect(() => solanaAdapter({ ...config, mode: "carrier-pigeon" as "direct" })).toThrow(RangeError);
  });

  it("rejects a non-positive amount before touching the network", async () => {
    const send = vi.fn();
    const adapter = solanaAdapter({ ...config, mode: "direct", sendTransaction: send });
    await expect(adapter.execute({ to: "addr", amountMinor: 0n, reason: "r" })).rejects.toThrow(RangeError);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("returns the confirmed signature in direct mode", async () => {
    const adapter = solanaAdapter({
      ...config,
      mode: "direct",
      buildSignedTransfer: vi.fn(async () => ({
        signedTransaction: new Uint8Array([1]),
        wireTransaction: "AQID",
        signature: "sig-abc",
      })),
      sendTransaction: vi.fn(async () => "sig-abc"),
    });
    const receipt = await adapter.execute({ to: "addr", amountMinor: 50_000n, reason: "forecast" });
    expect(receipt).toEqual({ txSig: "sig-abc", rail: "solana" });
  });
});
```

The `buildSignedTransfer` and `sendTransaction` config fields exist as seams for tests. Type them as optional in `SolanaAdapterConfig` and default them to the real implementations.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/adapter-solana/test/adapter.test.ts`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 4: Write the shared transfer builder**

`packages/adapter-solana/src/transfer.ts`:

```ts
import {
  appendTransactionMessageInstruction, createSolanaRpc, createTransactionMessage,
  getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction, address, type KeyPairSigner,
} from "@solana/kit";
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

export interface TransferDeps {
  rpcUrl: string;
  signer: KeyPairSigner;
  usdcMint: string;
  decimals: number;
}

export interface SignedTransfer {
  signedTransaction: Uint8Array;
  wireTransaction: string;
  signature: string;
}

export async function buildSignedTransfer(
  deps: TransferDeps,
  to: string,
  amountMinor: bigint,
): Promise<SignedTransfer> {
  if (amountMinor <= 0n) {
    throw new RangeError("transfer amount must be greater than zero");
  }

  const rpc = createSolanaRpc(deps.rpcUrl);
  const mint = address(deps.usdcMint);

  const [source] = await findAssociatedTokenPda({
    owner: deps.signer.address,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [destination] = await findAssociatedTokenPda({
    owner: address(to),
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const instruction = getTransferCheckedInstruction({
    source,
    mint,
    destination,
    authority: deps.signer,
    amount: amountMinor,
    decimals: deps.decimals,
  });

  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(deps.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(instruction, m),
  );

  const signed = await signTransactionMessageWithSigners(message);

  return {
    signedTransaction: signed.messageBytes,
    wireTransaction: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
  };
}
```

- [ ] **Step 5: Write direct mode and the factory**

`packages/adapter-solana/src/direct.ts`:

```ts
import { createSolanaRpc } from "@solana/kit";

export async function sendAndConfirm(rpcUrl: string, wireTransaction: string): Promise<void> {
  const rpc = createSolanaRpc(rpcUrl);
  await rpc.sendTransaction(wireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }).send();
}
```

`packages/adapter-solana/src/index.ts`:

```ts
import type { SettlementReceipt, SettlementRequest, WalletAdapter } from "@agentveins/core";
import { sendAndConfirm } from "./direct.js";
import { buildSignedTransfer, type SignedTransfer } from "./transfer.js";
import { settleViaFacilitator } from "./x402.js";

export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
const USDC_DECIMALS = 6;

export interface SolanaAdapterConfig {
  keypair: unknown;
  rpcUrl: string;
  mode: "x402" | "direct";
  usdcMint?: string;
  facilitatorUrl?: string;
  buildSignedTransfer?: (to: string, amountMinor: bigint) => Promise<SignedTransfer>;
  sendTransaction?: (wireTransaction: string) => Promise<string>;
}

export function solanaAdapter(config: SolanaAdapterConfig): WalletAdapter {
  if (config.mode !== "x402" && config.mode !== "direct") {
    throw new RangeError(`unknown solana adapter mode: ${String(config.mode)}`);
  }

  const usdcMint = config.usdcMint ?? DEVNET_USDC_MINT;
  const build = config.buildSignedTransfer
    ?? ((to: string, amountMinor: bigint) =>
      buildSignedTransfer(
        { rpcUrl: config.rpcUrl, signer: config.keypair as never, usdcMint, decimals: USDC_DECIMALS },
        to,
        amountMinor,
      ));

  return {
    name: "solana",
    currency: "USDC",
    async execute(req: SettlementRequest): Promise<SettlementReceipt> {
      if (req.amountMinor <= 0n) {
        throw new RangeError("settlement amount must be greater than zero");
      }
      const signed = await build(req.to, req.amountMinor);

      if (config.mode === "direct") {
        if (config.sendTransaction !== undefined) {
          await config.sendTransaction(signed.wireTransaction);
        } else {
          await sendAndConfirm(config.rpcUrl, signed.wireTransaction);
        }
        return { txSig: signed.signature, rail: "solana" };
      }

      return settleViaFacilitator({
        vendorUrl: req.to,
        approvedAmountMinor: req.amountMinor,
        signed,
        facilitatorUrl: config.facilitatorUrl ?? DEFAULT_FACILITATOR_URL,
      });
    },
  };
}

export { buildSignedTransfer } from "./transfer.js";
export type { SignedTransfer } from "./transfer.js";
```

Task 11 replaces `x402.ts`. Create it now as a stub so this task compiles and its own tests pass:

```ts
import type { SettlementReceipt } from "@agentveins/core";

export async function settleViaFacilitator(_input: unknown): Promise<SettlementReceipt> {
  throw new Error("x402 mode is not implemented yet");
}
```

- [ ] **Step 6: Run the tests and build**

Run: `npx vitest run packages/adapter-solana/test/adapter.test.ts && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-solana tsconfig.json package-lock.json
git commit -m "feat(adapter-solana): add the shared USDC transfer builder and direct settlement mode"
```

---

### Task 11: Solana adapter — x402 mode and the price-mismatch guard

**Files:**
- Create: `packages/adapter-solana/src/x402.ts` (replacing the stub from Task 10)
- Modify: `README.md` (re-check the Solana roadmap item)
- Test: `packages/adapter-solana/test/x402.test.ts`

**Interfaces:**
- Consumes: `SignedTransfer` from Task 10.
- Produces: `settleViaFacilitator(input: FacilitatorInput): Promise<SettlementReceipt>` and `class PriceMismatchError extends Error { code = "price_mismatch" }`.

- [ ] **Step 1: Confirm the payload format against the installed package**

Run: `npm install --workspace=@agentveins/adapter-solana @x402/core @x402/svm`
Then inspect what the installed version actually exports and what shape it expects:

```bash
grep -rn "export" node_modules/@x402/svm/dist/types/index.d.ts | head -40
grep -rn "PaymentRequirements\|x402Version\|scheme" node_modules/@x402/core/dist/types/index.d.ts | head -40
```

Use `@x402/svm`'s client helper to construct the payment payload if it exposes one that accepts a pre-signed transaction. If it does not, hand-encode the header as shown below — the wire format is `base64(JSON)` of `{ x402Version, scheme: "exact", network: "solana-devnet", payload: { transaction } }`. Record whichever path you took in a comment at the top of `x402.ts`, since it is a genuinely non-obvious choice.

- [ ] **Step 2: Write the failing tests**

`packages/adapter-solana/test/x402.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PriceMismatchError, settleViaFacilitator } from "../src/x402.js";

const signed = {
  signedTransaction: new Uint8Array([1]),
  wireTransaction: "AQID",
  signature: "sig-abc",
};

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const requirements = {
  x402Version: 1,
  accepts: [{ scheme: "exact", network: "solana-devnet", maxAmountRequired: "50000", payTo: "vendorAddr" }],
};

describe("settleViaFacilitator", () => {
  it("pays and returns the signature when the quote matches the approved amount", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, requirements))
      .mockResolvedValueOnce(response(200, { data: "ok" }, { "x-payment-response": "sig-abc" }));

    const receipt = await settleViaFacilitator({
      vendorUrl: "https://api.weather.com/forecast",
      approvedAmountMinor: 50_000n,
      signed,
      facilitatorUrl: "https://x402.org/facilitator",
      fetchImpl,
    });

    expect(receipt).toEqual({ txSig: "sig-abc", rail: "solana" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses to pay more than the guard approved", async () => {
    const expensive = {
      ...requirements,
      accepts: [{ ...requirements.accepts[0]!, maxAmountRequired: "500000" }],
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(402, expensive));

    await expect(
      settleViaFacilitator({
        vendorUrl: "https://api.weather.com/forecast",
        approvedAmountMinor: 50_000n,
        signed,
        facilitatorUrl: "https://x402.org/facilitator",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(PriceMismatchError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts a quote cheaper than the approved amount", async () => {
    const cheap = {
      ...requirements,
      accepts: [{ ...requirements.accepts[0]!, maxAmountRequired: "10000" }],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, cheap))
      .mockResolvedValueOnce(response(200, { data: "ok" }, { "x-payment-response": "sig-abc" }));

    await expect(
      settleViaFacilitator({
        vendorUrl: "https://api.weather.com/forecast",
        approvedAmountMinor: 50_000n,
        signed,
        facilitatorUrl: "https://x402.org/facilitator",
        fetchImpl,
      }),
    ).resolves.toMatchObject({ txSig: "sig-abc" });
  });

  it("throws when the endpoint never asks for payment", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, { data: "free" }));
    await expect(
      settleViaFacilitator({
        vendorUrl: "https://api.weather.com/forecast",
        approvedAmountMinor: 50_000n,
        signed,
        facilitatorUrl: "https://x402.org/facilitator",
        fetchImpl,
      }),
    ).rejects.toThrow(/did not request payment/);
  });

  it("throws when the vendor rejects the payment", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(402, requirements))
      .mockResolvedValueOnce(response(402, { error: "payment invalid" }));

    await expect(
      settleViaFacilitator({
        vendorUrl: "https://api.weather.com/forecast",
        approvedAmountMinor: 50_000n,
        signed,
        facilitatorUrl: "https://x402.org/facilitator",
        fetchImpl,
      }),
    ).rejects.toThrow(/rejected the payment/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/adapter-solana/test/x402.test.ts`
Expected: FAIL — `settleViaFacilitator` is still the Task 10 stub.

- [ ] **Step 4: Write the implementation**

`packages/adapter-solana/src/x402.ts`:

```ts
import type { SettlementReceipt } from "@agentveins/core";
import type { SignedTransfer } from "./transfer.js";

export class PriceMismatchError extends Error {
  readonly code = "price_mismatch";
  constructor(approvedMinor: bigint, quotedMinor: bigint) {
    super(`the vendor quoted ${quotedMinor} minor units but only ${approvedMinor} was approved`);
    this.name = "PriceMismatchError";
  }
}

export interface FacilitatorInput {
  vendorUrl: string;
  approvedAmountMinor: bigint;
  signed: SignedTransfer;
  facilitatorUrl: string;
  network?: string;
  fetchImpl?: typeof fetch;
}

interface Accepts {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: string;
}

export async function settleViaFacilitator(input: FacilitatorInput): Promise<SettlementReceipt> {
  const doFetch = input.fetchImpl ?? fetch;
  const network = input.network ?? "solana-devnet";

  const quoteResponse = await doFetch(input.vendorUrl);
  if (quoteResponse.status !== 402) {
    throw new Error(`the endpoint did not request payment (status ${quoteResponse.status})`);
  }

  const quote = (await quoteResponse.json()) as { x402Version?: number; accepts?: Accepts[] };
  const accepted = quote.accepts?.find((candidate) => candidate.network === network && candidate.scheme === "exact");
  if (accepted === undefined) {
    throw new Error(`the endpoint offers no "exact" scheme on ${network}`);
  }

  // The vendor states the price after the guard already approved an amount, so re-check it here.
  const quotedMinor = BigInt(accepted.maxAmountRequired);
  if (quotedMinor > input.approvedAmountMinor) {
    throw new PriceMismatchError(input.approvedAmountMinor, quotedMinor);
  }

  const header = Buffer.from(
    JSON.stringify({
      x402Version: quote.x402Version ?? 1,
      scheme: "exact",
      network,
      payload: { transaction: input.signed.wireTransaction },
    }),
    "utf8",
  ).toString("base64");

  const paidResponse = await doFetch(input.vendorUrl, { headers: { "X-PAYMENT": header } });
  if (!paidResponse.ok) {
    throw new Error(`the vendor rejected the payment (status ${paidResponse.status})`);
  }

  const txSig = paidResponse.headers.get("x-payment-response") ?? input.signed.signature;
  return { txSig, rail: "solana" };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npm run build`
Expected: every test passes and the build succeeds.

- [ ] **Step 6: Add the gated devnet test script**

CI must never need a network, so real devnet runs live behind their own script. Add to `packages/adapter-solana/package.json`:

```json
"scripts": {
  "build": "tsc --build",
  "test:devnet": "vitest run --dir test --testNamePattern devnet"
}
```

Write `packages/adapter-solana/test/devnet.test.ts` so every case skips unless the environment is configured, which keeps `npm test` green on a machine with no keys:

```ts
import { describe, expect, it } from "vitest";
import { solanaAdapter } from "../src/index.js";

const configured = process.env["SOLANA_KEYPAIR"] !== undefined && process.env["SOLANA_RPC_URL"] !== undefined;

describe.skipIf(!configured)("devnet settlement", () => {
  it("settles a real USDC transfer in direct mode", async () => {
    const adapter = solanaAdapter({
      keypair: JSON.parse(process.env["SOLANA_KEYPAIR"]!),
      rpcUrl: process.env["SOLANA_RPC_URL"]!,
      mode: "direct",
    });
    const receipt = await adapter.execute({
      to: process.env["VENDOR_ADDRESS"]!,
      amountMinor: 10_000n,
      reason: "devnet smoke test",
    });
    expect(receipt.txSig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);
  }, 60_000);
});
```

- [ ] **Step 7: Update the README roadmap**

Re-check `- [x] Solana devnet payment path (x402)` in `README.md`, since it is now true.

- [ ] **Step 8: Commit**

```bash
git add packages/adapter-solana README.md
git commit -m "feat(adapter-solana): settle through an x402 facilitator with a price-mismatch guard"
```

---

### Task 12: The demo vendor server

**Files:**
- Create: `examples/demo/package.json`, `examples/demo/tsconfig.json`, `examples/demo/src/vendor.ts`
- Test: `examples/demo/test/vendor.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createVendorApp(options: VendorOptions): express.Express` and `interface VendorOptions { priceMinor: bigint; payTo: string; network?: string }`.

- [ ] **Step 1: Create the package and install express**

`examples/demo/package.json`:

```json
{
  "name": "@agentveins/demo",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "demo": "tsx src/demo.ts",
    "vendor": "tsx src/vendor.ts"
  },
  "dependencies": {
    "@agentveins/core": "0.0.1",
    "@agentveins/adapter-solana": "0.0.1"
  }
}
```

Run: `npm install --workspace=@agentveins/demo express && npm install -D @types/express`

- [ ] **Step 2: Write the failing tests**

`examples/demo/test/vendor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createVendorApp } from "../src/vendor.js";

async function request(path: string, headers: Record<string, string> = {}) {
  const app = createVendorApp({ priceMinor: 50_000n, payTo: "vendorAddr" });
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: response.status, body: await response.json() as Record<string, unknown>, headers: response.headers };
  } finally {
    server.close();
  }
}

describe("vendor server", () => {
  it("answers 402 with payment requirements when unpaid", async () => {
    const { status, body } = await request("/forecast");
    expect(status).toBe(402);
    expect(body).toMatchObject({
      x402Version: 1,
      accepts: [{ scheme: "exact", network: "solana-devnet", maxAmountRequired: "50000", payTo: "vendorAddr" }],
    });
  });

  it("serves the resource when an X-PAYMENT header is present", async () => {
    const payment = Buffer.from(JSON.stringify({ payload: { transaction: "AQID" } })).toString("base64");
    const { status, body, headers } = await request("/forecast", { "X-PAYMENT": payment });
    expect(status).toBe(200);
    expect(body).toHaveProperty("forecast");
    expect(headers.get("x-payment-response")).toBeTruthy();
  });

  it("rejects a malformed payment header", async () => {
    const { status } = await request("/forecast", { "X-PAYMENT": "not-base64-json" });
    expect(status).toBe(402);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run examples/demo/test/vendor.test.ts`
Expected: FAIL — cannot resolve `../src/vendor.js`.

- [ ] **Step 4: Write the vendor server**

`examples/demo/src/vendor.ts`:

```ts
import express from "express";

export interface VendorOptions {
  priceMinor: bigint;
  payTo: string;
  network?: string;
}

export function createVendorApp(options: VendorOptions): express.Express {
  const app = express();
  const network = options.network ?? "solana-devnet";

  app.get("/forecast", (req, res) => {
    const header = req.get("X-PAYMENT");

    if (header === undefined) {
      res.status(402).json({
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network,
            maxAmountRequired: options.priceMinor.toString(),
            payTo: options.payTo,
            asset: "USDC",
          },
        ],
      });
      return;
    }

    let transaction: string | undefined;
    try {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        payload?: { transaction?: string };
      };
      transaction = decoded.payload?.transaction;
    } catch {
      transaction = undefined;
    }

    if (transaction === undefined) {
      res.status(402).json({ error: "the X-PAYMENT header is not a valid x402 payload" });
      return;
    }

    // The demo vendor trusts the payload it receives; a production vendor would verify and settle it.
    res.setHeader("x-payment-response", `demo-${transaction.slice(0, 12)}`);
    res.status(200).json({ forecast: "22C, light rain", issuedAt: new Date().toISOString() });
  });

  return app;
}

if (process.argv[1]?.endsWith("vendor.ts")) {
  const port = Number(process.env["VENDOR_PORT"] ?? 3001);
  createVendorApp({ priceMinor: 50_000n, payTo: process.env["VENDOR_ADDRESS"] ?? "vendorAddr" })
    .listen(port, () => process.stdout.write(`vendor listening on http://localhost:${port}\n`));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run examples/demo/test/vendor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/demo package.json package-lock.json
git commit -m "feat(demo): add a 402-protected vendor endpoint"
```

---

### Task 13: The demo agent loop

**Files:**
- Create: `examples/demo/src/mockAdapter.ts`, `examples/demo/src/demo.ts`
- Test: `examples/demo/test/demo.test.ts`

**Interfaces:**
- Consumes: `createGuard`, `memoryAuditSink`, `fileAuditSink`, `verifyAuditLog`, `formatAmount` from `@agentveins/core`; `solanaAdapter` from `@agentveins/adapter-solana`; `createVendorApp` from Task 12.
- Produces: `mockAdapter(): WalletAdapter` and `runDemo(options: DemoOptions): Promise<DemoSummary>` where `interface DemoSummary { settled: number; blocked: number; failed: number; verified: boolean; tamperDetected: boolean }`.

- [ ] **Step 1: Write the failing test**

`examples/demo/test/demo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runDemo } from "../src/demo.js";

describe("runDemo", () => {
  it("completes the full governed loop offline", async () => {
    const summary = await runDemo({ mock: true, quiet: true });

    expect(summary.settled).toBe(10);
    expect(summary.blocked).toBeGreaterThanOrEqual(3);
    expect(summary.failed).toBe(0);
    expect(summary.verified).toBe(true);
    expect(summary.tamperDetected).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run examples/demo/test/demo.test.ts`
Expected: FAIL — cannot resolve `../src/demo.js`.

- [ ] **Step 3: Write the mock adapter**

`examples/demo/src/mockAdapter.ts`:

```ts
import type { SettlementReceipt, SettlementRequest, WalletAdapter } from "@agentveins/core";

export function mockAdapter(): WalletAdapter {
  let counter = 0;
  return {
    name: "solana",
    currency: "USDC",
    async execute(req: SettlementRequest): Promise<SettlementReceipt> {
      counter++;
      return { txSig: `mock-${counter}-${req.amountMinor}`, rail: "solana-mock" };
    },
  };
}
```

- [ ] **Step 4: Write the demo**

`examples/demo/src/demo.ts`:

```ts
import { generateKeyPairSync } from "node:crypto";
import {
  createGuard, formatAmount, memoryAuditSink, verifyAuditLog,
  type AuditEntry, type PayResult, type Policy, type WalletAdapter,
} from "@agentveins/core";
import { solanaAdapter } from "@agentveins/adapter-solana";
import type { Server } from "node:http";
import { mockAdapter } from "./mockAdapter.js";
import { createVendorApp } from "./vendor.js";

export interface DemoOptions {
  mock: boolean;
  quiet?: boolean;
  mode?: "x402" | "direct";
}

export interface DemoSummary {
  settled: number;
  blocked: number;
  failed: number;
  verified: boolean;
  tamperDetected: boolean;
}

function buildPolicy(allowedHost: string): Policy {
  return {
    budgets: [
      { period: "per_tx", limit: "0.10", currency: "USDC" },
      { period: "daily", limit: "0.50", currency: "USDC" },
    ],
    vendors: { mode: "allowlist", entries: [allowedHost] },
    killSwitch: { frozen: false },
  };
}

function safe(value: string, max = 32): string {
  return JSON.stringify(value.length > max ? `${value.slice(0, max)}…` : value);
}

export async function runDemo(options: DemoOptions): Promise<DemoSummary> {
  const log = options.quiet === true ? () => {} : (line: string) => process.stdout.write(`${line}\n`);
  const keys = generateKeyPairSync("ed25519");
  const audit = memoryAuditSink();

  const mode = options.mode ?? "x402";
  let vendorServer: Server | undefined;
  let adapter: WalletAdapter;

  if (options.mock) {
    adapter = mockAdapter();
  } else {
    const port = Number(process.env["VENDOR_PORT"] ?? 3001);
    const payTo = process.env["VENDOR_ADDRESS"] ?? "";
    if (mode === "x402") {
      // The demo is its own vendor: a local 402-protected endpoint the agent actually pays.
      vendorServer = createVendorApp({ priceMinor: 50_000n, payTo }).listen(port);
      log(`  vendor listening on http://localhost:${port}`);
    }
    adapter = solanaAdapter({
      keypair: JSON.parse(process.env["SOLANA_KEYPAIR"] ?? "null"),
      rpcUrl: process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com",
      mode,
      facilitatorUrl: process.env["X402_FACILITATOR_URL"],
    });
  }

  const vendorUrl = options.mock || mode === "direct"
    ? "https://api.weather.com/forecast"
    : `http://localhost:${process.env["VENDOR_PORT"] ?? 3001}/forecast`;
  const policy = buildPolicy(new URL(vendorUrl).hostname);

  const guard = await createGuard({
    policy, adapters: [adapter], audit,
    agent: "weather-agent", signingKey: keys.privateKey,
  });

  const counts = { settled: 0, blocked: 0, failed: 0 };
  function record(label: string, result: PayResult): void {
    counts[result.status]++;
    if (result.status === "settled") {
      log(`  ✓ ${label} settled  tx=${result.txSig}`);
    } else if (result.status === "blocked") {
      log(`  ✗ ${label} BLOCKED  ${result.violation.code} — ${result.violation.message}`);
      if (result.violation.detail !== undefined) {
        log(`      ${JSON.stringify(result.violation.detail)}`);
      }
      log("      no chain call was made");
    } else {
      log(`  ! ${label} failed   ${result.error.code} — ${result.error.message}`);
    }
  }

  log("\n── Act 1: the policy ───────────────────────────────");
  log(`  per-tx limit  0.10 USDC`);
  log(`  daily limit   0.50 USDC`);
  log(`  allowlist     ${policy.vendors.entries.join(", ")}`);

  log("\n── Act 2: the agent works normally ─────────────────");
  for (let i = 1; i <= 10; i++) {
    const result = await guard.pay({ to: vendorUrl, amount: "0.05", currency: "USDC", reason: `forecast query ${i}` });
    record(`payment ${i} (0.05)`, result);
  }

  log("\n── Act 3: the guard says no ────────────────────────");
  record("oversized payment (0.25)", await guard.pay({ to: vendorUrl, amount: "0.25", currency: "USDC", reason: "bulk forecast" }));
  record("unapproved vendor", await guard.pay({ to: "https://evil.example/drain", amount: "0.01", currency: "USDC", reason: "unknown" }));
  record("payment 11 (0.05)", await guard.pay({ to: vendorUrl, amount: "0.05", currency: "USDC", reason: "forecast query 11" }));

  log("\n── Act 4: the kill switch ──────────────────────────");
  await guard.freeze();
  log("  operator froze the agent");
  record("payment after freeze", await guard.pay({ to: vendorUrl, amount: "0.01", currency: "USDC", reason: "retry" }));

  log("\n── Act 5: proof ────────────────────────────────────");
  for (const entry of audit.entries) {
    log(`  #${entry.seq} ${entry.outcome.padEnd(7)} ${formatAmount(BigInt(entry.amountMinor))} ${safe(entry.vendorNormalized)} ${safe(entry.reason)}`);
  }

  const verified = await verifyAuditLog(audit.entries, keys.publicKey);
  log(`\n  verifyAuditLog → ${verified.ok ? "OK" : "FAILED"} (${verified.checked} entries checked)`);

  const tampered: AuditEntry[] = audit.entries.map((entry, index) =>
    index === 3 ? { ...entry, amountMinor: "1" } : entry,
  );
  const afterTamper = await verifyAuditLog(tampered, keys.publicKey);
  log(`  after editing one amount → ${afterTamper.ok ? "OK" : `FAILED at seq ${afterTamper.failure?.seq} (${afterTamper.failure?.reason})`}`);

  vendorServer?.close();

  return {
    settled: counts.settled,
    blocked: counts.blocked,
    failed: counts.failed,
    verified: verified.ok,
    tamperDetected: !afterTamper.ok,
  };
}

if (process.argv[1]?.endsWith("demo.ts")) {
  await runDemo({
    mock: process.argv.includes("--mock"),
    mode: process.argv.includes("--direct") ? "direct" : "x402",
  });
}
```

- [ ] **Step 5: Run the test and the demo**

Run: `npx vitest run examples/demo/test/demo.test.ts && npm run demo -- --mock`
Expected: the test passes and the demo prints all five acts, ending with a verification success followed by a detected tamper.

- [ ] **Step 6: Commit**

```bash
git add examples/demo/src/mockAdapter.ts examples/demo/src/demo.ts examples/demo/test/demo.test.ts
git commit -m "feat(demo): add the five-act governed agent loop with audit verification"
```

---

### Task 14: Continuous integration and the README quickstart check

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md` (roadmap, quickstart verification note)

**Interfaces:**
- Consumes: the `build`, `test`, and `demo` scripts from Task 1.
- Produces: a green CI run requiring no network.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm run demo -- --mock
```

- [ ] **Step 2: Verify the CI steps locally**

Run: `npm ci && npm run build && npm test && npm run demo -- --mock`
Expected: all four succeed with no network access to any rail.

- [ ] **Step 3: Re-check the delivered roadmap items**

In `README.md`, the roadmap should now read:

```markdown
- [x] Policy engine: budgets, allowlist, kill switch
- [x] Solana devnet payment path (x402)
- [x] Signed audit log
- [ ] Base adapter
- [ ] Velocity rules
- [ ] Hosted dashboard: team policies, alerts, compliance exports
- [ ] Privacy: payment-metadata redaction
```

- [ ] **Step 4: Walk the quickstart end to end**

Follow the README from a clean clone: `npm install`, then run the demo. Time it. If it takes longer than ten minutes, fix the README rather than lowering the bar — the integration target is a product requirement, not an aspiration.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: build, test, and run the mocked demo on every push"
```

---

## Deferred, on purpose

Do not build these during this plan, even where a seam makes them tempting: velocity rules, approval workflows, Base and Cloudflare adapter implementations, a hosted dashboard, and metadata redaction. The seams exist so they land cleanly later.

## Definition of done

Core compiles under TS strict with every policy test passing offline. `npm run demo -- --mock` completes the five acts in CI with no network. Against Solana devnet, the same demo settles real payments, exhausts the daily budget, blocks with a structured violation, honors the kill switch, and closes by verifying the audit log and then detecting a tampered entry. The README quickstart takes a stranger under ten minutes.

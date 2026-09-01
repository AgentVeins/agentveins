# @agentveins/mcp

Governed payments as a tool any MCP-capable agent can call. The agent asks to pay; the
guard decides; the wallet key never leaves this process.

```bash
npm install @agentveins/mcp
```

Write a policy — the rules are the product, so this is the one thing that cannot have a
default:

```json
{
  "budgets": [
    { "period": "per_tx", "limit": "1.00",  "currency": "USDC" },
    { "period": "daily",  "limit": "10.00", "currency": "USDC" }
  ],
  "vendors": { "mode": "allowlist", "entries": ["api.weather.com"] },
  "killSwitch": { "frozen": false }
}
```

Then point any MCP-capable agent at it. Two variables:

```json
{
  "mcpServers": {
    "agentveins": {
      "command": "npx",
      "args": ["-y", "@agentveins/mcp"],
      "env": {
        "AGENTVEINS_POLICY": "/absolute/path/to/policy.json",
        "AGENTVEINS_RAIL": "mock"
      }
    }
  }
}
```

The audit log, its anchor, the approval store and the signing key all live beside the
policy file unless you name them. The key is created on the first run and kept; the
public half is written next to it, so `veins --verify` has something to check the log
against.

## Tools

| | |
| --- | --- |
| `pay` | attempts a payment. Settles, or is refused with the rule that refused it |
| `check` | answers whether a payment would pass, moving nothing |
| `spend_state` | every budget, what is spent, what remains, and whether the agent is frozen |

Nothing here can loosen a rule. There is no `grant` and no `unfreeze`: an agent may spend
what it was allowed and ask what it is allowed, and may not widen either.

A blocked payment is a tool **result**, not a tool error. A denial is the policy working,
and reporting it as an error teaches an agent to treat governance as a malfunction and
retry against it. Only a rail failure is an error.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AGENTVEINS_RAIL` | `solana`, or `mock` to govern payments that never move money. Inferred as `solana` when `SOLANA_KEYPAIR_PATH` is set |
| `AGENTVEINS_POLICY` | path to the policy JSON |
| `AGENTVEINS_SIGNING_KEY` | ed25519 private key, PEM. Defaults to `operator.key.pem` beside the policy, created on first run |
| `AGENTVEINS_AUDIT` | the audit log, which holds the spend counter. Defaults to `audit.jsonl` beside the policy |
| `AGENTVEINS_ANCHOR` | detects a deleted log. Defaults to `audit.anchor.json` beside the policy |
| `AGENTVEINS_APPROVALS` | approval store, used when the policy sets a threshold. Defaults beside the policy |
| `AGENTVEINS_AGENT` / `_LOG_ID` | identity recorded on every entry |
| `SOLANA_KEYPAIR_PATH` / `SOLANA_RPC_URL` | when the rail is `solana` |
| `SOLANA_MODE` | `direct` or `x402`; defaults to `direct` |

Only `AGENTVEINS_POLICY` and `AGENTVEINS_RAIL` are required, and the rail is inferred as
`solana` when `SOLANA_KEYPAIR_PATH` is set. Nothing is ever inferred as `mock` — a server
that reported settlements while moving nothing is the one guess this must not make.

Everything else defaults beside the policy file, which is a location you chose. The
alternative is the process's working directory, which an MCP client picks and you never
see — and since a missing audit log reads as a first run rather than an error, a path that
wanders would hand back the whole daily budget on every launch from somewhere new.

The signing key is generated once and reused. A guard replays its audit log at startup and
refuses one it cannot verify, so a key that changed between launches would work exactly
once; that argument calls for a key that *persists*, not one you have to produce by hand. A
key file that exists but cannot be read is an error rather than a reason to write a new
one, because replacing it would orphan every entry the old key signed.

Every diagnostic, including that refusal, goes to stderr: stdout is the MCP protocol, and
writing anything else there would corrupt the session.

## Mounting your own guard

```typescript
import { serveGuard } from "@agentveins/mcp";

await serveGuard(myGuard, "solana");
```

`serveGuard` reads no environment and no files, so an operator with their own guard — a
database-backed approval store, a custom adapter — mounts it directly.

Full documentation: **[docs.agentveins.com](https://docs.agentveins.com)**

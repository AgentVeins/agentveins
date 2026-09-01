# @agentveins/mcp

Governed payments as a tool any MCP-capable agent can call. The agent asks to pay; the
guard decides; the wallet key never leaves this process.

Not yet published to npm. Build it from a clone of the monorepo:

```bash
git clone https://github.com/AgentVeins/agentveins.git && cd agentveins
npm install && npm run build --workspace=@agentveins/mcp
```

Then point any MCP-capable agent at the built binary:

```json
{
  "mcpServers": {
    "agentveins": {
      "command": "node",
      "args": ["/absolute/path/to/agentveins/packages/mcp/dist/bin.js"],
      "env": {
        "AGENTVEINS_RAIL": "mock",
        "AGENTVEINS_POLICY": "/absolute/path/to/policy.json",
        "AGENTVEINS_SIGNING_KEY": "/absolute/path/to/operator.key.pem",
        "AGENTVEINS_AUDIT": "/absolute/path/to/audit.jsonl"
      }
    }
  }
}
```

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
| `AGENTVEINS_RAIL` | `solana`, or `mock` to govern payments that never move money |
| `AGENTVEINS_POLICY` | path to the policy JSON |
| `AGENTVEINS_SIGNING_KEY` | ed25519 private key, PEM. Must persist between runs |
| `AGENTVEINS_AUDIT` | absolute path to the audit log — it holds the spend counter |
| `AGENTVEINS_ANCHOR` / `_APPROVALS` | optional store paths |
| `AGENTVEINS_AGENT` / `_LOG_ID` | identity recorded on every entry |
| `SOLANA_KEYPAIR_PATH` / `SOLANA_RPC_URL` | when the rail is `solana` |
| `SOLANA_MODE` | `direct` or `x402`; defaults to `direct` |

The server refuses to start without a rail, a policy, a signing key, or an audit path, and
its error names the missing variable. The audit path is required rather than defaulted: an
MCP client launches this server with a working directory you neither pick nor see, and a
log that is missing there reads as a first run — a silently reset budget. `AGENTVEINS_ANCHOR`
is optional, but without it a deleted log reads the same way, so the server warns on stderr
when it is unset. The key must persist: a guard replays its audit log at startup and
refuses one it cannot verify, so a key generated per launch would work exactly once and
then fail forever.

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

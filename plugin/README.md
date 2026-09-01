# AgentVeins plugin

The AgentVeins MCP server and a skill for using it well.

```
/plugin marketplace add AgentVeins/agentveins
/plugin install agentveins
```

The server gives the agent three tools — `pay`, `check` and `spend_state` — and holds the
wallet key itself, so the agent cannot pay around the guard. The skill teaches it how to
behave with them: check before planning, write a reason worth reading, and stop rather than
retry when the refusal is one no retry can fix.

Set `AGENTVEINS_POLICY` to the absolute path of a policy file. Everything else — the audit
log, its anchor, the approval store, the signing key — is created beside it on first run.

Full documentation: **[docs.agentveins.com](https://docs.agentveins.com)**

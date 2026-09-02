# @agentveins/cli

Review and approve the payments an AgentVeins guard is holding, from a terminal.

```bash
npm install -g @agentveins/cli
```

A guard records that a payment needs a person and refuses it until one decides. It never
carries the question to anyone — that belongs wherever your organisation already makes
decisions. This is one worked example of doing it: a person, at a prompt.

```bash
veins pending
```

```
  log verified — 4,182 entries

  pending approvals — 2

   1  pricewatch-eu → "api.pricingdata.io"
      12.000000 USDC   "Q3 historical basket, DE+FR"
      3 attempts, last 6m ago   audit 8f21c4a9-…

   2  pricewatch-eu → "api.retailfeed.com"
      7.500000 USDC    "competitor SKU refresh"
      1 attempt, last 22m ago   audit b904de17-…
```

```bash
veins approve 1 --ttl 30m
```

The agent's next attempt on those exact terms settles. The second row keeps waiting.

## It keeps no state

There is no queue to fall out of step with the guard. Every blocked attempt is already in the
audit log with its agent, vendor, amount and reason, so the log *is* the queue, and each
entry's `auditId` is the identifier a person can quote back.

An agent that retries writes one entry per attempt, but a person is being asked one question
rather than five — so attempts fold into a single row and the count is shown instead.
`3 attempts` is information about urgency, not three decisions owed.

Rows an unspent approval already covers disappear, judged the same way the guard judges them.
Showing a row as satisfied when the guard would still refuse it would send you away believing
you were done.

## Verification

`--verify` checks the log's signatures before reading it, and **refuses to approve against a
log that fails**.

It earns its keep when the log and the approval store are separated — the store behind its own
access control, or a log shipped from another machine. An attacker who can forge log entries
can otherwise fabricate a plausible request and have a real person authorise terms of the
attacker's choosing. It buys less when both sit on one box under the same permissions: whoever
can forge the log can write the store directly and skip you entirely.

Without the flag the tool reads a file it cannot prove is intact, and says so in `--help`.

## Configuration

A `veins.config.json` in the working directory or any parent supplies the same options, so a
service directory carries its own paths and you type no flags:

```json
{
  "log": "./audit.jsonl",
  "approvals": "./approvals.json",
  "verify": "/etc/pricewatch/operator.pub.pem",
  "ttl": "30m"
}
```

Flags beat the file. Relative paths in it resolve against the file itself rather than your
working directory — it is found by walking up, so the same config read from two directories
must not point at two different logs. An unknown key is an error rather than something
ignored: a misspelled `verify` would otherwise leave you believing every approval had been
checked against a signed log when none had been.

## Commands

| | |
| --- | --- |
| `veins pending` | list what is waiting on a person |
| `veins approve` | pick a row and grant it |
| `veins approve 2 --yes` | grant the second row without prompting |
| `veins help` | the options, and what running without `--verify` costs |

| Option | |
| --- | --- |
| `--log <path>` | audit log to read. Default `./audit.jsonl` |
| `--approvals <path>` | approval store to write. Default `./approvals.json` |
| `--ttl <duration>` | how long a grant stands. Default `15m`, maximum `7d` |
| `--verify <path>` | ed25519 public key, PEM |
| `--config <path>` | use this config instead of searching |
| `--yes`, `-y` | skip the confirmation prompt |

`--ttl` refuses a bare number: `15` could mean minutes or seconds, and those differ by sixty
on how long an agent may move money. `--yes` without a row number is refused rather than
choosing for you — that costs a rerun, where guessing costs a payment nobody picked.

## What a grant authorises

One agent, one vendor, one exact amount, once, until it expires. Granting twice authorises
twice: a person who approves the same payment on two occasions has made two decisions, and the
store keeps them apart.

Grants go through `ApprovalStore.grant()`, the same interface the guard reads. Nothing about
this CLI is privileged — an approvals UI, a Slack action or a row written by an on-call script
are all doing exactly what it does.

Full documentation: **[docs.agentveins.com](https://docs.agentveins.com)**

MIT

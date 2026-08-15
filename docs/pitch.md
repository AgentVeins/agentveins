# AgentVeins

**A spending limit for AI agents — and a receipt for every attempt.**

AI agents are starting to pay for things on their own: data, APIs, compute, access to
websites that now charge for it. The payment rails already work. What is missing is the
part every company already takes for granted with human employees — a limit on the card, a
list of approved suppliers, an off switch, and a record of what was bought and why.

AgentVeins is that layer. It sits between an agent and its money. Every payment the agent
tries to make passes through AgentVeins first, and every attempt — approved or refused —
gets written down.

---

## The problem

Imagine handing a new hire a company card on their first day with no limit, no approval
list, and no expense report. Most companies would never do it. But that is exactly the
deal an AI agent gets today: full access to a wallet, thousands of decisions an hour, and
no one watching.

The failure does not need malice. A retry loop that does not know when to stop, a
misread price, or a web page that quietly tells the agent to pay somewhere else — any one
of them can drain a balance overnight across thousands of tiny payments. And when someone
asks the next morning where the money went, there is no answer, because nothing kept a
record.

Teams solve this today by not letting agents pay at all. That works, and it is also why
the whole category is stuck. AgentVeins removes the reason to say no.

---

## What it does

Before any money moves, AgentVeins asks four questions:

| The check | The question it answers |
|---|---|
| **Approved vendor** | Is this someone the owner said we can pay? |
| **Budget** | Is this within the limit for one payment, and for today? |
| **Kill switch** | Is this agent still allowed to spend at all? |
| **Record** | Can we prove afterwards exactly what happened? |

If everything passes, the payment goes through and the agent never notices AgentVeins is
there. If something fails, the agent gets a clear, specific answer — *over the daily
limit*, *vendor not approved* — instead of a crash. That matters more than it sounds: an
agent that gets a real reason can pick a cheaper supplier or ask a human. An agent that
gets an error just tries again.

Either way, the attempt is recorded. The record is sealed in a way that makes tampering
visible: change one line after the fact, delete one, or move one, and the record stops
checking out. Anyone can run the check, including someone who does not trust the operator.

The one-sentence version: **corporate card controls, for AI agents.**

The reason it is a separate product rather than a wallet feature: an agent rarely has just
one wallet. It has one on this chain, one on that platform, one issued by whatever service
it signed up for. A limit that lives inside a single wallet only governs that wallet.
AgentVeins holds one policy across all of them, so "$25 a day" means $25 a day in total —
not $25 per wallet the agent happens to hold. **One policy, every wallet.**

---

## See it in two minutes

The demo runs on a laptop with no setup and no network. It plays out in five acts.

**Act 1 — Nothing feels governed.** An agent buys weather forecasts, a few cents at a
time. Payment after payment settles. The budget ticks down on screen. This is the point:
when the rules are being followed, the agent behaves as if AgentVeins is not there.

**Act 2 — The agent reaches too far.** It tries a payment larger than the per-payment cap.
Refused, with the reason stated, and — this is the part worth watching — no payment is
attempted at all. Nothing is sent and then reversed. The money never leaves.

**Act 3 — The day runs out.** Small payments keep landing until the daily budget is
exhausted. The next one is refused. The agent is not broken; it is finished for the day,
and it knows why.

**Act 4 — The operator pulls the cord.** A human freezes the agent. The very next payment
dies instantly, no matter what the agent was in the middle of.

**Act 5 — The proof.** The full record prints, and the verification passes. Then we edit a
single character in one line — and re-run it. It fails, and it names the exact entry that
was touched.

That last act is the whole pitch. Every governance product claims its records are
trustworthy. This one shows you what it looks like when someone lies to it.

---

## What is real today

Honest status, because a demo that oversells is a demo nobody trusts twice.

| | Status |
|---|---|
| The rules engine — budgets, approved vendors, kill switch | **Working** |
| The sealed, verifiable record | **Working** |
| Budgets that survive a restart (an agent cannot reboot its way to a fresh budget) | **Working** |
| Real payments on Solana's test network | **Working** |
| The open payment standard (x402) path | **Built and verified against the standard's own checker — not yet run against a live server** |
| Approved destinations (refusing a payment redirected to an address you did not approve) | **Working** |
| Other chains and platforms (Base, Cloudflare) | Planned |
| Speed limits, approval workflows, hosted dashboard | Planned |

Two limits worth stating out loud, because they are documented in the repository rather
than hidden in it:

- On the open-standard path, you can now list the destinations you approve, and AgentVeins
  refuses any payment routed somewhere else — before it signs anything. What it still cannot
  prove is that an approved destination genuinely **belongs to** the vendor; it proves only
  that you named it in advance. Tying an address to a vendor's identity needs a signed vendor
  record, which is out of scope for this first version. And if you leave the destination list
  out, that check simply does not run: the amount stays governed, the payee does not.
- The record can prove that someone edited or deleted history. It cannot yet prove that
  someone restored an older, complete copy of it. That needs storage the operator cannot
  rewrite, which is deliberately out of scope for this first version.

Everything is open source under the MIT license.

---

## Why now

- Payments made by machines stopped being a thought experiment. The x402 standard now sits
  under Linux Foundation governance with Visa, Stripe, Google, and the Solana Foundation
  among 40+ members.
- Cloudflare measured bot traffic passing 57% of web requests in mid-2026 and launched a
  way to charge those bots per page. The web is becoming something agents pay to read.
- Roughly 31% of enterprises already run agents in production, while about 60% have no
  formal governance for them.

The rails are here. The seatbelts are not.

---

## What AgentVeins is not

- **Not a wallet.** It never holds anyone's money.
- **Not a payment network.** The existing rails move the funds.
- **Not an agent framework.** Bring whatever agent you already built.

Every wallet, rail, and framework is something AgentVeins plugs into — not something it
competes with.

---

## The ask

**If you build agents:** install it and wrap the one function where your agent spends
money. Target is under ten minutes from install to your first governed payment. Then tell
us where it got in your way.

**If you are considering backing this:** the rules engine, the sealed record, and the
Solana path are built and tested. Support goes toward the next chains, the speed limits
and human-approval workflows that larger teams ask for first, and the dashboard that lets
a non-engineer set the policy.

**If you are judging this:** run `npm run demo -- --mock`. It needs no network, no keys,
and no accounts, and it ends by catching a forged record live.

**agentveins.com** · MIT License · Built on Solana

---
---

## ⚠️ Verify before you send this

*This section is a working note. Delete it before the document goes to anyone.*

| Claim | What to check |
|---|---|
| x402 under Linux Foundation governance, Visa / Stripe / Google / Solana Foundation, 40+ members | Confirm the member list and that the governance move is still accurately described. Membership pages change. |
| Cloudflare: bot traffic past 57% of web requests, mid-2026 | Find the original Cloudflare Radar post or report and keep the link. Cite the date the figure covers, not the date you read it. |
| 31% of enterprises run agents in production; 60% lack formal governance | Identify the source survey by name, year, and sample. Two unattributed percentages side by side is the easiest thing in this document for a judge to challenge. |
| "Under ten minutes from install to first governed payment" | This is the project's stated target. Have one person who has never seen the repository actually do it, timed, before presenting it as fact. |
| "Alpenglow-era, ~150 ms finality" (used in the repository README) | Left out of this document on purpose — it is a network claim, not a product claim, and it dates quickly. Add it back only with a current source. |
| The status table above | Re-check it before every send. It is the most valuable part of this document to the audiences who matter, and the fastest to go stale. |

# AgentVeins
**One policy, every wallet. Cross-rail spend governance, approvals, and audit for AI agents.**
*agentveins.com*

---

## One-liner
Set budgets, approve vendors, require human sign-off, kill runaway agents, and prove every payment — one policy enforced across every wallet and rail your agents use.

## Problem
Companies are deploying AI agents at scale, and the internet is being rebuilt to charge those agents for access. Wallet providers are responding with per-wallet guardrails — Cloudflare Wallets (Aug 2026) ships allowances, allowlists, and transaction caps natively. But real agent deployments hold **multiple wallets across multiple rails** (Cloudflare, Coinbase, Crossmint, raw Solana/Base keys), and per-wallet caps can't see aggregate spend, can't enforce one org-wide policy, and each produces its own siloed log. There is still no way to govern, approve, and audit agent spending **across** wallets.

## What it does
Every agent payment passes through our checkpoint before money moves — regardless of which wallet pays:
1. **Is the vendor approved?** — one allowlist across all rails
2. **Is it within budget?** — per-payment, daily, and periodic limits on *aggregate* spend, not per-wallet silos
3. **Does it need a human?** — approval workflows: payments above a threshold pause for owner sign-off
4. **Is behavior normal?** — velocity checks against runaway loops
5. **Is the agent still authorized?** — instant org-wide kill switch, across every wallet at once

Allowed payments proceed untouched. Blocked ones return a structured reason. Every attempt on every rail lands in **one** tamper-evident audit log: what was paid, from which wallet, to whom, when, and the stated reason — exportable for finance and compliance.

## What it is NOT
Not a wallet, not a payment rail, not an agent framework, not a chain. Wallets with built-in caps (Cloudflare, Coinbase) are rails we govern, not competitors — the same way 1Password isn't competing with websites' own login forms.

## Who it's for
1. **Developers** building agents that make x402 payments → adopt the free open-source SDK
2. **Teams/companies** running agents across multiple wallets/rails → pay for the dashboard, approvals, alerts, and compliance exports (later)

## Why now
- **The category was just validated at the highest level:** Cloudflare — sitting in front of ~1 in 5 websites — launched Wallets (Aug 4, 2026) with spending guardrails as the *headline feature*, completing its two-sided machine-payment stack with the Monetization Gateway. Per-wallet caps are becoming table stakes; cross-wallet governance is the next layer up.
- **Agents are deployed at scale:** 31% of enterprises run at least one AI agent in production; Gartner projects 40% of enterprise apps will embed agents by end of 2026, up from under 5% in 2025.
- **The governance gap is measured and budgeted:** 72% of enterprises believe they control their AI, but few have visibility into what agents spend; enterprises now allocate ~16.7% of AI budgets to agent security/governance (IDC); 57–68% plan to switch or add governance vendors within 12 months (VentureBeat).
- **Trust research says limits alone aren't enough:** Forrester found 75% of consumers are uncomfortable with autonomous agent payments *even with spending limits* — approval workflows (human-in-the-loop) are the trust unlock, and nobody's headline feature yet.
- **Machine traffic is now the majority of the web:** ~57.4% of HTTP requests are bot-originated (Cloudflare Radar, June 2026), driven by AI agents. *(Caveat: measures page loads, not usage.)*
- **The payment standard consolidated:** x402 under Linux Foundation governance with Visa, Stripe, Mastercard, Google, AWS, Cloudflare, and the Solana Foundation; ~160M transactions settled to date.
- **Sub-second settlement is arriving:** Solana's Alpenglow (~150ms finality, mainnet late Q3/Q4 2026) makes real-time machine-to-machine payments practical.

## Why us
- Built agent-commerce systems already (AgentRail — decentralised AI agent commerce)
- DeFi and payments background (yield aggregator; crypto-exchange internship at Hata)
- Inside the Superteam Malaysia network — the exact channel funding this category

## Competitive position
- **First-party per-wallet guardrails:** Cloudflare Wallets (live, partially — handles only for now), Coinbase/Crossmint/MoonPay expected to bundle the same. These validate the category and commoditize *single-wallet* caps — they are adapters for us, not rivals.
- **Closest independent players:** Flovia (agent-payment analytics), Clawpump (agentic finance) — hackathon-stage, no cross-rail governance, no moat yet.
- **The open layer:** cross-wallet policy, approval workflows, and unified compliance-grade audit have no owner. Enterprise buyers name spend visibility and control as the #1 gap, and no wallet provider will build governance for its competitors' wallets.
- **Chain positioning:** Solana-first for ecosystem funding; Base and Cloudflare Wallets adapters next — the multi-rail reality *is* the product thesis.

## Honest risks
- **Paying agents are early:** a meaningful share of x402 volume is testing/self-dealing. Agents exist at scale; *paying* agents are the bet — though Cloudflare completing both sides of the market materially shortens the odds.
- **First-party risk, updated:** basic caps just got absorbed into wallets, as predicted. The remaining bet is that cross-wallet governance stays independent (wallet providers won't govern rivals' wallets). If a neutral giant (Stripe, Visa) ships cross-rail governance as GA, pivot to the privacy/metadata-redaction angle or a vertical niche.
- **Fallback that de-risks the thesis:** the same policy/approval/audit layer applies to agents spending via fiat rails (virtual cards, issuing APIs) — the product doesn't depend on crypto surviving the hype cycle.

## Business model
Open-source core (SDK/middleware + adapters) → paid team tier: hosted dashboard, approval workflows, alerts, compliance-grade audit exports. For the next 6 months, "revenue" = grants and hackathon prizes; the metric that matters = external developers using it.

## 6-month plan
- **Week 0 (now):** repo + README live; claim `agentveins` handles AND the `cloudflare.pay` wallet handle (namespace land grab); Superteam MY announcement.
- **Weeks 0–6:** Ship open-source TypeScript SDK — budgets + allowlist + kill switch + audit log, wallet-adapter architecture from day one; Solana devnet adapter fully working; Base and Cloudflare Wallets adapters stubbed. Demo: an agent hits its aggregate daily budget mid-loop and gets blocked, full audit trail shown.
- **Weeks 4–8:** Superteam Malaysia grant application with repo + demo; 2–3 Superteam Earn bounties in parallel; publish toward x402 Foundation ecosystem lists.
- **Sept 28 – Nov 2:** Colosseum hackathon, agentic-finance track — target the $250K accelerator. Approval-workflow prototype by then if pace allows.
- **Ongoing:** Dogfood in AgentRail (coursework doubles as test environment and portfolio).

**Success at 6 months:** shipped tool with real external users, a grant landed, Colosseum entry submitted — then decide: company, portfolio piece, or acquisition target.

## Decisions (settled)
1. **Positioning:** lead with control ("one policy, every wallet"), ship analytics/audit as the retention proof. Governance is the pitch; the unified log is why they stay.
2. **Chain framing:** Solana-first — maximizes Superteam/Colosseum fit; Base and Cloudflare Wallets adapters after the Solana MVP proves out. Multi-rail is the thesis, sequenced pragmatically.
3. **Team:** solo for now, moving fast; keep the co-founder option open (APUBCC/Superteam circles) and revisit before the Colosseum entry.
# Cite — decision log

Settled-vs-open state for the Cite spec (`SPEC.md`). Future sessions: read this before re-litigating anything.

## 2026-08-12 — spec v1 settled

Full spec settled with David Henzel (source of record: DH Engine note `cite-spec-v1`). Product: agent-native marketplace for earned link placements on Shortlist's publisher inventory. Intent-based (`create_campaign` + allocator), MCP-first, free read tier, human outreach fulfilment, T+30 live-and-indexed guarantee, prepaid Stripe credits, Cite Score instead of raw vendor metrics.

## 2026-08-13 — feasibility talk-through (decisions settled)

| # | Question (spec §) | Decision |
|---|---|---|
| 1 | Link policy — dofollow vs. `rel=sponsored` (§12b, was §13.2) | **Dofollow, risk accepted.** `link_attributes_offered` stays explicit per site; buyer ToS must disclose that Google penalty risk sits with the customer; keep `rel=sponsored` inventory available per-site so compliance-minded agents can still buy. |
| 2 | Concealment model (§12a, §14) | **Confirmed comfortable.** Concealed earned outreach stands as the supply model (explicitly chosen over CrowdReply-style opted-in sellers). Separate brand, quiet Shortlist ownership confirmed (was §13.6). |
| 3 | Outreach inbox staffing (§8, was §13.4) | **Existing Shortlist team** at launch. |
| 4 | Core interface (§1) | **Intent-first confirmed** — `create_campaign` + allocator is the product; catalog/cart explicitly rejected as the primary interface. |
| 5 | v1 sequencing (§15) | **Front-load the demand test:** ship inventory import + read-only MCP search + directory listings first with per-key query instrumentation; build the money path only on real query signal. |

### Demand evidence (honest state)

None direct — "nobody is asking." The bet is that agents (Claude etc.) start using it. CrowdReply's existence is partial category validation but also removes first-mover.

### Competitive finding: CrowdReply (crowdreply.io)

- 40k+ **opted-in** publisher marketplace (DR ≥ 20, ≥ 2k traffic, spam screening), cart ordering, AI-filled briefs, money-back guarantee.
- **Already ships an MCP server (18+ tools)** for Claude/Cursor — so §12c's "MCP wrapper is a weekend away" has already happened.
- Their writes are gated behind **human confirmation steps** → the open gap is autonomous end-to-end purchase: intent interface, allocator, idempotency, webhooks, machine-actionable errors, funds-held-until-verified. That is Cite's ground; recorded in spec §12c.

### Feasibility verdict (from the session)

Technically and operationally feasible — v1 is a bounded build (data model, MCP+REST, Stripe, cold-start allocator, verification crawler, Gmail drafts); the two underestimated corners are the `page_indexed` check (no legitimate API; SERP scraping or paid SERP API) and `LiftObservation` across ChatGPT/Perplexity/AIO (a product category of its own — log from day one, don't assume it's a cron job). The 30–60 orders/day operator ceiling is not binding near-term; **demand is the constraint**, hence the re-sequenced v1.

### Inventory source — audited 2026-08-13

Google Sheet `docs.google.com/spreadsheets/d/1_u6N3o1iYTmpGgXxfmpWPpwP6yoXPA_SQV3zF6yxcPE` (shared, readable). Findings:

- **Master tab: 84 unique publisher sites**, well-maintained: full DR/DA/TrustFlow/CitationFlow/traffic on every row (refreshed 2025-04, now 16 months stale), 66 priced (median $100, $25–$16k), 77 with publisher email, 73 with internal point of contact. DR median 65; organic traffic median ~936/mo (only 33 sites ≥ 2k/mo).
- **Gaps:** `link_attributes_offered` unknown for essentially all sites (§12b makes this mandatory per site), no turnaround SLA data, 18 sites unpriced.
- **~780 additional prospect domains** across other tabs (outreach and DA-scored lists) — unvetted expansion pipeline.
- **Capacity implication (recorded in spec §8):** 84 sites × 4 placements/quarter throttle ≈ 336 placements/quarter (~3.7/day). **Inventory, not operator throughput, is the binding constraint at launch** — inventory growth is the real growth work, and "the inventory list is the moat" (§11) should be read accordingly: the moat is currently thin.
- Full column→`Site` mapping recorded in spec §15 step 1.

## Still open

1. **Domain + trademark check for "Cite"** (§13.1) — cheap, blocks all public naming; do now.
2. **Masked vs. open domains on the free tier** (§13.3).
3. **Finished posts vs. pitches** (§13.5) — currently finished posts, flagged revisitable.
4. **Ahrefs / Moz / Majestic API access** — verify what Shortlist's licences actually include (API vs. UI-only).
5. **Build team** — who drives the v1 build (agent-driven by David, Shortlist devs, or a hire).
6. **Shortlist's own repositioning** — independent open question; not resolved by shipping Cite.

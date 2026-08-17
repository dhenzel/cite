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

### Inventory source — audited 2026-08-13, **corrected 2026-08-15**

Google Sheet `docs.google.com/spreadsheets/d/1_u6N3o1iYTmpGgXxfmpWPpwP6yoXPA_SQV3zF6yxcPE` ("Copy of ShortList.io - Client CRM Marketer Version").

> ⚠️ The 2026-08-13 audit reported **84 sites** and concluded inventory was the binding constraint. That figure was an artifact of a silently truncated Drive markdown export. The full CSV export (2026-08-15) shows the real database below; the capacity conclusion is reversed accordingly.

- **9,463 rows / 9,453 unique publisher domains.** 8,108 priced (median $90, mean $128, range $3–$16k), 9,163 with publisher email. DR median 47 (4,296 sites ≥ 50); DA median 43; organic traffic median ~940/mo (3,579 sites ≥ 2k/mo); ~7,600 rows metric-refreshed in 2025.
- **Niches:** Multiple 2,452 · Business 2,330 · Lifestyle 1,815 · Tech 995 · Health & Wellness 432 · Home Improvement 394 · Finance 161 · EDU/Career 148 · Auto 144 · Crypto 143 · Pets 105 · Sport 101.
- **Gaps:** `link_attributes_offered` unknown at 9.5k-row scale (a real backfill project — §12b makes it mandatory per site), no turnaround SLA data, ~1,350 rows unpriced, metrics ~16 months stale.
- **Capacity (spec §8):** 9,453 sites × 4/quarter throttle ≈ 37,800 placements/quarter (~420/day) — **operator throughput (30–60 orders/day/operator) is the binding constraint, as the spec originally stated.**
- Full column→`Site` mapping recorded in spec §15 step 1.

## 2026-08-15 — blind placements (settles §13.3)

**Buyers never see the site's domain until the link is delivered — at any tier, on any endpoint.** Pre-delivery, sites are anonymized handles: `site_id`, Cite Score, topic tags, traffic band, price, link attribute, turnaround. The domain first appears as `published_url` on delivery. Consequences recorded in spec §11/§6/§3: the scraping surface mostly dissolves (no domain list to steal), watermarking becomes second-line, and the T+30 refund guarantee is the trust mechanism that makes blind buying rational for an agent.

## 2026-08-15 — v0 prototype built (`cite-mcp/`)

Working MCP server over the full 9,453-site inventory: `search_sites` / `get_site` / `estimate` / `inventory_stats`, blind placements enforced in code (field whitelist + leak assertion + brand-scrubbed content summaries), Cite Score v0 computed at import, listed prices derived (margin internal). Content enrichment added to the data model (`site_content`: summary, writes_about, recent titles — anonymized) so an agent can tell what kind of post a site would take. Publisher data (CSV/DB) stays gitignored — code only in the repo. Demo transcript verified end to end in-session.

**Asks for the Shortlist team** (fields the sheet doesn't carry):
- per-site link attribute (dofollow / sponsored) — mandatory before launch
- max links per post, turnaround SLA
- order history → `placements` table (what's already placed where)

## 2026-08-15 — operator console + per-site markup (spec §16)

David: "we need a backend where we can administrate the pages we offer… and I want to add the price that we pay and the markup we have per site." Added to the spec as §16 (operator console) and to the `Site` model as a private `markup` field (default ×1.6, per-site editable; `listed_price = ceil(seller_price × markup / 5) × 5`). Built in v0: `cite-worker` gains `/admin` (single-page UI) + `/admin/api/*` behind an `ADMIN_TOKEN` bearer secret; inventory moves from the frozen bundled JSON into the `cite-v0` D1 database, which both the admin surface (full private rows) and the public MCP tools (whitelisted fields) read — price edits are live immediately. Worker must be deployed in the same Cloudflare account as `cite-v0` (David's main account).

## Still open

1. **Domain + trademark check for "Cite"** (§13.1) — cheap, blocks all public naming; do now.
2. **Finished posts vs. pitches** (§13.5) — currently finished posts, flagged revisitable.
3. **Ahrefs / Moz / Majestic API access** — verify what Shortlist's licences actually include (API vs. UI-only).
4. **Link-attribute backfill** — dofollow/sponsored unknown across 9,453 sites; mandatory field before launch (§12b).
5. **Build team** — who drives the v1 build (agent-driven by David, Shortlist devs, or a hire).
6. **Shortlist's own repositioning** — independent open question; not resolved by shipping Cite.

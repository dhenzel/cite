# placement.sh — agent-native link placement marketplace (spec v1)

**Public brand:** placement.sh. Buyer-facing APIs say **publisher** / **Placement Score**, never Cite / site.
**Status:** build-ready spec, v1. Settled with David Henzel on 2026-08-12; decisions updated 2026-08-13 (see `DECISIONS.md`).
**Owner:** shortlist.io. Human website names Shortlist in the footer (trust). Agent MCP copy stays quiet. Historical sections below still say “Cite”; that was the working name.
**Purpose of this document:** open it in Claude Code and start building with no other context.

D1 tables stay `sites` so live inventory does not migrate. Cloudflare Worker script name stays `cite-mcp`. Neither name is shown to buyers or in Connect URLs.

---

## 1. Product definition

Cite is an agent-native marketplace for earned link placements. A coding agent or marketing agent states an *intent* — "get `example.com/pricing` cited on fintech sites, $4,000, over 8 weeks, conservative risk" — and Cite constructs and executes the portfolio: which publisher sites, in what order, at what cadence, with what anchor-text distribution. It runs on shortlist.io's existing publisher inventory, prices each placement, takes the money, guarantees the link is live and indexed at T+30 or refunds, and reports state back over MCP and webhooks. It is sold as infrastructure, not as an agency.

**Who it is for:** AI agents acting for SEO/growth teams (the primary buyer — an agent with a budget and a target URL), agencies and in-house SEO teams who want an API instead of a spreadsheet and a Slack thread, and developers wiring link acquisition into an existing growth stack. The human buyer never has to see the site list to get a result.

**Why now:** buyers increasingly need to be *cited* by AI answer engines — ChatGPT, Perplexity, Google AI Overviews — as well as ranked by Google. "Citations" is the growing category; "backlinks" is the shrinking one with the bad smell. The name is one word, one spelling, no hyphen, and unambiguous when a model types `claude mcp add cite`. Runners-up: Byline, Vouch, Anchor. **Domain and trademark availability are NOT yet checked — see §13.**

### The positioning that makes this not-a-catalog

**Selection is the wrong interface.** A directory an agent browses is a commodity — any incumbent can ship one in a weekend. The primary verb is intent:

```
create_campaign(target_url, topics[], budget, timeframe, risk_tolerance)
```

An allocator does the portfolio construction. `search_sites` and `get_site` still exist for inspection and for trust-building, but they are **not the workflow**. The allocator and the lift data behind it are the product; the API is just how you reach them.

> **Confirmed 2026-08-13:** intent-first stands as the core interface. See §12c — CrowdReply already occupies "catalog + MCP", which makes a catalog-first Cite a me-too and the intent interface the differentiator.
>
> **Reinforced 2026-08-15 by blind placements (§11):** there is literally no catalog to browse — pre-delivery, buyers see anonymized handles (score, topic, band, price), never domains. The buyer purchases an outcome, and the T+30 guarantee is what makes buying blind rational.

---

## 2. Why MCP-first

Be the thing Claude Code reaches for the way it reaches for Vercel. **MCP server first, REST underneath** — the MCP server is the primary interface and the REST API is its implementation, not the other way round. A **free read tier with no card**, generous enough that agents query inventory exploratorily: the inventory search *is* the marketing, because every exploratory query teaches an agent that Cite is where link supply lives. Get listed everywhere agents discover servers: **mcp.so, Smithery, Glama, PulseMCP, awesome-mcp-servers**.

---

## 3. Data model

Owner contact information is held on `Site` and is **never exposed through any API surface, at any tier, ever**. It is the asset. As of the blind-placements decision (§11, 2026-08-15), **`domain` carries the same pre-delivery privacy**: it is never serialized in any API response until the order's link is delivered, when it surfaces as `published_url`.

### `Site`
| field | type | notes |
|---|---|---|
| `id` | uuid | |
| `domain` | string | unique |
| `owner_contact` | object | name, email, preferred channel — **private, never serialized to any API response** |
| `current_metric_snapshot_id` | uuid | ref to latest `MetricSnapshot` |
| `cite_score` | int 0–100 | derived composite, see §5 |
| `topic_taxonomy` | string[] + vector | tags plus an embedding for relevance scoring |
| `price_tiers` | object[] | `{link_type, word_count_band, seller_price, listed_price}` — `seller_price` never published |
| `markup` | real | per-site multiplier (default 1.6, operator-editable in §16). `listed_price = ceil(seller_price × markup / 5) × 5`, recomputed whenever either input changes. **Private** — same class as `owner_contact`; never serialized to any buyer-facing surface |
| `turnaround_sla_days` | int | typical publish time from acceptance |
| `link_attributes_offered` | enum[] | `dofollow` \| `sponsored` \| `ugc` \| `nofollow` — **must be explicit per site**, see §12b |
| `max_links_per_post` | int | typically 1–3 |
| `accept_history` | counter | accepted orders |
| `reject_history` | counter + reasons[] | |
| `avg_response_latency_hours` | float | feeds outreach timing |
| `accepted_floor_price` | money | lowest price this publisher has actually accepted — internal |
| `acquisition_mode` | enum | `paid_placement` \| `self_serve` \| `apply_editorial` \| `link_exchange` \| `unavailable` — how a placement is actually obtained (§17) |
| `cost_type` | enum | `paid` \| `free` |
| `requires_reciprocal_link` | bool | link-exchange deals cost a link from the buyer's own site; hidden from buyer MCP |
| `agent_instructions` | string | operator-only leftover from free self-serve; never serialized on the public MCP |
| `status` | enum | `active` \| `paused` \| `burned` |
| `throttle_counters` | object | `{placements_this_quarter, last_placement_at, quarter_key}` |

### `MetricSnapshot` — append-only, immutable
One row per site per refresh. **Never updated in place.** Immutability matters because price disputes are settled by pointing at the snapshot that priced the order.

`site_id`, `ahrefs_dr`, `ahrefs_organic_traffic`, `moz_da`, `moz_pa`, `majestic_tf`, `majestic_cf`, `indexed_pages`, `outbound_link_count`, `spam_signals` (object), `fetched_at`, `source` (enum: `ahrefs` \| `moz` \| `majestic` \| `composite`).

### `Campaign` — the new top-level object
`id`, `buyer_id`, `target_url`, `topics[]`, `budget` (money), `timeframe` (start, end), `risk_tolerance` (enum `conservative` \| `balanced` \| `aggressive`), `state` (`draft` \| `allocated` \| `approved` \| `executing` \| `complete` \| `cancelled`), `allocation_plan` (ordered array of `{site_id, planned_price, planned_send_date, anchor_text_slot, rationale_code}`), `created_at`.

### `Order`
`id`, `campaign_id`, `site_id`, `content` (see content contract §6), `target_url`, `anchor_text`, `price_locked_at_creation` (money — the listed price at the moment of creation, immune to later refresh), `metric_snapshot_id` (what it was priced against), `state` (§7), `idempotency_key` (unique per buyer — a retrying agent must never double-buy), `created_at`, `published_url`, `refund_reason`.

### `OutreachThread`
`id`, `order_id`, `draft_body`, `sender_identity` (the named human), `channel`, `sent_at`, `replies[]` (`{direction, body, received_at}`), `state`, `edited_by_human` (bool — audit that a person actually touched it).

### `Verification`
`id`, `order_id`, `checked_at`, `checkpoint` (enum `T+7` \| `T+30` \| `T+90`), `link_present` (bool), `link_attribute` (as found in HTML), `http_status`, `page_indexed` (bool), `raw_evidence_ref`.

### `LiftObservation` — **internal only, never exposed to a customer**
`id`, `campaign_id`, `target_url`, `observed_at`, `keyword`, `google_rank`, `ai_citation_present` (bool per engine), `ai_citation_position`, `engine` (enum `chatgpt` \| `perplexity` \| `google_aio`), `source`.

---

## 4. The allocator (the heart of the system)

Given a `Campaign`, produce an ordered `allocation_plan`. This is where the margin and the defensibility live.

### Inputs
- Budget, timeframe, topics, risk tolerance.
- The buyer's **existing link profile** (fetched from the vendor APIs for the target domain) — so the allocator does not buy what they already have and can see anchor-text saturation already present.
- Site pool filtered to `status = active`.
- `LiftObservation` history across all campaigns (internal).

### Hard constraints — enforced in code, not policy
1. **Per-site throttle: max N placements per site per quarter.** Default N = 4; per-site override. This is the single most important constraint in the system: an autonomous engine will hammer the best publishers first and burn them in weeks. Enforced at allocation time *and* re-checked at order creation.
2. **Anchor-text distribution limits.** Cap exact-match anchors as a share of the campaign and of the target URL's total known profile (default: exact-match ≤ 20% of campaign links, more conservative under `risk_tolerance = conservative`). Prevents over-optimisation penalties.
3. **Topical relevance floor.** Cosine similarity between campaign topic vector and site topic vector ≥ threshold (default 0.6; raised under `conservative`).
4. **Price ceiling.** No single placement above X% of campaign budget (default 25%), so one expensive site can't eat a small campaign.
5. **Cadence spread.** Placements distributed across the timeframe — never all in week one. A link velocity spike is itself a risk signal.

### Objective function
Maximise **observed lift per dollar** once there is enough `LiftObservation` data for a site/topic pair. Formally, rank candidate sites by `E[lift | site, topic, buyer_profile] / listed_price`, subject to the constraints above, and fill the budget greedily with a diversity penalty (declining marginal value for repeat placements on the same site or same topical cluster).

### Cold start (no lift data yet — this is v1's real state)
Fall back to **composite score per dollar**: `cite_score` adjusted by topical relevance, publisher reliability (accept rate × inverse response latency), and freshness of the metric snapshot, divided by listed price. Deliberately over-explore in the first N campaigns — allocate a fixed slice (~15%) of each budget to sites with thin data, so the lift dataset actually gets built. Log the `rationale_code` per allocation so cold-start decisions are auditable later.

---

## 5. Vendor-metric licensing constraint (the LinkYard problem) and its fix

**The constraint:** Ahrefs, Moz and Majestic all prohibit redistributing their metrics through a third-party API. Shortlist licenses all three, and that licence covers internal use — it does not cover re-serving DR or DA over Cite's public endpoints. Building the obvious thing (expose DR next to every site) is a licence violation and a takedown risk.

**The fix:** Cite publishes a derived composite — the **Cite Score (0–100)** — plus freely-derivable facts:
- traffic **band** (e.g. `10k–50k/mo`), not the vendor's number
- indexed page count (Cite's own crawl)
- topical vector / topic tags (Cite's own classification)
- outbound-link hygiene (Cite's own crawl)
- publisher reliability signals (Cite's own order history)

**Raw vendor numbers are never present in a public API response.** They live in `MetricSnapshot`, internal-only, and feed the score.

**Side benefit, and it is not small:** this makes Cite the *source of truth* rather than a reseller. An agent that learns to trust Cite Score is an agent that has to come back to Cite — not to Ahrefs — for the number that matters.

---

## 6. API surface

MCP tool names are the canonical names; REST paths mirror them 1:1.

### Free tier — no card
| tool | does |
|---|---|
| `search_sites(topics[], min_score, max_price, link_attribute, limit)` | returns **anonymized site handles** — `site_id`, Cite Score + derived facts, **never the domain** (§11 blind placements); hard-capped result sets |
| `get_site(site_id)` | one site, same field policy — no domain pre-delivery |
| `estimate(target_url, topics[], budget, timeframe)` | what a budget would plausibly buy — shape of the plan, no commitment, no reserved inventory |

### Funded — requires credit balance
`create_campaign(target_url, topics[], budget, timeframe, risk_tolerance)` · `get_campaign(campaign_id)` · `approve_allocation(campaign_id)` · `create_order(campaign_id, site_id, content, target_url, anchor_text, idempotency_key)` · `get_order(order_id)` · `list_orders(campaign_id?, state?)` · `cancel_order(order_id)` — **pre-outreach only**, rejected once `outreach_sent` · `register_webhook(url, events[])`

### Content contract
The agent submits a **finished post**, not a topic pitch (flagged revisitable, §13):
- `body`: markdown, min word count per site (`WORD_COUNT_LOW` if under)
- `title`: string
- `links`: **1–3 maximum**, at most one to `target_url`
- `author_bio`: optional string
- no images required in v1

### Structured rejection errors
Machine-actionable so an agent can fix and resubmit without a human round trip:
`TOPIC_MISMATCH` (+ the site's accepted topics) · `WORD_COUNT_LOW` (+ required minimum) · `ANCHOR_OVER_OPTIMIZED` (+ current distribution and the cap) · `DUPLICATE_CONTENT` (+ where it collided) · `SITE_THROTTLED` (+ next eligible date) · `INSUFFICIENT_CREDIT`.

### Webhooks
`order.state_changed`, `order.published`, `order.verified`, `order.refunded`, `campaign.allocation_ready`, `campaign.complete`. **Webhooks matter because agents are async and polling is a tax** — an agent that has to poll for 30 days is an agent that stops using you.

---

## 7. Order lifecycle state machine

```
submitted
  → auto_screen
  → human_review
  → outreach_drafted
  → outreach_sent
  → site_accepted | site_rejected
  → published
  → verified
  → complete
```

- `site_rejected` → `refund_issued`
- `link_lost_at_verification` (link absent or attribute changed at T+30) → `refund_issued`
- `cancel_order` is legal only up to and including `outreach_drafted`.

**Funds are held at order creation and released to Cite on `verified`.** Never before — the guarantee is only credible if the money is actually held.

---

## 8. The human fulfilment loop, and the capacity ceiling

Every order produces a **Gmail draft in the team's inbox**, written in the voice of a named human, which a person edits and sends. **This is permanent, not scaffolding.** The reason is §12a: publishers will not be told the buying is programmatic, and a human in the loop is what keeps that true.

Agent-assisted negotiation **on the buy side is in** — drafts informed by Cite's own order history: each publisher's real accepted floor, rejection threshold, response latency, best day of week to send. That is **margin, not customer-facing differentiation**; it is never marketed and never exposed. Agent-to-publisher negotiation is **out**: an agent haggling is the tell that breaks concealment.

**The ceiling, stated plainly:** throughput is roughly **30–60 orders/day per operator**. That — not demand, not inventory — is the revenue constraint on this business. Every growth plan has to be read against operator headcount, and the model should be built assuming it.

> **Settled 2026-08-13:** the outreach inbox is staffed by the **existing Shortlist team** at launch (§13.4).
>
> **Capacity check (corrected 2026-08-15):** with the full 9,453-site database and the §4 throttle of 4 placements/site/quarter, inventory-side capacity is ~37,800 placements/quarter (~420/day) — an order of magnitude above one operator's 30–60/day. **The original claim stands: operator throughput, not inventory or demand-side supply, is the revenue ceiling.** (A 2026-08-13 note briefly claimed the reverse, based on a truncated 84-row export of the database; disregard it.)

---

## 9. Metrics refresh pipeline

- **Nightly, staggered** — never a thundering herd against the vendor APIs.
- Every site refreshed **every 14–30 days**; refresh order prioritised by staleness and by how often the site is being allocated.
- Each refresh writes a **new immutable `MetricSnapshot`**; nothing is mutated.
- **Auto-pause** any site whose Cite Score drops **more than 15 points** between snapshots — pending human review.
- **`burned`** after **two rejections** or **one link removal**.
- **Burned inventory never returns to search results.** Not filtered at the edge — excluded at the query layer.

---

## 10. Money

- **Prepaid credits via Stripe**, debited at order creation.
- **Margin sits between `seller_price` and `listed_price`. The seller cut is never published**, in any API response, at any tier.
- **Refunds default to credit balance**; cash refund on request.
- **The guarantee: link live and indexed at T+30, or full refund.** Fully within Cite's control, which is exactly why it is the thing being guaranteed.
- Link lost between **T+30 and T+90** → **prorated credit**.

### The three things that must never be conflated

1. **GUARANTEE** — link live and indexed at T+30 or refund. Contractual. Within Cite's control.
2. **MEASUREMENT** — rank and AI-citation movement on the buyer's target URL at T+0 / T+30 / T+90. Runs on every campaign, **with no promise attached**.
3. **ALLOCATION** — uses (2) to pick sites. Invisible to the customer and absent from the contract.

**Lift is measured but never guaranteed.** Outcome pricing was considered and **rejected as too risky** — correctly. **Lift data stays INTERNAL in v1. No per-customer lift dashboard.** A number you show a customer becomes a promise you made, and SEO confounders — core updates, their own site changes, seasonality — make that an unwinnable attribution argument. Aggregate, explicitly observational benchmarks are acceptable marketing; a per-customer scoreboard is not.

---

## 11. Trust and abuse

The inventory list is the moat — and the protection model is **blind placements** (settled 2026-08-15, §13.3):

- **Domains are hidden until the link is delivered — every tier, every endpoint.** Pre-delivery, a site is an anonymized handle: `site_id` + Cite Score + topic tags + traffic band + price + link attribute + turnaround. The `domain` field is never serialized in any pre-delivery API response, exactly like `owner_contact`. The buyer first sees the actual site as `published_url` when the order reaches `published`.
- This **dissolves most of the scraping surface**: there is no domain list to steal, so free exploratory querying can stay generous. The known cost — an agent that can't see what it's buying buys less — is absorbed by the T+30 guarantee: if the delivered placement isn't live and indexed, the money comes back.
- **Hard rate limits on the free tier** stay — per key, per hour, per day (now protecting pricing/score data rather than domains).
- **Per-key watermarking of result sets** becomes second-line: deterministic perturbation of ordering/subsetting per key, so systematic reconstruction attempts still trace back to a key.
- **Never more than ~50 results per query** without a funded account, and no deep pagination on the free tier.

---

## 12. Risks — stated bluntly

### (a) Concealment is the biggest operational risk in the design
Publishers are not told the buying is programmatic. At agent volume, **a publisher will eventually notice the pattern** — same cadence, same content shape, same three senders — and the inventory list is the asset that burns. Mitigations, all of which cost real money:
- per-site rate limiting (§4, constraint 1)
- varied sender identity and varied send timing
- human editors who **genuinely rewrite** rather than rubber-stamp — this is real editing time and **must be budgeted**, not assumed away

This risk is structural, not a bug to be fixed. Build the model around it.

> **Settled 2026-08-13:** David confirmed he is comfortable operating the concealment model as designed, and confirmed concealed earned outreach (not opted-in sellers) as the supply model.

### (b) Link policy — SETTLED 2026-08-13: dofollow, risk accepted
Undisclosed paid dofollow links are a **Google link-spam violation, and the penalty lands on the customer's site**, not on Cite. David's decision: sell dofollow and accept that risk, with these requirements carried into the build:

1. **`link_attributes_offered` stays explicit per site in every API response** so an agent can filter and a buyer makes an informed choice. Never ship this ambiguous.
2. **Buyer-facing ToS must state plainly that Google penalty risk sits with the customer.** The guarantee covers link liveness, never safety from algorithmic or manual action.
3. **Channel caveat:** the distribution thesis is safety-trained agents (Claude, etc.), and those agents may resist recommending undisclosed paid dofollow placements to their users. Carrying honest per-site attributes — and `rel=sponsored` inventory where sites offer it — keeps the compliant path open for buyers whose agents insist on it.

### (c) The API is not the moat — and CrowdReply proves it
**Collaborator, Adsy, WhitePress, PRposting, LinkHouse** and similar already have order-placement APIs. **An MCP wrapper is a weekend of their engineering time.**

**Closest competitor (added 2026-08-13): CrowdReply (crowdreply.io).** Positioned as an "AI search visibility" tool; a marketplace of 40,000+ *opted-in* publishers (DR ≥ 20, ≥ 2k organic traffic, spam screening), cart-based ordering with AI-filled briefs, money-back guarantee — and **an already-shipped MCP server (18+ tools) for Claude and Cursor**. The predicted weekend MCP wrapper has already happened.

The gap that remains — and that Cite must own: CrowdReply's writes sit **behind human confirmation steps**; it is a human-supervised assistant product. Cite's differentiation is that an **autonomous agent completes the purchase end-to-end**: intent interface (`create_campaign`), allocator, idempotency keys, webhooks instead of polling, machine-actionable rejection errors, funds held until verification. A catalog+MCP me-too is dead on arrival; the allocator and the accumulated lift data have to be the defensible part. Every roadmap decision should be tested against: *does this widen the allocator's data advantage, or is it a feature they can copy in a week?*

---

## 13. Open decisions — for David

1. **Domain and trademark for "Cite" — unchecked.** Blocks any public naming. *(Still open — do this now, it is cheap.)*
2. ~~Dofollow vs. `rel=sponsored`~~ — **SETTLED 2026-08-13: dofollow, risk accepted** (§12b).
3. ~~Masked vs. open domains on the free tier~~ — **SETTLED 2026-08-15: blind placements — domains hidden at every tier until the link is delivered** (§11).
4. ~~Who staffs the outreach inbox~~ — **SETTLED 2026-08-13: existing Shortlist team** (§8).
5. **Finished posts vs. pitches** — currently finished posts; David flagged this as revisitable. *(Still open.)*
6. ~~Branding — separate brand vs. Shortlist sub-product~~ — **SETTLED 2026-08-13: separate brand.** Human site + buyer MCP name Shortlist for trust (2026-08-19, §14).

---

## 14. Branding: separate product, named operator on the human site

**Launch as placement.sh, not as a Shortlist sub-brand.** *(Confirmed 2026-08-13.)* Agent-facing infrastructure and a human agency stay different motions.

**Human website and buyer MCP name the operator.** *(2026-08-18, expanded 2026-08-19.)* People pay real money. A domain with no company reads as a fly-by-night. placement.sh HTML explains that Shortlist has bought publisher placements since 2018, with links to [shortlist.io](https://shortlist.io/) and [the team](https://shortlist.io/about-us/). Claude/MCP `help` and the payment `next_step` tell the agent to show those same links before the human pays.

**Publisher-facing copy stays quiet about the product.** Outreach is still Shortlist humans, never From placement.sh (§8). Inventory stays blind until delivery (§11). Do not market “programmatic placements at scale” at publishers.

**Buyer mail From `placement@shortlist.io`.** Do not send buyer transactional mail from `hello@placement.sh`. The Worker sends the signup note on `register_account`.

The 2026-08-13 “do NOT put Shortlist in the footer” line is superseded. Concealment of *inventory* is unchanged. The paying human is told who operates placement.sh.

Note (2026-08-13): placement.sh is **not** Shortlist's repositioning — it is a separate project that feeds demand into Shortlist's publisher inventory. Shortlist's own positioning remains an open, independent question.

---

## 15. v1 scope cut — one order, end to end

Build the shortest path that takes real money and delivers one real link.

> **Sequencing note (2026-08-13):** demand is the only unproven part of the model — nobody is asking for this yet; the bet is that agents start using it. Therefore **ship steps 1–2 first, alone, as the demand test**: inventory + read-only MCP search, listed on the MCP directories, with query volume instrumented per key. Build the money path (steps 3–7) only once exploratory query volume shows real agent traffic. `LiftObservation` (step 8) still starts on day one.

1. **Import inventory** from the Shortlist team's existing site list; refresh ranking factors from Ahrefs/Moz/Majestic. Ship `Site` + `MetricSnapshot` and the Cite Score computation.
   - **Inventory source (audited 2026-08-13; corrected 2026-08-15):** the Google Sheet at `docs.google.com/spreadsheets/d/1_u6N3o1iYTmpGgXxfmpWPpwP6yoXPA_SQV3zF6yxcPE` ("Copy of ShortList.io - Client CRM Marketer Version"). Full CSV export: **9,463 rows, 9,453 unique publisher domains** — 8,108 priced (median $90, mean $128, range $3–$16,000), 9,163 with publisher email, DR median 47 (4,296 sites ≥ 50), organic traffic median ~940/mo (3,579 sites ≥ 2k/mo), ~7,600 rows metric-refreshed in 2025. Niches: Multiple 2,452 · Business 2,330 · Lifestyle 1,815 · Tech 995 · Health & Wellness 432 · Home Improvement 394 · Finance 161 · long tail (EDU/Career, Auto, Crypto, Pets, Sport). *(An earlier audit reported 84 sites — that was a truncated Drive markdown export, not the database.)*
   - **Column mapping:** `Website`→`domain`; `Name`+`Email To`→`owner_contact`; `Rate`/`In-post Rate`→`price_tiers.seller_price` basis (listed_price = seller_price × margin rule, TBD); `Standard/Premium/Platinum`→tier flags; `Niche`/`Subniche`→`topic_taxonomy` seed; `DR/DA/TrustFlow/CitationFlow/Traffic/Spam Score`→first `MetricSnapshot` (marked stale — re-fetch at import); `Note`→parse for `max_links_per_post`, forbidden-niche surcharges, language, link attributes; `Added`/`Updated`→timestamps.
   - **Gaps to backfill at import:** `link_attributes_offered` unknown for essentially all 9,453 sites (§12b requires this explicit per site — at this scale the backfill is a real project, not a cleanup pass), `turnaround_sla_days` absent, ~1,350 rows unpriced, metrics ~16 months stale.
2. **MCP server** with `search_sites`, `get_site` on the free tier — read-only, rate-limited, watermarked. This is the marketing; ship it before anything else is buyable.
   - **Prototype exists (2026-08-15):** `cite-mcp/` — stdio MCP server over the full imported inventory (SQLite), with `search_sites`, `get_site`, `estimate` (v0 allocator taste) and `inventory_stats`; blind placements enforced by a field whitelist + runtime leak check; content enrichment pipeline (`src/enrich.ts`) that stores brand-scrubbed summaries of what each site writes about (11 demo sites enriched; full crawl runs outside the sandbox). See `cite-mcp/README.md`.
   - **2026-08-18:** replace bag-of-words enrichment with fetch-then-Grok profiles (`SPEC-PAID-PATH.md` §3). Public `content_summary` stays scrubbed; `get_writing_brief` is what the customer agent writes against.
3. **Stripe prepaid credits** + balance debit at order creation. **→ `SPEC-PAID-PATH.md`:** Checkout link in the agent chat (`add_credits`), wallet with available/held cents, capture only at T+30 verified.
4. **`create_campaign` + a v1 allocator** running pure cold-start composite-score-per-dollar with all five hard constraints enforced in code. No lift model yet. Returns writing-brief refs so the customer agent can draft.
5. **`submit_placement` (was `create_order`)** with idempotency, auto-screen (word count, topic match, anchor check, duplicate check), **finished post from the customer’s agent**, and the **Gmail draft** into the team inbox. See `SPEC-PAID-PATH.md` §4.
6. **Order state machine + webhooks** — enough states to be honest with the agent about where an order actually is.
7. **Verification crawler** at T+7 and T+30, and the **refund path** on `site_rejected` / `link_lost_at_verification`.
8. **`LiftObservation` collection starts on day one, internal only** — even with no model consuming it yet. The dataset is the moat and it only exists if you start writing rows before you need them.

**Explicitly not in v1:** lift-weighted allocation, agent-assisted negotiation drafts, `cancel_order` beyond the trivial case, T+90 verification, any customer-facing lift reporting.

---

## 16. Operator console (admin backend)

*Added 2026-08-15.* An authenticated, operator-only surface for administrating the inventory — never linked from buyer-facing pages, never listed on MCP directories.

**v1 scope:**
- **Inventory CRUD** — add, edit, pause, and burn sites; search and filter across the full private dataset (domain, contacts, notes included).
- **Pricing** — per-site `seller_price` (what the publisher gets) and per-site `markup`; the console shows the computed `listed_price` and margin per site. Margin never appears on any buyer surface; the console is where it lives.
- **Backfill workflows** — the fields the sheet never carried, editable in place: `link_attribute` (dofollow/sponsored — mandatory before public launch, §12b), `max_links_per_post`, `turnaround_sla_days`.
- **Content review** — inspect and correct enrichment output (summaries must stay brand-scrubbed, §11).
- **Import** — (re)load from the Shortlist sheet export.

**Auth:** humans sign in with Shortlist SSO (§18). Agents authenticate to `/admin/mcp` with a **per-person key** (`cka_…`) minted from the console's Connect tab — shown once, masked thereafter, revocable per person, and automatically dead once its owner loses console access on the engine. The shared `ADMIN_TOKEN` still works so nothing breaks mid-migration, but per-person keys are the intended path and let it be retired. Aggregate margin reporting and order/outreach management land with orders (§7).

**Implementation note (v0 prototype):** lives in `cite-worker/` on the same Worker as the public MCP endpoint — `/admin` (UI) + `/admin/api/*` (JSON), bearer-token-guarded, backed by the `cite-v0` D1 database, which is the working store the public tools also read. Editing a price changes what agents see immediately; no redeploys for data.

---

## 17. Buyer inventory is paid-only; access tiers

*Added 2026-08-17. **Superseded 2026-08-18:** free listings are no longer sold or claimed on the public MCP.*

### Paid inventory (buyer MCP)

The public tools (`estimate`, `search_publishers`, `get_publisher`, `inventory_stats`) return **paid placements only**: `cost_type=paid`, `listed_price > 0`, `acquisition_mode=paid_placement`. `$0` / self-serve / editorial-free / link-exchange rows may remain in D1 so operators can still see them in the console; they must not appear to a buyer agent.

`claim_free_placement` is removed. An agent that still calls it gets `TOOL_REMOVED` and a `next_step` pointing at register → credits → `create_campaign`.

**Why:** a $0 newsletter subdomain with a high DR looks like a "huge free citation." Agents then offer it as a consolation prize when Stripe isn't live. That is not the product. The product is bought placements, live and indexed at T+30 or refunded.

`acquisition_mode` remains on the operator model:

| mode | what it means | buyer MCP |
|---|---|---|
| `paid_placement` | Cite pays the publisher | shown |
| `self_serve` | anyone can register and publish — Medium, Substack… | hidden |
| `apply_editorial` | free editorial pitch | hidden |
| `link_exchange` | reciprocal link from the buyer's site | hidden |
| `unavailable` | not accepting placements | hidden |

### Access tiers

Looking is free and **unlimited**. Buying is not. No result cap, no account required to search.

| tier | how you get it | looking | what you can do |
|---|---|---|---|
| anyone | nothing | unlimited (page with `offset`) | search, inspect, estimate — figure out what to write |
| registered | `register_account({email})` — agent asks the human; do not invent an email | unlimited | same, plus a key so we can take payment |
| funded | prepaid Stripe credits | unlimited | + `create_campaign` / submit |

The agent should let the human browse until they know what they want. Email and credits only when they submit. On `INSUFFICIENT_CREDIT`, follow `next_step`. Every call is written to `query_log`.

### Operator MCP

The console (§16) is also exposed as an MCP server at `/admin/mcp`, guarded by the same `ADMIN_TOKEN`, so the team can run the back office from an agent: `admin_search_sites`, `admin_update_site`, `admin_bulk_update` (dry-run by default), `admin_update_metrics` (push a refresh, recompute Cite Score), `admin_add_site`, `admin_analytics`. Never listed on public MCP directories. Operators can still filter `cost_type=free` in the console; buyers cannot.

---

## 18. Operator sign-in: Shortlist Context Engine SSO

*Added 2026-08-17.* The console (§16) authenticates humans against the **Shortlist Context Engine** over OpenID Connect, and reads engine data as that person using the same token.

**One credential, both halves.** The access token from sign-in is the token used against the engine's MCP endpoint. Nothing separate is issued or stored.

**Flow.** Authorization code + PKCE (S256, required by the engine), with `state` and `nonce` sent and verified. Endpoints, signing keys and algorithms come from the discovery document — never hard-coded. The `id_token` is verified for signature (JWKS), `iss` exact-match, `aud` = our client id, `exp`, and `nonce`. Protocol handling is delegated to `oauth4webapi` (WebCrypto, Workers-native).

**Scopes requested:** `openid profile email *:read briefs:assemble` — identity plus engine reads. No `events:emit` / `files:write` / `signals:write` (this app only reads) and no administrative scopes such as `users:manage` or `system:config`.

**Identity.** The local user is keyed on the `sub` claim in its own indexed column — email can change, `sub` cannot. `name` and `email` are created on first sign-in and refreshed on every later one. App sessions run from a signed, HttpOnly cookie; there is no re-authentication per page load.

**Authorization is what the token actually holds, not what we asked for.** After sign-in, `probe-tool` returns the ability list the engine granted this person — an admin and a viewer signing into the same app get different lists. Console access requires the `CITE_ADMIN_ABILITY` (default `*:read`) or an email in `CITE_ADMIN_EMAILS`. Panels resolve their tools from `tools/list` (never hard-coded names) and hide themselves when the tool is absent or unavailable.

**Two failures treated as normal.** A 401 from the engine sends the person back through sign-in rather than showing an empty dashboard. A scope denial degrades that one panel and leaves the rest of the page working.

**Caching.** Engine reads are cached ~60s per person and tool (tool lists ~5 min), so a render is not a burst of live calls in the engine's audit log.

**The shared `ADMIN_TOKEN` no longer opens the web console.** It remains solely for `/admin/mcp`, because an agent cannot complete a browser sign-in.

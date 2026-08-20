# placement.sh — decision log

Settled-vs-open state for the spec (`SPEC.md`). Future sessions: read this before re-litigating anything.

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

## 2026-08-17 — free inventory, metrics disclosure, agent signup, operator MCP

**Free sites (SPEC §17).** 465 sites in the database already cost $0. Classified by `acquisition_mode`: 22 `self_serve` (agent publishes itself — includes a curated set of platforms Shortlist's outreach database never carried: Medium, Hashnode, Substack, Quora, Reddit, LinkedIn…), 378 `apply_editorial`, 80 `link_exchange` (parked per David — tagged, excluded from search), 19 free `unavailable`. David: free placements stay free and are the trial; no service fee.

**Classifier correction:** an early pass hid marketwatch.com (DR 91) because its note reads "not available *from Hazel*" — a contact remark, not a closed site. Regex now distinguishes "not available" from "not available from <person>".

**Metrics disclosure (SPEC §5 rewritten).** David wants real SEO metrics visible in the free tier. Two findings shaped the answer:
1. [Ahrefs API rules](https://ahrefs.com/api/guide) forbid redistribution to non-end-users, white-labeling, renaming metrics and bulk export — but *permit* showing data to the end user with attribution. The original "no vendor metrics anywhere" was stricter than required.
2. Fingerprinting measured on the real catalog (n=9,433): exact DR alone identifies 0.1% of sites, DR+niche 2.9%, DR+DA+niche 53.8%, DR+DA+TF+CF+niche 93.6%, plus exact traffic 100%.

Result: **exact Ahrefs DR** (labeled, attributed, never renamed) + **bands** for DA and TF/CF + traffic band + decomposed score components. Exact DA/TF/CF/traffic stay in the console.

**Superseded 2026-08-19:** buyer surface is Ahrefs-only. Moz DA and Majestic TF/CF are no longer shown to buyers (not even as bands). See the 2026-08-19 Ahrefs-only decision.

**Access tiers (SPEC §17, revised 2026-08-19).** Looking is unlimited with no account. `register_account({email})` is only so we can take payment. Funded via Stripe Checkout on Shortlist’s existing account (wallet + webhook). After pay, `create_campaign` returns `ready_to_write`; the agent writes via `get_writing_brief` and `submit_placement`. Every call logged to `query_log`.

**Operator MCP (SPEC §16).** `/admin/mcp` exposes the back office as tools for the team — bulk updates dry-run by default. Auth via `ADMIN_TOKEN` header or `/admin/mcp/<token>` for clients that cannot send headers.

**Console analytics.** Signups, active agents, query volume by day, top searched topics, unmet demand (zero-result searches), free placements claimed, and inventory readiness (link-attribute gaps, unpriced sites).

## 2026-08-17 — Shortlist Context Engine SSO (spec §18)

Operator console moved from a shared bearer token to **"Sign in with Shortlist"** — OIDC against `shortlist.on-relote.com`, with the same access token used to read engine data over MCP.

- **Admin rule (David's call):** holds the `*:read` ability **or** email in `CITE_ADMIN_EMAILS`. Configurable via `CITE_ADMIN_ABILITY` — worth revisiting once real people sign in and we see what their tokens actually carry (each sign-in records the ability list on the user row).
- **Shared `ADMIN_TOKEN` (David's call):** retained for `/admin/mcp` only, since agents can't do a browser flow. It no longer opens the web console.
- **Panels (David's call):** publisher/company lookup (`search-tool`), recent engine activity (`recent-tool`), open signals (`signals-tool`), plus an always-on identity strip from `probe-tool`.
- Redirect URI to register: `https://cite-mcp.d-henzel.workers.dev/auth/callback`.
- Engine endpoints are unreachable from the build sandbox, so the flow is verified against a stubbed issuer + stubbed engine (real PKCE, real JWKS signature validation). First live sign-in is David's.

## 2026-08-17 — break-glass console access (temporary)

Shortlist sign-in currently fails at the token exchange with `invalid_client` ("Client secret missing or invalid"). Diagnosis: the authorization step succeeds, so the client id is right; both `client_secret_post` and `client_secret_basic` are attempted, so transport is not the cause — **the client secret stored in the Worker is wrong**, and the app registration holding the correct one has not been located yet.

Because the SSO change had removed `ADMIN_TOKEN` as a way into `/admin`, that left nobody able to open the console. Added a flagged fallback: `GET /admin?token=<ADMIN_TOKEN>` (or the "Use the operator token instead" disclosure on the sign-in page) mints a session with no engine access token — inventory and pricing work, Shortlist panels say plainly that they need a Shortlist sign-in. Controlled by `ALLOW_TOKEN_CONSOLE`, currently `"true"`.

**Close this once sign-in works:** set `ALLOW_TOKEN_CONSOLE = "false"` and redeploy. Diagnostics live at `/auth/debug` (ADMIN_TOKEN-gated): advertised auth methods, the method chosen, and the stored secret's length / whitespace flag / SHA-256 prefix — no secret is printed.

## 2026-08-17 — per-person admin MCP keys

The admin MCP was gated by the one shared `ADMIN_TOKEN`: no attribution, and revoking it cut off the whole team. The console now has a **Connect** tab where a signed-in person mints their own `cka_…` key, with the `claude mcp add` command pre-filled and a header-free `/admin/mcp/<key>` URL for claude.ai connectors (which cannot send headers). Keys are shown once, listed masked with a last-used timestamp, revocable by the owner, and validated on every call against the owner's current engine abilities — so losing engine access disables the key without anyone remembering to. A break-glass token session cannot mint one (`SSO_REQUIRED`). The shared token still works, so it can be retired on David's schedule rather than in a flag day.

## 2026-08-18 — public brand is placement.sh

Domain bought and on Cloudflare NS (`brynne` / `lakas`). Public product name is **placement.sh**, not Cite (cite.sh is a competing ChatGPT-citation directory). Worker `cite-mcp` keeps its script name and D1 `sites` tables; Custom Domains `placement.sh`, `www.placement.sh`, and `mcp.placement.sh` are declared in `cite-worker/wrangler.toml`. Operator SSO redirect is `https://placement.sh/auth/callback`. Register that URI on the Shortlist IdP. The `cite-mcp.*.workers.dev` hostname must never appear in Connect commands, MCP cards, or minted admin keys.

## 2026-08-18 — Connect URLs are always placement.sh

Opening the operator console on `cite-mcp.*.workers.dev` used `request.origin`, so minted admin MCP keys looked like `https://cite-mcp.d-henzel.workers.dev/admin/mcp/cka_…`. That is the old Worker hostname, not the product.

**Fix:** `productOrigin()` always prints `https://placement.sh` outside localhost/tests. GET/HEAD on `*.workers.dev` 301s to placement.sh. POST `/mcp` and `/admin/mcp` still respond on workers.dev so already-connected agents do not break mid-call. OIDC callback in wrangler.toml is `https://placement.sh/auth/callback` — that URI must be on the Shortlist IdP app.

Revoke any admin key that was copied with a workers.dev URL and mint a new one from https://placement.sh/admin.

## 2026-08-18 — paid path, emails, crawl+Grok profiles, agent-submitted posts

David: make payments work in the Claude/Grok conversation; set up the emails; research every site so the bot gets more than a niche tag; customer agent writes the post and submits it.

Recorded in `SPEC-PAID-PATH.md`. Settled in that session:

| # | Question | Decision |
|---|---|---|
| 1 | How the human pays | Stripe Checkout **link in the chat**. Agent calls `add_credits` → `{checkout_url}`. No card entry in the model, no placement.sh billing dashboard in v1. Landing page after pay is one line: go back and say “paid”. |
| 2 | Wallet vs per-order Stripe capture | **Prepaid credits + internal hold.** Available/held cents on `accounts`. Capture to us only at T+30 verified. `INSUFFICIENT_CREDIT` always includes a fresh Checkout payload for the shortfall. |
| 2b | Which Stripe account | **Shortlist’s existing Stripe for v1.** Metadata `product=placement.sh` on every session so we don’t mix with other Shortlist charges. Checkout branded placement.sh. Dedicated account later if needed. |
| 3 | Who writes the post | **The customer’s agent.** `get_writing_brief` + `submit_placement` with finished markdown. Auto-screen returns one machine-actionable error; agent rewrites in-thread. Pitches without a body are `CONTENT_REQUIRED`. |
| 4 | Site research / Grok crawl | **We fetch, Grok API writes the profile, D1 stores it.** Do not crawl 9k URLs inside a Grok chat. Public summary is brand-scrubbed; private summary is operator-only. Highest score first. |
| 5 | Emails | Two pipes: buyer mail **From `@shortlist.io`** (account, credits, order, published, refund). Gmail **drafts** in the Shortlist mailbox for publisher outreach — never From: placement.sh. *(From-address updated 2026-08-18: not hello@placement.sh.)* |

`create_campaign` remaining a stub is now an explicit gap this spec closes (build order in SPEC-PAID-PATH §5).

## 2026-08-18 — paid inventory only (no free listings)

David, after a Grok session on upcoach.com: a score-87 / DR-92 **$0 newsletter subdomain** showed up as a "huge free slot," and after signup the agent offered to **claim a free Business listing** instead of waiting for Stripe. That is the wrong product.

**Decision:** buyer MCP is paid placements only. Hide `cost_type=free`, `listed_price=0`, and non-`paid_placement` modes from `estimate` / `search_publishers` / `get_publisher` / `inventory_stats`. Remove `claim_free_placement` (`TOOL_REMOVED` if an old client still calls it). `help`, `register_account`, `account_status`, and `create_campaign` must tell the agent: looking is free → ask the human for an email → register → prepaid credits. Never offer Medium / Substack / self-serve as a consolation prize.

Rows stay in D1 for the operator console. This supersedes the 2026-08-17 "free placements stay free and are the trial" call.

## 2026-08-18 — buyer website names Shortlist (trust, not quiet)

Paying humans land on a site with no company, no people, no aged domain. That reads like a scam when a Stripe Checkout is next. David: put Shortlist on the site, subtly; link the company and the team page so a buyer can see real people. (“shoppers.io” in the ask is the Shortlist team page at [shortlist.io/about-us](https://shortlist.io/about-us/).)

**Decision (updated 2026-08-19):**
- **Human website:** a visible “Who runs this” block plus footer — Shortlist since 2018, links to [shortlist.io](https://shortlist.io/) and [the team](https://shortlist.io/about-us/). Copy is explanatory, not a banner about “programmatic placements at scale.”
- **Buyer MCP (Claude etc.):** `help`, initialize `instructions`, `/llms.txt`, `register_account`, and the payment/`INSUFFICIENT_CREDIT` `next_step` tell the agent to show Shortlist + the team page **before the human pays**. Inventory stays blind. Do not invent a different owner.
- **Buyer mail From `placement@shortlist.io`**, not `hello@placement.sh`. Anja/ops use the Shortlist mailbox.
- **Publisher outreach unchanged:** named Shortlist human, never From placement.sh.
- **Hermes** is a first-class add-to-agent option on the homepage (`hermes mcp add placement --url …`).

## 2026-08-19 — looking is unlimited; pay only to submit

David: an agent should query as much as it wants so the human can figure out what to write. No result cap. Smooth, natural, guided by MCP. Payment only when they submit.

**Decision:** drop the anonymous-10 / registered-50 search caps. `search_publishers` pages (`limit` default 50, max 200, `offset` for the rest) so a 9k catalog does not dump into one MCP turn. `help` and initialize tell the agent to keep browsing, then show Shortlist, then ask for email, then pay. Registering does not unlock extra results — it unlocks booking.

## 2026-08-19 — buyer mail From placement@shortlist.io

David: customers and people who sign up should get mail from `placement@shortlist.io`.

**Decision:** buyer transactional From/Reply-To is `placement.sh <placement@shortlist.io>` (Shortlist Google Workspace). The Worker sends `account.created` on a *new* `register_account` (welcome to the buyer + ops ping to that mailbox and `CITE_ADMIN_EMAILS`). Re-register of an existing email does not resend. Transport is Gmail API secrets, else Resend. No Cloudflare Email Sending on placement.sh, no Email Routing MX on the apex. Mail failure never blocks MCP. API keys and publisher domains stay out of the mail.

## 2026-08-19 — prepaid Stripe Checkout on Shortlist’s Stripe

David: signup mail works; put the payment path live.

**Decision:** Worker implements wallet + Stripe Checkout on **Shortlist’s existing Stripe**. `add_credits` returns a Checkout URL. Webhook `POST /webhooks/stripe` credits `available_cents` only when `metadata.product=placement.sh`. Landing page `GET /paid`. `create_campaign` with no credits returns `INSUFFICIENT_CREDIT` plus that Checkout payload. No new Stripe account. Restricted key.

## 2026-08-19 — charge the exact amount; MCP writes and submits the post

David: do not introduce credit packs yet. Charge whatever they are buying (the publisher `listed_price`, or the campaign budget). Packs can come later.

Second: in this booking process the MCP must guide the agent on what to write and where the backlink goes — Context Engine homepage vs a specific article. If it is an article, help craft the post from that URL. The finished post is submitted into our backend so ops can process it.

**Decision:**
- `add_credits` / `create_campaign` Checkout is the **exact USD amount** (minimum $1). No $50 / $150 / $500 / $2,000 snap.
- Funded `create_campaign` returns `ready_to_write` (it does not email publishers or reveal domains).
- New tools: `get_writing_brief` (homepage vs article URL, how to write; domain stays hidden; the Worker does not fetch the buyer URL) and `submit_placement` (screen the post, hold `listed_price`, insert `placement_orders`, ops email with domain).
- Operator console **Orders** tab lists submitted posts. Allocator / publisher outreach still happens by hand from that queue.

## 2026-08-19 — Ahrefs-only metrics going forward

David: we will only use Ahrefs.

**Decision:** the public metric is **Ahrefs Domain Rating**, attributed, never renamed. Organic traffic stays a **band** (exact Ahrefs traffic uniquely identifies a site). Moz DA and Majestic TrustFlow / CitationFlow are not shown on the buyer MCP and will not be refreshed as ranking inputs.

**Superseded later the same day:** David: we can show all the stats Ahrefs shows. Exact Ahrefs organic traffic (and the rest of the Site Explorer overview) is now buyer-visible. See below.

Fingerprinting consequence of the earlier cut: the combo that reconstructed the catalog was exact DR+DA+TF+CF (93.6%). DR+niche is 2.9%.

Not in the morning cut: D1 still has `da` / `tf` / `cf` from the sheet (operator console can see them). Placement Score still has leftover DA/TF weights until scores are recomputed from Ahrefs-only inputs.

## 2026-08-19 — show every Ahrefs overview stat

David: we can show all the stats Ahrefs shows.

**Decision:** the buyer MCP publishes the Ahrefs Site Explorer overview, using Ahrefs' names, attributed, never renamed:

- Domain Rating
- organic traffic (**exact**, not a band)
- organic keywords, referring domains, backlinks, Ahrefs Rank, organic value — when the row has them

`traffic_band` stays as a search convenience. Moz DA and Majestic TF/CF stay off every surface (buyer MCP, operator console, admin MCP).

**Placement Score is Ahrefs-only:** 50% Domain Rating + 50% organic traffic (log-scaled). Moz DA, Majestic TF/CF, and Moz spam are not inputs. Recompute on D1 with `migrations/008_ahrefs_score.sql` at deploy.

What we have in D1 today: DR + organic traffic from the sheet. The extra overview columns are nullable until an Ahrefs refresh fills them. Domain is still hidden from buyers until delivery.

Exact organic traffic uniquely identifies a site in Ahrefs. That is accepted: we are showing the same numbers Ahrefs shows an end user, not a Moz/Majestic fingerprinting combo.

## 2026-08-19 — orders stay in the console; copy and send by hand

David: the order can stay inside the platform for now; copy it out and send it to the person. Notify when an order comes in, then take it from there. Context Engine for fulfilment is later, not now.

**Decision:** no Gmail drafts to publishers, no auto-send. `notifyPlacementSubmitted` emails ops. Operators open `/admin` → Orders, copy the post, and email the publisher themselves. Domain stays operator-only.

**Console look:** operator console (including sign-in) uses Shortlist.io brand tokens — Inter, navy `#17204B`, mint `#30D2AD`, cyan `#00AADD` — light surfaces, not the previous dark console.

## 2026-08-19 — unfinished Checkouts stay in Follow-up

David: if somebody opens Checkout and does not pull through, we want that visible so we can follow up with that person.

**Decision:** unpaid Stripe Checkout sessions (`checkout_sessions.credited_at IS NULL`) show in `/admin` → Follow-up: email, amount, when they started, whether the Stripe link is still open. Ops copy / mailto from here. No automatic nudge sequence.

## 2026-08-20 — homepage wordmark, team, and a call link

David: the placement.sh homepage should use the Shortlist-colored dot between “placement” and “sh”, and Who runs this should mainly send people to the team page, plus the same Book a call Calendly Shortlist uses on shortlist.io.

**Decision:** wordmark is `placement.sh` with the period in Shortlist mint (`#30D2AD`). Who runs this leads with [the team](https://shortlist.io/about-us/), then a plain link to [Book a 15-min call](https://calendly.com/shortlist-businessdevelopment/15min) (the homepage widget URL, not an embedded popup), then shortlist.io. The same three links go out over MCP (`help.who_runs_this`, initialize instructions, booking `next_step`) so the agent can offer a call in the chat — optional, not required to pay. No auto-book, no Calendly embed. Inter + navy ink so the mint period reads as Shortlist, not a generic teal.

## 2026-08-20 — crawl-first enrichment while Ahrefs is pending

David: enrich publishers with what they write about and recent posts so an agent can draft; sign up for Ahrefs in parallel.

**Decision:** do the crawl (+ optional Grok) now. Do not wait on Ahrefs. Fat profile belongs on `get_writing_brief` / `get_publisher` detail — not a keyword dump on `search_publishers`.

- Script: `cite-worker/scripts/enrich-content.mts` (open egress, not the public Worker). Homepage + RSS, honour `Disallow: /`, brand-scrub public fields.
- `--llm` calls xAI (`grok-4-fast` by default) with `enrich_prompt_v1` when `XAI_API_KEY` is set. Without a key, store crawl-only `summary` / `writes_about` / `recent_titles` (`source=crawl-v1`) so briefs improve immediately.
- **Cursor Grok ≠ xAI API.** Selecting Grok in Cursor (including this cloud agent) uses the Cursor plan. It does not inject `XAI_API_KEY`. SuperGrok / grok.com is not API access either. Unattended `--llm` needs a key from [console.x.ai](https://console.x.ai/) stored as a Cursor Cloud Agent Runtime Secret named `XAI_API_KEY`. Profiles written in this chat are applied with `scripts/apply-llm-profiles.mts`.
- D1 migration `009_enrich_profile.sql` adds audience / tone / post_shape / typical_length_words / do_fit / dont_fit / summary_private / enrich_status. `summary_private` is operator-only.
- Highest `cite_score` first. Resume skips `enrich_status=ok`. Ahrefs ranking keywords stay a second pass.

## 2026-08-20 — buyer MCP descriptions must not identify the publisher

David: the site description must not leak which publisher it is via MCP.

**Decision:** `search_publishers` / `get_publisher` / `get_writing_brief` re-scrub every public text field at read time and drop the field if a domain or registered-name token remains. Exact `recent_post_titles` stay off the buyer MCP (they google the masthead). Writing-brief `example_angles` come from topics, not quoted headlines. `summary_private` stays operator-only.

## 2026-08-20 — paid and free inventory are two sections of the console

David: separate the inventory of paid sites and the free sites I found — these are two different sections in the backend.

**Decision:** `sites.cost_type` is the split, and `/admin` shows it as two tabs: **Paid inventory** and **Free inventory**. The tab is the filter (`/admin/api/sites` always sends `cost_type`), so the old *paid + free* dropdown is gone and a free publisher can never turn up in the paid table.

- Paid keeps the money columns — seller $, markup, listed $, margin.
- Free drops all four (they were four dashes per row) and shows what an operator actually needs: **how to get in** (`acquisition_mode`), whether the publisher **wants a link back** (`requires_reciprocal_link`), and the **submission instructions** (`agent_instructions`), all editable inline.
- A **Section** control on every row patches `cost_type` — that is how a site moves between the two.
- Free sites are added from the free tab and stored **without a seller price**, so nothing computes a listed price for them and `buyerWhere` keeps them off the buyer MCP. Free inventory stays operator-only; nothing about this changes the 2026-08-18 "paid inventory only, no free listings" decision on the public MCP.
- Header counts split too (`paid_sites` / `free_sites`), and the money stats — priced, avg markup, avg margin, link-attr unknown — now count paid rows only. New: a `paid, unpriced` warning, because those rows are invisible to buyers.

Live today: **8,968 paid** (8,820 `paid_placement` + 148 `unavailable`) and **499 free** (378 `apply_editorial`, 80 `link_exchange`, 22 `self_serve`, 19 `unavailable`).

Next on the free side (not built): researching more free publishers and filling in `agent_instructions` for the 470-odd rows that have none.

## Still open

1. **Domain + trademark check for "Cite"** (§13.1) — **closed as a brand**: ship as placement.sh. Cite remains the repo/worker name.
2. **Finished posts vs. pitches** (§13.5) — **closed 2026-08-18**: finished posts, implemented via `submit_placement`.
3. **Ahrefs API access** — Moz / Majestic are out going forward. Still verify what Shortlist's Ahrefs licence actually includes (API vs. UI-only).
4. **Link-attribute backfill** — dofollow/sponsored unknown across 9,453 sites; mandatory field before launch (§12b).
5. **Build team** — who drives the v1 build (agent-driven by David, Shortlist devs, or a hire).
6. **Shortlist's own repositioning** — independent open question; not resolved by shipping Cite.
7. **Which Shortlist mailbox / named sender** owns v1 Gmail drafts — **deferred.** Orders stay in `/admin`; operators copy and send by hand. Revisit drafts / Context Engine writes after that loop is in use.
8. **xAI vs other LLM** — prompt and JSON shape stay; the vendor is swappable. Cursor Grok can write profiles in-chat; the 8k batch still wants an xAI API key.

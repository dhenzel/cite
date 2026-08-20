# placement.sh — paid path, emails, site research, agent-submitted posts

**Status:** build-ready spec. Settled with David Henzel 2026-08-18.
**Companion to:** `SPEC.md` §6 (content), §8 (outreach), §10 (money), §15 steps 3–7, §17 (tiers).
**Product name in public copy:** placement.sh. Internal tables may still say Cite.

This is the shortest path that takes real money, lets a customer’s agent write the post in Claude/Grok/Cursor, and lands a Gmail draft in the Shortlist inbox.

---

## 0. What is already true

| Piece | State today |
|---|---|
| Inventory in D1 (`cite-v0`) | ~9k publishers, prices, contacts |
| Public MCP | `estimate` / `search_publishers` / `get_publisher` / `register_account` / `add_credits` / `account_status` / `create_campaign`. **Paid inventory only** — no `claim_free_placement`, no $0 / self-serve listings |
| `create_campaign` | `ACCOUNT_REQUIRED` or `INSUFFICIENT_CREDIT` (+ Checkout when Stripe secrets are set). Funded accounts get `FULFILLMENT_NOT_LIVE` until the allocator ships |
| Stripe | Worker implements wallet + Checkout + webhook. Live keys + D1 migration + Dashboard webhook still required. Tag `metadata.product=placement.sh` |
| `site_content` | table exists; ~11 demo rows; `cite-mcp/src/enrich.ts` fetches homepage + RSS and stores a **brand-scrubbed** summary. Most inventory is still just a niche tag (“Tech”) |
| Buyer emails | `account.created` on new `register_account`; `credits.added` after Checkout |
| Operator outreach | specced as Gmail drafts (§8); not built |
| Agent-submitted posts | specced as finished markdown (§6); not built |

---

## 1. In-agent money (must feel like talking, not a checkout site)

Agents cannot enter card numbers. Humans can click a link in the same chat. That is the whole UX.

### Wallet, not a cart

Prepaid **credits in USD cents** on `accounts`. One Checkout can fund many placements. Matches SPEC §10.

```
available_cents   — spendable
held_cents        — reserved on submitted orders, not yet ours
```

- `add_credits` → Stripe Checkout → webhook credits `available_cents`
- `submit_placement` → move `listed_price` from available → held (fail with `INSUFFICIENT_CREDIT` + a fresh Checkout URL if short)
- publisher accepts + T+30 verified → held becomes captured (credits burn)
- publisher rejects / link missing at T+30 → held returns to available; buyer email + MCP error `REFUND_ISSUED`

Never capture to placement.sh before `verified`. The T+30 guarantee is only honest if the money is still the buyer’s until then.

### MCP tools (buyer)

| tool | does |
|---|---|
| `register_account({email})` | already exists. Keep it. Email is how we talk to the human when the agent goes idle. |
| `account_status` | add `available_cents`, `held_cents`, `currency: "usd"`, `has_card` |
| `add_credits({amount_usd, return_to?})` | create Stripe Checkout Session (`mode=payment`, `customer_email` from the account). Return **only** `{checkout_url, session_id, expires_at, amount_usd, next_step}`. `next_step` is a one-liner the agent reads aloud: *“Open this link, pay, then say ‘paid’.”* |
| `create_campaign(...)` | if `available_cents < budget * 100`, do **not** fail with a dead end. Return `INSUFFICIENT_CREDIT` **plus** the same Checkout payload `add_credits` would have returned for the shortfall (round up to a pack). If funded, allocate and return `{campaign_id, allocation: [{publisher_id, listed_price, writing_brief_ref}]}` |
| `get_writing_brief({publisher_id})` | the brief the customer agent writes against — see §3 |
| `submit_placement({publisher_id, campaign_id?, target_url, anchor_text, title, body, author_bio?, idempotency_key})` | finished post in. Auto-screen. Hold funds. Queue operator email. |
| `get_order({order_id})` / `list_orders` | honest state. Domain still hidden until `published` / `verified`. |

**Credit packs** (so agents don’t mint a $37.12 session): $50 / $150 / $500 / $2,000 / custom ≥ $50. `add_credits` snaps up to the next pack unless `amount_usd` is already a pack.

**Idempotency:** `add_credits` and `submit_placement` take `idempotency_key`. Stripe Session id is stored on the account. Retrying the tool must return the **same** `checkout_url` while the session is open, not a second charge.

### What the agent says (this is the product)

Happy path, one conversation:

1. User: “Get https://acme.com/pricing cited on fintech, about two thousand dollars.”
2. Agent calls `estimate`, then `register_account` if needed.
3. Agent calls `add_credits({amount_usd: 2000})`, prints the URL, waits.
4. Human pays in the browser. Agent calls `account_status` until `available_cents >= 200000` (or the human says “paid” — then one status check).
5. Agent calls `create_campaign` → picks publishers → for each, `get_writing_brief` → **writes the post in the chat** → `submit_placement`.
6. On `WORD_COUNT_LOW` / `TOPIC_MISMATCH` / … the agent rewrites **in the same thread** and resubmits the same `idempotency_key` with new body. Do not send the human to a form.

`help` and the homepage panel copy must describe this loop, not “once a card is on file.”

### Stripe implementation notes

- Product: one Stripe product “placement.sh credits”; Checkout line item = pack.
- **Account (v1):** use **Shortlist’s existing Stripe**. Do not open a new Stripe account to start. Tag every Session/PaymentIntent `metadata.product = placement.sh` so webhooks ignore unrelated Shortlist charges. Statement descriptor / Checkout title: `PLACEMENT.SH` (not Shortlist). Split to a dedicated account later if volume warrants it.
- Restricted API key (Checkout + Customers + Webhooks only) — the Worker must not see the rest of Shortlist’s Stripe.
- Webhook `checkout.session.completed` (and `async_payment_succeeded`): credit wallet **only if** `metadata.product === "placement.sh"`, send `credits.added` email, mark `stripe_customer_id`.
- Webhook secret in Worker secrets (`STRIPE_WEBHOOK_SECRET`). Never in wrangler.toml.
- Success/cancel URLs: `https://placement.sh/paid?session_id={CHECKOUT_SESSION_ID}` — a **dead-simple** page: “Credits added. Go back to your agent and say ‘paid’.” No dashboard, no login. Agents cannot complete OAuth; this page exists so the human has somewhere to land.
- Customer Portal is **not** v1. Card-on-file / auto-top-up is v2.
- Test mode first; live keys only after one internal $50 pack round-trip.

### What we will not do in v1

- Charging inside Claude’s UI (no network for raw PANs; no Stripe MCP we control across Grok/Cursor).
- Per-order Stripe captures (too many sessions; agents retry). Wallet + internal hold is the agent-native version of “funds held until verified.”
- Showing seller_price, domain, or margin on any buyer tool.

---

## 2. Emails

Two completely different streams. Mixing them burns concealment (§12a / §14).

### A. Buyer transactional — from shortlist.io

**From / Reply-To:** `placement.sh <placement@shortlist.io>`. Not `hello@placement.sh`. Do not wait on Cloudflare Email Sending or a placement.sh sending domain. The Worker sends `account.created` on `register_account` via the Gmail API (Workspace mailbox) or Resend. Mail failure never blocks signup. Remaining buyer events (`credits.added`, order mail) can still be sent by a human until those paths exist.

| event | when | says | never says |
|---|---|---|---|
| `account.created` | `register_account` | you have an account; placement.sh is a Shortlist product; how to add the MCP; next step is prepaid credits | publisher names, free listings |
| `credits.added` | Checkout completed | amount, new available balance | last4 unnecessary |
| `order.received` | `submit_placement` accepted | order id, listed price, “we’ll email when it’s live” | domain |
| `order.needs_revision` | auto_screen failed **and** the agent is gone (no follow-up call in 30 min) | the structured error in English | domain |
| `order.published` | operator marked published | **first time the buyer sees `published_url`** | seller_price, outreach thread |
| `order.verified` | T+30 crawler | guarantee met; credits captured | — |
| `order.refunded` | reject or link lost | amount returned to credits; cash refund on request | publisher identity if still blind |

If the agent is still in the conversation, MCP is the primary channel; email is the backup for when Claude/Grok sessions die.

Templates live in the Worker as functions, not a third-party campaign tool. Log `email_id` on the order.

### B. Operator outreach — Gmail drafts, Shortlist identity

SPEC §8 unchanged: **a named Shortlist human** appears to the publisher. placement.sh must not be the From: on that message.

On `submit_placement` passing auto_screen:

1. Worker writes `orders` row (`state=human_review`).
2. Worker calls Gmail API (`gmail.users.drafts.create`) into the **Shortlist outreach mailbox**, as the assigned sender identity.
3. Draft body is the agent’s submitted post, wrapped in a short human pitch (template per sender). Operator edits and sends. This is real editing time, not a rubber stamp.
4. Console + admin MCP: `admin_list_orders`, `admin_mark_order({id, state, published_url?})`.

v1 sender: one mailbox (Nenad/Martin — confirm who). v2: rotate identities.

**Env:** `GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN` as Worker secrets, or a tiny Cloud Function if Google’s OAuth refresh is painful in Workers. Do not send via Resend to publishers.

### C. DNS

Buyer mail authenticates as **shortlist.io** (existing Shortlist Google Workspace / SPF / DKIM). Do not add Email Routing MX on the placement.sh apex. Cloudflare Email Sending on placement.sh is not required for v1.

---

## 3. Site research — crawl ourselves, Grok writes the profile, store in D1

Today `get_publisher` is a niche tag plus optional thin `content_summary`. A customer agent cannot write a post that would actually run. That is the gap.

### Can we “crawl with Grok”?

**Not in chat.** Do not paste 9,000 URLs into Grok/Cursor and hope. Grok has no durable crawl, rate limits will kill it, and private domains would leak into a consumer product.

**Yes as a pipeline:** we fetch, Grok (xAI API) writes the profile, we save.

```
for each active site:
  1. GET https://{domain}/  (+ /blog, /articles, RSS/Atom if advertised)
  2. Extract title, meta description, up to ~8k chars of visible text, up to 12 recent headlines
  3. POST to xAI chat completions (grok-4-fast or grok-3-mini) with a fixed prompt
  4. Store two rows of meaning (see schema)
  5. Sleep / jitter; honour robots.txt Disallow; skip on 403/timeout; mark enrich_status
```

Run from a machine with open egress (local script or a Cloudflare Worker + Browser Rendering for JS-heavy homes). The existing `cite-mcp/src/enrich.ts` is step 1–2; **replace the bag-of-words `topicsFrom()` with the Grok profile.** Do not use Grok to *fetch* pages — we fetch, it only writes.

**Prompt (fixed, versioned `enrich_prompt_v1`):** given extracted text (which still contains the brand — this call is internal), return JSON:

```
{
  "audience": "who reads this, one sentence",
  "topics": ["5–12 topics they actually cover, not the sheet niche"],
  "tone": "e.g. practitioner / consumer / affiliate-review",
  "typical_length_words": 900,
  "post_shape": "how-to | listicle | opinion | news | review",
  "do": "what a guest post must include to fit",
  "dont": "angles they clearly don’t run",
  "summary_private": "120–180 words, brand names OK",
  "summary_public": "80–120 words, no brand, no domain, no author names — as if describing a nameless publisher"
}
```

Validate JSON. If `summary_public` still contains the domain or registered-name tokens, run `scrub()` and reject/retry once.

### Schema additions (`site_content`)

Keep the table; add columns (migration, not a rewrite):

| column | who sees it |
|---|---|
| `summary` | **public** (already exposed as `content_summary`) — store `summary_public` here |
| `writes_about` | **public** — Grok `topics` JSON |
| `recent_titles` | **public** — already scrubbed headlines |
| `summary_private` | operator + allocator only |
| `audience`, `tone`, `post_shape`, `typical_length_words`, `do_fit`, `dont_fit` | operator full; public via `get_writing_brief` as the same fields **without** brand tokens |
| `enriched_at`, `enrich_status` (`ok` / `fetch_failed` / `llm_failed` / `robots_blocked`), `source` (`crawl+grok-v1`) | operator |
| `raw_extract` | optional, operator, **do not** send to buyer tools; drop or cap at 16kb |

### `get_writing_brief(publisher_id)` — what the customer agent needs

Returned to buyers (still blind):

- `publisher_id`
- `audience`, `topics`, `tone`, `post_shape`, `typical_length_words`
- `do` / `dont`
- `content_summary` (public)
- `max_links_per_post`, `link_attribute`, `min_word_count` (from `typical_length_words` or site override)
- `example_angles` — 3 bullets derived from recent (scrubbed) titles, not the titles themselves if they leak brand

This is enough to write a fitting post without knowing the domain.

### Cost and pacing (order-of-magnitude)

~9,000 active sites × ~1.5k tokens in + 400 out on a cheap Grok tier is a bounded batch (tens of dollars, not thousands), plus fetch time. Run **highest `cite_score` first**, cap concurrency at ~5, resume from `enrich_status IS NULL`. Refresh quarterly or when an operator clicks “re-enrich.”

Admin MCP: `admin_enrich_sites({limit, min_score, status})` dry-run count, then `confirm:true`. Console: Enrichment tab showing coverage % and failures.

**Do not** put xAI keys in the public Worker if the public Worker is reachable from the internet without admin auth — run enrich as a one-shot script (`cite-mcp/src/enrich.ts`) that writes to D1 via `wrangler d1 execute` or an admin-only Worker route.

---

## 4. The customer’s agent writes the post and submits it

This is the default. Pitches without a body are rejected (`CONTENT_REQUIRED`). (SPEC §13.5 stays “finished posts”; this spec implements it.)

### Auto-screen (deterministic, no LLM)

Run in this order; return **one** error so the agent can fix and retry:

| code | if |
|---|---|
| `CONTENT_REQUIRED` | missing title or body |
| `WORD_COUNT_LOW` | words(body) < site `typical_length_words` * 0.8 (or 600 if unknown) — include `required_min` |
| `WORD_COUNT_HIGH` | > 2500 unless site override |
| `LINK_LIMIT` | more than `max_links_per_post` (default 2) or more than one link to `target_url` |
| `TARGET_URL_MISSING` | `target_url` not in body |
| `ANCHOR_OVER_OPTIMIZED` | exact-match anchors over campaign cap (SPEC §4) |
| `TOPIC_MISMATCH` | none of the brief `topics` appear in title+body AND cosine/token overlap with `writes_about` is below floor — include `accepted_topics` |
| `DUPLICATE_CONTENT` | body hash matches a prior order |
| `SITE_THROTTLED` | 4/quarter (SPEC §4) — include `next_eligible_at` |
| `INSUFFICIENT_CREDIT` | include Checkout payload |

On pass: `state=human_review`, funds held, Gmail draft created, `order.received` email.

### Operator

Reads the draft, actually edits, sends. Marks `outreach_sent` / `site_accepted` / `site_rejected` / `published` (+ `published_url`) in the console. Buyer `get_order` then shows `published_url`.

---

## 5. Build order (do not parallelize the money path)

1. **Wallet + Stripe Checkout + webhook + `add_credits` / richer `account_status`.** **Shipped 2026-08-19** on the Worker (test keys first, then live). Internal $50 pack still required before flipping `sk_live`. Buyer email `credits.added` + `account.created`. `create_campaign` still does not allocate publishers (`FULFILLMENT_NOT_LIVE` when funded).
2. **Enrichment pipeline** on the top ~500 score sites (enough for briefs to be real), then the rest. Wire `get_writing_brief` and richer `get_publisher.content_summary`.
3. **`submit_placement` + auto-screen + D1 `orders` + hold.** MCP errors the agent can act on.
4. **Gmail drafts** into the Shortlist inbox + console order list.
5. **`create_campaign` allocator** that returns writing_brief refs (can stay greedy/v0).
6. T+30 verification crawler + capture/refund (SPEC §15.7) — after one real paid order has been fulfilled by hand.

Help, homepage agent panels, and `skills/placement/SKILL.md` update when step 1 ships so Claude/Grok stop saying “card on file.”

---

## 6. Secrets / env (Worker)

```
STRIPE_SECRET_KEY           # Restricted key on Shortlist's Stripe (v1)
STRIPE_WEBHOOK_SECRET
MAIL_FROM                   # placement@shortlist.io (wrangler.toml [vars])
GMAIL_CLIENT_ID             # secret — Workspace OAuth for placement@shortlist.io
GMAIL_CLIENT_SECRET         # secret
GMAIL_REFRESH_TOKEN         # secret — authorize as placement@shortlist.io with gmail.send
RESEND_API_KEY              # secret — fallback if Gmail is not configured; shortlist.io must be verified
GMAIL_* (drafts)            # operator outreach drafts stay a separate mailbox/token later
XAI_API_KEY                 # enrich script, not public MCP
```

OIDC redirect is `https://placement.sh/auth/callback` (`wrangler.toml` `[vars]`). Register that URI on the Shortlist IdP. GET/HEAD on `*.workers.dev` redirects to placement.sh.

---

## 7. Explicitly out of this spec

- Customer-facing lift dashboards (SPEC §10)
- Agent-to-publisher chat
- Revealing domains pre-delivery
- Using Grok/Claude chat as the crawler
- Auto-sending outreach without a human (concealment)
- Cash refunds in-Stripe in v1 (credits back first)

# placement.sh worker — MCP + operator console

Cloudflare Worker serving:

- **`GET /`** — minimal landing page (HTML for browsers, plaintext for agents).
- **`POST /mcp`** — public MCP (Streamable HTTP), two tool families:
  - *free* — `analyze_site`, `search_opportunities`, `get_opportunity`, `prepare_submission`, `record_submission`, `check_listing_status`, `list_submissions`. No account, no card.
  - *paid* — `estimate`, `search_publishers`, `get_publisher`, `inventory_stats`, `register_account`, `add_credits`, `account_status`, `create_campaign`, `get_writing_brief`, `submit_placement`.
- **`GET /paid`** — post-Checkout landing (“credits added — go back to your agent and say paid”).
- **`POST /webhooks/stripe`** — credits the wallet on `checkout.session.completed` when `metadata.product=placement.sh`.
- **`GET /llms.txt`**, **`GET /.well-known/mcp/server.json`** — agent discovery.
- **`/admin`** — operator console (Shortlist navy/mint): **Paid inventory**, **Opportunities** (the free catalog, where unverified rows get confirmed), **Submissions** (what customers are doing with it), and **Orders**. Submitted posts stay here; ops get mail, copy the post, and send it to the publisher themselves. Domain is visible to operators only. Guarded by Shortlist SSO / `ADMIN_TOKEN`.

Public language is **publisher / placement**, never site. D1 table names stay `sites` so the live catalog does not need a migration.

## Connect

```bash
claude mcp add --transport http placement https://mcp.placement.sh/mcp
```

## Custom domains

`wrangler.toml` attaches this Worker as origin for `placement.sh`, `www.placement.sh`, and `mcp.placement.sh`. Deploy from this directory with the same Cloudflare account that owns the zone:

```bash
cd cite-worker
npx wrangler deploy --keep-vars
```

`--keep-vars` preserves `ADMIN_TOKEN`, OIDC secrets, `SESSION_SECRET`, and mail secrets (`GMAIL_*` / `RESEND_API_KEY`). If deploy errors on an existing CNAME, delete that DNS record in the placement.sh zone and redeploy. Apex A/AAAA placeholders are usually replaced.

Public and operator URLs are always `https://placement.sh` (MCP at `/mcp`, console at `/admin`, admin MCP at `/admin/mcp`). The `cite-mcp.*.workers.dev` hostname still exists as a Cloudflare Worker URL; GET/HEAD there redirects to placement.sh. Never mint connector URLs on workers.dev.

## First-time setup

```bash
cd cite-worker
npm install
npx wrangler d1 execute cite-v0 --remote --file=/path/to/seed.sql
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy --keep-vars
```

Buyer signup mail is From `placement@shortlist.io`. Create that Workspace user, then put Gmail OAuth secrets (authorize as that mailbox with `gmail.send`):

```bash
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
```

If Gmail is not ready, `RESEND_API_KEY` is the fallback (verify `shortlist.io` on Resend). Signup still works if neither is set.

Prepaid credits use **Shortlist’s existing Stripe** (restricted key). Tag is `metadata.product=placement.sh`. Do not open a new Stripe account. The Worker only needs Checkout Sessions write + Customers write — it must not see the rest of Shortlist’s Stripe.

```bash
npx wrangler d1 execute cite-v0 --remote --file=migrations/005_wallet.sql
npx wrangler d1 execute cite-v0 --remote --file=migrations/006_orders.sql
npx wrangler secret put STRIPE_SECRET_KEY          # start sk_test_ / rk_test_; later live restricted
npx wrangler secret put STRIPE_WEBHOOK_SECRET      # from the webhook endpoint (test mode has its own secret)
npx wrangler deploy --keep-vars
```

If the ALTERs in `005_wallet.sql` say the column already exists, skip them and run only the `CREATE TABLE checkout_sessions` statements.

Stripe Dashboard (same Shortlist account):

- Webhook URL: `https://placement.sh/webhooks/stripe`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`
- Success URL (already in code): `https://placement.sh/paid?session_id={CHECKOUT_SESSION_ID}`
- Checkout branding / statement descriptor: **PLACEMENT.SH** (not Shortlist)

Charge the exact listed_price (for example $195). No credit packs in v1. Test mode first, then one internal live payment, then leave live keys in place.

## Tests

`npm test` — extractors plus the Worker handler against in-memory SQLite: public leak checks, publisher-named tools, discovery URLs, admin auth, and the paid/free section split.

`npm run test:console` — renders the real console in headless Chromium against a stubbed API. Catches an inline-script syntax error, which would silently blank the whole page.

## Two products, two tables

`sites` is **paid publishers only** since migration 010. Everything free lives in
`opportunities` — a different thing with a different workflow, not a cheaper shelf of
the same thing.

| | Paid inventory (`sites`) | Free opportunities (`opportunities`) |
|---|---|---|
| What it is | publishers Shortlist pays for and places on | places a **customer** gets listed, profiled or published |
| Who acts | we do — the buyer pays and we fulfil | the customer's agent prepares; a human submits |
| Identity | anonymised handle, domain blind until delivery | a public platform, named up front |
| Money | seller $, markup, listed $, margin | none. No account, no card, free forever |
| Buyer MCP | `search_publishers` etc., paid rows only | `analyze_site` → `search_opportunities` → `prepare_submission` |

`contribution` is the axis inside the free catalog:

- **`article`** — the customer writes a post (guest-post blogs, Medium, dev.to, Substack).
  These are the 499 rows migration 010 moved out of `sites`.
- **`profile`** — the customer's company gets listed (directories, marketplaces, review sites).
- **`program`** — the customer applies to join (partner ecosystems, awards, accelerators).

### Importing the research workbook

```bash
npx tsx scripts/import-opportunities.mts --in ~/free-backlink-opportunities-2026.xlsx
npx wrangler d1 execute cite-v0 --remote --file=migrations/010_opportunities.sql
npx wrangler d1 execute cite-v0 --remote --file=data/opportunities.sql
npx wrangler deploy --keep-vars
```

Migration 010 also copies the free `sites` rows into `opportunities` and archives the
originals — it is idempotent, so re-running it will not duplicate them. The generated
SQL is ~4 MB and takes about ten seconds; `data/` stays gitignored.

The workbook is ClosedXML output (`x:`-prefixed OOXML), which ExcelJS cannot parse,
so `scripts/xlsx-read.mts` is a small dependency-free reader written for it. Generated
SQL carries **no** `BEGIN`/`COMMIT` — D1 rejects SQL transaction statements in an
executed file.

### What the catalog is honest about

The research is a discovery corpus, not a verified list, and the schema says so:

- **Cost is unverified on about half of it.** Only `is_free_confirmed = 1` rows may be
  described as free; everything else says "not established" until someone checks.
- **`needs_reverification = 1` on 842 of 843 imported rows.** The requirements came from
  a class template covering many platforms of the same kind, not from that platform's
  live form. An operator clears the flag from the console **Opportunities** tab after
  opening the live page — that is the standing work.
- **`link_attribute_claim` is a claim.** `check_listing_status` fetches a live listing
  and records the `rel` it actually renders, which is the only link fact worth having.
- **Gates only bite where the workbook set them.** Many rows have no hard gates at all,
  so matching quality improves with verification, not with more code.

Nothing on either surface may promise approval, indexing, traffic, or a dofollow link.

## Publisher enrichment (crawl, then optional Grok)

Do not crawl from the public Worker. **The crawl needs open egress and will not
run everywhere.** A Claude Code cloud session proxies outbound HTTPS through an
allowlist that denies publisher hosts — every fetch comes back `403` from the
CONNECT tunnel and the whole pass reports `fetch_failed`. Run it from a Cursor
cloud agent or a laptop. Prove egress with a 10-site `--limit` before starting a
long run; if the status spread is all `fetch_failed`, you are on the wrong machine,
not looking at broken publishers.

```bash
# 1. Build the input from D1: every paid site without an 'ok' profile yet,
#    highest cite_score first. Writes data/paid-sites.json (gitignored — domains).
npx tsx scripts/make-paid-sites.mts --pending enrich

# 2. Crawl. Resume is automatic — rerunning skips anything already in the JSONL.
npx tsx scripts/enrich-content.mts --sites data/paid-sites.json --out data/enrich.jsonl

# later, when you have an xAI *API* key (console.x.ai — not SuperGrok, not Cursor):
XAI_API_KEY=... npx tsx scripts/enrich-content.mts --sites data/paid-sites.json --out data/enrich.jsonl --llm --force

# 3. Load into D1 and redeploy.
npx tsx scripts/enrich-to-sql.mts --in data/enrich.jsonl --out data/enrich.sql
npx wrangler d1 execute cite-v0 --remote --file=migrations/009_enrich_profile.sql
npx wrangler d1 execute cite-v0 --remote --file=data/enrich.sql
npx wrangler deploy --keep-vars
```

`--force` restarts from scratch: it clears the resume set *and* truncates the
JSONL, so the ledger never ends up with two rows per site. Without it, `--limit`
and `--offset` window the sites that are still outstanding, so a resumed run with
`--limit 500` crawls 500 new sites rather than 500 minus whatever is already done.

**Cursor × Grok is not an API key.** Picking Grok in Cursor (this cloud agent included) bills the Cursor plan. It does not set `XAI_API_KEY` and cannot call `https://api.x.ai`. SuperGrok / grok.com is also not API access.

Two ways to get Grok profiles:

1. **This chat (Cursor subscription).** The agent writes `enrich_prompt_v1` JSON from crawl extracts. Then:
   ```bash
   npx tsx scripts/apply-llm-profiles.mts --in data/enrich.jsonl --profiles data/llm-profiles.jsonl --out data/llm-merged.jsonl
   ```
2. **Unattended 8k batch.** Create an xAI API key at [console.x.ai](https://console.x.ai/), add it to Cursor as a Cloud Agent **Runtime Secret** named `XAI_API_KEY` ([Secrets & Network](https://cursor.com/docs/cloud-agent/security-network)), and run `--llm`.

`get_writing_brief` already reads scrubbed `summary` / `writes_about`. Exact recent headlines stay off the buyer MCP so a description cannot be googled back to the publisher. Deploy after 009 so audience / tone / do / dont show up.

## Ahrefs overview refresh

Do not put an Ahrefs key on the public Worker. Use the REST **Batch Analysis** API from a machine with `AHREFS_API_KEY` in the environment (Cursor Runtime Secret, or your laptop). The hosted Ahrefs MCP is for interactive lookups only.

Lite is 100k units/month. One overview row (`domain_rating`, `org_traffic`, `org_keywords`, `refdomains`, `backlinks`, `ahrefs_rank`, `org_cost`) is about 29 units, so a full 8k pass does not fit. Default is the top 3,000 paid sites by score, `mode=subdomains` (apex `domain` mode often returns 0 traffic).

```bash
cd cite-worker
npx tsx scripts/make-paid-sites.mts --pending ahrefs   # only sites with no overview yet
AHREFS_API_KEY=… npx tsx scripts/refresh-ahrefs.mts \
  --sites data/paid-sites.json --out data/ahrefs.jsonl --sql data/ahrefs.sql
npx wrangler d1 execute cite-v0 --remote --file=data/ahrefs.sql
```

`data/ahrefs.jsonl` and `data/ahrefs.sql` are gitignored (publisher domains). Resume skips site_ids already in the JSONL. `--limit` / `--budget-units` cap spend.

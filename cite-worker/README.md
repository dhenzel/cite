# placement.sh worker — MCP + operator console

Cloudflare Worker serving:

- **`GET /`** — minimal landing page (HTML for browsers, plaintext for agents).
- **`POST /mcp`** — public MCP (Streamable HTTP): `help`, `estimate`, `search_publishers`, `get_publisher`, `inventory_stats`, `register_account`, `add_credits`, `account_status`, `create_campaign`, `get_writing_brief`, `submit_placement`. Paid inventory only.
- **`GET /paid`** — post-Checkout landing (“credits added — go back to your agent and say paid”).
- **`POST /webhooks/stripe`** — credits the wallet on `checkout.session.completed` when `metadata.product=placement.sh`.
- **`GET /llms.txt`**, **`GET /.well-known/mcp/server.json`** — agent discovery.
- **`/admin`** — operator console: inventory plus an **Orders** tab for agent-submitted posts (domain visible to operators only). Guarded by Shortlist SSO / `ADMIN_TOKEN`.

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

`npm test` — Worker handler against in-memory SQLite: public leak checks, publisher-named tools, discovery URLs, admin auth.

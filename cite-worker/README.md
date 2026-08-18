# placement.sh worker — MCP + operator console

Cloudflare Worker serving:

- **`GET /`** — minimal landing page (HTML for browsers, plaintext for agents).
- **`POST /mcp`** — public free read tier (MCP Streamable HTTP): `help`, `estimate`, `search_publishers`, `get_publisher`, `inventory_stats`. Whitelisted fields only — domains, contacts, seller prices, and markup are never serialized here (blind placements).
- **`GET /llms.txt`**, **`GET /.well-known/mcp/server.json`** — agent discovery.
- **`/admin`** — operator console: full inventory with seller price, markup, listed price and margin. Guarded by Shortlist SSO / `ADMIN_TOKEN`.

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

`--keep-vars` preserves `ADMIN_TOKEN`, OIDC secrets, and `SESSION_SECRET`. If deploy errors on an existing CNAME, delete that DNS record in the placement.sh zone and redeploy. Apex A/AAAA placeholders are usually replaced.

Until that deploy runs, the live origin is still `https://cite-mcp.d-henzel.workers.dev`.

## First-time setup

```bash
cd cite-worker
npm install
npx wrangler d1 execute cite-v0 --remote --file=/path/to/seed.sql
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy --keep-vars
```

## Tests

`npm test` — Worker handler against in-memory SQLite: public leak checks, publisher-named tools, discovery URLs, admin auth.

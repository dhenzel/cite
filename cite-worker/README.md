# placement.sh worker — MCP + operator console

Cloudflare Worker serving:

- **`POST /mcp`** — public free read tier (MCP Streamable HTTP): `help`, `estimate`, `search_publishers`, `get_publisher`, `inventory_stats`. Whitelisted fields only — domains, contacts, seller prices, and markup are never serialized here (blind placements).
- **`GET /llms.txt`**, **`GET /.well-known/mcp/server.json`** — agent discovery.
- **`/admin`** — operator console: full inventory with seller price, markup, listed price and margin. Guarded by Shortlist SSO / `ADMIN_TOKEN`.

Public language is **publisher / placement**, never site. D1 table names stay `sites` so the live catalog does not need a migration.

## Connect

```bash
claude mcp add --transport http placement https://mcp.placement.sh/mcp
```

Until DNS is attached to this Worker, substitute the `*.workers.dev` origin.

## First-time setup

```bash
cd cite-worker
npm install
npx wrangler d1 execute cite-v0 --remote --file=/path/to/seed.sql
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Then attach `mcp.placement.sh` (and apex `placement.sh`) to the Worker.

## Tests

`npm test` — Worker handler against in-memory SQLite: public leak checks, publisher-named tools, discovery URLs, admin auth.

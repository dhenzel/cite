# AGENTS.md

## Cursor Cloud specific instructions

### Repository layout / where the code lives

This repo (`cite`) hosts **Cite** — an agent-native link-placement marketplace (see `SPEC.md` and `DECISIONS.md`). All of the application code is on `main`. There are two independent Node/TypeScript projects:

- `cite-worker/` — the primary product: a Cloudflare Worker (`wrangler`) serving the public MCP endpoint (`POST /mcp`), the operator console (`/admin`), and the operator/admin MCP (`/admin/mcp`), backed by a D1 database (`cite-v0`). See `cite-worker/README.md`.
- `cite-mcp/` — a local **stdio** MCP server (the free read tier) over a local SQLite DB built by an import pipeline. See `cite-mcp/README.md`.

Node 22 + npm are the toolchain. Dependencies for both projects are installed by the startup update script (`npm install --prefix <dir>` for each, guarded on the `package.json` existing).

### Running & testing `cite-worker` (primary)

- **Tests / lint proxy:** `npm test` (from `cite-worker/`) runs the extractor, Ahrefs and `scripts/worker-test-d1.mts` suites — a fully self-contained suite (in-memory SQLite D1 shim + stubbed OIDC/engine). It needs no network, no secrets, and no external data. This is the authoritative check for the Worker.
- **Do not rely on standalone `tsc` for the Worker.** There is no `cite-worker/tsconfig.json`; the Worker is typed/built by `wrangler` (esbuild) and its devDep is a TS 7 preview. Running `npx tsc src/index.ts` fails with `Cannot find name 'D1Database'` — that is expected (Cloudflare Worker types are only wired up under wrangler), not a real defect. Validate via `npm test` and `wrangler dev`.
- **Run it:** `wrangler dev` talks to a **local** D1 in `--local` mode — use it so you never need Cloudflare account auth (the remote `cite-v0` DB in `wrangler.toml` lives in David's account and is unreachable here). First-time local DB setup:
  - `npx wrangler d1 execute cite-v0 --local --file=schema.sql`
  - `npx wrangler d1 execute cite-v0 --local --file=scripts/dev-seed.sql` (synthetic, obviously-fake `*.test` fixtures — there is no real publisher data in the repo)
  - `npx wrangler dev --local --port 8787`
  - Local D1 state persists under `cite-worker/.wrangler/` (gitignored), so the schema/seed survive dev-server restarts.
- **Secrets for local console:** `ADMIN_TOKEN` and `SESSION_SECRET` are real secrets (set in prod via `wrangler secret put`). For local work pass them as plain vars, e.g. `npx wrangler dev --local --var ADMIN_TOKEN:dev-admin-token-123 --var SESSION_SECRET:dev-session-secret-xyz`. With `ALLOW_TOKEN_CONSOLE="true"` (the default in `wrangler.toml`) you can then open the operator console via the break-glass URL `http://localhost:8787/admin?token=dev-admin-token-123`. Full Shortlist SSO cannot be exercised locally — the OIDC issuer (`shortlist.on-relote.com`) is unreachable from the VM; the test suite covers SSO against a stubbed issuer instead.
- Quick smoke checks: `GET /health`, `POST /mcp` with `tools/list` or a `search_sites` call. The public payload is deliberately "blind" — `domain`, `contact_*`, `seller_price` and `markup` are never serialized on `/mcp` (only `/admin/*` returns them).

### Running & testing `cite-mcp` (stdio server)

- Real runs need the private publisher CSV at `cite-mcp/data/inventory.csv`, which is **gitignored and not in the repo** (it holds domains, contacts, seller prices). `data/` and `*.db` are gitignored.
- For local dev without the real export, drop a synthetic CSV at `cite-mcp/data/inventory.csv` with the sheet's headers (`Niche,Subniche,Website,Name,Email To,Point Of Contact,Note,Rate,Standard,Premium,Platinum,TrustFlow,CitationFlow,DA,Spam Score,Organic Traffic (Ahrefs),DR (Ahrefs),Updated`), then:
  - `npm run import` → builds `data/cite.db` (also writes `data/handle.salt`)
  - `npm run demo` → starts the stdio server and plays a buyer agent through it (`inventory_stats` → `search_sites` → `get_site` → `estimate`), including a leak check that no domain/email escapes.
  - `npm run server` runs the server directly on stdio (used by `claude mcp add`).
- `npx tsc --noEmit` (from `cite-mcp/`, TS 5.9) is a valid typecheck for this project.

### Gotchas

- Never commit anything under `cite-mcp/data/` or a real inventory CSV — it is private publisher data by design.
- `cite-worker/scripts/dev-seed.sql` is intentionally synthetic dev-only fixture data; do not treat it as real inventory.
- Generated D1 import files must not contain `BEGIN`/`COMMIT` — D1 rejects SQL transaction statements in a `--file` import.
- The console HTML and `LLMS_TXT` are TS template literals: a stray backtick in a comment inside them is a syntax error that blanks the page. `npm run test:console` catches it.
- The free-opportunity workbook is ClosedXML output (`x:`-prefixed OOXML). ExcelJS cannot read it; `scripts/xlsx-read.mts` is the dependency-free reader written for it.

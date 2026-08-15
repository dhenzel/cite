# cite-mcp — Cite v0 prototype

The free read tier of Cite (SPEC §6/§15 steps 1–2) as a working MCP server over
the real Shortlist inventory, with blind placements enforced in code.

## Setup

```bash
cd cite-mcp
npm install
# put the publisher sheet CSV export at data/inventory.csv (never commit it)
npm run import          # builds data/cite.db — 9,453 sites, Cite Scores, listed prices
npm run enrich -- --limit 100   # optional: crawl sites → anonymized content summaries
```

`data/` is gitignored: it holds publisher domains, contacts and seller prices.

## Connect from Claude Code

```bash
claude mcp add cite -- npx tsx /absolute/path/to/cite-mcp/src/server.ts
```

Then ask Claude things like:

> "Search Cite for finance sites with score ≥ 60 under $300, tell me which
> ones fit a B2B payments product, and what kind of post each would take."

## Tools

- `search_sites` — filter by topics / text / min_score / max_price / traffic band. Returns anonymized handles only.
- `get_site` — full anonymized profile incl. content summary + what the site writes about (when enriched).
- `estimate` — what a budget buys across score bands (v0 allocator taste, applies the ≤25%-of-budget per-placement cap).
- `inventory_stats` — aggregate niche/score-band counts.

## Blind placements

Every response passes a field whitelist (`src/serialize.ts`) — `domain`,
contact fields and `seller_price` are structurally absent — plus a runtime
`assertNoLeak` check. Content summaries are scrubbed of brand/domain tokens
(`src/anonymize.ts`) before storage.

## Known v0 gaps (need Shortlist team input)

- `link_attribute` is `unknown` everywhere — dofollow/sponsored per site must be backfilled (SPEC §12b makes it mandatory).
- `max_links_per_post`, `turnaround_sla_days` — not in the sheet.
- `placements` table (what's already placed where) — needs order history.
- Metrics are ~16 months stale; refresh via vendor APIs before anything public.
- Demo enrichment used search snippets for 11 sites (this sandbox blocks
  arbitrary outbound HTTP); run `npm run enrich` on a normal machine to crawl at scale.

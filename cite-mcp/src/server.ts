// Cite v0 MCP server — the free read tier from SPEC §6, plus a v0 estimate.
// stdio transport: `npx tsx src/server.ts`, or via Claude Code:
//   claude mcp add cite -- npx tsx /path/to/cite-mcp/src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { publicSite, assertNoLeak, type SiteRow } from './serialize.js';

const here = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(here, '..', 'data', 'cite.db'), { readonly: true });

const MAX_RESULTS = 50; // free-tier cap (SPEC §11)

const privateValues = (rows: SiteRow[]): string[] =>
  rows.flatMap((r) => [r.domain, r.contact_email, r.contact_name, r.point_of_contact] as string[]).filter(Boolean);

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

const server = new McpServer({ name: 'cite', version: '0.1.0' });

server.tool(
  'search_sites',
  'Search Cite placement inventory. Returns anonymized site handles — domains are revealed only when a placement is delivered. Filter by topic, Cite Score, price, and traffic.',
  {
    topics: z.array(z.string()).optional().describe('Topic/niche terms, e.g. ["fintech","business"]'),
    text: z.string().optional().describe('Free-text match against what the site writes about'),
    min_score: z.number().min(0).max(100).optional().describe('Minimum Cite Score (0-100)'),
    max_price: z.number().positive().optional().describe('Maximum price per placement, USD'),
    min_traffic_band: z.enum(['500–1k/mo', '1k–5k/mo', '5k–10k/mo', '10k–50k/mo', '50k–250k/mo', '250k+/mo']).optional(),
    limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
  },
  async (args) => {
    const clauses: string[] = ["s.status = 'active'", 's.listed_price IS NOT NULL'];
    const params: unknown[] = [];
    if (args.topics?.length) {
      const t = args.topics.map(() => '(s.niche LIKE ? OR s.subniche LIKE ? OR c.writes_about LIKE ?)').join(' OR ');
      clauses.push(`(${t})`);
      for (const topic of args.topics) params.push(`%${topic}%`, `%${topic}%`, `%${topic}%`);
    }
    if (args.text) {
      clauses.push('(c.summary LIKE ? OR c.writes_about LIKE ? OR s.subniche LIKE ?)');
      params.push(`%${args.text}%`, `%${args.text}%`, `%${args.text}%`);
    }
    if (args.min_score != null) { clauses.push('s.cite_score >= ?'); params.push(args.min_score); }
    if (args.max_price != null) { clauses.push('s.listed_price <= ?'); params.push(args.max_price); }
    if (args.min_traffic_band) {
      const order = ['<500/mo', '500–1k/mo', '1k–5k/mo', '5k–10k/mo', '10k–50k/mo', '50k–250k/mo', '250k+/mo'];
      const allowed = order.slice(order.indexOf(args.min_traffic_band));
      clauses.push(`s.traffic_band IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    }
    const rows = db.prepare(`
      SELECT s.*, c.summary, c.writes_about, c.recent_titles
      FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.cite_score DESC, s.listed_price ASC
      LIMIT ?
    `).all(...params, Math.min(args.limit ?? 20, MAX_RESULTS)) as SiteRow[];

    const payload = {
      result_count: rows.length,
      note: 'Handles are anonymized. Domains are revealed only at delivery; buy on cite_score, topics, traffic_band and price — backed by the live-and-indexed-at-T+30-or-refund guarantee.',
      sites: rows.map((r) => publicSite(r)),
    };
    assertNoLeak(payload, privateValues(rows));
    return ok(payload);
  },
);

server.tool(
  'get_site',
  'Full anonymized profile for one site handle: score, pricing tiers, content summary, what it writes about, posting constraints.',
  { site_id: z.string().describe('Handle from search_sites, e.g. cs_ab12cd34ef56') },
  async ({ site_id }) => {
    const row = db.prepare(`
      SELECT s.*, c.summary, c.writes_about, c.recent_titles
      FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
      WHERE s.id = ?
    `).get(site_id) as SiteRow | undefined;
    if (!row) return ok({ error: 'SITE_NOT_FOUND', site_id });
    const payload = publicSite(row, true);
    assertNoLeak(payload, privateValues([row]));
    return ok(payload);
  },
);

server.tool(
  'estimate',
  'Sketch what a budget buys: placement counts across Cite Score bands for given topics. No commitment, no reserved inventory. A v0 taste of the allocator.',
  {
    topics: z.array(z.string()).describe('Campaign topics'),
    budget: z.number().positive().describe('Total budget, USD'),
    risk_tolerance: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
  },
  async ({ topics, budget, risk_tolerance }) => {
    const risk = risk_tolerance ?? 'balanced';
    const perPlacementCap = budget * 0.25; // SPEC §4 constraint 4
    const minScore = risk === 'conservative' ? 55 : risk === 'balanced' ? 40 : 25;
    const t = topics.map(() => '(s.niche LIKE ? OR s.subniche LIKE ? OR c.writes_about LIKE ?)').join(' OR ');
    const params: unknown[] = [];
    for (const topic of topics) params.push(`%${topic}%`, `%${topic}%`, `%${topic}%`);
    const rows = db.prepare(`
      SELECT s.cite_score, s.listed_price
      FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
      WHERE s.status='active' AND s.listed_price IS NOT NULL AND s.listed_price <= ?
        AND s.cite_score >= ? AND (${t})
      ORDER BY s.cite_score DESC
    `).all(perPlacementCap, minScore, ...params) as { cite_score: number; listed_price: number }[];

    // Greedy fill across bands, ~4 placements per site is irrelevant here since
    // each row is a distinct site; diversity = spread spend across score bands.
    const bands = [
      { name: '80–100', min: 80, sites: [] as number[] },
      { name: '60–79', min: 60, sites: [] as number[] },
      { name: '40–59', min: 40, sites: [] as number[] },
      { name: '25–39', min: 25, sites: [] as number[] },
    ];
    for (const r of rows) {
      const b = bands.find((b) => r.cite_score >= b.min);
      if (b) b.sites.push(r.listed_price);
    }
    let remaining = budget;
    const plan = bands
      .filter((b) => b.sites.length && b.min >= minScore)
      .map((b) => {
        const share = b.min >= 80 ? 0.35 : b.min >= 60 ? 0.35 : b.min >= 40 ? 0.2 : 0.1;
        let alloc = Math.min(budget * share, remaining);
        const prices = b.sites.sort((a, z) => a - z);
        let count = 0, spent = 0;
        for (const p of prices) {
          if (spent + p > alloc) break;
          spent += p; count++;
        }
        remaining -= spent;
        return { score_band: b.name, eligible_sites: b.sites.length, planned_placements: count, planned_spend: spent };
      })
      .filter((p) => p.planned_placements > 0);

    const totalPlacements = plan.reduce((a, p) => a + p.planned_placements, 0);
    const totalSpend = plan.reduce((a, p) => a + p.planned_spend, 0);
    return ok({
      topics, budget, risk_tolerance: risk,
      constraints_applied: [`per-placement cap $${perPlacementCap}`, `min cite_score ${minScore}`, 'spend spread across score bands'],
      plan,
      total_planned_placements: totalPlacements,
      total_planned_spend: totalSpend,
      unallocated_budget: budget - totalSpend,
      note: totalPlacements === 0 ? 'No eligible inventory for these filters — widen topics or raise budget.' : 'Estimate only. create_campaign (funded tier, not in v0) turns this into a real allocation.',
    });
  },
);

server.tool(
  'inventory_stats',
  'Aggregate view of Cite inventory: counts by niche and Cite Score band. No site identities.',
  {},
  async () => {
    const byNiche = db.prepare(`
      SELECT niche, COUNT(*) AS sites, ROUND(AVG(cite_score)) AS avg_score,
             MIN(listed_price) AS from_price
      FROM sites WHERE status='active' AND listed_price IS NOT NULL AND niche IS NOT NULL
      GROUP BY niche ORDER BY sites DESC LIMIT 15
    `).all();
    const byBand = db.prepare(`
      SELECT CASE WHEN cite_score>=80 THEN '80–100' WHEN cite_score>=60 THEN '60–79'
                  WHEN cite_score>=40 THEN '40–59' ELSE '<40' END AS band,
             COUNT(*) AS sites
      FROM sites WHERE status='active' AND listed_price IS NOT NULL
      GROUP BY band ORDER BY MIN(cite_score) DESC
    `).all();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM sites WHERE status='active' AND listed_price IS NOT NULL`).get();
    return ok({ purchasable_sites: (total as { n: number }).n, by_niche: byNiche, by_score_band: byBand });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('cite-mcp v0 ready (stdio)');

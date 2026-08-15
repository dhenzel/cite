// Cite v0 — hosted MCP endpoint (Cloudflare Worker, Streamable HTTP).
// The bundled dataset contains PUBLIC fields only (handles, scores, bands,
// prices, scrubbed content summaries) — no domains, contacts, or seller
// prices exist in this deployment at all, so the endpoint structurally
// cannot leak them. Blind placements by construction.
//
// Connect:  claude mcp add --transport http cite https://<worker-url>/mcp
import DATA from '../data/public-data.json';

interface SiteRec {
  id: string; niche: string | null; subniche: string | null;
  cite_score: number; traffic_band: string; listed_price: number;
  link_attribute: string; ts: number; tp: number; tpl: number;
  summary: string | null; writes_about: string | null; recent_titles: string | null;
}
const SITES = DATA as SiteRec[];
const MAX_RESULTS = 50;
const BAND_ORDER = ['<500/mo', '500–1k/mo', '1k–5k/mo', '5k–10k/mo', '10k–50k/mo', '50k–250k/mo', '250k+/mo'];

const pub = (s: SiteRec, detail = false) => {
  const base: Record<string, unknown> = {
    site_id: s.id,
    cite_score: s.cite_score,
    niche: s.niche,
    subniche: s.subniche || undefined,
    traffic_band: s.traffic_band,
    listed_price: s.listed_price,
    link_attribute: s.link_attribute ?? 'unknown',
    writes_about: s.writes_about ? JSON.parse(s.writes_about) : undefined,
  };
  if (!detail) return base;
  return {
    ...base,
    tiers: { standard: !!s.ts, premium: !!s.tp, platinum: !!s.tpl },
    max_links_per_post: 'unknown',
    turnaround_sla_days: 'unknown',
    content_summary: s.summary ?? undefined,
    recent_post_titles: s.recent_titles ? JSON.parse(s.recent_titles) : undefined,
    note: 'Domain is revealed as published_url when the placement is delivered (blind placements).',
  };
};

const matchTopics = (s: SiteRec, topics: string[]) =>
  topics.some((t) => {
    const q = t.toLowerCase();
    return (s.niche ?? '').toLowerCase().includes(q)
      || (s.subniche ?? '').toLowerCase().includes(q)
      || (s.writes_about ?? '').toLowerCase().includes(q);
  });

// ---------- tools ----------
const tools = [
  {
    name: 'search_sites',
    description: 'Search Cite placement inventory. Returns anonymized site handles — domains are revealed only when a placement is delivered. Filter by topic, Cite Score, price, and traffic.',
    inputSchema: {
      type: 'object',
      properties: {
        topics: { type: 'array', items: { type: 'string' }, description: 'Topic/niche terms, e.g. ["fintech","business"]' },
        text: { type: 'string', description: 'Free-text match against what the site writes about' },
        min_score: { type: 'number', minimum: 0, maximum: 100 },
        max_price: { type: 'number', exclusiveMinimum: 0 },
        min_traffic_band: { type: 'string', enum: BAND_ORDER.slice(1) },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
      },
    },
  },
  {
    name: 'get_site',
    description: 'Full anonymized profile for one site handle: score, pricing tiers, content summary, what it writes about, posting constraints.',
    inputSchema: {
      type: 'object',
      properties: { site_id: { type: 'string', description: 'Handle from search_sites, e.g. cs_ab12cd34ef56' } },
      required: ['site_id'],
    },
  },
  {
    name: 'estimate',
    description: 'Sketch what a budget buys: placement counts across Cite Score bands for given topics. No commitment, no reserved inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        topics: { type: 'array', items: { type: 'string' } },
        budget: { type: 'number', exclusiveMinimum: 0 },
        risk_tolerance: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'] },
      },
      required: ['topics', 'budget'],
    },
  },
  {
    name: 'inventory_stats',
    description: 'Aggregate view of Cite inventory: counts by niche and Cite Score band. No site identities.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function runTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'search_sites': {
      const topics = (args.topics as string[] | undefined) ?? [];
      const text = (args.text as string | undefined)?.toLowerCase();
      const minScore = (args.min_score as number | undefined) ?? 0;
      const maxPrice = (args.max_price as number | undefined) ?? Infinity;
      const minBandIdx = args.min_traffic_band ? BAND_ORDER.indexOf(args.min_traffic_band as string) : 0;
      const limit = Math.min((args.limit as number | undefined) ?? 20, MAX_RESULTS);
      const rows = SITES.filter((s) =>
        s.cite_score >= minScore
        && s.listed_price <= maxPrice
        && BAND_ORDER.indexOf(s.traffic_band) >= minBandIdx
        && (!topics.length || matchTopics(s, topics))
        && (!text || `${s.summary ?? ''} ${s.writes_about ?? ''} ${s.subniche ?? ''}`.toLowerCase().includes(text)),
      ).slice(0, limit);
      return {
        result_count: rows.length,
        note: 'Handles are anonymized. Domains are revealed only at delivery; buy on cite_score, topics, traffic_band and price — backed by the live-and-indexed-at-T+30-or-refund guarantee.',
        sites: rows.map((s) => pub(s)),
      };
    }
    case 'get_site': {
      const s = SITES.find((x) => x.id === args.site_id);
      return s ? pub(s, true) : { error: 'SITE_NOT_FOUND', site_id: args.site_id };
    }
    case 'estimate': {
      const topics = args.topics as string[];
      const budget = args.budget as number;
      const risk = (args.risk_tolerance as string | undefined) ?? 'balanced';
      const cap = budget * 0.25;
      const minScore = risk === 'conservative' ? 55 : risk === 'balanced' ? 40 : 25;
      const eligible = SITES.filter((s) => s.listed_price <= cap && s.cite_score >= minScore && matchTopics(s, topics));
      const bands = [
        { name: '80–100', min: 80, share: 0.35 },
        { name: '60–79', min: 60, share: 0.35 },
        { name: '40–59', min: 40, share: 0.2 },
        { name: '25–39', min: 25, share: 0.1 },
      ];
      let remaining = budget;
      const plan = bands
        .filter((b) => b.min >= minScore || b.min + 20 > minScore)
        .map((b) => {
          const prices = eligible
            .filter((s) => s.cite_score >= b.min && s.cite_score < b.min + (b.min === 80 ? 21 : 20))
            .map((s) => s.listed_price)
            .sort((a, z) => a - z);
          const alloc = Math.min(budget * b.share, remaining);
          let count = 0, spent = 0;
          for (const p of prices) {
            if (spent + p > alloc) break;
            spent += p; count++;
          }
          remaining -= spent;
          return { score_band: b.name, eligible_sites: prices.length, planned_placements: count, planned_spend: spent };
        })
        .filter((p) => p.planned_placements > 0);
      const total = plan.reduce((a, p) => a + p.planned_placements, 0);
      const spend = plan.reduce((a, p) => a + p.planned_spend, 0);
      return {
        topics, budget, risk_tolerance: risk,
        constraints_applied: [`per-placement cap $${cap}`, `min cite_score ${minScore}`, 'spend spread across score bands'],
        plan, total_planned_placements: total, total_planned_spend: spend, unallocated_budget: budget - spend,
        note: total === 0 ? 'No eligible inventory for these filters — widen topics or raise budget.' : 'Estimate only. create_campaign (funded tier) turns this into a real allocation.',
      };
    }
    case 'inventory_stats': {
      const byNiche = new Map<string, { sites: number; scoreSum: number; from: number }>();
      const byBand = new Map<string, number>();
      for (const s of SITES) {
        const n = s.niche ?? 'Uncategorized';
        const e = byNiche.get(n) ?? { sites: 0, scoreSum: 0, from: Infinity };
        e.sites++; e.scoreSum += s.cite_score; e.from = Math.min(e.from, s.listed_price);
        byNiche.set(n, e);
        const band = s.cite_score >= 80 ? '80–100' : s.cite_score >= 60 ? '60–79' : s.cite_score >= 40 ? '40–59' : '<40';
        byBand.set(band, (byBand.get(band) ?? 0) + 1);
      }
      return {
        purchasable_sites: SITES.length,
        by_niche: [...byNiche.entries()]
          .sort((a, z) => z[1].sites - a[1].sites).slice(0, 15)
          .map(([niche, e]) => ({ niche, sites: e.sites, avg_score: Math.round(e.scoreSum / e.sites), from_price: e.from })),
        by_score_band: [...byBand.entries()].map(([band, sites]) => ({ band, sites })),
      };
    }
    default:
      return { error: 'UNKNOWN_TOOL', name };
  }
}

// ---------- MCP Streamable HTTP (stateless) ----------
const PROTOCOL = '2025-03-26';

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

async function handleMcp(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST JSON-RPC to this endpoint (MCP Streamable HTTP)' }), {
      status: 405, headers: { 'content-type': 'application/json', allow: 'POST' },
    });
  }
  let body: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { body = await req.json(); } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const { id, method, params } = body;
  if (method === 'initialize') {
    return json(rpcResult(id, {
      protocolVersion: (params?.protocolVersion as string) ?? PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'cite', version: '0.1.0' },
      instructions: 'Cite: agent-native link placement inventory (free read tier). Sites are anonymized handles; domains are revealed only when a placement is delivered.',
    }));
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
    return new Response(null, { status: 202 });
  }
  if (method === 'tools/list') return json(rpcResult(id, { tools }));
  if (method === 'tools/call') {
    const name = params?.name as string;
    const args = (params?.arguments as Record<string, unknown>) ?? {};
    const payload = runTool(name, args);
    return json(rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }));
  }
  if (method === 'ping') return json(rpcResult(id, {}));
  return json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } }, 200);
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/mcp') return handleMcp(req);
    if (url.pathname === '/health') return json({ ok: true, sites: SITES.length });
    return new Response(
      `Cite v0 — agent-native link placement inventory (free read tier)\n\n` +
      `MCP endpoint (Streamable HTTP): POST ${url.origin}/mcp\n` +
      `Connect from Claude Code:  claude mcp add --transport http cite ${url.origin}/mcp\n\n` +
      `Tools: search_sites, get_site, estimate, inventory_stats\n` +
      `${SITES.length} purchasable sites. Handles are anonymized — domains are revealed only at delivery.\n`,
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },
};

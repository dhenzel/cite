// Cite v0 — hosted MCP endpoint + operator console (Cloudflare Worker).
//
// Public surface (no auth): POST /mcp (MCP Streamable HTTP), GET /, /health.
//   Reads whitelisted fields from D1 — domains, contacts, seller prices and
//   markup are never serialized here (blind placements, SPEC §11).
// Operator surface (bearer ADMIN_TOKEN): GET /admin (UI), /admin/api/*.
//   Full private rows: domain, contacts, seller price, per-site markup,
//   computed listed price + margin (SPEC §16).
//
// Connect:  claude mcp add --transport http cite https://<worker-url>/mcp
import { ADMIN_HTML } from './admin-ui.js';

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
}

const MAX_RESULTS = 50;
const BAND_ORDER = ['<500/mo', '500–1k/mo', '1k–5k/mo', '5k–10k/mo', '10k–50k/mo', '50k–250k/mo', '250k+/mo'];
const LINK_ATTRS = ['unknown', 'dofollow', 'sponsored', 'ugc', 'nofollow'];
const STATUSES = ['active', 'paused', 'burned'];

export const listedPrice = (seller: number, markup: number): number =>
  Math.ceil((seller * markup) / 5) * 5;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-session-id, authorization',
};
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...CORS } });

// ---------- public field whitelist (blind placements) ----------
type Row = Record<string, unknown>;
const pub = (r: Row, detail = false) => {
  const base: Row = {
    site_id: r.id,
    cite_score: r.cite_score,
    niche: r.niche,
    subniche: r.subniche || undefined,
    traffic_band: r.traffic_band,
    listed_price: r.listed_price,
    link_attribute: r.link_attribute ?? 'unknown',
    writes_about: r.writes_about ? JSON.parse(r.writes_about as string) : undefined,
  };
  if (!detail) return base;
  return {
    ...base,
    tiers: { standard: !!r.tier_standard, premium: !!r.tier_premium, platinum: !!r.tier_platinum },
    max_links_per_post: r.max_links_per_post ?? 'unknown',
    turnaround_sla_days: r.turnaround_sla_days ?? 'unknown',
    content_summary: r.summary ?? undefined,
    recent_post_titles: r.recent_titles ? JSON.parse(r.recent_titles as string) : undefined,
    note: 'Domain is revealed as published_url when the placement is delivered (blind placements).',
  };
};

// ---------- MCP tools ----------
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
    inputSchema: { type: 'object', properties: { site_id: { type: 'string' } }, required: ['site_id'] },
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

const topicClause = (n: number) =>
  Array.from({ length: n }, () => '(s.niche LIKE ? OR s.subniche LIKE ? OR c.writes_about LIKE ?)').join(' OR ');
const topicParams = (topics: string[]) => topics.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);

async function runTool(env: Env, name: string, args: Row): Promise<unknown> {
  switch (name) {
    case 'search_sites': {
      const topics = (args.topics as string[] | undefined) ?? [];
      const clauses = ["s.status='active'", 's.listed_price IS NOT NULL'];
      const params: unknown[] = [];
      if (topics.length) { clauses.push(`(${topicClause(topics.length)})`); params.push(...topicParams(topics)); }
      if (args.text) {
        clauses.push('(c.summary LIKE ? OR c.writes_about LIKE ? OR s.subniche LIKE ?)');
        params.push(`%${args.text}%`, `%${args.text}%`, `%${args.text}%`);
      }
      if (args.min_score != null) { clauses.push('s.cite_score >= ?'); params.push(args.min_score); }
      if (args.max_price != null) { clauses.push('s.listed_price <= ?'); params.push(args.max_price); }
      if (args.min_traffic_band) {
        const allowed = BAND_ORDER.slice(BAND_ORDER.indexOf(args.min_traffic_band as string));
        clauses.push(`s.traffic_band IN (${allowed.map(() => '?').join(',')})`);
        params.push(...allowed);
      }
      const limit = Math.min((args.limit as number | undefined) ?? 20, MAX_RESULTS);
      const rows = (await env.DB.prepare(`
        SELECT s.*, c.summary, c.writes_about, c.recent_titles
        FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY s.cite_score DESC, s.listed_price ASC LIMIT ?
      `).bind(...params, limit).all()).results as Row[];
      return {
        result_count: rows.length,
        note: 'Handles are anonymized. Domains are revealed only at delivery; buy on cite_score, topics, traffic_band and price — backed by the live-and-indexed-at-T+30-or-refund guarantee.',
        sites: rows.map((r) => pub(r)),
      };
    }
    case 'get_site': {
      const row = (await env.DB.prepare(`
        SELECT s.*, c.summary, c.writes_about, c.recent_titles
        FROM sites s LEFT JOIN site_content c ON c.site_id = s.id WHERE s.id = ?
      `).bind(args.site_id).first()) as Row | null;
      return row ? pub(row, true) : { error: 'SITE_NOT_FOUND', site_id: args.site_id };
    }
    case 'estimate': {
      const topics = args.topics as string[];
      const budget = args.budget as number;
      const risk = (args.risk_tolerance as string | undefined) ?? 'balanced';
      const cap = budget * 0.25;
      const minScore = risk === 'conservative' ? 55 : risk === 'balanced' ? 40 : 25;
      const rows = (await env.DB.prepare(`
        SELECT s.cite_score, s.listed_price
        FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
        WHERE s.status='active' AND s.listed_price IS NOT NULL AND s.listed_price <= ?
          AND s.cite_score >= ? AND (${topicClause(topics.length)})
      `).bind(cap, minScore, ...topicParams(topics)).all()).results as { cite_score: number; listed_price: number }[];
      const bands = [
        { name: '80–100', min: 80, max: 101, share: 0.35 },
        { name: '60–79', min: 60, max: 80, share: 0.35 },
        { name: '40–59', min: 40, max: 60, share: 0.2 },
        { name: '25–39', min: 25, max: 40, share: 0.1 },
      ];
      let remaining = budget;
      const plan = bands
        .map((b) => {
          const prices = rows.filter((r) => r.cite_score >= b.min && r.cite_score < b.max)
            .map((r) => r.listed_price).sort((a, z) => a - z);
          const alloc = Math.min(budget * b.share, remaining);
          let count = 0, spent = 0;
          for (const p of prices) { if (spent + p > alloc) break; spent += p; count++; }
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
      const byNiche = (await env.DB.prepare(`
        SELECT niche, COUNT(*) AS sites, ROUND(AVG(cite_score)) AS avg_score, MIN(listed_price) AS from_price
        FROM sites WHERE status='active' AND listed_price IS NOT NULL AND niche IS NOT NULL
        GROUP BY niche ORDER BY sites DESC LIMIT 15
      `).all()).results;
      const byBand = (await env.DB.prepare(`
        SELECT CASE WHEN cite_score>=80 THEN '80–100' WHEN cite_score>=60 THEN '60–79'
                    WHEN cite_score>=40 THEN '40–59' ELSE '<40' END AS band, COUNT(*) AS sites
        FROM sites WHERE status='active' AND listed_price IS NOT NULL
        GROUP BY band ORDER BY MIN(cite_score) DESC
      `).all()).results;
      const total = (await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM sites WHERE status='active' AND listed_price IS NOT NULL`,
      ).first()) as { n: number };
      return { purchasable_sites: total.n, by_niche: byNiche, by_score_band: byBand };
    }
    default:
      return { error: 'UNKNOWN_TOOL', name };
  }
}

// ---------- MCP Streamable HTTP (stateless) ----------
async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST JSON-RPC to this endpoint (MCP Streamable HTTP)' }), {
      status: 405, headers: { 'content-type': 'application/json', allow: 'POST', ...CORS },
    });
  }
  let body: { id?: unknown; method?: string; params?: Row };
  try { body = await req.json(); } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const { id, method, params } = body;
  if (method === 'initialize') {
    return json({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params?.protocolVersion as string) ?? '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'cite', version: '0.2.0' },
      instructions: 'Cite: agent-native link placement inventory (free read tier). Sites are anonymized handles; domains are revealed only when a placement is delivered.',
    } });
  }
  if (method?.startsWith('notifications/')) return new Response(null, { status: 202, headers: CORS });
  if (method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools } });
  if (method === 'tools/call') {
    const payload = await runTool(env, params?.name as string, (params?.arguments as Row) ?? {});
    return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] } });
  }
  if (method === 'ping') return json({ jsonrpc: '2.0', id, result: {} });
  return json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } });
}

// ---------- operator console (SPEC §16) ----------
function authorized(req: Request, env: Env): boolean {
  const token = env.ADMIN_TOKEN;
  if (!token) return false; // no secret configured → admin surface disabled
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const EDITABLE = ['seller_price', 'markup', 'status', 'link_attribute', 'max_links_per_post',
  'turnaround_sla_days', 'niche', 'subniche', 'note', 'contact_name', 'contact_email'] as const;

async function handleAdminApi(req: Request, env: Env, path: string): Promise<Response> {
  if (!authorized(req, env)) return json({ error: 'UNAUTHORIZED' }, 401);

  if (path === '/admin/api/stats' && req.method === 'GET') {
    const totals = await env.DB.prepare(`
      SELECT COUNT(*) AS sites,
             SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN listed_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
             ROUND(AVG(markup),2) AS avg_markup,
             ROUND(AVG(CASE WHEN seller_price>0 THEN listed_price-seller_price END),2) AS avg_margin,
             SUM(CASE WHEN link_attribute='unknown' THEN 1 ELSE 0 END) AS attr_unknown
      FROM sites
    `).first();
    return json(totals);
  }

  if (path === '/admin/api/sites' && req.method === 'GET') {
    const u = new URL(req.url);
    const q = u.searchParams.get('q');
    const niche = u.searchParams.get('niche');
    const status = u.searchParams.get('status');
    const page = Math.max(1, parseInt(u.searchParams.get('page') ?? '1', 10));
    const per = 50;
    const clauses: string[] = ['1=1'];
    const params: unknown[] = [];
    if (q) { clauses.push('(domain LIKE ? OR niche LIKE ? OR subniche LIKE ? OR note LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (niche) { clauses.push('niche = ?'); params.push(niche); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.join(' AND ');
    const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM sites WHERE ${where}`).bind(...params).first()) as { n: number };
    const rows = (await env.DB.prepare(`
      SELECT id, domain, niche, subniche, cite_score, traffic_band, seller_price, markup, listed_price,
             link_attribute, max_links_per_post, turnaround_sla_days, status, contact_email, note
      FROM sites WHERE ${where}
      ORDER BY cite_score DESC LIMIT ? OFFSET ?
    `).bind(...params, per, (page - 1) * per).all()).results as Row[];
    for (const r of rows) {
      r.margin = r.listed_price != null && r.seller_price != null
        ? Math.round(((r.listed_price as number) - (r.seller_price as number)) * 100) / 100 : null;
    }
    return json({ total: total.n, page, per_page: per, sites: rows });
  }

  const patchMatch = path.match(/^\/admin\/api\/sites\/(cs_[a-z0-9]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const id = patchMatch[1];
    const body = (await req.json()) as Row;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const field of EDITABLE) {
      if (!(field in body)) continue;
      const v = body[field];
      if (field === 'status' && !STATUSES.includes(v as string)) return json({ error: 'BAD_STATUS', allowed: STATUSES }, 400);
      if (field === 'link_attribute' && !LINK_ATTRS.includes(v as string)) return json({ error: 'BAD_LINK_ATTRIBUTE', allowed: LINK_ATTRS }, 400);
      if ((field === 'seller_price' || field === 'markup') && v !== null && (typeof v !== 'number' || v < 0)) {
        return json({ error: 'BAD_NUMBER', field }, 400);
      }
      sets.push(`${field} = ?`);
      params.push(v ?? null);
    }
    if (!sets.length) return json({ error: 'NO_EDITABLE_FIELDS', editable: EDITABLE }, 400);
    await env.DB.prepare(`UPDATE sites SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .bind(...params, id).run();
    // recompute listed_price from current seller_price × markup
    await env.DB.prepare(`
      UPDATE sites SET listed_price = CASE WHEN seller_price > 0 THEN CAST(((seller_price * markup) + 4.9999) / 5 AS INT) * 5 ELSE listed_price END
      WHERE id = ?
    `).bind(id).run();
    const row = await env.DB.prepare(`SELECT * FROM sites WHERE id = ?`).bind(id).first();
    if (!row) return json({ error: 'SITE_NOT_FOUND', id }, 404);
    return json({ ok: true, site: row });
  }

  if (path === '/admin/api/sites' && req.method === 'POST') {
    const b = (await req.json()) as Row;
    if (!b.domain || typeof b.domain !== 'string' || !b.domain.includes('.')) return json({ error: 'DOMAIN_REQUIRED' }, 400);
    const domain = b.domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const id = `cs_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const seller = typeof b.seller_price === 'number' ? b.seller_price : null;
    const markup = typeof b.markup === 'number' ? b.markup : 1.6;
    await env.DB.prepare(`
      INSERT INTO sites (id, domain, niche, subniche, contact_name, contact_email, note,
                         seller_price, markup, listed_price, link_attribute, status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',datetime('now'))
    `).bind(
      id, domain, b.niche ?? null, b.subniche ?? null, b.contact_name ?? null, b.contact_email ?? null,
      b.note ?? null, seller, markup, seller && seller > 0 ? listedPrice(seller, markup) : null,
      LINK_ATTRS.includes(b.link_attribute as string) ? b.link_attribute : 'unknown',
    ).run();
    return json({ ok: true, id, domain }, 201);
  }

  return json({ error: 'NOT_FOUND', path }, 404);
}

// ---------- router ----------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/mcp') return handleMcp(req, env);
    if (url.pathname === '/health') {
      const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM sites`).first()) as { n: number };
      return json({ ok: true, sites: n.n });
    }
    if (url.pathname === '/admin') {
      return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname.startsWith('/admin/api/')) return handleAdminApi(req, env, url.pathname);
    if (url.pathname === '/') {
      return new Response(
        `Cite v0 — agent-native link placement inventory (free read tier)\n\n` +
        `MCP endpoint (Streamable HTTP): POST ${url.origin}/mcp\n` +
        `Connect from Claude Code:  claude mcp add --transport http cite ${url.origin}/mcp\n\n` +
        `Tools: search_sites, get_site, estimate, inventory_stats\n` +
        `Handles are anonymized — domains are revealed only at delivery.\n`,
        { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } },
      );
    }
    // Unknown paths (incl. /.well-known/oauth-*) must 404 cleanly — a 200 here
    // makes MCP clients attempt OAuth registration against a non-existent IdP.
    return json({ error: 'NOT_FOUND', path: url.pathname }, 404);
  },
};

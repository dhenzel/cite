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
import { ADMIN_HTML, signInPage } from './admin-ui.js';
import { buildAuthUrl, handleCallback, describeOidcFailure, diagnostics, OidcNotConfigured, OidcError } from './oidc.js';
import {
  readSession, createSession, destroySession, upsertUser, isAdmin,
  clearCookieHeader, markEngineUnauthorized, type Session,
} from './session.js';
import {
  probe, cachedCall, listTools, pickTool,
  EngineUnauthorized, EngineScopeDenied, EngineUnavailable,
} from './engine.js';

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  // Shortlist Context Engine SSO (SPEC §18)
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;   // secret — never in wrangler.toml
  OIDC_REDIRECT_URI?: string;
  ENGINE_MCP_URL?: string;
  SESSION_SECRET?: string;       // secret — signs session cookies
  CITE_ADMIN_ABILITY?: string;   // default '*:read'
  CITE_ADMIN_EMAILS?: string;    // comma-separated allowlist override
}

const MAX_RESULTS = 50;       // with an account key
const ANON_MAX_RESULTS = 10;  // anonymous — register_account raises this
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
// Metrics disclosure ladder (SPEC §5, revised 2026-08-17):
//   exact Ahrefs DR — permitted by Ahrefs' API rules when shown to the end user,
//   attributed, and not renamed. Measured fingerprinting risk: DR + niche
//   identifies 2.9% of the catalog. Adding exact DA/TF/CF takes that to 93.6%,
//   so those ship as BANDS only. Exact DA/TF/CF/traffic never leave the console.
type Row = Record<string, unknown>;

const band10 = (v: unknown, label: string): string | undefined => {
  const n = typeof v === 'number' ? v : null;
  if (n === null) return undefined;
  const lo = Math.floor(n / 10) * 10;
  return `${label} ${lo}–${lo + 9}`;
};
const trustBand = (tf: unknown, cf: unknown): string | undefined => {
  if (typeof tf !== 'number' || typeof cf !== 'number' || cf <= 0) return undefined;
  const ratio = tf / cf;
  if (ratio >= 0.8) return 'strong';
  if (ratio >= 0.5) return 'healthy';
  if (ratio >= 0.3) return 'weak';
  return 'poor';
};
const scoreComponents = (r: Row) => ({
  authority: typeof r.dr === 'number' ? Math.round(r.dr) : undefined,
  traffic: typeof r.traffic === 'number' ? Math.min(100, Math.round(20 * Math.log10(r.traffic + 1))) : undefined,
  trust: trustBand(r.tf, r.cf),
  spam_flag: typeof r.spam === 'number' && r.spam > 0 ? true : false,
});

const FREE_MODE_NOTES: Record<string, string> = {
  self_serve: 'Free, self-serve: an account can be created and the post published directly — no publisher outreach needed.',
  apply_editorial: 'Free, but by editorial application: a pitch is submitted and acceptance is not guaranteed.',
  link_exchange: 'Requires a reciprocal link from your own site. Excluded from search by default.',
  unavailable: 'Not currently accepting placements.',
};

const pub = (r: Row, detail = false) => {
  const base: Row = {
    site_id: r.id,
    cite_score: r.cite_score,
    niche: r.niche,
    subniche: r.subniche || undefined,
    // Ahrefs requires the metric keep its name and carry attribution.
    ahrefs_domain_rating: r.dr ?? undefined,
    da_band: band10(r.da, 'DA'),
    trust_ratio: trustBand(r.tf, r.cf),
    traffic_band: r.traffic_band,
    listed_price: r.listed_price,
    cost_type: r.cost_type ?? 'paid',
    acquisition_mode: r.acquisition_mode ?? 'paid_placement',
    link_attribute: r.link_attribute ?? 'unknown',
    writes_about: r.writes_about ? JSON.parse(r.writes_about as string) : undefined,
  };
  if (!detail) return base;
  return {
    ...base,
    score_components: scoreComponents(r),
    tiers: { standard: !!r.tier_standard, premium: !!r.tier_premium, platinum: !!r.tier_platinum },
    max_links_per_post: r.max_links_per_post ?? 'unknown',
    turnaround_sla_days: r.turnaround_sla_days ?? 'unknown',
    requires_reciprocal_link: !!r.requires_reciprocal_link,
    how_this_works: FREE_MODE_NOTES[(r.acquisition_mode as string) ?? ''] ?? 'Paid placement fulfilled by Cite.',
    agent_instructions: r.agent_instructions ?? undefined,
    content_summary: r.summary ?? undefined,
    recent_post_titles: r.recent_titles ? JSON.parse(r.recent_titles as string) : undefined,
    metrics_attribution: 'Domain Rating (DR) via Ahrefs. DA shown as a band; traffic as a band. Exact vendor values are not redistributed.',
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
        cost_type: { type: 'string', enum: ['paid', 'free'], description: 'free = no placement cost. Free inventory needs no card — the way to try Cite.' },
        acquisition_mode: {
          type: 'string',
          enum: ['paid_placement', 'self_serve', 'apply_editorial'],
          description: 'self_serve = an agent can register and publish itself; apply_editorial = free but requires an accepted pitch',
        },
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
    description: 'Aggregate view of Cite inventory: counts by niche, Cite Score band, and free vs paid. No site identities.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'register_account',
    description: 'Create a Cite account and get an API key. Free — takes an email, no card. Raises your result and quota limits and lets you claim free placements. Pass the key as "Authorization: Bearer <key>" on later calls.',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'Contact email for the account' } },
      required: ['email'],
    },
  },
  {
    name: 'account_status',
    description: 'Your account tier, quota used and remaining, and how to upgrade for paid placements.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'claim_free_placement',
    description: 'Claim a free placement on a free site (cost_type=free). Requires an account (register_account). Returns the agent playbook for that site; for self_serve sites the domain is released so you can publish there yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        target_url: { type: 'string', description: 'The URL you want cited' },
        anchor_text: { type: 'string' },
      },
      required: ['site_id', 'target_url'],
    },
  },
];

const topicClause = (n: number) =>
  Array.from({ length: n }, () => '(s.niche LIKE ? OR s.subniche LIKE ? OR c.writes_about LIKE ?)').join(' OR ');
const topicParams = (topics: string[]) => topics.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);

export interface Account {
  api_key: string;
  email: string;
  tier: string;
  quota: number;
  orders_used: number;
}

async function runTool(env: Env, name: string, args: Row, account: Account | null, maxResults: number): Promise<unknown> {
  switch (name) {
    case 'search_sites': {
      const topics = (args.topics as string[] | undefined) ?? [];
      // link_exchange (reciprocal-link obligation) and unavailable are never
      // returned — an agent buying blind cannot honour a link-back deal.
      const clauses = [
        "s.status='active'",
        's.listed_price IS NOT NULL',
        "COALESCE(s.acquisition_mode,'paid_placement') NOT IN ('link_exchange','unavailable')",
      ];
      const params: unknown[] = [];
      if (args.cost_type) { clauses.push('COALESCE(s.cost_type,?) = ?'); params.push('paid', args.cost_type); }
      if (args.acquisition_mode) { clauses.push("COALESCE(s.acquisition_mode,'paid_placement') = ?"); params.push(args.acquisition_mode); }
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
      const limit = Math.min((args.limit as number | undefined) ?? 20, maxResults);
      const rows = (await env.DB.prepare(`
        SELECT s.*, c.summary, c.writes_about, c.recent_titles
        FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY s.cite_score DESC, s.listed_price ASC LIMIT ?
      `).bind(...params, limit).all()).results as Row[];
      return {
        result_count: rows.length,
        note: 'Handles are anonymized. Domains are revealed only at delivery; buy on cite_score, Ahrefs DR, topics, traffic_band and price — backed by the live-and-indexed-at-T+30-or-refund guarantee.',
        free_inventory_hint: account
          ? undefined
          : 'Free placements (cost_type="free") need no card. register_account with an email to claim them and to raise result limits.',
        result_limit: maxResults,
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
      const byCost = (await env.DB.prepare(`
        SELECT COALESCE(cost_type,'paid') AS cost_type,
               COALESCE(acquisition_mode,'paid_placement') AS acquisition_mode,
               COUNT(*) AS sites
        FROM sites WHERE status='active'
        GROUP BY 1,2 ORDER BY sites DESC
      `).all()).results;
      return {
        purchasable_sites: total.n,
        by_niche: byNiche,
        by_score_band: byBand,
        by_cost_and_mode: byCost,
        note: 'free + self_serve inventory needs no card: register_account and claim_free_placement.',
      };
    }

    case 'register_account': {
      const email = String(args.email ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
        return { error: 'INVALID_EMAIL', message: 'Provide a valid contact email.' };
      }
      const existing = (await env.DB.prepare('SELECT api_key, tier, quota, orders_used FROM accounts WHERE email = ?')
        .bind(email).first()) as Row | null;
      if (existing) {
        return {
          api_key: existing.api_key,
          email,
          tier: existing.tier,
          quota: existing.quota,
          orders_used: existing.orders_used,
          note: 'An account already exists for this email; returning its key.',
        };
      }
      const key = `ck_${crypto.randomUUID().replace(/-/g, '')}`;
      await env.DB.prepare(`
        INSERT INTO accounts (api_key, email, tier, created_at, orders_used, quota)
        VALUES (?, ?, 'free', datetime('now'), 0, 10)
      `).bind(key, email).run();
      return {
        api_key: key,
        email,
        tier: 'free',
        quota: 10,
        how_to_use: 'Send this key as the HTTP header: Authorization: Bearer <api_key>',
        what_you_get: [
          'Up to 50 results per search (anonymous is capped at 10)',
          '10 free placements on cost_type="free" inventory via claim_free_placement',
          'Paid placements require adding a card (Stripe) — coming with the funded tier',
        ],
      };
    }

    case 'account_status': {
      if (!account) {
        return {
          tier: 'anonymous',
          result_limit: maxResults,
          note: 'No account. register_account({email}) is free and instant — raises limits and unlocks free placements.',
        };
      }
      return {
        tier: account.tier,
        email: account.email,
        free_placements_used: account.orders_used,
        free_placements_remaining: Math.max(0, account.quota - account.orders_used),
        result_limit: maxResults,
        upgrade: 'Paid placements need a card on file (Stripe). Not enabled in this release.',
      };
    }

    case 'claim_free_placement': {
      if (!account) {
        return { error: 'ACCOUNT_REQUIRED', message: 'Call register_account({email}) first, then send Authorization: Bearer <api_key>.' };
      }
      if (account.orders_used >= account.quota) {
        return { error: 'QUOTA_EXCEEDED', quota: account.quota, message: 'Free placement quota used up. Paid placements require a card (not enabled in this release).' };
      }
      const site = (await env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(args.site_id).first()) as Row | null;
      if (!site) return { error: 'SITE_NOT_FOUND', site_id: args.site_id };
      if ((site.cost_type ?? 'paid') !== 'free') {
        return { error: 'NOT_FREE_INVENTORY', site_id: args.site_id, message: 'This site is a paid placement. Free claims only apply to cost_type="free".' };
      }
      if (site.acquisition_mode === 'link_exchange' || site.acquisition_mode === 'unavailable') {
        return { error: 'SITE_UNAVAILABLE', acquisition_mode: site.acquisition_mode };
      }
      await env.DB.prepare(`
        INSERT INTO free_orders (site_id, api_key, target_url, anchor_text, state, created_at)
        VALUES (?, ?, ?, ?, 'claimed', datetime('now'))
      `).bind(site.id, account.api_key, args.target_url, args.anchor_text ?? null).run();
      await env.DB.prepare('UPDATE accounts SET orders_used = orders_used + 1 WHERE api_key = ?')
        .bind(account.api_key).run();
      const selfServe = site.acquisition_mode === 'self_serve';
      return {
        claimed: true,
        site_id: site.id,
        acquisition_mode: site.acquisition_mode,
        // Self-serve is the one case where the domain is released up front: the
        // agent does the publishing itself, so withholding it would make the
        // placement impossible. Everything else stays blind until delivery.
        domain: selfServe ? site.domain : undefined,
        link_attribute: site.link_attribute,
        max_links_per_post: site.max_links_per_post ?? 'unknown',
        agent_instructions: site.agent_instructions ?? undefined,
        next_step: selfServe
          ? 'Publish there yourself following agent_instructions, then Cite verifies the link is live at T+7/T+30.'
          : 'Cite submits the editorial application on your behalf. Acceptance is not guaranteed; you will be notified either way.',
        free_placements_remaining: Math.max(0, account.quota - account.orders_used - 1),
      };
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
    // Optional account key: anonymous callers get a tighter result cap, account
    // holders get the full free tier (SPEC §17).
    const key = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
    let account: Account | null = null;
    if (key.startsWith('ck_')) {
      account = (await env.DB.prepare(
        'SELECT api_key, email, tier, quota, orders_used FROM accounts WHERE api_key = ?',
      ).bind(key).first()) as Account | null;
    }
    const maxResults = account ? MAX_RESULTS : ANON_MAX_RESULTS;
    const toolName = params?.name as string;
    const toolArgs = (params?.arguments as Row) ?? {};
    const payload = await runTool(env, toolName, toolArgs, account, maxResults);

    // Query log = the demand instrument (SPEC §15: query volume is the signal
    // that decides whether the money path gets built).
    try {
      const count = (payload as Row)?.result_count;
      await env.DB.prepare(`
        INSERT INTO query_log (api_key, tool, args, result_count, at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).bind(account?.api_key ?? null, toolName, JSON.stringify(toolArgs).slice(0, 1000),
        typeof count === 'number' ? count : null).run();
    } catch { /* logging must never break a response */ }

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
  'turnaround_sla_days', 'niche', 'subniche', 'note', 'contact_name', 'contact_email',
  'acquisition_mode', 'cost_type', 'requires_reciprocal_link', 'agent_instructions'] as const;
const ACQUISITION_MODES = ['paid_placement', 'self_serve', 'apply_editorial', 'link_exchange', 'unavailable'];


// Analytics shared by /admin/api/analytics (console) and the admin_analytics
// MCP tool, so both surfaces report identical numbers.
async function computeAnalytics(env: Env): Promise<Row> {
  const one = async <T>(sql: string): Promise<T> => (await env.DB.prepare(sql).first()) as T;
    const many = async (sql: string) => (await env.DB.prepare(sql).all()).results;

    const accounts = await one<Row>(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN created_at >= datetime('now','-7 day') THEN 1 ELSE 0 END) AS new_7d,
             SUM(CASE WHEN created_at >= datetime('now','-30 day') THEN 1 ELSE 0 END) AS new_30d,
             SUM(orders_used) AS free_placements_claimed
      FROM accounts
    `);
    const activity = await one<Row>(`
      SELECT COUNT(*) AS queries_total,
             SUM(CASE WHEN at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS queries_24h,
             SUM(CASE WHEN at >= datetime('now','-7 day') THEN 1 ELSE 0 END) AS queries_7d,
             COUNT(DISTINCT api_key) AS identified_agents,
             SUM(CASE WHEN api_key IS NULL THEN 1 ELSE 0 END) AS anonymous_queries
      FROM query_log
    `);
    const byTool = await many(`
      SELECT tool, COUNT(*) AS calls,
             SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS zero_result_calls
      FROM query_log GROUP BY tool ORDER BY calls DESC
    `);
    const daily = await many(`
      SELECT substr(at,1,10) AS day, COUNT(*) AS queries,
             COUNT(DISTINCT COALESCE(api_key,'anon')) AS agents
      FROM query_log WHERE at >= datetime('now','-14 day')
      GROUP BY day ORDER BY day DESC
    `);
    const signups = await many(`
      SELECT email, tier, created_at, orders_used, quota FROM accounts
      ORDER BY created_at DESC LIMIT 50
    `);
    // Unmet demand: searches that returned nothing. Each one is a gap in
    // inventory an agent actually wanted.
    const unmet = await many(`
      SELECT args, COUNT(*) AS times FROM query_log
      WHERE tool = 'search_sites' AND result_count = 0
      GROUP BY args ORDER BY times DESC LIMIT 25
    `);
    const recentArgs = await many(`
      SELECT args FROM query_log WHERE tool = 'search_sites' AND args IS NOT NULL
      ORDER BY id DESC LIMIT 500
    `);
    // Topic frequency has to be computed in JS — args is JSON.
    const topicCounts = new Map<string, number>();
    for (const r of recentArgs as { args: string }[]) {
      try {
        const a = JSON.parse(r.args) as { topics?: string[]; text?: string };
        for (const t of a.topics ?? []) topicCounts.set(t.toLowerCase(), (topicCounts.get(t.toLowerCase()) ?? 0) + 1);
        if (a.text) topicCounts.set(a.text.toLowerCase(), (topicCounts.get(a.text.toLowerCase()) ?? 0) + 1);
      } catch { /* skip malformed */ }
    }
    const topTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([topic, times]) => ({ topic, times }));
    const freeOrders = await many(`
      SELECT f.site_id, s.domain, s.acquisition_mode, COUNT(*) AS claims
      FROM free_orders f LEFT JOIN sites s ON s.id = f.site_id
      GROUP BY f.site_id ORDER BY claims DESC LIMIT 20
    `);
    const readiness = await one<Row>(`
      SELECT SUM(CASE WHEN link_attribute='unknown' OR link_attribute IS NULL THEN 1 ELSE 0 END) AS link_attr_unknown,
             SUM(CASE WHEN seller_price IS NULL THEN 1 ELSE 0 END) AS unpriced,
             SUM(CASE WHEN COALESCE(cost_type,'paid')='free' THEN 1 ELSE 0 END) AS free_sites,
             COUNT(*) AS total_sites
      FROM sites
    `);
    return {
      accounts, activity, by_tool: byTool, daily, signups,
      unmet_demand: unmet, top_topics: topTopics,
      free_placements_by_site: freeOrders, inventory_readiness: readiness,
      funnel: {
        anonymous_queries: activity.anonymous_queries ?? 0,
        signups: accounts.total ?? 0,
        free_placements_claimed: accounts.free_placements_claimed ?? 0,
        paid_customers: 0,
        note: 'Paid tier not enabled yet — funnel ends at free placements.',
      },
    };
}

async function handleAdminApi(req: Request, env: Env, path: string): Promise<Response> {
  // Either an SSO session (humans, via the console) or the ADMIN_TOKEN
  // (scripts and the admin MCP).
  if (!authorized(req, env)) {
    const session = await readSession(req, env);
    if (!session?.is_admin) return json({ error: 'UNAUTHORIZED', sign_in: '/auth/login' }, 401);
  }

  // Analytics: who signed up, how many agents are active, what they ask for,
  // and what we could not answer. The zero-result and top-topic views are the
  // demand signal the whole free tier exists to collect (SPEC §15).
  if (path === '/admin/api/analytics' && req.method === 'GET') {
    return json(await computeAnalytics(env));
  }

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
    const costType = u.searchParams.get('cost_type');
    const mode = u.searchParams.get('acquisition_mode');
    const page = Math.max(1, parseInt(u.searchParams.get('page') ?? '1', 10));
    const per = 50;
    const clauses: string[] = ['1=1'];
    const params: unknown[] = [];
    if (q) { clauses.push('(domain LIKE ? OR niche LIKE ? OR subniche LIKE ? OR note LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (niche) { clauses.push('niche = ?'); params.push(niche); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (costType) { clauses.push("COALESCE(cost_type,'paid') = ?"); params.push(costType); }
    if (mode) { clauses.push("COALESCE(acquisition_mode,'paid_placement') = ?"); params.push(mode); }
    const where = clauses.join(' AND ');
    const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM sites WHERE ${where}`).bind(...params).first()) as { n: number };
    const rows = (await env.DB.prepare(`
      SELECT id, domain, niche, subniche, cite_score, traffic_band, seller_price, markup, listed_price,
             link_attribute, max_links_per_post, turnaround_sla_days, status, contact_email, note,
             dr, da, tf, cf, traffic, COALESCE(cost_type,'paid') AS cost_type,
             COALESCE(acquisition_mode,'paid_placement') AS acquisition_mode,
             requires_reciprocal_link, agent_instructions
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
      if (field === 'acquisition_mode' && !ACQUISITION_MODES.includes(v as string)) return json({ error: 'BAD_ACQUISITION_MODE', allowed: ACQUISITION_MODES }, 400);
      if (field === 'cost_type' && !['paid', 'free'].includes(v as string)) return json({ error: 'BAD_COST_TYPE', allowed: ['paid', 'free'] }, 400);
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

// ---------- auth routes (SPEC §18) ----------
async function handleAuth(req: Request, env: Env, path: string): Promise<Response> {
  if (path === '/auth/login') {
    try {
      const url = new URL(req.url);
      const back = url.searchParams.get('next') || '/admin';
      return Response.redirect(await buildAuthUrl(env, back.startsWith('/') ? back : '/admin'), 302);
    } catch (e) {
      if (e instanceof OidcNotConfigured) {
        return html(signInPage({ error: e.message, configured: false }), 503);
      }
      return html(signInPage({ error: (e as Error).message, configured: true }), 502);
    }
  }

  if (path === '/auth/callback') {
    try {
      const result = await handleCallback(env, new URL(req.url));

      // Ask the engine what this token can actually do before deciding
      // anything — requested scopes are not granted scopes.
      let abilities: string[] = [];
      let engineDown = false;
      try {
        const p = await probe(env, result.accessToken);
        abilities = p.abilities ?? [];
      } catch (e) {
        if (e instanceof EngineUnauthorized) throw new OidcError('The engine rejected the new token.');
        engineDown = true; // sign-in still succeeds; panels degrade
      }

      const admin = isAdmin(env, result.email, abilities);
      await upsertUser(env, result, abilities);

      if (!admin && !engineDown) {
        return html(signInPage({
          error: 'Your Shortlist engine account does not have the access this console requires. '
            + `It reports: ${abilities.length ? abilities.join(', ') : 'no abilities'}. `
            + 'Ask David to add you.',
          configured: true,
        }), 403);
      }

      const cookie = await createSession(env, result, result.accessToken,
        result.accessExpiresInSeconds, abilities, admin || engineDown);
      return new Response(null, {
        status: 302,
        headers: { location: result.redirectTo, 'set-cookie': cookie },
      });
    } catch (e) {
      return html(signInPage({
        error: describeOidcFailure(e),
        configured: !(e instanceof OidcNotConfigured),
      }), 400);
    }
  }

  // Operator-only: what the engine advertises + a fingerprint of the secret
  // we hold, so a failing sign-in can be diagnosed without printing secrets.
  if (path === '/auth/debug') {
    if (!authorized(req, env)) return json({ error: 'UNAUTHORIZED', message: 'Send Authorization: Bearer <ADMIN_TOKEN>' }, 401);
    return json(await diagnostics(env));
  }

  if (path === '/auth/logout') {
    const s = await readSession(req, env);
    if (s) await destroySession(env, s.id);
    return new Response(null, { status: 302, headers: { location: '/admin', 'set-cookie': clearCookieHeader() } });
  }

  return json({ error: 'NOT_FOUND', path }, 404);
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

// ---------- engine data panels (SPEC §18) ----------
// Each panel resolves its tool from tools/list and degrades on its own: a role
// that cannot read signals still gets the rest of the page.
async function handleEngineApi(req: Request, env: Env, path: string, session: Session): Promise<Response> {
  if (!session.access_token) {
    return json({ error: 'NO_ENGINE_TOKEN', message: 'Sign in with Shortlist to load engine data.' }, 401);
  }
  const url = new URL(req.url);
  const degrade = (e: unknown) => {
    if (e instanceof EngineUnauthorized) {
      // Do not show an empty dashboard — say the session needs renewing.
      return json({ error: 'ENGINE_UNAUTHORIZED', message: 'Your Shortlist session expired. Sign in again.', sign_in: '/auth/login' }, 401);
    }
    if (e instanceof EngineScopeDenied) {
      return json({ error: 'SCOPE_DENIED', message: 'Your engine role does not include this.', detail: (e as Error).message }, 200);
    }
    return json({ error: 'ENGINE_UNAVAILABLE', message: (e as Error).message }, 200);
  };

  try {
    if (path === '/admin/api/engine/me') {
      const p = await probe(env, session.access_token);
      const tools = await listTools(env, session.access_token, session.sub).catch(() => []);
      return json({
        engine: p.engine ?? null,
        abilities: p.abilities ?? session.abilities,
        console: p.console ?? null,
        user: { sub: session.sub, email: session.email, name: session.name },
        panels: {
          search: pickTool(tools, ['search-tool']),
          recent: pickTool(tools, ['recent-tool']),
          signals: pickTool(tools, ['signals-tool']),
        },
        tool_count: tools.length,
      });
    }

    if (path === '/admin/api/engine/recent') {
      const tools = await listTools(env, session.access_token, session.sub);
      const tool = pickTool(tools, ['recent-tool']);
      if (!tool) return json({ error: 'TOOL_UNAVAILABLE', message: 'This engine has no recent-tool.' }, 200);
      const data = await cachedCall(env, session.access_token, session.sub, tool, { limit: 12 });
      return json({ tool, data });
    }

    if (path === '/admin/api/engine/signals') {
      const tools = await listTools(env, session.access_token, session.sub);
      const tool = pickTool(tools, ['signals-tool']);
      if (!tool) return json({ error: 'TOOL_UNAVAILABLE', message: 'This engine has no signals-tool.' }, 200);
      const data = await cachedCall(env, session.access_token, session.sub, tool, { limit: 10 });
      return json({ tool, data });
    }

    if (path === '/admin/api/engine/search') {
      const q = url.searchParams.get('q');
      if (!q) return json({ error: 'QUERY_REQUIRED' }, 400);
      const tools = await listTools(env, session.access_token, session.sub);
      const tool = pickTool(tools, ['search-tool']);
      if (!tool) return json({ error: 'TOOL_UNAVAILABLE', message: 'This engine has no search-tool.' }, 200);
      const data = await cachedCall(env, session.access_token, session.sub, tool, { query: q, limit: 8 });
      return json({ tool, query: q, data });
    }
  } catch (e) {
    if (e instanceof EngineUnauthorized) await markEngineUnauthorized(env, session.id);
    return degrade(e);
  }
  return json({ error: 'NOT_FOUND', path }, 404);
}

// ---------- admin MCP (SPEC §16) ----------
// The operator console as MCP tools, so the team can run the back office from
// an agent: bulk-fix pricing, backfill link attributes, push refreshed metrics.
// Guarded by the same ADMIN_TOKEN as /admin — never listed publicly.
const adminTools = [
  {
    name: 'admin_search_sites',
    description: 'Search inventory with FULL private fields — domain, contacts, seller price, markup, listed price, margin. Operator-only.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Matches domain, niche, subniche or note' },
        niche: { type: 'string' },
        status: { type: 'string', enum: STATUSES },
        cost_type: { type: 'string', enum: ['paid', 'free'] },
        acquisition_mode: { type: 'string', enum: ACQUISITION_MODES },
        link_attribute: { type: 'string', enum: LINK_ATTRS },
        min_score: { type: 'number' }, max_score: { type: 'number' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: 'admin_update_site',
    description: 'Update one site. Editable: seller_price, markup, status, link_attribute, max_links_per_post, turnaround_sla_days, niche, subniche, note, contact_name, contact_email, acquisition_mode, cost_type, agent_instructions. listed_price recomputes automatically from seller_price × markup.',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        domain: { type: 'string', description: 'Alternative to site_id' },
        fields: { type: 'object', description: 'Field/value pairs to set' },
      },
      required: ['fields'],
    },
  },
  {
    name: 'admin_bulk_update',
    description: 'Apply the same field values to every site matching a filter — the fast way to backfill link attributes or re-price a niche. ALWAYS returns a preview count first unless confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description: 'Any of: niche, status, cost_type, acquisition_mode, link_attribute, min_score, max_score, max_seller_price, min_seller_price',
        },
        set: { type: 'object', description: 'Field/value pairs to apply' },
        confirm: { type: 'boolean', description: 'false/omitted = dry run returning the affected count' },
      },
      required: ['filter', 'set'],
    },
  },
  {
    name: 'admin_update_metrics',
    description: 'Push refreshed SEO metrics for a site (dr, da, tf, cf, traffic, spam) and recompute its Cite Score and traffic band. Use after an Ahrefs/Moz refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' }, domain: { type: 'string' },
        dr: { type: 'number' }, da: { type: 'number' }, tf: { type: 'number' },
        cf: { type: 'number' }, traffic: { type: 'number' }, spam: { type: 'number' },
      },
    },
  },
  {
    name: 'admin_add_site',
    description: 'Add a new site to inventory. Mints the anonymized handle server-side.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' }, niche: { type: 'string' }, subniche: { type: 'string' },
        seller_price: { type: 'number' }, markup: { type: 'number' },
        contact_email: { type: 'string' }, contact_name: { type: 'string' },
        link_attribute: { type: 'string', enum: LINK_ATTRS },
        acquisition_mode: { type: 'string', enum: ACQUISITION_MODES },
        note: { type: 'string' }, agent_instructions: { type: 'string' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'admin_analytics',
    description: 'Signups, active agents, query volume, top searched topics, unmet demand (searches returning nothing), free placements claimed, and inventory readiness.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const RECOMPUTE_PRICE = `UPDATE sites SET listed_price = CASE WHEN seller_price > 0 THEN CAST(((seller_price * markup) + 4.9999) / 5 AS INT) * 5 WHEN seller_price = 0 THEN 0 ELSE listed_price END WHERE id = ?`;

function buildFilter(f: Row): { where: string; params: unknown[] } {
  const clauses = ['1=1'];
  const params: unknown[] = [];
  const eq = (col: string, key: string) => {
    if (f[key] !== undefined && f[key] !== null) { clauses.push(`${col} = ?`); params.push(f[key]); }
  };
  eq('niche', 'niche'); eq('status', 'status');
  eq("COALESCE(cost_type,'paid')", 'cost_type');
  eq("COALESCE(acquisition_mode,'paid_placement')", 'acquisition_mode');
  eq('link_attribute', 'link_attribute');
  if (f.q) { clauses.push('(domain LIKE ? OR niche LIKE ? OR subniche LIKE ? OR note LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  if (typeof f.min_score === 'number') { clauses.push('cite_score >= ?'); params.push(f.min_score); }
  if (typeof f.max_score === 'number') { clauses.push('cite_score <= ?'); params.push(f.max_score); }
  if (typeof f.min_seller_price === 'number') { clauses.push('seller_price >= ?'); params.push(f.min_seller_price); }
  if (typeof f.max_seller_price === 'number') { clauses.push('seller_price <= ?'); params.push(f.max_seller_price); }
  return { where: clauses.join(' AND '), params };
}

function validateSet(set: Row): string | null {
  for (const [k, v] of Object.entries(set)) {
    if (!(EDITABLE as readonly string[]).includes(k)) return `Field not editable: ${k}. Editable: ${EDITABLE.join(', ')}`;
    if (k === 'status' && !STATUSES.includes(v as string)) return `Bad status. Allowed: ${STATUSES.join(', ')}`;
    if (k === 'link_attribute' && !LINK_ATTRS.includes(v as string)) return `Bad link_attribute. Allowed: ${LINK_ATTRS.join(', ')}`;
    if (k === 'acquisition_mode' && !ACQUISITION_MODES.includes(v as string)) return `Bad acquisition_mode. Allowed: ${ACQUISITION_MODES.join(', ')}`;
    if (k === 'cost_type' && !['paid', 'free'].includes(v as string)) return 'Bad cost_type. Allowed: paid, free';
    if ((k === 'seller_price' || k === 'markup') && v !== null && (typeof v !== 'number' || v < 0)) return `${k} must be a non-negative number`;
  }
  return null;
}

async function resolveSite(env: Env, args: Row): Promise<Row | null> {
  if (args.site_id) return (await env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(args.site_id).first()) as Row | null;
  if (args.domain) {
    const d = String(args.domain).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return (await env.DB.prepare('SELECT * FROM sites WHERE domain = ?').bind(d).first()) as Row | null;
  }
  return null;
}

async function runAdminTool(env: Env, req: Request, name: string, args: Row): Promise<unknown> {
  switch (name) {
    case 'admin_search_sites': {
      const { where, params } = buildFilter(args);
      const limit = Math.min((args.limit as number | undefined) ?? 50, 200);
      const rows = (await env.DB.prepare(`
        SELECT id, domain, niche, subniche, cite_score, dr, da, tf, cf, traffic, traffic_band,
               seller_price, markup, listed_price, link_attribute, max_links_per_post,
               turnaround_sla_days, status, COALESCE(cost_type,'paid') AS cost_type,
               COALESCE(acquisition_mode,'paid_placement') AS acquisition_mode,
               contact_email, contact_name, note, agent_instructions
        FROM sites WHERE ${where} ORDER BY cite_score DESC LIMIT ?
      `).bind(...params, limit).all()).results as Row[];
      const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM sites WHERE ${where}`).bind(...params).first()) as { n: number };
      for (const r of rows) {
        r.margin = r.listed_price != null && r.seller_price != null
          ? Math.round(((r.listed_price as number) - (r.seller_price as number)) * 100) / 100 : null;
      }
      return { matched: total.n, returned: rows.length, sites: rows };
    }

    case 'admin_update_site': {
      const site = await resolveSite(env, args);
      if (!site) return { error: 'SITE_NOT_FOUND', hint: 'Pass site_id or domain.' };
      const set = (args.fields as Row) ?? {};
      const bad = validateSet(set);
      if (bad) return { error: 'INVALID_FIELDS', message: bad };
      const keys = Object.keys(set);
      if (!keys.length) return { error: 'NO_FIELDS' };
      await env.DB.prepare(
        `UPDATE sites SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ).bind(...keys.map((k) => set[k] ?? null), site.id).run();
      await env.DB.prepare(RECOMPUTE_PRICE).bind(site.id).run();
      const after = (await env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(site.id).first()) as Row;
      return {
        updated: true, site_id: site.id, domain: after.domain, changed: keys,
        seller_price: after.seller_price, markup: after.markup, listed_price: after.listed_price,
        margin: after.listed_price != null && after.seller_price != null
          ? Math.round(((after.listed_price as number) - (after.seller_price as number)) * 100) / 100 : null,
      };
    }

    case 'admin_bulk_update': {
      const set = (args.set as Row) ?? {};
      const bad = validateSet(set);
      if (bad) return { error: 'INVALID_FIELDS', message: bad };
      const keys = Object.keys(set);
      if (!keys.length) return { error: 'NO_FIELDS' };
      const { where, params } = buildFilter((args.filter as Row) ?? {});
      const count = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM sites WHERE ${where}`).bind(...params).first()) as { n: number };
      if (!args.confirm) {
        const sample = (await env.DB.prepare(
          `SELECT domain, niche, cite_score, seller_price, markup, listed_price, link_attribute FROM sites WHERE ${where} ORDER BY cite_score DESC LIMIT 5`,
        ).bind(...params).all()).results;
        return {
          dry_run: true, would_affect: count.n, set, sample,
          next_step: 'Re-run with confirm: true to apply.',
        };
      }
      await env.DB.prepare(
        `UPDATE sites SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE ${where}`,
      ).bind(...keys.map((k) => set[k] ?? null), ...params).run();
      // Recompute listed_price wherever pricing inputs could have moved.
      if (keys.includes('seller_price') || keys.includes('markup')) {
        await env.DB.prepare(`
          UPDATE sites SET listed_price = CASE WHEN seller_price > 0 THEN CAST(((seller_price * markup) + 4.9999) / 5 AS INT) * 5
                                               WHEN seller_price = 0 THEN 0 ELSE listed_price END
          WHERE ${where}
        `).bind(...params).run();
      }
      return { updated: true, affected: count.n, set };
    }

    case 'admin_update_metrics': {
      const site = await resolveSite(env, args);
      if (!site) return { error: 'SITE_NOT_FOUND', hint: 'Pass site_id or domain.' };
      const m = {
        dr: typeof args.dr === 'number' ? args.dr : (site.dr as number | null),
        da: typeof args.da === 'number' ? args.da : (site.da as number | null),
        tf: typeof args.tf === 'number' ? args.tf : (site.tf as number | null),
        cf: typeof args.cf === 'number' ? args.cf : (site.cf as number | null),
        traffic: typeof args.traffic === 'number' ? args.traffic : (site.traffic as number | null),
        spam: typeof args.spam === 'number' ? args.spam : (site.spam as number | null),
      };
      const trafficPts = Math.min(100, 20 * Math.log10((m.traffic ?? 0) + 1));
      const ratio = m.cf && m.cf > 0 ? Math.min(1, (m.tf ?? 0) / m.cf) : 0;
      const score = Math.max(0, Math.min(100, Math.round(
        0.4 * (m.dr ?? 0) + 0.2 * (m.da ?? 0) + 0.3 * trafficPts + 0.1 * (100 * ratio) - 8 * (m.spam ?? 0),
      )));
      const t = m.traffic ?? 0;
      const band = t < 500 ? '<500/mo' : t < 1_000 ? '500–1k/mo' : t < 5_000 ? '1k–5k/mo'
        : t < 10_000 ? '5k–10k/mo' : t < 50_000 ? '10k–50k/mo' : t < 250_000 ? '50k–250k/mo' : '250k+/mo';
      await env.DB.prepare(`
        UPDATE sites SET dr=?, da=?, tf=?, cf=?, traffic=?, spam=?, traffic_band=?, cite_score=?,
                         metrics_updated_at=date('now'), updated_at=datetime('now')
        WHERE id = ?
      `).bind(m.dr, m.da, m.tf, m.cf, m.traffic, m.spam, band, score, site.id).run();
      return { updated: true, site_id: site.id, domain: site.domain, metrics: m, traffic_band: band, cite_score: score };
    }

    case 'admin_add_site': {
      const raw = String(args.domain ?? '');
      if (!raw.includes('.')) return { error: 'DOMAIN_REQUIRED' };
      const domain = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const exists = await env.DB.prepare('SELECT id FROM sites WHERE domain = ?').bind(domain).first();
      if (exists) return { error: 'DOMAIN_EXISTS', site_id: (exists as Row).id, domain };
      const id = `cs_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const seller = typeof args.seller_price === 'number' ? args.seller_price : null;
      const markup = typeof args.markup === 'number' ? args.markup : 1.6;
      const listed = seller === null ? null : seller > 0 ? listedPrice(seller, markup) : 0;
      await env.DB.prepare(`
        INSERT INTO sites (id, domain, niche, subniche, contact_name, contact_email, note,
                           seller_price, markup, listed_price, link_attribute, acquisition_mode,
                           cost_type, agent_instructions, status, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', datetime('now'))
      `).bind(
        id, domain, args.niche ?? null, args.subniche ?? null, args.contact_name ?? null,
        args.contact_email ?? null, args.note ?? null, seller, markup, listed,
        LINK_ATTRS.includes(args.link_attribute as string) ? args.link_attribute : 'unknown',
        ACQUISITION_MODES.includes(args.acquisition_mode as string) ? args.acquisition_mode : (seller === 0 ? 'apply_editorial' : 'paid_placement'),
        seller === 0 ? 'free' : 'paid', args.agent_instructions ?? null,
      ).run();
      return { added: true, site_id: id, domain, listed_price: listed };
    }

    case 'admin_analytics':
      return await computeAnalytics(env);

    default:
      return { error: 'UNKNOWN_TOOL', name };
  }
}

async function handleAdminMcp(req: Request, env: Env, tokenFromPath?: string): Promise<Response> {
  const ok = authorized(req, env) || (!!env.ADMIN_TOKEN && tokenFromPath === env.ADMIN_TOKEN);
  if (!ok) return json({ error: 'UNAUTHORIZED', message: 'Send Authorization: Bearer <ADMIN_TOKEN>' }, 401);
  if (req.method !== 'POST') return json({ error: 'POST JSON-RPC to this endpoint' }, 405);
  let body: { id?: unknown; method?: string; params?: Row };
  try { body = await req.json(); } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const { id, method, params } = body;
  if (method === 'initialize') {
    return json({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params?.protocolVersion as string) ?? '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'cite-admin', version: '0.2.0' },
      instructions: 'Cite operator console as tools. Full private data: domains, publisher contacts, seller prices, markup and margin. Bulk edits are dry-run by default — pass confirm:true to apply.',
    } });
  }
  if (method?.startsWith('notifications/')) return new Response(null, { status: 202, headers: CORS });
  if (method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools: adminTools } });
  if (method === 'tools/call') {
    const payload = await runAdminTool(env, req, params?.name as string, (params?.arguments as Row) ?? {});
    return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] } });
  }
  if (method === 'ping') return json({ jsonrpc: '2.0', id, result: {} });
  return json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } });
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
    if (url.pathname.startsWith('/auth/')) return handleAuth(req, env, url.pathname);

    if (url.pathname === '/admin') {
      // Humans sign in with Shortlist. The shared ADMIN_TOKEN is no longer a
      // way into the web console — it remains only for /admin/mcp, which an
      // agent cannot get through a browser flow.
      const session = await readSession(req, env);
      if (!session?.is_admin) {
        return new Response(signInPage({ configured: !!env.OIDC_CLIENT_ID && !!env.OIDC_CLIENT_SECRET }), {
          status: session ? 403 : 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname.startsWith('/admin/api/engine/')) {
      const session = await readSession(req, env);
      if (!session?.is_admin) return json({ error: 'UNAUTHORIZED', sign_in: '/auth/login' }, 401);
      return handleEngineApi(req, env, url.pathname, session);
    }
    // Admin MCP. Header auth is preferred; the /admin/mcp/<token> form exists
    // for MCP clients that cannot send custom headers.
    if (url.pathname === '/admin/mcp') return handleAdminMcp(req, env);
    const mcpPath = url.pathname.match(/^\/admin\/mcp\/(.+)$/);
    if (mcpPath) return handleAdminMcp(req, env, decodeURIComponent(mcpPath[1]));
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

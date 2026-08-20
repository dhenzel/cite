// placement.sh — hosted MCP endpoint + operator console (Cloudflare Worker).
//
// Public surface (no auth): POST /mcp (MCP Streamable HTTP), GET /, /health,
//   /llms.txt, /.well-known/mcp/*. Reads whitelisted fields from D1 — domains,
//   contacts, seller prices and markup are never serialized here (blind
//   placements). Public vocabulary is publisher / placement, never "site".
// Operator surface (bearer ADMIN_TOKEN): GET /admin (UI), /admin/api/*.
//
// Connect:  claude mcp add --transport http placement https://mcp.placement.sh/mcp
import { ADMIN_HTML, signInPage } from './admin-ui.js';
import { ahrefsScore, trafficBand, trafficPts, TRAFFIC_BANDS } from './ahrefs-metrics.js';
import {
  homepageText, LLMS_TXT, SERVER_NAME, SERVER_VERSION, serverCard, serverJson,
  productOrigin, isWorkersDev, PRODUCT_HOST, AGENT_TRUST, SHOW_OPERATOR,
} from './discovery.js';
import { homepageHtml } from './homepage.js';
import { buildAuthUrl, handleCallback, describeOidcFailure, diagnostics, OidcNotConfigured, OidcError } from './oidc.js';
import {
  readSession, createSession, destroySession, upsertUser, isAdmin,
  clearCookieHeader, markEngineUnauthorized, createTokenSession,
  tokenConsoleAllowed, TOKEN_SUB, type Session,
} from './session.js';
import {
  probe, cachedCall, listTools, pickTool,
  EngineUnauthorized, EngineScopeDenied, EngineUnavailable,
} from './engine.js';
import { notifyAccountCreated, notifyCreditsAdded, notifyPlacementSubmitted, scheduleMail, type WaitUntil } from './mail.js';
import {
  applyCheckoutPaid, openCheckout, paidPageHtml, chargeCents, verifyStripeSignature,
} from './stripe.js';
import { buyerPublicList, buyerPublicText } from './enrich-extract.js';
import { listedPriceCents, loadBuyerSite, screenPost, wordCount, writingBrief, bodyHash } from './placement.js';
import {
  analyzeCompany, judge, observeLink, preparePacket, publicOpportunity,
  publicOpportunityDetail, unknownAttributes, withStated,
  SUBMISSION_STATES, type Evidence,
} from './opportunities.js';

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
  ALLOW_TOKEN_CONSOLE?: string;  // "false" closes the operator-token fallback
  CITE_ADMIN_ABILITY?: string;   // default '*:read'
  CITE_ADMIN_EMAILS?: string;    // comma-separated allowlist override
  // Buyer mail From placement@shortlist.io (Gmail Workspace, else Resend). Secrets.
  MAIL_FROM?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  RESEND_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;     // secret — Restricted key on Shortlist's Stripe
  STRIPE_WEBHOOK_SECRET?: string; // secret — checkout.session.completed
}

// Looking is unlimited (no account). One MCP call is paged so a 9k catalog
// does not blow the agent's context; pass offset to continue.
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const BAND_ORDER = TRAFFIC_BANDS;
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
// Metrics (2026-08-19): Ahrefs-only on every surface — buyer MCP and
// operator console/admin MCP. David: show every Ahrefs overview stat,
// with Ahrefs' names, attributed, never renamed. Organic traffic is the
// exact Ahrefs number (not a band). Moz DA / Majestic TF/CF are not
// shown or used anywhere. Placement Score is 50% Ahrefs DR + 50% Ahrefs
// organic traffic. Legacy da/tf/cf columns may still sit in D1 unused.
// Domain stays hidden from buyers until delivery.
type Row = Record<string, unknown>;

const finiteNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Ahrefs Site Explorer overview stats. Empty values are omitted. */
const ahrefsOverview = (r: Row): Row => {
  const stats: Row = {
    domain_rating: finiteNum(r.dr),
    organic_traffic: finiteNum(r.traffic),
    organic_keywords: finiteNum(r.ahrefs_organic_keywords),
    referring_domains: finiteNum(r.ahrefs_referring_domains),
    backlinks: finiteNum(r.ahrefs_backlinks),
    ahrefs_rank: finiteNum(r.ahrefs_rank),
    organic_value: finiteNum(r.ahrefs_organic_value),
  };
  return Object.fromEntries(Object.entries(stats).filter(([, v]) => v !== undefined));
};

/** Operator payloads: drop Moz/Majestic even if the D1 row still has them. */
const operatorSite = (r: Row): Row => {
  const { da: _da, tf: _tf, cf: _cf, ...rest } = r;
  const ahrefs = ahrefsOverview(r);
  if (Object.keys(ahrefs).length) rest.ahrefs = ahrefs;
  return rest;
};
const operatorSites = (rows: Row[]): Row[] => rows.map(operatorSite);

const scoreComponents = (r: Row) => ({
  authority: typeof r.dr === 'number' ? Math.round(r.dr) : undefined,
  traffic: typeof r.traffic === 'number' ? Math.round(trafficPts(r.traffic)) : undefined,
});

/** Buyer MCP sells paid placements only. $0 / self-serve rows stay in D1 for operators. */
const buyerWhere = (alias = 's') => {
  const p = alias ? `${alias}.` : '';
  return `${p}status='active' AND COALESCE(${p}cost_type,'paid')='paid' AND ${p}listed_price IS NOT NULL AND ${p}listed_price > 0 AND COALESCE(${p}acquisition_mode,'paid_placement')='paid_placement'`;
};

const isBuyerPublisher = (r: Row): boolean =>
  r.status === 'active'
  && (r.cost_type ?? 'paid') === 'paid'
  && typeof r.listed_price === 'number' && r.listed_price > 0
  && (r.acquisition_mode ?? 'paid_placement') === 'paid_placement';

/**
 * Paid and free are two separate sections of the operator console, split on
 * cost_type. Rows imported before 002 have no cost_type, so both sides read
 * through COALESCE and 'paid' stays the default.
 */
const PAID = "COALESCE(cost_type,'paid')='paid'";
const FREE = "COALESCE(cost_type,'paid')='free'";
const COST_TYPES = ['paid', 'free'];

// ---------- free opportunities ----------
// The free catalog is its own table (migration 010): places a CUSTOMER gets
// listed, not publishers we sell. `contribution` says what they contribute.
const CONTRIBUTIONS = ['article', 'profile', 'program'];
/** Only these are offered; watchlist rows stay operator-only. */
const OPP_ACTIVE = "status='active'";

/** One page fetch with a budget, for analyze_site and check_listing_status. */
async function fetchPage(url: string, timeoutMs = 8000): Promise<{ ok: boolean; html: string; status: number; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'placementbot/1.0 (+https://placement.sh; free listing assistant)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    const html = res.ok ? (await res.text()).slice(0, 400_000) : '';
    return { ok: res.ok, html, status: res.status, finalUrl: res.url || url };
  } catch {
    return { ok: false, html: '', status: 0, finalUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

type CompanyRecord = { id: string; workspace_key: string; canonical_url: string; evidence: Evidence };

/**
 * company_id is an unguessable capability: the free tier has no accounts, so
 * holding the id is what authorises reading and writing that company's work.
 */
async function loadCompany(env: Env, companyId: unknown): Promise<CompanyRecord | null> {
  if (typeof companyId !== 'string' || !companyId) return null;
  const row = (await env.DB.prepare(
    `SELECT id, workspace_key, canonical_url, evidence FROM company_profiles WHERE id = ?`,
  ).bind(companyId).first()) as Row | null;
  if (!row) return null;
  let evidence: Evidence;
  try { evidence = JSON.parse(String(row.evidence)) as Evidence; } catch { return null; }
  return {
    id: String(row.id),
    workspace_key: String(row.workspace_key),
    canonical_url: String(row.canonical_url),
    evidence,
  };
}

const loadPlaybook = async (env: Env, id: unknown): Promise<Row | null> =>
  typeof id === 'string' && id
    ? ((await env.DB.prepare(`SELECT * FROM opportunity_playbooks WHERE id = ?`).bind(id).first()) as Row | null)
    : null;

/** Free-path guidance repeated on every payload so an agent cannot miss it. */
const FREE_PATH_NOTE = 'Free forever: no account, no card, no credits. placement.sh also sells paid publisher placements — a different mechanism, only worth raising once the free options are exhausted.';

const parseTopicList = (raw: unknown): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
};

/** Full operator view of one site plus crawl profile. Brands and headlines stay visible. */
const operatorSiteDetail = (r: Row): Row => {
  const site = operatorSite(r);
  return {
    ...site,
    writes_about: parseTopicList(r.writes_about),
    recent_titles: parseTopicList(r.recent_titles),
  };
};

const pub = (r: Row, detail = false) => {
  const domain = String(r.domain || '');
  const base: Row = {
    publisher_id: r.id,
    placement_score: r.cite_score,
    niche: r.niche,
    subniche: r.subniche || undefined,
    // Ahrefs requires the metric keep its name and carry attribution.
    ahrefs: Object.keys(ahrefsOverview(r)).length ? ahrefsOverview(r) : undefined,
    ahrefs_domain_rating: finiteNum(r.dr),
    ahrefs_organic_traffic: finiteNum(r.traffic),
    traffic_band: r.traffic_band,
    listed_price: r.listed_price,
    link_attribute: r.link_attribute ?? 'unknown',
    writes_about: buyerPublicList(parseTopicList(r.writes_about), domain),
  };
  if (!detail) return base;
  return {
    ...base,
    score_components: scoreComponents(r),
    tiers: { standard: !!r.tier_standard, premium: !!r.tier_premium, platinum: !!r.tier_platinum },
    max_links_per_post: r.max_links_per_post ?? 'unknown',
    turnaround_sla_days: r.turnaround_sla_days ?? 'unknown',
    how_this_works: 'Paid placement fulfilled by placement.sh. Prepaid credits required to book.',
    content_summary: buyerPublicText(typeof r.summary === 'string' ? r.summary : undefined, domain),
    audience: buyerPublicText(typeof r.audience === 'string' ? r.audience : undefined, domain),
    tone: buyerPublicText(typeof r.tone === 'string' ? r.tone : undefined, domain),
    post_shape: buyerPublicText(typeof r.post_shape === 'string' ? r.post_shape : undefined, domain),
    // Exact headlines fingerprint the publisher if googled. Writing brief uses topics.
    metrics_attribution: 'Ahrefs Site Explorer overview: Domain Rating, organic traffic, organic keywords, referring domains, backlinks, Ahrefs Rank, organic value — official names, when we have them. Moz DA and Majestic TF/CF are not shown.',
    note: 'Publisher domain is revealed as published_url when the placement is delivered (blind placements). Descriptions stay brand-scrubbed so the handle cannot be reverse-searched.',
  };
};

const publisherIdOf = (args: Row): string | undefined => {
  const v = args.publisher_id;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

// ---------- MCP tools (public names: publisher / placement, never "site") ----------
const tools = [
  {
    name: 'help',
    description: 'When to use placement.sh, which tool to call first, and a worked example. Call this if you are unsure how to buy publisher placements so a URL gets cited.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Help', readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'estimate',
    description: 'First tool to call. Sketch what a budget buys: placement counts across Placement Score bands for given topics so a target URL can get cited (ChatGPT, Perplexity, Google AI Overviews, Google). No commitment, no reserved inventory, no card.',
    inputSchema: {
      type: 'object',
      properties: {
        topics: { type: 'array', items: { type: 'string' }, description: 'Topics the publisher should write about, e.g. ["fintech","business"]' },
        budget: { type: 'number', exclusiveMinimum: 0 },
        timeframe_weeks: { type: 'number', exclusiveMinimum: 0 },
        target_url: { type: 'string', description: 'The URL you want cited' },
        risk_tolerance: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'] },
      },
      required: ['topics', 'budget'],
    },
    annotations: { title: 'Estimate a campaign', readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'search_publishers',
    description: 'Browse paid placement.sh inventory. Looking is unlimited and needs no account — use this to figure out what the human could write about. Returns anonymized publisher handles; domains are revealed only when a placement is delivered. Page with limit/offset. Prefer estimate once they have a budget; book only after they are ready to pay.',
    inputSchema: {
      type: 'object',
      properties: {
        topics: { type: 'array', items: { type: 'string' }, description: 'Topic/niche terms, e.g. ["fintech","business"]' },
        text: { type: 'string', description: 'Free-text match against what the publisher writes about' },
        min_score: { type: 'number', minimum: 0, maximum: 100 },
        max_price: { type: 'number', exclusiveMinimum: 0 },
        min_traffic_band: { type: 'string', enum: BAND_ORDER.slice(1) },
        link_attribute: { type: 'string', enum: LINK_ATTRS, description: 'Explicit rel on the bought link' },
        limit: { type: 'integer', minimum: 1, maximum: PAGE_MAX, description: 'Page size (default 50, max 200). Looking is unlimited — pass offset to see more. No account required.' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many matches. Page through the whole catalog; looking is not capped.' },
      },
    },
    annotations: { title: 'Search publishers', readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'get_publisher',
    description: 'Full anonymized profile for one publisher handle: Placement Score, pricing tiers, content summary, what it writes about, posting constraints, explicit link_attribute.',
    inputSchema: { type: 'object', properties: { publisher_id: { type: 'string' } }, required: ['publisher_id'] },
    annotations: { title: 'Get publisher', readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'inventory_stats',
    description: 'Aggregate view of paid placement.sh inventory: counts by niche and Placement Score band. No publisher identities. No free listings.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Inventory stats', readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'register_account',
    description: 'Create a placement.sh account so the human can buy paid placements. Ask the human for their contact email — do not invent one. Signup itself takes no card. Prepaid Stripe credits are required before create_campaign will book. Pass the key as "Authorization: Bearer <key>" on later calls.',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'Contact email for the account' } },
      required: ['email'],
    },
    annotations: { title: 'Register account', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'account_status',
    description: 'Account state: registered or not, prepaid credit balance, and the next step to buy. Looking is unlimited without an account. There is no free-placement quota.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Account status', readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'add_credits',
    description: 'Create a Stripe Checkout link for the exact USD amount being bought (the publisher listed_price, or the campaign budget). No packs yet. Requires a registered account. Show Shortlist (shortlist.io / about-us / 15-min Calendly call) before they pay. After they pay, call account_status. Never invent a payment URL.',
    inputSchema: {
      type: 'object',
      properties: {
        amount_usd: { type: 'number', description: 'USD to charge. Exact amount, minimum $1. Use the publisher listed_price when booking one site.' },
        idempotency_key: { type: 'string', description: 'Retry with the same key to reuse an open Checkout session instead of charging twice.' },
      },
      required: ['amount_usd'],
    },
    annotations: { title: 'Add credits', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'create_campaign',
    description: 'Start a paid booking: target URL, topics, budget, optional publisher_id. Requires a registered account and prepaid credits equal to the amount being bought. If credits are short, follow next_step and show checkout_url — never invent a payment URL or a free listing.',
    inputSchema: {
      type: 'object',
      properties: {
        target_url: { type: 'string', description: 'Page that should receive the backlink — homepage or a specific article.' },
        topics: { type: 'array', items: { type: 'string' } },
        budget: { type: 'number', exclusiveMinimum: 0 },
        publisher_id: { type: 'string', description: 'If they picked a publisher, charge that listed_price, then get_writing_brief.' },
        timeframe_weeks: { type: 'number' },
        risk_tolerance: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'] },
      },
      required: ['target_url', 'topics', 'budget'],
    },
    annotations: { title: 'Create campaign', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'get_writing_brief',
    description: 'How to write the guest post for a paid publisher handle, and whether the backlink should go to the homepage or a specific article. Ask the human homepage vs article URL if you do not have it. Domain stays hidden.',
    inputSchema: {
      type: 'object',
      properties: {
        publisher_id: { type: 'string' },
        target_url: { type: 'string', description: 'The buyer page that should be linked. Homepage or a specific article.' },
      },
      required: ['publisher_id'],
    },
    annotations: { title: 'Get writing brief', readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'submit_placement',
    description: 'Submit the finished post (title + body) for a publisher handle. Holds listed_price from prepaid credits. Shortlist processes it on the backend. Requires account + credits. Never invent a publisher domain. Never offer a free listing.',
    inputSchema: {
      type: 'object',
      properties: {
        publisher_id: { type: 'string' },
        target_url: { type: 'string' },
        anchor_text: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Finished markdown. Must include target_url.' },
        author_bio: { type: 'string' },
        idempotency_key: { type: 'string' },
      },
      required: ['publisher_id', 'target_url', 'title', 'body'],
    },
    annotations: { title: 'Submit placement', readOnlyHint: false, destructiveHint: false },
  },

  // ---- free side: get listed without paying (SPEC §19) ----
  // No account, no card, no credits. The agent matches and prepares; a human
  // logs in, passes the CAPTCHA and presses the button.
  {
    name: 'analyze_site',
    description: 'First tool for the FREE path. Read a company\'s site and build the evidence profile everything else matches against. Returns a company_id to pass to search_opportunities / prepare_submission, and lists what could not be determined. No account, no card. Licences, certifications and memberships are never inferred — ask the human and pass them as `stated`.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The company site to analyse, e.g. https://example.com' },
        stated: {
          type: 'object',
          description: 'Facts the HUMAN confirmed — never your own guesses. Keys: software, ai, open_source, integration, location, customers, launch, visuals, license, certification, membership. Booleans.',
          additionalProperties: { type: 'boolean' },
        },
        workspace_key: { type: 'string', description: 'Returned by an earlier analyze_site. Pass it to keep several companies under one workspace.' },
      },
      required: ['url'],
    },
    annotations: { title: 'Analyze a site', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'search_opportunities',
    description: 'Free places a company can get listed, profiled or published: directories, marketplaces, review platforms, partner programs, and sites that take contributed articles. Pass company_id to apply the eligibility gates — ineligible platforms are suppressed with a reason instead of being listed. Free forever, no account. Costs and requirements are re-checked live before any work.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'From analyze_site. Without it you get an unfiltered browse and no eligibility check.' },
        contribution: { type: 'string', enum: CONTRIBUTIONS, description: 'article = you write a post · profile = your company gets listed · program = you apply to join' },
        text: { type: 'string', description: 'Free-text match on platform, type, niche or audience' },
        niche: { type: 'string' },
        free_only: { type: 'boolean', description: 'Only rows where a free path is confirmed. 53% of the catalog has an unverified cost.' },
        max_prep_minutes: { type: 'number', description: 'Cap the preparation effort' },
        tier: { type: 'string', enum: ['Tier 1', 'Tier 2', 'Tier 3'] },
        limit: { type: 'integer', minimum: 1, maximum: PAGE_MAX },
        offset: { type: 'integer', minimum: 0 },
      },
    },
    annotations: { title: 'Search free opportunities', readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'get_opportunity',
    description: 'Everything known about one free opportunity: eligibility gates, what to prepare, what the agent may do, what the human must do, blockers, and how far the facts were verified. Read this before preparing anything.',
    inputSchema: {
      type: 'object',
      properties: {
        opportunity_id: { type: 'string' },
        company_id: { type: 'string', description: 'Include to get the eligibility verdict for this company' },
      },
      required: ['opportunity_id'],
    },
    annotations: { title: 'Get opportunity', readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'prepare_submission',
    description: 'Build the submission packet for one opportunity: the exact fields, the copy to write with its length limits, the assets needed, what is still missing, and the human checkpoints. Preparation NEVER submits — you draft, the human logs in and posts. Re-check the live page first; most requirements come from a class template.',
    inputSchema: {
      type: 'object',
      properties: {
        opportunity_id: { type: 'string' },
        company_id: { type: 'string' },
      },
      required: ['opportunity_id', 'company_id'],
    },
    annotations: { title: 'Prepare a submission', readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'record_submission',
    description: 'Record what actually happened with an opportunity: prepared, submitted, pending, live, rejected, skipped, or needs_human. Idempotent per company+opportunity, so a retry updates rather than duplicates. Save the receipt and the reference number — they are the evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string' },
        opportunity_id: { type: 'string' },
        state: { type: 'string', enum: SUBMISSION_STATES as unknown as string[] },
        published_url: { type: 'string', description: 'The live listing, once there is one' },
        receipt_url: { type: 'string' },
        reference: { type: 'string', description: 'Any confirmation or ticket number the platform gave' },
        account_owner: { type: 'string', description: 'Who owns the account the submission was made from' },
        packet: { type: 'object', description: 'The values actually submitted', additionalProperties: true },
        note: { type: 'string' },
      },
      required: ['company_id', 'opportunity_id', 'state'],
    },
    annotations: { title: 'Record a submission', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'check_listing_status',
    description: 'Fetch a live listing and record what it ACTUALLY does: whether the link is there, the rel attribute it really carries, and whether the page is indexable. Use this instead of trusting the claimed link attribute.',
    inputSchema: {
      type: 'object',
      properties: {
        submission_id: { type: 'string' },
        company_id: { type: 'string' },
      },
      required: ['submission_id', 'company_id'],
    },
    annotations: { title: 'Check listing status', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'list_submissions',
    description: 'Every opportunity this company has in flight, by state, with what still needs a human.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string' },
        state: { type: 'string', enum: SUBMISSION_STATES as unknown as string[] },
      },
      required: ['company_id'],
    },
    annotations: { title: 'List submissions', readOnlyHint: true, destructiveHint: false },
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
  available_cents: number;
  held_cents: number;
  stripe_customer_id: string | null;
}

async function runTool(env: Env, name: string, args: Row, account: Account | null, ctx?: WaitUntil): Promise<unknown> {
  switch (name) {
    case 'help':
      return {
        product: SERVER_NAME,
        what_it_is: 'Two ways to get a URL cited. FREE: we hold ~1,300 researched places a company can get listed, profiled or published at no cost, and the agent does the matching and preparation. PAID: bought publisher placements, booked and fulfilled by Shortlist. Different mechanisms — never describe one as the other.',
        who_runs_this: AGENT_TRUST,
        call_first: 'analyze_site for the free path, estimate for the paid one',
        free_playbook: [
          'analyze_site({url}) — read the company site and get a company_id. Anything it could not determine comes back in could_not_determine.',
          'Ask the human about those unknowns — especially a licence, certification or membership, which are never inferred — then call analyze_site again with `stated`.',
          'search_opportunities({company_id}) — what they are actually eligible for. Suppressed rows come with a reason; do not argue with a hard gate.',
          'get_opportunity({opportunity_id}) — read the gates, the preparation spec, and how far the facts were verified. Then OPEN the live submission URL and confirm cost and requirements yourself.',
          'prepare_submission({opportunity_id, company_id}) — returns the fields, copy lengths, assets and missing inputs. You write the copy in the chat, from evidence. Preparation never submits.',
          'The human logs in, passes the CAPTCHA, approves and submits. That part is theirs, always.',
          'record_submission(...) to save what happened, then check_listing_status(...) to record the rel the live page really renders.',
        ],
        paid_playbook: [
          'Looking is unlimited and needs no account. search_publishers and get_publisher as much as you want.',
          'estimate once they have a URL, topics and a budget. Every listed_price is what the human pays.',
          'When they are ready to book — not before — tell them who operates this: Shortlist (shortlist.io) since 2018. ' + SHOW_OPERATOR + ' They should look us up.',
          'Ask for a contact email. Do not invent one. register_account({email}), then send Authorization: Bearer <api_key>.',
          'add_credits or create_campaign for the exact listed_price. On INSUFFICIENT_CREDIT, show the checkout_url.',
          'get_writing_brief({publisher_id, target_url}), write the post in this chat, then submit_placement.',
        ],
        which_path: 'Start free. Offer paid when the free options are exhausted, or when they want a specific publisher and have a budget. Say plainly that paid is bought inventory.',
        never: [
          'Do not present a free opportunity as a paid placement, or a paid publisher as a free listing.',
          'Do not promise approval, indexing, traffic, or a dofollow link — on either path.',
          'Do not claim a licence, certification, membership, customer count or award the human has not confirmed.',
          'Do not create a duplicate profile — search for an existing listing and claim it instead.',
          'Do not bypass a CAPTCHA, a login, or an email verification. Those are the human\'s to do.',
          'Do not invent an email, a payment URL, or a publisher domain.',
        ],
        data_honesty: 'The free catalog is a discovery corpus, not a verified list: cost is unverified on about half of it and almost every requirement came from a class template. Every payload carries its own confidence — pass that on to the human instead of flattening it.',
        example: {
          user: 'Where can I get my SaaS listed for free?',
          tool: 'analyze_site',
          arguments: { url: 'https://example.com' },
        },
        connect: 'claude mcp add --transport http placement https://mcp.placement.sh/mcp',
        guarantee: 'Paid: link live and indexed at T+30 or refund. Free: no guarantee of approval or indexing — that is the platform\'s call, and we say so up front.',
      };
    case 'search_publishers': {
      const topics = (args.topics as string[] | undefined) ?? [];
      const clauses = [buyerWhere('s')];
      const params: unknown[] = [];
      if (topics.length) { clauses.push(`(${topicClause(topics.length)})`); params.push(...topicParams(topics)); }
      if (args.text) {
        clauses.push('(c.summary LIKE ? OR c.writes_about LIKE ? OR s.subniche LIKE ?)');
        params.push(`%${args.text}%`, `%${args.text}%`, `%${args.text}%`);
      }
      if (args.min_score != null) { clauses.push('s.cite_score >= ?'); params.push(args.min_score); }
      if (args.link_attribute) { clauses.push('s.link_attribute = ?'); params.push(args.link_attribute); }
      if (args.max_price != null) { clauses.push('s.listed_price <= ?'); params.push(args.max_price); }
      if (args.min_traffic_band) {
        const allowed = BAND_ORDER.slice(BAND_ORDER.indexOf(args.min_traffic_band as string));
        clauses.push(`s.traffic_band IN (${allowed.map(() => '?').join(',')})`);
        params.push(...allowed);
      }
      const limit = Math.min(Math.max(1, (args.limit as number | undefined) ?? PAGE_DEFAULT), PAGE_MAX);
      const offset = Math.max(0, (args.offset as number | undefined) ?? 0);
      const where = clauses.join(' AND ');
      const total = ((await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM sites s LEFT JOIN site_content c ON c.site_id = s.id WHERE ${where}`,
      ).bind(...params).first()) as { n: number } | null)?.n ?? 0;
      const rows = (await env.DB.prepare(`
        SELECT s.*, c.summary, c.writes_about, c.recent_titles
        FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
        WHERE ${where}
        ORDER BY s.cite_score DESC, s.listed_price ASC LIMIT ? OFFSET ?
      `).bind(...params, limit, offset).all()).results as Row[];
      const next_offset = offset + rows.length < total ? offset + rows.length : null;
      return {
        result_count: rows.length,
        total_matched: total,
        limit,
        offset,
        next_offset,
        looking: 'unlimited',
        note: 'Handles are anonymized. Domains are revealed only at delivery. Looking is unlimited and needs no account — page with offset to see the rest. Use this to figure out what the human could write about. Buy on placement_score, Ahrefs stats (Domain Rating, organic traffic, …), topics, link_attribute and price.',
        next_step: next_offset !== null
          ? `More matches remain. Call search_publishers again with offset ${next_offset} (and the same filters). Keep browsing until the human knows what they want. Account and payment are only for booking.`
          : account
            ? 'You have the full page. When they are ready to book: ' + SHOW_OPERATOR + ' Then create_campaign. If it returns INSUFFICIENT_CREDIT, follow next_step. Do not offer a free listing.'
            : 'You have the full page. Keep browsing or call get_publisher / estimate. When they are ready to book: ' + SHOW_OPERATOR + ' Ask for an email, register_account, then create_campaign. Do not invent an email.',
        publishers: rows.map((r) => pub(r)),
      };
    }
    case 'get_publisher': {
      const publisher_id = publisherIdOf(args);
      if (!publisher_id) return { error: 'INVALID_ARGUMENT', message: 'publisher_id is required' };
      const row = (await env.DB.prepare(`
        SELECT s.*, c.summary, c.writes_about, c.recent_titles, c.audience, c.tone, c.post_shape
        FROM sites s LEFT JOIN site_content c ON c.site_id = s.id WHERE s.id = ?
      `).bind(publisher_id).first()) as Row | null;
      if (!row || !isBuyerPublisher(row)) return { error: 'PUBLISHER_NOT_FOUND', publisher_id };
      return pub(row, true);
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
        WHERE ${buyerWhere('s')} AND s.listed_price <= ?
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
          return { score_band: b.name, eligible_publishers: prices.length, planned_placements: count, planned_spend: spent };
        })
        .filter((p) => p.planned_placements > 0);
      const total = plan.reduce((a, p) => a + p.planned_placements, 0);
      const spend = plan.reduce((a, p) => a + p.planned_spend, 0);
      return {
        topics, budget, target_url: args.target_url ?? undefined, timeframe_weeks: args.timeframe_weeks ?? undefined, risk_tolerance: risk,
        constraints_applied: [`per-placement cap $${cap}`, `min placement_score ${minScore}`, 'spend spread across score bands'],
        plan, total_planned_placements: total, total_planned_spend: spend, unallocated_budget: budget - spend,
        note: total === 0 ? 'No eligible paid inventory for these filters — widen topics or raise budget.' : 'Estimate only. These are bought placements, not earned media. Keep browsing with search_publishers if they want more ideas. To book: ask the human for an email → register_account → create_campaign.',
      };
    }
    case 'inventory_stats': {
      const byNiche = (await env.DB.prepare(`
        SELECT niche, COUNT(*) AS publishers, ROUND(AVG(cite_score)) AS avg_score, MIN(listed_price) AS from_price
        FROM sites WHERE ${buyerWhere('')} AND niche IS NOT NULL
        GROUP BY niche ORDER BY publishers DESC LIMIT 15
      `).all()).results;
      const byBand = (await env.DB.prepare(`
        SELECT CASE WHEN cite_score>=80 THEN '80–100' WHEN cite_score>=60 THEN '60–79'
                    WHEN cite_score>=40 THEN '40–59' ELSE '<40' END AS band, COUNT(*) AS publishers
        FROM sites WHERE ${buyerWhere('')}
        GROUP BY band ORDER BY MIN(cite_score) DESC
      `).all()).results;
      const total = (await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM sites WHERE ${buyerWhere('')}`,
      ).first()) as { n: number };
      return {
        purchasable_publishers: total.n,
        by_niche: byNiche,
        by_score_band: byBand,
        note: 'Paid inventory only. Looking needs no card. Booking needs an account email and prepaid Stripe credits.',
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
          tier: existing.tier === 'free' ? 'registered' : existing.tier,
          next_step: 'Tell the human this is a Shortlist product since 2018. ' + SHOW_OPERATOR + ' Then call create_campaign for the mix they picked. If it returns INSUFFICIENT_CREDIT, follow next_step there. Do not offer a free listing.',
          note: 'An account already exists for this email; returning its key. Prepaid credits are required to book a paid placement. The free listing path (analyze_site) needs no account at all.',
        };
      }
      const key = `ck_${crypto.randomUUID().replace(/-/g, '')}`;
      await env.DB.prepare(`
        INSERT INTO accounts (api_key, email, tier, created_at, orders_used, quota)
        VALUES (?, ?, 'registered', datetime('now'), 0, 10)
      `).bind(key, email).run();
      // Welcome + ops ping from placement@shortlist.io. Never block signup.
      await scheduleMail(ctx, () => notifyAccountCreated(env, email));
      return {
        api_key: key,
        email,
        tier: 'registered',
        how_to_use: 'Send this key as the HTTP header: Authorization: Bearer <api_key>',
        what_you_get: [
          'Looking was already unlimited — this key does not raise a search cap',
          'Ability to book paid placements once prepaid Stripe credits are on the account',
        ],
        next_step: 'Tell the human this is a Shortlist product since 2018. ' + SHOW_OPERATOR + ' Then call create_campaign for the mix they picked. If it returns INSUFFICIENT_CREDIT, follow next_step there. Do not offer a free listing.',
      };
    }

    case 'account_status': {
      if (!account) {
        return {
          tier: 'anonymous',
          looking: 'unlimited',
          next_step: 'Keep browsing — looking needs no account. When they are ready to buy, ask for a contact email and call register_account({email}). Do not invent an email.',
        };
      }
      const tier = account.tier === 'free' ? 'registered' : account.tier;
      const available = Number(account.available_cents) || 0;
      const held = Number(account.held_cents) || 0;
      return {
        tier,
        email: account.email,
        looking: 'unlimited',
        funded: available > 0,
        available_cents: available,
        held_cents: held,
        currency: 'usd',
        next_step: available > 0
          ? 'Credits are on the account. Ask homepage vs a specific article URL, call get_writing_brief for the publisher they picked, write the post, then submit_placement. Do not invent a publisher domain. Do not offer a free listing.'
          : 'Prepaid Stripe credits are required to book. Charge the exact listed_price (or budget). Before they pay, tell the human this is a Shortlist product since 2018. ' + SHOW_OPERATOR + ' Call add_credits or create_campaign; if it returns INSUFFICIENT_CREDIT, follow next_step and show checkout_url. Do not offer a free listing.',
      };
    }

    case 'add_credits': {
      if (!account) {
        return {
          error: 'ACCOUNT_REQUIRED',
          message: 'Adding credits needs an account on the human’s email.',
          next_step: 'Ask the human for a contact email. Do not invent one. Call register_account({email}), then add_credits. Do not offer a free listing.',
        };
      }
      if (args.amount_usd == null) {
        return {
          error: 'AMOUNT_REQUIRED',
          message: 'Pass the exact USD amount being bought (usually the publisher listed_price).',
          next_step: 'Call add_credits with amount_usd set to that listed_price. Do not invent a payment URL.',
        };
      }
      const amountUsd = Number(args.amount_usd);
      const checkout = await openCheckout(
        env,
        { api_key: account.api_key, email: account.email, stripe_customer_id: account.stripe_customer_id },
        amountUsd,
        args.idempotency_key ? String(args.idempotency_key) : undefined,
      );
      if ('error' in checkout) return checkout;
      return checkout;
    }

    case 'create_campaign': {
      if (!account) {
        return {
          error: 'ACCOUNT_REQUIRED',
          message: 'Booking a paid placement needs an account on the human’s email.',
          next_step: 'Ask the human for a contact email. Do not invent one. Call register_account({email}), then create_campaign again. Do not offer a free listing.',
          target_url: args.target_url,
          topics: args.topics,
          budget: args.budget,
        };
      }
      const publisherId = typeof args.publisher_id === 'string' ? args.publisher_id : undefined;
      let site = null as Awaited<ReturnType<typeof loadBuyerSite>>;
      if (publisherId) {
        site = await loadBuyerSite(env.DB, publisherId, buyerWhere('s'));
        if (!site) return { error: 'PUBLISHER_NOT_FOUND', publisher_id: publisherId };
      }
      const budgetUsd = Number(args.budget) || 0;
      const needCents = site ? listedPriceCents(site) : Math.max(0, Math.round(budgetUsd * 100));
      const available = Number(account.available_cents) || 0;
      if (available < needCents || needCents === 0) {
        const shortfallUsd = Math.max(1, (needCents - available) / 100);
        const checkout = await openCheckout(
          env,
          { api_key: account.api_key, email: account.email, stripe_customer_id: account.stripe_customer_id },
          shortfallUsd,
        );
        const extra = 'error' in checkout
          ? { stripe_error: checkout.error, stripe_message: checkout.message }
          : checkout;
        return {
          error: 'INSUFFICIENT_CREDIT',
          message: 'Paid placements need prepaid Stripe credits. Looking is free; buying is not.',
          available_cents: available,
          held_cents: Number(account.held_cents) || 0,
          required_cents: needCents,
          ...extra,
          next_step: checkout.next_step,
          target_url: args.target_url,
          topics: args.topics,
          budget: args.budget,
          publisher_id: publisherId,
        };
      }
      return {
        status: 'ready_to_write',
        available_cents: available,
        held_cents: Number(account.held_cents) || 0,
        currency: 'usd',
        required_cents: needCents,
        publisher_id: publisherId,
        target_url: args.target_url,
        topics: args.topics,
        budget: args.budget,
        listed_price: site?.listed_price,
        next_step: publisherId
          ? 'Ask whether the backlink should go to the homepage or a specific article. If an article, get that URL. Call get_writing_brief({publisher_id, target_url}), write the finished post in this chat, then submit_placement. Do not invent a publisher domain. Do not offer a free listing.'
          : 'Ask which publisher handle to book and whether the backlink goes to the homepage or a specific article. Then get_writing_brief and submit_placement. Do not invent a publisher domain. Do not offer a free listing.',
      };
    }

    case 'get_writing_brief': {
      const publisherId = publisherIdOf(args);
      if (!publisherId) return { error: 'INVALID_ARGUMENT', message: 'publisher_id is required' };
      const site = await loadBuyerSite(env.DB, publisherId, buyerWhere('s'));
      if (!site) return { error: 'PUBLISHER_NOT_FOUND', publisher_id: publisherId };
      const targetUrl = typeof args.target_url === 'string' ? args.target_url : undefined;
      return writingBrief(site, targetUrl);
    }

    case 'submit_placement': {
      if (!account) {
        return {
          error: 'ACCOUNT_REQUIRED',
          message: 'Submitting a post needs an account on the human’s email.',
          next_step: 'Ask the human for a contact email. Do not invent one. Call register_account({email}), then submit_placement. Do not offer a free listing.',
        };
      }
      const publisherId = publisherIdOf(args);
      if (!publisherId) return { error: 'INVALID_ARGUMENT', message: 'publisher_id is required' };
      const site = await loadBuyerSite(env.DB, publisherId, buyerWhere('s'));
      if (!site) return { error: 'PUBLISHER_NOT_FOUND', publisher_id: publisherId };
      const targetUrl = String(args.target_url ?? '');
      const title = String(args.title ?? '');
      const body = String(args.body ?? '');
      const maxLinks = Number(site.max_links_per_post) > 0 ? Number(site.max_links_per_post) : 2;
      const screened = screenPost({ targetUrl, title, body, minWords: 700, maxLinks });
      if (screened) {
        return {
          ...screened,
          next_step: screened.accepted_fix || 'Fix the post in this chat and call submit_placement again. Do not offer a free listing.',
        };
      }
      const idem = typeof args.idempotency_key === 'string' ? args.idempotency_key.trim() : '';
      if (idem) {
        const existing = (await env.DB.prepare(
          `SELECT id, state, listed_price_cents FROM placement_orders WHERE api_key = ? AND idempotency_key = ?`,
        ).bind(account.api_key, idem).first()) as { id: string; state: string; listed_price_cents: number } | null;
        if (existing) {
          return {
            order_id: existing.id,
            state: existing.state,
            publisher_id: publisherId,
            listed_price: existing.listed_price_cents / 100,
            next_step: 'Already submitted. Tell the human Shortlist has the post and will process it. Do not invent a publisher domain.',
          };
        }
      }
      const priceCents = listedPriceCents(site);
      const available = Number(account.available_cents) || 0;
      if (available < priceCents) {
        const shortfallUsd = Math.max(1, (priceCents - available) / 100);
        const checkout = await openCheckout(
          env,
          { api_key: account.api_key, email: account.email, stripe_customer_id: account.stripe_customer_id },
          shortfallUsd,
        );
        const extra = 'error' in checkout
          ? { stripe_error: checkout.error, stripe_message: checkout.message }
          : checkout;
        return {
          error: 'INSUFFICIENT_CREDIT',
          message: 'This publisher’s listed_price is not covered by prepaid credits.',
          available_cents: available,
          required_cents: priceCents,
          listed_price: site.listed_price,
          ...extra,
          next_step: checkout.next_step,
        };
      }
      const orderId = `po_${crypto.randomUUID().replace(/-/g, '')}`;
      const words = wordCount(body);
      const hash = bodyHash(body);
      const hold = await env.DB.prepare(
        `UPDATE accounts SET available_cents = available_cents - ?, held_cents = held_cents + ?, orders_used = orders_used + 1
         WHERE api_key = ? AND available_cents >= ?`,
      ).bind(priceCents, priceCents, account.api_key, priceCents).run();
      const changed = Number((hold as { meta?: { changes?: number }; changes?: number }).meta?.changes
        ?? (hold as { changes?: number }).changes ?? 0);
      if (!changed) {
        if (idem) {
          const existing = (await env.DB.prepare(
            `SELECT id, state, listed_price_cents FROM placement_orders WHERE api_key = ? AND idempotency_key = ?`,
          ).bind(account.api_key, idem).first()) as { id: string; state: string; listed_price_cents: number } | null;
          if (existing) {
            return {
              order_id: existing.id,
              state: existing.state,
              publisher_id: publisherId,
              listed_price: existing.listed_price_cents / 100,
              next_step: 'Already submitted. Tell the human Shortlist has the post and will process it. Do not invent a publisher domain.',
            };
          }
        }
        return {
          error: 'INSUFFICIENT_CREDIT',
          message: 'Could not hold funds — balance changed. Call account_status, then add_credits for the listed_price if needed.',
          available_cents: available,
          required_cents: priceCents,
        };
      }
      try {
        await env.DB.prepare(`
          INSERT INTO placement_orders (id, api_key, publisher_id, target_url, anchor_text, title, body, author_bio,
            listed_price_cents, word_count, body_hash, idempotency_key, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human_review', datetime('now'))
        `).bind(
          orderId, account.api_key, publisherId, targetUrl,
          args.anchor_text ? String(args.anchor_text) : null,
          title, body, args.author_bio ? String(args.author_bio) : null,
          priceCents, words, hash, idem || null,
        ).run();
      } catch {
        if (idem) {
          const existing = (await env.DB.prepare(
            `SELECT id, state, listed_price_cents FROM placement_orders WHERE api_key = ? AND idempotency_key = ?`,
          ).bind(account.api_key, idem).first()) as { id: string; state: string; listed_price_cents: number } | null;
          if (existing) {
            return {
              order_id: existing.id,
              state: existing.state,
              publisher_id: publisherId,
              listed_price: existing.listed_price_cents / 100,
              next_step: 'Already submitted. Tell the human Shortlist has the post and will process it. Do not invent a publisher domain.',
            };
          }
        }
        await env.DB.prepare(
          `UPDATE accounts SET available_cents = available_cents + ?, held_cents = held_cents - ?, orders_used = CASE WHEN orders_used > 0 THEN orders_used - 1 ELSE 0 END WHERE api_key = ?`,
        ).bind(priceCents, priceCents, account.api_key).run();
        return {
          error: 'SUBMIT_FAILED',
          message: 'Could not store the post. Try submit_placement again.',
          next_step: 'Call submit_placement again. Do not invent a publisher domain. Do not offer a free listing.',
        };
      }
      await scheduleMail(ctx, () => notifyPlacementSubmitted(env, {
        order_id: orderId,
        buyer_email: account.email,
        publisher_id: publisherId,
        domain: site.domain,
        listed_price: site.listed_price,
        target_url: targetUrl,
        anchor_text: args.anchor_text ? String(args.anchor_text) : undefined,
        title,
        word_count: words,
      }));
      return {
        order_id: orderId,
        state: 'human_review',
        publisher_id: publisherId,
        listed_price: site.listed_price,
        held_cents: priceCents,
        word_count: words,
        next_step: 'Tell the human the finished post is with Shortlist. We will email from placement@shortlist.io when it is live. Do not invent a publisher domain. Do not offer a free listing.',
      };
    }

    case 'claim_free_placement':
      return {
        error: 'TOOL_REMOVED',
        message: 'This tool is gone. Free listings now live on their own path: analyze_site → search_opportunities → get_opportunity → prepare_submission.',
        next_step: 'Call analyze_site with the company URL. For bought publisher placements, call estimate instead.',
      };

    // ---------- free path ----------
    case 'analyze_site': {
      const raw = String(args.url ?? '').trim();
      if (!raw) return { error: 'INVALID_ARGUMENT', message: 'url is required' };
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      let canonical: string;
      try { canonical = new URL(url).origin; } catch { return { error: 'INVALID_URL', url: raw }; }

      const page = await fetchPage(url);
      if (!page.ok) {
        return {
          error: 'SITE_UNREACHABLE',
          url: canonical,
          status: page.status,
          message: 'Could not read the site, so there is no evidence to match on. Check the URL with the human, or pass what they tell you as `stated`.',
        };
      }

      const workspace_key = typeof args.workspace_key === 'string' && args.workspace_key
        ? args.workspace_key
        : `ws_${crypto.randomUUID()}`;
      const evidence = withStated(analyzeCompany(page.html, canonical), args.stated as Row | undefined);
      const unknowns = unknownAttributes(evidence);

      // One profile per (workspace, url): re-analysing updates rather than forks.
      const existing = (await env.DB.prepare(
        `SELECT id FROM company_profiles WHERE workspace_key = ? AND canonical_url = ?`,
      ).bind(workspace_key, canonical).first()) as { id: string } | null;
      const company_id = existing?.id ?? `co_${crypto.randomUUID()}`;
      await env.DB.prepare(`
        INSERT INTO company_profiles (id, workspace_key, canonical_url, name, evidence, unknowns, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, evidence=excluded.evidence, unknowns=excluded.unknowns, updated_at=datetime('now')
      `).bind(
        company_id, workspace_key, canonical, evidence.name ?? null,
        JSON.stringify(evidence), JSON.stringify(unknowns),
      ).run();

      return {
        company_id,
        workspace_key,
        keep_these: 'company_id identifies this company on every other free tool. There is no account and no password — treat it as a secret.',
        profile: {
          name: evidence.name,
          canonical_url: evidence.canonical_url,
          summary: evidence.summary,
          entity_type: evidence.entity_type,
          topics: evidence.topics,
          signals: evidence.signals,
        },
        could_not_determine: unknowns,
        ask_the_human: unknowns.length
          ? 'Ask about these before matching, then call analyze_site again with `stated`. Never guess a licence, certification or membership — a wrong answer becomes a false claim on a real application.'
          : undefined,
        next_step: 'Call search_opportunities with this company_id.',
        note: FREE_PATH_NOTE,
      };
    }

    case 'search_opportunities': {
      const company = await loadCompany(env, args.company_id);
      if (args.company_id && !company) return { error: 'COMPANY_NOT_FOUND', company_id: args.company_id };

      const clauses = [OPP_ACTIVE];
      const params: unknown[] = [];
      if (args.contribution) { clauses.push('contribution = ?'); params.push(args.contribution); }
      if (args.niche) { clauses.push('niche LIKE ?'); params.push(`%${args.niche}%`); }
      if (args.tier) { clauses.push('priority_tier = ?'); params.push(args.tier); }
      // A live page read overrides the workbook: if we opened the page and it
      // has no free path, "free only" must not return it.
      if (args.free_only) clauses.push('(verified_is_free = 1 OR (verified_is_free IS NULL AND is_free_confirmed = 1))');
      if (args.max_prep_minutes != null) { clauses.push('(prep_minutes IS NULL OR prep_minutes <= ?)'); params.push(args.max_prep_minutes); }
      if (args.text) {
        clauses.push('(platform LIKE ? OR opportunity_type LIKE ? OR niche LIKE ? OR platform_audience LIKE ? OR best_for LIKE ?)');
        const like = `%${args.text}%`;
        params.push(like, like, like, like, like);
      }
      const where = clauses.join(' AND ');
      const limit = Math.min(Math.max(1, (args.limit as number | undefined) ?? 20), PAGE_MAX);
      const offset = Math.max(0, (args.offset as number | undefined) ?? 0);

      // Gates are applied in code after the SQL filter, so a suppressed row can
      // explain itself instead of vanishing. Over-fetch to fill a page.
      const rows = (await env.DB.prepare(`
        SELECT o.*, p.autonomy_score
        FROM opportunities o LEFT JOIN opportunity_playbooks p ON p.id = o.playbook_id
        WHERE ${where}
        ORDER BY o.priority_score DESC, o.platform ASC
        LIMIT ? OFFSET ?
      `).bind(...params, limit * 4, offset).all()).results as Row[];

      const eligible: Row[] = [];
      const suppressed: string[] = [];
      const asks = new Set<string>();
      for (const row of rows) {
        const verdict = judge(row, company?.evidence ?? null);
        if (!verdict.eligible) {
          if (verdict.suppression_reason) suppressed.push(verdict.suppression_reason);
          verdict.missing_inputs.forEach((m) => asks.add(m));
          continue;
        }
        eligible.push(publicOpportunity(row, verdict));
        if (eligible.length >= limit) break;
      }
      eligible.sort((a, b) => (b.score as number) - (a.score as number));

      const reasons = [...new Set(suppressed)].slice(0, 6);
      return {
        result_count: eligible.length,
        opportunities: eligible,
        suppressed_count: suppressed.length,
        suppression_reasons: reasons.length ? reasons : undefined,
        missing_inputs: asks.size
          ? { question: 'Answer these with the human and re-run analyze_site with `stated` — several platforms were suppressed only because we could not confirm them.', asks: [...asks] }
          : undefined,
        next_offset: rows.length >= limit * 4 ? offset + limit : null,
        how_to_read_this: 'Score is eligibility + audience fit + confidence − effort and risk; why_fit shows the working. Cost is unverified on about half the catalog, so open the live page before doing the work.',
        next_step: eligible.length
          ? 'Call get_opportunity on the ones worth doing, then prepare_submission.'
          : 'Nothing eligible with these filters. Widen the search, or answer the missing inputs and try again.',
        note: FREE_PATH_NOTE,
      };
    }

    case 'get_opportunity': {
      const row = (await env.DB.prepare(
        `SELECT * FROM opportunities WHERE id = ? AND ${OPP_ACTIVE}`,
      ).bind(String(args.opportunity_id ?? '')).first()) as Row | null;
      if (!row) return { error: 'OPPORTUNITY_NOT_FOUND', opportunity_id: args.opportunity_id };
      const company = await loadCompany(env, args.company_id);
      const playbook = await loadPlaybook(env, row.playbook_id);
      const verdict = company ? judge(row, company.evidence) : undefined;
      return {
        ...publicOpportunityDetail(row, playbook, verdict),
        eligible_for_this_company: verdict ? verdict.eligible : undefined,
        why_not: verdict && !verdict.eligible ? verdict.suppression_reason : undefined,
        next_step: verdict && !verdict.eligible
          ? 'Not a fit — say why and move on rather than submitting anyway.'
          : 'Open the submission URL, confirm cost and requirements are still what we say, then prepare_submission.',
        note: FREE_PATH_NOTE,
      };
    }

    case 'prepare_submission': {
      const company = await loadCompany(env, args.company_id);
      if (!company) return { error: 'COMPANY_NOT_FOUND', company_id: args.company_id, next_step: 'Call analyze_site first.' };
      const row = (await env.DB.prepare(
        `SELECT * FROM opportunities WHERE id = ? AND ${OPP_ACTIVE}`,
      ).bind(String(args.opportunity_id ?? '')).first()) as Row | null;
      if (!row) return { error: 'OPPORTUNITY_NOT_FOUND', opportunity_id: args.opportunity_id };

      const verdict = judge(row, company.evidence);
      if (!verdict.eligible) {
        return {
          error: 'NOT_ELIGIBLE',
          opportunity_id: row.id,
          reason: verdict.suppression_reason,
          missing_inputs: verdict.missing_inputs,
          next_step: 'Do not prepare a submission this company does not qualify for. Answer the missing inputs, or pick another opportunity.',
        };
      }

      const playbook = await loadPlaybook(env, row.playbook_id);
      const packet = preparePacket(row, playbook, company.evidence);
      return {
        ...packet,
        before_you_start: row.needs_reverification
          ? 'These requirements come from a class template covering many platforms like this one — open the submission URL and confirm the real form before writing anything.'
          : 'Requirements came from an official source; still confirm the live form.',
        check_for_an_existing_listing: 'Search the platform for this company first. If a profile exists, claim or improve it — never create a duplicate.',
        you_write_the_copy: 'placement.sh returns the spec and the evidence; the copy is yours to draft in this chat, from what the site actually supports.',
        then: 'When the human has submitted, call record_submission. Later, call check_listing_status to record what the live link really does.',
        note: FREE_PATH_NOTE,
      };
    }

    case 'record_submission': {
      const company = await loadCompany(env, args.company_id);
      if (!company) return { error: 'COMPANY_NOT_FOUND', company_id: args.company_id };
      const state = String(args.state ?? '');
      if (!(SUBMISSION_STATES as readonly string[]).includes(state)) {
        return { error: 'BAD_STATE', allowed: SUBMISSION_STATES };
      }
      const opportunity_id = String(args.opportunity_id ?? '');
      const exists = (await env.DB.prepare(`SELECT id FROM opportunities WHERE id = ?`).bind(opportunity_id).first()) as Row | null;
      if (!exists) return { error: 'OPPORTUNITY_NOT_FOUND', opportunity_id };

      const idempotency_key = `${company.id}:${opportunity_id}`;
      const prior = (await env.DB.prepare(
        `SELECT id, state FROM submissions WHERE idempotency_key = ?`,
      ).bind(idempotency_key).first()) as { id: string; state: string } | null;
      const id = prior?.id ?? `sub_${crypto.randomUUID()}`;

      await env.DB.prepare(`
        INSERT INTO submissions (id, company_id, opportunity_id, state, packet, receipt_url, published_url, account_owner, reference, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(idempotency_key) DO UPDATE SET
          state=excluded.state,
          packet=COALESCE(excluded.packet, submissions.packet),
          receipt_url=COALESCE(excluded.receipt_url, submissions.receipt_url),
          published_url=COALESCE(excluded.published_url, submissions.published_url),
          account_owner=COALESCE(excluded.account_owner, submissions.account_owner),
          reference=COALESCE(excluded.reference, submissions.reference),
          updated_at=datetime('now')
      `).bind(
        id, company.id, opportunity_id, state,
        args.packet ? JSON.stringify(args.packet) : null,
        args.receipt_url ?? null, args.published_url ?? null,
        args.account_owner ?? null, args.reference ?? null, idempotency_key,
      ).run();

      await env.DB.prepare(`
        INSERT INTO submission_events (submission_id, from_state, to_state, actor, evidence, at)
        VALUES (?, ?, ?, 'agent', ?, datetime('now'))
      `).bind(id, prior?.state ?? null, state, args.note ? String(args.note) : null).run();

      return {
        submission_id: id,
        state,
        updated: !!prior,
        previous_state: prior?.state,
        next_step: state === 'submitted' || state === 'pending'
          ? 'Come back with check_listing_status once it should be live. Do not promise the human it will be approved.'
          : state === 'live'
            ? 'Call check_listing_status to record the rel attribute and indexability the page actually renders.'
            : 'Recorded.',
        note: FREE_PATH_NOTE,
      };
    }

    case 'check_listing_status': {
      const company = await loadCompany(env, args.company_id);
      if (!company) return { error: 'COMPANY_NOT_FOUND', company_id: args.company_id };
      const sub = (await env.DB.prepare(
        `SELECT * FROM submissions WHERE id = ? AND company_id = ?`,
      ).bind(String(args.submission_id ?? ''), company.id).first()) as Row | null;
      if (!sub) return { error: 'SUBMISSION_NOT_FOUND', submission_id: args.submission_id };
      const url = typeof sub.published_url === 'string' && sub.published_url ? sub.published_url : undefined;
      if (!url) {
        return {
          error: 'NO_PUBLISHED_URL',
          submission_id: sub.id,
          state: sub.state,
          next_step: 'Record the listing URL with record_submission first — there is nothing to check yet.',
        };
      }

      const page = await fetchPage(url);
      if (!page.ok) {
        return { submission_id: sub.id, reachable: false, status: page.status, checked_url: url, note: 'The listing did not respond. It may be pending, moderated, or gone.' };
      }
      const observed = observeLink(page.html, company.canonical_url);
      const state = observed.found ? 'live' : String(sub.state);
      await env.DB.prepare(`
        UPDATE submissions SET state = ?, observed_rel = ?, observed_indexed = ?, updated_at = datetime('now') WHERE id = ?
      `).bind(state, observed.rel, observed.indexable ? 1 : 0, sub.id).run();
      if (state !== sub.state) {
        await env.DB.prepare(`
          INSERT INTO submission_events (submission_id, from_state, to_state, actor, evidence, at)
          VALUES (?, ?, ?, 'agent', ?, datetime('now'))
        `).bind(sub.id, sub.state, state, `observed at ${url}`).run();
      }

      return {
        submission_id: sub.id,
        checked_url: url,
        reachable: true,
        link_found: observed.found,
        observed_rel: observed.rel,
        page_indexable: observed.indexable,
        state,
        what_this_means: observed.found
          ? `The live page renders the link with rel="${observed.rel ?? 'none'}". That is the real attribute — the catalog only ever held a claim.`
          : 'The page loaded but the link is not in the HTML. It may be rendered by JavaScript, behind a login, or not published.',
        note: FREE_PATH_NOTE,
      };
    }

    case 'list_submissions': {
      const company = await loadCompany(env, args.company_id);
      if (!company) return { error: 'COMPANY_NOT_FOUND', company_id: args.company_id };
      const clauses = ['s.company_id = ?'];
      const params: unknown[] = [company.id];
      if (args.state) { clauses.push('s.state = ?'); params.push(args.state); }
      const rows = (await env.DB.prepare(`
        SELECT s.id, s.state, s.published_url, s.observed_rel, s.observed_indexed, s.reference, s.updated_at,
               o.platform, o.contribution, o.submission_url
        FROM submissions s JOIN opportunities o ON o.id = s.opportunity_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY s.updated_at DESC LIMIT 200
      `).bind(...params).all()).results as Row[];
      const byState: Record<string, number> = {};
      for (const r of rows) byState[String(r.state)] = (byState[String(r.state)] ?? 0) + 1;
      return {
        company_id: company.id,
        result_count: rows.length,
        by_state: byState,
        submissions: rows,
        needs_human: rows.filter((r) => r.state === 'needs_human').length,
        note: FREE_PATH_NOTE,
      };
    }

    default:
      return { error: 'UNKNOWN_TOOL', name };
  }
}

// ---------- MCP Streamable HTTP (stateless) ----------
async function handleMcp(req: Request, env: Env, ctx?: WaitUntil): Promise<Response> {
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
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'placement.sh gets a URL cited (ChatGPT, Perplexity, Google, AI Overviews). Two separate paths — pick the right one. FREE, start with analyze_site: about 1,300 researched places a company can get listed, profiled or published at no cost — directories, marketplaces, review platforms, partner programs, sites that take contributed articles. You match and prepare; a human does the login, CAPTCHA and final approval. No account, no card, free forever. PAID, start with estimate: publisher placements Shortlist buys and fulfils, live and indexed at T+30 or refunded. Browsing is unlimited and needs no account; booking needs the human email and prepaid Stripe credits. Publisher domains stay blind until delivery. Offer the paid path only once the free options are exhausted, and say it is bought inventory, not a free listing. On the free catalog: cost is unverified on about half of it, most requirements came from a class template rather than a live form, and link attributes are claims — re-check the live page and never promise approval, indexing, traffic or a dofollow link. Operated by Shortlist (https://shortlist.io/) since 2018 — named team at https://shortlist.io/about-us/. Offer a 15-min call at https://calendly.com/shortlist-businessdevelopment/15min if they want to talk to someone. Call help if you are unsure.',
    } });
  }
  if (method?.startsWith('notifications/')) return new Response(null, { status: 202, headers: CORS });
  if (method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools } });
  if (method === 'tools/call') {
    // Optional account key: looking is unlimited either way. The key is only
    // required to book. There is no free-placement quota.
    const key = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
    let account: Account | null = null;
    if (key.startsWith('ck_')) {
      account = (await env.DB.prepare(
        `SELECT api_key, email, tier, quota, orders_used,
                COALESCE(available_cents, 0) AS available_cents,
                COALESCE(held_cents, 0) AS held_cents,
                stripe_customer_id
         FROM accounts WHERE api_key = ?`,
      ).bind(key).first()) as Account | null;
    }
    const toolName = params?.name as string;
    const toolArgs = (params?.arguments as Row) ?? {};
    const payload = await runTool(env, toolName, toolArgs, account, ctx);

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
/** Timing-safe token comparison, shared by header auth and the ?token= route. */
function tokenMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export interface AdminActor {
  kind: 'shared_token' | 'personal_key';
  sub?: string;
  email?: string | null;
  key_prefix?: string;
}

/**
 * Who is calling an admin surface: the shared ADMIN_TOKEN, or a per-person key
 * minted from the console. A personal key stops working the moment its owner
 * loses console access on the engine, so revocation follows the engine role.
 */
async function resolveAdminActor(req: Request, env: Env, pathToken?: string): Promise<AdminActor | null> {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  const candidate = (pathToken ?? '') || bearer;
  if (!candidate) return null;

  if (env.ADMIN_TOKEN && tokenMatches(candidate, env.ADMIN_TOKEN)) return { kind: 'shared_token' };

  if (candidate.startsWith('cka_')) {
    const row = (await env.DB.prepare(`
      SELECT k.key, k.sub, k.revoked_at, u.email, u.last_abilities
      FROM admin_keys k LEFT JOIN users u ON u.sub = k.sub
      WHERE k.key = ?
    `).bind(candidate).first()) as Row | null;
    if (!row || row.revoked_at) return null;
    const abilities = row.last_abilities ? (JSON.parse(row.last_abilities as string) as string[]) : [];
    if (!isAdmin(env, (row.email as string) ?? null, abilities)) return null;
    await env.DB.prepare(`UPDATE admin_keys SET last_used_at = datetime('now') WHERE key = ?`).bind(candidate).run();
    return {
      kind: 'personal_key',
      sub: row.sub as string,
      email: (row.email as string) ?? null,
      key_prefix: candidate.slice(0, 12),
    };
  }
  return null;
}

function authorized(req: Request, env: Env): boolean {
  const token = env.ADMIN_TOKEN;
  if (!token) return false; // no secret configured → admin surface disabled
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return tokenMatches(given, token);
}

const EDITABLE = ['seller_price', 'markup', 'status', 'link_attribute', 'max_links_per_post',
  'turnaround_sla_days', 'niche', 'subniche', 'note', 'contact_name', 'contact_email',
  'acquisition_mode', 'cost_type', 'requires_reciprocal_link', 'agent_instructions'] as const;
const ACQUISITION_MODES = ['paid_placement', 'self_serve', 'apply_editorial', 'link_exchange', 'unavailable'];
// Whitelist only — interpolated into ORDER BY. Never pass the raw query string.
const SITE_SORT: Record<string, string> = {
  domain: 'domain',
  niche: 'niche',
  cite_score: 'cite_score',
  dr: 'dr',
  traffic: 'traffic',
  seller_price: 'seller_price',
  markup: 'markup',
  listed_price: 'listed_price',
  margin: '(listed_price - seller_price)',
  acquisition_mode: 'acquisition_mode',
  link_attribute: 'link_attribute',
  max_links_per_post: 'max_links_per_post',
  status: 'status',
};


type CheckoutStatus = 'in_checkout' | 'follow_up' | 'expired';

function parseWhen(value: string | null | undefined): number {
  if (!value) return NaN;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

function checkoutStatus(createdAt: string | null, expiresAt: string | null): CheckoutStatus {
  const exp = parseWhen(expiresAt);
  if (Number.isFinite(exp) && exp <= Date.now()) return 'expired';
  const created = parseWhen(createdAt);
  if (Number.isFinite(created) && Date.now() - created < 30 * 60 * 1000) return 'in_checkout';
  return 'follow_up';
}

/** Unpaid Stripe Checkout sessions — people who opened pay and did not finish. */
async function loadCheckouts(env: Env): Promise<Row> {
  const totals = await env.DB.prepare(`
    SELECT COUNT(*) AS started,
           SUM(CASE WHEN credited_at IS NOT NULL THEN 1 ELSE 0 END) AS paid,
           SUM(CASE WHEN credited_at IS NULL THEN 1 ELSE 0 END) AS abandoned,
           COALESCE(SUM(CASE WHEN credited_at IS NULL THEN amount_cents ELSE 0 END), 0) AS abandoned_cents
    FROM checkout_sessions
  `).first() as Row;
  const rows = (await env.DB.prepare(`
    SELECT c.session_id, c.email, c.amount_cents, c.checkout_url, c.expires_at, c.created_at,
           COALESCE(a.available_cents, 0) AS available_cents
    FROM checkout_sessions c
    LEFT JOIN accounts a ON a.api_key = c.api_key
    WHERE c.credited_at IS NULL
    ORDER BY c.created_at DESC
    LIMIT 80
  `).all()).results as Row[];
  const abandoned = rows.map((r) => ({
    ...r,
    status: checkoutStatus((r.created_at as string) ?? null, (r.expires_at as string) ?? null),
  }));
  return {
    started: Number(totals?.started) || 0,
    paid: Number(totals?.paid) || 0,
    abandoned_count: Number(totals?.abandoned) || 0,
    abandoned_cents: Number(totals?.abandoned_cents) || 0,
    abandoned,
  };
}

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
      SELECT email, tier, created_at, orders_used, quota,
             COALESCE(available_cents,0) AS available_cents,
             COALESCE(held_cents,0) AS held_cents
      FROM accounts
      ORDER BY created_at DESC LIMIT 50
    `);
    const wallets = await one<Row>(`
      SELECT COALESCE(SUM(available_cents),0) AS available_cents,
             COALESCE(SUM(held_cents),0) AS held_cents,
             SUM(CASE WHEN COALESCE(available_cents,0) > 0 OR COALESCE(held_cents,0) > 0 THEN 1 ELSE 0 END) AS funded_accounts
      FROM accounts
    `);
    const orders = await one<Row>(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN created_at >= datetime('now','-7 day') THEN 1 ELSE 0 END) AS new_7d,
             SUM(CASE WHEN state IN ('human_review','submitted','held') THEN 1 ELSE 0 END) AS in_review,
             COALESCE(SUM(listed_price_cents),0) AS listed_cents
      FROM placement_orders
    `);
    const niches = await many(`
      SELECT COALESCE(NULLIF(niche,''),'(none)') AS niche,
             COUNT(*) AS sites,
             ROUND(AVG(cite_score),1) AS avg_score,
             SUM(CASE WHEN listed_price IS NOT NULL THEN 1 ELSE 0 END) AS priced
      FROM sites GROUP BY 1 ORDER BY sites DESC LIMIT 12
    `);
    // Unmet demand: searches that returned nothing. Each one is a gap in
    // inventory an agent actually wanted.
    const unmet = await many(`
      SELECT args, COUNT(*) AS times FROM query_log
      WHERE tool IN ('search_publishers','search_sites') AND result_count = 0
      GROUP BY args ORDER BY times DESC LIMIT 25
    `);
    const recentArgs = await many(`
      SELECT args FROM query_log WHERE tool IN ('search_publishers','search_sites') AND args IS NOT NULL
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
             COUNT(*) AS total_sites
      FROM sites WHERE ${PAID}
    `);
    // The free catalog's readiness is a different question: how much of it has
    // actually been confirmed against a live page.
    const oppReadiness = await one<Row>(`
      SELECT COUNT(*) AS opportunities,
             SUM(CASE WHEN needs_reverification = 1 THEN 1 ELSE 0 END) AS opportunities_unverified
      FROM opportunities WHERE status = 'active'
    `);
    Object.assign(readiness as Row, oppReadiness as Row);
    const queryTotal = Number(activity.queries_total) || 0;
    const zeroCalls = (byTool as Row[]).reduce((n, t) => n + (Number(t.zero_result_calls) || 0), 0);
    activity.zero_result_rate = queryTotal ? Math.round((1000 * zeroCalls) / queryTotal) / 10 : 0;
    const funded = Number(wallets.funded_accounts) || 0;
    const checkouts = await loadCheckouts(env);
    return {
      accounts, activity, by_tool: byTool, daily, signups,
      unmet_demand: unmet, top_topics: topTopics,
      free_placements_by_site: freeOrders, inventory_readiness: readiness,
      wallets, orders, niches, checkouts,
      abandoned_checkouts: checkouts.abandoned,
      funnel: {
        anonymous_queries: activity.anonymous_queries ?? 0,
        signups: accounts.total ?? 0,
        funded_accounts: funded,
        checkouts_started: checkouts.started,
        checkouts_paid: checkouts.paid,
        abandoned_checkouts: checkouts.abandoned_count,
        orders: Number(orders.total) || 0,
        free_placements_claimed: accounts.free_placements_claimed ?? 0,
        paid_customers: funded,
        note: 'Looking is free. Prepaid credits are required to book. Orders stay in /admin until ops copy and send them.',
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
  // demand signal that decides whether the paid path gets built (SPEC §15).
  if (path === '/admin/api/analytics' && req.method === 'GET') {
    return json(await computeAnalytics(env));
  }

  if (path === '/admin/api/checkouts' && req.method === 'GET') {
    return json(await loadCheckouts(env));
  }

  // ---- free opportunities ----
  // Operators see everything, including the watchlist and the private source
  // URLs. The buyer MCP sees a whitelist; this is the other side of that line.
  if (path === '/admin/api/opportunities' && req.method === 'GET') {
    const u = new URL(req.url);
    const clauses: string[] = [];
    const params: unknown[] = [];
    const status = u.searchParams.get('status') ?? 'active';
    if (status) { clauses.push('o.status = ?'); params.push(status); }
    const contribution = u.searchParams.get('contribution');
    if (contribution) { clauses.push('o.contribution = ?'); params.push(contribution); }
    const cost = u.searchParams.get('cost');
    if (cost === 'free') clauses.push('o.is_free_confirmed = 1');
    if (cost === 'unknown') clauses.push("o.cost_confidence = 'unknown'");
    const verified = u.searchParams.get('verified');
    if (verified === 'needs') clauses.push('o.needs_reverification = 1');
    if (verified === 'done') clauses.push('o.needs_reverification = 0');
    const q = u.searchParams.get('q');
    if (q) {
      clauses.push('(o.platform LIKE ? OR o.domain LIKE ? OR o.opportunity_type LIKE ? OR o.niche LIKE ? OR o.note LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sortable = ['platform', 'contribution', 'opportunity_type', 'niche', 'cost_model', 'priority_score', 'prep_minutes', 'verification_level', 'status'];
    const sort = sortable.includes(u.searchParams.get('sort') ?? '') ? u.searchParams.get('sort')! : 'priority_score';
    const dir = u.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, Number(u.searchParams.get('page') ?? 1));
    const perPage = 50;

    const total = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM opportunities o ${where}`)
      .bind(...params).first()) as { n: number } | null)?.n ?? 0;
    const rows = (await env.DB.prepare(`
      SELECT o.* FROM opportunities o ${where}
      ORDER BY o.${sort} ${dir}, o.platform ASC
      LIMIT ? OFFSET ?
    `).bind(...params, perPage, (page - 1) * perPage).all()).results as Row[];
    return json({ opportunities: rows, total, page, per_page: perPage, sort, dir: dir.toLowerCase() });
  }

  const oppPatch = /^\/admin\/api\/opportunities\/([A-Za-z0-9_.:-]+)$/.exec(path);
  if (oppPatch && req.method === 'PATCH') {
    const id = oppPatch[1];
    const body = (await req.json().catch(() => ({}))) as Row;
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof body.status === 'string') {
      if (!['active', 'watchlist', 'retired'].includes(body.status)) {
        return json({ error: 'BAD_STATUS', allowed: ['active', 'watchlist', 'retired'] }, 400);
      }
      sets.push('status = ?');
      params.push(body.status);
    }
    // An operator confirming a live page is the only thing that clears the
    // template flag — nothing automatic may mark a row verified.
    if (body.verified === true) {
      sets.push(
        "needs_reverification = 0",
        "verification_level = 'Operator confirmed on the live page'",
        "last_checked = date('now')",
        "verified_at = datetime('now')",
        "verify_source = 'operator'",
      );
    }
    for (const field of ['cost_model', 'note', 'agent_instructions', 'link_attribute_claim'] as const) {
      if (typeof body[field] === 'string') { sets.push(`${field} = ?`); params.push(body[field]); }
    }
    if (!sets.length) return json({ error: 'NOTHING_TO_UPDATE' }, 400);
    sets.push("updated_at = datetime('now')");
    await env.DB.prepare(`UPDATE opportunities SET ${sets.join(', ')} WHERE id = ?`).bind(...params, id).run();
    const row = (await env.DB.prepare(`SELECT * FROM opportunities WHERE id = ?`).bind(id).first()) as Row | null;
    if (!row) return json({ error: 'OPPORTUNITY_NOT_FOUND', id }, 404);
    return json({ opportunity: row });
  }

  if (path === '/admin/api/submissions' && req.method === 'GET') {
    const rows = (await env.DB.prepare(`
      SELECT s.id, s.state, s.published_url, s.observed_rel, s.observed_indexed, s.reference,
             s.account_owner, s.updated_at, c.canonical_url AS company_url, c.name AS company_name,
             o.platform, o.contribution, o.submission_url
      FROM submissions s
      LEFT JOIN company_profiles c ON c.id = s.company_id
      LEFT JOIN opportunities o ON o.id = s.opportunity_id
      ORDER BY s.updated_at DESC LIMIT 200
    `).all()).results as Row[];
    const byState: Record<string, number> = {};
    for (const r of rows) byState[String(r.state)] = (byState[String(r.state)] ?? 0) + 1;
    const companies = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM company_profiles`).first()) as { n: number } | null)?.n ?? 0;
    return json({ submissions: rows, total: rows.length, by_state: byState, companies });
  }

  if (path === '/admin/api/orders' && req.method === 'GET') {
    const rows = (await env.DB.prepare(`
      SELECT o.id, o.state, o.publisher_id, s.domain, o.target_url, o.anchor_text, o.title,
             o.body, o.author_bio, o.listed_price_cents, o.word_count, o.created_at, a.email AS buyer_email
      FROM placement_orders o
      LEFT JOIN sites s ON s.id = o.publisher_id
      LEFT JOIN accounts a ON a.api_key = o.api_key
      ORDER BY o.created_at DESC
      LIMIT 100
    `).all()).results as Row[];
    return json({ orders: rows });
  }

  // Per-person admin MCP keys (SPEC §16). Minted only for a real Shortlist
  // sign-in — a break-glass token session cannot create one.
  if (path === '/admin/api/keys') {
    const session = await readSession(req, env);
    if (!session?.is_admin) return json({ error: 'UNAUTHORIZED', sign_in: '/auth/login' }, 401);

    if (req.method === 'GET') {
      const rows = (await env.DB.prepare(`
        SELECT key, label, created_at, last_used_at, revoked_at FROM admin_keys
        WHERE sub = ? ORDER BY created_at DESC
      `).bind(session.sub).all()).results as Row[];
      return json({
        keys: rows.map((r) => ({
          // Never return a whole key again — it is shown once at creation.
          masked: `${(r.key as string).slice(0, 12)}…${(r.key as string).slice(-4)}`,
          label: r.label,
          created_at: r.created_at,
          last_used_at: r.last_used_at,
          revoked: !!r.revoked_at,
        })),
        mcp_url: `${productOrigin(req.url)}/admin/mcp`,
      });
    }

    if (req.method === 'POST') {
      if (session.sub === TOKEN_SUB) {
        return json({
          error: 'SSO_REQUIRED',
          message: 'Personal keys are tied to a Shortlist account. Sign in with Shortlist first.',
          sign_in: '/auth/login',
        }, 403);
      }
      const body = (await req.json().catch(() => ({}))) as Row;
      const key = `cka_${crypto.randomUUID().replace(/-/g, '')}`;
      await env.DB.prepare(`
        INSERT INTO admin_keys (key, sub, label, created_at) VALUES (?, ?, ?, datetime('now'))
      `).bind(key, session.sub, (body.label as string) || 'admin MCP', ).run();
      const origin = productOrigin(req.url);
      return json({
        key,                       // shown once
        mcp_url: `${origin}/admin/mcp`,
        connect_command: `claude mcp add --transport http placement-admin ${origin}/admin/mcp --header "Authorization: Bearer ${key}"`,
        connector_url: `${origin}/admin/mcp/${key}`,
        note: 'Copy this now — it is not shown again. Revoke it any time from the console. The URL is always https://placement.sh — do not use any other hostname.',
      }, 201);
    }

    return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  // Revoke by full key or by the prefix the console displays — whole keys are
  // never returned after creation, so the UI only ever has the prefix.
  const revokeMatch = path.match(/^\/admin\/api\/keys\/(cka_[a-z0-9]{4,})$/);
  if (revokeMatch && req.method === 'DELETE') {
    const session = await readSession(req, env);
    if (!session?.is_admin) return json({ error: 'UNAUTHORIZED', sign_in: '/auth/login' }, 401);
    const ref = revokeMatch[1];
    const row = (await env.DB.prepare(`
      SELECT key FROM admin_keys WHERE sub = ? AND revoked_at IS NULL AND (key = ? OR key LIKE ?)
    `).bind(session.sub, ref, `${ref}%`).first()) as Row | null;
    if (!row) return json({ error: 'KEY_NOT_FOUND' }, 404);
    await env.DB.prepare(`UPDATE admin_keys SET revoked_at = datetime('now') WHERE key = ?`)
      .bind(row.key).run();
    return json({ revoked: true });
  }

  if (path === '/admin/api/stats' && req.method === 'GET') {
    // Paid and free are two different sections of the console, so the money
    // numbers (priced / markup / margin / link-attr gap) only count paid rows.
    const totals = await env.DB.prepare(`
      SELECT COUNT(*) AS sites,
             SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN ${PAID} THEN 1 ELSE 0 END) AS paid_sites,
             SUM(CASE WHEN ${FREE} THEN 1 ELSE 0 END) AS free_sites,
             SUM(CASE WHEN ${PAID} AND listed_price IS NOT NULL AND listed_price > 0 THEN 1 ELSE 0 END) AS priced,
             SUM(CASE WHEN ${PAID} AND (listed_price IS NULL OR listed_price = 0) THEN 1 ELSE 0 END) AS paid_unpriced,
             ROUND(AVG(CASE WHEN ${PAID} THEN markup END),2) AS avg_markup,
             ROUND(AVG(CASE WHEN ${PAID} AND seller_price>0 THEN listed_price-seller_price END),2) AS avg_margin,
             SUM(CASE WHEN ${PAID} AND link_attribute='unknown' THEN 1 ELSE 0 END) AS attr_unknown
      FROM sites
    `).first();
    const opps = await env.DB.prepare(`
      SELECT COUNT(*) AS opportunities,
             SUM(CASE WHEN needs_reverification = 1 THEN 1 ELSE 0 END) AS opportunities_unverified,
             SUM(CASE WHEN is_free_confirmed = 1 THEN 1 ELSE 0 END) AS opportunities_free_confirmed
      FROM opportunities WHERE status = 'active'
    `).first();
    return json({ ...(totals as Row), ...(opps as Row) });
  }

  if (path === '/admin/api/sites' && req.method === 'GET') {
    const u = new URL(req.url);
    const q = u.searchParams.get('q');
    const niche = u.searchParams.get('niche');
    const status = u.searchParams.get('status');
    const costType = u.searchParams.get('cost_type');
    const mode = u.searchParams.get('acquisition_mode');
    const page = Math.max(1, parseInt(u.searchParams.get('page') ?? '1', 10));
    const sortKey = u.searchParams.get('sort') || 'cite_score';
    const sortDir = u.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
    const sortSql = SITE_SORT[sortKey] ?? SITE_SORT.cite_score;
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
      SELECT sites.id, sites.domain, sites.niche, sites.subniche, sites.cite_score, sites.traffic_band,
             sites.seller_price, sites.markup, sites.listed_price,
             sites.link_attribute, sites.max_links_per_post, sites.turnaround_sla_days, sites.status,
             sites.contact_email, sites.note,
             sites.dr, sites.traffic, sites.ahrefs_organic_keywords, sites.ahrefs_referring_domains,
             sites.ahrefs_backlinks, sites.ahrefs_rank, sites.ahrefs_organic_value,
             COALESCE(sites.cost_type,'paid') AS cost_type,
             COALESCE(sites.acquisition_mode,'paid_placement') AS acquisition_mode,
             sites.requires_reciprocal_link, sites.agent_instructions,
             site_content.enrich_status, site_content.source AS content_source
      FROM sites
      LEFT JOIN site_content ON site_content.site_id = sites.id
      WHERE ${where}
      ORDER BY ${sortSql} IS NULL, ${sortSql} ${sortDir} LIMIT ? OFFSET ?
    `).bind(...params, per, (page - 1) * per).all()).results as Row[];
    for (const r of rows) {
      r.margin = r.listed_price != null && r.seller_price != null
        ? Math.round(((r.listed_price as number) - (r.seller_price as number)) * 100) / 100 : null;
    }
    return json({
      total: total.n, page, per_page: per, sort: sortSql === SITE_SORT[sortKey] ? sortKey : 'cite_score',
      dir: sortDir.toLowerCase(), sites: operatorSites(rows),
    });
  }

  const siteMatch = path.match(/^\/admin\/api\/sites\/(cs_[a-z0-9]+)$/);
  if (siteMatch && req.method === 'GET') {
    const id = siteMatch[1];
    const row = await env.DB.prepare(`
      SELECT sites.id, sites.domain, sites.niche, sites.subniche, sites.cite_score, sites.traffic_band,
             sites.seller_price, sites.markup, sites.listed_price,
             sites.link_attribute, sites.max_links_per_post, sites.turnaround_sla_days, sites.status,
             sites.contact_email, sites.contact_name, sites.note,
             sites.dr, sites.traffic, sites.ahrefs_organic_keywords, sites.ahrefs_referring_domains,
             sites.ahrefs_backlinks, sites.ahrefs_rank, sites.ahrefs_organic_value,
             COALESCE(sites.cost_type,'paid') AS cost_type,
             COALESCE(sites.acquisition_mode,'paid_placement') AS acquisition_mode,
             sites.requires_reciprocal_link, sites.agent_instructions,
             site_content.summary, site_content.writes_about, site_content.recent_titles,
             site_content.audience, site_content.tone, site_content.post_shape,
             site_content.typical_length_words, site_content.do_fit, site_content.dont_fit,
             site_content.summary_private, site_content.enrich_status,
             site_content.source AS content_source, site_content.enriched_at
      FROM sites
      LEFT JOIN site_content ON site_content.site_id = sites.id
      WHERE sites.id = ?
    `).bind(id).first() as Row | null;
    if (!row) return json({ error: 'SITE_NOT_FOUND', id }, 404);
    return json({ site: operatorSiteDetail(row) });
  }
  if (siteMatch && req.method === 'PATCH') {
    const id = siteMatch[1];
    const body = (await req.json()) as Row;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const field of EDITABLE) {
      if (!(field in body)) continue;
      const v = body[field];
      if (field === 'status' && !STATUSES.includes(v as string)) return json({ error: 'BAD_STATUS', allowed: STATUSES }, 400);
      if (field === 'link_attribute' && !LINK_ATTRS.includes(v as string)) return json({ error: 'BAD_LINK_ATTRIBUTE', allowed: LINK_ATTRS }, 400);
      if (field === 'acquisition_mode' && !ACQUISITION_MODES.includes(v as string)) return json({ error: 'BAD_ACQUISITION_MODE', allowed: ACQUISITION_MODES }, 400);
      if (field === 'cost_type' && !COST_TYPES.includes(v as string)) return json({ error: 'BAD_COST_TYPE', allowed: COST_TYPES }, 400);
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
    return json({ ok: true, site: operatorSite(row as Row) });
  }

  if (path === '/admin/api/sites' && req.method === 'POST') {
    const b = (await req.json()) as Row;
    if (!b.domain || typeof b.domain !== 'string' || !b.domain.includes('.')) return json({ error: 'DOMAIN_REQUIRED' }, 400);
    const domain = b.domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (b.cost_type != null && !COST_TYPES.includes(b.cost_type as string)) {
      return json({ error: 'BAD_COST_TYPE', allowed: COST_TYPES }, 400);
    }
    if (b.acquisition_mode != null && !ACQUISITION_MODES.includes(b.acquisition_mode as string)) {
      return json({ error: 'BAD_ACQUISITION_MODE', allowed: ACQUISITION_MODES }, 400);
    }
    const id = `cs_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    // A site lands in the free section when it is added there. Free rows carry
    // no seller price, so nothing can compute a listed price for them and they
    // stay invisible to the buyer MCP (buyerWhere).
    const costType = b.cost_type === 'free' ? 'free' : 'paid';
    const isFree = costType === 'free';
    const seller = !isFree && typeof b.seller_price === 'number' ? b.seller_price : null;
    const markup = typeof b.markup === 'number' ? b.markup : 1.6;
    const mode = (b.acquisition_mode as string) ?? (isFree ? 'apply_editorial' : 'paid_placement');
    await env.DB.prepare(`
      INSERT INTO sites (id, domain, niche, subniche, contact_name, contact_email, note,
                         seller_price, markup, listed_price, link_attribute,
                         cost_type, acquisition_mode, requires_reciprocal_link, agent_instructions,
                         status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',datetime('now'))
    `).bind(
      id, domain, b.niche ?? null, b.subniche ?? null, b.contact_name ?? null, b.contact_email ?? null,
      b.note ?? null, seller, markup, seller && seller > 0 ? listedPrice(seller, markup) : null,
      LINK_ATTRS.includes(b.link_attribute as string) ? b.link_attribute : 'unknown',
      costType, mode, b.requires_reciprocal_link ? 1 : 0, b.agent_instructions ?? null,
    ).run();
    return json({ ok: true, id, domain, cost_type: costType, acquisition_mode: mode }, 201);
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
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

// ---------- engine data panels (SPEC §18) ----------
// Each panel resolves its tool from tools/list and degrades on its own: a role
// that cannot read signals still gets the rest of the page.
async function handleEngineApi(req: Request, env: Env, path: string, session: Session): Promise<Response> {
  if (!session.access_token) {
    // Break-glass token session: the console works, Shortlist data does not.
    return json({
      error: 'NO_ENGINE_TOKEN',
      mode: session.sub === TOKEN_SUB ? 'operator_token' : 'no_token',
      message: 'Signed in with the operator token — Shortlist data needs a Shortlist sign-in.',
      sign_in: '/auth/login',
    }, 200);
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
        cost_type: { type: 'string', enum: COST_TYPES },
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
    description: 'Push refreshed Ahrefs overview stats for a publisher (domain_rating/dr, organic_traffic/traffic, organic_keywords, referring_domains, backlinks, ahrefs_rank, organic_value) and recompute Placement Score (50% Ahrefs DR + 50% Ahrefs organic traffic). Moz DA, Majestic TF/CF, and Moz spam are not accepted or used.',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' }, domain: { type: 'string' },
        dr: { type: 'number' }, domain_rating: { type: 'number' },
        traffic: { type: 'number' }, organic_traffic: { type: 'number' },
        organic_keywords: { type: 'number' }, referring_domains: { type: 'number' },
        backlinks: { type: 'number' }, ahrefs_rank: { type: 'number' },
        organic_value: { type: 'number' },
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
    description: 'Signups, funded wallets, unfinished Stripe Checkouts, orders, query volume, top searched topics, unmet demand, inventory mix, and readiness.',
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
    if (k === 'cost_type' && !COST_TYPES.includes(v as string)) return `Bad cost_type. Allowed: ${COST_TYPES.join(', ')}`;
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
        SELECT id, domain, niche, subniche, cite_score, dr, traffic, traffic_band,
               ahrefs_organic_keywords, ahrefs_referring_domains, ahrefs_backlinks,
               ahrefs_rank, ahrefs_organic_value,
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
      return { matched: total.n, returned: rows.length, sites: operatorSites(rows) };
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
      const numArg = (...keys: string[]): number | undefined => {
        for (const k of keys) if (typeof args[k] === 'number') return args[k] as number;
        return undefined;
      };
      const keep = (v: unknown): number | null => (typeof v === 'number' ? v : null);
      const m = {
        dr: numArg('dr', 'domain_rating') ?? keep(site.dr),
        traffic: numArg('traffic', 'organic_traffic') ?? keep(site.traffic),
        ahrefs_organic_keywords: numArg('organic_keywords') ?? keep(site.ahrefs_organic_keywords),
        ahrefs_referring_domains: numArg('referring_domains') ?? keep(site.ahrefs_referring_domains),
        ahrefs_backlinks: numArg('backlinks') ?? keep(site.ahrefs_backlinks),
        ahrefs_rank: numArg('ahrefs_rank') ?? keep(site.ahrefs_rank),
        ahrefs_organic_value: numArg('organic_value') ?? keep(site.ahrefs_organic_value),
      };
      const score = ahrefsScore(m.dr, m.traffic);
      const band = trafficBand(m.traffic ?? 0);
      await env.DB.prepare(`
        UPDATE sites SET dr=?, traffic=?, traffic_band=?, cite_score=?,
                         ahrefs_organic_keywords=?, ahrefs_referring_domains=?, ahrefs_backlinks=?,
                         ahrefs_rank=?, ahrefs_organic_value=?,
                         metrics_updated_at=date('now'), updated_at=datetime('now')
        WHERE id = ?
      `).bind(
        m.dr, m.traffic, band, score,
        m.ahrefs_organic_keywords, m.ahrefs_referring_domains, m.ahrefs_backlinks,
        m.ahrefs_rank, m.ahrefs_organic_value, site.id,
      ).run();
      return {
        updated: true, site_id: site.id, domain: site.domain,
        metrics: operatorSite(m), traffic_band: band, cite_score: score,
      };
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
  const actor = await resolveAdminActor(req, env, tokenFromPath);
  if (!actor) {
    return json({
      error: 'UNAUTHORIZED',
      message: 'Send Authorization: Bearer <your personal key>. Get one from the console at /admin → Connect.',
    }, 401);
  }
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
      serverInfo: { name: 'placement.sh-admin', version: SERVER_VERSION },
      instructions: 'placement.sh operator console as tools. Full private data: domains, publisher contacts, seller prices, markup and margin. Bulk edits are dry-run by default — pass confirm:true to apply.',
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

async function handleStripeWebhook(req: Request, env: Env, ctx?: WaitUntil): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST Stripe events to this URL' }, 405);
  const raw = await req.text();
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return json({ error: 'webhook_not_configured' }, 503);
  const ok = await verifyStripeSignature(raw, req.headers.get('stripe-signature'), secret);
  if (!ok) return json({ error: 'invalid_signature' }, 400);
  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try { event = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400); }
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
    return json({ ok: true, ignored: event.type ?? null });
  }
  const session = event.data?.object as {
    id: string;
    customer?: string | null;
    metadata?: Record<string, string> | null;
    amount_total?: number | null;
    payment_status?: string | null;
    client_reference_id?: string | null;
  };
  if (!session?.id) return json({ error: 'missing_session' }, 400);
  const result = await applyCheckoutPaid(env, session);
  if (result.credited && result.email) {
    await scheduleMail(ctx, () => notifyCreditsAdded(env, result.email!, result.amount_cents ?? 0, result.available_cents ?? 0));
  }
  return json({ ok: true, credited: result.credited });
}

// ---------- router ----------
export default {
  async fetch(req: Request, env: Env, ctx?: WaitUntil): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    // www is a Custom Domain so TLS works; send browsers to the apex.
    if (url.hostname.toLowerCase() === 'www.placement.sh' && (req.method === 'GET' || req.method === 'HEAD')) {
      url.hostname = PRODUCT_HOST;
      return new Response(null, { status: 301, headers: { location: url.toString(), ...CORS } });
    }
    // The Worker still has a workers.dev hostname. Never hand that URL to a
    // human or an agent — Connect tabs, bookmarks, and SSO all live on placement.sh.
    if (isWorkersDev(url.hostname) && (req.method === 'GET' || req.method === 'HEAD')) {
      const dest = new URL(req.url);
      dest.protocol = 'https:';
      dest.hostname = PRODUCT_HOST;
      dest.port = '';
      return new Response(null, { status: 301, headers: { location: dest.toString(), ...CORS } });
    }
    const origin = productOrigin(url);
    if (url.pathname === '/mcp') return handleMcp(req, env, ctx);
    if (url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt') {
      return new Response(LLMS_TXT, { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
    }
    if (url.pathname === '/.well-known/mcp/server.json') {
      return json(serverJson(origin));
    }
    if (url.pathname === '/.well-known/mcp/server-card.json') {
      return json(serverCard(origin));
    }
    if (url.pathname === '/health') {
      const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM sites`).first()) as { n: number };
      return json({ ok: true, product: SERVER_NAME, publishers: n.n });
    }
    if (url.pathname === '/paid') {
      return new Response(paidPageHtml({ canceled: url.searchParams.get('canceled') === '1' }), {
        headers: { 'content-type': 'text/html; charset=utf-8', ...CORS },
      });
    }
    if (url.pathname === '/webhooks/stripe') return handleStripeWebhook(req, env, ctx);
    if (url.pathname.startsWith('/auth/')) return handleAuth(req, env, url.pathname);

    if (url.pathname === '/admin') {
      // Humans sign in with Shortlist. The operator token remains as a
      // break-glass into the console (ALLOW_TOKEN_CONSOLE="false" closes it)
      // so a broken engine can never lock the team out of their own inventory.
      const supplied = url.searchParams.get('token');
      if (supplied && tokenConsoleAllowed(env) && env.ADMIN_TOKEN && tokenMatches(supplied, env.ADMIN_TOKEN)) {
        return new Response(null, {
          status: 302,
          headers: { location: '/admin', 'set-cookie': await createTokenSession(env) },
        });
      }
      const session = await readSession(req, env);
      if (!session?.is_admin) {
        return new Response(signInPage({
          configured: !!env.OIDC_CLIENT_ID && !!env.OIDC_CLIENT_SECRET,
          error: supplied ? 'That operator token is not valid.' : undefined,
          tokenFallback: tokenConsoleAllowed(env) && !!env.ADMIN_TOKEN,
        }), {
          status: session || supplied ? 403 : 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
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
      const accept = req.headers.get('accept') ?? '';
      if (accept.includes('text/html')) {
        return new Response(homepageHtml(origin), {
          headers: { 'content-type': 'text/html; charset=utf-8', ...CORS },
        });
      }
      return new Response(
        homepageText(origin),
        { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } },
      );
    }
    // Unknown paths (incl. /.well-known/oauth-*) must 404 cleanly — a 200 here
    // makes MCP clients attempt OAuth registration against a non-existent IdP.
    return json({ error: 'NOT_FOUND', path: url.pathname }, 404);
  },
};

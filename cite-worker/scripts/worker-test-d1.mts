// Local smoke test: runs the Worker handler against an in-memory SQLite DB
// wrapped in the D1 interface. Usage: npx --prefix ../cite-mcp tsx scripts/worker-test-d1.mts
import BetterSqlite3 from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker, { type Env } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sq = new BetterSqlite3(':memory:');
sq.exec(readFileSync(join(here, '..', 'schema.sql'), 'utf8'));
sq.exec(`
  INSERT INTO sites (id, domain, contact_email, niche, seller_price, markup, listed_price, cite_score, traffic_band, status, link_attribute)
  VALUES ('cs_aaa111bbb222', 'secret-example.com', 'owner@secret-example.com', 'Business', 100, 1.6, 160, 88, '10k–50k/mo', 'active', 'unknown'),
         ('cs_ccc333ddd444', 'hidden-blog.net', 'ed@hidden-blog.net', 'Tech', 50, 1.6, 80, 62, '1k–5k/mo', 'active', 'unknown');
  INSERT INTO site_content (site_id, summary, writes_about) VALUES
    ('cs_aaa111bbb222', 'B2B finance guides.', '["finance","b2b"]');
`);

// minimal D1 shim over better-sqlite3
const d1 = {
  prepare(sql: string) {
    const stmt = sq.prepare(sql);
    const make = (args: unknown[]) => ({
      async all() { return { results: stmt.reader ? stmt.all(...args) : (stmt.run(...args), []) }; },
      async first() { return stmt.reader ? stmt.get(...args) ?? null : (stmt.run(...args), null); },
      async run() { return stmt.reader ? { results: stmt.all(...args) } : stmt.run(...args); },
      bind(...more: unknown[]) { return make([...args, ...more]); },
    });
    return make([]);
  },
} as unknown as Env['DB'];

const env: Env = { DB: d1, ADMIN_TOKEN: 'test-token-123' };
const f = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://cite.test${path}`, init), env);
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok: ${msg}`); };

// public surface
let r = await f('/health');
assert(r.status === 200 && (await r.json()).publishers === 2, 'health counts publishers from D1');
r = await f('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_publishers', arguments: { topics: ['finance'] } } }) });
let text = (await r.json()).result.content[0].text;
assert(text.includes('cs_aaa111bbb222'), 'search finds enriched site');
assert(!/secret-example|owner@|seller_price|markup/.test(text), 'public payload leaks nothing private');

// admin auth
r = await f('/admin/api/sites');
assert(r.status === 401, 'admin api 401 without token');
r = await f('/admin/api/sites', { headers: { authorization: 'Bearer wrong' } });
assert(r.status === 401, 'admin api 401 with wrong token');
const auth = { authorization: 'Bearer test-token-123', 'content-type': 'application/json' };
r = await f('/admin/api/sites?q=secret', { headers: auth });
let d = await r.json();
assert(d.total === 1 && d.sites[0].domain === 'secret-example.com' && d.sites[0].margin === 60, 'admin list returns private fields + margin');

// markup edit → listed price recompute (100 × 2.0 = 200)
r = await f('/admin/api/sites/cs_aaa111bbb222', { method: 'PATCH', headers: auth, body: JSON.stringify({ markup: 2.0 }) });
d = await r.json();
assert(d.site.listed_price === 200, `markup patch recomputes listed_price (got ${d.site.listed_price})`);

// seller price edit (80 × 2.0 = 160)
r = await f('/admin/api/sites/cs_aaa111bbb222', { method: 'PATCH', headers: auth, body: JSON.stringify({ seller_price: 80 }) });
d = await r.json();
assert(d.site.listed_price === 160, 'seller_price patch recomputes listed_price');

// link attribute backfill
r = await f('/admin/api/sites/cs_ccc333ddd444', { method: 'PATCH', headers: auth, body: JSON.stringify({ link_attribute: 'dofollow' }) });
d = await r.json();
assert(d.site.link_attribute === 'dofollow', 'link attribute editable');
r = await f('/admin/api/sites/cs_ccc333ddd444', { method: 'PATCH', headers: auth, body: JSON.stringify({ link_attribute: 'nope' }) });
assert(r.status === 400, 'invalid link attribute rejected');

// add site
r = await f('/admin/api/sites', { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'new-site.org', niche: 'Pets', seller_price: 40, markup: 2.5 }) });
d = await r.json();
assert(r.status === 201 && d.id.startsWith('cs_'), 'add site mints handle');
r = await f('/admin/api/sites?q=new-site', { headers: auth });
assert((await r.json()).sites[0].listed_price === 100, 'add site computes listed price (40×2.5=100)');

// stats + UI + discovery
r = await f('/admin/api/stats', { headers: auth });
assert((await r.json()).sites === 3, 'stats totals');
r = await f('/admin');
assert(r.status === 200 && (await r.text()).includes('operator console'), 'admin UI serves');
r = await f('/.well-known/oauth-protected-resource');
assert(r.status === 404, 'oauth discovery probes still 404');
r = await f('/llms.txt');
assert(r.status === 200 && (await r.text()).includes('placement.sh'), 'llms.txt served for agents');
r = await f('/.well-known/mcp/server.json');
assert((await r.json()).name === 'sh.placement/mcp', 'MCP registry server.json');
r = await f('/');
assert((await r.text()).includes('claude mcp add --transport http placement'), 'homepage install command');

console.log('\nall checks passed');

// ---- free sites, metrics ladder, accounts, admin MCP ----
sq.exec(`
  UPDATE sites SET dr=88, da=54, tf=40, cf=50, traffic=25000 WHERE id='cs_aaa111bbb222';
  INSERT INTO sites (id, domain, niche, seller_price, markup, listed_price, cite_score, traffic_band, status, link_attribute, acquisition_mode, cost_type, agent_instructions)
  VALUES ('cs_free00self01','free-platform.test','Tech',0,1.6,0,70,'250k+/mo','active','nofollow','self_serve','free','Register and publish directly.'),
         ('cs_exchange0001','swap-site.test','Tech',0,1.6,0,60,'1k-5k/mo','active','dofollow','link_exchange','free',NULL);
`);

const call = async (tool: string, args: Record<string, unknown> = {}, key?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await f('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: tool, arguments: args } }) });
  return JSON.parse((await res.json()).result.content[0].text);
};

// metrics ladder
let g = await call('get_publisher', { publisher_id: 'cs_aaa111bbb222' });
assert(g.ahrefs_domain_rating === 88, 'exact Ahrefs DR exposed');
assert(g.da_band === 'DA 50–59', `DA banded not exact (got ${g.da_band})`);
assert(g.trust_ratio === 'strong', `TF/CF exposed as a band (got ${g.trust_ratio})`);
assert(!('da' in g) && !('tf' in g) && !('traffic' in g), 'exact DA/TF/traffic absent from public payload');
assert(typeof g.metrics_attribution === 'string', 'Ahrefs attribution present');
assert(g.placement_score === 88 && !('cite_score' in g) && !('site_id' in g), 'public fields use publisher/placement_score');
assert(!JSON.stringify(g).includes('secret-example'), 'domain still blind in get_publisher');

// free-site filters + link_exchange exclusion
let s = await call('search_publishers', { cost_type: 'free' });
const ids = s.publishers.map((x: { publisher_id: string }) => x.publisher_id);
assert(ids.includes('cs_free00self01'), 'free self_serve publisher returned by cost_type filter');
assert(!ids.includes('cs_exchange0001'), 'link_exchange excluded from search by default');
s = await call('search_publishers', {});
assert(!s.publishers.map((x: { publisher_id: string }) => x.publisher_id).includes('cs_exchange0001'), 'link_exchange excluded from default search');

// anonymous cap
assert(s.result_limit === 10, `anonymous result cap is 10 (got ${s.result_limit})`);

// accounts
let a = await call('register_account', { email: 'not-an-email' });
assert(a.error === 'INVALID_EMAIL', 'bad email rejected');
a = await call('register_account', { email: 'Agent@Example.com' });
assert(typeof a.api_key === 'string' && a.api_key.startsWith('ck_'), 'register_account mints a key');
const apiKey = a.api_key;
const again = await call('register_account', { email: 'agent@example.com' });
assert(again.api_key === apiKey, 'same email returns the same key (case-insensitive)');
s = await call('search_publishers', {}, apiKey);
assert(s.result_limit === 50, 'account key raises result cap to 50');
let st = await call('account_status', {}, apiKey);
assert(st.tier === 'free' && st.free_placements_remaining === 10, 'account_status reports quota');

let h = await call('help');
assert(h.call_first === 'estimate' && h.product === 'placement.sh', 'help orients agents');
let camp = await call('create_campaign', { target_url: 'https://buyer.test', topics: ['finance'], budget: 4000 });
assert(camp.error === 'INSUFFICIENT_CREDIT', 'paid campaign is a credit stub');
let est = await call('estimate', { topics: ['finance'], budget: 4000, target_url: 'https://buyer.test/pricing' });
assert(est.target_url === 'https://buyer.test/pricing' && Array.isArray(est.plan), 'estimate accepts target_url');

// free placement claim
let c = await call('claim_free_placement', { publisher_id: 'cs_free00self01', target_url: 'https://buyer.test/pricing' });
assert(c.error === 'ACCOUNT_REQUIRED', 'claim requires an account');
c = await call('claim_free_placement', { publisher_id: 'cs_free00self01', target_url: 'https://buyer.test/pricing' }, apiKey);
assert(c.claimed === true && c.domain === 'free-platform.test', 'self_serve claim releases the domain so the agent can publish');
assert(typeof c.agent_instructions === 'string', 'claim returns the agent playbook');
c = await call('claim_free_placement', { publisher_id: 'cs_aaa111bbb222', target_url: 'https://buyer.test/x' }, apiKey);
assert(c.error === 'NOT_FREE_INVENTORY', 'paid publisher rejects a free claim');
c = await call('claim_free_placement', { publisher_id: 'cs_exchange0001', target_url: 'https://buyer.test/x' }, apiKey);
assert(c.error === 'PUBLISHER_UNAVAILABLE', 'link_exchange publisher cannot be claimed');

// query log populated
const logged = sq.prepare('SELECT COUNT(*) AS n FROM query_log').get() as { n: number };
assert(logged.n > 0, `query_log records calls (${logged.n})`);

// ---- admin MCP ----
const adminCall = async (tool: string, args: Record<string, unknown> = {}, token = 'test-token-123') => {
  const res = await f('/admin/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  return JSON.parse((await res.json()).result.content[0].text);
};
r = await f('/admin/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert(r.status === 401, 'admin MCP rejects unauthenticated calls');
r = await f('/admin/mcp/test-token-123', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
assert(r.status === 200 && (await r.json()).result.tools.length === 6, 'admin MCP path-token auth works, 6 tools');

let ad = await adminCall('admin_search_sites', { q: 'secret' });
assert(ad.sites[0].domain === 'secret-example.com' && ad.sites[0].seller_price === 80, 'admin MCP returns private fields');
ad = await adminCall('admin_update_site', { domain: 'secret-example.com', fields: { markup: 3 } });
assert(ad.listed_price === 240, `admin_update_site recomputes listed price (got ${ad.listed_price})`);
ad = await adminCall('admin_update_site', { domain: 'secret-example.com', fields: { evil_column: 1 } });
assert(ad.error === 'INVALID_FIELDS', 'admin_update_site rejects non-editable fields');
ad = await adminCall('admin_bulk_update', { filter: { niche: 'Tech' }, set: { link_attribute: 'dofollow' } });
assert(ad.dry_run === true && ad.would_affect >= 1, 'bulk update dry-runs by default');
ad = await adminCall('admin_bulk_update', { filter: { niche: 'Tech' }, set: { link_attribute: 'dofollow' }, confirm: true });
assert(ad.updated === true, 'bulk update applies with confirm');
const dofollowNow = sq.prepare("SELECT COUNT(*) AS n FROM sites WHERE niche='Tech' AND link_attribute='dofollow'").get() as { n: number };
assert(dofollowNow.n >= 1, 'bulk update wrote link_attribute');
ad = await adminCall('admin_update_metrics', { domain: 'secret-example.com', dr: 91, traffic: 500000 });
assert(ad.cite_score > 0 && ad.traffic_band === '250k+/mo', 'admin_update_metrics recomputes score and band');
ad = await adminCall('admin_add_site', { domain: 'brand-new.test', niche: 'Pets', seller_price: 40, markup: 2.5 });
assert(ad.added === true && ad.listed_price === 100, 'admin_add_site computes listed price');
ad = await adminCall('admin_analytics', {});
assert(ad.accounts.total === 1 && ad.activity.queries_total > 0, 'admin_analytics reports signups and queries');
assert(Array.isArray(ad.top_topics) && Array.isArray(ad.unmet_demand), 'analytics includes demand views');

console.log('\nall extended checks passed');

// ============ SSO: stubbed issuer + stubbed engine ============
// The real endpoints are unreachable from CI, so both are stubbed at fetch
// level. oauth4webapi still does the real work: PKCE, state, and full
// id_token validation against a JWKS we generate here.
const ISSUER = 'https://engine.test';
const CLIENT_ID = 'test-client-id';

const kp = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function makeIdToken(claims: Record<string, unknown>) {
  const header = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
  const payload = b64uStr(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64u(sig)}`;
}

let tokenEndpointMode: 'ok' | 'invalid_client' = 'ok';
let lastTokenAuthHeader = '';
let engineAbilities = ['*:read', 'entities:read', 'signals:read'];
let engineMode: 'ok' | 'unauthorized' | 'scope_denied' = 'ok';
let engineCalls = 0;
let lastAuthHeader = '';
let lastNonce = '';

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  // Only the MCP calls are JSON; the token request is form-encoded.
  let body: any = null;
  if (init?.body && typeof init.body === 'string' && init.body.trimStart().startsWith('{')) {
    try { body = JSON.parse(init.body); } catch { body = null; }
  }

  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return new Response(JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      scopes_supported: ['openid', 'profile', 'email', '*:read', 'briefs:assemble'],
    }), { headers: { 'content-type': 'application/json' } });
  }
  if (url === `${ISSUER}/jwks`) {
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }] }),
      { headers: { 'content-type': 'application/json' } });
  }
  if (url === `${ISSUER}/token`) {
    lastTokenAuthHeader = (init?.headers as Record<string, string>)?.authorization ?? '';
    if (tokenEndpointMode === 'invalid_client') {
      return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'client authentication failed' }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    }
    const form = new URLSearchParams(init!.body as string);
    if (!form.get('code_verifier')) return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const now = Math.floor(Date.now() / 1000);
    const id_token = await makeIdToken({
      iss: ISSUER, aud: CLIENT_ID, sub: 'engine-user-1', exp: now + 3600, iat: now,
      nonce: lastNonce, email: 'ops@shortlist.io', name: 'Ops Person',
    });
    return new Response(JSON.stringify({
      access_token: 'engine-access-token', token_type: 'bearer', expires_in: 3600, id_token,
    }), { headers: { 'content-type': 'application/json' } });
  }
  if (url === `${ISSUER}/mcp`) {
    engineCalls++;
    lastAuthHeader = (init?.headers as Record<string, string>)?.authorization ?? '';
    if (engineMode === 'unauthorized') return new Response('nope', { status: 401 });
    if (body?.method === 'tools/list') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [
        { name: 'probe-tool', available: true }, { name: 'recent-tool', available: true, required_scope: 'entities:read' },
        { name: 'signals-tool', available: true, required_scope: 'signals:read' },
        { name: 'search-tool', available: null },
      ] } }), { headers: { 'content-type': 'application/json' } });
    }
    const toolName = body?.params?.name;
    if (engineMode === 'scope_denied' && toolName === 'signals-tool') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'AuthorizationException: missing scope signals:read' } }),
        { headers: { 'content-type': 'application/json' } });
    }
    const payload = toolName === 'probe-tool'
      ? { engine: { key: 'shortlist', display_name: 'Shortlist' }, abilities: engineAbilities, ability_count: engineAbilities.length }
      : toolName === 'recent-tool' ? { results: [{ type: 'company', slug: 'acme', updated_at: '2026-08-17' }] }
      : toolName === 'signals-tool' ? { signals: [{ title: 'A risk', kind: 'risk' }] }
      : { results: [{ entity_ref: 'company::acme', excerpt: 'match' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }),
      { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const ssoEnv: Env = {
  ...env,
  OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: 'shh',
  OIDC_REDIRECT_URI: 'https://cite.test/auth/callback',
  ENGINE_MCP_URL: `${ISSUER}/mcp`, SESSION_SECRET: 'session-signing-secret',
} as Env;
const fs2 = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://cite.test${path}`, init), ssoEnv);

// unauthenticated console → sign-in page with the required button label
r = await fs2('/admin');
let page = await r.text();
assert(r.status === 200 && page.includes('Sign in with Shortlist'), 'console shows the Sign in with Shortlist button');
assert(page.indexOf('Sign in with Shortlist') < page.indexOf('operator token'),
  'SSO is the primary path; the operator token is a secondary fallback');

// the old shared token must no longer open the web console
r = await fs2('/admin', { headers: { authorization: 'Bearer test-token-123' } });
assert((await r.text()).includes('Sign in with Shortlist'), 'a bearer header alone does not open the web console');

// login redirect: PKCE S256 + state + nonce + exact scopes
r = await fs2('/auth/login');
assert(r.status === 302, 'login redirects to the engine');
const authUrl = new URL(r.headers.get('location')!);
assert(authUrl.origin + authUrl.pathname === `${ISSUER}/authorize`, 'authorize endpoint came from discovery');
assert(authUrl.searchParams.get('code_challenge_method') === 'S256', 'PKCE S256 requested');
assert(!!authUrl.searchParams.get('code_challenge'), 'code_challenge present');
assert(!!authUrl.searchParams.get('state'), 'state present');
assert(!!authUrl.searchParams.get('nonce'), 'nonce present');
assert(authUrl.searchParams.get('scope') === 'openid profile email *:read briefs:assemble', 'exact scopes requested');
assert(!/users:manage|system:config/.test(authUrl.searchParams.get('scope')!), 'no administrative scopes requested');
lastNonce = authUrl.searchParams.get('nonce')!;
const goodState = authUrl.searchParams.get('state')!;

// forged state is rejected
r = await fs2('/auth/callback?code=abc&state=not-a-real-state');
assert(r.status === 400 && (await r.text()).includes('expired or was already used'), 'unknown state rejected');

// happy path
r = await fs2(`/auth/callback?code=abc&state=${goodState}`);
if (r.status !== 302) { const t = await r.clone().text(); const m = t.match(/<p class=\"err\">([\s\S]*?)<\/p>/); console.log('DEBUG error:', m ? m[1] : t.slice(0,300)); }
assert(r.status === 302 && r.headers.get('location') === '/admin', 'callback signs the person in');
const setCookie = r.headers.get('set-cookie')!;
assert(/HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie), 'session cookie is hardened');
const cookie = setCookie.split(';')[0];

assert(lastTokenAuthHeader === '', 'client auth followed discovery (client_secret_post, not basic)');

// state is single-use
r = await fs2(`/auth/callback?code=abc&state=${goodState}`);
assert(r.status === 400, 'state cannot be replayed');

// user row keyed on sub, not email
const userRow = sq.prepare('SELECT sub, email, name FROM users').get() as { sub: string; email: string; name: string };
assert(userRow.sub === 'engine-user-1' && userRow.email === 'ops@shortlist.io', 'user keyed on sub with claims stored');

// session opens the console and the admin API
r = await fs2('/admin', { headers: { cookie } });
assert((await r.text()).includes('operator console'), 'session opens the console');
r = await fs2('/admin/api/sites?q=secret', { headers: { cookie } });
const sitesPayload = await r.json();
assert(r.status === 200, 'session authorises the admin API');
assert(Array.isArray(sitesPayload.sites) && sitesPayload.sites.length > 0,
  'admin API returns actual rows to an SSO session');

// engine identity uses the same token from sign-in
r = await fs2('/admin/api/engine/me', { headers: { cookie } });
let me = await r.json();
assert(lastAuthHeader === 'Bearer engine-access-token', 'engine called with the sign-in access token');
assert(me.abilities.includes('*:read') && me.engine.display_name === 'Shortlist', 'probe-tool drives identity + abilities');
assert(me.panels.recent === 'recent-tool' && me.panels.signals === 'signals-tool', 'panels resolved from tools/list');

// caching: a second identical read must not hit the engine again
r = await fs2('/admin/api/engine/recent', { headers: { cookie } });
assert((await r.json()).data.results.length === 1, 'recent panel returns engine data');
const callsAfterFirst = engineCalls;
await fs2('/admin/api/engine/recent', { headers: { cookie } });
assert(engineCalls === callsAfterFirst, 'second read served from cache');

// scope denial degrades one panel only
engineMode = 'scope_denied';
r = await fs2('/admin/api/engine/signals', { headers: { cookie } });
let sig = await r.json();
assert(r.status === 200 && sig.error === 'SCOPE_DENIED', 'scope denial degrades the panel, not the page');
r = await fs2('/admin/api/sites', { headers: { cookie } });
assert(r.status === 200, 'rest of the console still works during a scope denial');

// engine 401 → send the person back to sign-in, never a silent empty dashboard
engineMode = 'unauthorized';
r = await fs2('/admin/api/engine/search?q=acme', { headers: { cookie } });
sig = await r.json();
assert(r.status === 401 && sig.error === 'ENGINE_UNAUTHORIZED' && sig.sign_in === '/auth/login', 'engine 401 routes back to sign-in');
engineMode = 'ok';

// a viewer-shaped token (no *:read, not allowlisted) is refused the console
engineAbilities = ['entities:read'];
r = await fs2('/auth/login');
lastNonce = new URL(r.headers.get('location')!).searchParams.get('nonce')!;
const viewerState = new URL(r.headers.get('location')!).searchParams.get('state')!;
r = await fs2(`/auth/callback?code=abc&state=${viewerState}`);
assert(r.status === 403 && (await r.text()).includes('does not have the access'), 'viewer role refused with an explanation');

// ...unless allowlisted by email
const allowEnv = { ...ssoEnv, CITE_ADMIN_EMAILS: 'ops@shortlist.io' } as Env;
const fs3 = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://cite.test${path}`, init), allowEnv);
r = await fs3('/auth/login');
lastNonce = new URL(r.headers.get('location')!).searchParams.get('nonce')!;
const allowState = new URL(r.headers.get('location')!).searchParams.get('state')!;
r = await fs3(`/auth/callback?code=abc&state=${allowState}`);
assert(r.status === 302, 'email allowlist overrides the ability check');
engineAbilities = ['*:read', 'entities:read', 'signals:read'];

// the admin MCP still runs on ADMIN_TOKEN — agents cannot do a browser flow
r = await fs2('/admin/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-token-123' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
assert(r.status === 200 && (await r.json()).result.tools.length === 6, 'admin MCP still accepts ADMIN_TOKEN');

// sign-out clears the session
r = await fs2('/auth/logout', { headers: { cookie } });
assert(r.status === 302 && /Max-Age=0/.test(r.headers.get('set-cookie')!), 'sign-out clears the cookie');
r = await fs2('/admin/api/sites', { headers: { cookie } });
assert(r.status === 401, 'destroyed session no longer authorises');

// unconfigured deployment says so instead of 500ing
const bareEnv = { DB: d1, ADMIN_TOKEN: 'test-token-123' } as Env;
r = await worker.fetch(new Request('https://cite.test/auth/login'), bareEnv);
assert(r.status === 503 && (await r.text()).includes("isn't configured"), 'missing OIDC config fails clearly');

// an OAuth error from the token endpoint must be reported, not swallowed
tokenEndpointMode = 'invalid_client';
r = await fs2('/auth/login');
lastNonce = new URL(r.headers.get('location')!).searchParams.get('nonce')!;
const errState = new URL(r.headers.get('location')!).searchParams.get('state')!;
r = await fs2(`/auth/callback?code=abc&state=${errState}`);
page = await r.text();
assert(page.includes('invalid_client') && page.includes('client authentication method'),
  'token-endpoint errors are surfaced with an actionable hint');
assert(page.includes('client authentication failed'), 'error_description is shown');
tokenEndpointMode = 'ok';

console.log('\nall SSO checks passed');

// ---- break-glass operator-token console ----
const bgEnv = { ...ssoEnv, ALLOW_TOKEN_CONSOLE: 'true' } as Env;
const fsb = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://cite.test${path}`, init), bgEnv);

r = await fsb('/admin');
assert((await r.text()).includes('Use the operator token instead'), 'sign-in page offers the token fallback');

r = await fsb('/admin?token=wrong-token');
assert(r.status === 403 && (await r.text()).includes('not valid'), 'wrong operator token refused');

r = await fsb('/admin?token=test-token-123');
assert(r.status === 302, 'correct operator token opens a session');
const bgCookie = r.headers.get('set-cookie')!.split(';')[0];
r = await fsb('/admin', { headers: { cookie: bgCookie } });
assert((await r.text()).includes('operator console'), 'token session reaches the console');
r = await fsb('/admin/api/sites', { headers: { cookie: bgCookie } });
assert(r.status === 200, 'token session can read inventory');
r = await fsb('/admin/api/engine/me', { headers: { cookie: bgCookie } });
const bgMe = await r.json();
assert(bgMe.error === 'NO_ENGINE_TOKEN' && bgMe.mode === 'operator_token', 'engine panels report token mode honestly');

// closing the fallback actually closes it
const closedEnv = { ...ssoEnv, ALLOW_TOKEN_CONSOLE: 'false' } as Env;
r = await worker.fetch(new Request('https://cite.test/admin?token=test-token-123'), closedEnv);
assert(r.status !== 302, 'ALLOW_TOKEN_CONSOLE=false refuses the token');
r = await worker.fetch(new Request('https://cite.test/admin'), closedEnv);
assert(!(await r.text()).includes('Use the operator token instead'), 'fallback UI hidden when disabled');

console.log('\nall break-glass checks passed');

// ---- per-person admin MCP keys ----
// sign in properly first (cookie from the earlier allowlist flow is gone, so redo)
r = await fs2('/auth/login');
lastNonce = new URL(r.headers.get('location')!).searchParams.get('nonce')!;
const keyState = new URL(r.headers.get('location')!).searchParams.get('state')!;
r = await fs2(`/auth/callback?code=abc&state=${keyState}`);
const ssoCookie = r.headers.get('set-cookie')!.split(';')[0];

r = await fs2('/admin/api/keys', { method: 'POST', headers: { cookie: ssoCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'laptop' }) });
const minted = await r.json();
assert(r.status === 201 && minted.key.startsWith('cka_'), 'console mints a personal admin key');
assert(minted.connect_command.includes('claude mcp add') && minted.connect_command.includes(minted.key),
  'mint response includes a copy-paste connect command');
assert(minted.connector_url.endsWith(minted.key), 'mint response includes a header-free connector URL');

// the personal key authenticates the admin MCP, by header and by path
r = await fs2('/admin/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.key}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
assert(r.status === 200 && (await r.json()).result.tools.length === 6, 'personal key works on the admin MCP');
r = await fs2(`/admin/mcp/${minted.key}`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
assert(r.status === 200, 'personal key works in the URL path (for header-less connectors)');

// listing masks the key and records usage
r = await fs2('/admin/api/keys', { headers: { cookie: ssoCookie } });
const listed = await r.json();
assert(listed.keys.length === 1 && !JSON.stringify(listed).includes(minted.key), 'key list never returns the full key');
assert(listed.keys[0].masked.startsWith('cka_') && listed.keys[0].last_used_at, 'list shows a masked key and last-used time');

// revoke by the displayed prefix
const prefix = listed.keys[0].masked.split('…')[0];
r = await fs2(`/admin/api/keys/${prefix}`, { method: 'DELETE', headers: { cookie: ssoCookie } });
assert((await r.json()).revoked === true, 'key revoked by prefix');
r = await fs2('/admin/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.key}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
assert(r.status === 401, 'revoked key stops working immediately');

// a break-glass token session cannot mint a personal key
r = await fsb('/admin?token=test-token-123');
const bgCookie2 = r.headers.get('set-cookie')!.split(';')[0];
r = await fsb('/admin/api/keys', { method: 'POST', headers: { cookie: bgCookie2, 'content-type': 'application/json' }, body: '{}' });
assert(r.status === 403 && (await r.json()).error === 'SSO_REQUIRED', 'personal keys require a Shortlist sign-in');

// the shared token still works alongside personal keys
r = await fs2('/admin/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-token-123' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
assert(r.status === 200, 'shared ADMIN_TOKEN still works');

console.log('\nall admin-key checks passed');

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
assert(r.status === 200 && (await r.json()).sites === 2, 'health counts sites from D1');
r = await f('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_sites', arguments: { topics: ['finance'] } } }) });
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
let g = await call('get_site', { site_id: 'cs_aaa111bbb222' });
assert(g.ahrefs_domain_rating === 88, 'exact Ahrefs DR exposed');
assert(g.da_band === 'DA 50–59', `DA banded not exact (got ${g.da_band})`);
assert(g.trust_ratio === 'strong', `TF/CF exposed as a band (got ${g.trust_ratio})`);
assert(!('da' in g) && !('tf' in g) && !('traffic' in g), 'exact DA/TF/traffic absent from public payload');
assert(typeof g.metrics_attribution === 'string', 'Ahrefs attribution present');
assert(!JSON.stringify(g).includes('secret-example'), 'domain still blind in get_site');

// free-site filters + link_exchange exclusion
let s = await call('search_sites', { cost_type: 'free' });
const ids = s.sites.map((x: { site_id: string }) => x.site_id);
assert(ids.includes('cs_free00self01'), 'free self_serve site returned by cost_type filter');
assert(!ids.includes('cs_exchange0001'), 'link_exchange excluded from search by default');
s = await call('search_sites', {});
assert(!s.sites.map((x: { site_id: string }) => x.site_id).includes('cs_exchange0001'), 'link_exchange excluded from default search');

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
s = await call('search_sites', {}, apiKey);
assert(s.result_limit === 50, 'account key raises result cap to 50');
let st = await call('account_status', {}, apiKey);
assert(st.tier === 'free' && st.free_placements_remaining === 10, 'account_status reports quota');

// free placement claim
let c = await call('claim_free_placement', { site_id: 'cs_free00self01', target_url: 'https://buyer.test/pricing' });
assert(c.error === 'ACCOUNT_REQUIRED', 'claim requires an account');
c = await call('claim_free_placement', { site_id: 'cs_free00self01', target_url: 'https://buyer.test/pricing' }, apiKey);
assert(c.claimed === true && c.domain === 'free-platform.test', 'self_serve claim releases the domain so the agent can publish');
assert(typeof c.agent_instructions === 'string', 'claim returns the agent playbook');
c = await call('claim_free_placement', { site_id: 'cs_aaa111bbb222', target_url: 'https://buyer.test/x' }, apiKey);
assert(c.error === 'NOT_FREE_INVENTORY', 'paid site rejects a free claim');
c = await call('claim_free_placement', { site_id: 'cs_exchange0001', target_url: 'https://buyer.test/x' }, apiKey);
assert(c.error === 'SITE_UNAVAILABLE', 'link_exchange site cannot be claimed');

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

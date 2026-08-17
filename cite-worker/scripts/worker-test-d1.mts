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

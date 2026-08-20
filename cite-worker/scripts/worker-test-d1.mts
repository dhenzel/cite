// Local smoke test: runs the Worker handler against an in-memory SQLite DB
// wrapped in the D1 interface. Usage: npx --prefix ../cite-mcp tsx scripts/worker-test-d1.mts
import BetterSqlite3 from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker, { type Env } from '../src/index.js';
import { ADMIN_HTML } from '../src/admin-ui.js';

const here = dirname(fileURLToPath(import.meta.url));
const sq = new BetterSqlite3(':memory:');
sq.exec(readFileSync(join(here, '..', 'schema.sql'), 'utf8'));
sq.exec(`
  INSERT INTO sites (id, domain, contact_email, niche, seller_price, markup, listed_price, cite_score, traffic_band, status, link_attribute)
  VALUES ('cs_aaa111bbb222', 'secret-example.com', 'owner@secret-example.com', 'Business', 100, 1.6, 160, 88, '10k–50k/mo', 'active', 'unknown'),
         ('cs_ccc333ddd444', 'hidden-blog.net', 'ed@hidden-blog.net', 'Tech', 50, 1.6, 80, 62, '1k–5k/mo', 'active', 'unknown');
  INSERT INTO site_content (site_id, summary, writes_about, recent_titles, audience, tone, post_shape, typical_length_words, do_fit, dont_fit, enrich_status, source)
  VALUES
    ('cs_aaa111bbb222', 'Secret Example covers B2B finance guides for operators at secret-example.com.', '["finance","b2b","Secret Example"]',
     '["How operators run monthly close","Invoice terms that get paid"]',
     'Operators who need practical finance ops writing.', 'practitioner', 'how-to', 900,
     'Include a concrete close or invoicing example.', 'Do not pitch crypto trading.',
     'ok', 'crawl-v1');
  INSERT INTO checkout_sessions (session_id, api_key, email, amount_cents, checkout_url, expires_at, created_at)
  VALUES ('cs_open_unpaid', 'ak_ghost', 'buyer@example.com', 19500,
          'https://checkout.stripe.com/c/pay/cs_test_open', datetime('now', '+1 day'), datetime('now', '-2 hours'));
  INSERT INTO checkout_sessions (session_id, api_key, email, amount_cents, checkout_url, expires_at, created_at, credited_at)
  VALUES ('cs_paid_done', 'ak_ghost', 'buyer@example.com', 19500,
          'https://checkout.stripe.com/c/pay/cs_test_paid', datetime('now', '-1 day'), datetime('now', '-1 day'), datetime('now', '-1 day'));
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
assert(!('da' in d.sites[0]) && !('tf' in d.sites[0]) && !('cf' in d.sites[0]), 'admin list omits Moz/Majestic');
r = await f('/admin/api/sites?sort=domain&dir=asc', { headers: auth });
d = await r.json();
{
  const names = d.sites.map((s: { domain: string }) => s.domain);
  assert(names.join() === [...names].sort().join(), 'admin list sorts by domain asc');
  assert(d.sort === 'domain' && d.dir === 'asc', 'admin list echoes the sort');
  const secret = d.sites.find((s: { id: string }) => s.id === 'cs_aaa111bbb222');
  assert(secret?.enrich_status === 'ok' && secret?.content_source === 'crawl-v1', 'admin list includes crawl status');
}
r = await f('/admin/api/sites/cs_aaa111bbb222');
assert(r.status === 401, 'admin site detail 401 without token');
r = await f('/admin/api/sites/cs_doesnotexist1', { headers: auth });
assert(r.status === 404, 'admin site detail 404 for unknown id');
r = await f('/admin/api/sites/cs_aaa111bbb222', { headers: auth });
d = await r.json();
{
  const s = d.site;
  assert(s.domain === 'secret-example.com' && s.contact_email === 'owner@secret-example.com', 'admin detail returns the domain');
  assert(typeof s.summary === 'string' && s.summary.includes('B2B finance') && s.summary.includes('Secret Example'), 'admin detail shows the crawled summary with the brand');
  assert(Array.isArray(s.writes_about) && s.writes_about.includes('finance') && s.writes_about.includes('Secret Example'), 'admin detail parses topics');
  assert(Array.isArray(s.recent_titles) && s.recent_titles.includes('How operators run monthly close'), 'admin detail shows crawled titles');
  assert(s.audience && s.tone === 'practitioner' && s.post_shape === 'how-to' && s.typical_length_words === 900, 'admin detail shows audience, tone, shape, length');
  assert(s.do_fit.includes('invoicing') && s.dont_fit.includes('crypto'), 'admin detail shows do/don’t fit');
  assert(s.enrich_status === 'ok' && s.content_source === 'crawl-v1', 'admin detail shows enrich provenance');
  assert(!('da' in s) && !('tf' in s) && !('cf' in s), 'admin detail omits Moz/Majestic');
}
r = await f('/admin/api/analytics', { headers: auth });
{
  const ana = await r.json();
  assert(ana.accounts && ana.activity && ana.funnel, 'analytics payload has accounts, activity, funnel');
  assert('funded_accounts' in ana.funnel && 'orders' in ana.funnel, 'funnel includes funded accounts and orders');
  assert(Array.isArray(ana.niches) && Array.isArray(ana.daily), 'analytics includes niche mix and daily activity');
  assert(Array.isArray(ana.abandoned_checkouts) && ana.abandoned_checkouts.length === 1, 'analytics lists unpaid checkouts');
  assert(ana.abandoned_checkouts[0].email === 'buyer@example.com', 'unpaid checkout includes the buyer email');
  assert(ana.funnel.abandoned_checkouts === 1 && ana.funnel.checkouts_paid === 1, 'funnel counts abandoned vs paid checkouts');
}
r = await f('/admin/api/checkouts', { headers: auth });
{
  const ch = await r.json();
  assert(ch.abandoned_count === 1 && ch.paid === 1 && ch.started === 2, 'checkouts API counts opened vs paid vs unfinished');
  assert(ch.abandoned[0].email === 'buyer@example.com' && ch.abandoned[0].amount_cents === 19500, 'checkouts API returns the person to follow up');
  assert(ch.abandoned[0].status === 'follow_up', 'a checkout opened 2h ago is marked follow_up');
  assert(!('api_key' in ch.abandoned[0]), 'checkouts API does not leak the buyer key');
}

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
{
  const st = await r.json();
  assert(st.sites === 3, 'stats totals');
  assert(st.paid_sites === 3 && st.free_sites === 0, 'stats splits the two sections');
  assert(st.paid_sites + st.free_sites === st.sites, 'every site belongs to exactly one section');
}

// ---- paid and free are two sections of the console ----
r = await f('/admin/api/sites', { method: 'POST', headers: auth, body: JSON.stringify({
  domain: 'free-apply.test', niche: 'Tech', cost_type: 'free',
  agent_instructions: 'Pitch the editor, no fee.', requires_reciprocal_link: 1,
}) });
d = await r.json();
const freeId = d.id;
assert(r.status === 201 && d.cost_type === 'free', 'operators can add a site straight into the free section');
assert(d.acquisition_mode === 'apply_editorial', 'a free site defaults to apply_editorial, not paid_placement');
r = await f('/admin/api/sites?cost_type=free', { headers: auth });
d = await r.json();
{
  const ids = d.sites.map((x: { id: string }) => x.id);
  assert(d.total === 1 && ids.includes(freeId), 'the free section lists only free sites');
  const site = d.sites.find((x: { id: string }) => x.id === freeId);
  assert(site.listed_price == null && site.seller_price == null, 'a free site carries no price');
  assert(site.requires_reciprocal_link === 1 && site.agent_instructions === 'Pitch the editor, no fee.',
    'the free section keeps the link-back flag and the how-to-publish note');
}
r = await f('/admin/api/sites?cost_type=paid', { headers: auth });
d = await r.json();
assert(!d.sites.some((x: { id: string }) => x.id === freeId), 'a free site never shows up in the paid section');
assert(d.total === 3, 'the paid section still holds every paid site');
r = await f('/admin/api/sites', { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'bad-cost.test', cost_type: 'sponsored' }) });
assert(r.status === 400, 'a site has to land in one of the two sections');

// the Section control moves a publisher between the two tables
r = await f(`/admin/api/sites/${freeId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ cost_type: 'paid' }) });
assert((await r.json()).site.cost_type === 'paid', 'a free site can be moved into paid inventory');
r = await f('/admin/api/sites?cost_type=free', { headers: auth });
assert((await r.json()).total === 0, 'the moved site leaves the free section');
r = await f(`/admin/api/sites/${freeId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ cost_type: 'free' }) });
assert((await r.json()).site.cost_type === 'free', 'and it can be moved back');
r = await f('/admin/api/stats', { headers: auth });
{
  const st = await r.json();
  assert(st.paid_sites === 3, 'stats counts the paid section');
  assert('opportunities' in st, 'stats reports the free opportunity catalog, not free sites');
}
assert(ADMIN_HTML.includes('id="pane-opp"') && ADMIN_HTML.includes('id="rows_opp"'),
  'the console has an opportunities section');
assert(ADMIN_HTML.includes('id="pane-sub"') && ADMIN_HTML.includes('id="rows_sub"'),
  'the console has a submissions section');
assert(ADMIN_HTML.includes('data-verify') && /Mark verified/.test(ADMIN_HTML),
  'an operator can stamp an opportunity verified after checking the live page');
assert(!ADMIN_HTML.includes('id="pane-free"') && !ADMIN_HTML.includes('freeRowHtml'),
  'the old free-inventory section is gone — free rows live in the opportunities catalog');
assert(!/id="fcost"/.test(ADMIN_HTML), 'the paid/free dropdown is gone — the tab is the filter');
r = await f('/admin');
{
  const adminHtml = await r.text();
  assert(r.status === 200 && adminHtml.includes('operator console'), 'admin UI serves');
}
assert(ADMIN_HTML.includes('data-open-site') && ADMIN_HTML.includes('site-drawer') && ADMIN_HTML.includes('crawl profile'), 'admin inventory opens a crawl drawer from the domain');
assert(ADMIN_HTML.includes('.drawer[hidden]') && ADMIN_HTML.includes('display:none !important'), 'drawer Close can hide a flex panel');
r = await f('/.well-known/oauth-protected-resource');
assert(r.status === 404, 'oauth discovery probes still 404');
r = await f('/llms.txt');
{
  const llms = await r.text();
  assert(r.status === 200 && llms.includes('placement.sh'), 'llms.txt served for agents');
  assert(/shortlist\.io/i.test(llms) && /about-us/i.test(llms) && /calendly\.com/i.test(llms), 'agent docs name Shortlist and offer a call so the human can look us up before paying');
}
r = await f('/.well-known/mcp/server.json');
{
  const card = await r.json();
  assert(card.name === 'sh.placement/mcp', 'MCP registry server.json');
  assert(!JSON.stringify(card).includes('github.com') && !card.repository, 'server card does not expose a GitHub repo');
}
r = await f('/');
assert((await r.text()).includes('claude mcp add --transport http placement'), 'homepage install command');
r = await worker.fetch(new Request('https://placement.sh/', { headers: { accept: 'text/html' } }), env);
const home = await r.text();
assert(r.status === 200 && (r.headers.get('content-type') ?? '').includes('text/html'), 'browser homepage is HTML');
assert(home.includes('Get your URL cited') && home.includes('Claude') && home.includes('ChatGPT') && home.includes('Grok') && home.includes('Kimi') && home.includes('Cursor') && home.includes('Hermes'), 'homepage names the product and agent buttons');
assert(home.includes('https://placement.sh/mcp') && !home.includes('workers.dev'), 'homepage shows MCP URL, not workers.dev');
assert(home.includes('https://shortlist.io/') && home.includes('https://shortlist.io/about-us/'), 'homepage links Shortlist and the team page');
assert(home.includes('https://calendly.com/shortlist-businessdevelopment/15min') && home.includes('Book a 15-min call'), 'homepage links the Shortlist Calendly call');
assert(home.includes('mailto:placement@shortlist.io') && home.includes('placement@shortlist.io'), 'homepage lists buyer mail as placement@shortlist.io');
assert(/Who runs this/.test(home) && /A <a href="https:\/\/shortlist\.io\/">Shortlist<\/a> product/.test(home) && /since 2018/.test(home), 'homepage explains Shortlist as the operator');
assert(home.includes('placement<span class="dot">.</span>sh'), 'wordmark uses a Shortlist-colored dot between placement and sh');
assert(home.indexOf('Meet the team') < home.indexOf('Book a 15-min call'), 'Who runs this leads with the team, then the call');
assert(home.includes('data-client="hermes"') && home.includes('hermes mcp add placement --url'), 'Hermes is an add-to-agent option');
assert(/Free — get listed/.test(home) && /Paid — bought placements/.test(home),
  'homepage presents both paths');
assert(home.indexOf('Free — get listed') < home.indexOf('Paid — bought placements'),
  'free is presented first — it is the way in');
assert(/cost is unconfirmed on about half/.test(home),
  'homepage is honest that most of the free catalog is unverified');
assert(/Nobody can promise you approval/.test(home),
  'homepage promises no approval or link on the free path');
assert(/bought inventory/.test(home), 'homepage still calls paid inventory what it is');
assert(!home.includes('window.open') && !home.includes('cursor://') && !/https:\/\/(claude\.ai|chatgpt\.com|grok\.com)\//.test(home), 'agent buttons stay on-page and do not deep-link out');
assert(home.includes('data-client="cursor"') && !home.includes('<a class="btn"'), 'Cursor is a button like the others, not an outbound link');
r = await worker.fetch(new Request('https://www.placement.sh/llms.txt'), env);
assert(r.status === 301 && r.headers.get('location') === 'https://placement.sh/llms.txt', 'www redirects to apex');
r = await worker.fetch(new Request('https://cite-mcp.d-henzel.workers.dev/'), env);
assert(r.status === 301 && r.headers.get('location') === 'https://placement.sh/', 'workers.dev homepage redirects to placement.sh');
r = await worker.fetch(new Request('https://cite-mcp.d-henzel.workers.dev/admin'), env);
assert(r.status === 301 && r.headers.get('location') === 'https://placement.sh/admin', 'workers.dev console redirects to placement.sh');
r = await worker.fetch(new Request('https://cite-mcp.d-henzel.workers.dev/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
}), env);
assert(r.status === 200, 'POST /mcp still works on workers.dev so old clients do not die mid-request');
assert(!JSON.stringify(await r.json()).includes('workers.dev'), 'MCP payload does not advertise workers.dev');
r = await worker.fetch(new Request('https://mcp.placement.sh/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
}), env);
assert(r.status === 200, 'mcp.placement.sh serves POST /mcp');

console.log('\nall checks passed');

// ---- paid-only inventory, accounts, admin MCP ----
sq.exec(`
  UPDATE sites SET dr=88, da=54, tf=40, cf=50, traffic=25000,
    ahrefs_organic_keywords=1800, ahrefs_referring_domains=420, ahrefs_backlinks=12000
    WHERE id='cs_aaa111bbb222';
  INSERT INTO sites (id, domain, niche, seller_price, markup, listed_price, cite_score, traffic_band, status, link_attribute, acquisition_mode, cost_type, agent_instructions)
  VALUES ('cs_free00self01','free-platform.test','Tech',0,1.6,0,70,'250k+/mo','active','nofollow','self_serve','free','Register and publish directly.'),
         ('cs_exchange0001','swap-site.test','Tech',0,1.6,0,60,'1k-5k/mo','active','dofollow','link_exchange','free',NULL),
         ('cs_freebiz00001','free-newsletter.test','Business',0,1.6,0,95,'250k+/mo','active','sponsored','self_serve','free','Looks huge, is a $0 subdomain.');
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
assert(g.ahrefs_organic_traffic === 25000, 'exact Ahrefs organic traffic exposed');
assert(g.ahrefs?.domain_rating === 88 && g.ahrefs?.organic_traffic === 25000, 'ahrefs overview bundle present');
assert(g.ahrefs?.organic_keywords === 1800 && g.ahrefs?.referring_domains === 420 && g.ahrefs?.backlinks === 12000,
  'extra Ahrefs overview stats pass through when present');
assert(!('da_band' in g) && !('trust_ratio' in g) && !('da' in g) && !('tf' in g) && !('cf' in g),
  'Moz DA / Majestic TF/CF absent from buyer payload');
assert(!('traffic' in g) || g.traffic === undefined, 'raw traffic column is not a buyer field');
assert(typeof g.metrics_attribution === 'string', 'Ahrefs attribution present');
assert(!g.score_components || !('trust' in g.score_components), 'no Majestic trust on buyer score_components');
assert(g.placement_score === 88 && !('cite_score' in g) && !('site_id' in g), 'public fields use publisher/placement_score');
assert(!JSON.stringify(g).includes('secret-example'), 'domain still blind in get_publisher');
assert(!/secret example/i.test(JSON.stringify(g)), 'get_publisher description does not leak the brand name');
assert(!('recent_post_titles' in g) || g.recent_post_titles == null, 'get_publisher does not return exact headlines');
assert(typeof g.content_summary === 'string' && /B2B finance/i.test(g.content_summary), 'get_publisher keeps a scrubbed description');
assert(!('cost_type' in g) && !('acquisition_mode' in g), 'buyer payload does not advertise free/self-serve modes');

// free sites never appear on the buyer MCP
let s = await call('search_publishers', {});
let ids = s.publishers.map((x: { publisher_id: string }) => x.publisher_id);
assert(!ids.includes('cs_free00self01') && !ids.includes('cs_exchange0001') && !ids.includes('cs_freebiz00001'),
  'free / self-serve / link-exchange publishers are hidden from search');
assert(ids.includes('cs_aaa111bbb222'), 'paid publishers still search');
s = await call('search_publishers', { cost_type: 'free' } as Record<string, unknown>);
ids = s.publishers.map((x: { publisher_id: string }) => x.publisher_id);
assert(!ids.includes('cs_free00self01'), 'cost_type=free filter is gone; free sites stay hidden');
g = await call('get_publisher', { publisher_id: 'cs_freebiz00001' });
assert(g.error === 'PUBLISHER_NOT_FOUND', 'get_publisher hides free inventory instead of showing a $0 profile');

let toolsListRes = await f('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
const toolNames = (await toolsListRes.json()).result.tools.map((t: { name: string }) => t.name);
assert(!toolNames.includes('claim_free_placement'), 'claim_free_placement is not advertised');
assert(toolNames.includes('create_campaign') && toolNames.includes('register_account') && toolNames.includes('add_credits'), 'paid booking tools remain');
assert(toolNames.includes('get_writing_brief') && toolNames.includes('submit_placement'), 'writing brief and submit tools are advertised');

let gone = await call('claim_free_placement', { publisher_id: 'cs_free00self01', target_url: 'https://buyer.test/pricing' });
assert(gone.error === 'TOOL_REMOVED', 'old clients calling claim_free_placement get TOOL_REMOVED');

// looking is unlimited — no anonymous/account result cap
s = await call('search_publishers', {});
assert(s.looking === 'unlimited' && !('result_limit' in s), 'search is unlimited; no result_limit cap');
assert(typeof s.total_matched === 'number' && s.offset === 0, 'search reports total_matched and offset');
assert(typeof s.next_step === 'string' && /book/i.test(s.next_step), 'search still explains how booking works');
s = await call('search_publishers', { limit: 1 });
assert(s.result_count === 1 && s.next_offset === 1, 'limit 1 pages; next_offset is 1 when more remain');
s = await call('search_publishers', { limit: 1, offset: 1 });
assert(s.offset === 1 && s.publishers[0].publisher_id !== undefined, 'offset pages through the catalog');

// accounts
let a = await call('register_account', { email: 'not-an-email' });
assert(a.error === 'INVALID_EMAIL', 'bad email rejected');
a = await call('register_account', { email: 'Agent@Example.com' });
assert(typeof a.api_key === 'string' && a.api_key.startsWith('ck_'), 'register_account mints a key');
assert(a.tier === 'registered', 'new accounts are registered, not a free-placement tier');
assert(!JSON.stringify(a).includes('free placement'), 'register_account does not promise free placements');
assert(!/capped at 10|50 results/i.test(JSON.stringify(a)), 'register_account does not sell a search-cap upgrade');
const apiKey = a.api_key;
const again = await call('register_account', { email: 'agent@example.com' });
assert(again.api_key === apiKey, 'same email returns the same key (case-insensitive)');
s = await call('search_publishers', {}, apiKey);
assert(s.looking === 'unlimited', 'account key does not change looking — already unlimited');
let st = await call('account_status', {}, apiKey);
assert(st.tier === 'registered' && st.looking === 'unlimited' && !('free_placements_remaining' in st), 'account_status has no free-placement quota and unlimited looking');
assert(st.funded === false && st.available_cents === 0 && st.held_cents === 0, 'new account is unfunded');

let h = await call('help');
assert(h.product === 'placement.sh' && /analyze_site/.test(h.call_first) && /estimate/.test(h.call_first),
  'help names the entry verb for both paths');
assert(Array.isArray(h.never) && h.never.some((x: string) => /free opportunity as a paid placement/i.test(x)),
  'help forbids confusing the free and paid mechanisms');
assert(h.never.some((x: string) => /promise approval, indexing/i.test(x)),
  'help forbids promising approval or indexing on either path');
assert(h.never.some((x: string) => /licence|certification/i.test(x)),
  'help forbids claiming credentials the human has not confirmed');
assert(h.free_playbook.some((x: string) => /analyze_site/.test(x)) && h.free_playbook.some((x: string) => /never submits/i.test(x)),
  'the free playbook starts at analyze_site and says preparation never submits');
assert(h.free_playbook.some((x: string) => /CAPTCHA/.test(x)), 'the free playbook leaves the CAPTCHA to the human');
assert(h.paid_playbook.some((x: string) => /email/i.test(x)), 'the paid playbook says to ask the human for an email');
assert(h.paid_playbook.some((x: string) => /unlimited/i.test(x)), 'the paid playbook says looking is unlimited');
assert(/exhausted/i.test(h.which_path), 'help says when to raise the paid path');
assert(/unverified/i.test(h.data_honesty), 'help passes on how well the free catalog is verified');
assert(h.who_runs_this?.operator === 'Shortlist' && /shortlist\.io\/about-us/.test(h.who_runs_this.team) && /calendly\.com/.test(h.who_runs_this.book_a_call), 'help names Shortlist, the team page, and a 15-min call');
assert(h.paid_playbook.some((x: string) => /look us up/i.test(x) && /calendly/i.test(x)), 'help tells the agent to show Shortlist and offer a call before the human pays');

let camp = await call('create_campaign', { target_url: 'https://buyer.test', topics: ['finance'], budget: 4000 });
assert(camp.error === 'ACCOUNT_REQUIRED' && /email/i.test(camp.next_step), 'booking without an account asks for email, not a free listing');
camp = await call('create_campaign', { target_url: 'https://buyer.test', topics: ['finance'], budget: 4000 }, apiKey);
assert(camp.error === 'INSUFFICIENT_CREDIT' && /do not offer/i.test(camp.next_step), 'INSUFFICIENT_CREDIT forbids a free-listing substitute');
assert(/shortlist\.io/i.test(camp.next_step) && /about-us/i.test(camp.next_step) && /calendly\.com/i.test(camp.next_step), 'payment step tells the agent to show Shortlist and offer a call before the human pays');

let est = await call('estimate', { topics: ['finance'], budget: 4000, target_url: 'https://buyer.test/pricing' });
assert(est.target_url === 'https://buyer.test/pricing' && Array.isArray(est.plan), 'estimate accepts target_url');
assert(!/claim_free|cost_type/i.test(JSON.stringify(est)), 'estimate does not advertise free inventory');
const estBiz = await call('estimate', { topics: ['Business'], budget: 300 });
assert((estBiz.total_planned_placements ?? 0) === 0 || estBiz.total_planned_spend > 0,
  'estimate does not count $0 free sites as placements');

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
assert(!('da' in ad.sites[0]) && !('tf' in ad.sites[0]) && !('cf' in ad.sites[0]),
  'admin MCP does not show Moz DA / Majestic TF/CF');
assert(ad.sites[0].dr === 88 && ad.sites[0].traffic === 25000, 'admin MCP shows Ahrefs DR and organic traffic');
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
ad = await adminCall('admin_update_metrics', {
  domain: 'secret-example.com', dr: 91, traffic: 500000,
  organic_keywords: 9000, referring_domains: 2100, backlinks: 80000, ahrefs_rank: 12000, organic_value: 45000,
});
assert(ad.cite_score === 96 && ad.traffic_band === '250k+/mo',
  `admin_update_metrics uses Ahrefs-only score 50/50 DR+traffic (got ${ad.cite_score})`);
assert(!ad.metrics || (!('da' in ad.metrics) && !('tf' in ad.metrics) && !('cf' in ad.metrics)),
  'admin_update_metrics does not return Moz/Majestic');
g = await call('get_publisher', { publisher_id: 'cs_aaa111bbb222' });
assert(g.ahrefs?.organic_keywords === 9000 && g.ahrefs?.ahrefs_rank === 12000, 'admin Ahrefs overview refresh reaches the buyer payload');
ad = await adminCall('admin_add_site', { domain: 'brand-new.test', niche: 'Pets', seller_price: 40, markup: 2.5 });
assert(ad.added === true && ad.listed_price === 100, 'admin_add_site computes listed price');
ad = await adminCall('admin_analytics', {});
assert(ad.accounts.total === 1 && ad.activity.queries_total > 0, 'admin_analytics reports signups and queries');
assert(Array.isArray(ad.top_topics) && Array.isArray(ad.unmet_demand), 'analytics includes demand views');
assert(ad.funnel && typeof ad.funnel.funded_accounts === 'number', 'analytics funnel includes funded accounts');
assert(Array.isArray(ad.niches), 'analytics includes inventory by niche');
assert(Array.isArray(ad.abandoned_checkouts) && ad.funnel.abandoned_checkouts === 1, 'admin_analytics surfaces unpaid checkouts for follow-up');

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
assert(page.includes('#17204B') && page.includes('#30D2AD') && page.includes('Inter'), 'sign-in uses Shortlist navy, mint and Inter');
assert(page.includes('shortlist') && page.includes('class="logo"'), 'sign-in shows the Shortlist wordmark');
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
{
  const consoleHtml = await r.text();
  assert(consoleHtml.includes('operator console'), 'session opens the console');
  assert(consoleHtml.includes('Orders'), 'console has an Orders tab');
  assert(consoleHtml.includes('#17204B') && consoleHtml.includes('#30D2AD'), 'console uses Shortlist navy and mint');
  assert(consoleHtml.includes('class="logo"') && consoleHtml.includes('shortlist'), 'console shows the Shortlist wordmark');
  assert(consoleHtml.includes('Click to sort'), 'column headers advertise sorting');
  assert(consoleHtml.includes('Copy post'), 'Orders tab can copy the post out of the platform');
  assert(consoleHtml.includes('data-sort="cite_score"') && consoleHtml.includes('data-sort="listed_price"'),
    'inventory columns are sortable');
  assert(consoleHtml.includes('id="a_funnel"') && consoleHtml.includes('id="a_spark"'),
    'analytics has a funnel and 14-day chart');
  assert(consoleHtml.includes('Follow-up') && consoleHtml.includes('id="pane-fol"'),
    'console has a Follow-up tab for unfinished checkouts');
  assert(consoleHtml.includes('Copy follow-up') && consoleHtml.includes('/admin/api/checkouts'),
    'Follow-up tab can copy a note and loads unpaid checkouts');
}
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

r = await worker.fetch(new Request('https://cite-mcp.d-henzel.workers.dev/admin/api/keys', {
  method: 'POST',
  headers: { cookie: ssoCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'from-workers-dev' }),
}), ssoEnv);
const mintedOnLegacyHost = await r.json();
assert(r.status === 201, 'can mint a key even if the POST hit workers.dev');
assert(String(mintedOnLegacyHost.connector_url).startsWith('https://placement.sh/admin/mcp/'),
  'admin MCP connector URL is placement.sh, never workers.dev');
assert(!JSON.stringify(mintedOnLegacyHost).includes('workers.dev'),
  'minted key payload never mentions workers.dev');

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
assert(listed.keys.length === 2 && !JSON.stringify(listed).includes(minted.key), 'key list never returns the full key');
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

// ---------- buyer mail: From placement@shortlist.io on new register_account ----------
{
  type MailCall = { url: string; body: string };
  const mailCalls: MailCall[] = [];
  let gmailSendStatus = 200;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const body = typeof init?.body === 'string' ? init.body
      : init?.body instanceof URLSearchParams ? init.body.toString() : '';
    if (url === 'https://oauth2.googleapis.com/token') {
      mailCalls.push({ url, body });
      return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      mailCalls.push({ url, body });
      return new Response(JSON.stringify({ id: 'msg-1' }), {
        status: gmailSendStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://api.resend.com/emails') {
      mailCalls.push({ url, body });
      return new Response(JSON.stringify({ id: 're-1' }), { headers: { 'content-type': 'application/json' } });
    }
    return prevFetch(input, init);
  }) as typeof fetch;

  const decodeRaw = (raw: string) => {
    const pad = raw.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(pad, 'base64').toString('utf8');
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
  const flush = () => Promise.all(pending.splice(0));
  const parseTool = async (res: Response) => JSON.parse((await res.json()).result.content[0].text);
  const mailEnv: Env = {
    ...env,
    GMAIL_CLIENT_ID: 'gid',
    GMAIL_CLIENT_SECRET: 'gsecret',
    GMAIL_REFRESH_TOKEN: 'grefresh',
    CITE_ADMIN_EMAILS: 'ops@shortlist.io',
  };
  const mcpCall = (email: string, e: Env = mailEnv, c = ctx) => worker.fetch(new Request('https://cite.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'register_account', arguments: { email } },
    }),
  }), e, c);

  mailCalls.length = 0;
  let mr = await mcpCall('new-buyer@customer.test');
  const minted = await parseTool(mr);
  await flush();
  assert(minted.api_key.startsWith('ck_'), 'signup still mints a key when mail is configured');
  const gmailSends = mailCalls.filter((c) => c.url.includes('gmail.googleapis.com'));
  const tokenCalls = mailCalls.filter((c) => c.url.includes('oauth2.googleapis.com/token'));
  assert(tokenCalls.length >= 1, 'Gmail OAuth refresh is used');
  // welcome + ops to placement@shortlist.io + CITE_ADMIN_EMAILS
  assert(gmailSends.length === 3, `new signup sends buyer welcome + two ops pings (got ${gmailSends.length})`);
  const decoded = gmailSends.map((c) => decodeRaw(JSON.parse(c.body).raw));
  assert(decoded.every((m) => /From: "placement\.sh" <placement@shortlist\.io>/.test(m)), 'From is placement@shortlist.io');
  assert(decoded.every((m) => /Reply-To: placement@shortlist\.io/.test(m)), 'Reply-To is placement@shortlist.io');
  const welcome = decoded.find((m) => /To: new-buyer@customer\.test/.test(m));
  const ops = decoded.find((m) => /To: ops@shortlist\.io/.test(m));
  const inbox = decoded.find((m) => /To: placement@shortlist\.io/.test(m));
  assert(!!welcome && !!ops && !!inbox, 'welcome to the buyer; ops ping to placement@shortlist.io and CITE_ADMIN_EMAILS');
  assert(welcome!.includes('shortlist.io/about-us') && welcome!.includes('Shortlist') && welcome!.includes('calendly.com'), 'welcome names Shortlist, the team page, and a 15-min call');
  assert(welcome!.includes('claude mcp add') && welcome!.includes('hermes mcp add'), 'welcome shows how to add the MCP');
  assert(!welcome!.includes(minted.api_key) && !ops!.includes(minted.api_key), 'mail never includes the API key');
  assert(!/free listing|secret-example|hidden-blog/i.test(decoded.join('\n')), 'mail never mentions free listings or publisher domains');
  assert(!/hello@placement\.sh/.test(decoded.join('\n')), 'mail never uses hello@placement.sh');

  const sendsAfterFirst = gmailSends.length;
  mr = await mcpCall('new-buyer@customer.test');
  await flush();
  const againPayload = await parseTool(mr);
  assert(againPayload.api_key === minted.api_key, 're-register returns the same key');
  assert(mailCalls.filter((c) => c.url.includes('gmail.googleapis.com')).length === sendsAfterFirst,
    'existing email does not get another welcome');

  gmailSendStatus = 500;
  mailCalls.length = 0;
  mr = await mcpCall('mail-down@customer.test');
  const despite = await parseTool(mr);
  await flush();
  assert(despite.api_key.startsWith('ck_') && !despite.error, 'Gmail 500 does not fail register_account');

  gmailSendStatus = 200;
  mailCalls.length = 0;
  const resendEnv: Env = { ...env, RESEND_API_KEY: 're_test', CITE_ADMIN_EMAILS: 'ops@shortlist.io' };
  const resendPending: Promise<unknown>[] = [];
  const resendCtx = { waitUntil(p: Promise<unknown>) { resendPending.push(p); } };
  mr = await mcpCall('resend-buyer@customer.test', resendEnv, resendCtx);
  const resendMinted = await parseTool(mr);
  await Promise.all(resendPending);
  assert(resendMinted.api_key.startsWith('ck_'), 'Resend path still mints a key');
  const resendCalls = mailCalls.filter((c) => c.url === 'https://api.resend.com/emails');
  assert(resendCalls.length === 3, `Resend sends welcome + two ops pings (got ${resendCalls.length})`);
  const resendBodies = resendCalls.map((c) => JSON.parse(c.body));
  assert(resendBodies.every((b: { from: string }) => b.from === '"placement.sh" <placement@shortlist.io>'),
    'Resend From is placement@shortlist.io');
  assert(resendBodies.every((b: { reply_to: string }) => b.reply_to === 'placement@shortlist.io'),
    'Resend Reply-To is placement@shortlist.io');

  mailCalls.length = 0;
  mr = await mcpCall('quiet@customer.test', env, ctx);
  await flush();
  const quiet = await parseTool(mr);
  assert(quiet.api_key.startsWith('ck_'), 'signup works with no mail secrets');
  assert(mailCalls.length === 0, 'no mail HTTP when neither Gmail nor Resend is configured');

  globalThis.fetch = prevFetch;
  console.log('\nall signup-mail checks passed');
}

// ---------- prepaid Stripe credits ----------
{
  r = await f('/paid');
  assert(r.status === 200 && (await r.text()).includes('Credits added'), 'GET /paid is a simple landing page');
  r = await f('/paid?canceled=1');
  assert((await r.text()).includes('Payment canceled'), 'canceled Checkout lands on the same page with different copy');

  let pay = await call('add_credits', { amount_usd: 50 });
  assert(pay.error === 'ACCOUNT_REQUIRED', 'add_credits without an account asks for email');

  pay = await call('add_credits', { amount_usd: 50 }, apiKey);
  assert(pay.error === 'STRIPE_NOT_CONFIGURED', 'add_credits without Stripe secrets does not invent a URL');
  assert(!pay.checkout_url, 'no checkout_url when Stripe is missing');
  camp = await call('create_campaign', { target_url: 'https://buyer.test', topics: ['finance'], budget: 4000 }, apiKey);
  assert(camp.error === 'INSUFFICIENT_CREDIT' && /do not offer/i.test(camp.next_step), 'INSUFFICIENT_CREDIT without Stripe still forbids a free listing');
  assert(/shortlist\.io/i.test(camp.next_step) && /about-us/i.test(camp.next_step) && /calendly\.com/i.test(camp.next_step), 'payment step still names Shortlist and offers a call');

  const stripeCalls: { url: string; body: string; headers: Record<string, string> }[] = [];
  let stripeSeq = 0;
  const prevFetch2 = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.startsWith('https://api.stripe.com/v1/checkout/sessions')) {
      const body = typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : '';
      stripeCalls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
      const n = ++stripeSeq;
      return new Response(JSON.stringify({
        id: `cs_test_${n}`,
        url: `https://checkout.stripe.com/c/pay/cs_test_${n}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }), { headers: { 'content-type': 'application/json' } });
    }
    return prevFetch2(input, init);
  }) as typeof fetch;

  const stripeEnv: Env = {
    ...env,
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
  };
  const mcpPay = (name: string, args: Record<string, unknown>, key?: string) => worker.fetch(new Request('https://cite.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), stripeEnv);
  const parsePay = async (res: Response) => JSON.parse((await res.json()).result.content[0].text);

  let pr = await mcpPay('register_account', { email: 'payer@customer.test' });
  const payer = await parsePay(pr);
  stripeCalls.length = 0;
  pr = await mcpPay('add_credits', { amount_usd: 60, idempotency_key: 'exact-60' }, payer.api_key);
  const checkout = await parsePay(pr);
  assert(checkout.checkout_url?.startsWith('https://checkout.stripe.com/'), 'add_credits returns a Checkout URL');
  assert(checkout.amount_usd === 60, 'amount 60 is charged exactly — no pack snap');
  assert(checkout.amount_cents === 6000, 'exact charge is 6000 cents');
  assert(checkout.session_id === 'cs_test_1', 'session id from Stripe');
  assert(/shortlist\.io\/about-us/.test(checkout.next_step) && /calendly\.com/.test(checkout.next_step), 'Checkout next_step names the team page and a 15-min call');
  assert(stripeCalls[0].body.includes('metadata%5Bproduct%5D=placement.sh') || stripeCalls[0].body.includes('metadata[product]=placement.sh'),
    'Checkout Session is tagged product=placement.sh');

  pr = await mcpPay('add_credits', { amount_usd: 195, idempotency_key: 'exact-195' }, payer.api_key);
  const ck195 = await parsePay(pr);
  assert(ck195.amount_usd === 195 && ck195.amount_cents === 19500, 'amount 195 stays $195, not a pack');

  stripeCalls.length = 0;
  pr = await mcpPay('add_credits', { amount_usd: 60, idempotency_key: 'exact-60' }, payer.api_key);
  const againCk = await parsePay(pr);
  assert(againCk.session_id === checkout.session_id && stripeCalls.length === 0, 'same idempotency_key reuses the open session without a second Stripe call');

  pr = await mcpPay('create_campaign', { target_url: 'https://buyer.test', topics: ['finance'], budget: 4000 }, payer.api_key);
  const unpaidCamp = await parsePay(pr);
  assert(unpaidCamp.error === 'INSUFFICIENT_CREDIT' && unpaidCamp.checkout_url?.startsWith('https://checkout.stripe.com/'),
    'create_campaign includes a Checkout URL when Stripe is configured');
  assert(/shortlist\.io\/about-us/.test(unpaidCamp.next_step) && /calendly\.com/.test(unpaidCamp.next_step), 'funded-path Checkout still names Shortlist and offers a call');

  const event = {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: checkout.session_id,
        payment_status: 'paid',
        amount_total: 6000,
        customer: 'cus_test',
        metadata: { product: 'placement.sh', api_key: payer.api_key, email: 'payer@customer.test' },
        client_reference_id: payer.api_key,
      },
    },
  };
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode('whsec_test'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const sig = `t=${t},v1=${hex}`;

  r = await worker.fetch(new Request('https://cite.test/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=dead' },
    body: payload,
  }), stripeEnv);
  assert(r.status === 400, 'bad Stripe signature is rejected');

  r = await worker.fetch(new Request('https://cite.test/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sig },
    body: payload,
  }), stripeEnv);
  const credited = await r.json();
  assert(r.status === 200 && credited.credited === true, 'valid webhook credits the wallet');

  r = await worker.fetch(new Request('https://cite.test/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sig },
    body: payload,
  }), stripeEnv);
  assert((await r.json()).credited === false, 'replayed webhook does not double-credit');

  pr = await mcpPay('account_status', {}, payer.api_key);
  st = await parsePay(pr);
  assert(st.funded === true && st.available_cents === 6000, 'account_status shows the exact $60 credit');

  pr = await mcpPay('create_campaign', { target_url: 'https://buyer.test', topics: ['finance'], budget: 50 }, payer.api_key);
  const fundedCamp = await parsePay(pr);
  assert(fundedCamp.status === 'ready_to_write', 'funded create_campaign asks the agent to write, not fake a booking');
  assert(fundedCamp.available_cents === 6000, 'funded campaign response still reports the balance');
  assert(/get_writing_brief/i.test(fundedCamp.next_step) && /do not offer a free listing/i.test(fundedCamp.next_step),
    'funded next_step points at writing + submit and forbids a free listing');

  let brief = await call('get_writing_brief', { publisher_id: 'cs_aaa111bbb222' });
  assert(!brief.error, 'get_writing_brief works without an account — looking is free');
  assert(brief.publisher_id === 'cs_aaa111bbb222' && Array.isArray(brief.ask_the_human), 'brief asks homepage vs article');
  assert(brief.ask_the_human.some((x: string) => /homepage/i.test(x)), 'brief asks homepage vs a specific article');
  assert(!JSON.stringify(brief).includes('secret-example'), 'writing brief does not leak the publisher domain');
  assert(brief.audience && /operators/i.test(brief.audience), 'writing brief includes crawl audience');
  assert(brief.tone === 'practitioner' && brief.post_shape === 'how-to', 'writing brief includes tone and post shape');
  assert(brief.do && brief.dont && brief.typical_length_words === 900, 'writing brief includes do/dont and typical length');
  assert((brief.example_angles || []).some((x: string) => /finance|b2b/i.test(x)), 'example angles come from topics, not exact headlines');
  assert(!(brief.example_angles || []).some((x: string) => /monthly close/i.test(x)), 'writing brief does not quote recent headlines');

  brief = await call('get_writing_brief', { publisher_id: 'cs_aaa111bbb222', target_url: 'https://contextengine.com/docs/overview' });
  assert(brief.link?.kind === 'article' && brief.link?.to === 'https://contextengine.com/docs/overview', 'article target is recorded on the brief');
  assert((brief.how_to_write || []).some((x: string) => /contextengine\.com\/docs\/overview/.test(x)), 'article brief tells the agent to read and cite that URL');

  let sub = await call('submit_placement', {
    publisher_id: 'cs_aaa111bbb222',
    target_url: 'https://contextengine.com/docs/overview',
    title: 'Too short',
    body: 'Not enough words. https://contextengine.com/docs/overview',
  });
  assert(sub.error === 'ACCOUNT_REQUIRED', 'submit_placement without an account asks for email');

  sub = await call('submit_placement', {
    publisher_id: 'cs_aaa111bbb222',
    target_url: 'https://contextengine.com/docs/overview',
    title: 'Too short',
    body: 'Not enough words. https://contextengine.com/docs/overview',
  }, payer.api_key);
  assert(sub.error === 'WORD_COUNT_LOW', 'short posts are rejected so the agent can rewrite in-thread');

  const longBody = (url: string) => {
    const sentence = 'Operators keep a written record of decisions so the next person can pick up the work. ';
    return `# Why durable context matters\n\nThe source is ${url}.\n\n` + sentence.repeat(80);
  };

  sub = await mcpPay('submit_placement', {
    publisher_id: 'cs_aaa111bbb222',
    target_url: 'https://contextengine.com/docs/overview',
    anchor_text: 'Context Engine',
    title: 'Why teams need a durable record of work',
    body: longBody('https://contextengine.com/docs/overview'),
    idempotency_key: 'post-1',
  }, payer.api_key).then(parsePay);
  assert(sub.error === 'INSUFFICIENT_CREDIT' && sub.checkout_url?.startsWith('https://checkout.stripe.com/'),
    'submit_placement returns Checkout for the shortfall when credits do not cover listed_price');
  assert(sub.required_cents === 24000, 'listed_price after admin markup 3× is $240');

  stripeCalls.length = 0;
  pr = await mcpPay('add_credits', { amount_usd: 180, idempotency_key: 'cover-240' }, payer.api_key);
  const cover = await parsePay(pr);
  assert(cover.amount_usd === 180, 'shortfall checkout is the exact remaining $180');
  const event2 = {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: cover.session_id,
        payment_status: 'paid',
        amount_total: 18000,
        customer: 'cus_test',
        metadata: { product: 'placement.sh', api_key: payer.api_key, email: 'payer@customer.test' },
        client_reference_id: payer.api_key,
      },
    },
  };
  const payload2 = JSON.stringify(event2);
  const mac3 = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload2}`)));
  const hex3 = [...mac3].map((b) => b.toString(16).padStart(2, '0')).join('');
  r = await worker.fetch(new Request('https://cite.test/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${hex3}` },
    body: payload2,
  }), stripeEnv);
  assert((await r.json()).credited === true, 'shortfall webhook credits the wallet');

  sub = await mcpPay('submit_placement', {
    publisher_id: 'cs_aaa111bbb222',
    target_url: 'https://contextengine.com/docs/overview',
    anchor_text: 'Context Engine',
    title: 'Why teams need a durable record of work',
    body: longBody('https://contextengine.com/docs/overview'),
    idempotency_key: 'post-1',
  }, payer.api_key).then(parsePay);
  assert(typeof sub.order_id === 'string' && sub.state === 'human_review', 'accepted post is stored for ops');
  assert(sub.held_cents === 24000 && sub.word_count >= 700, 'listed_price is held and word count is recorded');
  assert(!JSON.stringify(sub).includes('secret-example'), 'buyer submit response does not reveal the domain');

  const againPost = await mcpPay('submit_placement', {
    publisher_id: 'cs_aaa111bbb222',
    target_url: 'https://contextengine.com/docs/overview',
    title: 'Why teams need a durable record of work',
    body: longBody('https://contextengine.com/docs/overview'),
    idempotency_key: 'post-1',
  }, payer.api_key).then(parsePay);
  assert(againPost.order_id === sub.order_id, 'same idempotency_key does not create a second order');

  r = await worker.fetch(new Request('https://cite.test/admin/api/orders', { headers: auth }), stripeEnv);
  const orders = await r.json();
  assert(r.status === 200 && orders.orders?.[0]?.domain === 'secret-example.com', 'ops Orders API shows the publisher domain');
  assert(orders.orders[0].buyer_email === 'payer@customer.test', 'ops Orders API shows the buyer');
  assert(orders.orders[0].title.includes('durable record'), 'ops Orders API shows the submitted title');
  assert(typeof orders.orders[0].body === 'string' && orders.orders[0].body.length > 200,
    'ops Orders API includes the post body so operators can copy it');

  const other = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_other', payment_status: 'paid', amount_total: 999, metadata: { product: 'shortlist-other' } } },
  });
  const mac2 = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${other}`)));
  const hex2 = [...mac2].map((b) => b.toString(16).padStart(2, '0')).join('');
  r = await worker.fetch(new Request('https://cite.test/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${hex2}` },
    body: other,
  }), stripeEnv);
  assert((await r.json()).credited === false, 'webhooks ignore non-placement.sh Stripe sessions');

  globalThis.fetch = prevFetch2;
  console.log('\nall stripe-credits checks passed');
}

// ---------- free opportunities (SPEC §19) ----------
// The free path has no account, so these run with no auth at all. What is being
// checked is that the gates suppress honestly, that nothing operator-only leaks,
// and that we never dress an unverified fact up as a verified one.
{
  sq.exec(`
    INSERT INTO opportunity_playbooks (id, automation_level, agent_mode, agent_can_do, human_must_do,
      action_recipe, safety_guardrail, recommended_action, required_form_information, copy_to_prepare,
      assets_to_prepare, eligibility_proof, customer_only_inputs, agent_can_infer, account_verification,
      human_handoff, login_auth, captcha, email_verification, editorial_approval, likely_blockers,
      required_credentials, autonomy_score)
    VALUES ('pb_test', 'High automation potential', 'Agent can prepare + attempt submission',
      'Draft the listing copy', 'Approve and submit',
      'OPEN -> CHECK -> DRAFT -> HUMAN SUBMITS', 'Never bypass CAPTCHA or fabricate reviews.',
      'Create or claim profile',
      'canonical company/product name | canonical HTTPS URL | primary category | contact email',
      'tagline 40-60 characters | short description 150-250 characters',
      'square logo PNG 512x512', 'website confirms identity',
      'authorized account owner/email | approval of final claims', 'name and URL from website',
      'Login may be required', 'Authenticate; complete CAPTCHA; approve final submission',
      'Not identified', 'Unknown until form is opened', 'Possible', 'Not identified',
      'CAPTCHA unknown', 'None expected initially', 60);

    INSERT INTO opportunities (id, source, platform, domain, submission_url, contribution,
      opportunity_type, best_for, niche, cost_model, cost_confidence, is_free_confirmed,
      requires_reciprocal_link, link_attribute_claim, primary_benefit, verification_level,
      last_checked, priority_score, priority_tier, needs_reverification, services_allowed,
      requires_software, requires_license, eligible_entity_types, hard_exclusions, fit_question,
      contact_email, note, agent_instructions, discovery_source, verification_source,
      prep_minutes, requirement_confidence, agent_prompt, playbook_id, status)
    VALUES
      ('opp_dir', 'workbook-2026-08', 'Test Directory', 'testdir.test', 'https://testdir.test/submit',
       'profile', 'SaaS/software directory', 'B2B software', 'Software', 'Free or freemium', 'secondary', 1,
       0, 'claimed_dofollow', 'Buyer discovery', 'Automated page scan + secondary source',
       '2026-08-20', 80, 'Tier 1', 1, 'Conditional', 1, 0, 'SaaS; software product',
       'Agency without a product', 'Does the company ship software?',
       'private@testdir.test', 'PRIVATE OPERATOR NOTE', 'PRIVATE AGENT INSTRUCTION',
       'https://discovery.example', 'https://verify.example', 25,
       'Opportunity-class preparation template — verify live form',
       'Using only verified company evidence, prepare Test Directory.', 'pb_test', 'active'),
      ('opp_licensed', 'workbook-2026-08', 'Licensed Pros', 'licensed.test', 'https://licensed.test/apply',
       'profile', 'Niche directory: Legal', 'Licensed practitioners', 'Legal', 'Unknown — verify', 'unknown', 0,
       0, 'unknown', 'Credibility', 'Reachability confirmed + secondary source',
       '2026-08-20', 70, 'Tier 2', 1, 'Yes', 0, 1, 'Law firms', 'Unlicensed providers',
       'Is the practitioner licensed?', NULL, NULL, NULL, NULL, NULL, 45,
       'Opportunity-class preparation template — verify live form', NULL, 'pb_test', 'active'),
      ('opp_swap', 'workbook-2026-08', 'Swap Blog', 'swap.test', 'https://swap.test/write',
       'article', 'Community/publishing platform', 'Anyone', 'Tech', 'Free listing requiring a reciprocal link',
       'secondary', 1, 1, 'claimed_nofollow', 'Referral traffic', 'Reachability confirmed + secondary source',
       '2026-08-20', 60, 'Tier 3', 1, 'Yes', 0, 0, 'Any', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 30,
       'Opportunity-class preparation template — verify live form', NULL, 'pb_test', 'active'),
      ('opp_hidden', 'workbook-2026-08', 'Dead Directory', 'dead.test', 'https://dead.test',
       'profile', 'General startup/business directory', 'Startups', 'Software', 'Unknown — verify', 'unknown', 0,
       0, 'unknown', NULL, 'Secondary source only', '2026-08-20', 20, 'Research', 1, 'Yes', 0, 0,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pb_test', 'watchlist');
  `);

  const COMPANY_HTML = `<!doctype html><html><head>
    <title>Acme Ops | Close your books faster</title>
    <meta name="description" content="Acme Ops is the finance platform B2B teams close their books on.">
    <meta property="og:image" content="https://acme.test/card.png">
    </head><body>
    <h2>Start your free trial of the Acme platform</h2>
    <h2>Trusted by finance teams at 200 companies</h2>
    <p>Our AI-powered software integrates with your ledger. Read the case studies.</p>
    </body></html>`;
  const LISTING_HTML = `<!doctype html><html><body>
    <h1>Acme Ops</h1><a href="https://acme.test" rel="nofollow ugc">Visit site</a>
    </body></html>`;

  const prevFetch3 = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.startsWith('https://acme.test')) return new Response(COMPANY_HTML, { status: 200 });
    if (url.startsWith('https://testdir.test/listing')) return new Response(LISTING_HTML, { status: 200 });
    if (url.startsWith('https://gone.test')) return new Response('nope', { status: 404 });
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await f('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    return { raw: body.result.content[0].text as string, data: JSON.parse(body.result.content[0].text) };
  };

  // --- analyze_site ---
  let out = await call('analyze_site', { url: 'acme.test' });
  const companyId = out.data.company_id as string;
  const workspace = out.data.workspace_key as string;
  assert(companyId?.startsWith('co_') && workspace?.startsWith('ws_'), 'analyze_site mints a company and workspace');
  assert(out.data.profile.entity_type === 'software', 'entity type read from the page');
  assert(out.data.profile.signals.software.value === 'yes' && out.data.profile.signals.software.basis === 'observed',
    'software signal is observed, not assumed');
  assert(out.data.profile.signals.ai.value === 'yes', 'AI signal read from the page');
  assert(out.data.profile.signals.customers.value === 'yes', 'customer proof read from the page');
  assert(out.data.profile.signals.license.value === 'unknown' && out.data.profile.signals.certification.value === 'unknown',
    'a licence or certification is NEVER inferred from a homepage');
  assert((out.data.could_not_determine as string[]).includes('license'), 'unknown credentials are reported, not hidden');

  out = await call('analyze_site', { url: 'https://gone.test' });
  assert(out.data.error === 'SITE_UNREACHABLE', 'an unreadable site is an error, not an invented profile');

  // --- search_opportunities ---
  out = await call('search_opportunities', { company_id: companyId });
  let ids = (out.data.opportunities as { opportunity_id: string }[]).map((o) => o.opportunity_id);
  assert(ids.includes('opp_dir'), 'a matching directory is offered');
  assert(!ids.includes('opp_licensed'), 'a licence-gated platform is suppressed while the licence is unknown');
  assert(!ids.includes('opp_hidden'), 'watchlist rows are never offered to a customer');
  assert((out.data.missing_inputs?.asks as string[]).some((a) => /licence/i.test(a)),
    'suppression surfaces the question to ask the human');
  assert(out.data.suppressed_count >= 1 && out.data.suppression_reasons.length >= 1,
    'suppressions are counted and explained');
  assert(!/private@testdir|PRIVATE OPERATOR NOTE|PRIVATE AGENT INSTRUCTION|discovery\.example/.test(out.raw),
    'search payload never leaks operator-only fields');
  assert(!/secret-example|hidden-blog/.test(out.raw), 'free search never exposes paid publisher domains');

  {
    const dir = (out.data.opportunities as Record<string, unknown>[]).find((o) => o.opportunity_id === 'opp_dir')!;
    assert(dir.link_attribute_claim === 'claimed_dofollow', 'the link attribute is labelled a claim');
    assert(dir.needs_reverification === true, 'template-sourced requirements are flagged for re-verification');
    const swap = (out.data.opportunities as Record<string, unknown>[]).find((o) => o.opportunity_id === 'opp_swap');
    assert(swap && (swap.why_fit as string[]).some((w) => /reciprocal/i.test(w)),
      'a reciprocal-link requirement is stated up front');
  }

  // The human answers the licence question; only then does the gate open.
  out = await call('analyze_site', { url: 'acme.test', workspace_key: workspace, stated: { license: true } });
  assert(out.data.company_id === companyId, 're-analysing the same URL updates the profile instead of forking it');
  assert(out.data.profile.signals.license.basis === 'stated', 'a stated credential is marked as stated, not observed');
  out = await call('search_opportunities', { company_id: companyId });
  ids = (out.data.opportunities as { opportunity_id: string }[]).map((o) => o.opportunity_id);
  assert(ids.includes('opp_licensed'), 'the licence-gated platform appears once the human confirms the licence');

  out = await call('search_opportunities', { company_id: companyId, free_only: true });
  ids = (out.data.opportunities as { opportunity_id: string }[]).map((o) => o.opportunity_id);
  assert(ids.includes('opp_dir') && !ids.includes('opp_licensed'),
    'free_only excludes rows whose cost was never established');

  // --- get_opportunity ---
  out = await call('get_opportunity', { opportunity_id: 'opp_dir', company_id: companyId });
  assert(out.data.preparation.required_form_information.includes('canonical company/product name'),
    'the class playbook supplies the form spec');
  assert(out.data.execution.human_must_do === 'Approve and submit', 'the human checkpoint is explicit');
  assert((out.data.caveats as string[]).some((c) => /promise approval/i.test(c)),
    'every detail payload says nobody can promise approval');
  assert(out.data.eligible_for_this_company === true, 'eligibility verdict travels with the record');
  assert(!/PRIVATE OPERATOR NOTE|private@testdir/.test(out.raw), 'detail payload never leaks operator-only fields');

  // --- prepare_submission ---
  out = await call('prepare_submission', { opportunity_id: 'opp_dir', company_id: companyId });
  assert(out.data.fields.some((x: { field: string; value?: string }) => x.field === 'canonical HTTPS URL' && x.value),
    'a field the evidence answers is filled in');
  assert((out.data.missing_inputs as string[]).includes('contact email'),
    'a contact email is asked for, never invented');
  assert((out.data.guardrails as string[]).some((g) => /not claim a licence/i.test(g)),
    'the packet forbids claiming credentials the customer has not confirmed');
  assert(/never create a duplicate/i.test(out.data.check_for_an_existing_listing as string),
    'the packet requires searching for an existing listing first');
  assert(typeof out.data.you_write_the_copy === 'string', 'the agent is told it writes the copy, not the Worker');

  out = await call('prepare_submission', { opportunity_id: 'opp_swap', company_id: 'co_not_a_real_company' });
  assert(out.data.error === 'COMPANY_NOT_FOUND', 'preparation needs a real company');

  // --- submissions ---
  out = await call('record_submission', { company_id: companyId, opportunity_id: 'opp_dir', state: 'submitted', reference: 'REF-1' });
  const submissionId = out.data.submission_id as string;
  assert(submissionId?.startsWith('sub_') && out.data.updated === false, 'first record creates a submission');
  out = await call('record_submission', {
    company_id: companyId, opportunity_id: 'opp_dir', state: 'live',
    published_url: 'https://testdir.test/listing/acme',
  });
  assert(out.data.submission_id === submissionId && out.data.updated === true && out.data.previous_state === 'submitted',
    'recording the same company+opportunity updates instead of duplicating');
  out = await call('record_submission', { company_id: companyId, opportunity_id: 'opp_dir', state: 'invented' });
  assert(out.data.error === 'BAD_STATE', 'an unknown state is rejected');

  // --- check_listing_status ---
  out = await call('check_listing_status', { submission_id: submissionId, company_id: companyId });
  assert(out.data.link_found === true, 'the live link is found on the listing');
  assert(out.data.observed_rel === 'nofollow ugc',
    'the OBSERVED rel is recorded, even though the catalog claimed dofollow');
  assert(out.data.page_indexable === true, 'indexability is observed from the page');

  out = await call('list_submissions', { company_id: companyId });
  assert(out.data.result_count === 1 && out.data.submissions[0].observed_rel === 'nofollow ugc',
    'submissions list carries the observed attribute');
  out = await call('list_submissions', { company_id: 'co_someone_else' });
  assert(out.data.error === 'COMPANY_NOT_FOUND', 'another company id cannot read these submissions');

  // --- the paid path is unchanged and still separate ---
  out = await call('search_publishers', { topics: ['finance'] });
  assert(!/opp_dir|testdir\.test/.test(out.raw), 'free opportunities never appear in paid publisher search');

  // --- operator console API ---
  r = await f('/admin/api/opportunities');
  assert(r.status === 401, 'opportunities API needs auth');
  r = await f('/admin/api/opportunities', { headers: auth });
  let ops = await r.json();
  assert(ops.total === 3 && !ops.opportunities.some((o: { status: string }) => o.status === 'watchlist'),
    'operator list defaults to active opportunities');
  assert(ops.opportunities.some((o: { contact_email: string }) => o.contact_email === 'private@testdir.test'),
    'operators DO see the private contact the buyer MCP hides');
  r = await f('/admin/api/opportunities?status=watchlist', { headers: auth });
  assert((await r.json()).opportunities[0].id === 'opp_hidden', 'the watchlist is reachable in the console');
  r = await f('/admin/api/opportunities?verified=needs', { headers: auth });
  assert((await r.json()).total === 3, 'every imported row starts flagged for re-verification');
  r = await f('/admin/api/opportunities?cost=unknown', { headers: auth });
  assert((await r.json()).opportunities[0].id === 'opp_licensed', 'unverified-cost rows can be listed');

  r = await f('/admin/api/opportunities/opp_dir', { method: 'PATCH', headers: auth, body: JSON.stringify({ verified: true }) });
  {
    const patched = (await r.json()).opportunity;
    assert(patched.needs_reverification === 0 && /Operator confirmed/.test(patched.verification_level),
      'an operator stamping a live page clears the template flag');
    assert(patched.verified_at && patched.verify_source === 'operator',
      'and leaves the same provenance trail the crawler does');
  }
  r = await f('/admin/api/opportunities/opp_dir', { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'nonsense' }) });
  assert(r.status === 400, 'an unknown opportunity status is rejected');

  r = await f('/admin/api/submissions', { headers: auth });
  {
    const subs = await r.json();
    assert(subs.total === 1 && subs.submissions[0].platform === 'Test Directory',
      'the console shows customer submissions with their platform');
    assert(subs.submissions[0].company_url === 'https://acme.test', 'and which company they belong to');
    assert(subs.by_state.live === 1 && subs.companies === 1, 'submission states and company count are summarised');
  }
  r = await f('/admin/api/stats', { headers: auth });
  {
    const st = await r.json();
    assert(st.opportunities === 3, 'stats counts active opportunities');
    assert(st.opportunities_unverified === 2, 'stats counts what still needs verifying');
  }

  globalThis.fetch = prevFetch3;
  console.log('\nall free-opportunity checks passed');
}

// ---------- verified facts beat the class template (migration 011) ----------
// The workbook told us what platforms of a KIND ask for. A live page read tells
// us what THIS one asks for. When both exist the payload must answer from the
// page, and must say which it used — an agent should weigh them differently.
{
  sq.exec(`
    INSERT INTO opportunities (id, source, platform, domain, submission_url, contribution,
      opportunity_type, niche, cost_model, cost_confidence, is_free_confirmed, link_attribute_claim,
      verification_level, priority_score, priority_tier, needs_reverification, playbook_id, status,
      verified_cost_model, verified_is_free, verified_requirements, verified_eligibility,
      verified_submission_mechanism, verified_at, verify_source, verify_note, liveness, final_url)
    VALUES
      ('opp_read', 'workbook-2026-08', 'Read Directory', 'read.test', 'https://read.test/submit',
       'profile', 'SaaS/software directory', 'Software', 'Free or freemium', 'secondary', 1,
       'claimed_dofollow', 'Live page read 2026-08-21', 75, 'Tier 1', 0, 'pb_test', 'active',
       'Free to list; $79 to be featured', 1,
       '["company name","live URL","logo 400x400","founder email"]',
       '["must have a public pricing page"]',
       'form', '2026-08-21T02:10:00.000Z', 'llm-page-read-v1',
       'Free to list, but the page pushes a paid upgrade — say so before recommending it.',
       'live', 'https://read.test/submit-your-tool'),
      ('opp_notfree', 'workbook-2026-08', 'Turns Out Paid', 'paid.test', 'https://paid.test/submit',
       'profile', 'SaaS/software directory', 'Software', 'Free or freemium', 'secondary', 1,
       'unknown', 'Live page read 2026-08-21', 70, 'Tier 2', 0, 'pb_test', 'active',
       '$149 one-time listing fee', 0, '["company name"]', NULL, 'form',
       '2026-08-21T02:11:00.000Z', 'llm-page-read-v1',
       'Catalog says free; the live page says otherwise ($149 one-time listing fee).', 'live', NULL);
  `);

  // This block runs after the fetch stub is restored, so give it a company
  // profile directly rather than crawling for one.
  const gateKeys = ['software', 'ai', 'open_source', 'integration', 'location',
    'customers', 'launch', 'visuals', 'license', 'certification', 'membership'];
  const evidence = {
    canonical_url: 'https://acme.test', name: 'Acme Ops', summary: 'Finance platform.',
    topics: ['finance', 'software'], entity_type: 'software',
    signals: Object.fromEntries(gateKeys.map((k) => [k, k === 'software'
      ? { value: 'yes', basis: 'observed' }
      : { value: 'unknown', basis: 'unknown' }])),
  };
  const companyId = 'co_verified_test';
  sq.prepare(`INSERT INTO company_profiles (id, workspace_key, canonical_url, name, evidence, created_at, updated_at)
              VALUES (?, 'ws_verified_test', 'https://acme.test', 'Acme Ops', ?, datetime('now'), datetime('now'))`)
    .run(companyId, JSON.stringify(evidence));

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await f('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    return { raw: body.result.content[0].text as string, data: JSON.parse(body.result.content[0].text) };
  };

  let out = await call('get_opportunity', { opportunity_id: 'opp_read' });
  assert(/read from the live page on 2026-08-21/.test(out.data.facts_from),
    'a verified row says the facts came from the live page, with the date');
  assert(/read from the live page on 2026-08-21/.test(out.data.cost),
    'the cost line stops hedging once the page has been read');
  assert(out.data.cost_confidence === 'read from the live page', 'confidence reflects the read');
  assert(out.data.preparation_source === 'read from the live page on 2026-08-21',
    'preparation names the live page as its source');
  assert(out.data.verified_requirements.includes('founder email'),
    'the real form fields are exposed');
  assert(out.data.how_to_submit === 'form', 'the submission mechanism read from the page is exposed');
  assert(!(out.data.caveats as string[]).some((c) => /class template/.test(c)),
    'a verified row no longer warns about a class template');
  assert((out.data.caveats as string[]).some((c) => /Pages change/.test(c)),
    'but it still tells the agent to glance at the form');
  assert((out.data.caveats as string[]).some((c) => /paid upgrade/.test(c)),
    'the upsell warning travels with the record');

  out = await call('get_opportunity', { opportunity_id: 'opp_swap' });
  assert(/class template/.test(out.data.facts_from),
    'an unverified row still admits it is answering from a template');
  out = await call('get_opportunity', { opportunity_id: 'opp_dir' });
  assert(/confirmed by a placement\.sh operator/.test(out.data.facts_from),
    'an operator-confirmed row says a person confirmed it, not that a crawler read it');

  // prepare_submission must ask for what the real form asks for.
  out = await call('prepare_submission', { opportunity_id: 'opp_read', company_id: companyId });
  assert(out.data.fields_from === 'the real form — read from the live page on 2026-08-21',
    'the packet says the fields came from the real form');
  assert((out.data.fields as { field: string }[]).some((x) => x.field === 'logo 400x400'),
    'the packet asks for the size the live form actually wants');
  assert((out.data.guardrails as string[]).some((g) => /paid upgrade/.test(g)),
    'the packet leads with the disagreement the crawl found');
  assert(out.data.submission_url === 'https://read.test/submit-your-tool',
    'the packet points at where the submission URL actually redirected to');

  // A page read that found no free path must override the workbook's guess.
  out = await call('search_opportunities', { company_id: companyId, free_only: true });
  {
    const ids = (out.data.opportunities as { opportunity_id: string }[]).map((o) => o.opportunity_id);
    assert(ids.includes('opp_read'), 'a verified free listing still shows under free_only');
    assert(!ids.includes('opp_notfree'),
      'a row the live page proved is paid is excluded from free_only, whatever the workbook said');
  }
  out = await call('get_opportunity', { opportunity_id: 'opp_notfree' });
  assert(out.data.is_free_confirmed === false,
    'the live read overrides the workbook even when it is bad news');
  assert(/no free path/.test(out.data.cost), 'and the payload says so plainly');
  assert(/Catalog says free/.test(out.data.caution ?? ''),
    'the contradiction is surfaced rather than quietly resolved');

  console.log('\nall verified-facts checks passed');
}

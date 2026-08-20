// Renders the real ADMIN_HTML in headless Chromium against a stubbed API.
// Catches what unit tests cannot: a syntax error in the inline script, which
// silently blanks the whole console.
// Run: npm run test:console   (needs playwright-core + a local Chromium)
import { chromium } from 'playwright-core';
import { ADMIN_HTML } from '../src/admin-ui.js';
const html = ADMIN_HTML;
const sites = [{ id: 'cs_1', domain: 'a.com', niche: 'Business', cite_score: 70, dr: 60, traffic: 4200,
  traffic_band: '1k–5k/mo', seller_price: 100, markup: 1.6, listed_price: 160, margin: 60,
  link_attribute: 'unknown', max_links_per_post: null, status: 'active', cost_type: 'paid',
  acquisition_mode: 'paid_placement' }];
const freeSites = [{ id: 'cs_2', domain: 'free.com', niche: 'Tech', cite_score: 80, dr: 70, traffic: 9000,
  traffic_band: '5k–25k/mo', seller_price: null, markup: 1.6, listed_price: null, margin: null,
  link_attribute: 'nofollow', status: 'active', cost_type: 'free', acquisition_mode: 'self_serve',
  requires_reciprocal_link: 1, agent_instructions: 'Register and publish.' }];

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage();
const errs = [];
pg.on('pageerror', e => errs.push(e.message));
pg.on('console', m => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // The Inter webfont is fetched from fonts.googleapis.com and cannot load in a
  // sandbox with no egress. That is the environment, not a broken console.
  if (/Failed to load resource/.test(t)) return;
  errs.push('console: ' + t);
});
await pg.route('http://cite.local/admin', r => r.fulfill({ contentType: 'text/html', body: html }));
await pg.route('**/admin/api/**', r => {
  const u = r.request().url();
  if (u.includes('/engine/me')) return r.fulfill({ json: { engine: { display_name: 'Shortlist' }, abilities: ['*:read'], user: { name: 'David' }, panels: { recent: 'recent-tool', signals: 'signals-tool', search: 'search-tool' } } });
  if (u.includes('/engine/')) return r.fulfill({ json: { tool: 'x', data: { results: [] } } });
  if (u.includes('/api/stats')) return r.fulfill({ json: { sites: 9467, active: 9467, paid_sites: 8968, free_sites: 499, priced: 8210, paid_unpriced: 787, avg_markup: 1.6, avg_margin: 60, attr_unknown: 9400 } });
  if (u.includes('/api/analytics')) return r.fulfill({ json: { accounts: { total: 0 }, activity: {}, by_tool: [], daily: [], signups: [], unmet_demand: [], top_topics: [], free_placements_by_site: [], inventory_readiness: {} } });
  if (u.includes('/api/keys')) return r.fulfill({ json: { keys: [], mcp_url: 'http://cite.local/admin/mcp' } });
  if (u.includes('/api/checkouts')) return r.fulfill({ json: { started: 1, paid: 0, abandoned_count: 1, abandoned_cents: 19500, abandoned: [{ email: 'buyer@example.com', amount_cents: 19500, status: 'follow_up', created_at: '2026-08-19 16:00:00', checkout_url: 'https://checkout.stripe.com/c/pay/cs_test' }] } });
  if (u.includes('/api/orders')) return r.fulfill({ json: { orders: [{
    id: 'ord_1', state: 'human_review', publisher_id: 'cs_1', domain: 'secret.com',
    target_url: 'https://buyer.test/', anchor_text: 'Buyer', title: 'A post',
    body: 'Hello world post body', listed_price_cents: 16000, word_count: 800,
    created_at: '2026-08-19T12:00:00Z', buyer_email: 'a@b.test',
  }] } });
  if (u.includes('/api/sites')) return u.includes('cost_type=free')
    ? r.fulfill({ json: { total: 499, page: 1, per_page: 50, sites: freeSites } })
    : r.fulfill({ json: { total: 8968, page: 1, per_page: 50, sites } });
  return r.fulfill({ json: {} });
});
await pg.goto('http://cite.local/admin', { waitUntil: 'load' });
await pg.waitForTimeout(1200);
const rowCount = await pg.locator('#rows tr').count();
console.log('rows:', rowCount);
if (rowCount < 1) { console.error('FAIL: inventory table rendered no rows'); process.exitCode = 1; }
const logo = await pg.locator('.logo').textContent();
if (!/shortlist/.test(logo || '')) { console.error('FAIL: Shortlist wordmark missing'); process.exitCode = 1; }
let lastSites = '';
pg.on('request', req => { if (req.url().includes('/admin/api/sites')) lastSites = req.url(); });
await pg.click('#pane-inv th[data-sort="listed_price"]');
await pg.waitForTimeout(600);
if (!/sort=listed_price/.test(lastSites)) {
  console.error('FAIL: clicking Listed $ did not sort, last request', lastSites);
  process.exitCode = 1;
}
console.log('sort request:', lastSites);
// The free section is its own tab, loaded the first time it is opened.
await pg.click('#tab-free');
await pg.waitForTimeout(700);
const freeRows = await pg.locator('#rows_free tr').count();
console.log('free rows:', freeRows);
if (freeRows < 1) { console.error('FAIL: free inventory rendered no rows'); process.exitCode = 1; }
if (!/cost_type=free/.test(lastSites)) {
  console.error('FAIL: free tab did not ask for free sites, last request', lastSites);
  process.exitCode = 1;
}
const freeHeads = await pg.locator('#pane-free thead th').allTextContents();
if (freeHeads.some(h => /Seller|Listed|Margin|Markup/.test(h))) {
  console.error('FAIL: free table still shows price columns', freeHeads);
  process.exitCode = 1;
}
await pg.click('#pane-free th[data-sort="dr"]');
await pg.waitForTimeout(600);
if (!/cost_type=free/.test(lastSites) || !/sort=dr/.test(lastSites)) {
  console.error('FAIL: sorting the free table lost the section, last request', lastSites);
  process.exitCode = 1;
}
await pg.click('#tab-inv');
await pg.waitForTimeout(400);

for (const tab of ['free', 'ord', 'fol', 'ana', 'eng', 'key']) {
  await pg.click('#tab-' + tab);
  await pg.waitForTimeout(500);
  const visible = await pg.locator('#pane-' + tab).isVisible();
  console.log('tab', tab, 'visible:', visible);
  if (!visible) { console.error('FAIL: tab ' + tab + ' did not open'); process.exitCode = 1; }
}
await pg.click('#tab-fol');
await pg.waitForTimeout(400);
{
  const fol = await pg.locator('#pane-fol').textContent();
  if (!/buyer@example.com/.test(fol || '')) {
    console.error('FAIL: Follow-up tab did not show the unpaid checkout email');
    process.exitCode = 1;
  }
  if (!/Did not finish/.test(fol || '')) {
    console.error('FAIL: Follow-up tab did not count unfinished checkouts');
    process.exitCode = 1;
  }
}
console.log('page errors:', errs.length ? errs : 'none');
if (errs.length) { console.error('FAIL: the console page threw'); process.exitCode = 1; }
await b.close();

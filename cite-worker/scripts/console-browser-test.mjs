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

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage();
const errs = [];
pg.on('pageerror', e => errs.push(e.message));
pg.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await pg.route('http://cite.local/admin', r => r.fulfill({ contentType: 'text/html', body: html }));
await pg.route('**/admin/api/**', r => {
  const u = r.request().url();
  if (u.includes('/engine/me')) return r.fulfill({ json: { engine: { display_name: 'Shortlist' }, abilities: ['*:read'], user: { name: 'David' }, panels: { recent: 'recent-tool', signals: 'signals-tool', search: 'search-tool' } } });
  if (u.includes('/engine/')) return r.fulfill({ json: { tool: 'x', data: { results: [] } } });
  if (u.includes('/api/stats')) return r.fulfill({ json: { sites: 9467, active: 9467, priced: 8210, avg_markup: 1.6, avg_margin: 60, attr_unknown: 9400 } });
  if (u.includes('/api/analytics')) return r.fulfill({ json: { accounts: { total: 0 }, activity: {}, by_tool: [], daily: [], signups: [], unmet_demand: [], top_topics: [], free_placements_by_site: [], inventory_readiness: {} } });
  if (u.includes('/api/keys')) return r.fulfill({ json: { keys: [], mcp_url: 'http://cite.local/admin/mcp' } });
  if (u.includes('/api/sites')) return r.fulfill({ json: { total: 9467, page: 1, per_page: 50, sites } });
  return r.fulfill({ json: {} });
});
await pg.goto('http://cite.local/admin', { waitUntil: 'load' });
await pg.waitForTimeout(1200);
const rowCount = await pg.locator('#rows tr').count();
console.log('rows:', rowCount);
if (rowCount < 1) { console.error('FAIL: inventory table rendered no rows'); process.exitCode = 1; }
for (const tab of ['ana', 'eng', 'key']) {
  await pg.click('#tab-' + tab);
  await pg.waitForTimeout(500);
  const visible = await pg.locator('#pane-' + tab).isVisible();
  console.log('tab', tab, 'visible:', visible);
  if (!visible) { console.error('FAIL: tab ' + tab + ' did not open'); process.exitCode = 1; }
}
console.log('page errors:', errs.length ? errs : 'none');
if (errs.length) { console.error('FAIL: the console page threw'); process.exitCode = 1; }
await b.close();

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
const opportunities = [
  { id: 'opp_1', platform: 'Test Directory', domain: 'testdir.test', submission_url: 'https://testdir.test/submit',
    contribution: 'profile', opportunity_type: 'SaaS/software directory', niche: 'Software',
    cost_model: 'Free or freemium', cost_confidence: 'secondary', is_free_confirmed: 1,
    requires_reciprocal_link: 0, link_attribute_claim: 'claimed_dofollow', priority_score: 80,
    prep_minutes: 25, verification_level: 'Automated page scan + secondary source',
    needs_reverification: 1, status: 'active' },
  { id: 'opp_2', platform: 'Swap Blog', domain: 'swap.test', submission_url: 'https://swap.test/write',
    contribution: 'article', opportunity_type: 'Community/publishing platform', niche: 'Tech',
    cost_model: 'Unknown — verify', cost_confidence: 'unknown', is_free_confirmed: 0,
    requires_reciprocal_link: 1, link_attribute_claim: 'unknown', priority_score: 60,
    prep_minutes: 30, verification_level: 'Reachability confirmed + secondary source',
    needs_reverification: 0, last_checked: '2026-08-20', status: 'active' },
];
const submissions = [{ id: 'sub_1', state: 'live', published_url: 'https://testdir.test/listing/acme',
  observed_rel: 'nofollow ugc', observed_indexed: 1, updated_at: '2026-08-20 12:00:00',
  company_url: 'https://acme.test', platform: 'Test Directory', contribution: 'profile' }];

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
  if (u.includes('/api/stats')) return r.fulfill({ json: { sites: 8968, active: 8968, paid_sites: 8968, opportunities: 1330, opportunities_unverified: 842, priced: 8210, paid_unpriced: 787, avg_markup: 1.6, avg_margin: 60, attr_unknown: 9400 } });
  if (u.includes('/api/analytics')) return r.fulfill({ json: { accounts: { total: 0 }, activity: {}, by_tool: [], daily: [], signups: [], unmet_demand: [], top_topics: [], free_placements_by_site: [], inventory_readiness: {} } });
  if (u.includes('/api/keys')) return r.fulfill({ json: { keys: [], mcp_url: 'http://cite.local/admin/mcp' } });
  if (u.includes('/api/checkouts')) return r.fulfill({ json: { started: 1, paid: 0, abandoned_count: 1, abandoned_cents: 19500, abandoned: [{ email: 'buyer@example.com', amount_cents: 19500, status: 'follow_up', created_at: '2026-08-19 16:00:00', checkout_url: 'https://checkout.stripe.com/c/pay/cs_test' }] } });
  if (u.includes('/api/orders')) return r.fulfill({ json: { orders: [{
    id: 'ord_1', state: 'human_review', publisher_id: 'cs_1', domain: 'secret.com',
    target_url: 'https://buyer.test/', anchor_text: 'Buyer', title: 'A post',
    body: 'Hello world post body', listed_price_cents: 16000, word_count: 800,
    created_at: '2026-08-19T12:00:00Z', buyer_email: 'a@b.test',
  }] } });
  if (u.includes('/api/opportunities')) return r.fulfill({ json: { total: 1330, page: 1, per_page: 50, opportunities, sort: 'priority_score', dir: 'desc' } });
  if (u.includes('/api/submissions')) return r.fulfill({ json: { total: 1, submissions, by_state: { live: 1 }, companies: 1 } });
  if (u.includes('/api/sites')) return r.fulfill({ json: { total: 8968, page: 1, per_page: 50, sites } });
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
// The opportunities catalog is its own tab, loaded the first time it is opened.
let lastOpps = '';
pg.on('request', req => { if (req.url().includes('/admin/api/opportunities')) lastOpps = req.url(); });
await pg.click('#tab-opp');
await pg.waitForTimeout(700);
const oppRows = await pg.locator('#rows_opp tr').count();
console.log('opportunity rows:', oppRows);
if (oppRows < 1) { console.error('FAIL: opportunities rendered no rows'); process.exitCode = 1; }
{
  const pane = await pg.locator('#pane-opp').textContent();
  // Confidence has to be visible at a glance: this catalog is mostly unverified.
  if (!/template — verify/.test(pane || '')) {
    console.error('FAIL: unverified rows are not flagged in the table');
    process.exitCode = 1;
  }
  if (!/not established/.test(pane || '')) {
    console.error('FAIL: an unknown cost is not called out');
    process.exitCode = 1;
  }
  if (!/claimed dofollow/.test(pane || '')) {
    console.error('FAIL: the link attribute is not labelled a claim');
    process.exitCode = 1;
  }
  const heads = await pg.locator('#pane-opp thead th').allTextContents();
  if (heads.some(h => /Seller|Listed|Margin|Markup/.test(h))) {
    console.error('FAIL: the opportunities table shows price columns', heads);
    process.exitCode = 1;
  }
}
await pg.click('#pane-opp th[data-sort="prep_minutes"]');
await pg.waitForTimeout(600);
if (!/sort=prep_minutes/.test(lastOpps)) {
  console.error('FAIL: sorting the opportunities table did not request a sort', lastOpps);
  process.exitCode = 1;
}
await pg.click('#tab-sub');
await pg.waitForTimeout(700);
{
  const pane = await pg.locator('#pane-sub').textContent();
  if (!/acme\.test/.test(pane || '')) {
    console.error('FAIL: submissions tab did not show the customer');
    process.exitCode = 1;
  }
  if (!/nofollow ugc/.test(pane || '')) {
    console.error('FAIL: submissions tab did not show the observed link attribute');
    process.exitCode = 1;
  }
}
await pg.click('#tab-inv');
await pg.waitForTimeout(400);

for (const tab of ['opp', 'sub', 'ord', 'fol', 'ana', 'eng', 'key']) {
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

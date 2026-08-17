// Operator console UI (SPEC §16) — one inline page, no external assets.
// Served at /admin; talks to /admin/api/* with the bearer token the operator
// enters (kept in sessionStorage only).
export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cite — Operator Console</title>
<style>
  :root { --bg:#10141d; --surface:#171c29; --line:#2a3145; --ink:#e8eaf0; --muted:#98a0b3;
          --accent:#8fa8ff; --good:#4fc08d; --bad:#e0766c; --warn:#d8a94e; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:1240px; margin:0 auto; padding:20px 24px 60px; }
  h1 { font-size:20px; margin:0; } h1 small { color:var(--muted); font-weight:400; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:16px;
           padding-bottom:14px; border-bottom:1px solid var(--line); margin-bottom:16px; }
  .stats { display:flex; gap:20px; flex-wrap:wrap; color:var(--muted); font-size:13px; }
  .stats b { color:var(--ink); font-size:15px; }
  .stats .warn { color:var(--warn); }
  .bar { display:flex; gap:10px; flex-wrap:wrap; margin:14px 0; }
  input, select, button { background:var(--surface); color:var(--ink); border:1px solid var(--line);
    border-radius:7px; padding:7px 10px; font:inherit; }
  input:focus, select:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  button { cursor:pointer; } button.primary { background:var(--accent); color:#10141d; border-color:var(--accent); font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--muted); font-weight:500; padding:8px 10px; border-bottom:1px solid var(--line);
       position:sticky; top:0; background:var(--bg); white-space:nowrap; }
  td { padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td input { width:70px; padding:4px 6px; text-align:right; }
  td select { padding:4px 6px; }
  .domain { font-weight:600; } .sub { color:var(--muted); font-size:12px; }
  .margin-pos { color:var(--good); } .margin-neg { color:var(--bad); }
  .pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; }
  .pill.active { background:rgba(79,192,141,.12); color:var(--good); }
  .pill.paused { background:rgba(216,169,78,.12); color:var(--warn); }
  .pill.burned { background:rgba(224,118,108,.12); color:var(--bad); }
  .pill.unknown { background:rgba(152,160,179,.12); color:var(--muted); }
  #login { max-width:420px; margin:120px auto; text-align:center; }
  #login input { width:100%; margin:12px 0; text-align:center; }
  .toast { position:fixed; bottom:20px; right:20px; background:var(--surface); border:1px solid var(--line);
    border-left:3px solid var(--good); padding:10px 16px; border-radius:8px; display:none; }
  .toast.err { border-left-color:var(--bad); }
  .pager { display:flex; gap:8px; align-items:center; margin-top:14px; color:var(--muted); }
  details { margin:14px 0; } summary { cursor:pointer; color:var(--accent); }
  .addform { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; margin-top:10px; }
  .tabs { display:flex; gap:6px; margin:14px 0 4px; }
  .tab { background:transparent; border:1px solid var(--line); }
  .tab.active { background:var(--accent); color:#10141d; border-color:var(--accent); font-weight:600; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:16px 0; }
  .kpi { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .kpi .n { font-size:26px; font-variant-numeric:tabular-nums; }
  .kpi .l { font-size:12px; color:var(--muted); margin-top:4px; }
  .kpi.hi .n { color:var(--accent); }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:18px; }
  section h3 { font-size:14px; margin:18px 0 8px; font-weight:600; }
  section h3 small { color:var(--muted); font-weight:400; }
  .mini { width:100%; border-collapse:collapse; font-size:12.5px; }
  .mini td, .mini th { padding:5px 8px; border-bottom:1px solid var(--line); }
  .mini th { color:var(--muted); font-weight:500; text-align:left; }
  .mini td.n { text-align:right; font-variant-numeric:tabular-nums; }
  .empty { color:var(--muted); font-size:13px; padding:8px 0; }
  .barcell { background:linear-gradient(90deg,var(--accent) var(--w,0%),transparent 0); border-radius:3px; }
</style>
</head>
<body>
<div id="login" class="wrap">
  <h1>Cite <small>operator console</small></h1>
  <p style="color:var(--muted)">Paste the operator token (ADMIN_TOKEN secret).</p>
  <input id="tok" type="password" placeholder="operator token" autocomplete="off">
  <button class="primary" onclick="saveTok()">Enter</button>
  <p id="loginerr" style="color:var(--bad)"></p>
</div>

<div id="app" class="wrap" style="display:none">
  <header>
    <h1>Cite <small>operator console</small></h1>
    <div class="stats" id="stats"></div>
  </header>
  <div class="tabs">
    <button id="tab-inv" class="tab active" onclick="showTab('inv')">Inventory</button>
    <button id="tab-ana" class="tab" onclick="showTab('ana')">Analytics</button>
  </div>

  <div id="pane-inv">
  <div class="bar">
    <input id="q" placeholder="search domain / niche / note…" style="flex:1;min-width:220px">
    <select id="fniche"><option value="">all niches</option></select>
    <select id="fstatus"><option value="">all statuses</option><option>active</option><option>paused</option><option>burned</option></select>
    <select id="fcost"><option value="">paid + free</option><option value="free">free only</option><option value="paid">paid only</option></select>
    <select id="fmode"><option value="">all modes</option><option value="paid_placement">paid_placement</option><option value="self_serve">self_serve</option><option value="apply_editorial">apply_editorial</option><option value="link_exchange">link_exchange</option><option value="unavailable">unavailable</option></select>
    <button class="primary" onclick="load(1)">Search</button>
  </div>
  <details>
    <summary>+ Add site</summary>
    <div class="addform">
      <input id="a_domain" placeholder="domain.com">
      <input id="a_niche" placeholder="niche">
      <input id="a_seller" placeholder="seller $" type="number">
      <input id="a_markup" placeholder="markup (1.6)" type="number" step="0.1">
      <input id="a_email" placeholder="contact email">
      <button class="primary" onclick="addSite()">Add</button>
    </div>
  </details>
  <div style="overflow-x:auto">
  <table>
    <thead><tr>
      <th>Domain</th><th>Niche</th><th class="num">Score</th><th class="num">DR</th><th class="num">DA</th><th>Traffic</th>
      <th class="num">Seller $</th><th class="num">Markup</th><th class="num">Listed $</th><th class="num">Margin $</th>
      <th>Acquisition</th><th>Link attr</th><th class="num">Max links</th><th>Status</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
  </div>
  <div class="pager">
    <button onclick="load(page-1)">‹ prev</button>
    <span id="pageinfo"></span>
    <button onclick="load(page+1)">next ›</button>
  </div>
  </div>

  <div id="pane-ana" style="display:none">
    <div class="kpis" id="kpis"></div>
    <div class="cols">
      <section><h3>Signups</h3><div id="a_signups"></div></section>
      <section><h3>Activity — last 14 days</h3><div id="a_daily"></div></section>
      <section><h3>What agents search for</h3><div id="a_topics"></div></section>
      <section><h3>Unmet demand <small>searches returning nothing</small></h3><div id="a_unmet"></div></section>
      <section><h3>Tool usage</h3><div id="a_tools"></div></section>
      <section><h3>Free placements claimed</h3><div id="a_free"></div></section>
    </div>
    <section><h3>Inventory readiness</h3><div id="a_ready"></div></section>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
let page = 1;
const $ = (id) => document.getElementById(id);
const tok = () => sessionStorage.getItem('cite_tok') || '';
const hdrs = () => ({ 'authorization': 'Bearer ' + tok(), 'content-type': 'application/json' });

function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 2600);
}
async function saveTok() {
  sessionStorage.setItem('cite_tok', $('tok').value.trim());
  const r = await fetch('/admin/api/stats', { headers: hdrs() });
  if (r.status === 401) { $('loginerr').textContent = 'Invalid token (or ADMIN_TOKEN secret not set on the worker).'; return; }
  boot();
}
async function boot() {
  $('login').style.display = 'none'; $('app').style.display = 'block';
  await stats(); await load(1);
}
async function stats() {
  const s = await (await fetch('/admin/api/stats', { headers: hdrs() })).json();
  $('stats').innerHTML =
    '<span><b>' + s.sites + '</b> sites</span>' +
    '<span><b>' + s.active + '</b> active</span>' +
    '<span><b>' + s.priced + '</b> priced</span>' +
    '<span>avg markup <b>×' + (s.avg_markup ?? '–') + '</b></span>' +
    '<span>avg margin <b>$' + (s.avg_margin ?? '–') + '</b></span>' +
    '<span class="warn"><b>' + s.attr_unknown + '</b> link-attr unknown</span>';
}
function showTab(t) {
  $('pane-inv').style.display = t === 'inv' ? 'block' : 'none';
  $('pane-ana').style.display = t === 'ana' ? 'block' : 'none';
  $('tab-inv').className = 'tab' + (t === 'inv' ? ' active' : '');
  $('tab-ana').className = 'tab' + (t === 'ana' ? ' active' : '');
  if (t === 'ana') analytics();
}

const tbl = (headers, rows, empty) => rows.length
  ? '<table class="mini"><thead><tr>' + headers.map(h => '<th' + (h.n ? ' class="n"' : '') + '>' + h.t + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map(r => '<tr>' + r.map((c, i) => '<td' + (headers[i].n ? ' class="n"' : '') + '>' + c + '</td>').join('') + '</tr>').join('')
    + '</tbody></table>'
  : '<div class="empty">' + empty + '</div>';

async function analytics() {
  const r = await fetch('/admin/api/analytics', { headers: hdrs() });
  if (r.status === 401) { sessionStorage.removeItem('cite_tok'); location.reload(); return; }
  const d = await r.json();
  const kpi = (n, l, hi) => '<div class="kpi' + (hi ? ' hi' : '') + '"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
  $('kpis').innerHTML =
    kpi(d.accounts.total ?? 0, 'accounts signed up', true) +
    kpi(d.accounts.new_7d ?? 0, 'new in last 7 days') +
    kpi(d.activity.identified_agents ?? 0, 'agents with a key') +
    kpi(d.activity.queries_total ?? 0, 'queries all time', true) +
    kpi(d.activity.queries_24h ?? 0, 'queries last 24h') +
    kpi(d.accounts.free_placements_claimed ?? 0, 'free placements claimed');

  $('a_signups').innerHTML = tbl(
    [{t:'Email'},{t:'Tier'},{t:'Claimed',n:1},{t:'Signed up'}],
    (d.signups||[]).map(s => [esc(s.email), esc(s.tier), s.orders_used + '/' + s.quota, esc((s.created_at||'').slice(0,16))]),
    'No signups yet. Every register_account call lands here.');

  const maxQ = Math.max(1, ...(d.daily||[]).map(x => x.queries));
  $('a_daily').innerHTML = tbl(
    [{t:'Day'},{t:'Queries',n:1},{t:'Agents',n:1},{t:''}],
    (d.daily||[]).map(x => [x.day, x.queries, x.agents,
      '<div class="barcell" style="--w:' + Math.round(100*x.queries/maxQ) + '%">&nbsp;</div>']),
    'No activity logged yet.');

  $('a_topics').innerHTML = tbl(
    [{t:'Topic'},{t:'Searches',n:1}],
    (d.top_topics||[]).map(t => [esc(t.topic), t.times]),
    'No searches yet — this is what agents are actually asking for.');

  $('a_unmet').innerHTML = tbl(
    [{t:'Query'},{t:'Times',n:1}],
    (d.unmet_demand||[]).map(u => [esc((u.args||'').slice(0,90)), u.times]),
    'Nothing yet. Each row here is inventory an agent wanted and we could not supply.');

  $('a_tools').innerHTML = tbl(
    [{t:'Tool'},{t:'Calls',n:1},{t:'Zero-result',n:1}],
    (d.by_tool||[]).map(t => [esc(t.tool), t.calls, t.zero_result_calls]),
    'No tool calls logged yet.');

  $('a_free').innerHTML = tbl(
    [{t:'Site'},{t:'Mode'},{t:'Claims',n:1}],
    (d.free_placements_by_site||[]).map(f => [esc(f.domain || f.site_id), esc(f.acquisition_mode||''), f.claims]),
    'No free placements claimed yet.');

  const ready = d.inventory_readiness || {};
  $('a_ready').innerHTML = tbl(
    [{t:'Check'},{t:'Count',n:1}],
    [['Sites total', ready.total_sites],
     ['Free sites', ready.free_sites],
     ['Link attribute still unknown (launch blocker)', ready.link_attr_unknown],
     ['Unpriced sites', ready.unpriced]],
    '');
}

async function load(p) {
  page = Math.max(1, p || 1);
  const u = new URLSearchParams({ page });
  if ($('q').value) u.set('q', $('q').value);
  if ($('fniche').value) u.set('niche', $('fniche').value);
  if ($('fstatus').value) u.set('status', $('fstatus').value);
  if ($('fcost').value) u.set('cost_type', $('fcost').value);
  if ($('fmode').value) u.set('acquisition_mode', $('fmode').value);
  const r = await fetch('/admin/api/sites?' + u, { headers: hdrs() });
  if (r.status === 401) { sessionStorage.removeItem('cite_tok'); location.reload(); return; }
  const d = await r.json();
  $('pageinfo').textContent = 'page ' + d.page + ' — ' + d.total + ' sites';
  const niches = new Set([...$('fniche').options].map(o => o.value));
  $('rows').innerHTML = d.sites.map(rowHtml).join('');
  d.sites.forEach(s => { if (s.niche && !niches.has(s.niche)) { const o = document.createElement('option'); o.textContent = s.niche; $('fniche').appendChild(o); niches.add(s.niche); } });
}
const esc = (s) => (s ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function rowHtml(s) {
  const margin = s.margin == null ? '–' : '$' + s.margin;
  const mclass = s.margin > 0 ? 'margin-pos' : s.margin < 0 ? 'margin-neg' : '';
  const attrs = ['unknown','dofollow','sponsored','ugc','nofollow'];
  const stats_ = ['active','paused','burned'];
  const modes = ['paid_placement','self_serve','apply_editorial','link_exchange','unavailable'];
  return '<tr data-id="' + s.id + '">' +
    '<td class="domain">' + esc(s.domain) + (s.note ? '<div class="sub">' + esc(s.note).slice(0,60) + '</div>' : '') + '</td>' +
    '<td>' + esc(s.niche ?? '–') + (s.subniche ? '<div class="sub">' + esc(s.subniche) + '</div>' : '') + '</td>' +
    '<td class="num">' + (s.cite_score ?? '–') + '</td>' +
    '<td class="num">' + (s.dr ?? '–') + '</td>' +
    '<td class="num">' + (s.da ?? '–') + '</td>' +
    '<td>' + esc(s.traffic_band ?? '–') + '</td>' +
    '<td class="num"><input type="number" value="' + (s.seller_price ?? '') + '" onchange="patch(this,\\'seller_price\\',parseFloat(this.value))"></td>' +
    '<td class="num"><input type="number" step="0.1" value="' + (s.markup ?? 1.6) + '" onchange="patch(this,\\'markup\\',parseFloat(this.value))"></td>' +
    '<td class="num" data-col="listed">' + (s.listed_price != null ? '$' + s.listed_price : '–') + '</td>' +
    '<td class="num ' + mclass + '" data-col="margin">' + margin + '</td>' +
    '<td><select onchange="patch(this,\\'acquisition_mode\\',this.value)">' + modes.map(a => '<option' + (a === s.acquisition_mode ? ' selected' : '') + '>' + a + '</option>').join('') + '</select>' +
      (s.cost_type === 'free' ? '<div class="sub">free</div>' : '') + '</td>' +
    '<td><select onchange="patch(this,\\'link_attribute\\',this.value)">' + attrs.map(a => '<option' + (a === s.link_attribute ? ' selected' : '') + '>' + a + '</option>').join('') + '</select></td>' +
    '<td class="num"><input type="number" value="' + (s.max_links_per_post ?? '') + '" onchange="patch(this,\\'max_links_per_post\\',this.value===\\'\\'?null:parseInt(this.value))"></td>' +
    '<td><select onchange="patch(this,\\'status\\',this.value)">' + stats_.map(a => '<option' + (a === s.status ? ' selected' : '') + '>' + a + '</option>').join('') + '</select></td>' +
    '</tr>';
}
async function patch(el, field, value) {
  const id = el.closest('tr').dataset.id;
  const r = await fetch('/admin/api/sites/' + id, { method: 'PATCH', headers: hdrs(), body: JSON.stringify({ [field]: value }) });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'update failed', true); return; }
  const row = el.closest('tr');
  row.querySelector('[data-col=listed]').textContent = d.site.listed_price != null ? '$' + d.site.listed_price : '–';
  const m = d.site.listed_price != null && d.site.seller_price != null ? Math.round((d.site.listed_price - d.site.seller_price) * 100) / 100 : null;
  const mtd = row.querySelector('[data-col=margin]');
  mtd.textContent = m == null ? '–' : '$' + m;
  mtd.className = 'num ' + (m > 0 ? 'margin-pos' : m < 0 ? 'margin-neg' : '');
  toast(field + ' saved'); stats();
}
async function addSite() {
  const body = { domain: $('a_domain').value, niche: $('a_niche').value || null,
    seller_price: $('a_seller').value ? parseFloat($('a_seller').value) : null,
    markup: $('a_markup').value ? parseFloat($('a_markup').value) : 1.6,
    contact_email: $('a_email').value || null };
  const r = await fetch('/admin/api/sites', { method: 'POST', headers: hdrs(), body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'add failed', true); return; }
  toast('added ' + d.domain); load(1); stats();
}
if (tok()) boot();
</script>
</body>
</html>`;

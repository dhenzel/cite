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
  <div class="bar">
    <input id="q" placeholder="search domain / niche / note…" style="flex:1;min-width:220px">
    <select id="fniche"><option value="">all niches</option></select>
    <select id="fstatus"><option value="">all statuses</option><option>active</option><option>paused</option><option>burned</option></select>
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
      <th>Domain</th><th>Niche</th><th class="num">Score</th><th>Traffic</th>
      <th class="num">Seller $</th><th class="num">Markup</th><th class="num">Listed $</th><th class="num">Margin $</th>
      <th>Link attr</th><th class="num">Max links</th><th>Status</th>
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
async function load(p) {
  page = Math.max(1, p || 1);
  const u = new URLSearchParams({ page });
  if ($('q').value) u.set('q', $('q').value);
  if ($('fniche').value) u.set('niche', $('fniche').value);
  if ($('fstatus').value) u.set('status', $('fstatus').value);
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
  return '<tr data-id="' + s.id + '">' +
    '<td class="domain">' + esc(s.domain) + (s.note ? '<div class="sub">' + esc(s.note).slice(0,60) + '</div>' : '') + '</td>' +
    '<td>' + esc(s.niche ?? '–') + (s.subniche ? '<div class="sub">' + esc(s.subniche) + '</div>' : '') + '</td>' +
    '<td class="num">' + (s.cite_score ?? '–') + '</td>' +
    '<td>' + esc(s.traffic_band ?? '–') + '</td>' +
    '<td class="num"><input type="number" value="' + (s.seller_price ?? '') + '" onchange="patch(this,\\'seller_price\\',parseFloat(this.value))"></td>' +
    '<td class="num"><input type="number" step="0.1" value="' + (s.markup ?? 1.6) + '" onchange="patch(this,\\'markup\\',parseFloat(this.value))"></td>' +
    '<td class="num" data-col="listed">' + (s.listed_price != null ? '$' + s.listed_price : '–') + '</td>' +
    '<td class="num ' + mclass + '" data-col="margin">' + margin + '</td>' +
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

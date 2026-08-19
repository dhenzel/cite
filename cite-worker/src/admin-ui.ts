// Sign-in screen (SPEC §18). Shown at /admin when there is no session — one
// button, no password: identity comes from the Shortlist Context Engine.
export function signInPage(opts: { error?: string; configured?: boolean; tokenFallback?: boolean } = {}): string {
  const { error, configured = true, tokenFallback = false } = opts;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>placement.sh — Sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* Shortlist.io tokens: navy #17204B, mint #30D2AD / #39D6B4, cyan #00AADD. */
  :root { --bg:#F7F8FB; --surface:#fff; --ink:#17204B; --muted:#6e7aa4; --line:#e6e9ec;
          --accent:#30D2AD; --accent-2:#39D6B4; --accent-ink:#17204B; --cyan:#00AADD;
          --bad:#c0453a; --bad-soft:rgba(192,69,58,.08); }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--ink);
         font:15px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px; }
  .box { background:var(--surface); border:1px solid var(--line); border-radius:14px;
         padding:34px 34px 30px; max-width:430px; width:100%; box-shadow:0 10px 30px rgba(23,32,75,.06); }
  .brand { margin:0 0 14px; font-size:12px; font-weight:600; letter-spacing:.08em; text-transform:uppercase;
           color:var(--cyan); }
  h1 { margin:0 0 6px; font-size:23px; letter-spacing:-.02em; color:var(--ink); }
  .sub { color:var(--muted); margin:0 0 24px; font-size:14.5px; }
  a.btn { display:block; text-align:center; background:var(--accent); color:var(--accent-ink);
          text-decoration:none; font-weight:650; padding:13px 18px; border-radius:9px; font-size:15.5px; }
  a.btn:hover { background:var(--accent-2); }
  a.btn:focus-visible { outline:2px solid var(--ink); outline-offset:2px; }
  .err { background:var(--bad-soft); border-left:3px solid var(--bad); color:var(--ink);
         padding:12px 14px; border-radius:0 8px 8px 0; margin:0 0 20px; font-size:14px; }
  .foot { color:var(--muted); font-size:12.5px; margin:20px 0 0; }
  .foot a { color:var(--cyan); }
  code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12.5px; }
  .fallback { margin-top:22px; border-top:1px solid var(--line); padding-top:16px; }
  .fallback summary { cursor:pointer; color:var(--muted); font-size:13.5px; }
  .fallback form { display:flex; gap:8px; margin-top:12px; }
  .fallback input { flex:1; min-width:0; padding:9px 11px; border-radius:8px; border:1px solid var(--line);
                    background:var(--bg); color:var(--ink); font:inherit; }
  .fallback button { padding:9px 14px; border-radius:8px; border:1px solid var(--line);
                     background:var(--bg); color:var(--ink); font:inherit; cursor:pointer; }
</style>
</head>
<body>
  <div class="box">
    <p class="brand">Shortlist</p>
    <h1>placement.sh operator console</h1>
    <p class="sub">Inventory, pricing and margin for the Shortlist publisher network.</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    ${configured
      ? `<a class="btn" href="/auth/login">Sign in with Shortlist</a>
         <p class="foot">Uses your Shortlist Context Engine account. The first time, you'll be asked to approve what this app may read.</p>`
      : `<p class="foot">Sign-in isn't configured on this deployment yet. Set <code>OIDC_CLIENT_SECRET</code> and the related variables, then reload.</p>`}
    ${tokenFallback ? `<details class="fallback">
      <summary>Use the operator token instead</summary>
      <form method="get" action="/admin">
        <input type="password" name="token" placeholder="operator token" autocomplete="off">
        <button type="submit">Open console</button>
      </form>
      <p class="foot">Opens inventory and pricing without a Shortlist sign-in. Shortlist data stays unavailable in this mode.</p>
    </details>` : ''}
  </div>
</body>
</html>`;
}

// Operator console (SPEC §16). Served at /admin behind an SSO session.
// Visual tokens match shortlist.io: Inter, navy #17204B, mint #30D2AD, cyan #00AADD.
export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>placement.sh — Operator Console</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#F7F8FB; --surface:#fff; --line:#e6e9ec; --ink:#17204B; --muted:#6e7aa4;
          --accent:#30D2AD; --accent-2:#39D6B4; --cyan:#00AADD; --good:#0f8a6e;
          --bad:#c0453a; --warn:#c48a12; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:1240px; margin:0 auto; padding:20px 24px 60px; }
  h1 { font-size:20px; margin:0; letter-spacing:-.02em; }
  h1 small { color:var(--muted); font-weight:400; }
  h1 .brand { color:var(--cyan); font-size:11px; font-weight:600; letter-spacing:.08em;
              text-transform:uppercase; display:block; margin-bottom:4px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:16px;
           padding-bottom:14px; border-bottom:1px solid var(--line); margin-bottom:16px; }
  .stats { display:flex; gap:20px; flex-wrap:wrap; color:var(--muted); font-size:13px; }
  .stats b { color:var(--ink); font-size:15px; }
  .stats .warn { color:var(--warn); }
  .bar { display:flex; gap:10px; flex-wrap:wrap; margin:14px 0; }
  input, select, button { background:var(--surface); color:var(--ink); border:1px solid var(--line);
    border-radius:7px; padding:7px 10px; font:inherit; }
  input:focus, select:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  button { cursor:pointer; }
  button.primary { background:var(--accent); color:var(--ink); border-color:var(--accent); font-weight:600; }
  button.primary:hover { background:var(--accent-2); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--muted); font-weight:500; padding:8px 10px; border-bottom:1px solid var(--line);
       position:sticky; top:0; background:var(--bg); white-space:nowrap; }
  td { padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td input { width:70px; padding:4px 6px; text-align:right; }
  td select { padding:4px 6px; }
  .domain { font-weight:600; } .sub { color:var(--muted); font-size:12px; }
  .margin-pos { color:var(--good); } .margin-neg { color:var(--bad); }
  .pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px;
          background:rgba(110,122,164,.12); color:var(--muted); }
  .pill.active { background:rgba(48,210,173,.16); color:var(--good); }
  .pill.paused { background:rgba(196,138,18,.12); color:var(--warn); }
  .pill.burned { background:rgba(192,69,58,.12); color:var(--bad); }
  .pill.unknown { background:rgba(110,122,164,.12); color:var(--muted); }
  #login { max-width:420px; margin:120px auto; text-align:center; }
  #login input { width:100%; margin:12px 0; text-align:center; }
  .toast { position:fixed; bottom:20px; right:20px; background:var(--surface); border:1px solid var(--line);
    border-left:3px solid var(--good); padding:10px 16px; border-radius:8px; display:none; }
  .toast.err { border-left-color:var(--bad); }
  .pager { display:flex; gap:8px; align-items:center; margin-top:14px; color:var(--muted); }
  details { margin:14px 0; } summary { cursor:pointer; color:var(--cyan); }
  .addform { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; margin-top:10px; }
  .tabs { display:flex; gap:6px; margin:14px 0 4px; }
  .tab { background:transparent; border:1px solid var(--line); }
  .tab.active { background:var(--accent); color:var(--ink); border-color:var(--accent); font-weight:600; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:16px 0; }
  .kpi { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .kpi .n { font-size:26px; font-variant-numeric:tabular-nums; }
  .kpi .l { font-size:12px; color:var(--muted); margin-top:4px; }
  .kpi.hi .n { color:var(--cyan); }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:18px; }
  section h3 { font-size:14px; margin:18px 0 8px; font-weight:600; }
  section h3 small { color:var(--muted); font-weight:400; }
  .mini { width:100%; border-collapse:collapse; font-size:12.5px; }
  .mini td, .mini th { padding:5px 8px; border-bottom:1px solid var(--line); }
  .mini th { color:var(--muted); font-weight:500; text-align:left; }
  .mini td.n { text-align:right; font-variant-numeric:tabular-nums; }
  .empty { color:var(--muted); font-size:13px; padding:8px 0; }
  .barcell { background:linear-gradient(90deg,var(--accent) var(--w,0%),transparent 0); border-radius:3px; }
  .whoami { font-size:12.5px; color:var(--muted); display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .whoami b { color:var(--ink); }
  .whoami a { color:var(--cyan); }
  .abil { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; background:rgba(48,210,173,.14);
          color:var(--ink); padding:1px 6px; border-radius:4px; }
  .banner { background:rgba(196,138,18,.10); border-left:3px solid var(--warn); color:var(--ink);
            padding:10px 14px; border-radius:0 8px 8px 0; margin:12px 0; font-size:13.5px; }
  .banner.err { background:rgba(192,69,58,.10); border-left-color:var(--bad); }
  .prose { max-width:70ch; color:var(--ink); font-size:14px; line-height:1.6; }
  .prose.sub { color:var(--muted); }
  .keybox { background:var(--surface); border:1px solid var(--accent); border-radius:10px; padding:14px 16px; margin:12px 0; }
  .keybox code, .cmd { display:block; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12.5px;
    background:#17204B; color:#fff; padding:10px 12px; border-radius:7px; margin:8px 0; overflow-x:auto;
    white-space:pre-wrap; word-break:break-all; }
  .copy { font-size:12px; padding:5px 10px; }
  .order { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:0 0 12px; }
  .order-top { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:baseline; margin:0 0 8px; }
  .order-top .price { margin-left:auto; font-weight:650; font-variant-numeric:tabular-nums; }
  .order h3 { margin:0 0 6px; font-size:16px; letter-spacing:-.01em; }
  .order .meta { color:var(--muted); font-size:13px; margin:0 0 10px; }
  .order .meta b { color:var(--ink); font-weight:600; }
  .order-body { white-space:pre-wrap; word-break:break-word; font:13.5px/1.55 Inter,system-ui,sans-serif;
    background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px 14px;
    max-height:22rem; overflow:auto; margin:0 0 12px; }
  .order .actions { display:flex; gap:8px; flex-wrap:wrap; }
</style>
</head>
<body>
<div id="app" class="wrap">
  <header>
    <h1><span class="brand">Shortlist</span>placement.sh <small>operator console</small></h1>
    <div class="stats" id="stats"></div>
    <div class="whoami" id="whoami"></div>
  </header>
  <div class="tabs">
    <button id="tab-inv" class="tab active" onclick="showTab('inv')">Inventory</button>
    <button id="tab-ord" class="tab" onclick="showTab('ord')">Orders</button>
    <button id="tab-ana" class="tab" onclick="showTab('ana')">Analytics</button>
    <button id="tab-eng" class="tab" onclick="showTab('eng')">Shortlist</button>
    <button id="tab-key" class="tab" onclick="showTab('key')">Connect</button>
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
      <th>Domain</th><th>Niche</th><th class="num">Score</th><th class="num">DR</th><th class="num">Org traffic</th>
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

  <div id="pane-ord" style="display:none">
    <p class="prose sub">Orders stay in this tab. When a new one arrives you get mail — copy the post here and send it to the publisher yourself. Domain is for operators only; never send it to the buyer. Context Engine writes come later.</p>
    <div id="ord_rows"></div>
  </div>

  <div id="pane-eng" style="display:none">
    <div id="e_head"></div>
    <div class="bar">
      <input id="e_q" placeholder="Look up a publisher, company or client in Shortlist…" style="flex:1;min-width:260px">
      <button class="primary" onclick="engSearch()">Search engine</button>
    </div>
    <div id="e_search"></div>
    <div class="cols">
      <section><h3>Recent in Shortlist</h3><div id="e_recent"></div></section>
      <section><h3>Open signals</h3><div id="e_signals"></div></section>
    </div>
  </div>

  <div id="pane-key" style="display:none">
    <section>
      <h3>Connect your agent to the placement.sh back office</h3>
      <p class="prose">Create a personal key below, then paste one command into your terminal. After that you
      can just talk to Claude — <em>"set link attribute to dofollow for every finance site above DR 60"</em>,
      <em>"which sites have no price?"</em>, <em>"how many queries did we get this week?"</em> — and it edits
      the same inventory you see in this console.</p>
      <p class="prose sub">The key is yours alone. It carries the same access you have here, it stops working
      if your Shortlist access is removed, and you can revoke it at any time. Don't share it — if a teammate
      needs one, they sign in here and create their own.</p>
      <div class="bar">
        <input id="k_label" placeholder="What is this key for? e.g. Claude Code on my laptop" style="flex:1;min-width:240px">
        <button class="primary" onclick="mintKey()">Create a key</button>
      </div>
      <div id="k_new"></div>
      <h3>Your keys</h3>
      <div id="k_list"></div>
      <h3>Other ways to connect</h3>
      <div class="prose sub" id="k_alt"></div>
    </section>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
let page = 1;
const $ = (id) => document.getElementById(id);
// Auth is the SSO session cookie — sent automatically, nothing to store.
const hdrs = () => ({ 'content-type': 'application/json' });

function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 2600);
}
async function whoami() {
  const r = await fetch('/admin/api/engine/me', { headers: hdrs(), signal: AbortSignal.timeout(8000) });
  if (r.status === 401) { $('whoami').innerHTML = '<span>Shortlist session expired — <a href="/auth/login">sign in again</a></span>'; return; }
  const d = await r.json();
  if (d.error === 'NO_ENGINE_TOKEN' && d.mode === 'operator_token') {
    $('whoami').innerHTML = '<span><b>Operator token</b> · Shortlist not connected</span>'
      + '<a href="/auth/login">Sign in with Shortlist</a> <a href="/auth/logout">Sign out</a>';
    window.__tokenMode = true; return;
  }
  if (d.error) { $('whoami').innerHTML = '<span>Signed in · Shortlist data unavailable</span> <a href="/auth/logout">Sign out</a>'; return; }
  const who = (d.user && (d.user.name || d.user.email)) || 'signed in';
  const eng = (d.engine && d.engine.display_name) || 'Shortlist';
  const abil = (d.abilities || []).slice(0, 6).map(a => '<span class="abil">' + esc(a) + '</span>').join(' ');
  const more = (d.abilities || []).length > 6 ? ' +' + ((d.abilities || []).length - 6) : '';
  $('whoami').innerHTML = '<span><b>' + esc(who) + '</b> · ' + esc(eng) + '</span>' + abil + more +
    ' <a href="/auth/logout">Sign out</a>';
  window.__panels = d.panels || {};
}

async function engFetch(path, target, render) {
  $(target).innerHTML = '<div class="empty">Loading…</div>';
  let r;
  try {
    r = await fetch(path, { headers: hdrs(), signal: AbortSignal.timeout(8000) });
  } catch (e) {
    $(target).innerHTML = '<div class="banner">Shortlist did not respond in time.</div>';
    return;
  }
  if (r.status === 401) {
    $(target).innerHTML = '<div class="banner err">Your Shortlist session expired. <a href="/auth/login">Sign in again</a>.</div>';
    return;
  }
  const d = await r.json();
  if (d.error === 'SCOPE_DENIED') {
    $(target).innerHTML = '<div class="banner">Your engine role does not include this.</div>'; return;
  }
  if (d.error === 'TOOL_UNAVAILABLE') {
    $(target).innerHTML = '<div class="empty">This engine does not offer that tool.</div>'; return;
  }
  if (d.error) { $(target).innerHTML = '<div class="banner">' + esc(d.message || d.error) + '</div>'; return; }
  $(target).innerHTML = render(d);
}

const engRows = (items, cols) => items && items.length
  ? '<table class="mini"><tbody>' + items.map(i => '<tr>' + cols(i) + '</tr>').join('') + '</tbody></table>'
  : '<div class="empty">Nothing to show.</div>';

const engLink = (url, label) => url
  ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + '</a>' : esc(label);

function engine() {
  if (window.__tokenMode) {
    const msg = '<div class="banner">You are signed in with the operator token, so Shortlist data is not available. '
      + '<a href="/auth/login">Sign in with Shortlist</a> to load it.</div>';
    $('e_head').innerHTML = msg; $('e_recent').innerHTML = ''; $('e_signals').innerHTML = ''; $('e_search').innerHTML = '';
    return;
  }
  $('e_head').innerHTML = '';
  engFetch('/admin/api/engine/recent', 'e_recent', d => {
    const items = (d.data && (d.data.results || d.data.entities || d.data)) || [];
    const arr = Array.isArray(items) ? items.slice(0, 12) : [];
    return engRows(arr, i => '<td>' + engLink(i.url, (i.type ? i.type + ' · ' : '') + (i.slug || i.title || i.id || '?')) + '</td>'
      + '<td class="n sub">' + esc((i.updated_at || i.entity_updated_at || '').toString().slice(0, 10)) + '</td>');
  });
  engFetch('/admin/api/engine/signals', 'e_signals', d => {
    const items = (d.data && (d.data.signals || d.data.results || d.data)) || [];
    const arr = Array.isArray(items) ? items.slice(0, 10) : [];
    return engRows(arr, i => '<td>' + engLink(i.url, i.title || i.slug || '?') + '</td>'
      + '<td class="n sub">' + esc(i.kind || i.species || '') + '</td>');
  });
}

async function engSearch() {
  const q = $('e_q').value.trim();
  if (!q) return;
  engFetch('/admin/api/engine/search?q=' + encodeURIComponent(q), 'e_search', d => {
    const items = (d.data && (d.data.results || d.data)) || [];
    const arr = Array.isArray(items) ? items.slice(0, 10) : [];
    return '<h3>Results for “' + esc(q) + '”</h3>' + engRows(arr, i =>
      '<td>' + engLink(i.url, i.entity_ref || i.id || i.title || '?') + '</td>'
      + '<td class="sub">' + esc((i.excerpt || '').toString().slice(0, 120)) + '</td>');
  });
}

async function keys() {
  const r = await fetch('/admin/api/keys', { headers: hdrs() });
  if (r.status === 401) { location.href = '/auth/login'; return; }
  const d = await r.json();
  const origin = (function () {
    var h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || /\.test$/.test(h)) return location.origin;
    return 'https://placement.sh';
  })();
  $('k_list').innerHTML = (d.keys && d.keys.length)
    ? tbl([{t:'Key'},{t:'Label'},{t:'Created'},{t:'Last used'},{t:''}],
        d.keys.map(k => [
          '<code>' + esc(k.masked) + '</code>',
          esc(k.label || ''),
          esc((k.created_at || '').slice(0, 16)),
          k.last_used_at ? esc(k.last_used_at.slice(0, 16)) : '<span class="sub">never</span>',
          k.revoked ? '<span class="sub">revoked</span>'
            : '<button class="copy" data-revoke="' + esc(k.masked) + '">Revoke</button>',
        ]), '')
    : '<div class="empty">No keys yet. Create one above.</div>';
  $('k_alt').innerHTML =
    '<p><b>claude.ai connector:</b> Settings → Connectors → Add custom connector. Custom connectors cannot send a '
    + 'header, so use the URL form that carries the key in the path — shown when you create a key.</p>'
    + '<p><b>Anything else that speaks MCP:</b> POST JSON-RPC to <code>' + origin + '/admin/mcp</code> with '
    + '<code>Authorization: Bearer &lt;your key&gt;</code>.</p>';
}

async function mintKey() {
  const r = await fetch('/admin/api/keys', {
    method: 'POST', headers: hdrs(), body: JSON.stringify({ label: $('k_label').value || null }),
  });
  const d = await r.json();
  if (!r.ok) { toast(d.message || d.error || 'could not create a key', true); return; }
  $('k_new').innerHTML =
    '<div class="keybox"><b>Your new key — copy it now, it is not shown again.</b>'
    + '<code id="k_val">' + esc(d.key) + '</code>'
    + '<button class="copy" data-copy="k_val">Copy key</button>'
    + '<p class="prose" style="margin-top:14px"><b>1.</b> Run this in a terminal:</p>'
    + '<code id="k_cmd">' + esc(d.connect_command) + '</code>'
    + '<button class="copy" data-copy="k_cmd">Copy command</button>'
    + '<p class="prose" style="margin-top:14px"><b>2.</b> Start Claude and ask it something, e.g. '
    + '<em>"search placement.sh inventory for finance publishers above DR 60 and show me the margin"</em>.</p>'
    + '<p class="prose sub">For a claude.ai custom connector, use this URL instead (the key is in the path, '
    + 'because connectors cannot send headers):</p>'
    + '<code id="k_url">' + esc(d.connector_url) + '</code>'
    + '<button class="copy" data-copy="k_url">Copy URL</button>'
    + '</div>';
  $('k_label').value = '';
  keys();
}

function copyText(t) {
  navigator.clipboard?.writeText(t).then(() => toast('copied'), () => toast('could not copy', true));
}

async function revokeKey(masked) {
  if (!confirm('Revoke this key? Anything using it stops working immediately.')) return;
  const prefix = masked.split('…')[0];
  // The full key is never returned, so revoke by prefix match server-side.
  const res = await fetch('/admin/api/keys/' + encodeURIComponent(prefix), { method: 'DELETE', headers: hdrs() });
  if (!res.ok) { toast('could not revoke', true); return; }
  toast('key revoked'); keys();
}

function showError(target, message, retry) {
  const el = $(target);
  if (!el) return;
  el.innerHTML = '<div class="banner err">' + esc(message)
    + (retry ? ' <button class="copy" onclick="' + retry + '">Retry</button>' : '') + '</div>';
}

// Inventory is why this page exists, so it loads first and nothing else can
// block it: each step is isolated, and a failure says so instead of leaving
// the table blank.
async function boot() {
  load(1).catch(e => showError('rows', 'Could not load inventory: ' + (e && e.message || e), 'load(1)'));
  stats().catch(e => showError('stats', 'Could not load totals: ' + (e && e.message || e), 'stats()'));
  whoami().catch(e => {
    const el = $('whoami');
    if (el) el.innerHTML = '<span class="sub">Shortlist status unavailable</span> <a href="/auth/logout">Sign out</a>';
  });
}
async function stats() {
  const s = await (await fetch('/admin/api/stats', { headers: hdrs() })).json();
  $('stats').innerHTML =
    '<span><b>' + s.sites + '</b> publishers</span>' +
    '<span><b>' + s.active + '</b> active</span>' +
    '<span><b>' + s.priced + '</b> priced</span>' +
    '<span>avg markup <b>×' + (s.avg_markup ?? '–') + '</b></span>' +
    '<span>avg margin <b>$' + (s.avg_margin ?? '–') + '</b></span>' +
    '<span class="warn"><b>' + s.attr_unknown + '</b> link-attr unknown</span>';
}
function showTab(t) {
  for (const k of ['inv','ord','ana','eng','key']) {
    $('pane-' + k).style.display = t === k ? 'block' : 'none';
    $('tab-' + k).className = 'tab' + (t === k ? ' active' : '');
  }
  if (t === 'ord') loadOrders();
  if (t === 'ana') analytics();
  if (t === 'eng') engine();
  if (t === 'key') keys();
}

let ordersCache = [];
async function loadOrders() {
  const r = await fetch('/admin/api/orders', { headers: hdrs() });
  if (r.status === 401) { location.href = '/auth/login'; return; }
  const d = await r.json();
  ordersCache = d.orders || [];
  if (!ordersCache.length) {
    $('ord_rows').innerHTML = '<div class="empty">No submitted posts yet.</div>';
    return;
  }
  $('ord_rows').innerHTML = ordersCache.map((o, i) => {
    const dollars = ((o.listed_price_cents || 0) / 100).toFixed(0);
    const when = (o.created_at || '').slice(0, 16);
    const domain = o.domain || o.publisher_id || '';
    const anchor = o.anchor_text ? esc(o.anchor_text) + ' → ' : '';
    return '<article class="order">'
      + '<div class="order-top">'
      + '<span class="pill">' + esc(o.state || '') + '</span>'
      + '<span class="sub">' + esc(when) + '</span>'
      + '<span class="sub">' + esc(o.word_count || '') + ' words</span>'
      + '<span class="price">$' + dollars + '</span>'
      + '</div>'
      + '<h3>' + esc(o.title || '') + '</h3>'
      + '<p class="meta"><b>' + esc(domain) + '</b> · ' + esc(o.buyer_email || '') + '</p>'
      + '<p class="meta">' + anchor + esc(o.target_url || '') + '</p>'
      + (o.author_bio ? '<p class="meta">bio: ' + esc(o.author_bio) + '</p>' : '')
      + '<pre class="order-body">' + esc(o.body || '') + '</pre>'
      + '<div class="actions">'
      + '<button type="button" class="primary" data-copy-post="' + i + '">Copy post</button>'
      + '<button type="button" class="copy" data-copy-details="' + i + '">Copy outreach details</button>'
      + '</div></article>';
  }).join('');
}
function copyPost(i) {
  const o = ordersCache[i];
  if (!o) return;
  copyText((o.title || '') + '\\n\\n' + (o.body || ''));
}
function copyDetails(i) {
  const o = ordersCache[i];
  if (!o) return;
  copyText([
    'domain: ' + (o.domain || o.publisher_id || ''),
    'buyer: ' + (o.buyer_email || ''),
    'price: $' + ((o.listed_price_cents || 0) / 100).toFixed(0),
    'target: ' + (o.target_url || ''),
    'anchor: ' + (o.anchor_text || '(none)'),
    o.author_bio ? 'bio: ' + o.author_bio : '',
  ].filter(Boolean).join('\\n'));
}

const tbl = (headers, rows, empty) => rows.length
  ? '<table class="mini"><thead><tr>' + headers.map(h => '<th' + (h.n ? ' class="n"' : '') + '>' + h.t + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map(r => '<tr>' + r.map((c, i) => '<td' + (headers[i].n ? ' class="n"' : '') + '>' + c + '</td>').join('') + '</tr>').join('')
    + '</tbody></table>'
  : '<div class="empty">' + empty + '</div>';

async function analytics() {
  const r = await fetch('/admin/api/analytics', { headers: hdrs() });
  if (r.status === 401) { location.href = '/auth/login'; return; }
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

function resetFilters() {
  for (const id of ['q','fniche','fstatus','fcost','fmode']) { const el = $(id); if (el) el.value = ''; }
  load(1);
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
  if (r.status === 401) { location.href = '/auth/login'; return; }
  const d = await r.json();
  $('pageinfo').textContent = 'page ' + d.page + ' — ' + d.total + ' sites';
  const niches = new Set([...$('fniche').options].map(o => o.value));
  $('rows').innerHTML = (d.sites && d.sites.length)
    ? d.sites.map(rowHtml).join('')
    : '<tr><td colspan="13" class="empty">No sites match these filters. '
      + '<button class="copy" onclick="resetFilters()">Reset filters</button></td></tr>';
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
    '<td class="num">' + (s.traffic ?? '–') + '</td>' +
    '<td class="num"><input type="number" data-field="seller_price" data-kind="float" value="' + (s.seller_price ?? '') + '"></td>' +
    '<td class="num"><input type="number" step="0.1" data-field="markup" data-kind="float" value="' + (s.markup ?? 1.6) + '"></td>' +
    '<td class="num" data-col="listed">' + (s.listed_price != null ? '$' + s.listed_price : '–') + '</td>' +
    '<td class="num ' + mclass + '" data-col="margin">' + margin + '</td>' +
    '<td><select data-field="acquisition_mode">' + modes.map(a => '<option' + (a === s.acquisition_mode ? ' selected' : '') + '>' + a + '</option>').join('') + '</select>' +
      (s.cost_type === 'free' ? '<div class="sub">free</div>' : '') + '</td>' +
    '<td><select data-field="link_attribute">' + attrs.map(a => '<option' + (a === s.link_attribute ? ' selected' : '') + '>' + a + '</option>').join('') + '</select></td>' +
    '<td class="num"><input type="number" data-field="max_links_per_post" data-kind="int" value="' + (s.max_links_per_post ?? '') + '"></td>' +
    '<td><select data-field="status">' + stats_.map(a => '<option' + (a === s.status ? ' selected' : '') + '>' + a + '</option>').join('') + '</select></td>' +
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
// One listener for every editable cell — inline handlers needed escaping that
// was easy to get wrong inside a template literal.
document.getElementById('pane-key').addEventListener('click', (ev) => {
  const t = ev.target;
  if (!t || !t.dataset) return;
  if (t.dataset.revoke) { revokeKey(t.dataset.revoke); return; }
  if (t.dataset.copy) {
    const el = document.getElementById(t.dataset.copy);
    if (el) copyText(el.textContent);
  }
});

document.getElementById('pane-ord').addEventListener('click', (ev) => {
  const t = ev.target;
  if (!t || !t.dataset) return;
  if (t.dataset.copyPost != null) { copyPost(parseInt(t.dataset.copyPost, 10)); return; }
  if (t.dataset.copyDetails != null) { copyDetails(parseInt(t.dataset.copyDetails, 10)); }
});

document.getElementById('rows').addEventListener('change', (ev) => {
  const el = ev.target;
  const field = el && el.dataset && el.dataset.field;
  if (!field) return;
  let value = el.value;
  if (el.dataset.kind === 'float') value = value === '' ? null : parseFloat(value);
  else if (el.dataset.kind === 'int') value = value === '' ? null : parseInt(value, 10);
  patch(el, field, value);
});

boot();
</script>
</body>
</html>`;

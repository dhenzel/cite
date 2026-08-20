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
  /* shortlist.io: navy #17204B, mint #30D2AD / #39D6B4, cyan #00AADD, Inter. */
  :root { --navy:#17204B; --mint:#30D2AD; --mint-2:#39D6B4; --cyan:#00AADD;
          --ink:#17204B; --muted:#6e7aa4; --line:#e6e9ec; --bad:#c0453a; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--navy); color:#fff;
         font:15px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px; }
  .logo { margin:0 0 28px; text-align:center; font-weight:700; font-size:28px; letter-spacing:-.04em; color:#fff; }
  .logo span { color:var(--mint); }
  .box { background:#fff; color:var(--ink); border-radius:16px;
         padding:34px 34px 30px; max-width:430px; width:100%; box-shadow:0 18px 50px rgba(0,0,0,.25); }
  h1 { margin:0 0 6px; font-size:22px; letter-spacing:-.02em; color:var(--ink); }
  .sub { color:var(--muted); margin:0 0 24px; font-size:14.5px; }
  a.btn { display:block; text-align:center; background:var(--mint); color:var(--navy);
          text-decoration:none; font-weight:700; padding:13px 18px; border-radius:9px; font-size:15.5px; }
  a.btn:hover { background:var(--mint-2); }
  a.btn:focus-visible { outline:2px solid var(--navy); outline-offset:2px; }
  .err { background:rgba(192,69,58,.08); border-left:3px solid var(--bad); color:var(--ink);
         padding:12px 14px; border-radius:0 8px 8px 0; margin:0 0 20px; font-size:14px; }
  .foot { color:var(--muted); font-size:12.5px; margin:20px 0 0; }
  .foot a { color:var(--cyan); }
  code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12.5px; }
  .fallback { margin-top:22px; border-top:1px solid var(--line); padding-top:16px; }
  .fallback summary { cursor:pointer; color:var(--muted); font-size:13.5px; }
  .fallback form { display:flex; gap:8px; margin-top:12px; }
  .fallback input { flex:1; min-width:0; padding:9px 11px; border-radius:8px; border:1px solid var(--line);
                    background:#F7F8FB; color:var(--ink); font:inherit; }
  .fallback button { padding:9px 14px; border-radius:8px; border:1px solid var(--line);
                     background:#F7F8FB; color:var(--ink); font:inherit; cursor:pointer; }
</style>
</head>
<body>
  <div>
    <p class="logo">shortlist<span>.</span></p>
  <div class="box">
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
          --bad:#c0453a; --warn:#c48a12; --navy:#17204B; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .topbar { background:var(--navy); color:#fff; }
  .topbar-inner { max-width:1240px; margin:0 auto; padding:14px 24px; display:flex;
                  align-items:center; gap:18px; flex-wrap:wrap; }
  .logo { font-weight:700; font-size:22px; letter-spacing:-.04em; color:#fff; text-decoration:none; }
  .logo span { color:var(--accent); }
  .product { font-size:13px; color:rgba(255,255,255,.72); margin-right:auto; }
  .product em { font-style:normal; color:#fff; font-weight:500; }
  .wrap { max-width:1240px; margin:0 auto; padding:16px 24px 60px; }
  .stats { display:flex; gap:18px; flex-wrap:wrap; color:rgba(255,255,255,.7); font-size:13px; }
  .stats b { color:#fff; font-size:15px; }
  .stats .warn { color:#ffd36a; }
  .whoami { font-size:12.5px; color:rgba(255,255,255,.7); display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .whoami b { color:#fff; }
  .whoami a { color:var(--accent); }
  .bar { display:flex; gap:10px; flex-wrap:wrap; margin:14px 0; }
  .hint { color:var(--muted); font-size:12.5px; margin:-6px 0 12px; }
  input, select, button { background:var(--surface); color:var(--ink); border:1px solid var(--line);
    border-radius:7px; padding:7px 10px; font:inherit; }
  input:focus, select:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  button { cursor:pointer; }
  button.primary, a.primary { background:var(--accent); color:var(--navy); border-color:var(--accent); font-weight:700; }
  button.primary:hover, a.primary:hover { background:var(--accent-2); }
  a.primary { display:inline-block; text-decoration:none; padding:7px 10px; border-radius:7px; border:1px solid var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:13px; background:var(--surface); border-radius:10px; overflow:hidden; }
  th { text-align:left; color:#fff; font-weight:600; padding:10px 10px; border-bottom:1px solid rgba(255,255,255,.08);
       position:sticky; top:0; background:var(--navy); white-space:nowrap; }
  th.sort { cursor:pointer; user-select:none; }
  th.sort:hover { color:var(--accent); }
  th.sort::after { content:' ⇅'; font-size:11px; color:var(--accent); opacity:.55; font-weight:700; }
  th.sort.sorted { color:var(--accent); }
  th.sort.sorted[data-dir="asc"]::after { content:' ↑'; opacity:1; }
  th.sort.sorted[data-dir="desc"]::after { content:' ↓'; opacity:1; }
  td { padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td input { width:70px; padding:4px 6px; text-align:right; }
  td select { padding:4px 6px; }
  td.instr input { width:200px; text-align:left; }
  .addform .reciprocal { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:13px; }
  .addform .reciprocal input { width:auto; }
  .domain { font-weight:600; } .sub { color:var(--muted); font-size:12px; }
  .margin-pos { color:var(--good); } .margin-neg { color:var(--bad); }
  .pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px;
          background:rgba(110,122,164,.12); color:var(--muted); }
  .pill.active { background:rgba(48,210,173,.16); color:var(--good); }
  .pill.paused { background:rgba(196,138,18,.12); color:var(--warn); }
  .pill.burned { background:rgba(192,69,58,.12); color:var(--bad); }
  .pill.unknown { background:rgba(110,122,164,.12); color:var(--muted); }
  .pill.ok { background:rgba(48,210,173,.16); color:var(--good); }
  .pill.warn { background:rgba(196,138,18,.12); color:var(--warn); }
  .pill.open { background:rgba(48,210,173,.16); color:var(--good); }
  .pill.follow { background:rgba(196,138,18,.12); color:var(--warn); }
  .pill.expired { background:rgba(192,69,58,.12); color:var(--bad); }
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
  .tab.active { background:var(--accent); color:var(--navy); border-color:var(--accent); font-weight:700; }
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
  .mini th { color:var(--muted); font-weight:500; text-align:left; background:var(--surface);
             position:static; }
  .mini td.n { text-align:right; font-variant-numeric:tabular-nums; }
  .empty { color:var(--muted); font-size:13px; padding:8px 0; }
  .barcell { background:linear-gradient(90deg,var(--accent) var(--w,0%),transparent 0); border-radius:3px; }
  .funnel { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin:8px 0 18px; }
  .funnel .step { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .funnel .step .n { font-size:22px; font-variant-numeric:tabular-nums; font-weight:650; }
  .funnel .step .l { font-size:12px; color:var(--muted); margin-top:4px; }
  .funnel .bar { height:6px; background:var(--line); border-radius:99px; margin-top:10px; overflow:hidden; }
  .funnel .bar > i { display:block; height:100%; background:var(--accent); border-radius:99px; }
  .spark { display:flex; align-items:flex-end; gap:6px; height:120px; padding:8px 4px 0; margin:0 0 10px; }
  .spark-col { flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; height:100%; min-width:0; }
  .spark-bar { width:100%; max-width:28px; background:var(--accent); border-radius:4px 4px 0 0; min-height:2px; }
  .spark-col span { font-size:10px; color:var(--muted); margin-top:6px; }
  .ana-note { color:var(--muted); font-size:13.5px; max-width:72ch; margin:0 0 8px; }
  .topbar .abil { color:#fff; background:rgba(48,210,173,.28); }
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
  .domain-btn { background:none; border:0; padding:0; color:var(--cyan); font:inherit; font-weight:600;
                cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
  .domain-btn:hover { color:var(--ink); }
  .drawer-bg { position:fixed; inset:0; background:rgba(23,32,75,.35); z-index:40; }
  .drawer { position:fixed; top:0; right:0; bottom:0; width:min(480px,100vw); background:var(--surface); z-index:41;
            box-shadow:-12px 0 40px rgba(23,32,75,.18); display:flex; flex-direction:column; }
  /* Author display:flex beats the UA [hidden] rule — Close would leave the panel up. */
  .drawer[hidden], .drawer-bg[hidden] { display:none !important; }
  .drawer-head { display:flex; align-items:flex-start; gap:12px; padding:18px 20px 12px;
                 border-bottom:1px solid rgba(255,255,255,.08); background:var(--navy); color:#fff; }
  .drawer-head h2 { margin:0; font-size:18px; letter-spacing:-.02em; word-break:break-all; }
  .drawer-head .sub { color:rgba(255,255,255,.7); margin:4px 0 0; }
  .drawer-head button { margin-left:auto; }
  .drawer-body { overflow:auto; padding:16px 20px 32px; }
  .sd-sec { margin:0 0 16px; }
  .sd-sec h3 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .sd-sec p { margin:0 0 6px; white-space:pre-wrap; word-break:break-word; }
  .sd-titles { margin:0; padding-left:18px; }
  .sd-titles li { margin:0 0 4px; white-space:normal; }
  .sd-kicker { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:baseline; margin:0 0 8px; }
  .sd-kicker a { color:var(--cyan); font-weight:700; }
  .drawer .pill { margin:0 6px 6px 0; }
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-inner">
    <a class="logo" href="https://shortlist.io/" target="_blank" rel="noopener">shortlist<span>.</span></a>
    <div class="product">placement.sh <em>operator console</em></div>
    <div class="stats" id="stats"></div>
    <div class="whoami" id="whoami"></div>
  </div>
</div>
<div id="app" class="wrap">
  <div class="tabs">
    <button id="tab-inv" class="tab active" onclick="showTab('inv')">Paid inventory</button>
    <button id="tab-opp" class="tab" onclick="showTab('opp')">Opportunities</button>
    <button id="tab-sub" class="tab" onclick="showTab('sub')">Submissions</button>
    <button id="tab-ord" class="tab" onclick="showTab('ord')">Orders</button>
    <button id="tab-fol" class="tab" onclick="showTab('fol')">Follow-up</button>
    <button id="tab-ana" class="tab" onclick="showTab('ana')">Analytics</button>
    <button id="tab-eng" class="tab" onclick="showTab('eng')">Shortlist</button>
    <button id="tab-key" class="tab" onclick="showTab('key')">Connect</button>
  </div>

  <div id="pane-inv">
  <div class="bar">
    <input id="q" placeholder="search domain / niche / note…" style="flex:1;min-width:220px">
    <select id="fniche"><option value="">all niches</option></select>
    <select id="fstatus"><option value="">all statuses</option><option>active</option><option>paused</option><option>burned</option></select>
    <select id="fmode"><option value="">all modes</option><option value="paid_placement">paid_placement</option><option value="self_serve">self_serve</option><option value="apply_editorial">apply_editorial</option><option value="link_exchange">link_exchange</option><option value="unavailable">unavailable</option></select>
    <button class="primary" onclick="load('inv',1)">Search</button>
  </div>
  <p class="hint">Publishers we pay for. Free sites live in their own tab. Click a domain to see the crawl profile, any column header to sort. Score starts highest first.</p>
  <details>
    <summary>+ Add paid site</summary>
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
      <th class="sort" data-sort="domain" title="Click to sort">Domain</th>
      <th class="sort" data-sort="niche" title="Click to sort">Niche</th>
      <th class="num sort" data-sort="cite_score" title="Click to sort">Score</th>
      <th class="num sort" data-sort="dr" title="Click to sort">DR</th>
      <th class="num sort" data-sort="traffic" title="Click to sort">Org traffic</th>
      <th class="num sort" data-sort="seller_price" title="Click to sort">Seller $</th>
      <th class="num sort" data-sort="markup" title="Click to sort">Markup</th>
      <th class="num sort" data-sort="listed_price" title="Click to sort">Listed $</th>
      <th class="num sort" data-sort="margin" title="Click to sort">Margin $</th>
      <th class="sort" data-sort="acquisition_mode" title="Click to sort">Acquisition</th>
      <th class="sort" data-sort="link_attribute" title="Click to sort">Link attr</th>
      <th class="num sort" data-sort="max_links_per_post" title="Click to sort">Max links</th>
      <th class="sort" data-sort="status" title="Click to sort">Status</th>
      <th title="Move this publisher to the other section">Section</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
  </div>
  <div class="pager">
    <button onclick="load('inv',VIEWS.inv.page-1)">‹ prev</button>
    <span id="pageinfo"></span>
    <button onclick="load('inv',VIEWS.inv.page+1)">next ›</button>
  </div>
  </div>

  <div id="pane-opp" style="display:none">
  <div class="bar">
    <input id="q_opp" placeholder="search platform / type / niche…" style="flex:1;min-width:220px">
    <select id="f_contribution">
      <option value="">all kinds</option>
      <option value="profile">profile — they get listed</option>
      <option value="article">article — they write a post</option>
      <option value="program">program — they apply to join</option>
    </select>
    <select id="f_opp_status"><option value="active">active</option><option value="watchlist">watchlist</option><option value="retired">retired</option><option value="">all</option></select>
    <select id="f_cost"><option value="">any cost</option><option value="free">confirmed free</option><option value="unknown">cost unknown</option></select>
    <select id="f_verify"><option value="">any confidence</option><option value="needs">needs re-verification</option><option value="done">verified</option></select>
    <button class="primary" onclick="loadOpps(1)">Search</button>
  </div>
  <p class="hint">Places a <b>customer</b> gets listed, profiled or published for free — this is the other product, not inventory we sell.
  Cost is unverified on about half of these and almost every requirement came from a class template, so
  <b>Verify</b> is the real work here: open the live page, confirm cost and requirements, then stamp it.</p>
  <div style="overflow-x:auto">
  <table>
    <thead><tr>
      <th class="sort" data-sort="platform" title="Click to sort">Platform</th>
      <th class="sort" data-sort="contribution" title="Click to sort">Kind</th>
      <th class="sort" data-sort="opportunity_type" title="Click to sort">Type</th>
      <th class="sort" data-sort="niche" title="Click to sort">Niche</th>
      <th class="sort" data-sort="cost_model" title="Click to sort">Cost</th>
      <th title="What the source claimed — not verified">Link claim</th>
      <th class="num sort" data-sort="priority_score" title="Click to sort">Score</th>
      <th class="num sort" data-sort="prep_minutes" title="Click to sort">Prep</th>
      <th class="sort" data-sort="verification_level" title="Click to sort">Confidence</th>
      <th class="sort" data-sort="status" title="Click to sort">Status</th>
      <th title="Confirm the live page, then stamp it verified">Verify</th>
    </tr></thead>
    <tbody id="rows_opp"></tbody>
  </table>
  </div>
  <div class="pager">
    <button onclick="loadOpps(OPPS.page-1)">‹ prev</button>
    <span id="pageinfo_opp"></span>
    <button onclick="loadOpps(OPPS.page+1)">next ›</button>
  </div>
  </div>

  <div id="pane-sub" style="display:none">
    <p class="prose sub">What customers are doing with the free catalog. Anything in <b>needs human</b> is stuck waiting on
    a person — a login, a CAPTCHA, an email verification, an editorial decision. Observed link is what the live page
    actually renders, which is the only link fact we ever trust.</p>
    <div class="kpis" id="sub_kpis"></div>
    <div style="overflow-x:auto">
    <table>
      <thead><tr>
        <th>Company</th><th>Platform</th><th>Kind</th><th>State</th>
        <th>Listing</th><th>Observed link</th><th>Indexed</th><th>Updated</th>
      </tr></thead>
      <tbody id="rows_sub"></tbody>
    </table>
    </div>
  </div>

  <div id="pane-ana" style="display:none">
    <p class="ana-note">What agents are looking for, whether they pay, and whether inventory can fill it. Click any table header to sort.</p>
    <div class="kpis" id="kpis"></div>
    <div class="funnel" id="a_funnel"></div>
    <div class="cols">
      <section><h3>Activity — last 14 days</h3><div id="a_spark"></div><div id="a_daily"></div></section>
      <section><h3>Tool usage</h3><div id="a_tools"></div></section>
      <section><h3>What agents search for</h3><div id="a_topics"></div></section>
      <section><h3>Unmet demand <small>searches returning nothing</small></h3><div id="a_unmet"></div></section>
      <section><h3>Inventory by niche</h3><div id="a_niches"></div></section>
      <section><h3>Inventory readiness</h3><div id="a_ready"></div></section>
      <section><h3>Signups</h3><div id="a_signups"></div></section>
      <section><h3>Legacy free claims</h3><div id="a_free"></div></section>
    </div>
  </div>

  <div id="pane-fol" style="display:none">
    <p class="prose sub">People who opened Stripe Checkout and did not finish paying. Email them from here — we do not send a nudge automatically. A session still marked “in Checkout” may just be mid-payment; wait ~30 minutes before chasing.</p>
    <div id="fol_kpis" class="kpis"></div>
    <div id="fol_rows"></div>
  </div>

  <div id="pane-ord" style="display:none">
    <p class="prose sub">Orders stay in this tab. When a new one arrives you get mail — copy the post here and send it to the publisher yourself. Domain is for operators only; never send it to the buyer. Context Engine writes come later.</p>
    <div class="bar">
      <select id="ord_sort" onchange="renderOrders()">
        <option value="created_at:desc">Newest first</option>
        <option value="created_at:asc">Oldest first</option>
        <option value="listed_price_cents:desc">Highest price</option>
        <option value="listed_price_cents:asc">Lowest price</option>
        <option value="word_count:desc">Longest post</option>
        <option value="domain:asc">Domain A–Z</option>
        <option value="state:asc">State</option>
      </select>
    </div>
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
<div id="site-drawer-bg" class="drawer-bg" hidden></div>
<div id="site-drawer" class="drawer" hidden>
  <div class="drawer-head">
    <div>
      <h2 id="sd-domain">Site</h2>
      <p class="sub" id="sd-handle"></p>
    </div>
    <button type="button" id="sd-close">Close</button>
  </div>
  <div id="sd-body" class="drawer-body"></div>
</div>
<div class="toast" id="toast"></div>

<script>
// The sites table is paid publishers only since migration 010 — the free rows
// moved to the opportunities catalog, which has its own shape and loader below.
const VIEWS = {
  inv:  { cost: 'paid', rows: 'rows',      info: 'pageinfo',      noun: 'paid sites',
          q: 'q',      niche: 'fniche',      status: 'fstatus',      mode: 'fmode',
          cols: 13, page: 1, sort: 'cite_score', dir: 'desc', loaded: false },
};
const OPPS = { page: 1, sort: 'priority_score', dir: 'desc', loaded: false };
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
  markSortHeaders();
  load('inv', 1).catch(e => showError('rows', 'Could not load paid inventory: ' + (e && e.message || e), "load('inv',1)"));
  stats().catch(e => showError('stats', 'Could not load totals: ' + (e && e.message || e), 'stats()'));
  loadFollowups().catch(e => showError('fol_rows', 'Could not load unfinished checkouts: ' + (e && e.message || e), 'loadFollowups()'));
  whoami().catch(e => {
    const el = $('whoami');
    if (el) el.innerHTML = '<span class="sub">Shortlist status unavailable</span> <a href="/auth/logout">Sign out</a>';
  });
  const deep = location.hash.match(/^#site-(cs_[a-z0-9]+)$/);
  if (deep) openSite(deep[1]);
}
async function stats() {
  const s = await (await fetch('/admin/api/stats', { headers: hdrs() })).json();
  const opps = s.opportunities ?? 0;
  $('stats').innerHTML =
    '<span><b>' + (s.paid_sites ?? s.sites) + '</b> paid</span>' +
    '<span><b>' + opps + '</b> free opportunities</span>' +
    '<span><b>' + s.active + '</b> active</span>' +
    '<span><b>' + s.priced + '</b> priced</span>' +
    '<span>avg markup <b>×' + (s.avg_markup ?? '–') + '</b></span>' +
    '<span>avg margin <b>$' + (s.avg_margin ?? '–') + '</b></span>' +
    (s.paid_unpriced ? '<span class="warn"><b>' + s.paid_unpriced + '</b> paid, unpriced</span>' : '') +
    '<span class="warn"><b>' + s.attr_unknown + '</b> link-attr unknown</span>' +
    (s.opportunities_unverified ? '<span class="warn"><b>' + s.opportunities_unverified + '</b> unverified</span>' : '');
  const ot = $('tab-opp');
  if (ot) ot.textContent = opps ? ('Opportunities (' + opps + ')') : 'Opportunities';
}
function showTab(t) {
  for (const k of ['inv','opp','sub','ord','fol','ana','eng','key']) {
    $('pane-' + k).style.display = t === k ? 'block' : 'none';
    $('tab-' + k).className = 'tab' + (t === k ? ' active' : '');
  }
  if (t === 'opp' && !OPPS.loaded) {
    loadOpps(1).catch(e => showError('rows_opp', 'Could not load opportunities: ' + (e && e.message || e), 'loadOpps(1)'));
  }
  if (t === 'sub') loadSubmissions();
  if (t === 'ord') loadOrders();
  if (t === 'fol') loadFollowups();
  if (t === 'ana') analytics();
  if (t === 'eng') engine();
  if (t === 'key') keys();
}

let followups = [];
async function loadFollowups() {
  const r = await fetch('/admin/api/checkouts', { headers: hdrs() });
  if (r.status === 401) { location.href = '/auth/login'; return; }
  const d = await r.json();
  followups = d.abandoned || [];
  const n = d.abandoned_count || followups.length;
  const tab = $('tab-fol');
  if (tab) tab.textContent = n ? ('Follow-up (' + n + ')') : 'Follow-up';
  const kpi = (v, l, hi) => '<div class="kpi' + (hi ? ' hi' : '') + '"><div class="n">' + v + '</div><div class="l">' + l + '</div></div>';
  if ($('fol_kpis')) $('fol_kpis').innerHTML =
    kpi(d.started ?? 0, 'Checkouts opened') +
    kpi(d.paid ?? 0, 'Paid') +
    kpi(n, 'Did not finish', true) +
    kpi(dollars(d.abandoned_cents), 'Unpaid $');
  renderFollowups();
}
function followupLabel(status) {
  if (status === 'expired') return 'Expired — did not pay';
  if (status === 'in_checkout') return 'Still in Checkout';
  return 'Did not finish — follow up';
}
function followupNote(c) {
  return [
    'email: ' + (c.email || ''),
    'amount: ' + dollars(c.amount_cents),
    'started: ' + (c.created_at || ''),
    'status: ' + followupLabel(c.status),
    c.checkout_url ? 'checkout: ' + c.checkout_url : '',
  ].filter(Boolean).join('\\n');
}
function renderFollowups() {
  if (!followups.length) {
    $('fol_rows').innerHTML = '<div class="empty">Nobody left Checkout unfinished.</div>';
    return;
  }
  $('fol_rows').innerHTML = followups.map((c, i) => {
    const when = (c.created_at || '').slice(0, 16);
    const email = c.email || '';
    const pill = c.status === 'expired' ? 'expired' : c.status === 'in_checkout' ? 'open' : 'follow';
    const mail = 'mailto:' + encodeURIComponent(email)
      + '?subject=' + encodeURIComponent('Your placement.sh checkout')
      + '&body=' + encodeURIComponent(followupNote(c));
    return '<article class="order">'
      + '<div class="order-top">'
      + '<span class="pill ' + pill + '">' + esc(followupLabel(c.status)) + '</span>'
      + '<span class="sub">' + esc(when) + '</span>'
      + '<span class="price">' + dollars(c.amount_cents) + '</span>'
      + '</div>'
      + '<h3>' + (email ? esc(email) : '<span class="sub">no email on this session</span>') + '</h3>'
      + '<p class="meta">Opened Checkout, did not complete payment.'
      + (c.available_cents ? ' Credits already on account: ' + dollars(c.available_cents) + '.' : '')
      + (c.status === 'expired' ? ' The Stripe link has expired — send a new one if they still want to pay.' : '')
      + '</p>'
      + '<div class="actions">'
      + (email ? '<a class="primary" href="' + mail + '">Email</a>' : '')
      + (email ? '<button type="button" class="copy" data-fol-copy="email" data-i="' + i + '">Copy email</button>' : '')
      + (c.checkout_url && c.status !== 'expired' ? '<button type="button" class="copy" data-fol-copy="link" data-i="' + i + '">Copy checkout link</button>' : '')
      + '<button type="button" class="copy" data-fol-copy="note" data-i="' + i + '">Copy follow-up</button>'
      + '</div></article>';
  }).join('');
}

let ordersCache = [];
let ordersShown = [];
async function loadOrders() {
  const r = await fetch('/admin/api/orders', { headers: hdrs() });
  if (r.status === 401) { location.href = '/auth/login'; return; }
  const d = await r.json();
  ordersCache = d.orders || [];
  renderOrders();
}
function renderOrders() {
  const spec = ($('ord_sort') && $('ord_sort').value) || 'created_at:desc';
  const parts = spec.split(':');
  const key = parts[0];
  const mul = parts[1] === 'asc' ? 1 : -1;
  ordersShown = ordersCache.slice().sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'number' || typeof bv === 'number') return mul * ((Number(av) || 0) - (Number(bv) || 0));
    return mul * String(av || '').localeCompare(String(bv || ''), undefined, { sensitivity: 'base' });
  });
  if (!ordersShown.length) {
    $('ord_rows').innerHTML = '<div class="empty">No submitted posts yet.</div>';
    return;
  }
  $('ord_rows').innerHTML = ordersShown.map((o, i) => {
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
  const o = ordersShown[i];
  if (!o) return;
  copyText((o.title || '') + '\\n\\n' + (o.body || ''));
}
function copyDetails(i) {
  const o = ordersShown[i];
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
  ? '<table class="mini"><thead><tr>' + headers.map((h, i) => '<th class="' + (h.n ? 'num ' : '') + 'sort" data-col="' + i + '"' + (h.n ? ' data-num="1"' : '') + '>' + h.t + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map(r => '<tr>' + r.map((c, i) => '<td' + (headers[i].n ? ' class="num"' : '') + '>' + c + '</td>').join('') + '</tr>').join('')
    + '</tbody></table>'
  : '<div class="empty">' + empty + '</div>';

function dollars(cents) {
  return '$' + ((Number(cents) || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtQuery(raw) {
  try {
    const a = JSON.parse(raw);
    const bits = [];
    if (Array.isArray(a.topics) && a.topics.length) bits.push(a.topics.join(', '));
    if (a.text) bits.push('"' + a.text + '"');
    if (a.min_score != null) bits.push('score ≥ ' + a.min_score);
    if (a.max_price != null) bits.push('≤ $' + a.max_price);
    if (a.link_attribute) bits.push(a.link_attribute);
    return bits.join(' · ') || String(raw || '');
  } catch (e) { return String(raw || ''); }
}

async function analytics() {
  const r = await fetch('/admin/api/analytics', { headers: hdrs() });
  if (r.status === 401) { location.href = '/auth/login'; return; }
  const d = await r.json();
  const ac = d.accounts || {};
  const act = d.activity || {};
  const wal = d.wallets || {};
  const ord = d.orders || {};
  const fun = d.funnel || {};
  const kpi = (n, l, hi) => '<div class="kpi' + (hi ? ' hi' : '') + '"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
  $('kpis').innerHTML =
    kpi(act.queries_24h ?? 0, 'queries last 24h', true) +
    kpi(act.queries_7d ?? 0, 'queries last 7 days') +
    kpi(act.identified_agents ?? 0, 'agents with a key') +
    kpi(ac.total ?? 0, 'accounts') +
    kpi(wal.funded_accounts ?? fun.funded_accounts ?? 0, 'funded accounts', true) +
    kpi(dollars(wal.available_cents), 'credits on hand') +
    kpi(fun.abandoned_checkouts ?? 0, 'opened checkout, didn’t pay', true) +
    kpi(ord.in_review ?? 0, 'orders in review', true) +
    kpi((act.zero_result_rate ?? 0) + '%', 'zero-result rate');

  const steps = [
    ['Anonymous queries', fun.anonymous_queries ?? act.anonymous_queries ?? 0],
    ['Accounts', fun.signups ?? ac.total ?? 0],
    ['Funded', fun.funded_accounts ?? wal.funded_accounts ?? 0],
    ['Checkouts opened', fun.checkouts_started ?? 0],
    ['Paid', fun.checkouts_paid ?? 0],
    ['Did not finish', fun.abandoned_checkouts ?? 0],
    ['Orders', fun.orders ?? ord.total ?? 0],
  ];
  const maxStep = Math.max(1, ...steps.map(s => s[1]));
  $('a_funnel').innerHTML = steps.map(s =>
    '<div class="step"><div class="n">' + s[1] + '</div><div class="l">' + s[0] + '</div>'
    + '<div class="bar"><i style="width:' + Math.round(100 * s[1] / maxStep) + '%"></i></div></div>'
  ).join('');

  const days = (d.daily || []).slice().reverse();
  const maxQ = Math.max(1, ...days.map(x => x.queries));
  $('a_spark').innerHTML = days.length
    ? '<div class="spark">' + days.map(x =>
        '<div class="spark-col" title="' + esc(x.day) + ': ' + x.queries + ' queries"><div class="spark-bar" style="height:' + Math.round(80 * x.queries / maxQ) + '%"></div><span>' + esc((x.day || '').slice(5)) + '</span></div>'
      ).join('') + '</div>'
    : '<div class="empty">No activity logged yet.</div>';
  $('a_daily').innerHTML = tbl(
    [{t:'Day'},{t:'Queries',n:1},{t:'Agents',n:1},{t:''}],
    days.slice().reverse().map(x => [x.day, x.queries, x.agents,
      '<div class="barcell" style="--w:' + Math.round(100 * x.queries / maxQ) + '%">&nbsp;</div>']),
    'No activity logged yet.');

  $('a_tools').innerHTML = tbl(
    [{t:'Tool'},{t:'Calls',n:1},{t:'Zero-result',n:1},{t:'Miss %',n:1}],
    (d.by_tool || []).map(t => {
      const calls = t.calls ?? 0;
      const zero = t.zero_result_calls ?? 0;
      return [esc(t.tool), calls, zero, calls ? Math.round(100 * zero / calls) + '%' : '–'];
    }),
    'No tool calls logged yet.');

  $('a_topics').innerHTML = tbl(
    [{t:'Topic'},{t:'Searches',n:1}],
    (d.top_topics || []).map(t => [esc(t.topic), t.times]),
    'No searches yet — this is what agents are actually asking for.');

  $('a_unmet').innerHTML = tbl(
    [{t:'Query'},{t:'Times',n:1}],
    (d.unmet_demand || []).map(u => [esc(fmtQuery(u.args || '').slice(0, 120)), u.times]),
    'Nothing yet. Each row is inventory an agent wanted and we could not supply.');

  $('a_niches').innerHTML = tbl(
    [{t:'Niche'},{t:'Sites',n:1},{t:'Avg score',n:1},{t:'Priced',n:1}],
    (d.niches || []).map(n => [esc(n.niche), n.sites, n.avg_score ?? '–', n.priced ?? 0]),
    'No sites in inventory yet.');

  const ready = d.inventory_readiness || {};
  $('a_ready').innerHTML = tbl(
    [{t:'Check'},{t:'Count',n:1}],
    [['Paid publishers', ready.total_sites],
     ['Free opportunities', ready.opportunities],
     ['Opportunities still unverified', ready.opportunities_unverified],
     ['Link attribute still unknown (launch blocker)', ready.link_attr_unknown],
     ['Unpriced sites', ready.unpriced],
     ['Orders held $', dollars(ord.listed_cents)]],
    '');

  $('a_signups').innerHTML = tbl(
    [{t:'Email'},{t:'Tier'},{t:'Credits'},{t:'Held'},{t:'Claimed',n:1},{t:'Signed up'}],
    (d.signups || []).map(s => [esc(s.email), esc(s.tier), dollars(s.available_cents), dollars(s.held_cents), (s.orders_used ?? 0) + '/' + (s.quota ?? 0), esc((s.created_at || '').slice(0, 16))]),
    'No signups yet. Every register_account call lands here.');

  $('a_free').innerHTML = tbl(
    [{t:'Site'},{t:'Mode'},{t:'Claims',n:1}],
    (d.free_placements_by_site || []).map(f => [esc(f.domain || f.site_id), esc(f.acquisition_mode || ''), f.claims]),
    'No legacy free claims.');
}

const val = (id) => { const el = $(id); return el ? el.value : ''; };

function resetFilters(v) {
  const view = VIEWS[v] || VIEWS.inv;
  for (const id of [view.q, view.niche, view.status, view.mode]) { const el = $(id); if (el) el.value = ''; }
  load(v, 1);
}

async function load(v, p) {
  const view = VIEWS[v];
  if (!view) return;
  view.page = Math.max(1, p || 1);
  const u = new URLSearchParams({ page: view.page, sort: view.sort, dir: view.dir, cost_type: view.cost });
  if (val(view.q)) u.set('q', val(view.q));
  if (val(view.niche)) u.set('niche', val(view.niche));
  if (val(view.status)) u.set('status', val(view.status));
  if (val(view.mode)) u.set('acquisition_mode', val(view.mode));
  const r = await fetch('/admin/api/sites?' + u, { headers: hdrs() });
  if (r.status === 401) { location.href = '/auth/login'; return; }
  const d = await r.json();
  view.loaded = true;
  $(view.info).textContent = 'page ' + d.page + ' — ' + d.total + ' ' + view.noun;
  const sites = d.sites || [];
  $(view.rows).innerHTML = sites.length
    ? sites.map(rowHtml).join('')
    : '<tr><td colspan="' + view.cols + '" class="empty">No ' + view.noun + ' match these filters. '
      + '<button class="copy" data-reset="' + v + '">Reset filters</button></td></tr>';
  const sel = $(view.niche);
  if (sel) {
    const niches = new Set([...sel.options].map(o => o.value));
    sites.forEach(s => { if (s.niche && !niches.has(s.niche)) { const o = document.createElement('option'); o.textContent = s.niche; sel.appendChild(o); niches.add(s.niche); } });
  }
  markSortHeaders(v);
}
const TEXT_SORT = { domain:1, niche:1, acquisition_mode:1, link_attribute:1, status:1 };
function setSort(v, col) {
  const view = VIEWS[v];
  if (!view) return;
  if (view.sort === col) view.dir = view.dir === 'asc' ? 'desc' : 'asc';
  else { view.sort = col; view.dir = TEXT_SORT[col] ? 'asc' : 'desc'; }
  load(v, 1);
}
function markSortHeaders(v) {
  for (const k of v ? [v] : Object.keys(VIEWS)) {
    const view = VIEWS[k];
    document.querySelectorAll('#pane-' + k + ' th.sort').forEach(th => {
      const on = th.dataset.sort === view.sort;
      th.classList.toggle('sorted', on);
      th.dataset.dir = on ? view.dir : '';
    });
  }
}
function sortMini(th) {
  const table = th.closest('table');
  if (!table) return;
  const col = parseInt(th.dataset.col, 10);
  const num = th.dataset.num === '1';
  const tbody = table.tBodies[0];
  const rows = Array.prototype.slice.call(tbody.rows);
  const dir = th.dataset.dir === 'asc' ? -1 : 1;
  table.querySelectorAll('th.sort').forEach(h => { h.dataset.dir = ''; h.classList.remove('sorted'); });
  th.dataset.dir = dir === 1 ? 'asc' : 'desc';
  th.classList.add('sorted');
  rows.sort((a, b) => {
    const av = (a.cells[col] && a.cells[col].textContent || '').trim();
    const bv = (b.cells[col] && b.cells[col].textContent || '').trim();
    if (num) return dir * ((parseFloat(av.replace(/[^0-9.-]/g, '')) || 0) - (parseFloat(bv.replace(/[^0-9.-]/g, '')) || 0));
    return dir * av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
  });
  rows.forEach(r => tbody.appendChild(r));
}
const esc = (s) => (s ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function enrichPill(s) {
  if (s.enrich_status === 'ok') return ' <span class="pill active">crawled</span>';
  if (s.enrich_status) return ' <span class="pill">' + esc(s.enrich_status) + '</span>';
  return '';
}
function rowHtml(s) {
  const margin = s.margin == null ? '–' : '$' + s.margin;
  const mclass = s.margin > 0 ? 'margin-pos' : s.margin < 0 ? 'margin-neg' : '';
  const attrs = ['unknown','dofollow','sponsored','ugc','nofollow'];
  const stats_ = ['active','paused','burned'];
  const modes = ['paid_placement','self_serve','apply_editorial','link_exchange','unavailable'];
  return '<tr data-id="' + s.id + '">' +
    '<td class="domain"><button type="button" class="domain-btn" data-open-site="' + esc(s.id) + '">' + esc(s.domain) + '</button>' + enrichPill(s) + (s.note ? '<div class="sub">' + esc(s.note).slice(0,60) + '</div>' : '') + '</td>' +
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
  const row = el.closest('tr');
  const r = await fetch('/admin/api/sites/' + row.dataset.id, { method: 'PATCH', headers: hdrs(), body: JSON.stringify({ [field]: value }) });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'update failed', true); return; }
  const listed = row.querySelector('[data-col=listed]');
  if (listed) {
    listed.textContent = d.site.listed_price != null ? '$' + d.site.listed_price : '–';
    const m = d.site.listed_price != null && d.site.seller_price != null ? Math.round((d.site.listed_price - d.site.seller_price) * 100) / 100 : null;
    const mtd = row.querySelector('[data-col=margin]');
    if (mtd) {
      mtd.textContent = m == null ? '–' : '$' + m;
      mtd.className = 'num ' + (m > 0 ? 'margin-pos' : m < 0 ? 'margin-neg' : '');
    }
  }
  toast(field + ' saved'); stats();
}
async function addSite() {
  const body = { domain: $('a_domain').value, niche: $('a_niche').value || null,
    seller_price: $('a_seller').value ? parseFloat($('a_seller').value) : null,
    markup: $('a_markup').value ? parseFloat($('a_markup').value) : 1.6,
    contact_email: $('a_email').value || null, cost_type: 'paid' };
  const r = await fetch('/admin/api/sites', { method: 'POST', headers: hdrs(), body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'add failed', true); return; }
  toast('added ' + d.domain); load('inv', 1); stats();
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

document.getElementById('pane-fol').addEventListener('click', (ev) => {
  const t = ev.target;
  if (!t || !t.dataset || !t.dataset.folCopy) return;
  const c = followups[parseInt(t.dataset.i, 10)];
  if (!c) return;
  if (t.dataset.folCopy === 'email') copyText(c.email || '');
  else if (t.dataset.folCopy === 'link') copyText(c.checkout_url || '');
  else copyText(followupNote(c));
});

function onCellChange(ev) {
  const el = ev.target;
  const field = el && el.dataset && el.dataset.field;
  if (!field) return;
  let value = el.value;
  if (el.dataset.kind === 'float') value = value === '' ? null : parseFloat(value);
  else if (el.dataset.kind === 'int') value = value === '' ? null : parseInt(value, 10);
  patch(el, field, value);
}
document.getElementById('rows').addEventListener('change', onCellChange);

document.getElementById('pane-inv').addEventListener('click', (ev) => {
  const t = ev.target;
  if (!t || !t.closest) return;
  const open = t.closest('[data-open-site]');
  if (open && open.dataset.openSite) { openSite(open.dataset.openSite, 'inv'); return; }
  if (t.dataset && t.dataset.reset) { resetFilters(t.dataset.reset); return; }
  const th = t.closest('th.sort');
  if (th && th.dataset.sort) setSort('inv', th.dataset.sort);
});

// ---------- opportunities ----------
// The free catalog. An operator's job here is verification: the workbook gave us
// 843 rows of which one had both its requirements and its source officially
// reviewed, so every row starts flagged and gets cleared by hand.
const CONTRIB_LABEL = { article: 'article', profile: 'profile', program: 'program' };

function oppRowHtml(o) {
  const stats_ = ['active','watchlist','retired'];
  // A live read wins over the workbook, including when it is bad news.
  const readFree = o.verified_is_free === 1 || o.verified_is_free === true;
  const readPaid = o.verified_is_free === 0 || o.verified_is_free === false;
  const costText = o.verified_cost_model || o.cost_model || '–';
  const cost = readPaid
    ? '<span class="pill warn">' + esc(costText) + '</span>'
    : (readFree || o.is_free_confirmed
      ? '<span class="pill ok">' + esc(costText) + '</span>'
      : (o.cost_confidence === 'unknown'
        ? '<span class="pill warn">not established</span>'
        : esc(costText)));
  const dead = o.liveness === 'dead' ? '<div class="sub">dead link (' + esc(String(o.http_status || '')) + ')</div>' : '';
  const conf = o.needs_reverification
    ? '<span class="pill warn">template — verify</span>'
    : '<span class="pill ok">' + (o.verify_source === 'llm-page-read-v1' ? 'live read ' : 'operator ')
      + esc(String(o.verified_at || o.last_checked || '').slice(0, 10)) + '</span>';
  const url = o.submission_url || ('https://' + (o.domain || ''));
  return '<tr data-id="' + esc(o.id) + '">' +
    '<td class="domain"><a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(o.platform) + '</a>' +
      (o.domain ? '<div class="sub">' + esc(o.domain) + '</div>' : '') + '</td>' +
    '<td>' + esc(CONTRIB_LABEL[o.contribution] || o.contribution || '') + '</td>' +
    '<td>' + esc(o.opportunity_type || '–') + '</td>' +
    '<td>' + esc(o.niche || '–') + '</td>' +
    '<td>' + cost + (o.requires_reciprocal_link ? '<div class="sub">wants a link back</div>' : '')
      + (o.verify_note ? '<div class="sub" title="' + esc(o.verify_note) + '">⚠ ' + esc(String(o.verify_note).slice(0, 44)) + '…</div>' : '')
      + dead + '</td>' +
    '<td>' + esc((o.link_attribute_claim || 'unknown').replace('claimed_', 'claimed ')) + '</td>' +
    '<td class="num">' + (o.priority_score ?? '–') + '</td>' +
    '<td class="num">' + (o.prep_minutes != null ? o.prep_minutes + 'm' : '–') + '</td>' +
    '<td>' + conf + '</td>' +
    '<td><select data-opp-field="status">' + stats_.map(a => '<option' + (a === o.status ? ' selected' : '') + '>' + a + '</option>').join('') + '</select></td>' +
    '<td>' + (o.needs_reverification
      ? '<button class="copy" data-verify="' + esc(o.id) + '">Mark verified</button>'
      : '<span class="sub">done</span>') + '</td>' +
    '</tr>';
}

async function loadOpps(p) {
  OPPS.page = Math.max(1, p || 1);
  const u = new URLSearchParams({ page: OPPS.page, sort: OPPS.sort, dir: OPPS.dir });
  const add = (k, id) => { const el = $(id); if (el && el.value) u.set(k, el.value); };
  add('q', 'q_opp'); add('contribution', 'f_contribution'); add('status', 'f_opp_status');
  add('cost', 'f_cost'); add('verified', 'f_verify');
  const r = await fetch('/admin/api/opportunities?' + u, { headers: hdrs() });
  if (r.status === 401) { location.href = '/auth/login'; return; }
  const d = await r.json();
  OPPS.loaded = true;
  $('pageinfo_opp').textContent = 'page ' + d.page + ' — ' + d.total + ' opportunities';
  const rows = d.opportunities || [];
  $('rows_opp').innerHTML = rows.length
    ? rows.map(oppRowHtml).join('')
    : '<tr><td colspan="11" class="empty">No opportunities match these filters.</td></tr>';
  document.querySelectorAll('#pane-opp th.sort').forEach(th => {
    const on = th.dataset.sort === OPPS.sort;
    th.classList.toggle('sorted', on);
    th.dataset.dir = on ? OPPS.dir : '';
  });
}

async function patchOpp(id, body) {
  const r = await fetch('/admin/api/opportunities/' + id, { method: 'PATCH', headers: hdrs(), body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'update failed', true); return false; }
  return true;
}

document.getElementById('pane-opp').addEventListener('click', async (ev) => {
  const t = ev.target;
  if (!t || !t.closest) return;
  const v = t.closest('[data-verify]');
  if (v) {
    // Stamping "verified" is a claim an operator makes with their own eyes, so
    // say what it means before recording it.
    if (!confirm('Only do this if you have just opened the live page and confirmed the cost and the requirements. Mark it verified?')) return;
    if (await patchOpp(v.dataset.verify, { verified: true })) { toast('marked verified'); loadOpps(OPPS.page); stats(); }
    return;
  }
  const th = t.closest('th.sort');
  if (th && th.dataset.sort) {
    if (OPPS.sort === th.dataset.sort) OPPS.dir = OPPS.dir === 'asc' ? 'desc' : 'asc';
    else { OPPS.sort = th.dataset.sort; OPPS.dir = 'desc'; }
    loadOpps(1);
  }
});

document.getElementById('rows_opp').addEventListener('change', async (ev) => {
  const el = ev.target;
  const field = el && el.dataset && el.dataset.oppField;
  if (!field) return;
  const row = el.closest('tr');
  if (await patchOpp(row.dataset.id, { [field]: el.value })) { toast(field + ' saved'); stats(); }
});

// ---------- submissions ----------
async function loadSubmissions() {
  const r = await fetch('/admin/api/submissions', { headers: hdrs() });
  if (r.status === 401) { location.href = '/auth/login'; return; }
  const d = await r.json();
  const kpi = (v, l, hi) => '<div class="kpi' + (hi ? ' hi' : '') + '"><div class="n">' + v + '</div><div class="l">' + l + '</div></div>';
  $('sub_kpis').innerHTML =
    kpi(d.total ?? 0, 'Submissions') +
    kpi(d.by_state?.live ?? 0, 'Live') +
    kpi((d.by_state?.submitted ?? 0) + (d.by_state?.pending ?? 0), 'Waiting on the platform') +
    kpi(d.by_state?.needs_human ?? 0, 'Needs a human', true) +
    kpi(d.companies ?? 0, 'Companies');
  const rows = d.submissions || [];
  $('rows_sub').innerHTML = rows.length
    ? rows.map(x => '<tr>' +
        '<td>' + esc(x.company_url || '') + '</td>' +
        '<td>' + esc(x.platform || '') + '</td>' +
        '<td>' + esc(x.contribution || '') + '</td>' +
        '<td><span class="pill ' + (x.state === 'live' ? 'ok' : x.state === 'needs_human' ? 'warn' : '') + '">' + esc(x.state) + '</span></td>' +
        '<td>' + (x.published_url ? '<a href="' + esc(x.published_url) + '" target="_blank" rel="noopener">listing</a>' : '<span class="sub">–</span>') + '</td>' +
        '<td>' + (x.observed_rel ? esc(x.observed_rel) : '<span class="sub">not checked</span>') + '</td>' +
        '<td>' + (x.observed_indexed == null ? '<span class="sub">–</span>' : (x.observed_indexed ? 'yes' : 'no')) + '</td>' +
        '<td class="sub">' + esc((x.updated_at || '').slice(0, 16)) + '</td>' +
        '</tr>').join('')
    : '<tr><td colspan="8" class="empty">No customer has run the free path yet.</td></tr>';
}
document.getElementById('pane-ana').addEventListener('click', (ev) => {
  const th = ev.target && ev.target.closest && ev.target.closest('th.sort');
  if (th) sortMini(th);
});

let siteOpenId = null;
function sdBlock(label, html) {
  if (!html) return '';
  return '<section class="sd-sec"><h3>' + esc(label) + '</h3>' + html + '</section>';
}
function sdPara(text) {
  if (!text) return '';
  return '<p>' + esc(text) + '</p>';
}
function sdChips(list) {
  if (!list || !list.length) return '';
  return '<p>' + list.map(t => '<span class="pill">' + esc(t) + '</span>').join(' ') + '</p>';
}
function sdTitles(list) {
  if (!list || !list.length) return '';
  return '<ul class="sd-titles">' + list.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul>';
}
function siteDrawerHtml(s) {
  const href = 'https://' + (s.domain || '');
  const enrich = s.enrich_status
    ? (esc(s.enrich_status) + (s.content_source ? ' · ' + esc(s.content_source) : '') + (s.enriched_at ? ' · ' + esc(String(s.enriched_at).slice(0, 16)) : ''))
    : 'not crawled';
  const hasProfile = !!(s.summary || s.summary_private || (s.writes_about && s.writes_about.length) || (s.recent_titles && s.recent_titles.length) || s.audience || s.tone);
  return '<p class="sd-kicker"><a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(s.domain) + '</a></p>'
    + '<p class="meta">' + esc(s.niche || '–') + (s.subniche ? ' / ' + esc(s.subniche) : '')
    + ' · score ' + (s.cite_score ?? '–')
    + (s.contact_email ? ' · ' + esc(s.contact_email) : '')
    + (s.contact_name ? ' · ' + esc(s.contact_name) : '')
    + '</p>'
    + '<p class="sub">Crawl: ' + enrich + '</p>'
    + sdBlock('Buyer-facing summary', sdPara(s.summary))
    + sdBlock('Private notes', sdPara(s.summary_private))
    + sdBlock('Audience', sdPara(s.audience))
    + sdBlock('Tone', sdPara(s.tone))
    + sdBlock('Post shape', sdPara(s.post_shape) + (s.typical_length_words ? '<p class="sub">Typical length: ' + esc(s.typical_length_words) + ' words</p>' : ''))
    + sdBlock('Do fit', sdPara(s.do_fit))
    + sdBlock("Don't fit", sdPara(s.dont_fit))
    + sdBlock('Topics', sdChips(s.writes_about))
    + sdBlock('Recent titles', sdTitles(s.recent_titles))
    + (hasProfile ? '' : '<p class="empty">No crawl profile for this domain yet.</p>');
}
async function openSite(id, v) {
  if (!id) return;
  showTab(v === 'free' ? 'free' : 'inv');
  if (siteOpenId === id) {
    $('site-drawer-bg').hidden = false;
    $('site-drawer').hidden = false;
    return;
  }
  siteOpenId = id;
  const want = '#site-' + id;
  if (location.hash !== want) location.hash = want;
  $('site-drawer-bg').hidden = false;
  $('site-drawer').hidden = false;
  $('sd-domain').textContent = 'Loading…';
  $('sd-handle').textContent = id;
  $('sd-body').innerHTML = '<p class="sub">Loading crawl profile…</p>';
  const r = await fetch('/admin/api/sites/' + id, { headers: hdrs() });
  if (r.status === 401) { location.href = '/auth/login'; return; }
  if (r.status === 404) { $('sd-body').innerHTML = '<p class="empty">Site not found.</p>'; return; }
  if (!r.ok) { $('sd-body').innerHTML = '<p class="empty">Could not load this site.</p>'; return; }
  const d = await r.json();
  const s = d.site || {};
  $('sd-domain').textContent = s.domain || id;
  $('sd-handle').textContent = s.id || id;
  $('sd-body').innerHTML = siteDrawerHtml(s);
}
function closeSite() {
  siteOpenId = null;
  if ($('site-drawer-bg')) $('site-drawer-bg').hidden = true;
  if ($('site-drawer')) $('site-drawer').hidden = true;
  if (location.hash.indexOf('#site-') === 0) history.replaceState(null, '', location.pathname + location.search);
}
$('site-drawer-bg').addEventListener('click', closeSite);
$('sd-close').addEventListener('click', closeSite);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && $('site-drawer') && !$('site-drawer').hidden) closeSite();
});
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#site-(cs_[a-z0-9]+)$/);
  if (m) openSite(m[1]);
  else if (siteOpenId) closeSite();
});

boot();
</script>
</body>
</html>`;

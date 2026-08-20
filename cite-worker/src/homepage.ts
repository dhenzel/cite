/** Public landing page. What it is, who runs it, how to use it, add-to-agent buttons. */

import {
  BUYER_MAIL_FROM, OPERATOR_CALL_URL, OPERATOR_NAME, OPERATOR_TEAM_URL, OPERATOR_URL,
} from './discovery.js';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export const homepageHtml = (origin: string): string => {
  const mcp = `${origin.replace(/\/$/, '')}/mcp`;
  const mcpEsc = esc(mcp);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>placement.sh — get your URL cited, free or paid</title>
<meta name="description" content="Free: your agent finds where your company can get listed and prepares the submission. Paid: placement.sh books bought publisher placements so a URL can get cited in Google, ChatGPT, Perplexity, and AI Overviews.">
<meta property="og:title" content="placement.sh">
<meta property="og:description" content="Get your URL cited. Free — your agent finds where you can get listed and prepares it. Paid — we buy publisher placements against a budget.">
<link rel="canonical" href="https://placement.sh/">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #FAF9F6;
    --ink: #17204B;
    --muted: #6E7AA4;
    --line: #E4E0D6;
    --surface: #fff;
    --accent: #30D2AD;
    --accent-ink: #17204B;
    --dot: #30D2AD;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0F1114;
      --ink: #EDECE8;
      --muted: #A8A49A;
      --line: #2A2D33;
      --surface: #171A1F;
      --accent: #30D2AD;
      --accent-ink: #17204B;
      --dot: #30D2AD;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    min-height: 100vh;
    background: var(--bg);
    color: var(--ink);
    font: 17px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    max-width: 36rem;
    margin: 0 auto;
    padding: 4.5rem 1.4rem 5rem;
  }
  h1 {
    font-size: 1.85rem;
    font-weight: 700;
    letter-spacing: -0.04em;
    margin: 0 0 1.1rem;
  }
  h1 .dot { color: var(--dot); }
  .lede { font-size: 1.22rem; line-height: 1.4; margin: 0 0 0.7rem; }
  .sub { color: var(--muted); margin: 0 0 1.6rem; }
  .who {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 1rem 1.05rem;
    margin: 0 0 2.2rem;
  }
  .who p { margin: 0 0 0.55rem; }
  .who p:last-child { margin: 0; }
  .who a { color: var(--ink); }
  .who .links a:first-child { font-weight: 600; }
  h2 {
    font-size: 0.78rem;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 0.85rem;
  }
  ol { margin: 0 0 2.4rem; padding-left: 1.2rem; }
  li { margin: 0.35rem 0; }
  li strong { font-weight: 600; }
  .clients {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0 0 1.4rem;
  }
  .clients button {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--ink);
    background: var(--ink);
    color: var(--bg);
    font: inherit;
    font-size: 0.95rem;
    font-weight: 600;
    padding: 0.55rem 0.95rem;
    border-radius: 999px;
    cursor: pointer;
    text-decoration: none;
  }
  .clients button:hover { filter: brightness(1.08); }
  .clients button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .clients button[aria-pressed="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
    filter: none;
  }
  .urlrow {
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
    margin: 0 0 1.5rem;
  }
  .urlrow code {
    flex: 1;
    min-width: 0;
    font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.65rem 0.75rem;
    overflow-x: auto;
    white-space: nowrap;
  }
  .urlrow button {
    appearance: none;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    font-size: 0.9rem;
    padding: 0 0.9rem;
    border-radius: 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 1rem 1.05rem 1.05rem;
    min-height: 7.5rem;
  }
  .panel h3 { margin: 0 0 0.45rem; font-size: 1rem; }
  .panel p, .panel ol { color: var(--muted); font-size: 0.95rem; margin: 0 0 0.7rem; }
  .panel ol { padding-left: 1.15rem; }
  .panel pre {
    margin: 0 0 0.7rem;
    overflow-x: auto;
    background: var(--bg);
    border-radius: 8px;
    padding: 0.7rem 0.8rem;
    font: 12.5px/1.45 ui-monospace, Menlo, Consolas, monospace;
  }
  .panel .ask { color: var(--ink); }
  .panel .muted { color: var(--muted); }
  footer {
    margin-top: 2.6rem;
    padding-top: 1.4rem;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.95rem;
  }
  footer a { color: var(--ink); }
  .ways { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); margin:1.4rem 0; }
  .way { border:1px solid var(--line); border-radius:12px; padding:1rem 1.1rem; background:var(--surface); }
  .way h3 { margin:0 0 .5rem; font-size:1.02rem; }
  .way p { margin:0 0 .6rem; line-height:1.55; }
  .way .fine { font-size:.86rem; color:var(--muted); margin-bottom:0; }
  footer .trust { margin: 0 0 0.7rem; line-height: 1.5; }
  footer .trust a { text-decoration: underline; text-underline-offset: 0.15em; }
  footer .meta { font-size: 0.82rem; color: var(--muted); }
  footer .meta a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>placement<span class="dot">.</span>sh</h1>
  <p class="lede">Get your URL cited. Free where you can, paid where it is worth it.</p>

  <div class="ways">
    <div class="way">
      <h3>Free — get listed</h3>
      <p>Point your agent at your site. It works out what your company actually is, filters roughly 1,300 researched
      directories, marketplaces, review platforms and partner programs down to the ones you are genuinely eligible for,
      and prepares each submission — the fields, the copy, the assets. You log in, pass the CAPTCHA and press submit.</p>
      <p class="fine">No account, no card. We say how well each one is verified: cost is unconfirmed on about half the
      catalog, so your agent re-checks the live page before doing any work. Nobody can promise you approval or a link.</p>
    </div>
    <div class="way">
      <h3>Paid — bought placements</h3>
      <p>Pick a URL, topics and a budget. placement.sh books paid editorial placements on real publisher sites. That is
      bought inventory — not a guest-post mill you run yourself. Publisher domains stay hidden until a placement is
      delivered.</p>
      <p class="fine">Live and indexed at T+30, or refunded. Prepaid credits, charged at the exact listed price.</p>
    </div>
  </div>

  <p class="sub">Start free. The paid side is there when you have exhausted the free options, or when you want a specific
  publisher and have a budget — a different mechanism, and we will say so rather than blur the two.</p>

  <div class="who">
    <p><strong>Who runs this.</strong> A <a href="${esc(OPERATOR_TEAM_URL)}">named ${esc(OPERATOR_NAME)} team</a> that has bought publisher placements since 2018 — people you can look up, not a new domain with a Stripe form.</p>
    <p class="links"><a href="${esc(OPERATOR_TEAM_URL)}">Meet the team</a>
      · <a href="${esc(OPERATOR_CALL_URL)}">Book a 15-min call</a>
      · <a href="${esc(OPERATOR_URL)}">shortlist.io</a></p>
  </div>

  <h2>How to use it</h2>
  <ol>
    <li><strong>Add this MCP</strong> to Claude, ChatGPT, Grok, Kimi, Cursor, Hermes, or any agent that speaks MCP.</li>
    <li><strong>For the free path</strong>, ask the agent to analyse your site. It will come back with what it could not
    work out — answer those, especially anything about licences or memberships, then let it match and prepare.</li>
    <li><strong>For the paid path</strong>, ask the agent to estimate — URL, topics, budget. No card required to look.
    The agent should tell you this is Shortlist before you pay.</li>
    <li><strong>To buy</strong>, the agent asks for a contact email, then opens a Stripe Checkout link for prepaid credits.</li>
  </ol>

  <h2>Add to your agent</h2>
  <div class="clients" role="group" aria-label="Show setup steps for an agent">
    <button type="button" data-client="claude" aria-pressed="false">Claude</button>
    <button type="button" data-client="chatgpt" aria-pressed="false">ChatGPT</button>
    <button type="button" data-client="grok" aria-pressed="false">Grok</button>
    <button type="button" data-client="kimi" aria-pressed="false">Kimi</button>
    <button type="button" data-client="cursor" aria-pressed="false">Cursor</button>
    <button type="button" data-client="hermes" aria-pressed="false">Hermes</button>
  </div>

  <div class="urlrow">
    <code id="mcp-url">${mcpEsc}</code>
    <button type="button" id="copy-url">Copy URL</button>
  </div>

  <div class="panel" id="panel" aria-live="polite">
    <p class="muted">Pick an agent. Steps stay here — we don’t send you into the product.</p>
  </div>

  <footer>
    <p class="trust"><strong>A <a href="${esc(OPERATOR_URL)}">Shortlist</a> product.</strong>
      Publisher placements since 2018. Named people, a real company, not a fly-by-night checkout page.
      <a href="${esc(OPERATOR_TEAM_URL)}">Meet the team</a>
      · <a href="${esc(OPERATOR_CALL_URL)}">Book a 15-min call</a>
      · <a href="${esc(OPERATOR_URL)}">shortlist.io</a>.</p>
    <p class="meta">Streamable HTTP MCP · POST ${mcpEsc}<br>
    Agents: <a href="/llms.txt">/llms.txt</a>
    · <a href="/.well-known/mcp/server.json">server card</a>
    · <a href="mailto:${esc(BUYER_MAIL_FROM)}">${esc(BUYER_MAIL_FROM)}</a></p>
  </footer>
</main>
<script>
(function () {
  var MCP = ${JSON.stringify(mcp)};
  var ASK = "Then tell it: Get https://example.com cited on [topics], budget $X. It should call estimate first, then ask for your email to register.";
  var guides = {
    claude: {
      title: "In Claude",
      steps: [
        "Customize → Connectors → Add custom connector.",
        "Paste the MCP URL. No OAuth for the public tools.",
        "Or in a terminal:"
      ],
      cmd: ${JSON.stringify(`claude mcp add --transport http placement ${mcp}`)}
    },
    chatgpt: {
      title: "In ChatGPT",
      steps: [
        "Settings → Apps → Advanced settings → turn on Developer mode.",
        "Create a custom connector named placement. Paste the MCP URL. Authentication: none.",
        "In a chat, enable the connector from the tools menu."
      ]
    },
    grok: {
      title: "In Grok",
      steps: [
        "Open Connectors and add a custom connector with this MCP URL.",
        "Or in a terminal:"
      ],
      cmd: ${JSON.stringify(`grok mcp add --transport http placement ${mcp}`)}
    },
    kimi: {
      title: "In Kimi",
      steps: [
        "The Kimi web app does not take custom connectors — use Kimi Code or the CLI.",
        "In Kimi Code: /mcp-config → add by URL. Or:"
      ],
      cmd: ${JSON.stringify(`kimi mcp add --transport http placement ${mcp}`)}
    },
    cursor: {
      title: "In Cursor",
      steps: [
        "Settings → MCP → Add a new global MCP server.",
        "Type: Streamable HTTP. URL:"
      ],
      cmd: MCP
    },
    hermes: {
      title: "In Hermes",
      steps: [
        "Hermes Agent speaks MCP over HTTP. In a terminal:"
      ],
      cmd: ${JSON.stringify(`hermes mcp add placement --url ${mcp}`)}
    }
  };

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {});
    }
  }
  function render(id) {
    var g = guides[id];
    if (!g) return;
    var html = "<h3>" + g.title + "</h3><ol>";
    g.steps.forEach(function (s) { html += "<li>" + s + "</li>"; });
    html += "</ol>";
    if (g.cmd) html += "<pre>" + g.cmd.replace(/</g, "&lt;") + "</pre>";
    html += '<p class="ask">' + ASK + "</p>";
    document.getElementById("panel").innerHTML = html;
  }
  document.querySelectorAll("[data-client]").forEach(function (el) {
    el.addEventListener("click", function () {
      var id = el.getAttribute("data-client");
      document.querySelectorAll("[data-client]").forEach(function (b) {
        b.setAttribute("aria-pressed", b === el ? "true" : "false");
      });
      copy(MCP);
      render(id);
    });
  });
  document.getElementById("copy-url").addEventListener("click", function () {
    copy(MCP);
    this.textContent = "Copied";
    var btn = this;
    setTimeout(function () { btn.textContent = "Copy URL"; }, 1400);
  });
})();
</script>
</body>
</html>`;
};

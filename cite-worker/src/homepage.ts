/** Public landing page. Minimal: what it is, how to use it, add-to-agent buttons. */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const cursorDeeplink = (mcp: string) => {
  const config = btoa(JSON.stringify({ url: mcp }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=placement&config=${config}`;
};

export const homepageHtml = (origin: string): string => {
  const mcp = `${origin.replace(/\/$/, '')}/mcp`;
  const mcpEsc = esc(mcp);
  const cursor = esc(cursorDeeplink(mcp));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>placement.sh — buy publisher placements so a URL gets cited</title>
<meta name="description" content="An agent sets a budget; placement.sh books bought publisher placements so a URL can get cited in Google, ChatGPT, Perplexity, and AI Overviews.">
<meta property="og:title" content="placement.sh">
<meta property="og:description" content="Buy publisher placements so a URL gets cited. Connect your agent, set a budget, we book the campaign.">
<link rel="canonical" href="https://placement.sh/">
<style>
  :root {
    --bg: #FAF9F6;
    --ink: #161616;
    --muted: #5E5A52;
    --line: #E4E0D6;
    --surface: #fff;
    --accent: #14655A;
    --accent-ink: #fff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0F1114;
      --ink: #EDECE8;
      --muted: #A8A49A;
      --line: #2A2D33;
      --surface: #171A1F;
      --accent: #6FD3C0;
      --accent-ink: #08131A;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    min-height: 100vh;
    background: var(--bg);
    color: var(--ink);
    font: 17px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    max-width: 36rem;
    margin: 0 auto;
    padding: 4.5rem 1.4rem 5rem;
  }
  h1 {
    font-size: 1.65rem;
    font-weight: 650;
    letter-spacing: -0.03em;
    margin: 0 0 1.1rem;
  }
  .lede { font-size: 1.22rem; line-height: 1.4; margin: 0 0 0.7rem; }
  .sub { color: var(--muted); margin: 0 0 2.4rem; }
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
  .clients button, .clients a.btn {
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
  .clients button:hover, .clients a.btn:hover { filter: brightness(1.08); }
  .clients button:focus-visible, .clients a.btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
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
    margin: 0;
    overflow-x: auto;
    background: var(--bg);
    border-radius: 8px;
    padding: 0.7rem 0.8rem;
    font: 12.5px/1.45 ui-monospace, Menlo, Consolas, monospace;
  }
  .panel .muted { color: var(--muted); }
  footer {
    margin-top: 2.6rem;
    color: var(--muted);
    font-size: 0.88rem;
  }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>placement.sh</h1>
  <p class="lede">Buy publisher placements so a URL gets cited.</p>
  <p class="sub">An agent sets a budget. placement.sh books the campaign — bought editorial inventory, not earned media. Publisher domains stay hidden until a placement is delivered.</p>

  <h2>How to use it</h2>
  <ol>
    <li><strong>Add this MCP</strong> to Claude, ChatGPT, Grok, Kimi, Cursor, or any agent that speaks MCP.</li>
    <li><strong>Ask the agent to estimate</strong> — URL, topics, budget. No card required to look.</li>
    <li><strong>Claim a free listing</strong> to try it, or fund a campaign when you are ready. Paid placements are live and indexed at T+30, or refunded.</li>
  </ol>

  <h2>Add to your agent</h2>
  <div class="clients" role="group" aria-label="Add placement.sh to an agent">
    <button type="button" data-client="claude">Claude</button>
    <button type="button" data-client="chatgpt">ChatGPT</button>
    <button type="button" data-client="grok">Grok</button>
    <button type="button" data-client="kimi">Kimi</button>
    <a class="btn" data-client="cursor" href="${cursor}">Cursor</a>
  </div>

  <div class="urlrow">
    <code id="mcp-url">${mcpEsc}</code>
    <button type="button" id="copy-url">Copy URL</button>
  </div>

  <div class="panel" id="panel" aria-live="polite">
    <p class="muted">Pick an agent. We copy the MCP URL and show the steps — most clients paste it into Connectors.</p>
  </div>

  <footer>
    Streamable HTTP MCP · POST ${mcpEsc}<br>
    Agents: <a href="/llms.txt">/llms.txt</a>
    · <a href="/.well-known/mcp/server.json">server card</a>
  </footer>
</main>
<script>
(function () {
  var MCP = ${JSON.stringify(mcp)};
  var guides = {
    claude: {
      title: "Claude",
      open: "https://claude.ai/new#settings/customize-connectors",
      steps: [
        "URL copied. Claude → Customize → Connectors → Add custom connector.",
        "Paste the MCP URL. No OAuth needed for the public tools.",
        "Or in a terminal:"
      ],
      cmd: ${JSON.stringify(`claude mcp add --transport http placement ${mcp}`)}
    },
    chatgpt: {
      title: "ChatGPT",
      open: "https://chatgpt.com/#settings/Connectors",
      steps: [
        "URL copied. In ChatGPT: Settings → Apps → Advanced settings → turn on Developer mode.",
        "Create a custom connector named placement. Paste the MCP URL. Authentication: none.",
        "In a chat, enable the connector from the tools menu."
      ]
    },
    grok: {
      title: "Grok",
      open: "https://grok.com/manage-connectors",
      steps: [
        "URL copied. On grok.com open Connectors and add a custom connector with this URL.",
        "Or in a terminal:"
      ],
      cmd: ${JSON.stringify(`grok mcp add --transport http placement ${mcp}`)}
    },
    kimi: {
      title: "Kimi",
      open: "",
      steps: [
        "URL copied. Kimi’s web app does not take custom connectors — use Kimi Code or the CLI.",
        "In Kimi Code: /mcp-config → add by URL. Or:"
      ],
      cmd: ${JSON.stringify(`kimi mcp add --transport http placement ${mcp}`)}
    },
    cursor: {
      title: "Cursor",
      open: "",
      steps: [
        "If Cursor is installed, the button opens an install prompt.",
        "Otherwise add a remote server in Cursor Settings → MCP, URL:"
      ],
      cmd: MCP
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
    document.getElementById("panel").innerHTML = html;
  }
  document.querySelectorAll("[data-client]").forEach(function (el) {
    el.addEventListener("click", function () {
      var id = el.getAttribute("data-client");
      var g = guides[id];
      copy(MCP);
      render(id);
      if (g && g.open) window.open(g.open, "_blank", "noopener");
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

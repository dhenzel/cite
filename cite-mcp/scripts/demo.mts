// Plays the buyer agent against the Cite v0 MCP server, end to end:
// stats → search → inspect → estimate. Run from cite-mcp/: npm run demo
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'src', 'server.ts');

const client = new Client({ name: 'demo-agent', version: '0.0.1' });
await client.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', serverPath] }));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  console.log(`\n━━━ ${name}(${JSON.stringify(args)})`);
  console.log(text);
  return JSON.parse(text);
};

console.log('=== Cite v0 demo: an agent shops for fintech links, $4k budget ===');

await call('inventory_stats');

const search = await call('search_sites', {
  topics: ['finance', 'business', 'investing'],
  min_score: 60,
  max_price: 350,
  limit: 8,
});

// leak check: no domains/emails should appear anywhere in any response
const leakProbe = JSON.stringify(search);
if (/@|\.com|\.net|\.org/i.test(leakProbe.replace(/250k\+\/mo/g, ''))) {
  console.error('\n!!! POSSIBLE LEAK — inspect payload above');
} else {
  console.log('\n[leak check] no domains or emails in search payload ✓');
}

for (const site of (search.sites as { site_id: string }[]).slice(0, 2)) {
  await call('get_site', { site_id: site.site_id });
}

await call('estimate', { topics: ['finance', 'business'], budget: 4000, risk_tolerance: 'balanced' });

await client.close();
console.log('\n=== demo complete ===');

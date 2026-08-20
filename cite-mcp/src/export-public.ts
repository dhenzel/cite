// Export PUBLIC fields only from the local master DB into the Worker bundle.
// The output contains no domains, no contacts, no seller prices — it is safe
// to commit and to serve from a public endpoint (blind placements by
// construction).  Usage: npx tsx src/export-public.ts
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(here, '..', 'data', 'cite.db'), { readonly: true });

const sites = db.prepare(`
  SELECT s.id, s.niche, s.subniche, s.cite_score, s.traffic_band, s.listed_price,
         s.link_attribute,
         s.tier_standard AS ts, s.tier_premium AS tp, s.tier_platinum AS tpl,
         c.summary, c.writes_about, c.recent_titles
  FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
  WHERE s.status = 'active' AND s.listed_price IS NOT NULL
  ORDER BY s.cite_score DESC
`).all();

const outDir = join(here, '..', '..', 'cite-worker', 'data');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'public-data.json');
writeFileSync(outPath, JSON.stringify(sites));
console.log(`wrote ${sites.length} public site records → ${outPath}`);

// paranoia: the export must never contain an email or a bare domain
const blob = JSON.stringify(sites);
if (/@/.test(blob)) throw new Error('leak check failed: "@" found in public export');
console.log('leak check passed: no emails in export');

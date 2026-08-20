// Builds the site list the enrichment crawl and the Ahrefs refresh both read.
// Neither script talks to D1 itself, so without this the input was hand-made and
// nobody could reproduce "the ones still missing a profile".
//
//   npx tsx scripts/make-paid-sites.mts --pending enrich   # no site_content row yet
//   npx tsx scripts/make-paid-sites.mts --pending ahrefs   # no Ahrefs overview yet
//   npx tsx scripts/make-paid-sites.mts                    # every paid site
//
// Output is {id, domain, cite_score, niche}[], highest cite_score first, written
// to data/paid-sites.json. It holds publisher domains, so data/ stays gitignored.
//
// Needs an authenticated wrangler (`npx wrangler login`) with access to cite-v0.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const PENDING = flag('pending') ?? 'all';
const LIMIT = flag('limit') ? Number(flag('limit')) : undefined;
const OUT = resolve(flag('out') ?? 'data/paid-sites.json');
const DB = flag('db') ?? 'cite-v0';

if (!['all', 'enrich', 'ahrefs'].includes(PENDING)) {
  console.error(`--pending must be one of: all, enrich, ahrefs (got ${PENDING})`);
  process.exit(1);
}

const where = [`s.cost_type = 'paid'`, `s.domain IS NOT NULL`, `s.domain <> ''`];
let join = '';
if (PENDING === 'enrich') {
  // enrich_status is only set once 009 landed; a row with no status is still a
  // crawl that never produced a usable profile.
  join = `LEFT JOIN site_content c ON c.site_id = s.id`;
  where.push(`(c.site_id IS NULL OR c.enrich_status IS NULL OR c.enrich_status <> 'ok')`);
} else if (PENDING === 'ahrefs') {
  where.push(`s.ahrefs_organic_keywords IS NULL`);
}

const sql = [
  `SELECT s.id, s.domain, s.cite_score, s.niche FROM sites s`,
  join,
  `WHERE ${where.join(' AND ')}`,
  `ORDER BY s.cite_score DESC`,
  LIMIT ? `LIMIT ${Math.max(1, Math.trunc(LIMIT))}` : '',
].filter(Boolean).join(' ');

console.log(sql);

function runQuery(): string {
  try {
    return execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (e: any) {
    console.error('wrangler d1 execute failed — run `npx wrangler login` first.');
    console.error(String(e?.stderr || e?.message || e).slice(0, 2000));
    process.exit(1);
  }
}

const raw = runQuery();

// wrangler prints a banner before the JSON payload on some versions.
const start = raw.indexOf('[');
const parsed = JSON.parse(start > 0 ? raw.slice(start) : raw);
const rows = (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? [];
if (!Array.isArray(rows) || rows.length === 0) {
  console.error('query returned no rows — nothing written');
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(rows, null, 0));
console.log(`wrote ${rows.length} sites to ${OUT} (pending=${PENDING})`);

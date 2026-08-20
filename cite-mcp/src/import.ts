// CSV → SQLite import. Reads the Shortlist publisher sheet export from
// data/inventory.csv and builds data/cite.db. Never commit either file.
import Database from 'better-sqlite3';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { citeScore, listedPrice, trafficBand } from './score.js';
import { mintHandle, newSalt } from './anonymize.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const csvPath = join(dataDir, 'inventory.csv');
const dbPath = join(dataDir, 'cite.db');
const saltPath = join(dataDir, 'handle.salt');

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = (s: string | undefined): number | null => {
  const v = parseFloat((s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(v) ? v : null;
};
const yes = (s: string | undefined): number => ((s ?? '').trim().toLowerCase() === 'yes' ? 1 : 0);

const rows = parseCsv(readFileSync(csvPath, 'utf8'));
const header = rows[0].map((h) => h.replace(/\s+/g, ' ').trim());
const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
const C = {
  niche: col('Niche'), subniche: col('Subniche'), website: col('Website'),
  name: col('Name'), email: col('Email To'), poc: col('Point Of Contact'),
  note: col('Note'), rate: col('Rate'),
  std: col('Standard'), prem: col('Premium'), plat: col('Platinum'),
  tf: col('TrustFlow'), cf: col('CitationFlow'), da: col('DA'),
  spam: col('Spam Score'), traffic: col('Organic Traffic (Ahrefs)'),
  dr: col('DR (Ahrefs)'), updated: col('Updated'),
};

const salt = existsSync(saltPath) ? readFileSync(saltPath, 'utf8') : newSalt();
writeFileSync(saltPath, salt);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

const insert = db.prepare(`
  INSERT OR IGNORE INTO sites (
    id, domain, contact_name, contact_email, point_of_contact, note,
    niche, subniche, seller_price, listed_price,
    tier_standard, tier_premium, tier_platinum,
    da, dr, tf, cf, spam, traffic, traffic_band, cite_score,
    metrics_updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

let imported = 0, skipped = 0;
db.transaction(() => {
  for (const r of rows.slice(1)) {
    const domain = (r[C.website] ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain || !domain.includes('.')) { skipped++; continue; }
    const seller = num(r[C.rate]);
    const metrics = {
      dr: num(r[C.dr]), da: num(r[C.da]), traffic: num(r[C.traffic]),
      tf: num(r[C.tf]), cf: num(r[C.cf]), spam: num(r[C.spam]),
    };
    const res = insert.run(
      mintHandle(domain, salt), domain,
      (r[C.name] ?? '').trim() || null, (r[C.email] ?? '').trim() || null,
      (r[C.poc] ?? '').trim() || null, (r[C.note] ?? '').trim() || null,
      (r[C.niche] ?? '').trim() || null, (r[C.subniche] ?? '').trim() || null,
      seller, seller && seller > 0 ? listedPrice(seller) : null,
      yes(r[C.std]), yes(r[C.prem]), yes(r[C.plat]),
      metrics.da, metrics.dr, metrics.tf, metrics.cf, metrics.spam,
      metrics.traffic, trafficBand(metrics.traffic), citeScore(metrics),
      (r[C.updated] ?? '').trim() || null,
    );
    if (res.changes > 0) imported++; else skipped++;
  }
})();

const stats = db.prepare(`
  SELECT COUNT(*) AS n,
         SUM(CASE WHEN listed_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
         ROUND(AVG(cite_score),1) AS avg_score
  FROM sites
`).get() as { n: number; priced: number; avg_score: number };
console.log(`imported ${imported} sites (${skipped} skipped/dupes) → ${dbPath}`);
console.log(`total ${stats.n}, priced ${stats.priced}, avg cite_score ${stats.avg_score}`);

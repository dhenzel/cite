// Generate the FULL D1 seed (private fields included) from the local master
// DB: data/seed.sql. Contains publisher domains, contacts, seller prices —
// NEVER commit it (data/ is gitignored). Load into D1 with:
//   npx wrangler d1 execute cite-v0 --remote --file=seed.sql
import Database from 'better-sqlite3';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(here, '..', 'data', 'cite.db'), { readonly: true });

const q = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

const DEFAULT_MARKUP = 1.6;
const sites = db.prepare(`SELECT * FROM sites`).all() as Record<string, unknown>[];
const content = db.prepare(`SELECT * FROM site_content`).all() as Record<string, unknown>[];

const lines: string[] = [];
lines.push(readFileSync(join(here, '..', '..', 'cite-worker', 'schema.sql'), 'utf8'));

const BATCH = 250;
for (let i = 0; i < sites.length; i += BATCH) {
  const vals = sites.slice(i, i + BATCH).map((s) => `(${[
    q(s.id), q(s.domain), q(s.contact_name), q(s.contact_email), q(s.point_of_contact), q(s.note),
    q(s.niche), q(s.subniche), q(s.seller_price), DEFAULT_MARKUP, q(s.listed_price),
    q(s.tier_standard), q(s.tier_premium), q(s.tier_platinum),
    q(s.da), q(s.dr), q(s.tf), q(s.cf), q(s.spam), q(s.traffic), q(s.traffic_band), q(s.cite_score),
    q(s.link_attribute ?? 'unknown'), q(s.max_links_per_post), q(s.turnaround_sla_days),
    q(s.status ?? 'active'), q(s.metrics_updated_at), `datetime('now')`,
  ].join(',')})`);
  lines.push(`INSERT INTO sites (id,domain,contact_name,contact_email,point_of_contact,note,niche,subniche,seller_price,markup,listed_price,tier_standard,tier_premium,tier_platinum,da,dr,tf,cf,spam,traffic,traffic_band,cite_score,link_attribute,max_links_per_post,turnaround_sla_days,status,metrics_updated_at,updated_at) VALUES\n${vals.join(',\n')};`);
}
for (let i = 0; i < content.length; i += BATCH) {
  const vals = content.slice(i, i + BATCH).map((c) => `(${[
    q(c.site_id), q(c.summary), q(c.writes_about), q(c.recent_titles), q(c.enriched_at), q(c.source),
  ].join(',')})`);
  lines.push(`INSERT INTO site_content (site_id,summary,writes_about,recent_titles,enriched_at,source) VALUES\n${vals.join(',\n')};`);
}

const out = join(here, '..', 'data', 'seed.sql');
writeFileSync(out, lines.join('\n\n'));
console.log(`wrote ${sites.length} sites + ${content.length} content rows → ${out}`);

// Operator-only seed: curated self-serve platforms (Medium, Substack, …).
// Public MCP no longer sells these (2026-08-18 — paid inventory only).
// Do not re-run against production unless operators explicitly want the
// rows in D1 for console review. Buyer tools ignore cost_type=free.
//
// Usage: npx tsx src/seed-free-platforms.ts [--sql]
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface Platform {
  domain: string;
  niche: string;
  subniche?: string;
  link_attribute: 'nofollow' | 'ugc' | 'dofollow' | 'unknown';
  max_links_per_post: number;
  turnaround_sla_days: number;
  agent_instructions: string;
}

export const FREE_PLATFORMS: Platform[] = [
  { domain: 'medium.com', niche: 'Multiple', link_attribute: 'nofollow', max_links_per_post: 3, turnaround_sla_days: 1,
    agent_instructions: 'Register a free account, publish the article directly. Links are nofollow. Heavily cited by AI answer engines. Avoid thin promotional posts — Medium removes them.' },
  { domain: 'dev.to', niche: 'Tech', subniche: 'Software Development', link_attribute: 'nofollow', max_links_per_post: 3, turnaround_sla_days: 1,
    agent_instructions: 'Free account, publish immediately in Markdown. Technical audience — code and specifics required, marketing copy gets downvoted. Strong AI-citation surface for dev topics.' },
  { domain: 'hashnode.com', niche: 'Tech', subniche: 'Software Development', link_attribute: 'dofollow', max_links_per_post: 3, turnaround_sla_days: 1,
    agent_instructions: 'Free account and personal blog; canonical URL supported. Notably offers dofollow links on some plans — verify per post.' },
  { domain: 'substack.com', niche: 'Multiple', link_attribute: 'dofollow', max_links_per_post: 3, turnaround_sla_days: 1,
    agent_instructions: 'Free newsletter/publication; posts are indexed on a subdomain. Own-subdomain authority, so treat as brand asset rather than third-party citation.' },
  { domain: 'vocal.media', niche: 'Lifestyle', link_attribute: 'nofollow', max_links_per_post: 2, turnaround_sla_days: 2,
    agent_instructions: 'Free account; submissions pass light moderation before going live. Links are nofollow.' },
  { domain: 'hackernoon.com', niche: 'Tech', link_attribute: 'nofollow', max_links_per_post: 2, turnaround_sla_days: 5,
    agent_instructions: 'Free submission, but editorial review before publishing — expect several days and possible rejection. Paid placement also available via Cite.' },
  { domain: 'newsbreak.com', niche: 'News', link_attribute: 'nofollow', max_links_per_post: 2, turnaround_sla_days: 2,
    agent_instructions: 'Free creator account; local/news framing performs best. Nofollow.' },
  { domain: 'quora.com', niche: 'Multiple', link_attribute: 'nofollow', max_links_per_post: 1, turnaround_sla_days: 1,
    agent_instructions: 'Answer an existing relevant question — do not post standalone promotion. One contextual link. Nofollow, but frequently surfaced in AI answers.' },
  { domain: 'reddit.com', niche: 'Multiple', link_attribute: 'nofollow', max_links_per_post: 1, turnaround_sla_days: 1,
    agent_instructions: 'CAUTION: subreddit rules vary and most ban self-promotion; an unsuited post gets removed and the account banned. Only use where the subreddit explicitly allows it. Nofollow, heavily cited by AI engines.' },
  { domain: 'linkedin.com', niche: 'Business', subniche: 'Professional', link_attribute: 'nofollow', max_links_per_post: 2, turnaround_sla_days: 1,
    agent_instructions: 'Publish as a LinkedIn article from a real profile. Nofollow. Value is distribution and B2B credibility, not link equity.' },
  { domain: 'indiehackers.com', niche: 'Business', subniche: 'Startups', link_attribute: 'nofollow', max_links_per_post: 2, turnaround_sla_days: 1,
    agent_instructions: 'Free account; post in a relevant group. Founder audience expects a real story with numbers, not a pitch.' },
  { domain: 'tumblr.com', niche: 'Lifestyle', link_attribute: 'nofollow', max_links_per_post: 3, turnaround_sla_days: 1,
    agent_instructions: 'Free blog on a subdomain. Low authority value; useful for brand-mention breadth only.' },
  { domain: 'write.as', niche: 'Multiple', link_attribute: 'nofollow', max_links_per_post: 2, turnaround_sla_days: 1,
    agent_instructions: 'Anonymous free publishing, no account strictly required. Minimal authority — use for breadth, not equity.' },
  { domain: 'telegra.ph', niche: 'Multiple', link_attribute: 'nofollow', max_links_per_post: 2, turnaround_sla_days: 1,
    agent_instructions: 'Instant publish, no account. Very low authority and often ignored by search engines — lowest tier of the free set.' },
  { domain: 'blogger.com', niche: 'Multiple', link_attribute: 'nofollow', max_links_per_post: 3, turnaround_sla_days: 1,
    agent_instructions: 'Free Google-hosted blog on a subdomain. Own-property asset rather than third-party citation.' },
  { domain: 'wordpress.com', niche: 'Multiple', link_attribute: 'nofollow', max_links_per_post: 3, turnaround_sla_days: 1,
    agent_instructions: 'Free hosted blog on a subdomain. Own-property asset; free plan shows ads.' },
  { domain: 'minds.com', niche: 'Multiple', link_attribute: 'nofollow', max_links_per_post: 2, turnaround_sla_days: 1,
    agent_instructions: 'Free account, immediate publishing, minimal moderation. Low authority.' },
  { domain: 'steemit.com', niche: 'Crypto', link_attribute: 'nofollow', max_links_per_post: 2, turnaround_sla_days: 1,
    agent_instructions: 'Free blockchain-based blogging; crypto-leaning audience. Nofollow.' },
  { domain: 'publish0x.com', niche: 'Crypto', link_attribute: 'nofollow', max_links_per_post: 2, turnaround_sla_days: 3,
    agent_instructions: 'Free submission with review; crypto/tech topics. Paid placement also available via Cite.' },
  { domain: 'producthunt.com', niche: 'Tech', subniche: 'Startups', link_attribute: 'dofollow', max_links_per_post: 1, turnaround_sla_days: 1,
    agent_instructions: 'Product launch listing, not an article. One dofollow link to the product site. Single-use per product — not repeatable inventory.' },
];

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const db = new Database(join(dataDir, 'cite.db'));
const salt = readFileSync(join(dataDir, 'handle.salt'), 'utf8');
const mint = (domain: string) => `cs_${createHash('sha256').update(salt + domain).digest('hex').slice(0, 12)}`;

// Keep the local schema in step with the worker's (cite-worker/schema.sql).
for (const col of [
  'agent_instructions TEXT',
  'markup REAL DEFAULT 1.6',
  "acquisition_mode TEXT DEFAULT 'paid_placement'",
  "cost_type TEXT DEFAULT 'paid'",
  'requires_reciprocal_link INTEGER DEFAULT 0',
  'updated_at TEXT',
]) {
  try { db.exec(`ALTER TABLE sites ADD COLUMN ${col}`); } catch { /* already there */ }
}

const upsert = db.prepare(`
  INSERT INTO sites (id, domain, niche, subniche, seller_price, markup, listed_price,
                     link_attribute, max_links_per_post, turnaround_sla_days,
                     acquisition_mode, cost_type, requires_reciprocal_link,
                     status, agent_instructions, updated_at)
  VALUES (?,?,?,?,0,1.6,0,?,?,?, 'self_serve','free',0, 'active', ?, datetime('now'))
  ON CONFLICT(domain) DO UPDATE SET
    acquisition_mode='self_serve', cost_type='free', seller_price=0, listed_price=0,
    link_attribute=excluded.link_attribute,
    max_links_per_post=excluded.max_links_per_post,
    turnaround_sla_days=excluded.turnaround_sla_days,
    agent_instructions=excluded.agent_instructions,
    niche=COALESCE(sites.niche, excluded.niche),
    updated_at=datetime('now')
`);

let added = 0;
db.transaction(() => {
  for (const p of FREE_PLATFORMS) {
    upsert.run(mint(p.domain), p.domain, p.niche, p.subniche ?? null,
      p.link_attribute, p.max_links_per_post, p.turnaround_sla_days, p.agent_instructions);
    added++;
  }
})();
console.log(`upserted ${added} free self-serve platforms`);
console.table(db.prepare(`
  SELECT acquisition_mode, cost_type, COUNT(*) AS sites FROM sites GROUP BY 1,2 ORDER BY sites DESC
`).all());

if (process.argv.includes('--sql')) {
  const q = (v: unknown) => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  const rows = FREE_PLATFORMS.map((p) => `(${[
    q(mint(p.domain)), q(p.domain), q(p.niche), q(p.subniche ?? null), 0, 1.6, 0,
    q(p.link_attribute), p.max_links_per_post, p.turnaround_sla_days,
    q('self_serve'), q('free'), 0, q('active'), q(p.agent_instructions), `datetime('now')`,
  ].join(',')})`).join(',\n');
  // Upsert, NOT "INSERT OR REPLACE": four of these platforms are already in the
  // database with real Ahrefs metrics, and REPLACE would delete those columns.
  const sql = `INSERT INTO sites (id,domain,niche,subniche,seller_price,markup,listed_price,link_attribute,max_links_per_post,turnaround_sla_days,acquisition_mode,cost_type,requires_reciprocal_link,status,agent_instructions,updated_at) VALUES\n${rows}\n`
    + `ON CONFLICT(domain) DO UPDATE SET\n`
    + `  acquisition_mode='self_serve', cost_type='free', seller_price=0, listed_price=0,\n`
    + `  link_attribute=excluded.link_attribute,\n`
    + `  max_links_per_post=excluded.max_links_per_post,\n`
    + `  turnaround_sla_days=excluded.turnaround_sla_days,\n`
    + `  agent_instructions=excluded.agent_instructions,\n`
    + `  niche=COALESCE(sites.niche, excluded.niche),\n`
    + `  updated_at=datetime('now');`;
  writeFileSync(join(dataDir, 'free-platforms.sql'), sql);
  console.log(`\nwrote D1 insert → ${join(dataDir, 'free-platforms.sql')}`);
}

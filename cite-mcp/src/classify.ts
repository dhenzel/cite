// Classify how each site is acquired — paid, free self-serve, free editorial
// application, reciprocal link exchange, or unavailable (SPEC §3). Free sites
// are the trial hook (§17): an agent can use them without a card, so knowing
// WHICH kind of free a site is decides what the agent must actually do.
//
// Usage: npx tsx src/classify.ts            (updates local data/cite.db)
//        npx tsx src/classify.ts --sql      (emit UPDATE statements for D1)
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type AcquisitionMode =
  | 'paid_placement' | 'self_serve' | 'apply_editorial' | 'link_exchange' | 'unavailable';

const RE = {
  selfServe: /profile|account|self.?serve|self.?publish/i,
  editorial: /apply via form|forms|guidelines|send (a )?(whole )?article|send outline|contributor/i,
  exchange: /exchange|link swap|reciprocal/i,
  // "not available" means the site isn't taking placements. But "not available
  // FROM <person>" means that contact can't supply it — the site is fine. Must
  // not conflate: it would have hidden marketwatch.com (DR 91) from search.
  dead: /not accepting|no longer accept|(?<!\S )not available(?!\s+(from|via|through)\b)|^n\/a\b/i,
};

// Platforms where anyone (including an agent) can register and publish without
// an editor. Exact domain match — substring matching produced false positives
// like ubiminds.com → minds.com.
export const KNOWN_SELF_SERVE = new Set([
  'medium.com', 'dev.to', 'vocal.media', 'hackernoon.com', 'substack.com',
  'hashnode.com', 'hashnode.dev', 'bloglovin.com', 'newsbreak.com', 'tumblr.com',
  'blogger.com', 'wordpress.com', 'write.as', 'telegra.ph', 'publish0x.com',
  'steemit.com', 'minds.com', 'quora.com', 'reddit.com', 'linkedin.com',
  'indiehackers.com', 'producthunt.com', 'notion.site', 'ghost.io',
]);

export interface ClassifyInput {
  domain?: string | null;
  seller_price: number | null;
  note: string | null;
  status?: string | null;
}

export function classify(s: ClassifyInput): {
  acquisition_mode: AcquisitionMode;
  cost_type: 'paid' | 'free';
  requires_reciprocal_link: 0 | 1;
} {
  const note = s.note ?? '';
  const free = s.seller_price === 0;
  const domain = (s.domain ?? '').toLowerCase().replace(/^www\./, '');

  // A known self-serve platform is self-serve regardless of what the note says
  // — unless the note marks it dead or we're paying for placement there
  // (hackernoon.com is a free platform Shortlist happens to buy on).
  if (KNOWN_SELF_SERVE.has(domain) && !RE.dead.test(note) && (free || s.seller_price === null)) {
    return { acquisition_mode: 'self_serve', cost_type: 'free', requires_reciprocal_link: 0 };
  }

  // Reciprocal-link deals are free in cash but cost a link from the buyer's own
  // site — never silently mixed into inventory. Parked per David, 2026-08-17.
  if (RE.exchange.test(note)) {
    return { acquisition_mode: 'link_exchange', cost_type: 'free', requires_reciprocal_link: 1 };
  }
  if (RE.dead.test(note)) {
    return { acquisition_mode: 'unavailable', cost_type: free ? 'free' : 'paid', requires_reciprocal_link: 0 };
  }
  if (free) {
    if (RE.selfServe.test(note)) {
      return { acquisition_mode: 'self_serve', cost_type: 'free', requires_reciprocal_link: 0 };
    }
    // Conservative default for unexplained $0 rows: treat as editorial
    // application (needs a pitch), not self-serve. Console review flag.
    return { acquisition_mode: 'apply_editorial', cost_type: 'free', requires_reciprocal_link: 0 };
  }
  return { acquisition_mode: 'paid_placement', cost_type: 'paid', requires_reciprocal_link: 0 };
}

// ---- CLI ----
if (process.argv[1] && process.argv[1].endsWith('classify.ts')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const db = new Database(join(here, '..', 'data', 'cite.db'));
  const emitSql = process.argv.includes('--sql');

  for (const col of [
    "acquisition_mode TEXT DEFAULT 'paid_placement'",
    "cost_type TEXT DEFAULT 'paid'",
    'requires_reciprocal_link INTEGER DEFAULT 0',
  ]) {
    try { db.exec(`ALTER TABLE sites ADD COLUMN ${col}`); } catch { /* already there */ }
  }

  const rows = db.prepare('SELECT id, domain, seller_price, note FROM sites').all() as
    ({ id: string } & ClassifyInput)[];
  const upd = db.prepare(
    'UPDATE sites SET acquisition_mode=?, cost_type=?, requires_reciprocal_link=? WHERE id=?',
  );
  const groups = new Map<string, string[]>();
  db.transaction(() => {
    for (const r of rows) {
      const c = classify(r);
      upd.run(c.acquisition_mode, c.cost_type, c.requires_reciprocal_link, r.id);
      const k = `${c.acquisition_mode}|${c.cost_type}|${c.requires_reciprocal_link}`;
      const g = groups.get(k) ?? [];
      g.push(r.id);
      groups.set(k, g);
    }
  })();

  console.table(
    [...groups.entries()].map(([k, ids]) => {
      const [mode, cost, recip] = k.split('|');
      return { acquisition_mode: mode, cost_type: cost, reciprocal: recip === '1', sites: ids.length };
    }).sort((a, b) => b.sites - a.sites),
  );

  if (emitSql) {
    // Batched UPDATEs for the live D1 (applied via the Cloudflare MCP).
    const out: string[] = [];
    for (const [k, ids] of groups) {
      const [mode, cost, recip] = k.split('|');
      if (mode === 'paid_placement' && cost === 'paid' && recip === '0') continue; // column defaults
      for (let i = 0; i < ids.length; i += 400) {
        const batch = ids.slice(i, i + 400).map((id) => `'${id}'`).join(',');
        out.push(`UPDATE sites SET acquisition_mode='${mode}', cost_type='${cost}', requires_reciprocal_link=${recip} WHERE id IN (${batch});`);
      }
    }
    const path = join(here, '..', 'data', 'classify.sql');
    (await import('node:fs')).writeFileSync(path, out.join('\n'));
    console.log(`\nwrote ${out.length} UPDATE statements → ${path}`);
  }
}

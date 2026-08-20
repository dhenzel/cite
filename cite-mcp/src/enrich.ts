// Content enrichment: fetch each site's homepage (+ RSS feed if present),
// extract what it currently writes about, and store an ANONYMIZED summary in
// site_content. Run where outbound HTTP is open (not in a restricted sandbox):
//   npx tsx src/enrich.ts [--limit 100] [--niche Business]
//
// The summary is scrubbed (anonymize.scrub) so it can't defeat blind
// placements: no domain, no brand tokens.
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scrub } from './anonymize.js';

const here = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(here, '..', 'data', 'cite.db'));

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = parseInt(flag('limit') ?? '50', 10);
const niche = flag('niche');

const UA = 'Mozilla/5.0 (compatible; research fetch)';
const TIMEOUT = 12_000;

async function get(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

const strip = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
const text1 = (html: string, re: RegExp): string | null => {
  const m = strip(html).match(re);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
};

function extractTitles(html: string): string[] {
  const out = new Set<string>();
  const s = strip(html);
  // headline-ish anchors and h2/h3 text
  for (const m of s.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    const t = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (t.length > 25 && t.length < 120) out.add(t);
    if (out.size >= 12) break;
  }
  return [...out];
}

function extractRssTitles(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t.length > 20 && t.length < 140) out.push(t);
    if (out.length >= 12) break;
  }
  return out.slice(1); // first <title> is the channel name
}

function topicsFrom(titles: string[], metaDesc: string | null): string[] {
  const textBlob = (titles.join(' ') + ' ' + (metaDesc ?? '')).toLowerCase();
  const stop = new Set('the a an and or for with your you how what why best top guide tips from this that are is to of in on it its can new all more get make need know 2024 2025 2026 will should about into after before every'.split(' '));
  const counts = new Map<string, number>();
  for (const w of textBlob.match(/[a-z]{4,}/g) ?? []) {
    if (stop.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
}

const rows = db.prepare(`
  SELECT s.id, s.domain FROM sites s
  LEFT JOIN site_content c ON c.site_id = s.id
  WHERE c.site_id IS NULL AND s.status = 'active' AND s.listed_price IS NOT NULL
  ${niche ? 'AND s.niche = ?' : ''}
  ORDER BY s.cite_score DESC LIMIT ?
`).all(...(niche ? [niche, limit] : [limit])) as { id: string; domain: string }[];

const upsert = db.prepare(`
  INSERT INTO site_content (site_id, summary, writes_about, recent_titles, enriched_at, source)
  VALUES (?, ?, ?, ?, datetime('now'), 'crawl')
  ON CONFLICT(site_id) DO UPDATE SET summary=excluded.summary,
    writes_about=excluded.writes_about, recent_titles=excluded.recent_titles,
    enriched_at=excluded.enriched_at, source=excluded.source
`);

let done = 0, failed = 0;
for (const site of rows) {
  const home = await get(`https://${site.domain}/`);
  if (!home) { failed++; continue; }
  const title = text1(home, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDesc = text1(home, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    ?? text1(home, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  let titles = extractTitles(home);
  const rssHref = text1(home, /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/i);
  if (rssHref) {
    const feedUrl = rssHref.startsWith('http') ? rssHref : `https://${site.domain}${rssHref.startsWith('/') ? '' : '/'}${rssHref}`;
    const feed = await get(feedUrl);
    if (feed) titles = [...new Set([...extractRssTitles(feed), ...titles])].slice(0, 12);
  }
  const summaryRaw = [
    metaDesc ?? title ?? '',
    titles.length ? `Recent coverage: ${titles.slice(0, 4).join(' · ')}` : '',
  ].filter(Boolean).join(' — ');
  const summary = scrub(summaryRaw, site.domain).slice(0, 600);
  const topics = topicsFrom(titles, metaDesc);
  upsert.run(site.id, summary || null, JSON.stringify(topics), JSON.stringify(titles.map((t) => scrub(t, site.domain))));
  done++;
  if (done % 10 === 0) console.log(`enriched ${done}/${rows.length}…`);
}
console.log(`enriched ${done}, failed ${failed} of ${rows.length} candidates`);

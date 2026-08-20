#!/usr/bin/env npx tsx
// Crawl-first publisher enrichment. Optional Grok pass when XAI_API_KEY is set.
// Does not run inside the public Worker. Writes JSONL (gitignored).
//
//   npx tsx scripts/enrich-content.mts --sites data/paid-sites.json --out data/enrich.jsonl
//   npx tsx scripts/enrich-content.mts --sites data/paid-sites.json --out data/enrich.jsonl --llm
//
// Highest cite_score first. Skips site_ids already ok in --out unless --force.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import {
  ENRICH_PROMPT_V1,
  crawlSummary,
  extractPage,
  extractRssTitles,
  leaksDomain,
  parseLlmProfile,
  parseRobots,
  pathDisallowed,
  resolveUrl,
  scrub,
  topicsFrom,
  type LlmProfile,
} from '../src/enrich-extract.js';

type Site = { id: string; domain: string; cite_score?: number; niche?: string | null };

export type EnrichRow = {
  site_id: string;
  domain: string;
  cite_score: number | null;
  niche: string | null;
  summary: string | null;
  writes_about: string[];
  recent_titles: string[];
  audience: string | null;
  tone: string | null;
  post_shape: string | null;
  typical_length_words: number | null;
  do_fit: string | null;
  dont_fit: string | null;
  summary_private: string | null;
  enrich_status: 'ok' | 'fetch_failed' | 'llm_failed' | 'robots_blocked';
  source: 'crawl-v1' | 'crawl+grok-v1';
  enriched_at: string;
  error?: string;
};

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const UA = 'PlacementBot/1.0 (+https://placement.sh)';
const TIMEOUT = 10_000;
const CONCURRENCY = Math.max(1, Math.min(12, Number(flag('concurrency') ?? 6)));
const LIMIT = flag('limit') ? Number(flag('limit')) : Infinity;
const OFFSET = Number(flag('offset') ?? 0);
const USE_LLM = has('llm');
const FORCE = has('force');
const XAI_KEY = process.env.XAI_API_KEY ?? '';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4-fast';

async function get(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch {
    return null;
  }
}

async function loadDone(outPath: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (!existsSync(outPath)) return done;
  const rl = createInterface({ input: createReadStream(outPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as EnrichRow;
      if (row.site_id && (FORCE ? false : row.enrich_status === 'ok')) done.add(row.site_id);
    } catch { /* skip bad line */ }
  }
  return done;
}

async function grokProfile(extract: string, domain: string): Promise<LlmProfile | null> {
  if (!XAI_KEY) return null;
  const call = async () => {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${XAI_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: XAI_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: ENRICH_PROMPT_V1 },
          { role: 'user', content: extract.slice(0, 12_000) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? null;
  };
  const first = await call();
  if (!first) return null;
  let profile = parseLlmProfile(first, domain);
  if (profile) return profile;
  const retry = await call();
  return retry ? parseLlmProfile(retry, domain) : null;
}

export async function enrichSite(site: Site): Promise<EnrichRow> {
  const now = new Date().toISOString();
  const base = (partial: Partial<EnrichRow>): EnrichRow => ({
    site_id: site.id,
    domain: site.domain,
    cite_score: typeof site.cite_score === 'number' ? site.cite_score : null,
    niche: site.niche ?? null,
    summary: null,
    writes_about: [],
    recent_titles: [],
    audience: null,
    tone: null,
    post_shape: null,
    typical_length_words: null,
    do_fit: null,
    dont_fit: null,
    summary_private: null,
    enrich_status: 'fetch_failed',
    source: USE_LLM && XAI_KEY ? 'crawl+grok-v1' : 'crawl-v1',
    enriched_at: now,
    ...partial,
  });

  const robots = await get(`https://${site.domain}/robots.txt`);
  if (robots && robots.status === 200 && /user-agent/i.test(robots.text)) {
    const rules = parseRobots(robots.text);
    if (pathDisallowed('/', rules.disallow)) {
      return base({ enrich_status: 'robots_blocked', error: 'robots Disallow: /' });
    }
  }

  let home = await get(`https://${site.domain}/`);
  if (!home || home.status >= 400) home = await get(`http://${site.domain}/`);
  if (!home || home.status >= 400 || home.text.length < 40) {
    return base({ enrich_status: 'fetch_failed', error: home ? `HTTP ${home.status}` : 'timeout' });
  }

  const page = extractPage(home.text, site.domain);
  let titles = page.titles;
  const feedCandidates = [
    page.feedUrl,
    resolveUrl('/feed', site.domain),
    resolveUrl('/rss.xml', site.domain),
    resolveUrl('/atom.xml', site.domain),
  ].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);

  for (const feedUrl of feedCandidates.slice(0, page.feedUrl ? 1 : 2)) {
    const feed = await get(feedUrl);
    if (feed && feed.status < 400 && /<item|<entry/i.test(feed.text)) {
      titles = [...new Set([...extractRssTitles(feed.text), ...titles])].slice(0, 12);
      break;
    }
  }

  const scrubbedTitles = titles
    .map((t) => scrub(t, site.domain).replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 12 && !leaksDomain(t, site.domain))
    .slice(0, 8);
  const topics = topicsFrom(titles, page.metaDesc, page.visible.slice(0, 1500))
    .map((t) => scrub(t, site.domain))
    .filter((t) => !leaksDomain(t, site.domain))
    .slice(0, 12);
  const summary = crawlSummary({ domain: site.domain, title: page.title, metaDesc: page.metaDesc, titles: scrubbedTitles });
  const privateNote = [page.metaDesc ?? page.title ?? '', titles.slice(0, 6).join(' · ')].filter(Boolean).join(' — ').slice(0, 900);

  let row = base({
    summary: summary || null,
    writes_about: topics,
    recent_titles: scrubbedTitles,
    summary_private: privateNote || null,
    enrich_status: 'ok',
    source: 'crawl-v1',
  });

  if (USE_LLM && XAI_KEY) {
    const extract = [
      `domain: ${site.domain}`,
      page.title ? `title: ${page.title}` : '',
      page.metaDesc ? `description: ${page.metaDesc}` : '',
      titles.length ? `headlines:\n- ${titles.slice(0, 12).join('\n- ')}` : '',
      page.visible ? `visible:\n${page.visible}` : '',
    ].filter(Boolean).join('\n\n');
    const profile = await grokProfile(extract, site.domain);
    if (!profile) {
      row.enrich_status = row.summary ? 'ok' : 'llm_failed';
      row.error = 'llm_failed';
      row.source = 'crawl-v1';
      return row;
    }
    row = {
      ...row,
      summary: profile.summary_public,
      writes_about: profile.topics,
      audience: profile.audience || null,
      tone: profile.tone || null,
      post_shape: profile.post_shape || null,
      typical_length_words: profile.typical_length_words,
      do_fit: profile.do || null,
      dont_fit: profile.dont || null,
      summary_private: profile.summary_private || privateNote,
      enrich_status: 'ok',
      source: 'crawl+grok-v1',
      error: undefined,
    };
  }
  return row;
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>, onEach: (r: R, i: number) => void): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      const r = await fn(items[idx]);
      onEach(r, idx);
    }
  });
  await Promise.all(workers);
}

function loadSites(path: string): Site[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Site[] | { results?: Site[] };
  const rows = Array.isArray(raw) ? raw : raw.results ?? [];
  return rows.map((r) => ({
    id: String((r as Site & { id?: string }).id),
    domain: String((r as Site).domain),
    cite_score: typeof (r as Site).cite_score === 'number' ? (r as Site).cite_score : undefined,
    niche: (r as Site).niche ?? null,
  })).filter((s) => s.id && s.domain);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('enrich-content.mts');
if (isMain && !has('no-run')) {
  const sitesPath = resolve(flag('sites') ?? 'data/paid-sites.json');
  const outPath = resolve(flag('out') ?? 'data/enrich.jsonl');
  if (!existsSync(sitesPath)) {
    console.error(`missing --sites ${sitesPath}`);
    process.exit(1);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const done = await loadDone(outPath);
  const sites = loadSites(sitesPath)
    .sort((a, b) => (b.cite_score ?? 0) - (a.cite_score ?? 0))
    .slice(OFFSET, Number.isFinite(LIMIT) ? OFFSET + LIMIT : undefined)
    .filter((s) => !done.has(s.id));
  if (USE_LLM && !XAI_KEY) {
    console.warn('`--llm` set but XAI_API_KEY is empty — crawl-only');
  }
  console.log(`enrich ${sites.length} sites (skip ${done.size} already ok), concurrency ${CONCURRENCY}${USE_LLM && XAI_KEY ? ', grok' : ', crawl-only'}`);
  const out = createWriteStream(outPath, { flags: 'a' });
  let ok = 0, failed = 0, blocked = 0;
  await pool(sites, CONCURRENCY, enrichSite, (row) => {
    out.write(`${JSON.stringify(row)}\n`);
    if (row.enrich_status === 'ok') ok++;
    else if (row.enrich_status === 'robots_blocked') blocked++;
    else failed++;
    const n = ok + failed + blocked;
    if (n % 25 === 0 || n === sites.length) {
      console.log(`progress ${n}/${sites.length} ok=${ok} failed=${failed} robots=${blocked} last=${row.domain} ${row.enrich_status}`);
    }
  });
  out.end();
  console.log(`done ok=${ok} failed=${failed} robots=${blocked}`);
}

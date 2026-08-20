// Crawl extractors + brand scrub for publisher enrichment.
// Public buyer text must never contain the domain or registered-name tokens.
// The raw extract (brand OK) is only for the optional LLM call and operator notes.

export const ENRICH_PROMPT_V1 = `You profile a publisher for a blind paid-placement marketplace.
The extracted page text still contains the brand — this call is internal.
Return ONLY JSON (no markdown) with this shape:
{
  "audience": "who reads this, one sentence",
  "topics": ["5–12 topics they actually cover, not a generic sheet niche"],
  "tone": "e.g. practitioner / consumer / affiliate-review",
  "typical_length_words": 900,
  "post_shape": "how-to | listicle | opinion | news | review",
  "do": "what a guest post must include to fit",
  "dont": "angles they clearly don’t run",
  "summary_private": "120–180 words, brand names OK",
  "summary_public": "80–120 words, no brand, no domain, no author names — as if describing a nameless publisher"
}`;

export type LlmProfile = {
  audience: string;
  topics: string[];
  tone: string;
  typical_length_words: number | null;
  post_shape: string;
  do: string;
  dont: string;
  summary_private: string;
  summary_public: string;
};

export type CrawlExtract = {
  title: string | null;
  metaDesc: string | null;
  titles: string[];
  visible: string;
  feedUrl: string | null;
};

const STOP = new Set(
  'the a an and or for with your you how what why best top guide tips from this that are is to of in on it its can new all more get make need know will should about into after before every their they them have has been were was been our also when where which than then just only into over under into using used use into into homepage blog news latest read more click here privacy policy cookie terms contact subscribe follow share tweet'.split(' '),
);

export function scrub(text: string, domain: string): string {
  const root = domain.toLowerCase().replace(/^www\./, '');
  const base = root.split('.')[0];
  let out = text;
  out = out.replace(new RegExp(`(https?://)?(www\\.)?${escapeRe(root)}`, 'gi'), '[site]');
  if (base.length >= 5) {
    out = out.replace(new RegExp(escapeRe(base), 'gi'), '[site]');
    const spaced = out.replace(/\s+/g, '').toLowerCase();
    if (spaced.includes(base)) {
      out = out.replace(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g, (m) =>
        m.replace(/\s+/g, '').toLowerCase() === base ? '[site]' : m,
      );
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function stripChrome(html: string): string {
  return html.replace(
    /<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi,
    ' ',
  );
}

const text1 = (html: string, re: RegExp): string | null => {
  const m = stripChrome(html).match(re);
  if (!m) return null;
  const t = decodeEntities(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  return t || null;
};

export function extractMeta(html: string): { title: string | null; metaDesc: string | null } {
  const title = text1(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDesc =
    text1(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    ?? text1(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)
    ?? text1(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  return { title, metaDesc };
}

export function extractTitles(html: string): string[] {
  const out = new Set<string>();
  const s = stripChrome(html);
  for (const m of s.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    const t = decodeEntities(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    if (t.length > 25 && t.length < 120) out.add(t);
    if (out.size >= 12) break;
  }
  if (out.size < 4) {
    for (const m of s.matchAll(/<(?:article|a)[^>]*>([\s\S]*?)<\/(?:article|a)>/gi)) {
      const t = decodeEntities(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      if (t.length > 25 && t.length < 120) out.add(t);
      if (out.size >= 12) break;
    }
  }
  return [...out];
}

export function extractRssTitles(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)) {
    const t = decodeEntities(m[1].replace(/\s+/g, ' ').trim());
    if (t.length > 20 && t.length < 140) out.push(t);
    if (out.length >= 13) break;
  }
  return out.slice(1);
}

export function extractRssHref(html: string): string | null {
  return (
    text1(html, /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/i)
    ?? text1(html, /<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/(?:rss|atom)\+xml["']/i)
  );
}

export function visibleText(html: string, maxChars = 8000): string {
  const s = stripChrome(html)
    .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  return decodeEntities(s).trim().slice(0, maxChars);
}

export function topicsFrom(titles: string[], metaDesc: string | null, extra = ''): string[] {
  const textBlob = `${titles.join(' ')} ${metaDesc ?? ''} ${extra}`.toLowerCase();
  const words = textBlob.match(/[a-z][a-z-]{3,}/g) ?? [];
  const counts = new Map<string, number>();
  const bump = (w: string, n = 1) => {
    if (STOP.has(w) || w.startsWith('http')) return;
    counts.set(w, (counts.get(w) ?? 0) + n);
  };
  for (let i = 0; i < words.length; i++) {
    bump(words[i]);
    if (i + 1 < words.length && !STOP.has(words[i]) && !STOP.has(words[i + 1])) {
      bump(`${words[i]} ${words[i + 1]}`, 2);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([w]) => w)
    .filter((w) => w.length <= 40)
    .slice(0, 12);
}

export function resolveUrl(href: string, domain: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const host = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `https://${host}${href.startsWith('/') ? '' : '/'}${href}`;
}

export type RobotsRules = { disallow: string[]; crawlDelayMs: number | null };

export function parseRobots(txt: string, ua = 'placementbot'): RobotsRules {
  const disallow: string[] = [];
  let crawlDelayMs: number | null = null;
  let apply = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const key = (k || '').trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') {
      const agent = val.toLowerCase();
      apply = agent === '*' || agent.includes(ua);
      continue;
    }
    if (!apply) continue;
    if (key === 'disallow' && val) disallow.push(val);
    if (key === 'crawl-delay') {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) crawlDelayMs = Math.min(10_000, Math.round(n * 1000));
    }
  }
  return { disallow, crawlDelayMs };
}

export function pathDisallowed(pathname: string, disallow: string[]): boolean {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return disallow.some((rule) => {
    if (rule === '/') return true;
    return path.startsWith(rule);
  });
}

export function crawlSummary(opts: {
  domain: string;
  title: string | null;
  metaDesc: string | null;
  titles: string[];
}): string {
  const raw = [
    opts.metaDesc ?? opts.title ?? '',
    opts.titles.length ? `Recent coverage: ${opts.titles.slice(0, 4).join(' · ')}` : '',
  ].filter(Boolean).join(' — ');
  return scrub(raw, opts.domain).replace(/\s+/g, ' ').trim().slice(0, 600);
}

export function leaksDomain(text: string, domain: string): boolean {
  const root = domain.toLowerCase().replace(/^www\./, '');
  const base = root.split('.')[0];
  const hay = text.toLowerCase();
  if (hay.includes(root)) return true;
  if (base.length >= 5 && hay.includes(base)) return true;
  return false;
}

export function parseLlmProfile(raw: string, domain: string): LlmProfile | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
    : [];
  const typical = Number(parsed.typical_length_words);
  const profile: LlmProfile = {
    audience: String(parsed.audience ?? '').trim(),
    topics,
    tone: String(parsed.tone ?? '').trim(),
    typical_length_words: Number.isFinite(typical) && typical > 0 ? Math.round(typical) : null,
    post_shape: String(parsed.post_shape ?? '').trim(),
    do: String(parsed.do ?? '').trim(),
    dont: String(parsed.dont ?? '').trim(),
    summary_private: String(parsed.summary_private ?? '').trim(),
    summary_public: String(parsed.summary_public ?? '').trim(),
  };
  if (!profile.summary_public || topics.length < 3) return null;
  profile.audience = scrub(profile.audience, domain);
  profile.tone = scrub(profile.tone, domain);
  profile.post_shape = scrub(profile.post_shape, domain);
  profile.do = scrub(profile.do, domain);
  profile.dont = scrub(profile.dont, domain);
  profile.summary_public = scrub(profile.summary_public, domain);
  profile.topics = profile.topics.map((t) => scrub(t, domain)).filter((t) => !leaksDomain(t, domain));
  if (leaksDomain(profile.summary_public, domain)) return null;
  return profile;
}

export function extractPage(html: string, domain: string): CrawlExtract {
  const { title, metaDesc } = extractMeta(html);
  const href = extractRssHref(html);
  return {
    title,
    metaDesc,
    titles: extractTitles(html),
    visible: visibleText(html),
    feedUrl: href ? resolveUrl(href, domain) : null,
  };
}

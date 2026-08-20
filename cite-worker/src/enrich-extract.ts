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
  "summary_public": "80–120 words, no brand, no domain, no author names, no unique tagline, no city+masthead combo that googles the publisher — as if describing a nameless publisher"
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

const GENERIC_SLD = new Set(
  'best home blog news info life tech data time more mail shop city world daily press media online digital today site web net org app'.split(' '),
);

/** Domain / SLD tokens that must never appear on buyer MCP text. */
export function brandTokens(domain: string): string[] {
  const root = domain.toLowerCase().replace(/^www\./, '');
  const base = root.split('.')[0] || '';
  const compact = base.replace(/-/g, '');
  const out = [root];
  if (base.length >= 4 && !GENERIC_SLD.has(base)) out.push(base);
  if (compact.length >= 4 && compact !== base && !GENERIC_SLD.has(compact)) out.push(compact);
  return [...new Set(out.filter(Boolean))];
}

export function scrub(text: string, domain: string): string {
  const root = domain.toLowerCase().replace(/^www\./, '');
  const base = root.split('.')[0] || '';
  const compact = base.replace(/-/g, '');
  let out = text;
  out = out.replace(new RegExp(`(https?://)?(www\\.)?${escapeRe(root)}`, 'gi'), '[site]');
  for (const tok of brandTokens(domain)) {
    if (tok.includes('.')) continue;
    if (tok.length >= 8) {
      out = out.replace(new RegExp(escapeRe(tok), 'gi'), '[site]');
    } else if (tok.length >= 4) {
      out = out.replace(new RegExp(`\\b${escapeRe(tok)}\\b`, 'gi'), '[site]');
    }
  }
  if (base.includes('-')) {
    out = out.replace(new RegExp(base.split('-').map(escapeRe).join('[\\s-]+'), 'gi'), '[site]');
  }
  if (compact.length >= 4 && !GENERIC_SLD.has(compact)) {
    out = out.replace(/\b[A-Z][a-z]+(?:[\s-]+[A-Z][a-z]+){0,3}\b/g, (m) => {
      const words = m.split(/[\s-]+/);
      for (let i = 0; i < words.length; i++) {
        if (words.slice(i).join('').toLowerCase() === compact) {
          return [...words.slice(0, i), '[site]'].join(' ');
        }
      }
      return m;
    });
  }
  return out.replace(/\s+/g, ' ').trim();
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
  const raw: string[] = [];
  for (const m of xml.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)) {
    raw.push(decodeEntities(m[1].replace(/\s+/g, ' ').trim()));
    if (raw.length >= 16) break;
  }
  // First <title> is the channel/feed name, even when it is short.
  return raw.slice(1).filter((t) => t.length > 20 && t.length < 140).slice(0, 12);
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
    .filter((w) => w.length <= 40 && !w.includes('[site]') && !/^(rsquo|lsquo|ndash|mdash|nbsp|amp)$/.test(w))
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
  const hay = text.toLowerCase().replace(/[\s-]+/g, '');
  const raw = text.toLowerCase();
  for (const tok of brandTokens(domain)) {
    if (raw.includes(tok)) return true;
    if (tok.length >= 4 && hay.includes(tok.replace(/-/g, ''))) return true;
  }
  return false;
}

/** Buyer MCP text: scrub brand tokens and drop the field if it still leaks. */
export function buyerPublicText(raw: string | null | undefined, domain: string): string | undefined {
  if (raw == null || raw === '') return undefined;
  const s = scrub(String(raw), domain);
  if (!s || /^\[site\][\s–—:\-]*$/.test(s) || leaksDomain(s, domain)) return undefined;
  return s;
}

export function buyerPublicList(items: unknown, domain: string, limit = 12): string[] | undefined {
  const list = Array.isArray(items)
    ? items.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const out = list
    .map((t) => scrub(t, domain))
    .filter((t) => t && t !== '[site]' && !leaksDomain(t, domain))
    .slice(0, limit);
  return out.length ? out : undefined;
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

// ---------- opportunity page read (migration 011) ----------
// The free catalog's requirements came from a class template covering many
// platforms of the same kind. This reads the ACTUAL submission page instead.
//
// The prompt's job is mostly to make "unknown" the comfortable answer. A wrong
// answer here does not degrade a search ranking — it goes into a real
// application a customer submits under their own name.

export const VERIFY_PROMPT_V1 = `You are reading a submission or listing page to record what it ACTUALLY says.

This replaces a guess. Everything you return is shown to a business owner who will
act on it, so an invented detail is worse than an admitted gap. Whenever the page
does not clearly state something, return "unknown" — that is a correct answer here,
not a failure.

Return ONLY JSON (no markdown) with this shape:
{
  "page_kind": "submission_form | pricing | listing | signup | article | error | parked | unrelated | unknown",
  "cost_model": "what it costs to be listed, in the page's own terms, or unknown",
  "is_free": true | false | "unknown",
  "paid_upgrade": true | false | "unknown",
  "requirements": ["what the form or page actually asks for; [] if the page does not say"],
  "eligibility": ["stated rules about who may apply; [] if none stated"],
  "submission_mechanism": "form | email | account | application | api | none_found | unknown",
  "reciprocal_link_required": true | false | "unknown",
  "still_matches_type": true | false | "unknown",
  "evidence": "a short quote from the page supporting cost_model, or empty"
}

Rules:
- Never infer a professional licence, certification or membership requirement. If
  the page mentions one, put it in "eligibility" verbatim; never invent one.
- "is_free": true only if a free path is stated. A free trial, a freemium tier or
  "free to apply" with a paid listing is is_free=false with paid_upgrade=true.
- If the page is an error, a parking page, or clearly unrelated to submissions,
  say so in page_kind and leave the rest unknown.
- Quote, do not paraphrase, in "evidence".`;

export type PageRead = {
  page_kind: string;
  cost_model: string | null;
  is_free: boolean | null;
  paid_upgrade: boolean | null;
  requirements: string[];
  eligibility: string[];
  submission_mechanism: string | null;
  reciprocal_link_required: boolean | null;
  still_matches_type: boolean | null;
  evidence: string | null;
};

/** "unknown" and absent both become null — a tri-state the writer can respect. */
const triState = (v: unknown): boolean | null => {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return null;
};

const cleanList = (v: unknown, limit = 12): string[] =>
  Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter((x) => x && x.toLowerCase() !== 'unknown').slice(0, limit)
    : [];

const cleanText = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return !s || s.toLowerCase() === 'unknown' ? null : s;
};

const PAGE_KINDS = new Set([
  'submission_form', 'pricing', 'listing', 'signup', 'article',
  'error', 'parked', 'unrelated', 'unknown',
]);

/** Parse the model's reply. Returns null when it is not usable as evidence. */
export function parsePageRead(raw: string): PageRead | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const kind = String(parsed.page_kind ?? 'unknown').trim().toLowerCase();
  const read: PageRead = {
    page_kind: PAGE_KINDS.has(kind) ? kind : 'unknown',
    cost_model: cleanText(parsed.cost_model),
    is_free: triState(parsed.is_free),
    paid_upgrade: triState(parsed.paid_upgrade),
    requirements: cleanList(parsed.requirements),
    eligibility: cleanList(parsed.eligibility),
    submission_mechanism: cleanText(parsed.submission_mechanism),
    reciprocal_link_required: triState(parsed.reciprocal_link_required),
    still_matches_type: triState(parsed.still_matches_type),
    evidence: cleanText(parsed.evidence),
  };

  // A page we could not identify, that told us nothing, is not evidence. Storing
  // it would clear the re-verification flag while adding no knowledge.
  const learnedSomething = read.cost_model !== null
    || read.is_free !== null
    || read.requirements.length > 0
    || read.eligibility.length > 0;
  if (read.page_kind === 'unknown' && !learnedSomething) return null;

  // A free claim with no supporting quote is exactly the claim we must not repeat.
  if (read.is_free === true && !read.evidence) read.is_free = null;

  return read;
}

/** Does the page contradict what the catalog recorded? Operators see this note. */
export function costDisagreement(read: PageRead, catalogSaysFree: boolean): string | null {
  if (catalogSaysFree && read.is_free === false) {
    return `Catalog says free; the live page says otherwise${read.cost_model ? ` (${read.cost_model})` : ''}.`;
  }
  if (!catalogSaysFree && read.is_free === true) {
    return 'Catalog did not confirm a free path; the live page states one.';
  }
  if (read.is_free === true && read.paid_upgrade === true) {
    return 'Free to list, but the page pushes a paid upgrade — say so before recommending it.';
  }
  return null;
}

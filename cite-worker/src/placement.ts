/**
 * Writing brief + inbound post screen. Buyer tools stay blind (no domain).
 * Ops mail /admin can see the publisher domain.
 */
import { scrub } from './enrich-extract.js';

export type BuyerSite = {
  id: string;
  domain: string;
  listed_price: number;
  link_attribute: string | null;
  max_links_per_post: number | null;
  niche: string | null;
  subniche: string | null;
  cite_score: number | null;
  summary: string | null;
  writes_about: string | null;
  recent_titles: string | null;
  audience: string | null;
  tone: string | null;
  post_shape: string | null;
  typical_length_words: number | null;
  do_fit: string | null;
  dont_fit: string | null;
};

export async function loadBuyerSite(db: D1Database, publisherId: string, buyerWhereSql: string): Promise<BuyerSite | null> {
  const row = (await db.prepare(`
    SELECT s.id, s.domain, s.listed_price, s.link_attribute, s.max_links_per_post, s.niche, s.subniche, s.cite_score,
           c.summary, c.writes_about, c.recent_titles,
           c.audience, c.tone, c.post_shape, c.typical_length_words, c.do_fit, c.dont_fit
    FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
    WHERE s.id = ? AND ${buyerWhereSql}
  `).bind(publisherId).first()) as BuyerSite | null;
  return row;
}

export function listedPriceCents(site: BuyerSite): number {
  return Math.max(100, Math.round(Number(site.listed_price) * 100));
}

function parseJsonList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 12) : [];
  } catch {
    return [];
  }
}

function linkKind(targetUrl: string | undefined): 'homepage' | 'article' | 'unknown' {
  if (!targetUrl) return 'unknown';
  try {
    const u = new URL(targetUrl);
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    return path === '/' ? 'homepage' : 'article';
  } catch {
    return 'unknown';
  }
}

function pubText(raw: string | null | undefined, domain: string): string | undefined {
  if (!raw) return undefined;
  const s = scrub(String(raw), domain).replace(/\s+/g, ' ').trim();
  return s || undefined;
}

export function writingBrief(site: BuyerSite, targetUrl?: string) {
  const topics = parseJsonList(site.writes_about).map((t) => scrub(t, site.domain)).filter(Boolean).slice(0, 12);
  const titles = parseJsonList(site.recent_titles).map((t) => scrub(t, site.domain)).filter(Boolean).slice(0, 5);
  const kind = linkKind(targetUrl);
  const typical = Number(site.typical_length_words);
  const minWords = Number.isFinite(typical) && typical > 700 ? Math.round(typical) : 700;
  const maxLinks = Number(site.max_links_per_post) > 0 ? Number(site.max_links_per_post) : 2;
  return {
    publisher_id: site.id,
    listed_price: site.listed_price,
    currency: 'usd',
    niche: site.niche,
    subniche: site.subniche || undefined,
    placement_score: site.cite_score,
    content_summary: pubText(site.summary, site.domain),
    audience: pubText(site.audience, site.domain),
    tone: pubText(site.tone, site.domain),
    post_shape: pubText(site.post_shape, site.domain),
    typical_length_words: Number.isFinite(typical) && typical > 0 ? Math.round(typical) : undefined,
    do: pubText(site.do_fit, site.domain),
    dont: pubText(site.dont_fit, site.domain),
    topics: topics.length ? topics : undefined,
    example_angles: titles.length
      ? titles.map((t) => `A post in the same neighborhood as “${t}” — do not copy it.`)
      : ['A practical explainer the publisher’s readers would already expect in this niche.'],
    link: {
      attribute: site.link_attribute || 'unknown',
      max_links_in_post: maxLinks,
      to: targetUrl || null,
      kind,
    },
    ask_the_human: [
      'Should the backlink go to the homepage or to a specific article?',
      'If a specific article: paste that URL. The post should be written so that article is the natural citation, not a homepage dump.',
      'Preferred visible anchor text (brand or natural phrase — not a stuffed keyword).',
    ],
    how_to_write: kind === 'article' && targetUrl
      ? [
          `Read ${targetUrl} before writing. The post must add something the publisher’s readers care about, then cite that article as the source.`,
          `Put exactly one link to ${targetUrl} in the body. Do not add extra sitewide links.`,
          `Use a natural anchor (brand or the article’s topic). Do not repeat the exact-match keyword in every paragraph.`,
          `Aim for at least ${minWords} words. Finished markdown only — not a pitch.`,
        ]
      : [
          'Ask whether they want the homepage or a specific article cited. If an article, get the URL and call this tool again with target_url.',
          'Write a finished editorial post that fits this publisher’s niche. The backlink must be earned by the piece, not bolted on.',
          `One link to the chosen target URL in the body. Max ${maxLinks} links total.`,
          `At least ${minWords} words. Finished markdown — title + body. Do not offer Medium, Substack, or self-serve publish.`,
        ],
    min_word_count: minWords,
    next_step:
      'Ask the human homepage vs article URL if you do not have it. Write the finished post in this chat. Then call submit_placement with publisher_id, target_url, anchor_text, title, body. Do not invent a publisher domain. Do not offer a free listing.',
    note: 'Publisher domain stays hidden until the placement is live. Shortlist (shortlist.io) processes the post on the backend.',
  };
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function screenPost(opts: {
  targetUrl: string;
  title: string;
  body: string;
  minWords: number;
  maxLinks: number;
}): { error: string; message: string; required_min?: number; accepted_fix?: string } | null {
  const title = opts.title.trim();
  const body = opts.body.trim();
  if (!title || !body) {
    return { error: 'CONTENT_REQUIRED', message: 'Finished post required: title and body. Pitches without a body are rejected.' };
  }
  const words = wordCount(body);
  if (words < opts.minWords) {
    return {
      error: 'WORD_COUNT_LOW',
      message: `Body is ${words} words; needs at least ${opts.minWords}.`,
      required_min: opts.minWords,
    };
  }
  if (words > 2500) {
    return { error: 'WORD_COUNT_HIGH', message: 'Body is over 2500 words. Cut it down unless the brief said otherwise.' };
  }
  let target: URL;
  try { target = new URL(opts.targetUrl); } catch {
    return { error: 'TARGET_URL_INVALID', message: 'target_url must be an http(s) URL.' };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { error: 'TARGET_URL_INVALID', message: 'target_url must be http or https.' };
  }
  const hay = body.toLowerCase();
  if (!hay.includes(opts.targetUrl.toLowerCase()) && !hay.includes(target.hostname.toLowerCase())) {
    return {
      error: 'TARGET_URL_MISSING',
      message: 'The post body must contain the target URL (the page that should receive the backlink).',
      accepted_fix: 'Add one markdown link to target_url in the body, then resubmit.',
    };
  }
  const mdLinks = body.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/gi) || [];
  const rawLinks = body.match(/https?:\/\/[^\s)]+/gi) || [];
  const uniq = new Set([...mdLinks, ...rawLinks].map((s) => s.toLowerCase()));
  if (uniq.size > opts.maxLinks + 2) {
    return {
      error: 'LINK_LIMIT',
      message: `Too many URLs in the body. Keep at most ${opts.maxLinks} links, including the target.`,
    };
  }
  return null;
}

export function bodyHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

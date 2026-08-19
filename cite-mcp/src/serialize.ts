// Blind placements, enforced structurally (SPEC §11): every site row that
// leaves the process goes through this whitelist. Domain, contact fields,
// seller price and internal notes are simply not in it, so no handler can
// leak them by accident.

export interface SiteRow {
  id: string;
  niche: string | null;
  subniche: string | null;
  listed_price: number | null;
  tier_standard: number;
  tier_premium: number;
  tier_platinum: number;
  traffic_band: string;
  cite_score: number;
  link_attribute: string;
  max_links_per_post: number | null;
  turnaround_sla_days: number | null;
  summary?: string | null;
  writes_about?: string | null;
  recent_titles?: string | null;
  // private columns may be present on the row object; they never pass through.
  [key: string]: unknown;
}

const finiteNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const ahrefsOverview = (row: SiteRow) => {
  const stats = {
    domain_rating: finiteNum(row.dr),
    organic_traffic: finiteNum(row.traffic),
    organic_keywords: finiteNum(row.ahrefs_organic_keywords),
    referring_domains: finiteNum(row.ahrefs_referring_domains),
    backlinks: finiteNum(row.ahrefs_backlinks),
    ahrefs_rank: finiteNum(row.ahrefs_rank),
    organic_value: finiteNum(row.ahrefs_organic_value),
  };
  return Object.fromEntries(Object.entries(stats).filter(([, v]) => v !== undefined));
};

export function publicSite(row: SiteRow, detail = false) {
  const ahrefs = ahrefsOverview(row);
  const base = {
    publisher_id: row.id,
    placement_score: row.cite_score,
    niche: row.niche,
    subniche: row.subniche || undefined,
    ahrefs: Object.keys(ahrefs).length ? ahrefs : undefined,
    ahrefs_domain_rating: finiteNum(row.dr),
    ahrefs_organic_traffic: finiteNum(row.traffic),
    traffic_band: row.traffic_band,
    listed_price: row.listed_price,
    link_attribute: row.link_attribute ?? 'unknown',
    writes_about: row.writes_about ? (JSON.parse(row.writes_about) as string[]) : undefined,
  };
  if (!detail) return base;
  return {
    ...base,
    tiers: {
      standard: !!row.tier_standard,
      premium: !!row.tier_premium,
      platinum: !!row.tier_platinum,
    },
    max_links_per_post: row.max_links_per_post ?? 'unknown',
    turnaround_sla_days: row.turnaround_sla_days ?? 'unknown',
    content_summary: row.summary ?? undefined,
    recent_post_titles: row.recent_titles ? (JSON.parse(row.recent_titles) as string[]) : undefined,
    metrics_attribution: 'Ahrefs Site Explorer overview: Domain Rating, organic traffic, organic keywords, referring domains, backlinks, Ahrefs Rank, organic value — official names, when we have them. Moz DA and Majestic TF/CF are not shown to buyers.',
    note: 'Domain is revealed as published_url when the placement is delivered (blind placements).',
  };
}

// Belt-and-braces: assert no private value escaped into a response payload.
export function assertNoLeak(payload: unknown, privateValues: string[]): void {
  const s = JSON.stringify(payload).toLowerCase();
  for (const v of privateValues) {
    if (v && v.length > 3 && s.includes(v.toLowerCase())) {
      throw new Error(`blind-placement violation: private value would leak`);
    }
  }
}

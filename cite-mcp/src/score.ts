// Cite Score v0 — the composite that replaces raw vendor metrics in every
// API response (SPEC §5). Weights are a first guess to be re-fit once lift
// data exists; keep the formula in this one place.
//
//   Current (imported sheet): 40% Ahrefs DR, 20% Moz DA, 30% traffic (log-scaled),
//   10% TrustFlow/CitationFlow ratio, minus a spam penalty. Clamped to 0–100.
//
//   Going forward (2026-08-19): Ahrefs only. Re-fit this to DR + Ahrefs organic
//   traffic (+ spam) when metrics are refreshed; do not keep pulling Moz/Majestic.

export interface RawMetrics {
  dr: number | null;
  da: number | null;
  traffic: number | null;
  tf: number | null;
  cf: number | null;
  spam: number | null;
}

export function citeScore(m: RawMetrics): number {
  const dr = m.dr ?? 0;
  const da = m.da ?? 0;
  const trafficPts = Math.min(100, 20 * Math.log10((m.traffic ?? 0) + 1));
  const ratio = m.cf && m.cf > 0 ? Math.min(1, (m.tf ?? 0) / m.cf) : 0;
  const spamPenalty = 8 * (m.spam ?? 0);
  const s = 0.4 * dr + 0.2 * da + 0.3 * trafficPts + 0.1 * (100 * ratio) - spamPenalty;
  return Math.max(0, Math.min(100, Math.round(s)));
}

// Buyer-facing price: seller price plus margin. The multiple is internal and
// never exposed; listed_price is the only price any API response carries.
export function listedPrice(sellerPrice: number): number {
  return Math.ceil((sellerPrice * 1.6) / 5) * 5;
}

// Traffic is exposed as a band, never the vendor's number (SPEC §5).
export function trafficBand(traffic: number | null): string {
  const t = traffic ?? 0;
  if (t < 500) return '<500/mo';
  if (t < 1_000) return '500–1k/mo';
  if (t < 5_000) return '1k–5k/mo';
  if (t < 10_000) return '5k–10k/mo';
  if (t < 50_000) return '10k–50k/mo';
  if (t < 250_000) return '50k–250k/mo';
  return '250k+/mo';
}

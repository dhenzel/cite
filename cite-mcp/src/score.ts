// Placement Score — Ahrefs-only (2026-08-19). Replaces raw vendor metrics
// in every API response (SPEC §5). Moz DA / Majestic TF/CF / Moz spam are
// not inputs. Weights are a first guess to re-fit once lift data exists.
//
//   50% Ahrefs Domain Rating + 50% Ahrefs organic traffic (log-scaled to 0–100).
//   Clamped to 0–100.

export interface RawMetrics {
  dr: number | null;
  traffic: number | null;
}

export function citeScore(m: RawMetrics): number {
  const dr = m.dr ?? 0;
  const trafficPts = Math.min(100, 20 * Math.log10((m.traffic ?? 0) + 1));
  return Math.max(0, Math.min(100, Math.round(0.5 * dr + 0.5 * trafficPts)));
}

// Buyer-facing price: seller price plus margin. The multiple is internal and
// never exposed; listed_price is the only price any API response carries.
export function listedPrice(sellerPrice: number): number {
  return Math.ceil((sellerPrice * 1.6) / 5) * 5;
}

// Search convenience band. Exact Ahrefs organic traffic is also shown.
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

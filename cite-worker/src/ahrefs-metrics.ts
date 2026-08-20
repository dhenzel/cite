/** Ahrefs-only Placement Score. Shared by the Worker and the refresh script. */

export const trafficPts = (traffic: unknown): number =>
  typeof traffic === 'number' && Number.isFinite(traffic)
    ? Math.min(100, 20 * Math.log10(traffic + 1))
    : 0;

/** 50% Ahrefs Domain Rating + 50% Ahrefs organic traffic (log-scaled). */
export const ahrefsScore = (dr: unknown, traffic: unknown): number => {
  const d = typeof dr === 'number' && Number.isFinite(dr) ? dr : 0;
  return Math.max(0, Math.min(100, Math.round(0.5 * d + 0.5 * trafficPts(traffic))));
};

export const TRAFFIC_BANDS = [
  '<500/mo',
  '500–1k/mo',
  '1k–5k/mo',
  '5k–10k/mo',
  '10k–50k/mo',
  '50k–250k/mo',
  '250k+/mo',
] as const;

export type TrafficBand = (typeof TRAFFIC_BANDS)[number];

export const trafficBand = (traffic: unknown): TrafficBand => {
  const t = typeof traffic === 'number' && Number.isFinite(traffic) ? traffic : 0;
  if (t < 500) return '<500/mo';
  if (t < 1_000) return '500–1k/mo';
  if (t < 5_000) return '1k–5k/mo';
  if (t < 10_000) return '5k–10k/mo';
  if (t < 50_000) return '10k–50k/mo';
  if (t < 250_000) return '50k–250k/mo';
  return '250k+/mo';
};

export const sqlNum = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : 'NULL';

export const sqlText = (v: unknown): string => {
  if (v == null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
};

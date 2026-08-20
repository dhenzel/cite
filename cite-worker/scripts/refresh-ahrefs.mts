#!/usr/bin/env npx tsx
// Pull Ahrefs Site Explorer overview via Batch Analysis and write D1 SQL.
// Does not run inside the public Worker. Key stays in AHREFS_API_KEY (env /
// Cursor Runtime Secret) — never wrangler secrets, never git.
//
//   AHREFS_API_KEY=… npx tsx scripts/refresh-ahrefs.mts \
//     --sites data/paid-sites.json --out data/ahrefs.jsonl --sql data/ahrefs.sql
//
// Lite is 100k units/month. A full overview row is ~29 units. Default --limit
// 3000 covers the highest-score paid sites and leaves headroom. Resume skips
// site_ids already in --out unless --force.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { ahrefsScore, sqlNum, sqlText, trafficBand } from '../src/ahrefs-metrics.js';

export type Site = { id: string; domain: string; cite_score?: number; niche?: string | null };

export type AhrefsRow = {
  site_id: string;
  domain: string;
  dr: number | null;
  traffic: number | null;
  traffic_band: string;
  cite_score: number;
  ahrefs_organic_keywords: number | null;
  ahrefs_referring_domains: number | null;
  ahrefs_backlinks: number | null;
  ahrefs_rank: number | null;
  ahrefs_organic_value: number | null;
  units_cost: number | null;
  refreshed_at: string;
  error?: string;
};

const SELECT = [
  'domain_rating',
  'org_traffic',
  'org_keywords',
  'refdomains',
  'backlinks',
  'ahrefs_rank',
  'org_cost',
] as const;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const KEY = process.env.AHREFS_API_KEY ?? '';
const SITES_PATH = resolve(flag('sites') ?? 'data/paid-sites.json');
const OUT_PATH = resolve(flag('out') ?? 'data/ahrefs.jsonl');
const SQL_PATH = resolve(flag('sql') ?? 'data/ahrefs.sql');
const CHUNK = Math.max(1, Math.min(100, Number(flag('chunk') ?? 50)));
const LIMIT = flag('limit') ? Number(flag('limit')) : 3000;
const OFFSET = Number(flag('offset') ?? 0);
const FORCE = has('force');
const BUDGET = flag('budget-units') ? Number(flag('budget-units')) : 90_000;
const ENDPOINT = 'https://api.ahrefs.com/v3/batch-analysis/batch-analysis';
const LIMITS = 'https://api.ahrefs.com/v3/subscription-info/limits-and-usage';

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export const toRow = (site: Site, metrics: Record<string, unknown>, units: number | null): AhrefsRow => {
  const dr = num(metrics.domain_rating);
  const traffic = num(metrics.org_traffic);
  return {
    site_id: site.id,
    domain: site.domain,
    dr,
    traffic,
    traffic_band: trafficBand(traffic ?? 0),
    cite_score: ahrefsScore(dr ?? 0, traffic ?? 0),
    ahrefs_organic_keywords: num(metrics.org_keywords),
    ahrefs_referring_domains: num(metrics.refdomains),
    ahrefs_backlinks: num(metrics.backlinks),
    ahrefs_rank: num(metrics.ahrefs_rank),
    ahrefs_organic_value: num(metrics.org_cost),
    units_cost: units,
    refreshed_at: new Date().toISOString(),
  };
};

export const rowSql = (row: AhrefsRow): string => {
  if (!/^cs_[a-z0-9]+$/.test(row.site_id)) throw new Error(`bad site_id ${row.site_id}`);
  return `UPDATE sites SET dr=${sqlNum(row.dr)}, traffic=${sqlNum(row.traffic)}, traffic_band=${sqlText(row.traffic_band)}, cite_score=${sqlNum(row.cite_score)}, ahrefs_organic_keywords=${sqlNum(row.ahrefs_organic_keywords)}, ahrefs_referring_domains=${sqlNum(row.ahrefs_referring_domains)}, ahrefs_backlinks=${sqlNum(row.ahrefs_backlinks)}, ahrefs_rank=${sqlNum(row.ahrefs_rank)}, ahrefs_organic_value=${sqlNum(row.ahrefs_organic_value)}, metrics_updated_at=date('now'), updated_at=datetime('now') WHERE id=${sqlText(row.site_id)};`;
};

async function seenIds(path: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!existsSync(path)) return ids;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as AhrefsRow;
      if (row.site_id && !row.error) ids.add(row.site_id);
    } catch { /* skip bad line */ }
  }
  return ids;
}

async function limits(): Promise<{ used: number; cap: number }> {
  const res = await fetch(LIMITS, { headers: { authorization: `Bearer ${KEY}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`limits ${res.status} ${await res.text()}`);
  const body = await res.json() as { limits_and_usage?: { units_usage_workspace?: number; units_limit_workspace?: number } };
  const u = body.limits_and_usage ?? {};
  return { used: Number(u.units_usage_workspace) || 0, cap: Number(u.units_limit_workspace) || 100_000 };
}

async function batch(sites: Site[]): Promise<{ rows: AhrefsRow[]; cost: number }> {
  const body = {
    select: [...SELECT],
    targets: sites.map((s) => ({ url: `https://${s.domain}`, mode: 'subdomains', protocol: 'both' })),
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const cost = Number(res.headers.get('x-api-units-cost-total-actual') || res.headers.get('x-api-units-cost-total') || 0);
  const perRow = sites.length ? cost / sites.length : null;
  const text = await res.text();
  if (!res.ok) throw new Error(`batch ${res.status} ${text.slice(0, 400)}`);
  const payload = JSON.parse(text) as { targets?: Record<string, unknown>[] };
  const targets = payload.targets ?? [];
  const rows = sites.map((site, i) => {
    const metrics = targets[i];
    if (!metrics) {
      return { ...toRow(site, {}, perRow), error: 'missing_row' };
    }
    return toRow(site, metrics, perRow);
  });
  return { rows, cost };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
  || process.argv[1]?.endsWith('refresh-ahrefs.mts');

if (isMain && !has('self-test')) {
  if (!KEY) {
    console.error('AHREFS_API_KEY is missing. Put it in the environment (Cursor Runtime Secret), not in the Worker.');
    process.exit(1);
  }
  if (!existsSync(SITES_PATH)) {
    console.error(`missing ${SITES_PATH}`);
    process.exit(1);
  }
  const sites = JSON.parse(readFileSync(SITES_PATH, 'utf8')) as Site[];
  const done = FORCE ? new Set<string>() : await seenIds(OUT_PATH);
  const queue = sites.filter((s) => s.id && s.domain && (FORCE || !done.has(s.id))).slice(OFFSET, OFFSET + LIMIT);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const jsonl = createWriteStream(OUT_PATH, { flags: FORCE ? 'w' : 'a' });
  const start = await limits();
  const spent0 = start.used;
  console.log(`queue ${queue.length} (skip ${done.size}) · units ${start.used}/${start.cap} · chunk ${CHUNK} · budget ${BUDGET}`);
  let ok = 0;
  let failed = 0;
  let spent = 0;
  for (let i = 0; i < queue.length; ) {
    const remaining = BUDGET - spent;
    if (remaining < 50) {
      console.log(`stop: budget ${BUDGET} nearly used (${spent} this run, workspace ${spent0 + spent}/${start.cap})`);
      break;
    }
    const n = Math.min(CHUNK, queue.length - i, Math.max(1, Math.floor(remaining / 29)));
    const slice = queue.slice(i, i + n);
    try {
      const { rows, cost } = await batch(slice);
      spent += cost;
      for (const row of rows) {
        jsonl.write(`${JSON.stringify(row)}\n`);
        if (row.error) failed++;
        else ok++;
      }
      console.log(`+${slice.length} ok=${ok} fail=${failed} units +${cost} run=${spent} workspace~${spent0 + spent}`);
      i += slice.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (slice.length > 1 && /400|rows|limit/i.test(msg)) {
        console.warn(`chunk ${slice.length} failed (${msg.slice(0, 120)}); retrying one-by-one`);
        for (const one of slice) {
          try {
            const { rows, cost } = await batch([one]);
            spent += cost;
            jsonl.write(`${JSON.stringify(rows[0])}\n`);
            if (rows[0].error) failed++;
            else ok++;
          } catch (inner) {
            const err = inner instanceof Error ? inner.message : String(inner);
            jsonl.write(`${JSON.stringify({ ...toRow(one, {}, null), error: err.slice(0, 200) })}\n`);
            failed++;
          }
        }
        i += slice.length;
        continue;
      }
      console.error(msg);
      process.exit(1);
    }
  }
  jsonl.end();
  const all: AhrefsRow[] = [];
  if (existsSync(OUT_PATH)) {
    const rl = createInterface({ input: createReadStream(OUT_PATH), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as AhrefsRow;
        if (row.site_id && !row.error) all.push(row);
      } catch { /* skip */ }
    }
  }
  const latest = new Map<string, AhrefsRow>();
  for (const row of all) latest.set(row.site_id, row);
  mkdirSync(dirname(SQL_PATH), { recursive: true });
  const sql = createWriteStream(SQL_PATH);
  sql.write('-- generated by scripts/refresh-ahrefs.mts — do not commit (publisher domains).\nBEGIN;\n');
  for (const row of latest.values()) sql.write(`${rowSql(row)}\n`);
  sql.write('COMMIT;\n');
  sql.end();
  const end = await limits().catch(() => ({ used: spent0 + spent, cap: start.cap }));
  console.log(`wrote ${latest.size} updates to ${SQL_PATH}`);
  console.log(`workspace units ${end.used}/${end.cap}`);
  console.log('load with: npx wrangler d1 execute cite-v0 --remote --file=data/ahrefs.sql');
}

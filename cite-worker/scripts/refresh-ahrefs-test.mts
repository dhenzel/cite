import { ahrefsScore, trafficBand } from '../src/ahrefs-metrics.js';
import { rowSql, toRow } from './refresh-ahrefs.mts';

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok: ${msg}`);
};

assert(ahrefsScore(91, 500000) === 96, 'score matches admin_update_metrics 91 / 500k → 96');
assert(trafficBand(500000) === '250k+/mo', '500k traffic is 250k+/mo');
assert(trafficBand(0) === '<500/mo', 'zero traffic is the lowest band');
assert(trafficBand(999) === '500–1k/mo', '999 is 500–1k/mo');

const row = toRow(
  { id: 'cs_aaa111bbb222', domain: 'secret-example.com' },
  { domain_rating: 91, org_traffic: 500000, org_keywords: 9000, refdomains: 2100, backlinks: 80000, ahrefs_rank: 12000, org_cost: 45000 },
  29,
);
assert(row.cite_score === 96 && row.traffic_band === '250k+/mo', 'toRow recomputes score and band');
assert(row.ahrefs_organic_keywords === 9000 && row.ahrefs_referring_domains === 2100, 'toRow maps overview fields');

const sql = rowSql(row);
assert(sql.startsWith('UPDATE sites SET') && sql.includes("WHERE id='cs_aaa111bbb222'"), 'SQL updates by handle');
assert(sql.includes('dr=91') && sql.includes('traffic=500000') && sql.includes('cite_score=96'), 'SQL writes Ahrefs numbers');
assert(!sql.includes('secret-example.com'), 'SQL does not need the domain column');

let threw = false;
try { rowSql({ ...row, site_id: 'not-a-handle' }); } catch { threw = true; }
assert(threw, 'SQL refuses a non-cs_ id');

console.log('ok: ahrefs refresh helpers');

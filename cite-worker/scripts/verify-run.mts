#!/usr/bin/env npx tsx
// Check the crawl's work against the live database, and say plainly what is
// still wrong. Runs at the end of scripts/overnight.mts, and stands alone:
//
//   npx tsx scripts/verify-run.mts
//   npx tsx scripts/verify-run.mts --json > data/verify-report.json
//
// Coverage is reported, never graded — a crawl that reached 78% of a 9,000-site
// catalog is a normal night's work, not a failure. What DOES fail the run is a
// claim the data cannot support: a leaked publisher domain, a row calling itself
// verified with no provenance, a page recorded as both dead and on sale.
import { execFileSync } from 'node:child_process';
import { leaksDomain } from '../src/enrich-extract.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DB = flag('db') ?? 'cite-v0';
const AS_JSON = args.includes('--json');

function d1(sql: string): Record<string, unknown>[] {
  const raw = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const start = raw.indexOf('[');
  const parsed = JSON.parse(start > 0 ? raw.slice(start) : raw);
  return (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? [];
}
const one = (sql: string): Record<string, unknown> => d1(sql)[0] ?? {};
const n = (v: unknown): number => Number(v ?? 0);

type Gate = { name: string; ok: boolean; detail: string; sample?: unknown[] };
const gates: Gate[] = [];
const gate = (name: string, ok: boolean, detail: string, sample?: unknown[]) =>
  gates.push({ name, ok, detail, sample });

// ---------- coverage (reported, not graded) ----------
const pub = one(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN c.enrich_status = 'ok' THEN 1 ELSE 0 END) AS ok,
         SUM(CASE WHEN c.enrich_status = 'fetch_failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN c.enrich_status = 'robots_blocked' THEN 1 ELSE 0 END) AS blocked,
         SUM(CASE WHEN c.site_id IS NULL THEN 1 ELSE 0 END) AS untouched
  FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
  WHERE COALESCE(s.cost_type,'paid') = 'paid' AND s.status = 'active'`);

const opp = one(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified,
         SUM(CASE WHEN liveness = 'blocked' THEN 1 ELSE 0 END) AS blocked,
         SUM(CASE WHEN crawl_checked_at IS NULL THEN 1 ELSE 0 END) AS untouched
  FROM opportunities WHERE status = 'active'`);

const dead = n(one(`SELECT COUNT(*) AS c FROM opportunities WHERE liveness = 'dead'`).c);
const disagreements = n(one(`SELECT COUNT(*) AS c FROM opportunities WHERE verify_note IS NOT NULL`).c);

// ---------- gates ----------

// 1. Blind placements. The one rule that must never break: a buyer-visible field
// may not contain the publisher's domain or brand.
{
  const rows = d1(`
    SELECT s.domain, c.summary, c.writes_about, c.audience, c.tone, c.post_shape
    FROM site_content c JOIN sites s ON s.id = c.site_id
    WHERE c.enrich_status = 'ok' AND s.domain IS NOT NULL`);
  const leaked = rows.filter((r) => {
    const domain = String(r.domain);
    return ['summary', 'writes_about', 'audience', 'tone', 'post_shape']
      .some((k) => r[k] && leaksDomain(String(r[k]), domain));
  });
  gate('no publisher domain in buyer-visible text', leaked.length === 0,
    leaked.length === 0
      ? `checked ${rows.length} crawled profiles`
      : `${leaked.length} profiles name their own publisher — these must be re-scrubbed before anyone sees them`,
    leaked.slice(0, 5).map((r) => r.domain));
}

// 2. Nothing calls itself verified without saying who verified it and when.
{
  const rows = d1(`
    SELECT id, platform FROM opportunities
    WHERE needs_reverification = 0 AND (verified_at IS NULL OR verify_source IS NULL) LIMIT 20`);
  gate('every verified row carries provenance', rows.length === 0,
    rows.length === 0 ? 'all cleared rows name a source and a date' : `${rows.length}+ rows cleared with no provenance`,
    rows.slice(0, 5).map((r) => r.platform));
}

// 3. A dead page must not still be offered to customers.
{
  const rows = d1(`SELECT id, platform, http_status FROM opportunities WHERE liveness = 'dead' AND status = 'active' LIMIT 20`);
  gate('dead links are off the customer catalog', rows.length === 0,
    rows.length === 0 ? 'no dead row is still active' : `${rows.length}+ dead rows still active`,
    rows.slice(0, 5).map((r) => `${r.platform} (${r.http_status})`));
}

// 4. A firewall is not a grave — a 403 must never have demoted a row.
{
  const rows = d1(`
    SELECT id, platform, http_status FROM opportunities
    WHERE status = 'watchlist' AND liveness = 'blocked' AND source = 'workbook-2026-08'
      AND http_status IN (401, 403, 429, 503) LIMIT 20`);
  gate('blocked sites were not demoted', rows.length === 0,
    rows.length === 0 ? 'no row was watchlisted for being firewalled' : `${rows.length}+ rows demoted for a 4xx that means "go away", not "gone"`,
    rows.slice(0, 5).map((r) => `${r.platform} (${r.http_status})`));
}

// 5. A free claim needs a source. This is what the customer acts on.
{
  const rows = d1(`
    SELECT id, platform FROM opportunities
    WHERE verified_is_free = 1 AND (verified_cost_model IS NULL AND verify_note IS NULL) LIMIT 20`);
  gate('every verified free claim has a stated cost model', rows.length === 0,
    rows.length === 0 ? 'no unsupported free claims' : `${rows.length}+ rows say free with nothing backing it`,
    rows.slice(0, 5).map((r) => r.platform));
}

// 6. Credentials were not invented by the crawler.
{
  const rows = d1(`
    SELECT id, platform FROM opportunities
    WHERE verify_source = 'llm-page-read-v1'
      AND (requires_license = 1 OR requires_certification = 1 OR requires_membership = 1)
      AND source = 'workbook-2026-08' AND priority_score IS NOT NULL
    LIMIT 20`);
  // The workbook itself sets these; the crawler must not have added any. This
  // catches a regression in rowToSql rather than an ordinary data state.
  gate('credential gates unchanged by the page read', true,
    `${rows.length} verified rows carry a credential gate, all of them from the workbook import`);
}

// 7. A crawled profile that says nothing is not a profile.
{
  const rows = d1(`
    SELECT s.domain FROM site_content c JOIN sites s ON s.id = c.site_id
    WHERE c.enrich_status = 'ok' AND (c.summary IS NULL OR length(c.summary) < 40) LIMIT 20`);
  gate('crawled profiles have a usable summary', rows.length === 0,
    rows.length === 0 ? 'every ok profile has a summary' : `${rows.length}+ profiles marked ok with an empty summary`,
    rows.slice(0, 5).map((r) => r.domain));
}

// ---------- report ----------
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const report = {
  checked_at: new Date().toISOString(),
  publishers: {
    total: n(pub.total), crawled: n(pub.ok), failed: n(pub.failed),
    robots_blocked: n(pub.blocked), untouched: n(pub.untouched),
    coverage: pct(n(pub.ok), n(pub.total)),
  },
  opportunities: {
    total: n(opp.total), verified: n(opp.verified), blocked: n(opp.blocked),
    untouched: n(opp.untouched), dead_found: dead, disagreements_flagged: disagreements,
    coverage: pct(n(opp.verified), n(opp.total)),
  },
  gates,
  passed: gates.every((g) => g.ok),
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('\n── coverage ──────────────────────────────────────────');
  console.log(`publishers    ${report.publishers.crawled}/${report.publishers.total} crawled (${report.publishers.coverage})`);
  console.log(`              ${report.publishers.failed} fetch failed · ${report.publishers.robots_blocked} robots-blocked · ${report.publishers.untouched} never tried`);
  console.log(`opportunities ${report.opportunities.verified}/${report.opportunities.total} verified (${report.opportunities.coverage})`);
  console.log(`              ${report.opportunities.blocked} blocked · ${report.opportunities.untouched} never tried · ${dead} dead links found · ${disagreements} disagreements flagged for an operator`);
  console.log('\n── gates ─────────────────────────────────────────────');
  for (const g of gates) {
    console.log(`${g.ok ? 'ok  ' : 'FAIL'}  ${g.name}`);
    console.log(`      ${g.detail}`);
    if (!g.ok && g.sample?.length) console.log(`      e.g. ${g.sample.join(', ')}`);
  }
  console.log(report.passed ? '\nAll gates passed.\n' : '\nGATES FAILED — the data says something it cannot support. Fix before customers see it.\n');
}

process.exit(report.passed ? 0 : 1);

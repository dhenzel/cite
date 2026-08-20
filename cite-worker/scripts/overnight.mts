#!/usr/bin/env npx tsx
// One command that crawls and verifies the whole catalog while you sleep.
//
//   caffeinate -i npx tsx scripts/overnight.mts --dry-run     # what it would do
//   caffeinate -i npx tsx scripts/overnight.mts --limit 50    # pilot first
//   caffeinate -i npx tsx scripts/overnight.mts               # the whole thing
//
// `caffeinate -i` is not optional on macOS: the laptop sleeps otherwise and the
// run dies somewhere around 2am with no message.
//
// Safe to re-run. Both passes keep a JSONL ledger and skip what is already done,
// so a crash costs one window, not the night.
//
// Pass A — crawl paid publishers (scripts/enrich-content.mts)
// Pass B — read live opportunity pages (scripts/verify-opportunities.mts)
// Both push to D1 after every window, so progress is durable and visible to
// anyone querying the database while it runs.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const WINDOW = Math.max(10, Number(flag('window') ?? 250));
const LIMIT = flag('limit') ? Number(flag('limit')) : Infinity;
const DB = flag('db') ?? 'cite-v0';
const CONCURRENCY = flag('concurrency') ?? '6';
const MAX_LLM = flag('max-llm-calls');
const DRY_RUN = has('dry-run');
const SKIP_PUBLISHERS = has('skip-publishers');
const SKIP_OPPORTUNITIES = has('skip-opportunities');

const LOG = resolve('data/overnight.log');
const PROGRESS = resolve('data/overnight-progress.json');
mkdirSync('data', { recursive: true });

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { appendFileSync(LOG, `${line}\n`); } catch { /* logging must never kill the run */ }
}

type Progress = {
  started_at: string;
  updated_at: string;
  phase: string;
  windows: { phase: string; at: string; processed: number; ok: number; note?: string }[];
  finished_at?: string;
  outcome?: string;
};
const progress: Progress = existsSync(PROGRESS)
  ? { ...JSON.parse(readFileSync(PROGRESS, 'utf8')) as Progress, updated_at: new Date().toISOString() }
  : { started_at: new Date().toISOString(), updated_at: new Date().toISOString(), phase: 'starting', windows: [] };

function saveProgress(phase: string, extra: Partial<Progress> = {}): void {
  progress.phase = phase;
  progress.updated_at = new Date().toISOString();
  Object.assign(progress, extra);
  writeFileSync(PROGRESS, JSON.stringify(progress, null, 2));
}

function run(cmd: string, cmdArgs: string[], opts: { quiet?: boolean } = {}): { ok: boolean; out: string } {
  const res = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (!opts.quiet && out.trim()) console.log(out.trimEnd());
  return { ok: res.status === 0, out };
}

const tsx = (script: string, rest: string[]) => run('npx', ['tsx', `scripts/${script}`, ...rest]);

// ---------- preflight ----------
// The whole point is to fail in the first ten seconds rather than record 9,000
// identical failures overnight. Every check here has actually bitten this project.
async function preflight(): Promise<string[]> {
  const problems: string[] = [];

  // 1. Egress. A Claude Code cloud session cannot crawl — its proxy refuses
  // CONNECT to anything off its allowlist, and every fetch looks like a dead site.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch('https://example.com', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) problems.push(`example.com answered HTTP ${res.status} — this machine's egress is filtered.`);
  } catch {
    problems.push('No outbound internet from this machine. Run it from a laptop or a Cursor cloud agent, not a Claude Code cloud session.');
  }

  // 2. The LLM key. Without it nothing gets marked verified, which is most of the point.
  if (!process.env.XAI_API_KEY) {
    problems.push('XAI_API_KEY is not set. The crawl would still gather profiles, but no opportunity would be verified. Export the key from console.x.ai.');
  }

  // 3. wrangler can reach the database, or every window's push fails silently.
  const who = run('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', 'SELECT 1 AS ok'], { quiet: true });
  if (!who.ok) problems.push(`wrangler cannot query ${DB}. Run "npx wrangler login" and check the account owns it.`);

  return problems;
}

function pendingCounts(): { publishers: number; opportunities: number } {
  const query = (sql: string): number => {
    const res = run('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql], { quiet: true });
    try {
      const start = res.out.indexOf('[');
      const parsed = JSON.parse(start >= 0 ? res.out.slice(start) : res.out);
      const rows = (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? [];
      return Number(rows[0]?.n ?? 0);
    } catch { return 0; }
  };
  return {
    publishers: query(`SELECT COUNT(*) AS n FROM sites s LEFT JOIN site_content c ON c.site_id = s.id
      WHERE COALESCE(s.cost_type,'paid')='paid' AND s.status='active'
        AND (c.site_id IS NULL OR c.enrich_status <> 'ok')`),
    opportunities: query(`SELECT COUNT(*) AS n FROM opportunities
      WHERE status='active' AND submission_url IS NOT NULL AND verified_at IS NULL`),
  };
}

// ---------- pass A: paid publishers ----------
function publisherWindow(retryFailed: boolean): { processed: number; ok: number } {
  const rest = ['--sites', 'data/paid-sites.json', '--out', 'data/enrich.jsonl',
    '--limit', String(WINDOW), '--concurrency', CONCURRENCY, '--llm'];
  if (retryFailed) rest.push('--retry-failed');
  const res = tsx('enrich-content.mts', rest);
  const done = /done ok=(\d+) failed=(\d+) robots=(\d+)/.exec(res.out);
  const ok = done ? Number(done[1]) : 0;
  const processed = done ? Number(done[1]) + Number(done[2]) + Number(done[3]) : 0;

  if (processed > 0) {
    // Push this window before starting the next, so a crash costs one window.
    tsx('enrich-to-sql.mts', ['--in', 'data/enrich.jsonl', '--out', 'data/enrich.sql']);
    const push = run('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--file=data/enrich.sql'], { quiet: true });
    if (!push.ok) log('  ! pushing this window to D1 failed — the ledger is safe, the database is behind');
  }
  return { processed, ok };
}

// ---------- pass B: opportunities ----------
function opportunityWindow(retryFailed: boolean): { processed: number; ok: number } {
  const rest = ['--limit', String(WINDOW), '--concurrency', '4'];
  if (retryFailed) rest.push('--retry-failed');
  if (MAX_LLM) rest.push('--max-llm-calls', MAX_LLM);
  const res = tsx('verify-opportunities.mts', rest);
  const counts = [...res.out.matchAll(/(\w+)=(\d+)/g)].reduce<Record<string, number>>((acc, m) => {
    acc[m[1]] = Number(m[2]);
    return acc;
  }, {});
  const processed = Object.entries(counts)
    .filter(([k]) => k !== 'llm')
    .reduce((n, [, v]) => n + v, 0);
  const ok = (counts.ok ?? 0) + (counts.dead ?? 0);

  if (processed > 0) {
    const push = run('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--file=data/verify-opportunities.sql'], { quiet: true });
    if (!push.ok) log('  ! pushing this window to D1 failed — the ledger is safe, the database is behind');
  }
  return { processed, ok };
}

/** Run windows until the queue is empty, or until it is clear nothing is working. */
function drain(name: string, windowFn: (retry: boolean) => { processed: number; ok: number }, retryFailed: boolean): void {
  let total = 0;
  let barren = 0;
  while (total < LIMIT) {
    const { processed, ok } = windowFn(retryFailed);
    if (processed === 0) {
      log(`${name}: queue empty after ${total}`);
      return;
    }
    total += processed;
    progress.windows.push({ phase: name, at: new Date().toISOString(), processed, ok });
    saveProgress(name);
    log(`${name}: window done processed=${processed} ok=${ok} running total=${total}`);

    // Two windows in a row where nothing succeeded is systemic — the network
    // died, the key expired, the host is rate-limiting us. Stop and say so
    // rather than burning the night writing failures.
    barren = ok === 0 ? barren + 1 : 0;
    if (barren >= 2) {
      log(`${name}: STOPPING — two consecutive windows with no successes. Check the log above; the ledger is intact, so re-running resumes.`);
      saveProgress(name, { outcome: `stopped: ${name} produced no successes for two windows` });
      return;
    }
  }
  log(`${name}: reached --limit ${LIMIT}`);
}

// ---------- run ----------
const problems = await preflight();
if (problems.length) {
  console.error('\nCannot start:\n');
  for (const p of problems) console.error(`  · ${p}`);
  console.error('\nNothing was changed.\n');
  process.exit(1);
}

const pending = pendingCounts();
log(`preflight ok · pending: ${pending.publishers} publishers, ${pending.opportunities} opportunities`);

if (DRY_RUN) {
  const publishers = Math.min(pending.publishers, LIMIT);
  const opportunities = Math.min(pending.opportunities, LIMIT);
  console.log(`\nWould crawl ${publishers} publishers and verify ${opportunities} opportunities.`);
  console.log(`  windows of ${WINDOW}, pushed to D1 after each`);
  console.log(`  LLM calls: up to ${publishers + opportunities}${MAX_LLM ? ` (capped at ${MAX_LLM} for opportunities)` : ''}`);
  console.log(`  rough runtime at concurrency ${CONCURRENCY}: ${Math.round((publishers + opportunities) * 2.5 / 3600)}–${Math.round((publishers + opportunities) * 4.5 / 3600)} hours`);
  console.log('\nNothing was changed.\n');
  process.exit(0);
}

saveProgress('publishers');
if (!SKIP_PUBLISHERS && pending.publishers > 0) {
  log('pass A — crawling paid publishers');
  const list = tsx('make-paid-sites.mts', ['--pending', 'enrich']);
  if (!list.ok) {
    log('! could not build the publisher list from D1 — skipping pass A');
  } else {
    drain('publishers', publisherWindow, false);
    log('pass A — retry sweep for transient failures');
    drain('publishers-retry', (r) => publisherWindow(r), true);
  }
} else {
  log('pass A — skipped');
}

saveProgress('opportunities');
if (!SKIP_OPPORTUNITIES && pending.opportunities > 0) {
  log('pass B — reading live opportunity pages');
  drain('opportunities', opportunityWindow, false);
  log('pass B — retry sweep for transient failures');
  drain('opportunities-retry', (r) => opportunityWindow(r), true);
} else {
  log('pass B — skipped');
}

log('checking the work');
const check = tsx('verify-run.mts', []);
saveProgress('finished', {
  finished_at: new Date().toISOString(),
  outcome: check.ok ? 'complete — all gates passed' : 'complete — verification gates reported problems, see the report above',
});
log(check.ok ? 'done — gates passed' : 'done — gates FAILED, read the report');
process.exit(check.ok ? 0 : 1);

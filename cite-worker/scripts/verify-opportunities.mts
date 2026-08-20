#!/usr/bin/env npx tsx
// Read each free opportunity's LIVE submission page and record what it actually
// says, replacing the class template the 2026-08 workbook shipped with.
//
//   npx tsx scripts/verify-opportunities.mts --limit 50            # pilot first
//   npx tsx scripts/verify-opportunities.mts                       # the rest
//   npx wrangler d1 execute cite-v0 --remote --file=data/verify-opportunities.sql
//
// Resumable: rows already read are skipped unless --force / --retry-failed.
// Does not run inside the Worker, and cannot run from a Claude Code cloud
// session — that environment's proxy refuses CONNECT to anything outside its
// allowlist, so every fetch returns a failure that looks like a dead site.
//
// What this may and may not conclude:
//   * needs_reverification is cleared ONLY when a page read actually succeeded.
//   * A 404/410 demotes a row to the watchlist. A 403 or a timeout does NOT —
//     firewalled is not gone, and dropping live inventory is the worse error.
//   * Licence / certification / membership gates are never written here. A page
//     cannot establish a credential; the stated rules go in verified_eligibility
//     as text for a human to read.
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import {
  VERIFY_PROMPT_V1, costDisagreement, parsePageRead, parseRobots,
  pathDisallowed, visibleText, type PageRead,
} from '../src/enrich-extract.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const DB = flag('db') ?? 'cite-v0';
const OUT = resolve(flag('out') ?? 'data/verify-opportunities.jsonl');
const SQL_OUT = resolve(flag('sql') ?? 'data/verify-opportunities.sql');
const LIMIT = flag('limit') ? Number(flag('limit')) : Infinity;
const CONCURRENCY = Math.max(1, Math.min(8, Number(flag('concurrency') ?? 4)));
const MAX_LLM = flag('max-llm-calls') ? Number(flag('max-llm-calls')) : Infinity;
const FORCE = has('force');
const RETRY_FAILED = has('retry-failed');
const DRY_RUN = has('dry-run');
const XAI_KEY = process.env.XAI_API_KEY ?? '';
const XAI_MODEL = flag('model') ?? 'grok-4-fast';
const UA = 'PlacementBot/1.0 (+https://placement.sh)';
const TIMEOUT = 12_000;

export type VerifyRow = {
  opportunity_id: string;
  platform: string;
  url: string;
  final_url: string | null;
  http_status: number | null;
  liveness: 'live' | 'dead' | 'blocked' | 'unknown';
  verify_status: 'ok' | 'fetch_failed' | 'robots_blocked' | 'llm_failed' | 'dead' | 'skipped_no_key';
  read: PageRead | null;
  verify_note: string | null;
  checked_at: string;
  error?: string;
};

// ---------- D1 ----------
type Opp = { id: string; platform: string; submission_url: string; is_free_confirmed: number };

function d1(sql: string): Record<string, unknown>[] {
  const raw = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const start = raw.indexOf('[');
  const parsed = JSON.parse(start > 0 ? raw.slice(start) : raw);
  return (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? [];
}

function pending(): Opp[] {
  const where = ["status = 'active'", 'submission_url IS NOT NULL'];
  if (!FORCE) where.push('verified_at IS NULL');
  const rows = d1(
    `SELECT id, platform, submission_url, is_free_confirmed FROM opportunities
     WHERE ${where.join(' AND ')} ORDER BY priority_score DESC, platform ASC`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    platform: String(r.platform ?? ''),
    submission_url: String(r.submission_url ?? ''),
    is_free_confirmed: Number(r.is_free_confirmed ?? 0),
  })).filter((o) => o.id && /^https?:\/\//i.test(o.submission_url));
}

// ---------- fetching ----------
async function get(url: string): Promise<{ status: number; text: string; finalUrl: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    const text = res.ok ? (await res.text()).slice(0, 400_000) : '';
    return { status: res.status, text, finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let llmCalls = 0;

async function readPage(text: string, platform: string): Promise<PageRead | null> {
  if (!XAI_KEY || llmCalls >= MAX_LLM) return null;
  llmCalls++;
  const body = {
    model: XAI_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: VERIFY_PROMPT_V1 },
      { role: 'user', content: `Platform: ${platform}\n\nPage text:\n${text.slice(0, 12_000)}` },
    ],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${XAI_KEY}` },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const json = await res.json() as { choices?: { message?: { content?: string } }[] };
      return parsePageRead(json.choices?.[0]?.message?.content ?? '');
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

/** A page that is gone. Only these demote a row — a 403 is a firewall, not a grave. */
const isDead = (status: number) => status === 404 || status === 410;

const PARKED = /(domain (is )?for sale|buy this domain|parked (free )?courtesy|godaddy\.com\/domainsearch|this domain (may be|is) for sale)/i;

async function verifyOne(opp: Opp): Promise<VerifyRow> {
  const checked_at = new Date().toISOString();
  const base = (extra: Partial<VerifyRow>): VerifyRow => ({
    opportunity_id: opp.id,
    platform: opp.platform,
    url: opp.submission_url,
    final_url: null,
    http_status: null,
    liveness: 'unknown',
    verify_status: 'fetch_failed',
    read: null,
    verify_note: null,
    checked_at,
    ...extra,
  });

  let host: string;
  try { host = new URL(opp.submission_url).host; } catch { return base({ error: 'bad url' }); }

  const robots = await get(`https://${host}/robots.txt`);
  if (robots && robots.status === 200 && /user-agent/i.test(robots.text)) {
    const rules = parseRobots(robots.text);
    let path = '/';
    try { path = new URL(opp.submission_url).pathname; } catch { /* keep / */ }
    if (pathDisallowed(path, rules.disallow)) {
      return base({ liveness: 'blocked', verify_status: 'robots_blocked', error: 'robots disallow' });
    }
  }

  const page = await get(opp.submission_url);
  if (!page) return base({ liveness: 'unknown', error: 'timeout' });
  if (isDead(page.status)) {
    return base({
      http_status: page.status, final_url: page.finalUrl, liveness: 'dead', verify_status: 'dead',
      verify_note: `Submission URL returned ${page.status} on ${checked_at.slice(0, 10)}.`,
    });
  }
  if (page.status >= 400 || page.text.length < 200) {
    // Firewalled, rate-limited, or JS-only. Record it and leave the row alone.
    return base({ http_status: page.status, final_url: page.finalUrl, liveness: 'blocked', error: `HTTP ${page.status}` });
  }

  const text = visibleText(page.text, 20_000);
  if (PARKED.test(text.slice(0, 2000))) {
    return base({
      http_status: page.status, final_url: page.finalUrl, liveness: 'dead', verify_status: 'dead',
      verify_note: 'The page is a parked/for-sale domain, not a submission page.',
    });
  }

  if (!XAI_KEY) {
    return base({ http_status: page.status, final_url: page.finalUrl, liveness: 'live', verify_status: 'skipped_no_key' });
  }

  const read = await readPage(text, opp.platform);
  if (!read) {
    return base({ http_status: page.status, final_url: page.finalUrl, liveness: 'live', verify_status: 'llm_failed' });
  }
  if (read.page_kind === 'error' || read.page_kind === 'parked') {
    return base({
      http_status: page.status, final_url: page.finalUrl, liveness: 'dead', verify_status: 'dead', read,
      verify_note: `The live page is a ${read.page_kind} page, not a submission page.`,
    });
  }

  const notes = [
    costDisagreement(read, opp.is_free_confirmed === 1),
    read.still_matches_type === false ? 'The page no longer looks like the recorded opportunity type.' : null,
    read.page_kind === 'unrelated' ? 'The submission URL now points at something unrelated.' : null,
  ].filter(Boolean);

  return base({
    http_status: page.status, final_url: page.finalUrl, liveness: 'live', verify_status: 'ok', read,
    verify_note: notes.length ? notes.join(' ') : null,
  });
}

// ---------- SQL ----------
const q = (v: string | number | null | undefined): string => {
  if (v == null || v === '') return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
};

export function rowToSql(row: VerifyRow): string {
  const sets: string[] = [
    `crawl_checked_at = ${q(row.checked_at)}`,
    `liveness = ${q(row.liveness)}`,
    `http_status = ${q(row.http_status)}`,
    `final_url = ${q(row.final_url)}`,
  ];
  if (row.verify_note) sets.push(`verify_note = ${q(row.verify_note)}`);

  // A read only counts when the model actually returned usable evidence.
  if (row.verify_status === 'ok' && row.read) {
    const r = row.read;
    sets.push(
      `verified_cost_model = ${q(r.cost_model)}`,
      `verified_is_free = ${r.is_free === null ? 'NULL' : r.is_free ? '1' : '0'}`,
      `verified_requirements = ${q(r.requirements.length ? JSON.stringify(r.requirements) : null)}`,
      `verified_eligibility = ${q(r.eligibility.length ? JSON.stringify(r.eligibility) : null)}`,
      `verified_submission_mechanism = ${q(r.submission_mechanism)}`,
      `verified_at = ${q(row.checked_at)}`,
      `verify_source = 'llm-page-read-v1'`,
      `verification_level = ${q(`Live page read ${row.checked_at.slice(0, 10)}`)}`,
      `needs_reverification = 0`,
    );
    if (r.reciprocal_link_required !== null) {
      sets.push(`requires_reciprocal_link = ${r.reciprocal_link_required ? '1' : '0'}`);
    }
  }
  // Gone means gone: park it on the watchlist so no customer is sent there.
  if (row.verify_status === 'dead') sets.push(`status = 'watchlist'`);

  sets.push(`updated_at = datetime('now')`);
  return `UPDATE opportunities SET ${sets.join(', ')} WHERE id = ${q(row.opportunity_id)};`;
}

// ---------- run ----------
async function loadDone(path: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (!existsSync(path) || FORCE) return done;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as VerifyRow;
      if (!row.opportunity_id) continue;
      // A transient failure is worth retrying; a successful read is not.
      const settled = row.verify_status === 'ok' || row.verify_status === 'dead';
      if (settled || !RETRY_FAILED) done.add(row.opportunity_id);
    } catch { /* skip bad line */ }
  }
  return done;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  }));
}

const isMain = process.argv[1]?.endsWith('verify-opportunities.mts');
if (isMain && !has('no-run')) {
  const done = await loadDone(OUT);
  const all = pending();
  const queue = all.filter((o) => !done.has(o.id)).slice(0, Number.isFinite(LIMIT) ? LIMIT : undefined);

  if (DRY_RUN) {
    console.log(`would verify ${queue.length} opportunities (${all.length} pending, ${done.size} already read)`);
    console.log(`  LLM calls: up to ${Math.min(queue.length, MAX_LLM)}${XAI_KEY ? '' : ' — XAI_API_KEY is empty, would be crawl-only'}`);
    console.log(`  concurrency ${CONCURRENCY}, model ${XAI_MODEL}`);
    process.exit(0);
  }
  if (!XAI_KEY) console.warn('XAI_API_KEY is empty — recording liveness only, nothing will be marked verified');

  mkdirSync(dirname(OUT), { recursive: true });
  const ledger = createWriteStream(OUT, { flags: FORCE ? 'w' : 'a' });
  const sql = createWriteStream(SQL_OUT, { flags: 'w' });
  sql.write('-- generated by scripts/verify-opportunities.mts — do not commit.\n');

  const tally: Record<string, number> = {};
  let n = 0;
  console.log(`verifying ${queue.length} opportunities (skip ${done.size} already read), concurrency ${CONCURRENCY}`);
  await pool(queue, CONCURRENCY, async (opp) => {
    const row = await verifyOne(opp);
    ledger.write(`${JSON.stringify(row)}\n`);
    sql.write(`${rowToSql(row)}\n`);
    tally[row.verify_status] = (tally[row.verify_status] ?? 0) + 1;
    n++;
    if (n % 25 === 0 || n === queue.length) {
      console.log(`progress ${n}/${queue.length} ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')} last=${row.platform}`);
    }
  });
  ledger.end();
  sql.end();
  console.log(`done ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')} · llm calls ${llmCalls}`);
  console.log(`apply with: npx wrangler d1 execute ${DB} --remote --file=${SQL_OUT}`);
}

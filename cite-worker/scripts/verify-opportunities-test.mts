// What a live page read is allowed to change in the catalog.
// No network: rowToSql is pure, and it is the gate that decides whether a row
// gets to call itself verified.
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rowToSql, type VerifyRow } from './verify-opportunities.mts';
import type { PageRead } from '../src/enrich-extract.js';

const here = dirname(fileURLToPath(import.meta.url));

const read = (over: Partial<PageRead> = {}): PageRead => ({
  page_kind: 'submission_form',
  cost_model: 'Free to submit',
  is_free: true,
  paid_upgrade: false,
  requirements: ['product name', 'URL'],
  eligibility: ['live product only'],
  submission_mechanism: 'form',
  reciprocal_link_required: false,
  still_matches_type: true,
  evidence: 'Submission is free.',
  ...over,
});

const row = (over: Partial<VerifyRow> = {}): VerifyRow => ({
  opportunity_id: 'opp_test',
  platform: 'Test Directory',
  url: 'https://test.example/submit',
  final_url: 'https://test.example/submit',
  http_status: 200,
  liveness: 'live',
  verify_status: 'ok',
  read: read(),
  verify_note: null,
  checked_at: '2026-08-21T02:00:00.000Z',
  ...over,
});

// Run the statements against the real schema so a typo in a column name fails here.
const db = new BetterSqlite3(':memory:');
db.exec(readFileSync(join(here, '..', 'schema.sql'), 'utf8'));
db.exec(`INSERT INTO opportunities (id, source, platform, contribution, status, needs_reverification, is_free_confirmed, verification_level)
         VALUES ('opp_test', 'workbook-2026-08', 'Test Directory', 'profile', 'active', 1, 1, 'Automated page scan + secondary source')`);

const apply = (r: VerifyRow) => {
  db.exec(`UPDATE opportunities SET needs_reverification=1, status='active', verified_at=NULL, verify_source=NULL WHERE id='opp_test'`);
  db.exec(rowToSql(r));
  return db.prepare(`SELECT * FROM opportunities WHERE id='opp_test'`).get() as Record<string, unknown>;
};

// --- a good read is what verification means ---
{
  const r = apply(row());
  assert.equal(r.needs_reverification, 0, 'a successful page read clears the template flag');
  assert.match(String(r.verification_level), /^Live page read 2026-08-21$/, 'provenance names the day it was read');
  assert.equal(r.verify_source, 'llm-page-read-v1', 'and how it was read');
  assert.ok(r.verified_at, 'verified_at is stamped');
  assert.equal(r.verified_is_free, 1, 'a backed free claim is recorded');
  assert.deepEqual(JSON.parse(String(r.verified_requirements)), ['product name', 'URL'],
    'the real form requirements replace the class template');
  assert.equal(r.liveness, 'live');
}

// --- an unknown cost must not become a false "paid" ---
{
  const r = apply(row({ read: read({ is_free: null, cost_model: null }) }));
  assert.equal(r.verified_is_free, null, 'unknown stays NULL, not 0');
  assert.equal(r.verified_cost_model, null, 'no cost is recorded when the page did not say');
  assert.equal(r.needs_reverification, 0, 'the read still counts — we did open the page');
}

// --- a dead link is removed from what customers see, but not "verified" ---
{
  const r = apply(row({ verify_status: 'dead', liveness: 'dead', http_status: 404, read: null,
    verify_note: 'Submission URL returned 404 on 2026-08-21.' }));
  assert.equal(r.status, 'watchlist', 'a 404 moves the row off the customer-facing catalog');
  assert.equal(r.needs_reverification, 1, 'a dead page verifies nothing');
  assert.equal(r.verified_at, null, 'and is never stamped as verified');
  assert.match(String(r.verify_note), /404/, 'the reason is recorded for an operator');
}

// --- firewalled is not gone ---
for (const status of [403, 429, 503]) {
  const r = apply(row({ verify_status: 'fetch_failed', liveness: 'blocked', http_status: status, read: null }));
  assert.equal(r.status, 'active', `HTTP ${status} does not demote a live opportunity`);
  assert.equal(r.needs_reverification, 1, `HTTP ${status} leaves the row unverified`);
  assert.equal(r.liveness, 'blocked', 'but the blockage is recorded so we know why');
  assert.ok(r.crawl_checked_at, 'and we know when we last tried');
}

// --- robots refusal changes nothing but the log ---
{
  const r = apply(row({ verify_status: 'robots_blocked', liveness: 'blocked', http_status: null, read: null }));
  assert.equal(r.verified_at, null, 'a site that asked us not to crawl is not verified around');
  assert.equal(r.status, 'active', 'nor is it demoted for it');
}

// --- credentials are never written from a page read ---
{
  const r = apply(row({ read: read({ eligibility: ['must hold a state licence', 'CPA certification required'] }) }));
  assert.equal(r.requires_license, 0, 'a page cannot set the licence gate');
  assert.equal(r.requires_certification, 0, 'nor the certification gate');
  assert.equal(r.requires_membership, 0, 'nor the membership gate');
  assert.match(String(r.verified_eligibility), /state licence/,
    'the stated rule is kept as text for a human to read');
}

// --- the SQL survives hostile text ---
{
  const nasty = "O'Reilly's \"free\" listing; DROP TABLE opportunities;--";
  const r = apply(row({ read: read({ cost_model: nasty }), verify_note: nasty }));
  assert.equal(r.verified_cost_model, nasty, 'quotes and semicolons round-trip intact');
  assert.ok(db.prepare(`SELECT COUNT(*) n FROM opportunities`).get(), 'the table is still there');
}

// --- a reciprocal-link demand found on the page is honoured ---
{
  const r = apply(row({ read: read({ reciprocal_link_required: true }) }));
  assert.equal(r.requires_reciprocal_link, 1, 'a link-back demand read from the page is recorded');
}

console.log('ok: opportunity verification writes');

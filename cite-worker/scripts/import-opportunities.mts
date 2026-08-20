#!/usr/bin/env npx tsx
// Turn the free-backlink research workbook into D1 SQL for the opportunities catalog.
//
//   npx tsx scripts/import-opportunities.mts --in ~/free-backlink-opportunities-2026.xlsx
//   npx wrangler d1 execute cite-v0 --remote --file=data/opportunities.sql
//
// Four sheets describe the same 843 opportunities and join on the opportunity id:
// Master List (facts), Opportunity Matching DB (gates), Submission Requirements
// (what to prepare), Agent Execution Matrix (what stands in the way). Four more
// carry reference data the agent reads while matching.
//
// The workbook repeats its instructions on every row — `Agent Can Do` has ONE
// distinct value across all 843, the requirements blob 19 and the execution blob
// 17, for 70 combinations — so that text is deduped into opportunity_playbooks
// instead of being written out 843 times.
//
// Output holds no private publisher data, but data/ stays gitignored by convention.
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readWorkbook, type Sheet } from './xlsx-read.mts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const inPath = resolve(flag('in') ?? 'data/free-backlink-opportunities-2026.xlsx');
const outPath = resolve(flag('out') ?? 'data/opportunities.sql');
if (!existsSync(inPath)) {
  console.error(`missing ${inPath} — pass --in <workbook.xlsx>`);
  process.exit(1);
}

// ---------- helpers ----------
const q = (v: string | number | null | undefined): string => {
  if (v == null || v === '') return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
};

const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? n : null;
};

/** Workbook gate columns are Yes / No / Conditional / blank. */
const yes = (v: string | undefined): number => (/^yes/i.test(v ?? '') ? 1 : 0);

type Rec = Record<string, string>;

/**
 * Some sheets open with a title banner, so the header is not always row 1.
 * Find the first row containing `hint` and treat it as the header.
 */
function readSheet(sheets: Sheet[], name: string, hint: string): Rec[] {
  const sheet = sheets.find((s) => s.name === name);
  if (!sheet) {
    console.warn(`  ! sheet "${name}" not found — skipped`);
    return [];
  }
  const at = sheet.rows.findIndex((r) => r.includes(hint));
  if (at < 0) {
    console.warn(`  ! header "${hint}" not found in "${name}" — skipped`);
    return [];
  }
  const header = sheet.rows[at];
  const out: Rec[] = [];
  for (const row of sheet.rows.slice(at + 1)) {
    if (row.every((v) => v === '')) continue;
    const rec: Rec = {};
    header.forEach((h, i) => { if (h) rec[h] = row[i] ?? ''; });
    out.push(rec);
  }
  return out;
}

// ---------- classification ----------
/**
 * What the customer actually contributes. This is the axis that merges the
 * workbook with the guest-post rows already in D1 (migration 010).
 */
const ARTICLE = /community\/publishing|press\/editorial|expert source|podcast guest|publishing\/|q&a\/community/i;
const PROGRAM = /ecosystem partner|partner\/service|business awards|startup competition|cloud partners|IT partners|supplier diversity|government suppliers/i;

function contributionOf(type: string): 'article' | 'profile' | 'program' {
  if (ARTICLE.test(type)) return 'article';
  if (PROGRAM.test(type)) return 'program';
  return 'profile';
}

/**
 * "Free" means at least ten different things in this data and 53% of rows are
 * `Unknown — verify`. Only a confirmed-free row may ever be presented as free.
 */
function costOf(model: string): { confidence: string; free: number } {
  const m = model.toLowerCase();
  if (!m || m.startsWith('unknown')) return { confidence: 'unknown', free: 0 };
  if (/^paid|paid-only/.test(m)) return { confidence: 'secondary', free: 0 };
  if (/free/.test(m)) return { confidence: 'secondary', free: 1 };
  return { confidence: 'secondary', free: 0 };
}

/**
 * The source says things like "Claimed dofollow" / "Unknown / visibility-first".
 * Normalise for filtering while keeping the word "claimed" — we never verified it.
 */
function linkClaim(raw: string): string {
  const v = raw.toLowerCase();
  if (!v || v.startsWith('unknown')) return 'unknown';
  if (/dofollow/.test(v)) return 'claimed_dofollow';
  if (/nofollow/.test(v)) return 'claimed_nofollow';
  if (/sponsored/.test(v)) return 'claimed_sponsored';
  if (/ugc/.test(v)) return 'claimed_ugc';
  if (/backlink|listing|profile/.test(v)) return 'claimed_link';
  return 'unknown';
}

const norm = (s: string) => s.toLowerCase().replace(/^www\./, '').trim();

// ---------- read ----------
console.log(`reading ${inPath}`);
const wb = readWorkbook(inPath);
console.log(`  sheets: ${wb.map((s) => s.name).join(' · ')}`);

const master = readSheet(wb, 'Master List', 'ID');
const blocked = readSheet(wb, 'Blocked or Dead', 'ID');
const matching = readSheet(wb, 'Opportunity Matching DB', 'Opportunity ID');
const requirements = readSheet(wb, 'Submission Requirements', 'Opportunity ID');
const execution = readSheet(wb, 'Agent Execution Matrix', 'Opportunity ID');
const plays = readSheet(wb, 'Earned Link Plays', 'Play');
const strategic = readSheet(wb, 'Strategic Opportunities', 'Platform');
const niches = readSheet(wb, 'Niche Coverage', 'Niche');
const fields = readSheet(wb, 'Field & Asset Library', 'Canonical Field');

console.log(`  master ${master.length} · blocked ${blocked.length} · matching ${matching.length} · requirements ${requirements.length} · execution ${execution.length}`);
console.log(`  plays ${plays.length} · strategic ${strategic.length} · niches ${niches.length} · fields ${fields.length}`);

// The opportunity id lives on three sheets; Master List carries a bare integer.
// Join on platform+domain, which is unique in this workbook.
const byKey = new Map<string, string>();
execution.forEach((r, i) => {
  byKey.set(`${norm(r['Platform'])}|${norm(r['Domain'])}`, r['Opportunity ID'] || `opp_${String(i + 1).padStart(4, '0')}`);
});
const index = (rows: Rec[]) => {
  const m = new Map<string, Rec>();
  for (const r of rows) m.set(r['Opportunity ID'], r);
  return m;
};
const matchById = index(matching);
const reqById = index(requirements);
const execById = index(execution);

// ---------- playbooks ----------
// The (execution, requirements) combination IS the playbook. 70 of them cover
// all 843 rows, so an opportunity references one instead of repeating it.
const PLAYBOOK_KEYS = [
  'Automation Level', 'Agent Execution Mode', 'Agent Can Do', 'Human Must Do',
  'Action Recipe', 'Safety / Terms Guardrail', 'Login/Auth', 'CAPTCHA',
  'Email Verification', 'Editorial Approval', 'Likely Blockers',
  'Required Credentials', 'Autonomy Score', 'Recommended Action',
  'Required Form Information', 'Copy to Prepare', 'Assets to Prepare',
  'Eligibility / Proof', 'Customer-Only Inputs', 'Agent Can Infer / Draft',
  'Account & Verification', 'Human Handoff',
];
const playbooks = new Map<string, { id: string; row: Rec }>();

function playbookFor(exec: Rec | undefined, req: Rec | undefined): string | null {
  if (!exec && !req) return null;
  const row: Rec = { ...(exec ?? {}), ...(req ?? {}) };
  const key = PLAYBOOK_KEYS.map((k) => row[k] ?? '').join('␟');
  const hit = playbooks.get(key);
  if (hit) return hit.id;
  const id = `pb_wb_${String(playbooks.size + 1).padStart(2, '0')}`;
  playbooks.set(key, { id, row });
  return id;
}

// ---------- emit ----------
mkdirSync(dirname(outPath), { recursive: true });
const out = createWriteStream(outPath);
out.write('-- generated by scripts/import-opportunities.mts — do not commit.\n');
out.write('-- Apply after migrations/010_opportunities.sql.\n');
// No BEGIN/COMMIT: D1 rejects SQL transaction statements ("please use the
// state.storage.transaction() APIs instead"). wrangler batches the file itself.

let unmatched = 0;
const stats = { article: 0, profile: 0, program: 0, freeConfirmed: 0, needsReverify: 0, watchlist: 0 };

function writeOpportunity(m: Rec, status: 'active' | 'watchlist') {
  const platform = m['Platform'];
  const domain = m['Domain'];
  const key = `${norm(platform)}|${norm(domain)}`;
  const id = byKey.get(key) ?? `opp_x_${norm(platform).replace(/[^a-z0-9]+/g, '_')}`;
  if (!byKey.has(key) && status === 'active') unmatched++;

  const gates = matchById.get(id);
  const req = reqById.get(id);
  const exec = execById.get(id);
  const type = m['Opportunity Type'];
  const contribution = contributionOf(type);
  const cost = costOf(m['Cost Model']);
  // Only a row whose requirements AND source were both officially reviewed can
  // skip re-verification. In the 2026-08 workbook that is exactly one row.
  const needsReverify = /official/i.test(req?.['Requirement Confidence'] ?? '')
    && /official/i.test(m['Verification Level'] ?? '') ? 0 : 1;

  if (status === 'watchlist') stats.watchlist++;
  else {
    stats[contribution]++;
    if (cost.free) stats.freeConfirmed++;
    if (needsReverify) stats.needsReverify++;
  }

  const values = [
    q(id), q('workbook-2026-08'), 'NULL', 'NULL', q(platform), q(domain), q(m['Submission URL']),
    q(contribution), q(type), q(type), q(m['Best For']), q(req?.['Niche'] || gates?.['Niche'] || null),
    q(gates?.['Platform Audience'] || null), q(gates?.['Relevant Industries'] || null),
    q(m['Cost Model']), q(cost.confidence), String(cost.free),
    /^yes/i.test(m['Reciprocal Link?'] ?? '') ? '1' : '0',
    q(linkClaim(m['Link Attribute'] ?? '')), q(gates?.['Primary Benefit'] || null),
    q(m['Verification Level']), q(m['Last Checked']), q(num(m['Priority Score'])), q(m['Priority Tier']),
    String(needsReverify),
    'NULL', 'NULL', 'NULL',
    q(gates?.['Services Allowed'] || null),
    String(yes(gates?.['Software Product Required'])),
    String(yes(gates?.['AI Product Required'])),
    String(yes(gates?.['Open Source Required'])),
    String(yes(gates?.['Working Integration Required'])),
    String(yes(gates?.['Physical/Service Location Required'])),
    String(yes(gates?.['Existing Customers/Reviews Required'])),
    String(yes(gates?.['Launch/New Product Required'])),
    String(yes(gates?.['Strong Visual Quality Required'])),
    String(yes(gates?.['Professional License Required'])),
    String(yes(gates?.['Certification Required'])),
    String(yes(gates?.['Membership/Partner Status Required'])),
    q(gates?.['Eligible Entity Types'] || null),
    q(gates?.['Geographic Eligibility'] || null),
    q(gates?.['Suitable Company Stage'] || null),
    q(gates?.['Hard Exclusions'] || null),
    q(gates?.['Agent Fit Question'] || null),
    'NULL', q(m['Notes / Caveats']), 'NULL',
    q(m['Discovery Source']), q(m['Verification Source']),
    q(num(req?.['Estimated Prep Minutes'])), q(req?.['Requirement Confidence'] || null),
    q(req?.['Requirements Source'] || null), q(req?.['Reusable Agent Prompt'] || null),
    q(playbookFor(exec, req)), q(status), "datetime('now')", "datetime('now')",
  ];

  out.write(`INSERT INTO opportunities (
  id, source, legacy_site_id, related_opportunity_id, platform, domain, submission_url,
  contribution, opportunity_type, opportunity_class, best_for, niche, platform_audience, relevant_industries,
  cost_model, cost_confidence, is_free_confirmed, requires_reciprocal_link,
  link_attribute_claim, primary_benefit,
  verification_level, last_checked, priority_score, priority_tier, needs_reverification,
  dr, traffic, cite_score,
  services_allowed, requires_software, requires_ai, requires_open_source, requires_integration,
  requires_location, requires_customers, requires_launch, requires_visuals,
  requires_license, requires_certification, requires_membership,
  eligible_entity_types, geographic_eligibility, company_stage, hard_exclusions, fit_question,
  contact_email, note, agent_instructions, discovery_source, verification_source,
  prep_minutes, requirement_confidence, requirements_source, agent_prompt,
  playbook_id, status, created_at, updated_at
) VALUES (${values.join(', ')})
ON CONFLICT(id) DO UPDATE SET
  platform=excluded.platform, domain=excluded.domain, submission_url=excluded.submission_url,
  contribution=excluded.contribution, opportunity_type=excluded.opportunity_type,
  cost_model=excluded.cost_model, cost_confidence=excluded.cost_confidence,
  is_free_confirmed=excluded.is_free_confirmed, link_attribute_claim=excluded.link_attribute_claim,
  verification_level=excluded.verification_level, last_checked=excluded.last_checked,
  priority_score=excluded.priority_score, priority_tier=excluded.priority_tier,
  needs_reverification=excluded.needs_reverification, status=excluded.status,
  prep_minutes=excluded.prep_minutes, requirement_confidence=excluded.requirement_confidence,
  requirements_source=excluded.requirements_source, agent_prompt=excluded.agent_prompt,
  playbook_id=excluded.playbook_id, updated_at=datetime('now');\n`);
}

for (const m of master) writeOpportunity(m, 'active');
for (const b of blocked) writeOpportunity(b, 'watchlist');

for (const { id, row } of playbooks.values()) {
  out.write(`INSERT INTO opportunity_playbooks (
  id, automation_level, agent_mode, agent_can_do, human_must_do, action_recipe, safety_guardrail,
  recommended_action, required_form_information, copy_to_prepare, assets_to_prepare,
  eligibility_proof, customer_only_inputs, agent_can_infer,
  account_verification, human_handoff, login_auth, captcha, email_verification,
  editorial_approval, likely_blockers, required_credentials, autonomy_score
) VALUES (${q(id)}, ${q(row['Automation Level'])}, ${q(row['Agent Execution Mode'])}, ${q(row['Agent Can Do'])}, ${q(row['Human Must Do'])}, ${q(row['Action Recipe'])}, ${q(row['Safety / Terms Guardrail'])}, ${q(row['Recommended Action'])}, ${q(row['Required Form Information'])}, ${q(row['Copy to Prepare'])}, ${q(row['Assets to Prepare'])}, ${q(row['Eligibility / Proof'])}, ${q(row['Customer-Only Inputs'])}, ${q(row['Agent Can Infer / Draft'])}, ${q(row['Account & Verification'])}, ${q(row['Human Handoff'])}, ${q(row['Login/Auth'])}, ${q(row['CAPTCHA'])}, ${q(row['Email Verification'])}, ${q(row['Editorial Approval'])}, ${q(row['Likely Blockers'])}, ${q(row['Required Credentials'])}, ${q(num(row['Autonomy Score']))})
ON CONFLICT(id) DO UPDATE SET
  automation_level=excluded.automation_level, agent_mode=excluded.agent_mode,
  agent_can_do=excluded.agent_can_do, human_must_do=excluded.human_must_do,
  action_recipe=excluded.action_recipe, safety_guardrail=excluded.safety_guardrail,
  recommended_action=excluded.recommended_action,
  required_form_information=excluded.required_form_information,
  copy_to_prepare=excluded.copy_to_prepare, assets_to_prepare=excluded.assets_to_prepare,
  eligibility_proof=excluded.eligibility_proof, customer_only_inputs=excluded.customer_only_inputs,
  agent_can_infer=excluded.agent_can_infer, account_verification=excluded.account_verification,
  human_handoff=excluded.human_handoff, login_auth=excluded.login_auth, captcha=excluded.captcha,
  email_verification=excluded.email_verification, editorial_approval=excluded.editorial_approval,
  likely_blockers=excluded.likely_blockers, required_credentials=excluded.required_credentials,
  autonomy_score=excluded.autonomy_score;\n`);
}

// ---------- reference tables ----------
out.write('DELETE FROM earned_link_plays;\n');
for (const p of plays) {
  out.write(`INSERT INTO earned_link_plays (play, what_you_do, cost, reciprocal, likely_link_value, guardrail, where_to_look)
VALUES (${q(p['Play'])}, ${q(p['What You Do'])}, ${q(p['Cost'])}, ${q(p['Reciprocal?'])}, ${q(p['Likely Link Value'])}, ${q(p['Guardrail'])}, ${q(p['Where to Look'])});\n`);
}

for (const s of strategic) {
  const id = `sp_${String(s['ID'] || s['Platform']).replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`;
  out.write(`INSERT OR REPLACE INTO strategic_programs (id, platform, opportunity_class, niche, action, primary_value, cost_model, hard_requirements, best_next_action, agent_mode, human_checkpoint, url, confidence, status)
VALUES (${q(id)}, ${q(s['Platform'])}, ${q(s['Opportunity Class'])}, ${q(s['Niche'])}, ${q(s['Action'])}, ${q(s['Primary Value'])}, ${q(s['Cost Model'])}, ${q(s['Hard Requirements'])}, ${q(s['Best Next Action'])}, ${q(s['Agent Mode'])}, ${q(s['Human Checkpoint'])}, ${q(s['URL'])}, ${q(s['Confidence'])}, ${q(s['Status'])});\n`);
}

for (const n of niches) {
  out.write(`INSERT OR REPLACE INTO niche_coverage (niche, reachable, free_freemium, license_gated, certification_gated, membership_gated, key_hard_gates, example_platforms)
VALUES (${q(n['Niche'])}, ${q(num(n['Reachable Opportunities']))}, ${q(num(n['Free/Freemium']))}, ${q(num(n['License-Gated']))}, ${q(num(n['Certification-Gated']))}, ${q(num(n['Membership-Gated']))}, ${q(n['Key Hard Gates'])}, ${q(n['Example Platforms'])});\n`);
}

for (const f of fields) {
  out.write(`INSERT OR REPLACE INTO field_library (field, data_type, owner, source, guardrail, used_by)
VALUES (${q(f['Canonical Field'])}, ${q(f['Data Type'])}, ${q(f['Owner / Preparation'])}, ${q(f['Source'])}, ${q(f['Validation / Guardrail'])}, ${q(f['Used By'])});\n`);
}

out.end();

console.log(`\nwrote ${outPath}`);
console.log(`  active: ${stats.article} article · ${stats.profile} profile · ${stats.program} program`);
console.log(`  watchlist: ${stats.watchlist}`);
console.log(`  cost confirmed free: ${stats.freeConfirmed} / ${master.length}`);
console.log(`  needs re-verification: ${stats.needsReverify} / ${master.length}`);
console.log(`  playbooks: ${playbooks.size} (deduped from ${execution.length} rows)`);
if (unmatched) console.log(`  ! ${unmatched} master rows had no execution-matrix id — synthesized one`);

#!/usr/bin/env npx tsx
// Merge Grok profiles written in a Cursor chat (or any JSONL) onto crawl rows.
// This is how we use the Cursor × xAI model subscription without an API key:
// the cloud agent writes enrich_prompt_v1 JSON; this script scrubs and stores it.
//
//   npx tsx scripts/apply-llm-profiles.mts --in data/enrich.jsonl --profiles data/llm-profiles.jsonl
//   npx tsx scripts/apply-llm-profiles.mts --in data/enrich.jsonl --profiles data/llm-profiles.jsonl --out data/llm-merged.jsonl
// Use --out while enrich-content.mts is appending: rewriting --in in place races the crawl fd.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { leaksDomain, parseLlmProfile, scrub } from '../src/enrich-extract.js';
import type { EnrichRow } from './enrich-content.mts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const inPath = resolve(flag('in') ?? 'data/enrich.jsonl');
const profilesPath = resolve(flag('profiles') ?? 'data/llm-profiles.jsonl');
const outPath = resolve(flag('out') ?? inPath);

const asProfileJson = (p: Record<string, unknown>): string => JSON.stringify({
  audience: p.audience,
  topics: p.topics,
  tone: p.tone,
  typical_length_words: p.typical_length_words,
  post_shape: p.post_shape,
  do: p.do ?? p.do_fit,
  dont: p.dont ?? p.dont_fit,
  summary_private: p.summary_private,
  summary_public: p.summary_public ?? p.summary,
});

const rows: EnrichRow[] = readFileSync(inPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as EnrichRow);
const byId = new Map(rows.map((r) => [r.site_id, r]));
const appliedRows: EnrichRow[] = [];
let applied = 0;
let skipped = 0;
for (const line of readFileSync(profilesPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const raw = JSON.parse(line) as Record<string, unknown>;
  const id = String(raw.site_id ?? '');
  const row = byId.get(id);
  if (!row) { skipped++; continue; }
  const parsed = parseLlmProfile(asProfileJson(raw), row.domain);
  if (!parsed) { skipped++; continue; }
  const titles = (row.recent_titles || []).map((t) => scrub(t, row.domain)).filter((t) => !leaksDomain(t, row.domain));
  row.summary = parsed.summary_public;
  row.writes_about = parsed.topics;
  row.recent_titles = titles;
  row.audience = parsed.audience || null;
  row.tone = parsed.tone || null;
  row.post_shape = parsed.post_shape || null;
  row.typical_length_words = parsed.typical_length_words;
  row.do_fit = parsed.do || null;
  row.dont_fit = parsed.dont || null;
  row.summary_private = parsed.summary_private || row.summary_private;
  row.enrich_status = 'ok';
  row.source = 'crawl+grok-v1';
  row.enriched_at = new Date().toISOString();
  delete row.error;
  appliedRows.push(row);
  applied++;
}
if (outPath === inPath) {
  console.warn('rewriting --in in place; do not do this while enrich-content is appending');
  writeFileSync(inPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
} else {
  writeFileSync(outPath, appliedRows.map((r) => JSON.stringify(r)).join('\n') + (appliedRows.length ? '\n' : ''));
}
console.log(`applied ${applied} Grok profiles, skipped ${skipped}, wrote ${outPath}`);

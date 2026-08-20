import assert from 'node:assert/strict';
import {
  buyerPublicText,
  crawlSummary,
  extractRssTitles,
  extractTitles,
  leaksDomain,
  parseLlmProfile,
  parseRobots,
  pathDisallowed,
  scrub,
  topicsFrom,
} from '../src/enrich-extract.js';
import { selectSites } from './enrich-content.mts';

const html = `
<title>Finance Weekly — money for operators</title>
<meta name="description" content="Guides on payroll, B2B invoicing, and cash flow.">
<h2>How operators run monthly close</h2>
<h2>Invoice terms that actually get paid</h2>
<h3>A short aside</h3>
`;
const titles = extractTitles(html);
assert(titles.some((t) => /monthly close/i.test(t)), 'extracts h2 headlines');

const rss = `<?xml version="1.0"?><rss><channel><title>Finance Weekly</title>
<item><title>Payroll mistakes that stall hiring</title></item>
<item><title>Why finance leads want shorter close cycles</title></item>
</channel></rss>`;
const rssTitles = extractRssTitles(rss);
assert.equal(rssTitles[0], 'Payroll mistakes that stall hiring');

const topics = topicsFrom(titles, 'Guides on payroll, B2B invoicing, and cash flow.');
assert(topics.includes('payroll') || topics.some((t) => t.includes('invoice')), 'topics from titles + meta');

const domain = 'secretexample.com';
const summary = crawlSummary({
  domain,
  title: 'Secret Example — finance',
  metaDesc: 'Secret Example covers payroll for operators.',
  titles: ['How Secret Example readers close the books'],
});
assert(!/secretexample/i.test(summary), 'crawl summary scrubs the domain');
assert(summary.includes('[site]'), 'scrub replaces the brand token');
assert(leaksDomain('visit secretexample.com today', domain), 'leak detector sees the domain');
assert(!leaksDomain(scrub('visit secretexample.com today', domain), domain), 'scrubbed text does not leak');

{
  const kake = scrub('KAKE delivers Wichita news', 'kake.com');
  assert(!/kake/i.test(kake), 'short SLD brand is scrubbed as a whole word');
  assert(leaksDomain('KAKE delivers Wichita news', 'kake.com'), 'leak detector sees a 4-letter brand token');
  const hyphen = scrub('Visit Secret Example at secret-example.com', 'secret-example.com');
  assert(!/secret-example|secret example/i.test(hyphen), 'hyphenated domain and spaced brand are scrubbed');
  assert(buyerPublicText('Secret Example covers payroll.', 'secret-example.com') === undefined
    || !/secret/i.test(buyerPublicText('Secret Example covers payroll.', 'secret-example.com') || ''),
    'buyerPublicText drops leftover brand');
}

const robots = parseRobots('User-agent: *\nDisallow: /wp-admin/\nDisallow: /');
assert(pathDisallowed('/', robots.disallow), 'Disallow: / blocks the homepage');
assert(pathDisallowed('/wp-admin/edit.php', parseRobots('User-agent: *\nDisallow: /wp-admin/').disallow), 'prefix disallow');
assert(!pathDisallowed('/', parseRobots('User-agent: *\nDisallow: /wp-admin/').disallow), 'admin-only disallow still allows /');

const profile = parseLlmProfile(JSON.stringify({
  audience: 'Operators who read Secret Example for finance ops.',
  topics: ['payroll', 'invoicing', 'cash flow', 'close'],
  tone: 'practitioner',
  typical_length_words: 900,
  post_shape: 'how-to',
  do: 'Include a concrete close-checklist example.',
  dont: 'Do not pitch crypto trading.',
  summary_private: 'Secret Example is a finance publication for operators.',
  summary_public: 'A finance publication for operators covering payroll and close.',
}), domain);
assert(profile, 'parses a valid Grok profile');
assert(profile && !/secretexample/i.test(profile.audience), 'LLM audience is scrubbed');
assert.equal(profile?.typical_length_words, 900);
assert.equal(parseLlmProfile('not json', domain), null, 'rejects garbage');

{
  const ok = parseLlmProfile(JSON.stringify({
    audience: 'Operators.',
    topics: ['payroll', 'invoicing', 'cash flow', 'close'],
    tone: 'practitioner',
    typical_length_words: 900,
    post_shape: 'how-to',
    do: 'Include an example.',
    dont: 'No crypto.',
    summary_private: 'Internal.',
    summary_public: 'A finance publication for operators covering payroll and close.',
  }), 'other.com');
  assert(ok && ok.topics.includes('payroll'), 'apply-llm uses the same Grok JSON shape');
}

// selectSites: resume + windowing. Both of these were real footguns on an 8k run.
{
  const all = [
    { id: 'a', domain: 'a.test', cite_score: 90 },
    { id: 'b', domain: 'b.test', cite_score: 80 },
    { id: 'c', domain: 'c.test', cite_score: 70 },
    { id: 'd', domain: 'd.test', cite_score: 60 },
  ];

  assert.deepEqual(selectSites(all, new Set()).map((s) => s.id), ['a', 'b', 'c', 'd'],
    'highest cite_score first');

  // The regression: with 'a' and 'b' already crawled, --limit 2 must still hand
  // back two fresh sites, not two minus the ones already done.
  assert.deepEqual(selectSites(all, new Set(['a', 'b']), 0, 2).map((s) => s.id), ['c', 'd'],
    'a resumed run with --limit yields a full window of fresh sites');

  assert.deepEqual(selectSites(all, new Set(), 1, 2).map((s) => s.id), ['b', 'c'],
    '--offset skips within the fresh set');
  assert.deepEqual(selectSites(all, new Set(['a', 'b', 'c', 'd'])), [],
    'everything done means nothing to crawl');
  assert.equal(all[0].id, 'a', 'selectSites does not reorder the caller\'s array');
}

console.log('ok: enrich extractors');

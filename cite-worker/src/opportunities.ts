// Free placement opportunities — matching, preparation, and submission state.
//
// The paid side of placement.sh sells a publisher placement. This side finds
// places a customer can get listed, profiled or published for nothing, and does
// the preparation work so a human only has to log in, pass the CAPTCHA and press
// the button.
//
// Two rules run through everything here, both from the research handoff (§10):
//   1. Never present an unverified fact as verified. Cost is unknown on 53% of
//      the catalog and only one row in 843 had its requirements officially
//      reviewed, so every payload carries its confidence and says so.
//   2. Never fabricate proof. Licences, certifications and memberships are only
//      ever "unknown" until a human states otherwise — they are not inferable
//      from a homepage, and guessing one would put a customer's application at
//      risk of being a lie.
import { extractMeta, extractTitles, topicsFrom, visibleText } from './enrich-extract.js';

type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

// ---------- company evidence ----------

/** Hard gates an opportunity can require of a company. */
export const GATE_KEYS = [
  'software', 'ai', 'open_source', 'integration', 'location',
  'customers', 'launch', 'visuals', 'license', 'certification', 'membership',
] as const;
export type GateKey = (typeof GATE_KEYS)[number];

export type Signal = {
  value: 'yes' | 'no' | 'unknown';
  /** observed = read it on the page · stated = a human told us · unknown */
  basis: 'observed' | 'stated' | 'unknown';
  because?: string;
};

export type Evidence = {
  canonical_url: string;
  name?: string;
  summary?: string;
  topics: string[];
  entity_type: 'software' | 'service' | 'ecommerce' | 'media' | 'unknown';
  signals: Record<GateKey, Signal>;
};

const unknownSignal = (): Signal => ({ value: 'unknown', basis: 'unknown' });

/**
 * Credentials a homepage can never establish. The research is explicit that an
 * agent must not invent a licence, certification or membership, so these stay
 * unknown until a human states them.
 */
const HUMAN_ONLY: GateKey[] = ['license', 'certification', 'membership'];

const PATTERNS: Partial<Record<GateKey, { re: RegExp; because: string }>> = {
  software: { re: /\b(saas|web app|platform|dashboard|free trial|sign up free|api docs|our app)\b/i, because: 'the site sells a product you sign up for' },
  ai: { re: /\b(artificial intelligence|machine learning|\bLLM\b|\bAI-(powered|native|driven)\b)/i, because: 'the site describes an AI capability' },
  open_source: { re: /\b(open[- ]source|github\.com\/|\bMIT licen[cs]e\b|\bApache 2\.0\b)/i, because: 'the site points at public source code' },
  integration: { re: /\b(integrat(?:es?|ions?)|zapier|slack app|works with|connect your)\b/i, because: 'the site advertises integrations' },
  customers: { re: /\b(case stud(?:y|ies)|testimonial|trusted by|our customers|success stor)/i, because: 'the site shows customer proof' },
  location: { re: /\b(visit us|our office|showroom|serving (?:the )?[A-Z][a-z]+|\b\d{5}(?:-\d{4})?\b)/, because: 'the site names a physical place' },
};

/** Build an evidence-backed profile from a homepage. Unknown stays unknown. */
export function analyzeCompany(html: string, canonicalUrl: string): Evidence {
  const { title, metaDesc } = extractMeta(html);
  const titles = extractTitles(html);
  const body = visibleText(html, 12000);
  const blob = `${title ?? ''} ${metaDesc ?? ''} ${body}`;

  const signals = Object.fromEntries(GATE_KEYS.map((k) => [k, unknownSignal()])) as Record<GateKey, Signal>;
  for (const key of GATE_KEYS) {
    if (HUMAN_ONLY.includes(key)) continue;
    const p = PATTERNS[key];
    if (!p) continue;
    if (p.re.test(blob)) signals[key] = { value: 'yes', basis: 'observed', because: p.because };
  }
  // og:image is weak evidence of usable brand imagery, and that is all we claim.
  if (/<meta[^>]+property=["']og:image["']/i.test(html)) {
    signals.visuals = { value: 'yes', basis: 'observed', because: 'the site publishes a social share image' };
  }

  const entity_type: Evidence['entity_type'] =
    signals.software.value === 'yes' ? 'software'
      : /\b(shop|store|cart|add to basket|free shipping)\b/i.test(blob) ? 'ecommerce'
        : /\b(we help|our (?:team|agency|service)|consultan|managed service|outsourc)/i.test(blob) ? 'service'
          : /\b(magazine|newsroom|our writers|subscribe to our newsletter)\b/i.test(blob) ? 'media'
            : 'unknown';

  return {
    canonical_url: canonicalUrl,
    name: title?.split(/[|·—-]/)[0].trim() || undefined,
    summary: metaDesc ?? undefined,
    topics: topicsFrom(titles, metaDesc, body.slice(0, 4000)),
    entity_type,
    signals,
  };
}

/** Merge facts a human stated. Only these may set a credential gate. */
export function withStated(evidence: Evidence, stated: Row | undefined): Evidence {
  if (!stated) return evidence;
  const signals = { ...evidence.signals };
  for (const key of GATE_KEYS) {
    const v = stated[key];
    if (v === undefined || v === null) continue;
    signals[key] = {
      value: v ? 'yes' : 'no',
      basis: 'stated',
      because: 'the customer confirmed this',
    };
  }
  return { ...evidence, signals };
}

export const unknownAttributes = (e: Evidence): GateKey[] =>
  GATE_KEYS.filter((k) => e.signals[k].value === 'unknown');

// ---------- matching ----------

const GATE_COLUMN: Record<GateKey, string> = {
  software: 'requires_software',
  ai: 'requires_ai',
  open_source: 'requires_open_source',
  integration: 'requires_integration',
  location: 'requires_location',
  customers: 'requires_customers',
  launch: 'requires_launch',
  visuals: 'requires_visuals',
  license: 'requires_license',
  certification: 'requires_certification',
  membership: 'requires_membership',
};

const GATE_LABEL: Record<GateKey, string> = {
  software: 'a software product',
  ai: 'an AI product',
  open_source: 'an open-source project',
  integration: 'a working integration',
  location: 'a physical or service location',
  customers: 'existing customers or reviews',
  launch: 'a new or unlaunched product',
  visuals: 'strong visual assets',
  license: 'a professional licence',
  certification: 'a certification',
  membership: 'a membership or partner status',
};

export type Verdict = {
  eligible: boolean;
  score: number;
  reasons: string[];
  missing_inputs: string[];
  suppression_reason?: string;
};

/**
 * Hard exclusions first, then score — never the other way round (handoff §8).
 * An unmet gate suppresses the row; an *unknown* gate suppresses it too, but
 * surfaces as a missing input so the agent knows what to go and ask.
 */
export function judge(opp: Row, evidence: Evidence | null): Verdict {
  const reasons: string[] = [];
  const missing: string[] = [];

  if (evidence) {
    for (const key of GATE_KEYS) {
      if (!opp[GATE_COLUMN[key]]) continue;
      const signal = evidence.signals[key];
      if (signal.value === 'yes') {
        reasons.push(`needs ${GATE_LABEL[key]} — ${signal.basis === 'stated' ? 'you confirmed it' : signal.because ?? 'found on your site'}`);
        continue;
      }
      const why = signal.value === 'no'
        ? `requires ${GATE_LABEL[key]}, which this company does not have`
        : `requires ${GATE_LABEL[key]} and we could not confirm it from the site`;
      if (signal.value === 'unknown') missing.push(`Does the company have ${GATE_LABEL[key]}?`);
      return { eligible: false, score: 0, reasons, missing_inputs: missing, suppression_reason: why };
    }
    if (str(opp.services_allowed) === 'No' && evidence.entity_type === 'service') {
      return {
        eligible: false, score: 0, reasons, missing_inputs: missing,
        suppression_reason: 'this platform lists products, not service businesses',
      };
    }
  }

  // Transparent, explainable scoring — no hidden weights.
  const f = facts(opp);
  let score = (int(opp.priority_score) ?? 40) * 0.5;
  if (f.verified) { score += 10; reasons.push(`requirements ${f.verifiedHow}`); }
  if (f.isFree) {
    score += 15;
    reasons.push(f.verified ? 'the live page states a free path' : 'cost confirmed free or freemium');
  } else if (f.verified) {
    score -= 15;
    reasons.push('the live page shows no free path');
  }
  if (!f.verified && str(opp.cost_confidence) === 'unknown') { score -= 10; reasons.push('cost not established — verify on the live page before working on it'); }
  if (opp.requires_reciprocal_link) { score -= 8; reasons.push('a reciprocal link back is expected'); }
  if (opp.needs_reverification) { score -= 5; }
  if (f.caution) reasons.push(f.caution);

  if (evidence) {
    const haystack = `${str(opp.relevant_industries) ?? ''} ${str(opp.niche) ?? ''} ${str(opp.platform_audience) ?? ''} ${str(opp.best_for) ?? ''}`.toLowerCase();
    const hit = evidence.topics.find((t) => t.length > 4 && haystack.includes(t));
    if (hit) { score += 12; reasons.push(`audience overlaps with what the site is about ("${hit}")`); }
  }
  const autonomy = int(opp.autonomy_score);
  if (autonomy !== undefined) score += autonomy * 0.15;

  return {
    eligible: true,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    missing_inputs: missing,
  };
}

// ---------- verified facts vs the class template ----------
// Migration 011 added what a live page read found, per row. The workbook's
// playbook describes a CLASS of opportunity; a verified row describes this one.
// Verified always wins, and every payload says which it answered from — an agent
// should treat "we read the page in August" and "platforms like this usually
// want" very differently.

const parseJsonList = (v: unknown): string[] => {
  if (!v) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};

export type Facts = {
  verified: boolean;
  verifiedOn?: string;
  /** How it was verified, in words an agent can pass to a human. */
  verifiedHow?: string;
  isFree: boolean;
  costModel?: string;
  requirements: string[];
  eligibility: string[];
  mechanism?: string;
  caution?: string;
};

export function facts(opp: Row): Facts {
  const verifiedAt = str(opp.verified_at);
  const source = str(opp.verify_source);
  const on = verifiedAt?.slice(0, 10);
  return {
    verified: !!verifiedAt,
    verifiedOn: on,
    verifiedHow: !verifiedAt ? undefined
      : source === 'operator' ? `confirmed by a placement.sh operator on ${on}`
        : source === 'llm-page-read-v1' ? `read from the live page on ${on}`
          : `verified on ${on}`,
    // A verified read wins even when it says "not free" — that is the whole point.
    isFree: opp.verified_is_free != null ? !!opp.verified_is_free : !!opp.is_free_confirmed,
    costModel: str(opp.verified_cost_model) ?? str(opp.cost_model),
    requirements: parseJsonList(opp.verified_requirements),
    eligibility: parseJsonList(opp.verified_eligibility),
    mechanism: str(opp.verified_submission_mechanism),
    caution: str(opp.verify_note),
  };
}

// ---------- public serialization ----------
// contact_email, note, agent_instructions and the source URLs are operator-only
// and must never reach /mcp. This is a whitelist, like the paid side's `pub()`.

const costLine = (opp: Row): string => {
  const f = facts(opp);
  const model = f.costModel ?? 'not established';
  if (f.verified) {
    return f.isFree
      ? `${model} — ${f.verifiedHow}`
      : `${model} — ${f.verifiedHow}; there is no free path`;
  }
  if (opp.is_free_confirmed) return `${model} (from a secondary source — re-check the live page)`;
  if (str(opp.cost_confidence) === 'unknown') return `${model} — treat as unknown until the live page is checked`;
  return model;
};

export function publicOpportunity(opp: Row, verdict?: Verdict): Row {
  const base: Row = {
    opportunity_id: opp.id,
    platform: opp.platform,
    url: opp.submission_url ?? opp.domain,
    contribution: opp.contribution,
    opportunity_type: opp.opportunity_type,
    best_for: opp.best_for,
    niche: opp.niche || undefined,
    cost: costLine(opp),
    cost_confidence: facts(opp).verified ? 'read from the live page' : opp.cost_confidence,
    is_free_confirmed: facts(opp).isFree,
    facts_from: facts(opp).verifiedHow
      ?? 'class template — open the submission URL and confirm before doing the work',
    requires_reciprocal_link: !!opp.requires_reciprocal_link,
    link_attribute_claim: opp.link_attribute_claim ?? 'unknown',
    expected_benefit: opp.primary_benefit || undefined,
    verification_level: opp.verification_level,
    last_checked: opp.last_checked || undefined,
    needs_reverification: !!opp.needs_reverification,
    caution: facts(opp).caution,
    tier: opp.priority_tier,
    estimated_prep_minutes: int(opp.prep_minutes),
  };
  if (verdict) {
    base.score = verdict.score;
    base.why_fit = verdict.reasons;
    if (verdict.missing_inputs.length) base.missing_inputs = verdict.missing_inputs;
  }
  return base;
}

/** Full record for get_opportunity: adds the class playbook and the gate prose. */
export function publicOpportunityDetail(opp: Row, playbook: Row | null, verdict?: Verdict): Row {
  return {
    ...publicOpportunity(opp, verdict),
    eligibility: {
      eligible_entity_types: opp.eligible_entity_types || undefined,
      services_allowed: opp.services_allowed || undefined,
      geography: opp.geographic_eligibility || undefined,
      company_stage: opp.company_stage || undefined,
      hard_exclusions: opp.hard_exclusions || undefined,
      requires: GATE_KEYS.filter((k) => opp[GATE_COLUMN[k]]).map((k) => GATE_LABEL[k]),
      question_to_answer_first: opp.fit_question || undefined,
    },
    preparation_source: facts(opp).requirements.length
      ? facts(opp).verifiedHow
      : 'a class template covering platforms of this kind — confirm against the live form',
    verified_requirements: facts(opp).requirements.length ? facts(opp).requirements : undefined,
    verified_eligibility: facts(opp).eligibility.length ? facts(opp).eligibility : undefined,
    how_to_submit: facts(opp).mechanism,
    preparation: playbook ? {
      recommended_action: playbook.recommended_action,
      required_form_information: playbook.required_form_information,
      copy_to_prepare: playbook.copy_to_prepare,
      assets_to_prepare: playbook.assets_to_prepare,
      eligibility_proof: playbook.eligibility_proof,
      customer_only_inputs: playbook.customer_only_inputs,
      agent_can_infer: playbook.agent_can_infer,
    } : undefined,
    execution: playbook ? {
      automation_level: playbook.automation_level,
      agent_mode: playbook.agent_mode,
      agent_can_do: playbook.agent_can_do,
      human_must_do: playbook.human_must_do,
      action_recipe: playbook.action_recipe,
      login_auth: playbook.login_auth,
      captcha: playbook.captcha,
      email_verification: playbook.email_verification,
      editorial_approval: playbook.editorial_approval,
      likely_blockers: playbook.likely_blockers,
      required_credentials: playbook.required_credentials,
      safety_guardrail: playbook.safety_guardrail,
    } : undefined,
    agent_prompt: opp.agent_prompt || undefined,
    caveats: [
      facts(opp).verified
        ? `These requirements were ${facts(opp).verifiedHow}. Pages change — glance at the form before you fill it in.`
        : 'These requirements come from a class template, not from this platform\'s live form. Open the submission URL and confirm before doing the work.',
      'The link attribute is what the source claimed, not something we verified. Record what the live page actually renders.',
      'Nobody can promise approval, indexing, or traffic here.',
      facts(opp).caution,
    ].filter(Boolean),
  };
}

// ---------- preparation ----------

const splitList = (v: unknown): string[] =>
  str(v)?.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean) ?? [];

export type Packet = {
  opportunity_id: string;
  platform: string;
  submission_url?: string;
  fields_from: string;
  recommended_action?: string;
  fields: { field: string; value?: string; source: string }[];
  copy_to_write: string[];
  assets_to_prepare: string[];
  missing_inputs: string[];
  human_must_do: string[];
  agent_prompt?: string;
  guardrails: string[];
};

/**
 * Build the submission packet. The Worker is not a writer — it returns the exact
 * spec (fields, lengths, assets) plus everything the evidence already answers,
 * and names what is still missing. The calling agent writes the copy.
 * Preparation never submits.
 */
export function preparePacket(opp: Row, playbook: Row | null, evidence: Evidence): Packet {
  const known: Record<string, string | undefined> = {
    'canonical company/product name': evidence.name,
    'canonical https url': evidence.canonical_url,
    'contact email': undefined,   // never inferred — it is the customer's to give
    'primary category': undefined,
    'one-sentence value proposition': evidence.summary,
    'short description': evidence.summary,
  };

  // A page we actually read beats a template describing platforms of this kind.
  const f = facts(opp);
  const required = f.requirements.length ? f.requirements : splitList(playbook?.required_form_information);
  const fields = required.map((field) => {
    const value = known[field.toLowerCase()];
    return value
      ? { field, value, source: 'read from the site' }
      : { field, source: 'needs drafting or the customer' };
  });

  const missing = fields.filter((f) => !f.value).map((f) => f.field);
  for (const key of unknownAttributes(evidence)) {
    if (opp[GATE_COLUMN[key]]) missing.push(GATE_LABEL[key]);
  }

  return {
    opportunity_id: String(opp.id),
    platform: String(opp.platform),
    submission_url: str(opp.final_url) ?? str(opp.submission_url),
    fields_from: f.requirements.length
      ? `the real form — ${f.verifiedHow}`
      : 'a class template — confirm against the real form before you fill it in',
    recommended_action: str(playbook?.recommended_action),
    fields,
    copy_to_write: splitList(playbook?.copy_to_prepare),
    assets_to_prepare: splitList(playbook?.assets_to_prepare),
    missing_inputs: [...new Set(missing)],
    human_must_do: splitList(playbook?.human_handoff).concat(splitList(playbook?.customer_only_inputs)),
    agent_prompt: str(opp.agent_prompt),
    guardrails: [
      f.caution,
      str(playbook?.safety_guardrail) ?? 'Never bypass a CAPTCHA, impersonate a user, or submit a misleading listing.',
      'Do not claim a licence, certification, membership, customer count or award the customer has not confirmed.',
      'Search for an existing listing before creating one — claim or improve it instead of duplicating.',
      'Preparation is not submission. A human logs in and presses the button.',
    ].filter(Boolean) as string[],
  };
}

// ---------- submission state ----------

export const SUBMISSION_STATES = [
  'matched', 'prepared', 'submitted', 'pending', 'live', 'rejected', 'skipped', 'needs_human',
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/** Observed link behaviour on a live listing — never the claim, always the render. */
export function observeLink(html: string, targetUrl: string): { found: boolean; rel: string | null; indexable: boolean } {
  const host = targetUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const anchor = new RegExp(`<a\\b[^>]*href=["'][^"']*${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*["'][^>]*>`, 'i');
  const m = html.match(anchor);
  const noindex = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html);
  return {
    found: !!m,
    rel: m ? (/\brel=["']([^"']+)["']/i.exec(m[0])?.[1] ?? 'none') : null,
    indexable: !noindex,
  };
}

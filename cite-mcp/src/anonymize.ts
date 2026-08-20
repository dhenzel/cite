import { createHash, randomBytes } from 'node:crypto';

// Opaque site handle. Salted at import time so handles cannot be recomputed
// from a domain list by an outsider; the salt lives only in the local DB dir.
export function mintHandle(domain: string, salt: string): string {
  const h = createHash('sha256').update(salt + domain.toLowerCase()).digest('hex');
  return `cs_${h.slice(0, 12)}`;
}

export function newSalt(): string {
  return randomBytes(16).toString('hex');
}

// Scrub brand/domain identifiers from enrichment text so content summaries
// can't defeat blind placements. Removes the registered name, its tokens, and
// bare-domain mentions.
export function scrub(text: string, domain: string): string {
  const root = domain.toLowerCase().replace(/^www\./, '');
  const base = root.split('.')[0];
  let out = text;
  // full domain, with or without www / scheme
  out = out.replace(new RegExp(`(https?://)?(www\\.)?${escapeRe(root)}`, 'gi'), '[site]');
  // brand token (e.g. "fashionablehousewife" from thefashionablehousewife.com)
  if (base.length >= 5) {
    out = out.replace(new RegExp(escapeRe(base), 'gi'), '[site]');
    // camel/space-separated variant: "the fashionable housewife" won't match the
    // token; cheap heuristic — collapse spaces and compare
    const spaced = out.replace(/\s+/g, '').toLowerCase();
    if (spaced.includes(base)) {
      // fall back to flagging rather than risking a leak
      out = out.replace(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g, (m) =>
        m.replace(/\s+/g, '').toLowerCase() === base ? '[site]' : m,
      );
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

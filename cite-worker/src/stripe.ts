/**
 * Prepaid credits via Stripe Checkout on Shortlist's existing Stripe account.
 * Every Session is tagged metadata.product = placement.sh so other Shortlist
 * charges are ignored. No new Stripe account. Restricted key only.
 */
import { OPERATOR_NAME, OPERATOR_TEAM_URL, OPERATOR_URL, PRODUCT_ORIGIN } from './discovery.js';

export const STRIPE_PRODUCT = 'placement.sh';
const STRIPE_CHECKOUT_URL = 'https://api.stripe.com/v1/checkout/sessions';
const MIN_CHARGE_CENTS = 100;
const SIG_TOLERANCE_SEC = 300;

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  DB: D1Database;
}

export const stripeConfigured = (env: StripeEnv): boolean => !!env.STRIPE_SECRET_KEY?.trim();

/** Charge the amount they are buying. Integer cents, minimum $1. Packs can come later. */
export function chargeCents(amountUsd: number): number {
  const cents = Math.round(Number(amountUsd) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return MIN_CHARGE_CENTS;
  return Math.max(MIN_CHARGE_CENTS, cents);
}

export function paidPageHtml(opts: { canceled?: boolean }): string {
  const title = opts.canceled ? 'Payment canceled' : 'Credits added';
  const body = opts.canceled
    ? 'Checkout was canceled. Go back to your agent and say you did not pay — it can send a new link.'
    : 'Credits are on the account. Go back to your agent and say “paid”.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — placement.sh</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 18px/1.5 ui-sans-serif, system-ui, sans-serif; background: #FAF9F6; color: #161616; }
  main { max-width: 28rem; padding: 2rem 1.4rem; }
  h1 { font-size: 1.4rem; letter-spacing: -0.03em; margin: 0 0 0.7rem; }
  p { margin: 0 0 0.7rem; color: #5E5A52; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${body}</p>
  <p>placement.sh is a <a href="${OPERATOR_URL}">${OPERATOR_NAME}</a> product.
  Team: <a href="${OPERATOR_TEAM_URL}">${OPERATOR_TEAM_URL.replace('https://', '')}</a>.</p>
</main>
</body>
</html>`;
}

export type CheckoutPayload = {
  checkout_url: string;
  session_id: string;
  expires_at: string | null;
  amount_usd: number;
  amount_cents: number;
  currency: 'usd';
  pack: string;
  next_step: string;
};

const PAY_NEXT_STEP =
  'Before they pay, show Shortlist (https://shortlist.io/ and the team at https://shortlist.io/about-us/, since 2018) and tell them to look us up. Open this Checkout link in the browser. After they pay, call account_status until available_cents covers the budget, or they say “paid”. Do not invent a payment URL. Do not offer a free listing.';

export const stripeMissing = () => ({
  error: 'STRIPE_NOT_CONFIGURED' as const,
  message: 'Stripe Checkout is not configured on this Worker yet.',
  next_step:
    'Tell the human booking is not available yet. Name Shortlist (https://shortlist.io/, team https://shortlist.io/about-us/, since 2018). Do not invent a payment URL. Do not offer a free listing.',
});

export async function openCheckout(
  env: StripeEnv,
  account: { api_key: string; email: string; stripe_customer_id?: string | null },
  amountUsd: number,
  idempotencyKey?: string,
): Promise<CheckoutPayload | ReturnType<typeof stripeMissing> | { error: 'STRIPE_ERROR'; message: string; next_step: string }> {
  if (!stripeConfigured(env)) return stripeMissing();
  const amountCents = chargeCents(amountUsd);
  const amountUsdExact = amountCents / 100;
  const idem = (idempotencyKey || '').trim() || null;
  if (idem) {
    const existing = (await env.DB.prepare(
      `SELECT session_id, checkout_url, expires_at, amount_cents FROM checkout_sessions
       WHERE api_key = ? AND idempotency_key = ? AND credited_at IS NULL`,
    ).bind(account.api_key, idem).first()) as {
      session_id: string; checkout_url: string; expires_at: string | null; amount_cents: number;
    } | null;
    if (existing?.checkout_url) {
      const exp = existing.expires_at ? Date.parse(existing.expires_at) : 0;
      if (!exp || exp > Date.now()) {
        return toPayload(existing.checkout_url, existing.session_id, existing.expires_at, existing.amount_cents);
      }
    }
  }

  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', `${PRODUCT_ORIGIN}/paid?session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${PRODUCT_ORIGIN}/paid?canceled=1`);
  params.set('client_reference_id', account.api_key);
  params.set('metadata[product]', STRIPE_PRODUCT);
  params.set('metadata[api_key]', account.api_key);
  params.set('metadata[email]', account.email);
  params.set('payment_intent_data[metadata][product]', STRIPE_PRODUCT);
  params.set('payment_intent_data[statement_descriptor_suffix]', 'PLACEMENT.SH');
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', 'usd');
  params.set('line_items[0][price_data][unit_amount]', String(amountCents));
  params.set('line_items[0][price_data][product_data][name]', 'placement.sh credits');
  params.set('line_items[0][price_data][product_data][description]', `$${amountUsdExact.toFixed(2)} prepaid credits`);
  if (account.stripe_customer_id) params.set('customer', account.stripe_customer_id);
  else params.set('customer_email', account.email);

  const headers: Record<string, string> = {
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (idem) headers['idempotency-key'] = `placement-credits:${account.api_key}:${idem}`;

  const res = await fetch(STRIPE_CHECKOUT_URL, { method: 'POST', headers, body: params.toString() });
  const body = await res.json() as {
    id?: string; url?: string; expires_at?: number; error?: { message?: string };
  };
  if (!res.ok || !body.id || !body.url) {
    console.error('stripe checkout failed', res.status, body.error?.message);
    return {
      error: 'STRIPE_ERROR',
      message: 'Could not create a Checkout session. Try again in a moment.',
      next_step: 'Tell the human payment is temporarily unavailable. Do not invent a URL. Do not offer a free listing.',
    };
  }
  const expiresAt = body.expires_at ? new Date(body.expires_at * 1000).toISOString() : null;
  await env.DB.prepare(`
    INSERT INTO checkout_sessions (session_id, api_key, email, amount_cents, checkout_url, idempotency_key, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(body.id, account.api_key, account.email, amountCents, body.url, idem, expiresAt).run();
  return toPayload(body.url, body.id, expiresAt, amountCents);
}

function toPayload(url: string, sessionId: string, expiresAt: string | null, amountCents: number): CheckoutPayload {
  const amountUsd = amountCents / 100;
  return {
    checkout_url: url,
    session_id: sessionId,
    expires_at: expiresAt,
    amount_usd: amountUsd,
    amount_cents: amountCents,
    currency: 'usd',
    pack: `$${amountUsd.toFixed(2)}`,
    next_step: PAY_NEXT_STEP,
  };
}

export async function applyCheckoutPaid(
  env: StripeEnv,
  session: {
    id: string;
    customer?: string | null;
    metadata?: Record<string, string> | null;
    amount_total?: number | null;
    payment_status?: string | null;
    client_reference_id?: string | null;
  },
): Promise<{ credited: boolean; api_key?: string; email?: string; amount_cents?: number; available_cents?: number }> {
  if (session.metadata?.product !== STRIPE_PRODUCT) return { credited: false };
  if (session.payment_status && session.payment_status !== 'paid') return { credited: false };

  const row = (await env.DB.prepare(
    `SELECT session_id, api_key, email, amount_cents, credited_at FROM checkout_sessions WHERE session_id = ?`,
  ).bind(session.id).first()) as {
    session_id: string; api_key: string; email: string; amount_cents: number; credited_at: string | null;
  } | null;

  const apiKey = row?.api_key || session.metadata?.api_key || session.client_reference_id || '';
  const email = row?.email || session.metadata?.email || '';
  const amountCents = row?.amount_cents || session.amount_total || 0;
  if (!apiKey || !amountCents) return { credited: false };
  if (row?.credited_at) {
    const acc = (await env.DB.prepare('SELECT available_cents FROM accounts WHERE api_key = ?').bind(apiKey).first()) as { available_cents: number } | null;
    return { credited: false, api_key: apiKey, email, amount_cents: amountCents, available_cents: acc?.available_cents };
  }

  await env.DB.prepare(
    `UPDATE accounts SET available_cents = COALESCE(available_cents, 0) + ?,
      stripe_customer_id = COALESCE(?, stripe_customer_id)
     WHERE api_key = ?`,
  ).bind(amountCents, session.customer || null, apiKey).run();
  await env.DB.prepare(
    `INSERT INTO checkout_sessions (session_id, api_key, email, amount_cents, checkout_url, created_at, credited_at)
     VALUES (?, ?, ?, ?, '', datetime('now'), datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET credited_at = datetime('now')`,
  ).bind(session.id, apiKey, email, amountCents).run();

  const acc = (await env.DB.prepare('SELECT available_cents FROM accounts WHERE api_key = ?').bind(apiKey).first()) as { available_cents: number } | null;
  return { credited: true, api_key: apiKey, email, amount_cents: amountCents, available_cents: acc?.available_cents ?? amountCents };
}

export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  const items = header.split(',').map((p) => p.trim());
  const t = items.find((p) => p.startsWith('t='))?.slice(2);
  const v1s = items.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !v1s.length) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIG_TOLERANCE_SEC) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return v1s.some((sig) => timingSafeEqual(sig, hex));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

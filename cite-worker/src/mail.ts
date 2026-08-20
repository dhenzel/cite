/**
 * Buyer transactional mail. From/Reply-To is placement@shortlist.io (Shortlist
 * Google Workspace). Never hello@placement.sh, never Cloudflare Email Sending.
 *
 * Transport: Gmail API if GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN are set (the
 * refresh token must belong to placement@shortlist.io or a user with send-as
 * on that address). Else Resend if RESEND_API_KEY is set and shortlist.io is
 * verified there. If neither is configured, send is a no-op — signup still
 * succeeds. Failures never throw to the MCP caller.
 */
import {
  BUYER_MAIL_FROM, BUYER_MAIL_FROM_NAME, OPERATOR_NAME, OPERATOR_TEAM_URL, OPERATOR_URL,
  PRODUCT_ORIGIN,
} from './discovery.js';

export interface MailEnv {
  MAIL_FROM?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  RESEND_API_KEY?: string;
  CITE_ADMIN_EMAILS?: string;
}

export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
}

const GMAIL_TOKEN = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const RESEND_SEND = 'https://api.resend.com/emails';

export const mailFromAddress = (env: MailEnv): string =>
  (env.MAIL_FROM || BUYER_MAIL_FROM).trim() || BUYER_MAIL_FROM;

export const mailFromHeader = (env: MailEnv): string =>
  `"${BUYER_MAIL_FROM_NAME}" <${mailFromAddress(env)}>`;

export const mailConfigured = (env: MailEnv): boolean =>
  gmailReady(env) || !!env.RESEND_API_KEY?.trim();

const gmailReady = (env: MailEnv): boolean =>
  !!(env.GMAIL_CLIENT_ID?.trim() && env.GMAIL_CLIENT_SECRET?.trim() && env.GMAIL_REFRESH_TOKEN?.trim());

/** Run mail after the MCP response is on the wire. Await only when there is no ctx (tests). */
export async function scheduleMail(ctx: WaitUntil | undefined, work: () => Promise<void>): Promise<void> {
  const p = work().catch((err) => {
    console.error('placement mail failed', err);
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(p);
    return;
  }
  await p;
}

export function opsNotifyAddresses(env: MailEnv, buyerEmail: string): string[] {
  const from = mailFromAddress(env).toLowerCase();
  const extras = (env.CITE_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const set = new Set<string>([from, ...extras]);
  set.delete(buyerEmail.trim().toLowerCase());
  return [...set];
}

export function welcomeMail(env: MailEnv, buyerEmail: string): OutboundMail {
  return {
    to: buyerEmail,
    subject: 'Your placement.sh account is ready',
    text: [
      `You have an account on placement.sh for ${buyerEmail}.`,
      ``,
      `placement.sh is a ${OPERATOR_NAME} product. ${OPERATOR_NAME} has bought publisher placements since 2018.`,
      `Company: ${OPERATOR_URL}`,
      `Team: ${OPERATOR_TEAM_URL}`,
      ``,
      `Add the MCP to your agent:`,
      `  claude mcp add --transport http placement https://mcp.placement.sh/mcp`,
      `  hermes mcp add placement --url https://mcp.placement.sh/mcp`,
      ``,
      `Looking at publishers is free and needs no card. Booking uses prepaid credits.`,
      `Ask your agent to call add_credits, then open the Stripe Checkout link. We email you from this address when credits land.`,
      ``,
      `Questions? Reply to this message.`,
      ``,
      `—`,
      `placement.sh · a ${OPERATOR_NAME} product`,
      mailFromAddress(env),
      PRODUCT_ORIGIN,
    ].join('\n'),
  };
}

export function opsSignupMail(env: MailEnv, buyerEmail: string): OutboundMail {
  return {
    to: '', // filled per recipient
    subject: `[placement.sh] new buyer signup: ${buyerEmail}`,
    text: [
      `A buyer registered via MCP register_account.`,
      ``,
      `email: ${buyerEmail}`,
      `at: ${new Date().toISOString()}`,
      ``,
      `API keys stay in the Worker response, not in this mail.`,
    ].join('\n'),
  };
}

export async function notifyAccountCreated(env: MailEnv, buyerEmail: string): Promise<void> {
  if (!mailConfigured(env)) return;
  const jobs: Promise<void>[] = [sendMailBestEffort(env, welcomeMail(env, buyerEmail))];
  const opsBody = opsSignupMail(env, buyerEmail);
  for (const to of opsNotifyAddresses(env, buyerEmail)) {
    jobs.push(sendMailBestEffort(env, { ...opsBody, to }));
  }
  await Promise.all(jobs);
}

export function creditsAddedMail(
  env: MailEnv,
  buyerEmail: string,
  amountCents: number,
  availableCents: number,
): OutboundMail {
  const usd = (n: number) => `$${(n / 100).toFixed(2)}`;
  return {
    to: buyerEmail,
    subject: `${usd(amountCents)} credits added to your placement.sh account`,
    text: [
      `${usd(amountCents)} in prepaid credits was added to ${buyerEmail}.`,
      ``,
      `Available now: ${usd(availableCents)}.`,
      `Go back to your agent and say “paid”.`,
      ``,
      `placement.sh is a ${OPERATOR_NAME} product. ${OPERATOR_NAME} has bought publisher placements since 2018.`,
      `Company: ${OPERATOR_URL}`,
      `Team: ${OPERATOR_TEAM_URL}`,
      ``,
      `Questions? Reply to this message.`,
      ``,
      `—`,
      `placement.sh · a ${OPERATOR_NAME} product`,
      mailFromAddress(env),
      PRODUCT_ORIGIN,
    ].join('\n'),
  };
}

export async function notifyCreditsAdded(
  env: MailEnv,
  buyerEmail: string,
  amountCents: number,
  availableCents: number,
): Promise<void> {
  if (!mailConfigured(env) || !buyerEmail) return;
  await sendMailBestEffort(env, creditsAddedMail(env, buyerEmail, amountCents, availableCents));
}

export async function sendMailBestEffort(env: MailEnv, mail: OutboundMail): Promise<void> {
  try {
    if (gmailReady(env)) {
      await sendViaGmail(env, mail);
      return;
    }
  } catch (err) {
    console.error('gmail send failed', mail.to, err);
  }
  try {
    if (env.RESEND_API_KEY?.trim()) {
      await sendViaResend(env, mail);
    }
  } catch (err) {
    console.error('resend send failed', mail.to, err);
  }
}

async function sendViaGmail(env: MailEnv, mail: OutboundMail): Promise<void> {
  const token = await gmailAccessToken(env);
  const raw = utf8ToBase64Url(rfc2822(env, mail));
  const res = await fetch(GMAIL_SEND, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail ${res.status} ${detail.slice(0, 300)}`);
  }
}

async function gmailAccessToken(env: MailEnv): Promise<string> {
  const res = await fetch(GMAIL_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID!,
      client_secret: env.GMAIL_CLIENT_SECRET!,
      refresh_token: env.GMAIL_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail token ${res.status} ${detail.slice(0, 300)}`);
  }
  const body = await res.json() as { access_token?: string };
  if (!body.access_token) throw new Error('gmail token missing access_token');
  return body.access_token;
}

async function sendViaResend(env: MailEnv, mail: OutboundMail): Promise<void> {
  const from = mailFromAddress(env);
  const res = await fetch(RESEND_SEND, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: mailFromHeader(env),
      to: [mail.to],
      reply_to: from,
      subject: mail.subject,
      text: mail.text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`resend ${res.status} ${detail.slice(0, 300)}`);
  }
}

function rfc2822(env: MailEnv, mail: OutboundMail): string {
  const from = mailFromAddress(env);
  return [
    `From: ${mailFromHeader(env)}`,
    `To: ${mail.to}`,
    `Reply-To: ${from}`,
    `Subject: ${mail.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    mail.text.replace(/\n/g, '\r\n'),
  ].join('\r\n');
}

function utf8ToBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

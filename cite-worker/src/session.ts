// App sessions. Login state lives here, not in a re-authentication on every
// page load: the browser holds an HMAC-signed cookie, the row in D1 holds the
// engine access token and the abilities that token actually carries.
import type { Env } from './index.js';

const COOKIE = 'cite_sess';
const SESSION_TTL_DAYS = 7;

export interface Session {
  id: string;
  sub: string;
  email: string | null;
  name: string | null;
  access_token: string | null;
  access_expires_at: string | null;
  abilities: string[];
  is_admin: boolean;
  engine_unauthorized: boolean;
}

const enc = new TextEncoder();

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function sessionSecret(env: Env): string {
  // Falls back to the admin token so a deployment without SESSION_SECRET still
  // signs cookies with *something* private rather than a constant.
  const s = env.SESSION_SECRET || env.ADMIN_TOKEN;
  if (!s) throw new Error('Neither SESSION_SECRET nor ADMIN_TOKEN is set — cannot sign sessions.');
  return s;
}

export function cookieHeader(id: string, mac: string, maxAgeSeconds: number): string {
  const parts = [
    `${COOKIE}=${id}.${mac}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return parts.join('; ');
}

export function clearCookieHeader(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(
  env: Env,
  user: { sub: string; email: string | null; name: string | null },
  accessToken: string,
  accessExpiresInSeconds: number | null,
  abilities: string[],
  isAdmin: boolean,
): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare(`
    INSERT INTO sessions (id, sub, access_token, access_expires_at, abilities, is_admin,
                          engine_unauthorized, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).bind(
    id, user.sub, accessToken,
    accessExpiresInSeconds ? new Date(Date.now() + accessExpiresInSeconds * 1000).toISOString() : null,
    JSON.stringify(abilities), isAdmin ? 1 : 0,
  ).run();
  const mac = await sign(id, sessionSecret(env));
  return cookieHeader(id, mac, SESSION_TTL_DAYS * 86400);
}

/**
 * Break-glass: a session created from the operator token rather than a
 * Shortlist sign-in. Carries no engine access token, so engine panels degrade
 * honestly instead of pretending. Disabled by ALLOW_TOKEN_CONSOLE="false".
 */
export const TOKEN_SUB = 'local:admin-token';

export function tokenConsoleAllowed(env: Env): boolean {
  return env.ALLOW_TOKEN_CONSOLE !== 'false';
}

export async function createTokenSession(env: Env): Promise<string> {
  await env.DB.prepare(`
    INSERT INTO users (sub, email, name, first_seen, last_seen, last_abilities)
    VALUES (?, NULL, 'Operator token', datetime('now'), datetime('now'), '[]')
    ON CONFLICT(sub) DO UPDATE SET last_seen = datetime('now')
  `).bind(TOKEN_SUB).run();
  const id = crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare(`
    INSERT INTO sessions (id, sub, access_token, access_expires_at, abilities, is_admin,
                          engine_unauthorized, created_at, last_seen)
    VALUES (?, ?, NULL, NULL, '[]', 1, 0, datetime('now'), datetime('now'))
  `).bind(id, TOKEN_SUB).run();
  const mac = await sign(id, sessionSecret(env));
  return cookieHeader(id, mac, SESSION_TTL_DAYS * 86400);
}

export async function readSession(req: Request, env: Env): Promise<Session | null> {
  const raw = req.headers.get('cookie') ?? '';
  const match = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [id, mac] = decodeURIComponent(match[1]).split('.');
  if (!id || !mac) return null;

  let expected: string;
  try { expected = await sign(id, sessionSecret(env)); } catch { return null; }
  if (!timingSafeEqual(mac, expected)) return null; // forged or wrong deployment

  const row = (await env.DB.prepare(`
    SELECT s.*, u.email, u.name FROM sessions s
    LEFT JOIN users u ON u.sub = s.sub
    WHERE s.id = ? AND s.created_at > datetime('now', ?)
  `).bind(id, `-${SESSION_TTL_DAYS} days`).first()) as Record<string, unknown> | null;
  if (!row) return null;

  await env.DB.prepare(`UPDATE sessions SET last_seen = datetime('now') WHERE id = ?`).bind(id).run();

  return {
    id,
    sub: row.sub as string,
    email: (row.email as string) ?? null,
    name: (row.name as string) ?? null,
    access_token: (row.access_token as string) ?? null,
    access_expires_at: (row.access_expires_at as string) ?? null,
    abilities: row.abilities ? (JSON.parse(row.abilities as string) as string[]) : [],
    is_admin: !!row.is_admin,
    engine_unauthorized: !!row.engine_unauthorized,
  };
}

export async function destroySession(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

export async function markEngineUnauthorized(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE sessions SET engine_unauthorized = 1 WHERE id = ?').bind(id).run();
}

/**
 * Who may open the operator console. The engine bounds every token by the
 * signed-in person's role, so a viewer and an admin signing into this same app
 * arrive with different ability lists — gate on what the token actually holds,
 * with an email allowlist as the override.
 */
export function isAdmin(env: Env, email: string | null, abilities: string[]): boolean {
  const required = env.CITE_ADMIN_ABILITY || '*:read';
  if (abilities.includes(required)) return true;
  const allow = (env.CITE_ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return !!email && allow.includes(email.toLowerCase());
}

export async function upsertUser(
  env: Env,
  user: { sub: string; email: string | null; name: string | null },
  abilities: string[],
): Promise<void> {
  // Keyed on sub. Email and name are refreshed on every sign-in because they
  // can change upstream; sub never does.
  await env.DB.prepare(`
    INSERT INTO users (sub, email, name, first_seen, last_seen, last_abilities)
    VALUES (?, ?, ?, datetime('now'), datetime('now'), ?)
    ON CONFLICT(sub) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      last_seen = excluded.last_seen,
      last_abilities = excluded.last_abilities
  `).bind(user.sub, user.email, user.name, JSON.stringify(abilities)).run();
}

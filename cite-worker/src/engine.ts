// Client for the Shortlist Context Engine's MCP endpoint.
//
// Authenticated with the SAME access token the sign-in produced — one
// credential for both halves. Every call is made as the signed-in person, so
// the engine bounds what comes back by their role.
import type { Env } from './index.js';

export class EngineUnauthorized extends Error {}   // 401: token expired or revoked
export class EngineScopeDenied extends Error {}    // this role may not use that tool
export class EngineUnavailable extends Error {}    // network/5xx — engine is down

export interface EngineTool {
  name: string;
  description?: string;
  available?: boolean | null;
  required_scope?: string | null;
}

export interface ProbeResult {
  engine?: { key?: string; display_name?: string; org?: string; purpose?: string; mode?: string };
  abilities?: string[];
  ability_count?: number;
  console?: { base_url?: string; entity_url_template?: string };
}

const CACHE_TTL_SECONDS = 60;

function endpoint(env: Env): string {
  const url = env.ENGINE_MCP_URL;
  if (!url) throw new EngineUnavailable('ENGINE_MCP_URL is not configured.');
  return url;
}

/** Raw JSON-RPC call. Errors are classified so callers can degrade a panel. */
export async function callTool(
  env: Env, accessToken: string, name: string, args: Record<string, unknown> = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(endpoint(env), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  } catch (e) {
    throw new EngineUnavailable(`Could not reach the engine: ${(e as Error).message}`);
  }

  if (res.status === 401) throw new EngineUnauthorized('Engine rejected the token (401).');
  if (!res.ok) throw new EngineUnavailable(`Engine returned HTTP ${res.status}.`);

  const body = (await res.json()) as {
    error?: { message?: string; code?: number };
    result?: { content?: { type: string; text: string }[]; isError?: boolean };
  };

  const errText = body.error?.message ?? '';
  if (errText) {
    // The engine denies with AuthorizationException and names the missing scope.
    if (/authorization|scope|forbidden|permission/i.test(errText)) throw new EngineScopeDenied(errText);
    throw new EngineUnavailable(errText);
  }

  const text = body.result?.content?.[0]?.text;
  if (text === undefined) return body.result ?? null;
  if (body.result?.isError) {
    if (/authorization|scope|permission/i.test(text)) throw new EngineScopeDenied(text);
    throw new EngineUnavailable(text);
  }
  try { return JSON.parse(text); } catch { return text; }
}

/** Cached read. A dashboard render must not mean a burst of live engine calls. */
export async function cachedCall(
  env: Env, accessToken: string, sub: string, name: string, args: Record<string, unknown> = {},
): Promise<unknown> {
  const key = `engine:${sub}:${name}:${JSON.stringify(args)}`;
  const hit = (await env.DB.prepare(
    `SELECT payload FROM engine_cache WHERE key = ? AND expires_at > datetime('now')`,
  ).bind(key).first()) as { payload: string } | null;
  if (hit) return JSON.parse(hit.payload);

  const value = await callTool(env, accessToken, name, args);
  await env.DB.prepare(`
    INSERT INTO engine_cache (key, sub, payload, expires_at)
    VALUES (?, ?, ?, datetime('now', ?))
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at
  `).bind(key, sub, JSON.stringify(value ?? null), `+${CACHE_TTL_SECONDS} seconds`).run();
  return value;
}

/** The ability list this specific token holds — not the scopes we asked for. */
export async function probe(env: Env, accessToken: string): Promise<ProbeResult> {
  return (await callTool(env, accessToken, 'probe-tool', {})) as ProbeResult;
}

/** Tools are discovered, never hard-coded: they differ between engine versions. */
export async function listTools(env: Env, accessToken: string, sub: string): Promise<EngineTool[]> {
  const key = `engine:${sub}:tools/list`;
  const hit = (await env.DB.prepare(
    `SELECT payload FROM engine_cache WHERE key = ? AND expires_at > datetime('now')`,
  ).bind(key).first()) as { payload: string } | null;
  if (hit) return JSON.parse(hit.payload) as EngineTool[];

  let res: Response;
  try {
    res = await fetch(endpoint(env), {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
  } catch (e) {
    throw new EngineUnavailable(`Could not reach the engine: ${(e as Error).message}`);
  }
  if (res.status === 401) throw new EngineUnauthorized('Engine rejected the token (401).');
  if (!res.ok) throw new EngineUnavailable(`Engine returned HTTP ${res.status}.`);
  const body = (await res.json()) as { result?: { tools?: EngineTool[] } };
  const tools = body.result?.tools ?? [];
  await env.DB.prepare(`
    INSERT INTO engine_cache (key, sub, payload, expires_at)
    VALUES (?, ?, ?, datetime('now', ?))
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at
  `).bind(key, sub, JSON.stringify(tools), `+${CACHE_TTL_SECONDS * 5} seconds`).run();
  return tools;
}

/**
 * Resolve a panel's tool from what the engine advertises. Returns null when the
 * engine doesn't have it or this token can't use it — the panel then hides
 * itself instead of erroring.
 */
export function pickTool(tools: EngineTool[], candidates: string[]): string | null {
  for (const name of candidates) {
    const t = tools.find((x) => x.name === name);
    if (t && t.available !== false) return t.name;
  }
  return null;
}

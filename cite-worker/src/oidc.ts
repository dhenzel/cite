// OpenID Connect against the Shortlist Context Engine.
//
// Everything protocol-shaped is delegated to oauth4webapi (WebCrypto, runs on
// Workers): discovery, PKCE S256, and id_token validation — signature against
// the engine's JWKS plus iss / aud / exp / nonce. Endpoints are never
// hard-coded; they come from the discovery document.
//
// One credential does both halves: the access_token returned here is the same
// token used to call the engine's MCP endpoint (see engine.ts).
import * as oauth from 'oauth4webapi';
import type { Env } from './index.js';

export const SCOPES = 'openid profile email *:read briefs:assemble';

const DISCOVERY_TTL_SECONDS = 3600;
const FLOW_TTL_SECONDS = 300;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function oidcConfig(env: Env): OidcConfig {
  const missing: string[] = [];
  if (!env.OIDC_ISSUER) missing.push('OIDC_ISSUER');
  if (!env.OIDC_CLIENT_ID) missing.push('OIDC_CLIENT_ID');
  if (!env.OIDC_CLIENT_SECRET) missing.push('OIDC_CLIENT_SECRET');
  if (!env.OIDC_REDIRECT_URI) missing.push('OIDC_REDIRECT_URI');
  if (missing.length) throw new OidcNotConfigured(missing);
  return {
    issuer: env.OIDC_ISSUER!,
    clientId: env.OIDC_CLIENT_ID!,
    clientSecret: env.OIDC_CLIENT_SECRET!,
    redirectUri: env.OIDC_REDIRECT_URI!,
  };
}

export class OidcNotConfigured extends Error {
  constructor(public missing: string[]) {
    super(`Sign-in is not configured. Missing: ${missing.join(', ')}`);
  }
}
export class OidcError extends Error {}

/** Discovery document, cached in D1 so we don't refetch on every sign-in. */
async function discover(env: Env, cfg: OidcConfig): Promise<oauth.AuthorizationServer> {
  const key = `oidc_discovery:${cfg.issuer}`;
  const row = (await env.DB.prepare(
    `SELECT payload FROM engine_cache WHERE key = ? AND expires_at > datetime('now')`,
  ).bind(key).first()) as { payload: string } | null;
  if (row) return JSON.parse(row.payload) as oauth.AuthorizationServer;

  const issuerUrl = new URL(cfg.issuer);
  const res = await oauth.discoveryRequest(issuerUrl, { algorithm: 'oidc' });
  const as = await oauth.processDiscoveryResponse(issuerUrl, res);
  if (!as.authorization_endpoint || !as.token_endpoint) {
    throw new OidcError('Discovery document is missing an authorization or token endpoint.');
  }
  await env.DB.prepare(`
    INSERT INTO engine_cache (key, sub, payload, expires_at)
    VALUES (?, NULL, ?, datetime('now', ?))
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at
  `).bind(key, JSON.stringify(as), `+${DISCOVERY_TTL_SECONDS} seconds`).run();
  return as;
}

/**
 * Start the authorization code flow. Stores the PKCE verifier, state and nonce
 * server-side; all three are verified on the way back.
 */
export async function buildAuthUrl(env: Env, redirectTo = '/admin'): Promise<string> {
  const cfg = oidcConfig(env);
  const as = await discover(env, cfg);

  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();

  await env.DB.prepare(`
    INSERT INTO oidc_flows (state, code_verifier, nonce, redirect_to, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(state, codeVerifier, nonce, redirectTo).run();

  const url = new URL(as.authorization_endpoint!);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256'); // engine rejects anything else
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  return url.toString();
}

export interface SignInResult {
  sub: string;
  email: string | null;
  name: string | null;
  accessToken: string;
  accessExpiresInSeconds: number | null;
  redirectTo: string;
}

/** Finish the flow: verify state, exchange the code, validate the id_token. */
export async function handleCallback(env: Env, requestUrl: URL): Promise<SignInResult> {
  const cfg = oidcConfig(env);
  const as = await discover(env, cfg);

  const returnedState = requestUrl.searchParams.get('state');
  if (!returnedState) throw new OidcError('Missing state on the callback.');

  const flow = (await env.DB.prepare(`
    SELECT state, code_verifier, nonce, redirect_to FROM oidc_flows
    WHERE state = ? AND created_at > datetime('now', ?)
  `).bind(returnedState, `-${FLOW_TTL_SECONDS} seconds`).first()) as
    { state: string; code_verifier: string; nonce: string; redirect_to: string } | null;
  // Single use, whatever happens next.
  await env.DB.prepare('DELETE FROM oidc_flows WHERE state = ?').bind(returnedState).run();
  if (!flow) throw new OidcError('This sign-in link has expired or was already used. Try again.');

  const client: oauth.Client = { client_id: cfg.clientId };
  const clientAuth = oauth.ClientSecretPost(cfg.clientSecret);

  // Throws if the engine returned an error, or if state does not match.
  const params = oauth.validateAuthResponse(as, client, requestUrl, flow.state);

  const tokenRes = await oauth.authorizationCodeGrantRequest(
    as, client, clientAuth, params, cfg.redirectUri, flow.code_verifier,
  );
  // Validates the id_token: signature via JWKS, iss, aud, exp — and nonce,
  // because we pass the expected value here.
  const result = await oauth.processAuthorizationCodeResponse(as, client, tokenRes, {
    expectedNonce: flow.nonce,
    requireIdToken: true,
  });

  const claims = oauth.getValidatedIdTokenClaims(result);
  if (!claims) throw new OidcError('The engine did not return an id_token.');
  if (claims.iss !== cfg.issuer) throw new OidcError('Token issuer does not match the configured engine.');
  if (!result.access_token) throw new OidcError('The engine did not return an access token.');

  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    name: typeof claims.name === 'string' ? claims.name : null,
    accessToken: result.access_token,
    accessExpiresInSeconds: typeof result.expires_in === 'number' ? result.expires_in : null,
    redirectTo: flow.redirect_to || '/admin',
  };
}

// ServiceM8 OAuth2: install-time token exchange + per-call token refresh.
// Copied from servicem8-renewal-autopilot/src/servicem8-oauth.js (same
// confirmed-live handshake) and trimmed to this add-on's own scope needs.

const AUTHORIZE_URL = "https://go.servicem8.com/oauth/authorize";
const TOKEN_URL = "https://go.servicem8.com/oauth/access_token";

// Minimal scope for this add-on: read_email to see opened/first_opened_at on
// email.json, publish_job_notes to post the job note that surfaces it on
// mobile. Confirmed against ServiceM8's own OAuth scope list -- notes follow
// a read_X/publish_X pattern (like read_job_photos/publish_job_photos), not
// the read_X/manage_X pattern used elsewhere (e.g. manage_badges).
export const OAUTH_SCOPES = "read_email publish_job_notes";

export function buildAuthorizeUrl({ appId, redirectUri, state }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

// Carries the HTTP status through so callers can tell "ServiceM8 is having a
// moment" (5xx -- worth retrying next cron tick) apart from "this grant is
// gone" (4xx -- retrying forever is pointless, the tenant has to reinstall).
export class ServiceM8TokenError extends Error {
  constructor(message, { status }) {
    super(message);
    this.name = "ServiceM8TokenError";
    this.status = status;
    this.grantLost = status >= 400 && status < 500;
  }
}

async function tokenRequest(env, body) {
  if (!env.SERVICEM8_APP_ID || !env.SERVICEM8_APP_SECRET) {
    // Worth its own message: a missing secret otherwise surfaces as an opaque
    // "invalid_client" from ServiceM8, which sends you hunting in the wrong place.
    throw new ServiceM8TokenError(
      `ServiceM8 OAuth not configured: ${!env.SERVICEM8_APP_ID ? "SERVICEM8_APP_ID" : "SERVICEM8_APP_SECRET"} is unset on this Worker`,
      { status: 500 }
    );
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SERVICEM8_APP_ID,
      client_secret: env.SERVICEM8_APP_SECRET,
      ...body,
    }),
  });
  if (!res.ok) {
    throw new ServiceM8TokenError(`ServiceM8 OAuth token request failed: ${res.status} ${await res.text()}`, {
      status: res.status,
    });
  }
  return res.json();
}

export async function exchangeCodeForTokens(env, { code, redirectUri }) {
  return tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

async function refreshTokens(env, refreshToken) {
  return tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function storeTokens(db, tenantId, tokens) {
  const now = Date.now();
  const expiresAt = now + tokens.expires_in * 1000;
  await db
    .prepare(
      `INSERT INTO oauth_tokens (tenant_id, access_token, refresh_token, access_token_expires_at, scope, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         access_token_expires_at = excluded.access_token_expires_at,
         scope = excluded.scope,
         updated_at = excluded.updated_at`
    )
    .bind(tenantId, tokens.access_token, tokens.refresh_token, expiresAt, tokens.scope || OAUTH_SCOPES, now)
    .run();
}

const REFRESH_SKEW_MS = 60_000; // refresh if expiring within the next 60s

// Same optimistic-lock refresh pattern as the sibling repo: a concurrent
// cron tick and a retried call can both want to refresh around the same
// moment, and refresh_token rotates on every use, so only one caller should
// actually perform the refresh.
export async function getValidAccessToken(env, tenantId) {
  const row = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE tenant_id = ?").bind(tenantId).first();
  if (!row) throw new Error(`No OAuth tokens on file for tenant ${tenantId}`);

  if (row.access_token_expires_at > Date.now() + REFRESH_SKEW_MS) {
    return row.access_token;
  }

  let fresh;
  try {
    fresh = await refreshTokens(env, row.refresh_token);
  } catch (err) {
    const now = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE tenant_id = ?").bind(tenantId).first();
    if (now && now.access_token_expires_at > Date.now()) return now.access_token;
    throw err;
  }

  const now = Date.now();
  const expiresAt = now + fresh.expires_in * 1000;
  const result = await env.DB.prepare(
    `UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, access_token_expires_at = ?, updated_at = ?
     WHERE tenant_id = ? AND access_token_expires_at = ?`
  )
    .bind(fresh.access_token, fresh.refresh_token, expiresAt, now, tenantId, row.access_token_expires_at)
    .run();

  if (result.meta.changes > 0) return fresh.access_token;

  const winner = await env.DB.prepare("SELECT access_token FROM oauth_tokens WHERE tenant_id = ?").bind(tenantId).first();
  return winner.access_token;
}

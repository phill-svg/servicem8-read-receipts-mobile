// Read Receipts for Mobile -- router + cron entry point.
//
// What this add-on does, end to end: ServiceM8 tracks whether a sent email
// was opened (email.json's opened/first_opened_at) and shows it in the Job
// Diary on desktop, but not on mobile. Rather than build a custom mobile UI,
// a cron poller (see src/read-receipts.js) checks for newly-opened emails and
// posts a Job Note when it finds one -- Job Notes already sync to the native
// mobile app, so the read receipt shows up there with no custom UI at all.
//
// No staff-facing UI, no webhooks, no per-tenant setup wizard -- install and
// it just works. That's why this is much smaller than servicem8-renewal-autopilot's
// index.js, which it's otherwise modelled on.

import { randomId, escapeHtml } from "./util.js";
import { buildAuthorizeUrl, exchangeCodeForTokens, storeTokens } from "./servicem8-oauth.js";
import { pollAllTenants, pollTenantForReadReceipts } from "./read-receipts.js";

async function handleInstallStart(request, env) {
  const url = new URL(request.url);
  const state = randomId(16);
  const authorizeUrl = buildAuthorizeUrl({
    appId: env.SERVICEM8_APP_ID,
    redirectUri: `${url.origin}/oauth/callback`,
    state,
  });
  return Response.redirect(authorizeUrl, 302);
}

function installedPageHtml() {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;max-width:32rem;margin:0 auto;">
    <h2>Read Receipts for Mobile is now installed</h2>
    <p>When a customer opens an email you sent from ServiceM8, a note will be added to the job so you can see it from the mobile app -- no further setup needed.</p>
  </body></html>`;
}

function installErrorHtml(message) {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;color:#c41613;">${escapeHtml(message)}</body></html>`;
}

async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return new Response(installErrorHtml("Missing authorization code."), { status: 400, headers: { "Content-Type": "text/html" } });

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(env, { code, redirectUri: `${url.origin}/oauth/callback` });
  } catch (err) {
    console.error("oauth callback: token exchange failed", err);
    return new Response(installErrorHtml("Installation failed -- please try again."), { status: 502, headers: { "Content-Type": "text/html" } });
  }

  // No add-on JWT callback in this product (no staff-facing UI to open), so
  // unlike the sibling repo there's no later "resolve the real account UUID"
  // step -- this generated id is the tenant's permanent key.
  const tenantId = randomId();
  try {
    await env.DB.prepare(`INSERT INTO tenants (tenant_id, status, installed_at) VALUES (?, 'active', ?)`).bind(tenantId, Date.now()).run();
    await storeTokens(env.DB, tenantId, tokens);
  } catch (err) {
    console.error("oauth callback: failed to persist new tenant", err);
    return new Response(installErrorHtml("Installation failed -- please try again."), { status: 502, headers: { "Content-Type": "text/html" } });
  }

  return new Response(installedPageHtml(), { headers: { "Content-Type": "text/html" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/install") return handleInstallStart(request, env);
    if (url.pathname === "/oauth/callback") return handleOAuthCallback(request, env);

    // Manual trigger for testing against one tenant without waiting for cron.
    // Not linked from anywhere -- only useful with the tenant_id in hand.
    if (url.pathname === "/debug/poll" && url.searchParams.get("tenant")) {
      const result = await pollTenantForReadReceipts(env, url.searchParams.get("tenant"));
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAllTenants(env));
  },
};

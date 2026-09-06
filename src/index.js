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
import { manualRunStartedRecently } from "./diagnostics.js";
import { probeEmailRequests } from "./servicem8-api.js";

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

const MANUAL_POLL_COOLDOWN_MS = 30_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

// The /debug routes expose no tokens and no customer data, but they do reveal
// install state and let a stranger burn ServiceM8 API quota, so they can be
// locked down by setting a DEBUG_KEY secret on the Worker. Unset (the default)
// leaves them open -- which is what makes them usable for first-run triage
// before anything else about the deployment is known to work.
function debugAuthorized(env, url) {
  if (!env.DEBUG_KEY) return true;
  return url.searchParams.get("key") === env.DEBUG_KEY;
}

// Everything needed to tell a healthy install from a stalled one, in one page:
// are the secrets set, did a tenant install, is the cron actually firing, and
// what did the last few runs do. Tenant ids are truncated -- they're the only
// identifying value here and nothing about triage needs the whole thing.
async function handleDebugStatus(env) {
  const shortId = (id) => (id ? `${String(id).slice(0, 8)}...` : null);
  const out = {
    now: new Date().toISOString(),
    config: {
      // Presence only -- never the values.
      SERVICEM8_APP_ID: Boolean(env.SERVICEM8_APP_ID),
      SERVICEM8_APP_SECRET: Boolean(env.SERVICEM8_APP_SECRET),
      DEBUG_KEY: Boolean(env.DEBUG_KEY),
    },
  };

  try {
    const tenants = await env.DB.prepare(
      `SELECT t.tenant_id, t.status, t.installed_at, o.access_token_expires_at, o.updated_at AS token_updated_at, o.scope
         FROM tenants t LEFT JOIN oauth_tokens o USING (tenant_id) ORDER BY t.installed_at`
    ).all();
    out.tenants = (tenants.results || []).map((t) => ({
      tenant_id: shortId(t.tenant_id),
      status: t.status,
      installed_at: new Date(t.installed_at).toISOString(),
      scope: t.scope,
      token_last_refreshed: t.token_updated_at ? new Date(t.token_updated_at).toISOString() : null,
      access_token_expired: t.access_token_expires_at ? t.access_token_expires_at < Date.now() : null,
    }));

    const notes = await env.DB.prepare("SELECT COUNT(*) AS n FROM notified_emails").first();
    out.notes_posted = notes ? notes.n : 0;

    const lastCron = await env.DB.prepare(
      "SELECT started_at, source FROM poll_runs WHERE source LIKE 'cron%' ORDER BY id DESC LIMIT 1"
    ).first();
    // The single most useful line here: if this stays null, the schedule isn't
    // reaching the Worker and no amount of ServiceM8 debugging will help.
    out.last_cron_run = lastCron ? { at: new Date(lastCron.started_at).toISOString(), source: lastCron.source } : null;

    const runs = await env.DB.prepare(
      `SELECT started_at, finished_at, source, tenant_id, scanned, notified, ok, error
         FROM poll_runs ORDER BY id DESC LIMIT 15`
    ).all();
    out.recent_runs = (runs.results || []).map((r) => ({
      at: new Date(r.started_at).toISOString(),
      source: r.source,
      tenant_id: shortId(r.tenant_id),
      completed: Boolean(r.finished_at),
      ok: Boolean(r.ok),
      scanned: r.scanned,
      notified: r.notified,
      error: r.error,
    }));
  } catch (err) {
    out.error = `Reading diagnostics failed -- has schema.sql been applied? ${err}`;
    return json(out, 500);
  }

  return json(out);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/install") return handleInstallStart(request, env);
    if (url.pathname === "/oauth/callback") return handleOAuthCallback(request, env);

    if (url.pathname.startsWith("/debug/")) {
      if (!debugAuthorized(env, url)) return json({ error: "Not authorised" }, 403);

      if (url.pathname === "/debug/status") return handleDebugStatus(env);

      // Runs the exact code path the cron runs, on demand -- the fastest way to
      // find out what a poll actually does without waiting up to 10 minutes.
      if (url.pathname === "/debug/poll-all") {
        if (await manualRunStartedRecently(env.DB, MANUAL_POLL_COOLDOWN_MS)) {
          return json({ error: "A manual poll just ran -- wait 30s before triggering another." }, 429);
        }
        return json(await pollAllTenants(env, { source: "manual" }));
      }

      // Answers "is /email.json capped at 1000, and how do we page past it?"
      // against the live account. Read-only -- it posts nothing and writes
      // nothing. Compare the counts and the first/last uuids: a parameter that
      // 400s is unsupported, and one that's accepted but ignored comes back
      // with the same uuids as the unparameterised call.
      if (url.pathname === "/debug/probe-emails" && url.searchParams.get("tenant")) {
        const probes = await probeEmailRequests(env, url.searchParams.get("tenant"), [
          "",
          "%24top=5",
          "%24top=1000&%24skip=1000",
          "%24filter=" + encodeURIComponent("opened eq '1'"),
        ]);
        return json(probes);
      }

      // Single-tenant variant, for when only one of several tenants misbehaves.
      if (url.pathname === "/debug/poll" && url.searchParams.get("tenant")) {
        return json(await pollTenantForReadReceipts(env, url.searchParams.get("tenant"), { source: "manual" }));
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // event.cron is recorded so poll_runs shows which schedule fired, which
    // also proves the trigger is wired up at all.
    ctx.waitUntil(pollAllTenants(env, { source: `cron:${event.cron || "?"}` }));
  },
};

// Core read-receipt logic. Selection/formatting are pure functions (tested
// directly, no live account needed); pollTenantForReadReceipts wires them up
// to the ServiceM8 API + D1 dedupe table.

import { parseServiceM8Date } from "./util.js";
import { listRecentEmails, createJobNote } from "./servicem8-api.js";
import { startRun, finishRun, pruneRuns, describeError } from "./diagnostics.js";

// ServiceM8 booleans sometimes come back as "1"/"0" strings rather than real
// booleans (same quirk as the sibling repo's badges field) -- normalize
// defensively rather than assuming either shape.
function isTruthy(v) {
  return v === true || v === 1 || v === "1";
}

// Given raw email.json records and the set of email UUIDs already notified
// on, returns the ones that are opened and haven't had a job note posted yet.
// Requires a real (non-zero-date) first_opened_at, not just an `opened` flag,
// since that's what confirms ServiceM8 actually has an open timestamp to
// report rather than a flag flipped with nothing behind it.
export function selectNewlyOpenedEmails(emails, alreadyNotifiedUuids) {
  const notified = alreadyNotifiedUuids instanceof Set ? alreadyNotifiedUuids : new Set(alreadyNotifiedUuids || []);
  return (emails || []).filter((email) => {
    if (!email || !email.uuid || !email.related_object_uuid) return false;
    if (notified.has(email.uuid)) return false;
    if (!isTruthy(email.opened)) return false;
    return Boolean(parseServiceM8Date(email.first_opened_at));
  });
}

// first_opened_at is already the installing account's own local-time string
// (e.g. "2026-08-18 15:45:00") -- embedded as-is rather than reparsed through
// a Date/timezone conversion, which would risk silently shifting it.
export function formatReadReceiptNote(email) {
  const recipient = email.to ? ` by ${email.to}` : "";
  const subject = email.subject ? ` ("${email.subject}")` : "";
  const when = email.first_opened_at || "just now";
  return `📧 Email opened${recipient}${subject} -- ${when}`;
}

const LOOKBACK_DAYS = 30; // emails older than this are assumed already handled; bounds the poll size

// Dedupe is deliberately account-wide rather than per-tenant. ServiceM8 record
// UUIDs are globally unique, so an email UUID can only ever belong to one
// account -- and that makes this the fix for a real failure mode: every visit
// to /install mints a brand-new tenant_id (nothing in the OAuth response
// identifies the ServiceM8 account), so installing twice leaves two tenant rows
// polling the same account. Keyed per tenant, both would post their own note
// and the customer would see the read receipt twice.
async function alreadyNotifiedEmailUuids(db) {
  const rows = await db.prepare("SELECT email_uuid FROM notified_emails").all();
  return new Set((rows.results || []).map((r) => r.email_uuid));
}

// A 4xx on the token refresh means the grant is gone for good. Park the tenant
// so the cron stops retrying it every 10 minutes forever; a fresh /install
// creates a working one, and the dedupe above stops the replacement
// re-notifying anything the parked tenant already handled.
async function parkTenantIfGrantLost(db, tenantId, err) {
  if (!err || err.grantLost !== true) return false;
  await db
    .prepare("UPDATE tenants SET status = 'reauth_required', uninstalled_at = ? WHERE tenant_id = ?")
    .bind(Date.now(), tenantId)
    .run();
  return true;
}

// The ServiceM8 calls are reached through this indirection purely so tests can
// stand in for them -- production always uses the real client.
const liveApi = { listRecentEmails, createJobNote };

// Never throws: a tenant whose poll blows up records the reason and lets the
// rest of the run continue. The caller reads the outcome off the return value.
export async function pollTenantForReadReceipts(env, tenantId, { source = "manual", api = liveApi } = {}) {
  const runId = await startRun(env.DB, { source, tenantId });
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const emails = await api.listRecentEmails(env, tenantId, { since });
    const notifiedSet = await alreadyNotifiedEmailUuids(env.DB);

    const toNotify = selectNewlyOpenedEmails(emails, notifiedSet);
    let notified = 0;
    const failures = [];
    for (const email of toNotify) {
      try {
        await api.createJobNote(env, tenantId, email.related_object_uuid, formatReadReceiptNote(email));
        await env.DB.prepare(
          `INSERT INTO notified_emails (tenant_id, email_uuid, job_uuid, opened_at, notified_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, email_uuid) DO NOTHING`
        )
          .bind(tenantId, email.uuid, email.related_object_uuid, email.first_opened_at || null, Date.now())
          .run();
        notified++;
      } catch (err) {
        // Left out of notified_emails on failure so the next poll retries it --
        // never mark an email notified without a successfully posted note.
        console.error(`read-receipts: failed to post note for email ${email.uuid} (tenant ${tenantId})`, err);
        failures.push(`email ${email.uuid}: ${describeError(err)}`);
      }
    }

    const scanned = (emails || []).length;
    const error = failures.length ? failures.join(" | ") : null;
    await finishRun(env.DB, runId, { ok: !error, scanned, notified, error });
    return { tenantId, scanned, eligible: toNotify.length, notified, error };
  } catch (err) {
    console.error(`read-receipts: poll failed for tenant ${tenantId}`, err);
    const parked = await parkTenantIfGrantLost(env.DB, tenantId, err).catch(() => false);
    const error = parked ? `${describeError(err)} [tenant parked: reauth_required]` : describeError(err);
    await finishRun(env.DB, runId, { ok: false, error });
    return { tenantId, scanned: 0, eligible: 0, notified: 0, error };
  }
}

// The cron entry point. Writes its own poll_runs row before touching anything
// else, so "the cron never fired" and "the cron fired and failed" stop looking
// identical from the outside -- which is exactly what they did on the first
// live attempt.
export async function pollAllTenants(env, { source = "cron", api = liveApi } = {}) {
  const runId = await startRun(env.DB, { source });
  const summary = { source, tenants: 0, scanned: 0, notified: 0, failures: [] };
  try {
    const tenants = await env.DB.prepare("SELECT tenant_id FROM tenants WHERE status = 'active'").all();
    for (const { tenant_id } of tenants.results || []) {
      summary.tenants++;
      const result = await pollTenantForReadReceipts(env, tenant_id, { source, api });
      summary.scanned += result.scanned;
      summary.notified += result.notified;
      if (result.error) summary.failures.push(`${tenant_id}: ${result.error}`);
    }
    await finishRun(env.DB, runId, {
      ok: summary.failures.length === 0,
      scanned: summary.scanned,
      notified: summary.notified,
      error: summary.failures.join(" | ") || null,
    });
  } catch (err) {
    console.error("read-receipts: poll run failed", err);
    summary.failures.push(describeError(err));
    await finishRun(env.DB, runId, { ok: false, error: err });
  }
  await pruneRuns(env.DB).catch(() => {});
  return summary;
}

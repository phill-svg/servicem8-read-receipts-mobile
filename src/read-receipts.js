// Core read-receipt logic. Selection/formatting are pure functions (tested
// directly, no live account needed); pollTenantForReadReceipts wires them up
// to the ServiceM8 API + D1 dedupe table.

import { parseServiceM8Date } from "./util.js";
import { listRecentEmails, createJobNote } from "./servicem8-api.js";

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

export async function pollTenantForReadReceipts(env, tenantId) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const emails = await listRecentEmails(env, tenantId, { since });

  const already = await env.DB.prepare("SELECT email_uuid FROM notified_emails WHERE tenant_id = ?").bind(tenantId).all();
  const notifiedSet = new Set((already.results || []).map((r) => r.email_uuid));

  const toNotify = selectNewlyOpenedEmails(emails, notifiedSet);
  let notified = 0;
  for (const email of toNotify) {
    try {
      await createJobNote(env, tenantId, email.related_object_uuid, formatReadReceiptNote(email));
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
    }
  }
  return { scanned: (emails || []).length, notified };
}

export async function pollAllTenants(env) {
  const tenants = await env.DB.prepare("SELECT tenant_id FROM tenants WHERE status = 'active'").all();
  for (const { tenant_id } of tenants.results || []) {
    try {
      await pollTenantForReadReceipts(env, tenant_id);
    } catch (err) {
      console.error(`read-receipts: poll failed for tenant ${tenant_id}`, err);
    }
  }
}

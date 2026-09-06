// Tenant-aware ServiceM8 REST client, trimmed to what this add-on needs.
// Conventions (retry/backoff, odata filter syntax, POST-returns-empty-body-
// plus-x-record-uuid-header) copied from servicem8-renewal-autopilot/src/servicem8-api.js,
// where they're already confirmed against a live account.

import { getValidAccessToken } from "./servicem8-oauth.js";

const API_BASE = "https://api.servicem8.com/api_1.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sm8Fetch(env, tenantId, path, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await getValidAccessToken(env, tenantId);
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 8000);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`ServiceM8 API ${path} failed for tenant ${tenantId}: ${res.status} ${await res.text()}`);
  }
}

// All emails sent from this account.
//
// This deliberately fetches unfiltered. The original version bounded each poll
// with `$filter=edit_date gt '<cutoff>'`, which ServiceM8 rejects outright:
//
//   400 {"errorCode":400,"message":"Unsupported $filter field: edit_date"}
//
// Confirmed live 2026-09-06 -- that 400 was what stopped every single poll,
// from install onwards. ServiceM8 doesn't document which fields are filterable
// per object, and the failure mode of guessing wrong is asymmetric: a rejected
// filter is loud (a 400, like the one above), but a filter that's *accepted*
// and matches nothing is silent -- the poller would look healthy and quietly
// never post a note again. Fetching too much is the safe direction to be wrong
// in, and the dedupe table already makes a wide scan harmless.
//
// poll_runs.scanned records how wide it actually is. Narrow this only with
// that number in hand, and only to a filter proven against a live account.
export async function listRecentEmails(env, tenantId) {
  return sm8Fetch(env, tenantId, `/email.json`);
}

// ServiceM8 appears to cap /email.json at 1000 records: the first successful
// live poll returned exactly that (2026-09-06). Exactly-round counts are how a
// silent ceiling announces itself, and this one matters -- if the capped page
// is the *oldest* 1000 rather than the newest, new emails fall off the end and
// the add-on quietly stops working forever.
export const EMAIL_PAGE_CAP = 1000;

// Read-only reconnaissance for that question, used by /debug/probe-emails.
// Reports what ServiceM8 does with each candidate request instead of guessing:
// an unsupported $filter or paging parameter is a 400 (like edit_date was), and
// a parameter that's accepted but ignored shows up as an identical first/last
// uuid. Posts nothing and writes nothing.
export async function probeEmailRequests(env, tenantId, queries) {
  const token = await getValidAccessToken(env, tenantId);
  const results = [];
  for (const query of queries) {
    const path = query ? `/email.json?${query}` : `/email.json`;
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) {
        results.push({ path, status: res.status, body: (await res.text()).slice(0, 300) });
        continue;
      }
      const rows = await res.json();
      results.push({
        path,
        status: res.status,
        count: Array.isArray(rows) ? rows.length : null,
        first_uuid: Array.isArray(rows) && rows.length ? rows[0].uuid : null,
        last_uuid: Array.isArray(rows) && rows.length ? rows[rows.length - 1].uuid : null,
      });
    } catch (err) {
      results.push({ path, error: String(err).slice(0, 300) });
    }
  }
  return results;
}

// Posts a Job Note -- shows up in the Job Diary on both desktop AND mobile.
// This is the whole trick this add-on relies on: ServiceM8's own read-receipt
// data (email.json's opened/first_opened_at) only renders on desktop, but a
// Job Note synced from the same job diary shows up natively on mobile with
// no custom UI needed. Same create-endpoint shape as the sibling repo's
// createBadge: empty response body, new UUID comes back in x-record-uuid.
export async function createJobNote(env, tenantId, jobUuid, noteText) {
  const token = await getValidAccessToken(env, tenantId);
  const res = await fetch(`${API_BASE}/note.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ related_object: "job", related_object_uuid: jobUuid, note: noteText }),
  });
  if (!res.ok) {
    throw new Error(`ServiceM8 API POST /note.json failed for tenant ${tenantId}: ${res.status} ${await res.text()}`);
  }
  const uuid = res.headers.get("x-record-uuid");
  if (!uuid) throw new Error("ServiceM8 POST /note.json returned no record UUID");
  return uuid;
}

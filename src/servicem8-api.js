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

// ServiceM8's filter language only supports eq/ne/gt/lt, combined with " and ".
function odataFilter(expr) {
  return `%24filter=${encodeURIComponent(expr)}`;
}

// All emails sent from this account, optionally only those touched since a
// given Date -- unlike a job-scoped fetch this doesn't require already
// knowing which jobs to check, which is what lets the poller find newly-
// opened emails account-wide. NEEDS LIVE CONFIRMATION: assumes email.json
// accepts an edit_date filter like other ServiceM8 objects generally do; if
// it's rejected or silently ignored, this just falls back to fetching every
// email on the account each run (safe, just less efficient -- worth
// tightening once confirmed).
export async function listRecentEmails(env, tenantId, { since } = {}) {
  if (!since) return sm8Fetch(env, tenantId, `/email.json`);
  const cutoff = since.toISOString().slice(0, 19).replace("T", " ");
  return sm8Fetch(env, tenantId, `/email.json?${odataFilter(`edit_date gt '${cutoff}'`)}`);
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

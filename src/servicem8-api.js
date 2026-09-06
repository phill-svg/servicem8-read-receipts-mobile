// Tenant-aware ServiceM8 REST client, trimmed to what this add-on needs.
// Conventions (retry/backoff, odata filter syntax, POST-returns-empty-body-
// plus-x-record-uuid-header) copied from servicem8-renewal-autopilot/src/servicem8-api.js,
// where they're already confirmed against a live account.

import { getValidAccessToken } from "./servicem8-oauth.js";

const API_BASE = "https://api.servicem8.com/api_1.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns the decoded body alongside the response headers -- paging is driven
// by a header, not by anything in the body.
async function sm8Fetch(env, tenantId, path, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await getValidAccessToken(env, tenantId);
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.ok) return { data: await res.json(), headers: res.headers };
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

// ServiceM8 caps /email.json at 1000 records per response and pages with a
// cursor, not with $top/$skip. Probed against the live account 2026-09-06:
//
//   /email.json                        200, 1000 rows
//   /email.json?$top=5                 200, 1000 rows, identical first/last uuid
//   /email.json?$top=1000&$skip=1000   200, 1000 rows, identical first/last uuid
//   /email.json?$filter=opened eq '1'  400 Unsupported $filter field: opened
//
// $top and $skip are accepted and silently ignored. That is the dangerous shape
// of failure: unpaged, the poller would sit on exactly 1000 records looking
// perfectly healthy while never seeing the 1001st.
export const EMAIL_PAGE_CAP = 1000;

// Bounds the walk at 20k emails so a pathological account can't spin the Worker
// until it's killed.
const MAX_EMAIL_PAGES = 20;

// Every email on the account, walked page by page.
//
// No $filter is sent. The original version bounded each poll with
// `$filter=edit_date gt '<cutoff>'`, which ServiceM8 rejects outright:
//
//   400 {"errorCode":400,"message":"Unsupported $filter field: edit_date"}
//
// Confirmed live 2026-09-06 -- that 400 was what stopped every single poll from
// install onwards. `opened` is rejected the same way, so there is no filter
// available that would narrow this to just the records we care about.
//
// The loop is driven entirely by the x-next-cursor response header, which makes
// it safe against being wrong about the mechanism: if ServiceM8 stops sending
// that header, this makes exactly one request and behaves identically to the
// unpaged version. It cannot spin, and it cannot fetch less than before.
export async function listRecentEmails(env, tenantId) {
  const all = [];
  const followed = new Set();
  let cursor = null;

  for (let page = 0; page < MAX_EMAIL_PAGES; page++) {
    const path = cursor ? `/email.json?cursor=${encodeURIComponent(cursor)}` : `/email.json`;
    const { data, headers } = await sm8Fetch(env, tenantId, path);
    const rows = Array.isArray(data) ? data : [];
    all.push(...rows);

    const next = headers.get("x-next-cursor");
    // Stop on: the last page (no header), an empty page, or a cursor we have
    // already followed -- that last one would otherwise loop until the cap.
    if (!next || rows.length === 0 || followed.has(next)) break;
    followed.add(next);
    cursor = next;
  }
  return all;
}

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
        next_cursor: res.headers.get("x-next-cursor"),
        // Field *names* only, never values -- these records carry customer
        // email addresses. Enough to confirm the fields the poller reads (to,
        // subject, opened, first_opened_at, related_object_uuid) are actually
        // what ServiceM8 calls them.
        fields: Array.isArray(rows) && rows.length ? Object.keys(rows[0]).sort() : null,
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

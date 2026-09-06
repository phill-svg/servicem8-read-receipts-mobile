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

// Read-only reconnaissance, used by /debug/probe-emails.
//
// The first version of this guessed at header and parameter names. That was the
// same mistake twice over, so it now dumps *every* response header and probes
// the cursor with a value taken from the live data rather than invented:
// ServiceM8's docs describe cursor paging where the cursor is a record UUID, so
// step 2 replays the first page's last uuid as ?cursor=. If page 2 comes back
// with different uuids, that's the mechanism.
//
// Posts nothing, writes nothing, and returns no field values -- only names.
export async function probeEmailRequests(env, tenantId) {
  const token = await getValidAccessToken(env, tenantId);

  async function attempt(label, query) {
    const path = query ? `/email.json?${query}` : `/email.json`;
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const headers = Object.fromEntries([...res.headers].filter(([k]) => !/^set-cookie$/i.test(k)));
      if (!res.ok) return { label, path, status: res.status, headers, body: (await res.text()).slice(0, 300) };

      const rows = await res.json();
      const list = Array.isArray(rows) ? rows : [];
      return {
        label,
        path,
        status: res.status,
        headers,
        count: list.length,
        first_uuid: list.length ? list[0].uuid : null,
        last_uuid: list.length ? list[list.length - 1].uuid : null,
        // Names only -- these records carry customer email addresses. Enough to
        // confirm the fields the poller reads are called what it thinks.
        fields: list.length ? Object.keys(list[0]).sort() : null,
      };
    } catch (err) {
      return { label, path, error: String(err).slice(0, 300) };
    }
  }

  const first = await attempt("baseline", "");
  const results = [first];

  // Replay the last record's uuid as a cursor -- the one candidate drawn from
  // live data rather than guessed. Compare first_uuid against the baseline: if
  // it differs, paging works and this is how.
  if (first.last_uuid) results.push(await attempt("cursor=last_uuid", `cursor=${encodeURIComponent(first.last_uuid)}`));

  results.push(await attempt("page=2", "page=2"));
  results.push(await attempt("per_page=5", "per_page=5"));
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

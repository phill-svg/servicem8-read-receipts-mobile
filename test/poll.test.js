import { test } from "node:test";
import assert from "node:assert/strict";
import { pollTenantForReadReceipts, pollAllTenants } from "../src/read-receipts.js";
import { ServiceM8TokenError } from "../src/servicem8-oauth.js";
import { fakeDb } from "./fake-d1.js";

const openedEmail = (uuid, job = "job-1") => ({
  uuid,
  related_object_uuid: job,
  opened: "1",
  first_opened_at: "2026-08-18 15:45:00",
  to: "jane@example.com",
  subject: "Your quote",
});

function fakeApi({ emails = [], failNoteFor = null, listError = null } = {}) {
  const posted = [];
  return {
    posted,
    async listRecentEmails() {
      if (listError) throw listError;
      return emails;
    },
    async createJobNote(env, tenantId, jobUuid, note) {
      if (failNoteFor && failNoteFor === jobUuid) throw new Error("ServiceM8 API POST /note.json failed: 403");
      posted.push({ tenantId, jobUuid, note });
      return "note-uuid";
    },
  };
}

test("posts a note for a newly opened email and records it", async () => {
  const db = fakeDb({ tenants: [{ tenant_id: "t1" }] });
  const api = fakeApi({ emails: [openedEmail("e1")] });

  const result = await pollTenantForReadReceipts({ DB: db }, "t1", { api });

  assert.equal(result.notified, 1);
  assert.equal(result.error, null);
  assert.equal(api.posted.length, 1);
  assert.match(api.posted[0].note, /Email opened by jane@example\.com/);
  assert.deepEqual(db.state.notified.map((n) => n.email_uuid), ["e1"]);
});

test("a second tenant on the same account does not re-post an already notified email", async () => {
  // Two /install visits leave two tenant rows polling one ServiceM8 account.
  // Deduping account-wide (not per tenant) is what stops the customer seeing
  // the same read receipt twice.
  const db = fakeDb({
    tenants: [{ tenant_id: "t1" }, { tenant_id: "t2" }],
    notified: [{ tenant_id: "t1", email_uuid: "e1" }],
  });
  const api = fakeApi({ emails: [openedEmail("e1")] });

  const summary = await pollAllTenants({ DB: db }, { api });

  assert.equal(summary.tenants, 2);
  assert.equal(summary.notified, 0);
  assert.equal(api.posted.length, 0);
});

test("records every run, including which schedule fired it", async () => {
  const db = fakeDb({ tenants: [{ tenant_id: "t1" }] });
  await pollAllTenants({ DB: db }, { source: "cron:*/10 * * * *", api: fakeApi() });

  const runLevel = db.state.runs.filter((r) => r.tenant_id === null);
  assert.equal(runLevel.length, 1, "one run-level row per poll");
  assert.equal(runLevel[0].source, "cron:*/10 * * * *");
  assert.equal(runLevel[0].ok, 1);
  assert.ok(runLevel[0].finished_at, "run is marked finished");
  assert.equal(db.state.runs.filter((r) => r.tenant_id === "t1").length, 1, "one row per tenant polled");
});

test("a failing tenant is recorded and does not stop the other tenants", async () => {
  const db = fakeDb({ tenants: [{ tenant_id: "t1" }, { tenant_id: "t2" }] });
  let call = 0;
  const api = {
    async listRecentEmails() {
      call++;
      if (call === 1) throw new Error("ServiceM8 API /email.json failed: 404 Not Found");
      return [openedEmail("e9")];
    },
    async createJobNote() {
      return "note-uuid";
    },
  };

  const summary = await pollAllTenants({ DB: db }, { api });

  assert.equal(summary.failures.length, 1);
  assert.match(summary.failures[0], /404 Not Found/);
  assert.equal(summary.notified, 1, "the healthy tenant still got its note");
  const failed = db.state.runs.find((r) => r.tenant_id === "t1");
  assert.equal(failed.ok, 0);
  assert.match(failed.error, /404 Not Found/);
});

test("a rejected refresh token parks the tenant instead of retrying forever", async () => {
  const db = fakeDb({ tenants: [{ tenant_id: "t1" }] });
  const listError = new ServiceM8TokenError("ServiceM8 OAuth token request failed: 400 invalid_grant", { status: 400 });
  const api = fakeApi({ listError });

  const result = await pollTenantForReadReceipts({ DB: db }, "t1", { api });

  assert.match(result.error, /tenant parked: reauth_required/);
  assert.equal(db.state.tenants[0].status, "reauth_required");

  // Parked tenants drop out of the cron's working set.
  const summary = await pollAllTenants({ DB: db }, { api: fakeApi() });
  assert.equal(summary.tenants, 0);
});

test("a ServiceM8 outage is retried rather than parking the tenant", async () => {
  const db = fakeDb({ tenants: [{ tenant_id: "t1" }] });
  const listError = new ServiceM8TokenError("ServiceM8 OAuth token request failed: 503 unavailable", { status: 503 });

  await pollTenantForReadReceipts({ DB: db }, "t1", { api: fakeApi({ listError }) });

  assert.equal(db.state.tenants[0].status, "active");
});

test("an email whose note fails to post is left for the next run to retry", async () => {
  const db = fakeDb({ tenants: [{ tenant_id: "t1" }] });
  const api = fakeApi({ emails: [openedEmail("e1", "job-bad")], failNoteFor: "job-bad" });

  const result = await pollTenantForReadReceipts({ DB: db }, "t1", { api });

  assert.equal(result.notified, 0);
  assert.match(result.error, /email e1/);
  assert.deepEqual(db.state.notified, [], "nothing recorded, so the next poll tries again");
});

test("missing OAuth config is reported as config, not as a ServiceM8 problem", async () => {
  const { exchangeCodeForTokens } = await import("../src/servicem8-oauth.js");
  await assert.rejects(
    () => exchangeCodeForTokens({ SERVICEM8_APP_ID: "123" }, { code: "c", redirectUri: "r" }),
    /SERVICEM8_APP_SECRET is unset/
  );
});

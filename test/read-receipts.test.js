import { test } from "node:test";
import assert from "node:assert/strict";
import { selectNewlyOpenedEmails, formatReadReceiptNote } from "../src/read-receipts.js";

function email({ uuid, job = "job-1", opened = "1", firstOpenedAt = "2026-08-18 15:45:00", to, subject }) {
  return {
    uuid,
    related_object_uuid: job,
    opened,
    first_opened_at: firstOpenedAt,
    ...(to ? { to } : {}),
    ...(subject ? { subject } : {}),
  };
}

test("selects an opened email that hasn't been notified yet", () => {
  const selected = selectNewlyOpenedEmails([email({ uuid: "e1" })], new Set());
  assert.equal(selected.length, 1);
  assert.equal(selected[0].uuid, "e1");
});

test("skips an email already notified on", () => {
  const selected = selectNewlyOpenedEmails([email({ uuid: "e1" })], new Set(["e1"]));
  assert.deepEqual(selected, []);
});

test("skips an unopened email even if flagged opened=0", () => {
  const selected = selectNewlyOpenedEmails([email({ uuid: "e1", opened: "0", firstOpenedAt: null })], new Set());
  assert.deepEqual(selected, []);
});

test("treats ServiceM8's zero-date sentinel as not actually opened", () => {
  // Seen live elsewhere in this account: `opened` can be truthy with no real
  // timestamp behind it yet -- require an actual first_opened_at, not just the flag.
  const selected = selectNewlyOpenedEmails([email({ uuid: "e1", firstOpenedAt: "0000-00-00 00:00:00" })], new Set());
  assert.deepEqual(selected, []);
});

test("handles opened as a real boolean or a numeric 1, not just the string \"1\"", () => {
  assert.equal(selectNewlyOpenedEmails([email({ uuid: "e1", opened: true })], new Set()).length, 1);
  assert.equal(selectNewlyOpenedEmails([email({ uuid: "e2", opened: 1 })], new Set()).length, 1);
});

test("drops a record missing the fields needed to act on it", () => {
  assert.deepEqual(selectNewlyOpenedEmails([{ opened: "1", first_opened_at: "2026-08-18 15:45:00" }], new Set()), [], "no uuid");
  assert.deepEqual(selectNewlyOpenedEmails([{ uuid: "e1", opened: "1", first_opened_at: "2026-08-18 15:45:00" }], new Set()), [], "no related_object_uuid");
});

test("handles a mixed batch, keeping only the ones that need a note", () => {
  const emails = [
    email({ uuid: "e1" }), // fresh open, should notify
    email({ uuid: "e2" }), // already notified
    email({ uuid: "e3", opened: "0", firstOpenedAt: null }), // never opened
  ];
  const selected = selectNewlyOpenedEmails(emails, new Set(["e2"]));
  assert.deepEqual(selected.map((e) => e.uuid), ["e1"]);
});

test("formats a note with recipient, subject, and ServiceM8's own local timestamp string", () => {
  const note = formatReadReceiptNote(email({ uuid: "e1", to: "jane@example.com", subject: "Your quote" }));
  assert.equal(note, '📧 Email opened by jane@example.com ("Your quote") -- 2026-08-18 15:45:00');
});

test("formats a note gracefully when recipient/subject are missing", () => {
  const note = formatReadReceiptNote(email({ uuid: "e1" }));
  assert.equal(note, "📧 Email opened -- 2026-08-18 15:45:00");
});

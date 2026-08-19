# Read Receipts for Mobile

ServiceM8 shows whether a sent email was opened (Job Diary "Email opened at
...") but only on desktop. This add-on posts a **Job Note** when an email
gets opened -- Job Notes already sync to the native mobile app, so the read
receipt shows up there with no custom UI needed.

No dashboard, no webhooks, no setup wizard. Install it and a background cron
(every 10 minutes) does the rest.

## How it works

1. `src/read-receipts.js`'s `pollAllTenants` runs every 10 minutes (see
   `wrangler.jsonc`'s `triggers.crons`).
2. For each installed tenant, it fetches emails from ServiceM8's
   `email.json` and picks out the ones that are newly opened (`opened` +
   a real `first_opened_at`) and haven't already had a note posted
   (`notified_emails` table in D1).
3. For each one, it posts a Job Note like:
   `📧 Email opened by jane@example.com ("Your quote") -- 2026-08-18 15:45:00`
4. Records it in `notified_emails` so it's never posted twice.

The selection/formatting logic (`selectNewlyOpenedEmails`,
`formatReadReceiptNote`) is pure and covered by `test/read-receipts.test.js`
-- run with `npm test`.

## Already provisioned

- D1 database `read-receipts-mobile-db` exists and has the schema applied
  (see `schema.sql`) -- its `database_id` is already wired into
  `wrangler.jsonc`.

## Still needed before this can go live

1. **Register the add-on in the ServiceM8 Developer Portal** to get an App
   ID + Secret. Set:
   - Activation URL: `https://servicem8-read-receipts-mobile.phill-abb.workers.dev/install`
   - Callback URL: `https://servicem8-read-receipts-mobile.phill-abb.workers.dev/oauth/callback`
   - Scopes: `read_email manage_job_notes` (see the note on `manage_job_notes` below)

2. **Set the two secrets** on the deployed Worker (Cloudflare dashboard ->
   Workers -> this worker -> Settings -> Variables, or `wrangler secret put`
   if deploying from a machine with an authenticated `wrangler`):
   - `SERVICEM8_APP_ID`
   - `SERVICEM8_APP_SECRET`

3. **Connect this repo to Cloudflare Workers Builds** (Git integration) so
   pushes auto-deploy, the same way `servicem8-renewal-autopilot` is wired
   up -- Cloudflare dashboard -> Workers & Pages -> Create -> Connect to Git
   -> this repo.

4. **Install it**: once deployed, visit the Worker's `/install` URL (or the
   Developer Portal's Private Add-on Install URL) from within your
   ServiceM8 account.

## Two things flagged as unverified, to check on the first live run

Both are called out inline in the code (`grep -rn "NEEDS LIVE CONFIRMATION"`)
-- same practice as the sibling repo, which flags an assumption rather than
guessing silently:

- **`manage_job_notes` scope name** (`src/servicem8-oauth.js`): inferred from
  ServiceM8's `read_X`/`manage_X` pattern (`read_job_notes` is confirmed live
  elsewhere), but the write counterpart itself hasn't been. If the first
  note-post 403s, the error message will name the actual required scope --
  fix it there and re-authorize.
- **`edit_date` filter on `email.json`** (`src/servicem8-api.js`): assumed to
  work like other ServiceM8 objects, to bound each poll to recently-touched
  emails. If it's rejected or ignored, the poller still works correctly
  (the `notified_emails` dedupe table prevents duplicate notes either way) --
  it would just be scanning more emails per run than necessary. Worth
  checking Worker logs once live.

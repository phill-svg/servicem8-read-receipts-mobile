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

- D1 database `read-receipts-mobile-db` exists, its `database_id` is wired
  into `wrangler.jsonc`, and the schema **has been applied** (2026-09-05):
  `tenants`, `oauth_tokens`, `notified_emails` and
  `idx_notified_emails_tenant` are all present. Re-running
  `npm run db:init:remote` is harmless -- every statement is
  `CREATE ... IF NOT EXISTS`.

## Still needed before this can go live

1. **Register the add-on in the ServiceM8 Developer Portal** to get an App
   ID + Secret. Set:
   - Add-on Type: **External Integration**. Not "Self-Hosted Web Service
     Function" -- that type's Callback URL field is for add-on *Action*
     events (an HTTP POST carrying a JWT signed with the App Secret), not
     for OAuth. This add-on declares no actions, so nothing would ever call
     it.
   - Addon Manifest: upload `addon-manifest.json`.
   - Addon Activation URL: `https://servicem8-read-receipts-mobile.phill-abb.workers.dev/install`
   - Scopes: `read_email publish_job_notes`

   There is no portal field for the OAuth callback and none is needed:
   ServiceM8 takes `redirect_uri` as a query parameter on the authorize URL,
   which `buildAuthorizeUrl` in `src/servicem8-oauth.js` already sets to
   `<origin>/oauth/callback`.

2. **Set the two secrets** on the deployed Worker (Cloudflare dashboard ->
   Workers -> this worker -> Settings -> Variables, or `wrangler secret put`
   if deploying from a machine with an authenticated `wrangler`):
   - `SERVICEM8_APP_ID`
   - `SERVICEM8_APP_SECRET`

3. **Connect this repo to Cloudflare Workers Builds** (Git integration) so
   pushes auto-deploy, the same way `servicem8-renewal-autopilot` is wired
   up -- Cloudflare dashboard -> Workers & Pages -> Create -> Connect to Git
   -> this repo.

4. ~~**Apply the schema** to the remote D1 database.~~ Done -- see
   "Already provisioned" above. (Had this been skipped, `/install` would
   have completed the whole OAuth handshake and then failed on the
   callback's `INSERT INTO tenants`, showing only "Installation failed --
   please try again".)

5. **Install it**: once deployed, visit the Worker's `/install` URL (or the
   Developer Portal's Private Add-on Install URL) from within your
   ServiceM8 account.

## Current status

Not deployed. `https://servicem8-read-receipts-mobile.phill-abb.workers.dev/install`
serves Cloudflare's "There is nothing here yet" placeholder, and no Worker by
that name exists in the account -- so step 3 (Workers Builds, or a
`wrangler deploy` from an authenticated machine) has to happen before the
add-on can be installed or its `iconURL` can resolve.

When wiring up Workers Builds, make sure it targets a **new** Worker that
`wrangler.jsonc` names `servicem8-read-receipts-mobile`. Pointing the build
at an existing Worker makes Cloudflare suggest renaming `wrangler.jsonc` to
match it -- taking that suggestion would move the add-on to a different
`workers.dev` hostname and break the Activation URL and `iconURL` already
registered in the ServiceM8 Developer Portal.

## One thing still flagged as unverified

Called out inline in the code (`grep -rn "NEEDS LIVE CONFIRMATION"`):

- **`edit_date` filter on `email.json`** (`src/servicem8-api.js`): assumed to
  work like other ServiceM8 objects, to bound each poll to recently-touched
  emails. If it's rejected or ignored, the poller still works correctly
  (the `notified_emails` dedupe table prevents duplicate notes either way) --
  it would just be scanning more emails per run than necessary. Worth
  checking Worker logs once live.

(The OAuth scope for creating notes -- `publish_job_notes` -- is confirmed
against ServiceM8's own published scope list, not a guess.)

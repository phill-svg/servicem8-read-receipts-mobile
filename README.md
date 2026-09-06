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
  into `wrangler.jsonc`, and the schema **has been applied**: `tenants`,
  `oauth_tokens`, `notified_emails` and `idx_notified_emails_tenant`
  (2026-09-05), plus `poll_runs` (2026-09-06). Re-running
  `npm run db:init:remote` is harmless -- every statement is
  `CREATE ... IF NOT EXISTS`.

## Current status (2026-09-06)

Deployed, installed, and **not posting any notes**. What the live D1 database
says:

- Worker `servicem8-read-receipts-mobile` is deployed and serving the bundle
  built from `src/` (last deploy 2026-09-05 14:48 UTC).
- The schema is applied, including `poll_runs` (added 2026-09-06).
- **Two tenants installed** -- 2026-09-05 14:49:35 and 15:09:58 UTC -- both
  with scope `read_email publish_job_notes`. So `SERVICEM8_APP_ID` and
  `SERVICEM8_APP_SECRET` are set correctly on the Worker: the OAuth code
  exchange cannot succeed otherwise. That question is settled.
- `notified_emails` is **empty**. No read receipt has ever been posted.
- `oauth_tokens.updated_at` still equals `installed_at` for both tenants, and
  ServiceM8 issues 1-hour access tokens. **No token has ever been refreshed**,
  so nothing has successfully called the ServiceM8 API since roughly an hour
  after install.

That last point narrows the fault to one of two things, which until now looked
identical from the outside because both leave no trace:

1. **The cron never fires.** Check the Worker's Triggers tab in the Cloudflare
   dashboard actually lists `*/10 * * * *`. A Workers Builds deploy that
   doesn't apply `triggers.crons` leaves the Worker live and reachable but
   never scheduled -- exactly what the symptoms look like.
2. **Every token refresh fails.** ServiceM8 rotates refresh tokens, and the
   second install may have revoked the first grant. A refresh that 4xxs leaves
   the tenant permanently stuck.

## Diagnosing it

`poll_runs` (see `src/diagnostics.js`) exists because Worker logs aren't
reachable from everywhere this is maintained, but D1 always is. Every poll --
cron or manual -- writes a row before it does anything, so an empty table is
itself the answer to "is the cron firing?".

- **In a browser:** `/debug/status` returns install state, whether each secret
  is present, `last_cron_run`, and the last 15 runs with their errors. It
  exposes no tokens and truncates tenant ids.
- **Force a run now:** `/debug/poll-all` runs the exact code path the cron
  runs and returns the result, rather than waiting up to 10 minutes.
  Rate-limited to one manual run per 30 seconds.
- **Straight from D1:**
  `SELECT * FROM poll_runs ORDER BY id DESC LIMIT 20;`

Both `/debug` routes are open by default -- deliberately, since they're the
tool for triaging a deployment before anything else about it is known to work.
Set a `DEBUG_KEY` secret on the Worker to require `?key=...` on them.

## If a tenant needs reinstalling

A refresh token ServiceM8 rejects outright (any 4xx) is gone for good, so the
poller parks that tenant as `status = 'reauth_required'` and stops polling it
rather than retrying every 10 minutes forever. The fix is to visit `/install`
again. That's safe to do: notes are deduped account-wide by email UUID, not
per tenant, so a replacement tenant will not re-notify anything the parked one
already handled.

## Known gaps

- **Every `/install` visit creates a new tenant.** Nothing in ServiceM8's OAuth
  response identifies the account, and this add-on declares no actions, so
  there's no add-on JWT callback to resolve the real account UUID from (the
  way `servicem8-renewal-autopilot` does). Installing twice therefore leaves
  two tenant rows polling the same account. The account-wide dedupe means they
  can't double-post, but they do double the API calls. Resolving this properly
  needs an account identifier from ServiceM8.
- **The OAuth `state` parameter is generated but never validated** on the
  callback. It should be stored at `/install` and checked on return.

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

2. ~~**Set the two secrets** on the deployed Worker.~~ Done -- proven by two
   successful OAuth exchanges, see "Current status".

3. **Connect this repo to Cloudflare Workers Builds** (Git integration) so
   pushes auto-deploy, the same way `servicem8-renewal-autopilot` is wired
   up -- Cloudflare dashboard -> Workers & Pages -> Create -> Connect to Git
   -> this repo. **Confirm the Triggers tab shows the cron afterwards** --
   see cause 1 above.

4. ~~**Apply the schema** to the remote D1 database.~~ Done.

5. ~~**Install it.**~~ Done twice -- see "Current status".

One trap worth remembering if this is ever rewired: point Workers Builds at a
Worker whose name matches `wrangler.jsonc`. Aiming it at an existing Worker
makes Cloudflare suggest renaming `wrangler.jsonc` to match *that* Worker
instead -- taking the suggestion moves the add-on to a different
`workers.dev` hostname and breaks the Activation URL and `iconURL` registered
in the Developer Portal. That mismatch is what failed the first build here.

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

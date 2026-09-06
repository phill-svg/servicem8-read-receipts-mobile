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
  (2026-09-05), plus `poll_runs` and `tenant_baselines` (2026-09-06). Re-running
  `npm run db:init:remote` is harmless -- every statement is
  `CREATE ... IF NOT EXISTS`.

## What was wrong (resolved 2026-09-06)

The add-on was deployed and installed for 22 hours and posted nothing. The
cause, once `poll_runs` could show it:

```
GET /email.json?$filter=edit_date gt '2026-08-07 13:27:57'
400 {"errorCode":400,"message":"Unsupported $filter field: edit_date"}
```

**ServiceM8 does not accept an `edit_date` filter on `email.json`.** Every poll
had 400'd since install. This was the one assumption the original build flagged
as unverified, and it was wrong -- see "Filtering `email.json`" below.

It took so long to find because nothing recorded it. Both plausible causes --
"the cron never fires" and "every poll fails" -- left exactly the same trace,
which was none: no notes, and `oauth_tokens.updated_at` frozen at install time,
because a poll that dies before its first API call never refreshes a token
either. `poll_runs` exists so that never happens again.

Ruled out along the way, all confirmed rather than assumed:

- `SERVICEM8_APP_ID` / `SERVICEM8_APP_SECRET` are set correctly -- two OAuth
  code exchanges succeeded, which is impossible otherwise.
- The cron trigger is registered (`*/10 * * * *` in the Worker's Triggers tab)
  and fires -- confirmed in Workers Logs with `eventType: scheduled`.
- Token refresh works. The frozen `updated_at` was a symptom of the 400, not a
  second fault: the first manual poll refreshed both tenants immediately.

Two real bugs were found while tracing it, both fixed before they could bite:
notes were deduped per tenant when every `/install` visit mints a new tenant id
(so the two installed tenants would have posted every read receipt twice), and
the first successful poll would have dumped the entire backlog onto live
customer jobs.

## Diagnosing it

`poll_runs` (see `src/diagnostics.js`) exists because Worker logs aren't
reachable from everywhere this is maintained, but D1 always is. Every poll --
cron or manual -- writes a row before it does anything, so an empty table is
itself the answer to "is the cron firing?".

- **In a browser:** `/debug/status` returns install state, whether each secret
  is present, `last_cron_run`, and the last 15 runs with their errors. It
  exposes no tokens and truncates tenant ids.

  One trap: `last_cron_run` is only meaningful once this code is in
  **production**. Reading it from a branch preview always shows `null` --
  previews never run the schedule, and the production deployment can only
  record a cron run once it carries the code that writes `poll_runs`. Until
  then a `null` there proves nothing about cause 1.
- **Force a run now:** `/debug/poll-all` runs the exact code path the cron
  runs and returns the result, rather than waiting up to 10 minutes.
  Rate-limited to one manual run per 30 seconds.
- **Straight from D1:**
  `SELECT * FROM poll_runs ORDER BY id DESC LIMIT 20;`

Both `/debug` routes are open by default -- deliberately, since they're the
tool for triaging a deployment before anything else about it is known to work.
Set a `DEBUG_KEY` secret on the Worker to require `?key=...` on them.

## The first poll posts nothing, on purpose

The poll is unfiltered, so the first successful one sees every email the
account has ever opened -- and would otherwise post a note for all of them at
once, onto real customer jobs, with no undo. Instead a
tenant's first successful poll records what it found in `notified_emails`,
writes a `tenant_baselines` row, and posts nothing; every poll after that
notifies normally.

So the first green run reports `notified: 0` and `seeded: N`. That is the
system working, not failing -- open an email after it and the next poll (within
10 minutes) should post the note.

To deliberately replay a tenant's backlog, delete its `tenant_baselines` row
and its `notified_emails` rows, then poll again.

Seeding writes in batches of 50. That's not premature optimisation: the first
real seeding run wrote 645 rows one at a time and took **2m39s** (`poll_runs`
row 9: 159,429ms). It did complete -- an earlier note here said the Worker was
killed mid-run, which was wrong; that reading was taken while the run was still
in flight and `finished_at` was still NULL. But 2m39s of a 10-minute cron spent
on one tenant's first poll is far too close to the edge, and a larger backlog
would have crossed it. Batched, the same 645 rows are 13 round trips.

For contrast, a steady-state run scans 1003 records across both tenants in
about 5.5 seconds.

The `notified_emails` rows are written before the `tenant_baselines` row, so a
seeding run that dies partway is simply finished by the next poll -- the rows
already down are skipped, and nothing in the backlog is ever notified.

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

- **The two installed tenants do not see the same account.** On the first
  successful poll (2026-09-06) tenant `146bd1d0...` scanned 3 emails and seeded
  2, while `d3b1d07c...` seeded 645. If both were meant to be the same
  ServiceM8 account they would see identical data, so one of them -- almost
  certainly the earlier `146bd1d0...`, installed at 14:49 and superseded 20
  minutes later -- is a stray from a first attempt. It costs an extra full
  `/email.json` fetch every 10 minutes and posts nothing useful. Confirm which
  is live before removing the other:
  `UPDATE tenants SET status = 'uninstalled', uninstalled_at = <now> WHERE tenant_id = '...'`.

## Setup checklist

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
   successful OAuth exchanges.

3. ~~**Connect this repo to Cloudflare Workers Builds**~~ Done -- the Git
   integration is live. Pushes to `main` deploy to production; pushes to any
   other branch upload a preview version only, which is why a branch preview
   never runs the cron. Handy while debugging: a preview URL still shares the
   production D1 binding and secrets, so `/debug/poll-all` on a branch preview
   exercises the real thing without touching the production deployment.

4. ~~**Apply the schema** to the remote D1 database.~~ Done.

5. ~~**Install it.**~~ Done twice (2026-09-05). Twice was one time too many --
   see "Known gaps".

6. ~~**Confirm the cron is registered and firing.**~~ Done -- `*/10 * * * *`
   shows in the Worker's Triggers tab, and Workers Logs shows the
   `eventType: scheduled` invocations.

One trap worth remembering if this is ever rewired: point Workers Builds at a
Worker whose name matches `wrangler.jsonc`. Aiming it at an existing Worker
makes Cloudflare suggest renaming `wrangler.jsonc` to match *that* Worker
instead -- taking the suggestion moves the add-on to a different
`workers.dev` hostname and breaks the Activation URL and `iconURL` registered
in the Developer Portal. That mismatch is what failed the first build here.

## Filtering `email.json`

Confirmed live 2026-09-06: **`edit_date` is not a supported `$filter` field on
`email.json`.** ServiceM8 answers `400 Unsupported $filter field: edit_date`.
The original build assumed it worked like other ServiceM8 objects, and that
assumption is what kept the add-on silent from the day it was installed.

`listRecentEmails` therefore sends no filter at all. Which fields *are*
filterable isn't documented per object, and guessing wrong is asymmetric:

- A **rejected** filter is loud -- a 400, like the one above.
- An **accepted** filter that matches nothing is silent. The poller would look
  perfectly healthy and quietly never post another note.

Fetching too much is the safe direction to be wrong in, and the dedupe table
already makes a wide scan harmless. `poll_runs.scanned` records how wide it
actually is. Narrow it only with that number in hand, and only to a filter
proven against a live account.

**The 1000-record ceiling, settled.** Probed against the live account
2026-09-06:

| Request | Result |
| --- | --- |
| `/email.json` | 200, 1000 rows |
| `?$top=5` | 200, **1000** rows, identical first/last uuid |
| `?$top=1000&$skip=1000` | 200, **1000** rows, identical first/last uuid |
| `?$filter=opened eq '1'` | 400 `Unsupported $filter field: opened` |

So `$top` and `$skip` are accepted and **silently ignored**, and `opened` is no
more filterable than `edit_date` was. ServiceM8 pages `/email.json` with a
cursor instead: the response carries an `x-next-cursor` header, which you pass
back as `?cursor=<value>`, and the header is absent on the last page.

`listRecentEmails` walks pages driven entirely by that header, which is what
makes it safe: if ServiceM8 doesn't send it, the walk makes exactly one request
and behaves identically to the unpaged version. It cannot spin and cannot fetch
less than before. It stops on the last page, an empty page, a repeated cursor,
or 20 pages (20k emails), whichever comes first.

**And that safety net is currently load-bearing: the walk is inert.** The
first cron run with paging deployed (14:20) still scanned exactly 1000, so
ServiceM8 is *not* sending `x-next-cursor` on `/email.json`. The header name
came from a search summary of ServiceM8's docs rather than from the live API --
a guess, which is the mistake this project has now made three times.

So the ceiling is still unresolved, and `/debug/probe-emails` has been rebuilt
to stop guessing: it dumps **every** response header, and probes the cursor with
a value taken from live data (the first page's `last_uuid` replayed as
`?cursor=`) rather than an invented one. If page two comes back with different
uuids, that's the mechanism. It also tries `page=2` and `per_page=5`.

Left unpaged, this was a live silent-failure waiting to happen: the poller
would have sat on exactly 1000 records looking perfectly healthy while never
seeing the 1001st.

(The OAuth scope for creating notes -- `publish_job_notes` -- is confirmed
against ServiceM8's own published scope list, not a guess.)

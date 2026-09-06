-- Read Receipts for Mobile -- multi-tenant ServiceM8 Add-on schema.
-- Deliberately much smaller than servicem8-renewal-autopilot/schema.sql:
-- no dashboard, no webhooks, no per-tenant config -- just OAuth tokens and a
-- dedupe table for which opened emails already got a job note posted.

-- status: active | reauth_required | uninstalled. Only 'active' tenants are
-- polled. A tenant is parked as 'reauth_required' when ServiceM8 rejects its
-- refresh token outright (revoked, or superseded by a re-install) -- retrying
-- that forever just burns cron runs, and the fix is a fresh visit to /install.
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id      TEXT PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'active',
  installed_at   INTEGER NOT NULL,
  uninstalled_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  tenant_id               TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
  access_token             TEXT NOT NULL,
  refresh_token            TEXT NOT NULL,
  access_token_expires_at  INTEGER NOT NULL,
  scope                    TEXT,
  updated_at               INTEGER NOT NULL
);

-- One row per email we've posted a "opened" job note for, so the poller
-- never posts a duplicate note on a later run. opened_at is ServiceM8's own
-- account-local datetime string, kept for debugging/audit only.
CREATE TABLE IF NOT EXISTS notified_emails (
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  email_uuid   TEXT NOT NULL,
  job_uuid     TEXT,
  opened_at    TEXT,
  notified_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email_uuid)
);
CREATE INDEX IF NOT EXISTS idx_notified_emails_tenant ON notified_emails(tenant_id);

-- Poll history -- see src/diagnostics.js. One row per cron/manual run plus one
-- per tenant polled within it (tenant_id NULL marks the run-level row). This is
-- how the add-on is debugged: Worker logs aren't reachable from everywhere the
-- code is maintained, but D1 always is.
CREATE TABLE IF NOT EXISTS poll_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,           -- NULL means the run never completed
  source      TEXT NOT NULL,     -- 'cron:<expr>' | 'manual'
  tenant_id   TEXT,
  scanned     INTEGER,
  notified    INTEGER,
  ok          INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_poll_runs_started ON poll_runs(started_at);

-- First-poll baseline -- see "backfill" in src/read-receipts.js. The poller
-- looks back 30 days, so a tenant's very first successful poll would otherwise
-- post a note for every email opened in the last month, all at once, onto real
-- customer jobs. Instead that first poll records those emails as already
-- handled and posts nothing; only opens from then on raise a note.
-- To deliberately replay a tenant's backlog: delete its row here and its
-- notified_emails rows, then poll again.
CREATE TABLE IF NOT EXISTS tenant_baselines (
  tenant_id    TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
  baselined_at INTEGER NOT NULL,
  suppressed   INTEGER NOT NULL
);

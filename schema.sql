-- Read Receipts for Mobile -- multi-tenant ServiceM8 Add-on schema.
-- Deliberately much smaller than servicem8-renewal-autopilot/schema.sql:
-- no dashboard, no webhooks, no per-tenant config -- just OAuth tokens and a
-- dedupe table for which opened emails already got a job note posted.

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id      TEXT PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'active', -- active | uninstalled
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

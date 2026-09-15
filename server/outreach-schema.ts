import type { DB } from './database';

export function installOutreachSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS funnels (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, audience TEXT NOT NULL DEFAULT '', steps_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','ACTIVE','PAUSED')),
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS funnels_project ON funnels(project_id);
    CREATE TABLE IF NOT EXISTS funnel_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
      funnel_id INTEGER NOT NULL REFERENCES funnels(id), lead_id INTEGER NOT NULL REFERENCES leads(id),
      recipient TEXT NOT NULL, lead_revision INTEGER NOT NULL, training_version INTEGER NOT NULL,
      account_id INTEGER NOT NULL REFERENCES accounts(id), created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK(status IN ('QUEUED','SENDING','COMPLETED','STOPPED','REPLIED','INTERESTED','CONVERTED','UNSUBSCRIBED','BLOCKED')),
      next_step INTEGER NOT NULL DEFAULT 0, next_send_at INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(funnel_id,lead_id)
    );
    CREATE INDEX IF NOT EXISTS enrollments_due ON funnel_enrollments(status,next_send_at);
    CREATE INDEX IF NOT EXISTS enrollments_project ON funnel_enrollments(project_id,funnel_id);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_funnel_per_recipient
      ON funnel_enrollments(recipient) WHERE status IN ('QUEUED','SENDING');
    CREATE TABLE IF NOT EXISTS email_suppressions (
      recipient TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
      token_hash TEXT PRIMARY KEY, recipient TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_deliveries (
      id INTEGER PRIMARY KEY, delivery_key TEXT NOT NULL UNIQUE,
      project_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, recipient TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('SENDING','SENT','FAILED','UNKNOWN','BLOCKED')),
      message_id INTEGER, started_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS deliveries_recipient ON email_deliveries(recipient,status);
    CREATE INDEX IF NOT EXISTS deliveries_message ON email_deliveries(message_id) WHERE message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS sent_messages_recipient ON email_messages(lower(trim(to_email))) WHERE status='SENT';
    CREATE UNIQUE INDEX IF NOT EXISTS one_send_per_recipient
      ON email_deliveries(recipient) WHERE status='SENDING';
    CREATE TABLE IF NOT EXISTS outreach_events (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id), outcome TEXT NOT NULL,
      notes TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outreach_events_lead ON outreach_events(project_id,lead_id);
  `);
  const columns = db.prepare('PRAGMA table_info(leads)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'outreach_status'))
    db.exec("ALTER TABLE leads ADD COLUMN outreach_status TEXT NOT NULL DEFAULT 'NOT_CONTACTED'");
}

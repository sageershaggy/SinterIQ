import type { DB } from './database';

/**
 * Attachments, inline images, bounces, campaign options and archiving. Additive only: new
 * tables, and new columns with defaults that keep every existing row meaning what it meant.
 */
export function installEmailSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL CHECK(kind IN ('attachment','image')),
      filename TEXT NOT NULL, content_type TEXT NOT NULL,
      size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL,
      width INTEGER, height INTEGER,
      account_id INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_files_project ON email_files(project_id,id);
    -- What each logged message carried, so history can show it. Goes with the message.
    CREATE TABLE IF NOT EXISTS email_message_files (
      message_id INTEGER NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
      file_id INTEGER NOT NULL REFERENCES email_files(id),
      disposition TEXT NOT NULL CHECK(disposition IN ('attachment','inline')),
      PRIMARY KEY (message_id,file_id)
    );
    -- Why an address stopped receiving mail. The suppression itself stays in email_suppressions.
    CREATE TABLE IF NOT EXISTS email_bounces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL, project_id INTEGER, lead_id INTEGER,
      source TEXT NOT NULL CHECK(source IN ('SMTP','DSN')),
      status_code TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_bounces_recipient ON email_bounces(recipient);
  `);
  const add = (table: string, column: string, definition: string) => {
    if (
      !(
        db.prepare('SELECT * FROM pragma_table_info(?)').all(table) as Array<{ name: string }>
      ).some((info) => info.name === column)
    )
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  };
  // Every existing funnel keeps stopping on a reply, which is what it always did.
  add('funnels', 'stop_on_reply', 'INTEGER NOT NULL DEFAULT 1');
  add('funnels', 'fit_band', "TEXT NOT NULL DEFAULT 'ANY'");
  // Per-enrollment send times the author chose when the first message went out by hand.
  add('funnel_enrollments', 'schedule_json', "TEXT NOT NULL DEFAULT ''");
  // Why a sequence stopped, where the status alone cannot say (a bounce, an archived lead).
  add('funnel_enrollments', 'stop_cause', "TEXT NOT NULL DEFAULT ''");
  add('project_email_templates', 'html', "TEXT NOT NULL DEFAULT ''");
  // Archiving hides a lead from the default lists without deleting anything.
  add('leads', 'archived_at', 'TEXT');
  add('leads', 'archived_reason', "TEXT NOT NULL DEFAULT ''");
  add('leads', 'archived_by', "TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS leads_project_archived ON leads(project_id,archived_at)');
}

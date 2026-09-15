import type { DB } from './database';

/** Additive workspace features; never migrate or rewrite research history. */
export function installWorkspaceSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS incoming_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_key TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL,
      internet_message_id TEXT NOT NULL, references_json TEXT NOT NULL,
      from_email TEXT NOT NULL, from_name TEXT NOT NULL, to_email TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL,
      attachment_count INTEGER NOT NULL DEFAULT 0, notice TEXT NOT NULL DEFAULT '',
      project_id INTEGER REFERENCES projects(id), lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      read_at TEXT, linked_at TEXT, created_at TEXT NOT NULL,
      UNIQUE(account_key,uid_validity,uid),
      CHECK((project_id IS NULL)=(lead_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS incoming_lead ON incoming_messages(project_id,lead_id,id DESC);
    CREATE INDEX IF NOT EXISTS incoming_identity ON incoming_messages(account_key,internet_message_id,from_email,received_at);
    CREATE TABLE IF NOT EXISTS mailbox_cursors (
      account_key TEXT PRIMARY KEY, uid_validity TEXT NOT NULL, last_uid INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_drafts (
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      revision INTEGER NOT NULL, document_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, lead_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS project_email_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
      subject TEXT NOT NULL, preview_text TEXT NOT NULL, blocks_json TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS templates_project ON project_email_templates(project_id);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES accounts(id),
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS notifications_account ON notifications(account_id, id DESC);
  `);
  const columns = db.prepare('PRAGMA table_info(email_messages)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'internet_message_id'))
    db.exec("ALTER TABLE email_messages ADD COLUMN internet_message_id TEXT NOT NULL DEFAULT ''");
  db.exec(
    "CREATE INDEX IF NOT EXISTS outbound_internet_id ON email_messages(internet_message_id) WHERE internet_message_id<>''",
  );
}

import { hash, now, type DB } from './database';

/**
 * A mailbox belongs to a project: every project sends from its own address and polls its own
 * inbox, so mail never crosses the project access boundary.
 *
 * Additive only. The legacy workspace rows in the settings table (the smtp_ keys and
 * imap_config) are left exactly where they are and simply stop being read, so rolling back to
 * the previous build finds its configuration intact.
 */
export function installMailboxSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_mailboxes (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      smtp_host TEXT NOT NULL DEFAULT '',
      smtp_port INTEGER NOT NULL DEFAULT 587,
      smtp_secure INTEGER NOT NULL DEFAULT 0,
      smtp_username TEXT NOT NULL DEFAULT '',
      smtp_password TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      from_email TEXT NOT NULL DEFAULT '',
      reply_to TEXT NOT NULL DEFAULT '',
      copy_to TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      imap_host TEXT NOT NULL DEFAULT '',
      imap_username TEXT NOT NULL DEFAULT '',
      imap_password TEXT NOT NULL DEFAULT '',
      imap_folder TEXT NOT NULL DEFAULT 'INBOX',
      imap_enabled INTEGER NOT NULL DEFAULT 0,
      imap_enabled_by INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      last_sync TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS project_mailbox_cursors (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      uid_validity TEXT NOT NULL, last_uid INTEGER NOT NULL
    );
  `);
  // Which project's mailbox received a message. Distinct from project_id/lead_id, which say
  // which lead it was matched to and stay null while a message is unlinked.
  for (const [table, column, definition] of [
    ['incoming_messages', 'mailbox_project_id', 'INTEGER REFERENCES projects(id)'],
    ['email_messages', 'from_email', "TEXT NOT NULL DEFAULT ''"],
  ] as const)
    if (
      !(
        db.prepare('SELECT * FROM pragma_table_info(?)').all(table) as Array<{ name: string }>
      ).some((info) => info.name === column)
    )
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  db.exec(`
    CREATE INDEX IF NOT EXISTS incoming_mailbox ON incoming_messages(mailbox_project_id,id DESC);
    CREATE INDEX IF NOT EXISTS incoming_project_identity
      ON incoming_messages(mailbox_project_id,internet_message_id,from_email,received_at);
  `);
}

/**
 * Moves the one workspace mailbox onto the projects that already exist.
 *
 * Sending is copied to every project, so nothing that works today stops working. Polling is
 * enabled for only ONE project, because two projects pointed at the same inbox each ingest
 * their own copy of every message, which would show one project's replies to another
 * project's members. The rest inherit the same settings, disabled, for an administrator to
 * confirm or repoint.
 */
export function adoptWorkspaceMailbox(db: DB) {
  if (db.prepare("SELECT 1 FROM meta WHERE key='project_mailboxes_v1'").get()) return;
  db.transaction(() => {
    const projects = db.prepare('SELECT id FROM projects ORDER BY id').all() as Array<{
      id: number;
    }>;
    const smtp = Object.fromEntries(
      (
        db.prepare("SELECT key,value FROM settings WHERE key LIKE 'smtp_%'").all() as Array<{
          key: string;
          value: string;
        }>
      ).map((row) => [row.key, row.value]),
    );
    const imapRow = db.prepare("SELECT value FROM settings WHERE key='imap_config'").get() as
      { value: string } | undefined;
    const imap = imapRow
      ? (JSON.parse(imapRow.value) as {
          host: string;
          username: string;
          password: string;
          folder: string;
          enabled: boolean;
          enabled_by: number;
          last_sync: string;
        })
      : null;
    const owner = projects[0];
    const insert = db.prepare(
      `INSERT OR IGNORE INTO project_mailboxes
        (project_id,smtp_host,smtp_port,smtp_secure,smtp_username,smtp_password,
         from_name,from_email,reply_to,copy_to,signature,
         imap_host,imap_username,imap_password,imap_folder,imap_enabled,imap_enabled_by,
         revision,last_sync,last_error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const project of projects) {
      const polls = Boolean(imap?.enabled) && project.id === owner?.id;
      insert.run(
        project.id,
        smtp.smtp_host || '',
        Number(smtp.smtp_port || 587),
        smtp.smtp_secure === '1' ? 1 : 0,
        smtp.smtp_username || '',
        // Ciphertext is copied verbatim: same workspace key, so nothing is re-encrypted here.
        smtp.smtp_password || '',
        smtp.smtp_from_name || '',
        smtp.smtp_from_email || '',
        smtp.smtp_reply_to || '',
        smtp.smtp_copy_to || '',
        smtp.smtp_signature || '',
        imap?.host || '',
        imap?.username || '',
        imap?.password || '',
        imap?.folder || 'INBOX',
        polls ? 1 : 0,
        polls ? imap?.enabled_by || 0 : 0,
        0,
        polls ? imap?.last_sync || '' : '',
        '',
      );
    }
    if (owner && imap?.host) {
      // Carry the IMAP resume point over so adoption does not re-download the inbox.
      const legacy = db
        .prepare('SELECT uid_validity,last_uid FROM mailbox_cursors WHERE account_key=?')
        .get(hash(JSON.stringify([imap.host, imap.username, imap.folder]))) as
        { uid_validity: string; last_uid: number } | undefined;
      if (legacy)
        db.prepare(
          'INSERT OR IGNORE INTO project_mailbox_cursors(project_id,uid_validity,last_uid) VALUES(?,?,?)',
        ).run(owner.id, legacy.uid_validity, legacy.last_uid);
    }
    // Mail already received belongs to the project that keeps polling it.
    if (owner)
      db.prepare(
        'UPDATE incoming_messages SET mailbox_project_id=? WHERE mailbox_project_id IS NULL',
      ).run(owner.id);
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('project_mailboxes_v1', now());
  })();
}

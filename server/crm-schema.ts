import type { DB } from './database';
import { callOutcomes } from '../shared/calls';

/**
 * Calling and the manual CRM layer. Additive: nothing here rewrites research, qualification or
 * an existing call entry.
 *
 * - call_logs keeps every entry it has; its outcome CHECK is widened to shared/calls.ts and it
 *   gains a next-action date.
 * - lead_status_events is the append-only history of the manual pipeline status. The current
 *   status is the newest row (New when there is none), so the history and the value can never
 *   disagree.
 * - lead_comments holds the team's comments on a lead.
 *
 * Both new tables cascade from leads, so deleting a lead deletes its status history and its
 * comments with it. Their enum columns are validated by the API rather than a CHECK, so a new
 * status never needs a table rebuild.
 */
export function installCrmSchema(db: DB) {
  widenCallLog(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_status_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      from_status TEXT NOT NULL, to_status TEXT NOT NULL,
      created_by_id INTEGER NOT NULL REFERENCES accounts(id),
      created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lead_status_events_lead
      ON lead_status_events(project_id, lead_id, id DESC);
    CREATE TABLE IF NOT EXISTS lead_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES accounts(id),
      author TEXT NOT NULL, body TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS lead_comments_lead ON lead_comments(project_id, lead_id, id DESC);
  `);
}

/**
 * SQLite cannot alter a CHECK constraint, so a call log whose outcome list is missing a value
 * from shared/calls.ts is rebuilt in one transaction: the stored CREATE statement is copied with
 * only the outcome list replaced, so any column added since (by anyone) survives, every row is
 * copied across with its id, and the table's indexes are recreated. It runs once: afterwards the
 * stored statement already lists every outcome.
 */
function widenCallLog(db: DB) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='call_logs'")
    .get() as { sql: string } | undefined;
  if (!table) return;
  const check = /CHECK\s*\(\s*outcome\s+IN\s*\([^)]*\)\s*\)/i;
  const current = check.exec(table.sql)?.[0];
  if (current && !callOutcomes.every((value) => current.includes("'" + value + "'"))) {
    const widened = table.sql
      .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["'`[]?call_logs["'`\]]?/i, () => {
        return 'CREATE TABLE call_logs_widened';
      })
      .replace(check, () => {
        return 'CHECK(outcome IN (' + callOutcomes.map((v) => "'" + v + "'").join(',') + '))';
      });
    if (!widened.startsWith('CREATE TABLE call_logs_widened'))
      throw new Error('The call log schema has an unexpected shape; not widening it.');
    const indexes = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='call_logs' AND sql IS NOT NULL",
        )
        .all() as Array<{ sql: string }>
    ).map((row) => row.sql);
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS call_logs_widened');
      db.exec(widened);
      db.exec('INSERT INTO call_logs_widened SELECT * FROM call_logs');
      db.exec('DROP TABLE call_logs');
      db.exec('ALTER TABLE call_logs_widened RENAME TO call_logs');
      for (const sql of indexes) db.exec(sql);
    })();
  }
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('call_logs') as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'next_action_at'))
    db.exec('ALTER TABLE call_logs ADD COLUMN next_action_at TEXT');
}

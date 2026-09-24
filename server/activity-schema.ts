import type { DB } from './database';

/**
 * Additive tables for the updates feed and the research log. Nothing here rewrites an existing
 * table.
 *
 * project_notifications: a lead notification's lead_id is NOT NULL, so updates about a project
 * as a whole (training published, a new draft, an import) get their own table rather than a
 * rebuilt one. Recipients are captured when the update is created, and access is checked again
 * on every read, exactly as for lead notifications.
 *
 * research_log_passes: the Research history log, one row per website research pass, including the passes that found
 * nothing — "checked three domains, none named the company" is research that was done. Only
 * field names, checked domains and the system's own notes are kept here; values and quotes stay
 * in lead_research_citations, so erasing a contact still erases what it said.
 *
 * research_runs_since marks when passes started being recorded: citations older than that have
 * no pass row, and the log groups them into passes itself.
 */
export function installActivitySchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES accounts(id),
      project_id INTEGER NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS project_notifications_account
      ON project_notifications(account_id, id DESC);
    CREATE TABLE IF NOT EXISTS research_log_passes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      website TEXT NOT NULL, discovered INTEGER NOT NULL,
      tried_json TEXT NOT NULL, applied_json TEXT NOT NULL, notes_json TEXT NOT NULL,
      refused_count INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS research_log_passes_project ON research_log_passes(project_id, id DESC);
    CREATE INDEX IF NOT EXISTS research_log_passes_lead
      ON research_log_passes(project_id, lead_id, id DESC);
  `);
  db.prepare("INSERT OR IGNORE INTO meta (key,value) VALUES ('research_runs_since',?)").run(
    new Date().toISOString(),
  );
}

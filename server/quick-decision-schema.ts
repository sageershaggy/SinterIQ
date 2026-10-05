import type { DB } from './database';

/**
 * The latest fast decision (Jev) per lead. Additive and separate from the leads row on purpose:
 * a quick decision never touches the lead's status, score, decision or revision. It records the
 * lead revision and training version it judged, so a later change shows it as out of date.
 * Deleting a lead deletes its quick decision.
 */
export function installQuickDecisionSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_quick_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      lead_revision INTEGER NOT NULL,
      training_version INTEGER NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('LIKELY_QUALIFIED','UNSURE','LIKELY_NOT')),
      score INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      UNIQUE(project_id, lead_id)
    );
  `);
}

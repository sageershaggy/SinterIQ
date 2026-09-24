import type { DB } from './database';

/**
 * Tables for the research log, the people found on a company's website, and the training
 * document upload log. Additive only: nothing here alters an existing table.
 *
 * lead_contacts holds personal data. A row exists only because a sentence on the company's own
 * site names that person; the sentence is kept on the row, so erasing the contact erases its
 * citation with it, and deleting the lead removes every row through the cascade.
 *
 * lead_research_runs is the research log. It records what a pass checked and wrote, never a
 * contact's details: those live in lead_contacts, where they can be erased.
 */
export function installIntelSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      name TEXT NOT NULL, name_key TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
      role_category TEXT NOT NULL
        CHECK(role_category IN ('purchasing','marketing','engineering','management','other')),
      email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL, evidence TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL,
      UNIQUE(project_id, lead_id, name_key)
    );
    CREATE INDEX IF NOT EXISTS lead_contacts_lead ON lead_contacts(project_id, lead_id);
    CREATE TABLE IF NOT EXISTS lead_research_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      origin TEXT NOT NULL CHECK(origin IN ('manual','qualification')),
      lead_revision INTEGER NOT NULL, result_revision INTEGER NOT NULL,
      summary_json TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lead_research_runs_lead
      ON lead_research_runs(project_id, lead_id, id DESC);
    CREATE TABLE IF NOT EXISTS source_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
      filename TEXT NOT NULL, size INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('READ','FAILED')),
      characters INTEGER NOT NULL DEFAULT 0, words INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS source_uploads_project ON source_uploads(project_id, id DESC);
  `);
}

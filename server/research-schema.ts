import type { DB } from './database';

/**
 * Where a researched value came from.
 *
 * A value written from a web page is only as good as its citation, so the sentence and the page
 * it came from are kept next to the value rather than living in one request's response. Without
 * this, a contact on a record has no provenance: nobody can tell later whether it was typed by a
 * colleague, extracted from the company's own site, or proposed and accepted in error.
 *
 * Append-only, like the rest of the research history. Erasing a lead's contact deletes the
 * contact rows here too, because the quote usually contains the personal detail itself.
 */
export function installResearchSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_research_citations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      field TEXT NOT NULL, value TEXT NOT NULL, evidence TEXT NOT NULL,
      source_url TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS research_citations_lead
      ON lead_research_citations(project_id,lead_id,id DESC);
  `);
}

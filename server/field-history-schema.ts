import type { DB } from './database';

/**
 * Additive table for where each company detail on a lead came from (server/field-history.ts).
 * Nothing here rewrites an existing row.
 *
 * lead_field_history: one row per change of a tracked field (shared/field-history.ts) — the value
 * it replaced, the new value and its origin: 'import' (the list), 'person' (the lead form) or
 * 'research' (the company's own website, with the sentence and page). Append-only. It cascades
 * with the lead, and project deletion finds it by its project_id like every other table.
 */
export function installFieldHistorySchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_field_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      field TEXT NOT NULL,
      previous_value TEXT NOT NULL,
      new_value TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('import','person','research')),
      evidence TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lead_field_history_lead
      ON lead_field_history(project_id,lead_id,field,id DESC);
  `);
  adoptTypedValues(db);
}

/** Who the adopted rows name: the audit log says a person did it, not which one for each field. */
export const earlierTeamEdit = 'your team';

/**
 * Once, when the table first appears on a database that already has leads: a lead the audit log
 * shows was created or edited on the lead form ('lead.created', 'lead.updated', which name the
 * lead) holds values a person typed, and research must not replace those. Which fields an edit
 * changed was never recorded, so every non-blank company detail of such a lead is adopted as
 * typed — except one a research citation shows research wrote. Leads only ever imported keep no
 * history and count as the original record. Additive and guarded by a meta key.
 */
function adoptTypedValues(db: DB) {
  if (db.prepare("SELECT 1 FROM meta WHERE key='lead_field_history_v1'").get()) return;
  db.transaction(() => {
    const leads = db
      .prepare(
        `SELECT l.id,l.project_id,l.website,l.country,l.city,l.industry,l.employee_count FROM leads l
        WHERE NOT EXISTS (SELECT 1 FROM lead_field_history h WHERE h.lead_id=l.id)
        AND EXISTS (SELECT 1 FROM audit_events a WHERE a.project_id=l.project_id
          AND ((a.action='lead.created' AND a.detail=l.name)
            OR (a.action='lead.updated' AND a.detail=l.name || '. Previous qualification retained for comparison.')))`,
      )
      .all() as Array<Record<string, string | number>>;
    const cited = db.prepare(
      'SELECT 1 FROM lead_research_citations WHERE project_id=? AND lead_id=? AND field=? AND value=? LIMIT 1',
    );
    const insert = db.prepare(
      `INSERT INTO lead_field_history
        (project_id,lead_id,field,previous_value,new_value,origin,changed_at,changed_by)
      VALUES (?,?,?,'',?,'person',?,?)`,
    );
    const at = new Date().toISOString();
    for (const lead of leads)
      for (const field of ['website', 'country', 'city', 'industry', 'employee_count']) {
        const value = String(lead[field] ?? '');
        if (!value.trim() || cited.get(lead.project_id, lead.id, field, value)) continue;
        insert.run(lead.project_id, lead.id, field, value, at, earlierTeamEdit);
      }
    db.prepare("INSERT INTO meta (key,value) VALUES ('lead_field_history_v1',?)").run(at);
  })();
}

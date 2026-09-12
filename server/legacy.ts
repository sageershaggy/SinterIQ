import Database from 'better-sqlite3';
import fs from 'node:fs';
import type { DB } from './database';
import type { PreservedRecord } from '../shared/types';

const kinds = ['contacts', 'activities', 'notes', 'research_history'] as const;
export function preserveLegacyResearch(db: DB, legacyPath?: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS preserved_research (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
    lead_id INTEGER REFERENCES leads(id), kind TEXT NOT NULL, legacy_id INTEGER NOT NULL,
    data_json TEXT NOT NULL, imported_at TEXT NOT NULL, UNIQUE(kind, legacy_id)
  );
  CREATE INDEX IF NOT EXISTS preserved_research_project_lead ON preserved_research(project_id,lead_id);`);
  // Existing installations already contain the company snapshots. Identify their actual project,
  // rather than assuming that project ID 1 is always Sintertechnik.
  if (!db.prepare("SELECT 1 FROM meta WHERE key='starter_project_id'").get()) {
    const starter = db
      .prepare(
        "SELECT project_id FROM sources WHERE filename='sintertechnik-training.md' AND title='Sintertechnik · qualification handbook' ORDER BY id LIMIT 1",
      )
      .get() as { project_id: number } | undefined;
    if (starter)
      db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run(
        'starter_project_id',
        String(starter.project_id),
      );
  }
  if (
    !legacyPath ||
    !fs.existsSync(legacyPath) ||
    db.prepare("SELECT 1 FROM meta WHERE key='preserved_research_v1'").get()
  )
    return;
  const original = new Database(legacyPath, { readonly: true, fileMustExist: true });
  try {
    db.transaction(() => {
      const timestamp = new Date().toISOString();
      const starter = db.prepare("SELECT value FROM meta WHERE key='starter_project_id'").get() as
        { value: string } | undefined;
      if (!starter) return;
      const leads = db
        .prepare('SELECT id,project_id,legacy_id FROM leads WHERE legacy_id IS NOT NULL')
        .all() as Array<{ id: number; project_id: number; legacy_id: number }>;
      const byOriginalId = new Map(leads.map((lead) => [lead.legacy_id, lead]));
      const insert = db.prepare(
        'INSERT OR IGNORE INTO preserved_research (project_id,lead_id,kind,legacy_id,data_json,imported_at) VALUES (?,?,?,?,?,?)',
      );
      let restored = 0;
      for (const kind of kinds) {
        if (
          !original.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(kind)
        )
          continue;
        for (const row of original.prepare('SELECT * FROM ' + kind).iterate() as Iterable<
          Record<string, unknown>
        >) {
          const originalCompanyId =
            kind === 'research_history' ? row.saved_to_company_id : row.company_id;
          const lead = byOriginalId.get(Number(originalCompanyId));
          // Unlinked research sessions remain project-level reference records.
          if (!lead && kind !== 'research_history') continue;
          restored += insert.run(
            lead?.project_id ?? Number(starter.value),
            lead?.id ?? null,
            kind,
            Number(row.id),
            JSON.stringify(row),
            timestamp,
          ).changes;
        }
      }
      // Newly available historical context must not silently change an existing qualification.
      db.prepare(
        'UPDATE leads SET revision=revision+1,updated_at=? WHERE legacy_id IS NOT NULL',
      ).run(timestamp);
      db.prepare(
        'INSERT INTO audit_events (project_id,actor,action,detail,created_at) VALUES (?,?,?,?,?)',
      ).run(
        Number(starter.value),
        'Migration',
        'research.restored',
        `${leads.length} company profiles and ${restored} earlier contact and research records are available for reference. Original data is unchanged.`,
        timestamp,
      );
      db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run(
        'preserved_research_v1',
        timestamp,
      );
    })();
  } finally {
    original.close();
  }
}

export function preservedRecords(db: DB, projectId: number, leadId?: number): PreservedRecord[] {
  const rows = db
    .prepare(
      'SELECT * FROM preserved_research WHERE project_id=?' +
        (leadId === undefined ? '' : ' AND lead_id=?') +
        ' ORDER BY id',
    )
    .all(...(leadId === undefined ? [projectId] : [projectId, leadId])) as Array<{
    id: number;
    project_id: number;
    lead_id: number | null;
    kind: PreservedRecord['kind'];
    legacy_id: number;
    data_json: string;
    imported_at: string;
  }>;
  return rows.map(({ data_json, ...row }) => ({ ...row, data: JSON.parse(data_json) }));
}

export function previousResearchContext(
  legacyJson: string | undefined,
  records: PreservedRecord[],
) {
  if (!legacyJson) return '';
  const company = JSON.parse(legacyJson) as Record<string, unknown>;
  const pick = (row: Record<string, unknown>, fields: string[]) =>
    Object.fromEntries(
      fields
        .filter((key) => row[key] !== null && row[key] !== undefined && row[key] !== '')
        .map((key) => [key, row[key]]),
    );
  // Contact identifiers and contact channels stay in the reference UI, not the AI request.
  return JSON.stringify({
    provenance:
      'Research carried over from the previous workspace. Historical, unverified context; re-check claims against current evidence and approved training. Previous scores and decisions are not the current decision.',
    company: pick(company, [
      'company_name',
      'city',
      'region',
      'legal_form',
      'company_type',
      'business_role',
      'employee_count',
      'revenue_eur',
      'corporate_parent',
      'is_subsidiary',
      'main_products',
      'product_fit',
      'technical_fit',
      'qualification_notes',
      'opportunity_notes',
      'disqualification_reason',
      'disqualification_category',
      'human_review_notes',
      'human_reviewed_at',
      'ai_qualified_at',
    ]),
    technical_observations: records
      .filter((row) => row.kind === 'contacts')
      .map((row) =>
        pick(row.data, [
          'job_title',
          'department',
          'interest_reason',
          'ceramic_bearing_experience',
          'attempted_solution',
          'operating_media',
          'hybrid_bearing_alternative',
          'cooperation_interest',
        ]),
      )
      .filter((row) => Object.keys(row).length),
    prior_notes: records
      .filter((row) => row.kind === 'notes')
      .map((row) => pick(row.data, ['message', 'type', 'created_at'])),
    research_activity: records
      .filter((row) => row.kind === 'activities')
      .map((row) =>
        pick(row.data, ['activity_type', 'activity_date', 'subject', 'details', 'outcome']),
      ),
  }).slice(0, 24000);
}

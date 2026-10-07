import { now, type DB } from './database';
import {
  trackedFields,
  type FieldChange,
  type FieldOrigin,
  type TrackedField,
} from '../shared/field-history';

/**
 * Per-field provenance for a lead's company details (lead_field_history,
 * server/field-history-schema.ts). Every path that writes one of the tracked fields records here:
 * the import (insert and duplicate update), the lead form (create and edit), research write-back
 * and detail conflicts. Two rules read it:
 *
 * - Research may replace a value whose latest origin is the import, earlier research or the
 *   original record (no history at all), never one a person typed.
 * - An import updating a duplicate may replace only an imported value (or one from the original
 *   record), never one research verified or a person typed.
 */
type Values = Partial<Record<TrackedField, unknown>>;

/**
 * Records every tracked field whose value differs between `before` and `after`. A field `after`
 * does not mention is not a change. Returns the fields recorded.
 */
export function recordFieldChanges(
  db: DB,
  options: {
    projectId: number;
    leadId: number;
    before: Values;
    after: Values;
    origin: FieldOrigin;
    actor: string;
    evidence?: string;
    sourceUrl?: string;
  },
): TrackedField[] {
  const insert = db.prepare(
    `INSERT INTO lead_field_history
      (project_id,lead_id,field,previous_value,new_value,origin,evidence,source_url,changed_at,changed_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const changed: TrackedField[] = [];
  for (const field of trackedFields) {
    if (!(field in options.after)) continue;
    const previous = String(options.before[field] ?? '');
    const next = String(options.after[field] ?? '');
    if (previous === next) continue;
    insert.run(
      options.projectId,
      options.leadId,
      field,
      previous,
      next,
      options.origin,
      options.evidence ?? '',
      options.sourceUrl ?? '',
      now(),
      options.actor,
    );
    changed.push(field);
  }
  return changed;
}

/**
 * Who set a field's current value. The latest recorded change says; with no history (a record
 * from before it was kept), a research citation of exactly this value still marks it researched,
 * and anything else is the original record (null).
 */
export function currentOrigin(
  db: DB,
  projectId: number,
  leadId: number,
  field: TrackedField,
  value: string,
): FieldOrigin | null {
  const latest = db
    .prepare(
      'SELECT origin FROM lead_field_history WHERE project_id=? AND lead_id=? AND field=? ORDER BY id DESC LIMIT 1',
    )
    .get(projectId, leadId, field) as { origin: FieldOrigin } | undefined;
  if (latest) return latest.origin;
  const cited = db
    .prepare(
      'SELECT 1 FROM lead_research_citations WHERE project_id=? AND lead_id=? AND field=? AND value=? LIMIT 1',
    )
    .get(projectId, leadId, field, value);
  return cited ? 'research' : null;
}

/** Research wins over an imported value, never over one a person typed. */
export function researchMayReplace(
  db: DB,
  projectId: number,
  leadId: number,
  field: TrackedField,
  value: string,
) {
  return currentOrigin(db, projectId, leadId, field, value) !== 'person';
}

/** A list replaces only list data: never a value research verified or a person typed. */
export function importMayReplace(
  db: DB,
  projectId: number,
  leadId: number,
  field: TrackedField,
  value: string,
) {
  const origin = currentOrigin(db, projectId, leadId, field, value);
  return origin === 'import' || origin === null;
}

/** A lead's recorded changes, newest first. */
export function leadFieldHistory(db: DB, projectId: number, leadId: number): FieldChange[] {
  return db
    .prepare(
      'SELECT id,field,previous_value,new_value,origin,evidence,source_url,changed_at,changed_by FROM lead_field_history WHERE project_id=? AND lead_id=? ORDER BY id DESC LIMIT 200',
    )
    .all(projectId, leadId) as FieldChange[];
}

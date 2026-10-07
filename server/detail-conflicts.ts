import type { Express } from 'express';
import { z } from 'zod';
import { audit, now, type DB } from './database';
import { HttpError, leadSchema, positiveId } from './validation';
import { recordFieldChanges, researchMayReplace } from './field-history';
import {
  conflictFields,
  type ConflictField,
  type DetailConflict,
  type Evidence,
  type Lead,
  type Project,
  type Qualification,
  type User,
} from '../shared/types';

type GetProject = (db: DB, id: number, user: User) => Project;

const fieldNames: Record<ConflictField, string> = {
  city: 'City',
  country: 'Country',
  industry: 'Industry',
  employee_count: 'Company size',
};
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Writes the website's value for one detail as a recorded edit: the column, its citation in
 * lead_research_citations (so the value stays traceable to the page and sentence), its
 * lead_field_history row with the value it replaced, and an audit line. The caller has checked
 * the value and moves the revision.
 */
function writeWebsiteValue(
  db: DB,
  options: {
    project: Project | { id: number };
    lead: Pick<Lead, 'id' | 'name'>;
    field: ConflictField;
    previous: string;
    value: string;
    quote: string;
    url: string;
    actor: string;
    action: string;
    how: string;
  },
) {
  const { project, lead, field, value } = options;
  // The column name comes from the closed list above, never from the request text itself.
  db.prepare('UPDATE leads SET ' + field + '=? WHERE id=? AND project_id=?').run(
    value,
    lead.id,
    project.id,
  );
  db.prepare(
    `INSERT INTO lead_research_citations
      (project_id,lead_id,field,value,evidence,source_url,created_at,created_by)
    VALUES (?,?,?,?,?,?,?,?)`,
  ).run(project.id, lead.id, field, value, options.quote, options.url, now(), options.actor);
  recordFieldChanges(db, {
    projectId: project.id,
    leadId: lead.id,
    before: { [field]: options.previous },
    after: { [field]: value },
    origin: 'research',
    actor: options.actor,
    evidence: options.quote,
    sourceUrl: options.url,
  });
  // These are company details, not personal data, so the values may sit in the audit log.
  audit(
    db,
    project.id,
    options.actor,
    options.action,
    lead.name +
      ': ' +
      fieldNames[field] +
      ' changed from "' +
      options.previous +
      '" to "' +
      value +
      '", as the company website states (' +
      options.url +
      ')' +
      options.how +
      '.',
  );
}

/** The website page a conflict's quote was checked against, if the run kept it. */
const sourcePage = (conflict: DetailConflict, evidence: Evidence[]) =>
  evidence.find((item) => item.kind === 'website' && conflict.source_ids.includes(item.id));

/**
 * Research wins over imported data. Called inside the transaction that saves a qualification
 * run, against the lead as freshly read there: every conflict the run kept (validateQualification
 * already checked that its quote is on the company's own page and contains the value) is written
 * as the lead's current value, unless a person typed the value it would replace. That one stays
 * a visible conflict for "Use website value", and so does any value that changed since the run
 * read the record, one the lead form would refuse, or one whose page is not in the evidence.
 *
 * The revision moves once for all of them. The run itself judged with the website's value in
 * front of it, so the caller saves it as current against the returned revision.
 */
export function applyFoundConflicts(
  db: DB,
  options: {
    project: Project | { id: number };
    lead: Lead;
    conflicts: DetailConflict[];
    evidence: Evidence[];
    actor: string;
  },
): { conflicts: DetailConflict[]; applied: ConflictField[]; revision: number } {
  const { project, lead } = options;
  const applied: ConflictField[] = [];
  const conflicts = options.conflicts.map((conflict) => {
    const current = String(lead[conflict.field] ?? '');
    if (!same(current, conflict.record_value)) return conflict;
    if (!researchMayReplace(db, project.id, lead.id, conflict.field, current)) return conflict;
    const parsed = leadSchema.shape[conflict.field].safeParse(conflict.found_value);
    if (!parsed.success || !parsed.data || same(parsed.data, current)) return conflict;
    const page = sourcePage(conflict, options.evidence);
    if (!page?.url) return conflict;
    writeWebsiteValue(db, {
      project,
      lead,
      field: conflict.field,
      previous: current,
      value: parsed.data,
      quote: conflict.quote,
      url: page.url,
      actor: options.actor,
      action: 'lead.research_applied',
      how: '; the imported value was replaced by the qualification',
    });
    applied.push(conflict.field);
    return { ...conflict, applied: true };
  });
  if (!applied.length) return { conflicts, applied, revision: lead.revision };
  db.prepare(
    'UPDATE leads SET revision=revision+1,reviewed=0,updated_at=? WHERE id=? AND project_id=?',
  ).run(now(), lead.id, project.id);
  return { conflicts, applied, revision: lead.revision + 1 };
}

/**
 * POST /api/projects/:projectId/leads/:leadId/conflicts/apply {run_id, field, revision}
 *
 * A conflict over a value a person typed is never applied on its own (applyFoundConflicts): this
 * route is the person's deliberate "Use website value", and it is an ordinary recorded edit.
 *
 * It applies only the lead's latest run, only over the revision the person was looking at and
 * only while the field still holds the value the run saw, so a value typed in the meantime is
 * never overwritten. The value passes the lead form's own validator, keeps its quote and page in
 * lead_research_citations like a researched value, and the revision moves and the review clears,
 * so the earlier qualification reads "Requalification needed" until it is run again.
 */
export function installDetailConflicts(app: Express, deps: { db: DB; getProject: GetProject }) {
  const { db } = deps;
  app.post('/api/projects/:projectId/leads/:leadId/conflicts/apply', (req, res) => {
    const project = deps.getProject(db, positiveId(req.params.projectId), req.user);
    const leadId = positiveId(req.params.leadId);
    const input = z
      .object({
        run_id: z.number().int().positive(),
        field: z.enum(conflictFields),
        revision: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    const applied = db.transaction(() => {
      const lead = db
        .prepare('SELECT * FROM leads WHERE id=? AND project_id=?')
        .get(leadId, project.id) as Lead | undefined;
      if (!lead) throw new HttpError(404, 'Lead not found in this project.');
      const run = db
        .prepare(
          'SELECT result_json,evidence_json FROM qualification_runs WHERE id=? AND lead_id=? AND project_id=?',
        )
        .get(input.run_id, lead.id, project.id) as
        { result_json: string; evidence_json: string } | undefined;
      if (!run) throw new HttpError(404, 'That analysis does not belong to this lead.');
      if (lead.latest_run_id !== input.run_id)
        throw new HttpError(
          409,
          'A newer analysis replaced this one. Refresh to see what it found.',
        );
      const conflict = ((JSON.parse(run.result_json) as Qualification).conflicts ?? []).find(
        (item) => item.field === input.field,
      );
      if (!conflict)
        throw new HttpError(404, 'This analysis reported no conflict for that detail.');
      if (lead.revision !== input.revision)
        throw new HttpError(409, 'This record changed in another session. Refresh before saving.');
      const current = String(lead[input.field] ?? '');
      if (!same(current, conflict.record_value))
        throw new HttpError(
          409,
          fieldNames[input.field] + ' was changed since the analysis, so it was left alone.',
        );
      // The same validator the edit form uses, so this never writes what a person could not type.
      const parsed = leadSchema.shape[input.field].safeParse(conflict.found_value);
      if (!parsed.success || !parsed.data)
        throw new HttpError(400, 'The lead form would not accept the website’s value.');
      const source = sourcePage(conflict, JSON.parse(run.evidence_json) as Evidence[]);
      if (!source?.url) throw new HttpError(409, 'The page this value came from is not on record.');
      writeWebsiteValue(db, {
        project,
        lead,
        field: input.field,
        previous: current,
        value: parsed.data,
        quote: conflict.quote,
        url: source.url,
        actor: req.user.name,
        action: 'lead.conflict_resolved',
        how: '',
      });
      db.prepare(
        'UPDATE leads SET revision=revision+1,reviewed=0,updated_at=? WHERE id=? AND project_id=?',
      ).run(now(), lead.id, project.id);
      return { field: input.field, value: parsed.data, revision: lead.revision + 1 };
    })();
    res.json(applied);
  });
}

import type { Express } from 'express';
import { z } from 'zod';
import { audit, now, type DB } from './database';
import { HttpError, leadSchema, positiveId } from './validation';
import {
  conflictFields,
  type ConflictField,
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

/**
 * POST /api/projects/:projectId/leads/:leadId/conflicts/apply {run_id, field, revision}
 *
 * A qualification can report that the company's own website states a detail differently from
 * the record (validateQualification in server/ai.ts keeps a conflict only with a quote that is
 * really on the cited page and contains the value). Nothing writes that value on its own: this
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
        throw new HttpError(409, 'A newer analysis replaced this one. Refresh to see what it found.');
      const conflict = ((JSON.parse(run.result_json) as Qualification).conflicts ?? []).find(
        (item) => item.field === input.field,
      );
      if (!conflict) throw new HttpError(404, 'This analysis reported no conflict for that detail.');
      if (lead.revision !== input.revision)
        throw new HttpError(409, 'This record changed in another session. Refresh before saving.');
      const current = String(lead[input.field] ?? '');
      if (current.trim().toLowerCase() !== conflict.record_value.trim().toLowerCase())
        throw new HttpError(
          409,
          fieldNames[input.field] + ' was changed since the analysis, so it was left alone.',
        );
      // The same validator the edit form uses, so this never writes what a person could not type.
      const parsed = leadSchema.shape[input.field].safeParse(conflict.found_value);
      if (!parsed.success || !parsed.data)
        throw new HttpError(400, 'The lead form would not accept the website’s value.');
      const source = (JSON.parse(run.evidence_json) as Evidence[]).find(
        (item) => item.kind === 'website' && conflict.source_ids.includes(item.id),
      );
      if (!source?.url) throw new HttpError(409, 'The page this value came from is not on record.');
      // The column name comes from the closed list above, never from the request text itself.
      db.prepare(
        'UPDATE leads SET ' +
          input.field +
          '=?,revision=revision+1,reviewed=0,updated_at=? WHERE id=? AND project_id=?',
      ).run(parsed.data, now(), lead.id, project.id);
      db.prepare(
        `INSERT INTO lead_research_citations
          (project_id,lead_id,field,value,evidence,source_url,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        project.id,
        lead.id,
        input.field,
        parsed.data,
        conflict.quote,
        source.url,
        now(),
        req.user.name,
      );
      // These are company details, not personal data, so the values may sit in the audit log.
      audit(
        db,
        project.id,
        req.user.name,
        'lead.conflict_resolved',
        lead.name +
          ': ' +
          fieldNames[input.field] +
          ' changed from "' +
          current +
          '" to "' +
          parsed.data +
          '", as the company website states (' +
          source.url +
          ').',
      );
      return { field: input.field, value: parsed.data, revision: lead.revision + 1 };
    })();
    res.json(applied);
  });
}

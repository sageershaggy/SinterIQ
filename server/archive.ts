import type { Express } from 'express';
import { z } from 'zod';
import { audit, now, type DB } from './database';
import { HttpError, positiveId, text } from './validation';
import type { Project, User } from '../shared/types';

/**
 * Archiving instead of deleting. A lead scoring below 50, or a company that has closed, is
 * set aside with the reason recorded: hidden from the default lists, never emailed, and
 * restorable. Deleting stays a separate, deliberate action.
 */
export const archiveReasons = {
  SCORE_BELOW_50: 'Score below 50',
  COMPANY_CLOSED: 'Company closed',
} as const;
const archiveSchema = z
  .object({
    reason: z.enum(['SCORE_BELOW_50', 'COMPANY_CLOSED', 'OTHER']),
    note: text(300).default(''),
  })
  .strict()
  .refine((input) => input.reason !== 'OTHER' || input.note.length >= 3, {
    message: 'Say why this lead is being archived.',
    path: ['note'],
  });
/** Leads a bulk "archive below 50" would move: scored on a real run, and not archived yet. */
const belowFifty = `project_id=? AND archived_at IS NULL AND latest_run_id IS NOT NULL
  AND score IS NOT NULL AND score<50`;

export function installArchive(
  app: Express,
  options: { db: DB; getProject: (db: DB, id: number, user: User) => Project },
) {
  const { db, getProject } = options;
  /** Stops anything still due to go out to archived leads. The history is kept. */
  const stopSequences = (projectId: number, leadIds: number[], reason: string) => {
    const stop = db.prepare(
      `UPDATE funnel_enrollments SET status='STOPPED',stop_cause='ARCHIVED',reason=?,updated_at=?
      WHERE project_id=? AND lead_id=? AND status IN ('QUEUED','BLOCKED')`,
    );
    for (const id of leadIds) stop.run('Lead archived: ' + reason + '.', now(), projectId, id);
  };
  app.post('/api/projects/:projectId/leads/:leadId/archive', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = archiveSchema.parse(req.body);
    const reason = input.reason === 'OTHER' ? input.note : archiveReasons[input.reason];
    const lead = db
      .prepare('SELECT id,name,archived_at FROM leads WHERE project_id=? AND id=?')
      .get(project.id, positiveId(req.params.leadId)) as
      { id: number; name: string; archived_at: string | null } | undefined;
    if (!lead) throw new HttpError(404, 'Lead not found in this project.');
    if (lead.archived_at) throw new HttpError(409, lead.name + ' is already archived.');
    if (
      db
        .prepare(
          "SELECT 1 FROM funnel_enrollments WHERE project_id=? AND lead_id=? AND status='SENDING'",
        )
        .get(project.id, lead.id)
    )
      throw new HttpError(409, 'A message is being sent to this lead. Try again in a minute.');
    db.transaction(() => {
      db.prepare(
        'UPDATE leads SET archived_at=?,archived_reason=?,archived_by=? WHERE project_id=? AND id=?',
      ).run(now(), reason, req.user.name, project.id, lead.id);
      stopSequences(project.id, [lead.id], reason);
      audit(db, project.id, req.user.name, 'lead.archived', lead.name + ' — ' + reason);
    })();
    res.json(
      db
        .prepare('SELECT id,archived_at,archived_reason,archived_by FROM leads WHERE id=?')
        .get(lead.id),
    );
  });
  app.post('/api/projects/:projectId/leads/:leadId/restore', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = db
      .prepare('SELECT id,name,archived_at FROM leads WHERE project_id=? AND id=?')
      .get(project.id, positiveId(req.params.leadId)) as
      { id: number; name: string; archived_at: string | null } | undefined;
    if (!lead) throw new HttpError(404, 'Lead not found in this project.');
    if (!lead.archived_at) throw new HttpError(409, lead.name + ' is not archived.');
    db.transaction(() => {
      db.prepare(
        "UPDATE leads SET archived_at=NULL,archived_reason='',archived_by='' WHERE project_id=? AND id=?",
      ).run(project.id, lead.id);
      audit(db, project.id, req.user.name, 'lead.restored', lead.name);
    })();
    res.json({ id: lead.id, archived_at: null, archived_reason: '', archived_by: '' });
  });
  /** The archived leads, newest first, so they can be found and restored. */
  app.get('/api/projects/:projectId/archive', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    res.json({
      leads: db
        .prepare(
          `SELECT id,name,score,archived_at,archived_reason,archived_by FROM leads
          WHERE project_id=? AND archived_at IS NOT NULL ORDER BY archived_at DESC,id DESC LIMIT 200`,
        )
        .all(project.id),
      total: (
        db
          .prepare('SELECT COUNT(*) n FROM leads WHERE project_id=? AND archived_at IS NOT NULL')
          .get(project.id) as { n: number }
      ).n,
    });
  });
  /** What "archive below 50" would do, shown before anyone confirms it. */
  app.get('/api/projects/:projectId/archive/below-50', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    res.json({
      count: (
        db.prepare('SELECT COUNT(*) n FROM leads WHERE ' + belowFifty).get(project.id) as {
          n: number;
        }
      ).n,
      leads: db
        .prepare(
          'SELECT id,name,score FROM leads WHERE ' + belowFifty + ' ORDER BY score,name LIMIT 50',
        )
        .all(project.id),
    });
  });
  /**
   * Archives every lead below 50 after a confirmation. The request repeats the count the person
   * saw, so a list that changed in between is refused instead of archiving more than they agreed to.
   */
  app.post('/api/projects/:projectId/archive/below-50', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = z
      .object({ confirm: z.literal(true), expected: z.number().int().min(1).max(100000) })
      .strict()
      .parse(req.body);
    const archived = db.transaction(() => {
      const ids = (
        db.prepare('SELECT id FROM leads WHERE ' + belowFifty).all(project.id) as Array<{
          id: number;
        }>
      ).map((row) => row.id);
      if (ids.length !== input.expected)
        throw new HttpError(409, 'The list changed since you reviewed it. Review it again.');
      const busy = db.prepare(
        "SELECT 1 FROM funnel_enrollments WHERE project_id=? AND lead_id=? AND status='SENDING'",
      );
      const archive = db.prepare(
        'UPDATE leads SET archived_at=?,archived_reason=?,archived_by=? WHERE project_id=? AND id=?',
      );
      const moved = ids.filter((id) => !busy.get(project.id, id));
      for (const id of moved)
        archive.run(now(), archiveReasons.SCORE_BELOW_50, req.user.name, project.id, id);
      stopSequences(project.id, moved, archiveReasons.SCORE_BELOW_50);
      audit(
        db,
        project.id,
        req.user.name,
        'leads.archived',
        moved.length + ' lead(s) scoring below 50 archived.',
      );
      return moved.length;
    })();
    res.json({ archived });
  });
}

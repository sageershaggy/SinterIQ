import type { Express } from 'express';
import { z } from 'zod';
import { audit, now, type DB } from './database';
import { HttpError, positiveId, requiredText } from './validation';
import {
  defaultPipelineStatus,
  pipelineStatusLabels,
  pipelineStatuses,
  type LeadComment,
  type LeadCrm,
  type PipelineChange,
  type PipelineStatus,
} from '../shared/crm';
import type { Project, User } from '../shared/types';

type GetProject = (db: DB, id: number, user: User) => Project;

/**
 * The current pipeline status of a lead aliased `l`, New when nobody has moved it. For the lead
 * list's "Lead status" filter: `WHERE ` + pipelineStatusSql + `=?` with a value from
 * shared/crm.ts pipelineStatuses.
 */
export const pipelineStatusSql =
  "COALESCE((SELECT s.to_status FROM lead_status_events s WHERE s.lead_id=l.id AND s.project_id=l.project_id ORDER BY s.id DESC LIMIT 1),'" +
  defaultPipelineStatus +
  "')";

/**
 * The CRM layer of one lead as the given viewer sees it. The lead detail spreads this in, so the
 * status control, the comments and the lead's activity all read the same rows.
 */
export function leadCrm(db: DB, projectId: number, leadId: number, viewer: User): LeadCrm {
  const changes = db
    .prepare(
      'SELECT id,from_status,to_status,created_by,created_at FROM lead_status_events WHERE project_id=? AND lead_id=? ORDER BY id DESC LIMIT 100',
    )
    .all(projectId, leadId) as PipelineChange[];
  const comments = (
    db
      .prepare(
        'SELECT id,lead_id,author_id,author,body,created_at,updated_at FROM lead_comments WHERE project_id=? AND lead_id=? ORDER BY id DESC LIMIT 200',
      )
      .all(projectId, leadId) as Array<
      Omit<LeadComment, 'can_edit' | 'can_delete'> & { author_id: number }
    >
  ).map(({ author_id, ...comment }) => ({
    ...comment,
    can_edit: author_id === viewer.id,
    can_delete: author_id === viewer.id || viewer.role === 'admin',
  }));
  return {
    pipeline_status: currentStatus(db, projectId, leadId),
    pipeline_changes: changes,
    comments,
  };
}

function currentStatus(db: DB, projectId: number, leadId: number): PipelineStatus {
  const row = db
    .prepare(
      'SELECT to_status FROM lead_status_events WHERE project_id=? AND lead_id=? ORDER BY id DESC LIMIT 1',
    )
    .get(projectId, leadId) as { to_status: PipelineStatus } | undefined;
  return row?.to_status ?? defaultPipelineStatus;
}

const statusSchema = z
  .object({
    status: z.enum(pipelineStatuses),
    /** The status the person was looking at, so two people cannot silently overwrite each other. */
    from: z.enum(pipelineStatuses),
  })
  .strict();
const commentSchema = z.object({ body: requiredText(4000) }).strict();

/**
 * Manual lead status and comments. Both are bookkeeping by people: neither route reads or
 * writes the leads row, so the qualification, fit score, decision, review and revision stay
 * exactly as they were. Project membership is checked on every route (404 otherwise), and a
 * lead or comment is only ever found through its project.
 */
export function installCrm(app: Express, db: DB, getProject: GetProject) {
  function scope(projectId: unknown, leadId: unknown, user: User) {
    const project = getProject(db, positiveId(projectId), user);
    const lead = db
      .prepare('SELECT id,name FROM leads WHERE id=? AND project_id=?')
      .get(positiveId(leadId), project.id) as { id: number; name: string } | undefined;
    if (!lead) throw new HttpError(404, 'Lead not found in this project.');
    return { project, lead };
  }
  function comment(projectId: number, leadId: number, id: unknown) {
    const row = db
      .prepare(
        'SELECT id,author_id,author FROM lead_comments WHERE id=? AND project_id=? AND lead_id=?',
      )
      .get(positiveId(id), projectId, leadId) as
      { id: number; author_id: number; author: string } | undefined;
    if (!row) throw new HttpError(404, 'Comment not found.');
    return row;
  }
  app.get('/api/projects/:projectId/leads/:leadId/crm', (req, res) => {
    const { project, lead } = scope(req.params.projectId, req.params.leadId, req.user);
    res.json(leadCrm(db, project.id, lead.id, req.user));
  });
  app.put('/api/projects/:projectId/leads/:leadId/pipeline-status', (req, res) => {
    const { project, lead } = scope(req.params.projectId, req.params.leadId, req.user);
    const input = statusSchema.parse(req.body);
    db.transaction(() => {
      const current = currentStatus(db, project.id, lead.id);
      if (current !== input.from)
        throw new HttpError(
          409,
          'Someone else changed this status to ' +
            pipelineStatusLabels[current] +
            '. Refresh before changing it.',
        );
      if (current === input.status)
        throw new HttpError(400, 'The lead is already ' + pipelineStatusLabels[current] + '.');
      db.prepare(
        'INSERT INTO lead_status_events (project_id,lead_id,from_status,to_status,created_by_id,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(project.id, lead.id, current, input.status, req.user.id, req.user.name, now());
      audit(
        db,
        project.id,
        req.user.name,
        'lead.status_changed',
        lead.name +
          ': ' +
          pipelineStatusLabels[current] +
          ' → ' +
          pipelineStatusLabels[input.status],
      );
    })();
    res.json(leadCrm(db, project.id, lead.id, req.user));
  });
  app.post('/api/projects/:projectId/leads/:leadId/comments', (req, res) => {
    const { project, lead } = scope(req.params.projectId, req.params.leadId, req.user);
    const input = commentSchema.parse(req.body);
    db.prepare(
      'INSERT INTO lead_comments (project_id,lead_id,author_id,author,body,created_at) VALUES (?,?,?,?,?,?)',
    ).run(project.id, lead.id, req.user.id, req.user.name, input.body, now());
    // The comment itself stays out of the audit log: deleting a comment must really remove it.
    audit(db, project.id, req.user.name, 'lead.comment_added', lead.name);
    res.status(201).json(leadCrm(db, project.id, lead.id, req.user));
  });
  app.put('/api/projects/:projectId/leads/:leadId/comments/:commentId', (req, res) => {
    const { project, lead } = scope(req.params.projectId, req.params.leadId, req.user);
    const found = comment(project.id, lead.id, req.params.commentId);
    // Nobody edits another person's words, administrators included; they may only remove them.
    if (found.author_id !== req.user.id)
      throw new HttpError(403, 'Only the author can edit a comment.');
    const input = commentSchema.parse(req.body);
    db.prepare('UPDATE lead_comments SET body=?,updated_at=? WHERE id=? AND project_id=?').run(
      input.body,
      now(),
      found.id,
      project.id,
    );
    audit(db, project.id, req.user.name, 'lead.comment_edited', lead.name);
    res.json(leadCrm(db, project.id, lead.id, req.user));
  });
  app.delete('/api/projects/:projectId/leads/:leadId/comments/:commentId', (req, res) => {
    const { project, lead } = scope(req.params.projectId, req.params.leadId, req.user);
    const found = comment(project.id, lead.id, req.params.commentId);
    const own = found.author_id === req.user.id;
    if (!own && req.user.role !== 'admin')
      throw new HttpError(403, 'Only the author or an administrator can delete a comment.');
    db.prepare('DELETE FROM lead_comments WHERE id=? AND project_id=?').run(found.id, project.id);
    audit(
      db,
      project.id,
      req.user.name,
      'lead.comment_deleted',
      lead.name + (own ? '' : ' (a comment by ' + found.author + ')'),
    );
    res.json(leadCrm(db, project.id, lead.id, req.user));
  });
}

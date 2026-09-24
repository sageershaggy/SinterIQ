import type { Express } from 'express';
import { z } from 'zod';
import { audit, now, type DB } from './database';
import { notifyLead } from './workspace';
import { HttpError, calendarDay, positiveId, text } from './validation';
import {
  callOutcomeLabels,
  callOutcomes,
  callStage,
  datedCallOutcomes,
  nextCallAction,
  type CallQueue,
  type CallQueueRow,
} from '../shared/calls';
import type { CallOutcome, Project, User } from '../shared/types';

type GetProject = (db: DB, id: number, user: User) => Project;

/**
 * The newest call entry of a lead aliased `l`, for joins and filters. The lead list's "Call
 * status" filter can use it: `LEFT JOIN call_logs c ON c.id=` + latestCallSql, then c.outcome
 * against shared/calls.ts (followUpCallOutcomes, callStage).
 */
export const latestCallSql =
  '(SELECT MAX(x.id) FROM call_logs x WHERE x.lead_id=l.id AND x.project_id=l.project_id)';

/**
 * The one place a call is written. Append-only, and deliberately blind to the qualification:
 * it never reads or writes status, score, confidence, the decision, the review or the lead
 * revision, so logging a call cannot make a result stale or change what it says.
 */
export function recordCall(
  db: DB,
  project: Project,
  lead: { id: number; name: string },
  input: { outcome: CallOutcome; notes: string; next_action_at: string | null },
  actor: string,
) {
  if (input.next_action_at && !datedCallOutcomes.includes(input.outcome))
    throw new HttpError(400, 'Only a call back or a follow-up carries a next-action date.');
  const id = db.transaction(() => {
    const inserted = Number(
      db
        .prepare(
          'INSERT INTO call_logs (project_id,lead_id,outcome,notes,next_action_at,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(project.id, lead.id, input.outcome, input.notes, input.next_action_at, actor, now())
        .lastInsertRowid,
    );
    db.prepare('UPDATE leads SET updated_at=? WHERE id=? AND project_id=?').run(
      now(),
      lead.id,
      project.id,
    );
    audit(
      db,
      project.id,
      actor,
      'lead.call_logged',
      lead.name +
        ': ' +
        callOutcomeLabels[input.outcome] +
        (input.next_action_at ? ' (next action ' + input.next_action_at + ')' : ''),
    );
    return inserted;
  })();
  notifyLead(db, project.id, lead.id, 'call', 'Call recorded for ' + lead.name);
  return id;
}

const queueColumns = `l.id lead_id,l.name,l.contact_name,l.contact_role,l.contact_phone,l.contact_email,
  l.city,l.country,l.assigned_to,a.name assigned_to_name,l.assigned_at,
  c.outcome call_status,c.created_at last_call_at,c.created_by last_call_by,
  COALESCE(c.notes,'') last_call_notes,c.next_action_at,
  (SELECT COUNT(*) FROM call_logs n WHERE n.lead_id=l.id AND n.project_id=l.project_id) call_count
  FROM leads l LEFT JOIN accounts a ON a.id=l.assigned_to
  LEFT JOIN call_logs c ON c.id=${latestCallSql}`;

function toRow(row: Omit<CallQueueRow, 'call_stage' | 'next_action'>): CallQueueRow {
  return {
    ...row,
    call_stage: callStage(row.call_status),
    next_action: nextCallAction(row.call_status),
  };
}

/** A manual status from the Calls page. Notes are optional here: the status is the record. */
const statusSchema = z
  .object({
    outcome: z.enum(callOutcomes),
    notes: text(4000).default(''),
    next_action_at: calendarDay.nullable().default(null),
  })
  .strict();

const queueQuery = z.object({
  assignee: z.union([z.enum(['me', 'all']), z.coerce.number().int().positive()]).optional(),
});

/**
 * The Calls page. Every lead with a calling assignment in the project, with where its calling
 * stands. Reaching it needs project access like every project route (404 otherwise); it lists
 * only leads of that project, so it shows a member nothing the lead list does not already.
 */
export function installCalls(app: Express, db: DB, getProject: GetProject) {
  function queueRow(projectId: number, leadId: number) {
    const row = db
      .prepare('SELECT ' + queueColumns + ' WHERE l.project_id=? AND l.id=?')
      .get(projectId, leadId) as Omit<CallQueueRow, 'call_stage' | 'next_action'> | undefined;
    if (!row) throw new HttpError(404, 'Lead not found in this project.');
    return toRow(row);
  }
  app.get('/api/projects/:projectId/calls', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const query = queueQuery.parse(req.query);
    // Researchers start from their own calls; administrators from the whole team.
    const assignee = query.assignee ?? (req.user.role === 'admin' ? 'all' : 'me');
    const params: number[] = [project.id];
    let where = 'l.project_id=? AND l.assigned_to IS NOT NULL';
    if (assignee !== 'all') {
      where += ' AND l.assigned_to=?';
      params.push(assignee === 'me' ? req.user.id : assignee);
    }
    // Dated next actions first (soonest first), then leads nobody has called, then the rest by
    // how long ago they were last called; a lead that said no goes to the bottom.
    const rows = db
      .prepare(
        'SELECT ' +
          queueColumns +
          ' WHERE ' +
          where +
          ` ORDER BY (c.next_action_at IS NULL), c.next_action_at,
          (c.outcome IS 'NOT_INTERESTED'), (c.id IS NOT NULL), c.created_at,
          l.name COLLATE NOCASE LIMIT 501`,
      )
      .all(...params) as Array<Omit<CallQueueRow, 'call_stage' | 'next_action'>>;
    const people = db
      .prepare(
        `SELECT DISTINCT a.id,a.name FROM accounts a
        LEFT JOIN project_members m ON m.account_id=a.id AND m.project_id=?
        WHERE a.active=1 AND (a.role='admin' OR m.project_id IS NOT NULL) ORDER BY a.name`,
      )
      .all(project.id) as CallQueue['people'];
    const body: CallQueue = {
      rows: rows.slice(0, 500).map(toRow),
      people,
      assignee,
      truncated: rows.length > 500,
    };
    res.json(body);
  });
  /** A manual call status. Saved as an ordinary call-log entry, so it is in the lead's history. */
  app.post('/api/projects/:projectId/leads/:leadId/call-status', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = db
      .prepare('SELECT id,name FROM leads WHERE id=? AND project_id=?')
      .get(positiveId(req.params.leadId), project.id) as { id: number; name: string } | undefined;
    if (!lead) throw new HttpError(404, 'Lead not found in this project.');
    const input = statusSchema.parse(req.body);
    recordCall(db, project, lead, input, req.user.name);
    res.status(201).json(queueRow(project.id, lead.id));
  });
}

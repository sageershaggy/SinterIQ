import type { Express } from 'express';
import { now, type DB } from './database';
import { HttpError, positiveId } from './validation';
import type { Project, Qualification, TrainingSnapshot, User } from '../shared/types';
import type { SourceUpload, TrainingGraph } from '../shared/research';

/**
 * The training library's record of what happened to each uploaded document, and the graph of
 * how a published version's rules played out across the leads qualified against it.
 */
export function createTrainingLibrary(deps: {
  db: DB;
  getProject: (db: DB, id: number, user?: User) => Project;
}) {
  const { db } = deps;

  /**
   * An upload attempt, kept whether it was read or refused. Someone who uploaded a file needs to
   * be able to come back and see that it worked, or why it did not; a toast that vanished is
   * not an answer. The reason is the application's own message, never a raw parser error.
   */
  function recordUpload(entry: {
    projectId: number;
    filename: string;
    size: number;
    actor: string;
    sourceId?: number;
    content?: string;
    error?: unknown;
  }) {
    const read = entry.sourceId !== undefined && entry.content !== undefined;
    const reason = read
      ? ''
      : entry.error instanceof HttpError
        ? entry.error.message
        : 'The document could not be read.';
    db.prepare(
      `INSERT INTO source_uploads
        (project_id,source_id,filename,size,status,characters,words,reason,created_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      entry.projectId,
      read ? entry.sourceId : null,
      entry.filename.slice(0, 180),
      entry.size,
      read ? 'READ' : 'FAILED',
      read ? entry.content!.length : 0,
      read ? entry.content!.split(/\s+/).filter(Boolean).length : 0,
      reason.slice(0, 500),
      now(),
      entry.actor,
    );
  }

  function graph(project: Project): TrainingGraph {
    const empty: TrainingGraph = {
      version: project.active_version,
      leads_evaluated: 0,
      decisions: { QUALIFIED: 0, NEEDS_REVIEW: 0, NOT_A_TARGET: 0 },
      rules: [],
    };
    if (!project.active_version) return empty;
    const row = db
      .prepare('SELECT snapshot_json FROM training_versions WHERE project_id=? AND version=?')
      .get(project.id, project.active_version) as { snapshot_json: string } | undefined;
    if (!row) return empty;
    const rubric = (JSON.parse(row.snapshot_json) as TrainingSnapshot).rubric;
    const rules: TrainingGraph['rules'] = [
      ...rubric.criteria.map((text) => ({ kind: 'criterion' as const, text })),
      ...rubric.exclusions.map((text) => ({ kind: 'exclusion' as const, text })),
    ].map((rule) => ({ ...rule, meets: 0, does_not_meet: 0, unable: 0 }));
    // Each lead's latest analysis on this version, and the lead's current decision, which
    // includes any human review of that analysis.
    const runs = db
      .prepare(
        `SELECT q.result_json,l.status FROM leads l
        JOIN qualification_runs q ON q.id=l.latest_run_id AND q.project_id=l.project_id
        WHERE l.project_id=? AND q.training_version=?`,
      )
      .all(project.id, project.active_version) as Array<{ result_json: string; status: string }>;
    const decisions = { ...empty.decisions };
    for (const run of runs) {
      const result = JSON.parse(run.result_json) as Qualification;
      if (run.status in decisions) decisions[run.status as keyof typeof decisions]++;
      for (const [kind, items] of [
        ['criterion', result.criteria],
        ['exclusion', result.exclusions],
      ] as const)
        for (const item of items || []) {
          const rule = rules.find((entry) => entry.kind === kind && entry.text === item.criterion);
          if (!rule) continue;
          if (item.outcome === 'MATCH') rule.meets++;
          else if (item.outcome === 'NO_MATCH') rule.does_not_meet++;
          else rule.unable++;
        }
    }
    return { ...empty, leads_evaluated: runs.length, decisions, rules };
  }

  function install(app: Express) {
    const projectOf = (req: { params: Record<string, string>; user: User }) =>
      deps.getProject(db, positiveId(req.params.projectId), req.user);
    app.get('/api/projects/:projectId/training/uploads', (req, res) => {
      const project = projectOf(req);
      res.json(
        db
          .prepare('SELECT * FROM source_uploads WHERE project_id=? ORDER BY id DESC LIMIT 50')
          .all(project.id) as SourceUpload[],
      );
    });
    app.get('/api/projects/:projectId/training/graph', (req, res) => {
      res.json(graph(projectOf(req)));
    });
  }

  return { install, recordUpload, graph };
}

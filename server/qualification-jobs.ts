import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { audit, now, type DB } from './database';
import { HttpError, positiveId } from './validation';
import { notifyProject } from './notifications';
import { leadSummary, qualificationStateSql } from './lead-filters';
import {
  maxJobLeadIds,
  projectWideScopes,
  qualificationJobScopes,
  recentAnalysisMinutes,
  type QualificationJob,
  type RunningAnalyses,
  type RunningAnalysisJob,
  type QualificationJobScope,
  type QualificationJobState,
  type QualificationJobStatus,
} from '../shared/qualification-jobs';
import type { Decision, Project, User } from '../shared/types';

/**
 * Project qualification jobs: "requalify these leads on the current training", run on the server
 * one lead at a time, through exactly the function the single-lead endpoint uses (qualifyLead in
 * server/app.ts). A job never judges differently from a person pressing the button; it only saves
 * them pressing it four hundred times, and keeps going when they close the tab.
 *
 * - One running job per project (a partial unique index), so two people cannot spend the budget
 *   twice, and one lead at a time per project, so a job never crowds out a person's own analyses.
 * - The leads are fixed when the job starts. A lead whose turn comes when it is already current on
 *   the job's training is skipped: someone qualified it meanwhile, or (for 'all') this job did.
 * - Stop takes effect once the lead in progress is finished; nothing half-saved is left behind.
 * - A changed training stops the job: everything after the change would be judged on rules that
 *   are no longer the published ones, and qualifyLead would refuse it anyway.
 * - A failure is recorded against its lead and the job moves on. Three failures in a row that
 *   point at the provider (no key, refused key, no credits, rate limit) stop it, because every
 *   lead after them would fail the same way.
 * - State lives in the database, so a restart picks a running job up where it was.
 */

type QualifyLead = (
  project: Project,
  leadId: number,
  actor: string,
) => Promise<{ result: { decision: Decision } }>;
/** What one runner step did. 'wait' means an analysis slot was busy; try again shortly. */
export type JobStep = 'idle' | 'next' | 'wait' | 'finished';

interface JobRow {
  id: number;
  project_id: number;
  status: QualificationJobStatus;
  scope: QualificationJobScope;
  training_version: number;
  training_revision: number;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  failure_streak: number;
  current_lead_id: number | null;
  stop_requested_by: string | null;
  last_error: string;
  created_by_id: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
interface LeadState {
  id: number;
  name: string;
  archived_at: string | null;
  latest_run_id: number | null;
  training_version: number | null;
  qualified_revision: number | null;
  revision: number;
}

/** A busy analysis slot clears in seconds; an unexpected runner error is given longer. */
const RETRY_MS = 5_000;
const ERROR_RETRY_MS = 60_000;
/** Consecutive provider-shaped failures that stop a job. */
const SYSTEMIC_LIMIT = 3;
const decisions: Decision[] = ['QUALIFIED', 'NOT_A_TARGET', 'NEEDS_REVIEW'];
const scopeLabels: Record<QualificationJobScope, string> = {
  stale: 'leads needing requalification',
  raw: 'leads never analysed',
  stale_and_raw: 'leads needing requalification and leads never analysed',
  all: 'every lead in the project',
  ids: 'selected leads',
};

const startSchema = z
  .object({
    scope: z.enum(qualificationJobScopes),
    lead_ids: z.array(z.number().int().positive()).min(1).max(maxJobLeadIds).optional(),
    /**
     * 'all' only: also redo leads already Qualified on the current training. Off by default —
     * their research and verdict are current, and redoing them spends credits for nothing.
     */
    include_qualified: z.boolean().default(false),
  })
  .strict()
  .refine((input) => (input.scope === 'ids') === Boolean(input.lead_ids), {
    message: 'List the leads to qualify with the "ids" scope, and only with it.',
    path: ['lead_ids'],
  });

/** single() in server/app.ts refuses a second analysis of one lead, or a fourth at once. */
function isBusy(error: unknown) {
  return (
    error instanceof HttpError &&
    (error.status === 409 || error.status === 429) &&
    /already running/i.test(error.message)
  );
}
/** Failures every following lead would hit too: the provider, its key or its budget. */
function isSystemic(error: unknown) {
  return (
    error instanceof HttpError &&
    /configure an ai provider|authentication failed|api key|permission denied|credits|quota|rate limit|HTTP 40[123]|HTTP 429|model .*not found/i.test(
      error.message,
    )
  );
}
/**
 * What the progress panel says about a failed lead. Provider messages can quote the provider's
 * own error text, so they are reduced to what happened; our own refusals are already plain.
 */
function shortReason(error: unknown) {
  const message = error instanceof HttpError ? error.message : '';
  if (/configure an ai provider/i.test(message)) return 'No AI provider is configured.';
  if (/authentication failed|api key|permission denied/i.test(message))
    return 'The AI provider refused the API key.';
  if (/HTTP 402|insufficient credits/i.test(message))
    return 'The AI provider account is out of credits.';
  if (/rate limit|quota|HTTP 429/i.test(message))
    return 'The AI provider rate limit or quota was reached.';
  if (/model .*not found/i.test(message)) return 'The AI model in Settings was not found.';
  if (/timed out/i.test(message)) return 'The AI provider took too long to answer.';
  if (/could not connect/i.test(message)) return 'The AI provider could not be reached.';
  if (/incomplete/i.test(message))
    return 'The AI returned an incomplete answer; nothing was saved.';
  if (error instanceof HttpError && error.status < 500) return message.slice(0, 200);
  return 'The analysis could not be completed; nothing was saved for this lead.';
}
const plural = (n: number, one: string, many = one + 's') => n + ' ' + (n === 1 ? one : many);

export function createQualificationJobs(deps: {
  db: DB;
  getProject: (db: DB, id: number, user?: User) => Project;
  qualifyLead: QualifyLead;
  /** Whether an AI provider is configured: the same test the qualify endpoint makes. */
  aiReady: () => boolean;
  /** Rate limit for starting a job, shared with the other AI actions. */
  limit?: RequestHandler;
  /** False leaves the runner to the caller (tests step it with runNext and drain). */
  autoRun?: boolean;
}) {
  const { db } = deps;
  const autoRun = deps.autoRun !== false;
  /** The step in progress per project: at most one lead is ever being qualified per project. */
  const inFlight = new Map<number, Promise<JobStep>>();
  /** Background loops per project, while autoRun is on. */
  const loops = new Map<number, Promise<void>>();

  const jobById = (id: number) =>
    db.prepare('SELECT * FROM qualification_jobs WHERE id=?').get(id) as JobRow | undefined;
  const runningJob = (projectId: number) =>
    db
      .prepare("SELECT * FROM qualification_jobs WHERE project_id=? AND status='RUNNING'")
      .get(projectId) as JobRow | undefined;
  const nextItem = (jobId: number) =>
    db
      .prepare(
        "SELECT id,lead_id FROM qualification_job_items WHERE job_id=? AND status='PENDING' ORDER BY id LIMIT 1",
      )
      .get(jobId) as { id: number; lead_id: number } | undefined;
  const count = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  /** Decisions reached by this job's own runs. */
  function outcomes(jobId: number) {
    const rows = db
      .prepare(
        "SELECT decision,COUNT(*) n FROM qualification_job_items WHERE job_id=? AND status='DONE' GROUP BY decision",
      )
      .all(jobId) as Array<{ decision: Decision; n: number }>;
    return Object.fromEntries(
      decisions.map((decision) => [
        decision,
        rows.find((row) => row.decision === decision)?.n ?? 0,
      ]),
    ) as Record<Decision, number>;
  }

  /** The non-archived leads a scope covers, most promising first so they are current soonest. */
  function scopeLeads(
    project: Project,
    scope: QualificationJobScope,
    ids: number[],
    includeQualified = false,
  ) {
    const where = ['l.project_id=?', 'l.archived_at IS NULL'];
    const params: number[] = [project.id];
    const state = qualificationStateSql(project);
    if (scope === 'stale') where.push(state + "='REQUALIFY'");
    else if (scope === 'raw') where.push(state + "='RAW'");
    else if (scope === 'stale_and_raw') where.push(state + " IN ('REQUALIFY','RAW')");
    // A lead already Qualified on this training keeps its result unless asked for explicitly.
    else if (scope === 'all' && !includeQualified) where.push(state + "<>'QUALIFIED'");
    else if (scope === 'ids') {
      where.push('l.id IN (' + ids.map(() => '?').join(',') + ')');
      params.push(...ids);
    }
    return (
      db
        .prepare(
          'SELECT l.id FROM leads l WHERE ' +
            where.join(' AND ') +
            ' ORDER BY l.score IS NULL,l.score DESC,l.id',
        )
        .all(...params) as Array<{ id: number }>
    ).map((row) => row.id);
  }

  function start(project: Project, user: User, input: z.infer<typeof startSchema>) {
    if (projectWideScopes.includes(input.scope) && user.role !== 'admin')
      throw new HttpError(
        403,
        'Only an administrator can requalify leads across the project, because it spends AI credits on every one of them.',
      );
    if (!project.active_version || project.revision !== project.trained_revision)
      throw new HttpError(409, 'Publish the current project training before qualifying leads.');
    if (!deps.aiReady()) throw new HttpError(409, 'Configure an AI provider in Settings first.');
    const id = db.transaction(() => {
      if (runningJob(project.id))
        throw new HttpError(
          409,
          'A qualification job is already running in this project. Stop it or wait for it to finish.',
        );
      const leads = scopeLeads(
        project,
        input.scope,
        [...new Set(input.lead_ids || [])],
        input.include_qualified,
      );
      if (!leads.length)
        throw input.scope === 'ids'
          ? new HttpError(404, 'No matching leads in this project.')
          : input.scope === 'all'
            ? new HttpError(
                409,
                'Every lead is already Qualified on this training. Include the qualified leads to redo them anyway.',
              )
            : new HttpError(409, 'There are no ' + scopeLabels[input.scope] + ' to qualify.');
      const at = now();
      const jobId = Number(
        db
          .prepare(
            `INSERT INTO qualification_jobs (project_id,status,scope,training_version,training_revision,total,created_by_id,created_by,created_at,updated_at)
            VALUES (?,'RUNNING',?,?,?,?,?,?,?,?)`,
          )
          .run(
            project.id,
            input.scope,
            project.active_version,
            project.trained_revision,
            leads.length,
            user.id,
            user.name,
            at,
            at,
          ).lastInsertRowid,
      );
      const insert = db.prepare(
        "INSERT INTO qualification_job_items (job_id,project_id,lead_id,status) VALUES (?,?,?,'PENDING')",
      );
      for (const leadId of leads) insert.run(jobId, project.id, leadId);
      audit(
        db,
        project.id,
        user.name,
        'qualification_job.started',
        'Qualifying ' +
          plural(leads.length, 'lead') +
          ' (' +
          scopeLabels[input.scope] +
          ') on training v' +
          project.active_version +
          ', one at a time.',
      );
      return jobId;
    })();
    kick(project.id);
    return id;
  }

  /** The one-line account used for the audit trail and the project update. */
  function summary(job: JobRow, status: 'DONE' | 'STOPPED', reason: string) {
    const counts = outcomes(job.id);
    const processed = job.done + job.failed + job.skipped;
    const pending = count(
      "SELECT COUNT(*) n FROM qualification_job_items WHERE job_id=? AND status='PENDING'",
      job.id,
    );
    const results =
      counts.QUALIFIED +
      ' qualified, ' +
      counts.NOT_A_TARGET +
      ' not a target, ' +
      counts.NEEDS_REVIEW +
      ' need review';
    const extra = [
      job.failed ? job.failed + ' failed' : '',
      job.skipped ? job.skipped + ' skipped' : '',
    ].filter(Boolean);
    return status === 'DONE'
      ? 'Qualification finished on training v' +
          job.training_version +
          ': ' +
          results +
          ' (' +
          [plural(processed, 'lead'), ...extra].join(', ') +
          ')'
      : 'Qualification stopped on training v' +
          job.training_version +
          ' after ' +
          processed +
          ' of ' +
          (processed + pending) +
          ' leads: ' +
          results +
          (extra.length ? ', ' + extra.join(', ') : '') +
          '. ' +
          reason;
  }

  /**
   * Ends a running job, once. The job row disappears with its project, so a job whose project was
   * deleted under it simply ends here without writing anything.
   */
  function finish(jobId: number, status: 'DONE' | 'STOPPED', reason: string) {
    db.transaction(() => {
      const job = jobById(jobId);
      if (!job || job.status !== 'RUNNING') return;
      const at = now();
      db.prepare(
        'UPDATE qualification_jobs SET status=?,last_error=?,current_lead_id=NULL,finished_at=?,updated_at=? WHERE id=?',
      ).run(status, reason, at, at, job.id);
      const line = summary(job, status, reason);
      audit(
        db,
        job.project_id,
        job.stop_requested_by || job.created_by,
        status === 'DONE' ? 'qualification_job.finished' : 'qualification_job.stopped',
        line,
      );
      notifyProject(db, job.project_id, 'qualification_job', line);
    })();
  }

  /** Why a running job must not take its next lead, or '' when it may. */
  function haltReason(job: JobRow) {
    if (job.stop_requested_by) return 'Stopped by ' + job.stop_requested_by + '.';
    if (job.failure_streak >= SYSTEMIC_LIMIT) {
      const last = db
        .prepare(
          "SELECT error FROM qualification_job_items WHERE job_id=? AND status='FAILED' ORDER BY updated_at DESC,id DESC LIMIT 1",
        )
        .get(job.id) as { error: string } | undefined;
      return (
        'Stopped after ' +
        SYSTEMIC_LIMIT +
        ' failures in a row: ' +
        (last?.error || 'the AI provider is not answering.') +
        ' Fix it in Settings, then start again.'
      );
    }
    const project = db
      .prepare('SELECT active_version,revision,trained_revision FROM projects WHERE id=?')
      .get(job.project_id) as
      | { active_version: number | null; revision: number; trained_revision: number | null }
      | undefined;
    if (
      !project ||
      project.active_version !== job.training_version ||
      project.trained_revision !== job.training_revision ||
      project.revision !== project.trained_revision
    )
      return 'Training changed — start again on the new version.';
    // The job spends on its starter's behalf, so it ends with their access.
    const starter = db
      .prepare('SELECT id,username,name,role,active FROM accounts WHERE id=?')
      .get(job.created_by_id) as (User & { active: number }) | undefined;
    if (!starter?.active) return job.created_by + ' can no longer sign in.';
    try {
      deps.getProject(db, job.project_id, starter);
    } catch {
      return job.created_by + ' no longer has access to this project.';
    }
    return '';
  }

  /** Records one lead's outcome; nothing happens if the item went with a deleted lead. */
  function settle(
    job: JobRow,
    itemId: number,
    status: 'DONE' | 'FAILED' | 'SKIPPED',
    detail: { decision?: Decision; error?: string; systemic?: boolean } = {},
  ) {
    db.transaction(() => {
      const changed = db
        .prepare(
          "UPDATE qualification_job_items SET status=?,decision=?,error=?,updated_at=? WHERE id=? AND job_id=? AND status='PENDING'",
        )
        .run(status, detail.decision ?? null, detail.error ?? '', now(), itemId, job.id);
      if (!changed.changes) return;
      const counter = status === 'DONE' ? 'done' : status === 'FAILED' ? 'failed' : 'skipped';
      // A success or an ordinary failure breaks a run of provider failures; a skip says nothing.
      const streak =
        status === 'SKIPPED' ? 'failure_streak' : detail.systemic ? 'failure_streak+1' : '0';
      db.prepare(
        `UPDATE qualification_jobs SET ${counter}=${counter}+1,failure_streak=${streak},current_lead_id=NULL,updated_at=? WHERE id=?`,
      ).run(now(), job.id);
    })();
  }

  /** Current on this job's training, and (for 'all') qualified since the job started. */
  function alreadyCurrent(job: JobRow, lead: LeadState) {
    if (
      lead.latest_run_id === null ||
      lead.training_version !== job.training_version ||
      lead.qualified_revision !== lead.revision
    )
      return false;
    if (job.scope !== 'all') return true;
    const run = db
      .prepare('SELECT created_at FROM qualification_runs WHERE id=? AND project_id=?')
      .get(lead.latest_run_id, job.project_id) as { created_at: string } | undefined;
    return Boolean(run && run.created_at >= job.created_at);
  }

  async function processItem(job: JobRow, item: { id: number; lead_id: number }) {
    const lead = db
      .prepare(
        'SELECT id,name,archived_at,latest_run_id,training_version,qualified_revision,revision FROM leads WHERE id=? AND project_id=?',
      )
      .get(item.lead_id, job.project_id) as LeadState | undefined;
    if (!lead) return settle(job, item.id, 'SKIPPED', { error: 'The lead was removed.' });
    if (lead.archived_at)
      return settle(job, item.id, 'SKIPPED', { error: 'Archived after the job started.' });
    if (alreadyCurrent(job, lead))
      return settle(job, item.id, 'SKIPPED', {
        error: 'Already qualified on training v' + job.training_version + '.',
      });
    db.prepare('UPDATE qualification_jobs SET current_lead_id=?,updated_at=? WHERE id=?').run(
      lead.id,
      now(),
      job.id,
    );
    try {
      // Read again for every lead: the project row carries the revision qualifyLead checks.
      const project = deps.getProject(db, job.project_id);
      const { result } = await deps.qualifyLead(project, lead.id, job.created_by);
      settle(job, item.id, 'DONE', { decision: result.decision });
    } catch (error) {
      const current = jobById(job.id);
      // Deleted with its project while this lead was being qualified: nothing left to record.
      if (!current) return;
      if (isBusy(error) || haltReason(current).startsWith('Training changed')) {
        // Not this lead's failure. It stays queued; a busy slot is retried and a changed
        // training stops the job at the next check.
        db.prepare('UPDATE qualification_jobs SET current_lead_id=NULL WHERE id=?').run(job.id);
        return isBusy(error) ? ('wait' as const) : undefined;
      }
      if (!(error instanceof HttpError))
        console.error(
          '[qualification] Lead failed in a job:',
          (error as { code?: string; name?: string })?.code ||
            (error as { name?: string })?.name ||
            'UnknownError',
        );
      settle(job, item.id, 'FAILED', { error: shortReason(error), systemic: isSystemic(error) });
    }
  }

  /** One step: check the job may continue, then qualify (or skip) its next lead. */
  async function advance(projectId: number): Promise<JobStep> {
    const job = runningJob(projectId);
    if (!job) return 'idle';
    const halt = haltReason(job);
    if (halt) {
      finish(job.id, 'STOPPED', halt);
      return 'finished';
    }
    const item = nextItem(job.id);
    if (!item) {
      finish(job.id, 'DONE', '');
      return 'finished';
    }
    if ((await processItem(job, item)) === 'wait') return 'wait';
    // Stop, a training change or a run of provider failures takes effect right after this lead.
    const after = jobById(job.id);
    if (!after || after.status !== 'RUNNING') return 'finished';
    const reason = haltReason(after);
    if (reason) {
      finish(after.id, 'STOPPED', reason);
      return 'finished';
    }
    if (!nextItem(after.id)) {
      finish(after.id, 'DONE', '');
      return 'finished';
    }
    return 'next';
  }

  /** Runs one step for a project, or joins the one already running there. */
  function runNext(projectId: number): Promise<JobStep> {
    const running = inFlight.get(projectId);
    if (running) return running;
    const step = advance(projectId).finally(() => inFlight.delete(projectId));
    inFlight.set(projectId, step);
    return step;
  }
  /** Steps until the project's job is finished or has to wait (tests drive the runner this way). */
  async function drain(projectId: number) {
    for (;;) {
      const step = await runNext(projectId);
      if (step !== 'next') return step;
    }
  }

  /**
   * The background loop for one project. Timers are unref'd, so a waiting job never holds the
   * process open, and a restart resumes from the database instead.
   */
  function kick(projectId: number) {
    if (!autoRun || loops.has(projectId)) return;
    const retry = (delay: number) => void setTimeout(() => kick(projectId), delay).unref();
    const loop = (async () => {
      try {
        for (;;) {
          const step = await runNext(projectId);
          if (step === 'wait') return retry(RETRY_MS);
          if (step !== 'next') return;
        }
      } catch (error) {
        if (!db.open) return;
        console.error(
          '[qualification] Job paused:',
          (error as { code?: string })?.code || (error as Error)?.name || 'UnknownError',
        );
        retry(ERROR_RETRY_MS);
      }
    })().finally(() => loops.delete(projectId));
    loops.set(projectId, loop);
  }
  /** Picks up every job that was running when the server last stopped. */
  function resume() {
    for (const { project_id } of db
      .prepare("SELECT project_id FROM qualification_jobs WHERE status='RUNNING'")
      .all() as Array<{ project_id: number }>)
      kick(project_id);
  }
  /** Resolves once no background loop is running (tests use it with autoRun on). */
  async function idle() {
    while (loops.size) await Promise.all([...loops.values()]);
  }

  function view(job: JobRow, viewer: User): QualificationJob {
    const pending = count(
      "SELECT COUNT(*) n FROM qualification_job_items WHERE job_id=? AND status='PENDING'",
      job.id,
    );
    const current = job.current_lead_id
      ? (db
          .prepare('SELECT id,name FROM leads WHERE id=? AND project_id=?')
          .get(job.current_lead_id, job.project_id) as { id: number; name: string } | undefined)
      : undefined;
    const failures = db
      .prepare(
        `SELECT i.lead_id,l.name lead_name,i.error FROM qualification_job_items i
        JOIN leads l ON l.id=i.lead_id AND l.project_id=i.project_id
        WHERE i.job_id=? AND i.status='FAILED' ORDER BY i.updated_at,i.id LIMIT 5`,
      )
      .all(job.id) as QualificationJob['failures'];
    return {
      id: job.id,
      project_id: job.project_id,
      status: job.status,
      scope: job.scope,
      training_version: job.training_version,
      total: job.done + job.failed + job.skipped + pending,
      done: job.done,
      failed: job.failed,
      skipped: job.skipped,
      current_lead: current ?? null,
      created_by: job.created_by,
      created_at: job.created_at,
      updated_at: job.updated_at,
      finished_at: job.finished_at,
      stopping: job.status === 'RUNNING' && Boolean(job.stop_requested_by),
      stop_reason: job.last_error,
      outcomes: outcomes(job.id),
      failures,
      can_stop:
        job.status === 'RUNNING' && (viewer.role === 'admin' || viewer.id === job.created_by_id),
    };
  }
  function state(project: Project, viewer: User): QualificationJobState {
    const job =
      runningJob(project.id) ||
      (db
        .prepare('SELECT * FROM qualification_jobs WHERE project_id=? ORDER BY id DESC LIMIT 1')
        .get(project.id) as JobRow | undefined);
    // The same partition as the lead list's count tiles, over the leads a job can include.
    const counts = leadSummary(db, project, {
      where: 'l.project_id=? AND l.archived_at IS NULL',
      params: [project.id],
    });
    const ready = Boolean(project.active_version && project.revision === project.trained_revision);
    return {
      job: job ? view(job, viewer) : null,
      counts: {
        requalify: counts.requalify,
        raw: counts.raw,
        total: counts.total,
        qualified: counts.qualified,
      },
      ready,
      training_version: project.active_version,
      can_start_project_wide: viewer.role === 'admin',
    };
  }

  /**
   * Every job running in a project the viewer can reach, and those that ended a short while ago,
   * for the header indicator on every page. Membership is the same test getProject makes: a
   * researcher's unassigned projects contribute nothing, so they cannot be probed this way.
   */
  function running(viewer: User): RunningAnalyses {
    const since = new Date(Date.now() - recentAnalysisMinutes * 60_000).toISOString();
    const rows = db
      .prepare(
        `SELECT j.*,p.name project_name FROM qualification_jobs j JOIN projects p ON p.id=j.project_id
        WHERE (j.status='RUNNING' OR j.finished_at>=?)
          AND (?=1 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=j.project_id AND m.account_id=?))
        ORDER BY j.id DESC LIMIT 50`,
      )
      .all(since, viewer.role === 'admin' ? 1 : 0, viewer.id) as Array<
      JobRow & { project_name: string }
    >;
    const jobs: RunningAnalysisJob[] = rows.map((row) => ({
      ...view(row, viewer),
      project_name: row.project_name,
      mine: row.created_by_id === viewer.id,
    }));
    return {
      running: jobs.filter((job) => job.status === 'RUNNING'),
      recent: jobs.filter((job) => job.status !== 'RUNNING'),
    };
  }

  function install(app: Express) {
    /** The header's "Analysis running" indicator polls this on every page. */
    app.get('/api/analysis/running', (req, res) => {
      res.json(running(req.user));
    });
    const base = '/api/projects/:projectId/qualification-jobs';
    /** The running job (or the last one) and the counts the start dialog offers. */
    app.get(base + '/current', (req, res) => {
      const project = deps.getProject(db, positiveId(req.params.projectId), req.user);
      res.json(state(project, req.user));
    });
    const limit: RequestHandler = deps.limit || ((_req, _res, next) => next());
    app.post(base, limit, (req, res) => {
      const project = deps.getProject(db, positiveId(req.params.projectId), req.user);
      start(project, req.user, startSchema.parse(req.body));
      res.status(201).json(state(project, req.user));
    });
    /** The starter or an administrator; the lead in progress is finished first. */
    app.post(base + '/:jobId/stop', (req, res) => {
      const project = deps.getProject(db, positiveId(req.params.projectId), req.user);
      const job = db
        .prepare('SELECT * FROM qualification_jobs WHERE id=? AND project_id=?')
        .get(positiveId(req.params.jobId), project.id) as JobRow | undefined;
      if (!job) throw new HttpError(404, 'Qualification job not found in this project.');
      if (job.status !== 'RUNNING')
        throw new HttpError(409, 'This qualification job has already ended.');
      if (req.user.role !== 'admin' && req.user.id !== job.created_by_id)
        throw new HttpError(
          403,
          'Only ' + job.created_by + ' or an administrator can stop this qualification job.',
        );
      db.prepare(
        'UPDATE qualification_jobs SET stop_requested_by=COALESCE(stop_requested_by,?),updated_at=? WHERE id=?',
      ).run(req.user.name, now(), job.id);
      // Nothing in progress: stop now rather than when the runner next looks.
      if (!inFlight.has(project.id))
        finish(job.id, 'STOPPED', 'Stopped by ' + (job.stop_requested_by || req.user.name) + '.');
      res.json(state(project, req.user));
    });
  }

  return { install, start, runNext, drain, resume, idle };
}

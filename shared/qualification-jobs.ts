import type { Decision } from './types';

/**
 * A project's qualification job (server/qualification-jobs.ts): one server-side pass that runs
 * the ordinary single-lead qualification over a set of leads, one lead at a time, on the training
 * version that was live when it started.
 *
 * - stale: leads whose result is from older training or an older version of the record
 *   ("Requalification needed").
 * - raw: leads never analysed.
 * - stale_and_raw: both.
 * - all: every lead, for when the rules themselves changed and every verdict should be redone.
 * - ids: an explicit list, e.g. the leads an import has just added.
 *
 * Archived leads are never included. Every scope but 'ids' spends AI credits across the whole
 * project, so only an administrator can start one.
 */
export const qualificationJobScopes = ['stale', 'raw', 'stale_and_raw', 'all', 'ids'] as const;
export type QualificationJobScope = (typeof qualificationJobScopes)[number];
export const projectWideScopes: readonly QualificationJobScope[] = [
  'stale',
  'raw',
  'stale_and_raw',
  'all',
];
/** The most leads one 'ids' job takes, the same cap as the other bulk lead actions. */
export const maxJobLeadIds = 500;

export type QualificationJobStatus = 'RUNNING' | 'STOPPED' | 'DONE';

export interface QualificationJob {
  id: number;
  project_id: number;
  status: QualificationJobStatus;
  scope: QualificationJobScope;
  /** The training version every lead in this job is qualified against. */
  training_version: number;
  /** Leads still in the job: processed plus those waiting. */
  total: number;
  done: number;
  failed: number;
  /** Already current when their turn came, archived meanwhile, or otherwise not run. */
  skipped: number;
  /** The lead being qualified right now, if any. */
  current_lead: { id: number; name: string } | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  /** Someone asked it to stop; it does once the lead in progress is finished. */
  stopping: boolean;
  /** Why it stopped (who stopped it, a training change, repeated provider failures). */
  stop_reason: string;
  /** Decisions reached by this job's own runs. */
  outcomes: Record<Decision, number>;
  /** The first few leads that failed, with a short reason (never a raw provider error). */
  failures: Array<{ lead_id: number; lead_name: string; error: string }>;
  /** The viewer started it or is an administrator. */
  can_stop: boolean;
}

/** GET /api/projects/:projectId/qualification-jobs/current */
export interface QualificationJobState {
  /** The running job, or else the most recent finished one; null before the first. */
  job: QualificationJob | null;
  /** Non-archived leads in each state, as the start dialog offers them. */
  counts: { requalify: number; raw: number; total: number };
  /** The published training is current, so a job could start now. */
  ready: boolean;
  training_version: number | null;
  /** The viewer is an administrator, who alone may start a project-wide job. */
  can_start_project_wide: boolean;
}

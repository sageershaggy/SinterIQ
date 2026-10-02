import type { DB } from './database';

/**
 * Additive tables for project qualification jobs (server/qualification-jobs.ts). Nothing here
 * rewrites an existing table.
 *
 * qualification_jobs: one row per job. The partial unique index is what makes "one running job per
 * project" hold even if two starts race. training_version and training_revision pin the training
 * the job was started on, so the runner can tell when it changed underneath. stop_requested_by is
 * set by Stop and honoured once the lead in progress is finished; last_error says why a job ended
 * early. The counters are kept with each item so the progress read is one row.
 *
 * qualification_job_items: the leads the job will qualify, fixed when it starts, each with its own
 * outcome. An item goes with its lead when the lead is deleted, and both tables carry project_id,
 * so deleting a project (server/project-delete.ts) finds and removes them from the schema itself.
 */
export function installQualificationJobSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qualification_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      status TEXT NOT NULL CHECK(status IN ('RUNNING','STOPPED','DONE')),
      scope TEXT NOT NULL CHECK(scope IN ('stale','raw','stale_and_raw','all','ids')),
      training_version INTEGER NOT NULL, training_revision INTEGER NOT NULL,
      total INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
      failure_streak INTEGER NOT NULL DEFAULT 0, current_lead_id INTEGER,
      stop_requested_by TEXT, last_error TEXT NOT NULL DEFAULT '',
      created_by_id INTEGER NOT NULL REFERENCES accounts(id), created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS qualification_jobs_running
      ON qualification_jobs(project_id) WHERE status='RUNNING';
    CREATE INDEX IF NOT EXISTS qualification_jobs_project ON qualification_jobs(project_id, id DESC);
    CREATE TABLE IF NOT EXISTS qualification_job_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES qualification_jobs(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('PENDING','DONE','FAILED','SKIPPED')),
      decision TEXT, error TEXT NOT NULL DEFAULT '', updated_at TEXT,
      UNIQUE(job_id, lead_id)
    );
    CREATE INDEX IF NOT EXISTS qualification_job_items_next
      ON qualification_job_items(job_id, status, id);
    CREATE INDEX IF NOT EXISTS qualification_job_items_lead ON qualification_job_items(lead_id);
  `);
}

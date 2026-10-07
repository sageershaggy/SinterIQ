import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, CircleStop, History, LoaderCircle, RotateCw, X } from 'lucide-react';
import type { Project } from '../shared/types';
import type {
  QualificationJob as Job,
  QualificationJobScope,
  QualificationJobState,
} from '../shared/qualification-jobs';
import { api, json } from './api';
import { analysisChanged, analysisChangedEvent } from './analysisActivity';
import { Alert, Modal, Spinner } from './ui';
import './QualificationJob.css';

/** How often a running job is read, and the most often the page around it is asked to refresh. */
const POLL_MS = 3000;
const REFRESH_MS = 5000;
const leads = (n: number) => n + (n === 1 ? ' lead' : ' leads');
const processed = (job: Job) => job.done + job.failed + job.skipped;
/** The decisions a job reached, in the words the lead list uses. */
const outcomeLine = (job: Job) =>
  [
    job.outcomes.QUALIFIED + ' qualified',
    job.outcomes.NOT_A_TARGET + ' not a target',
    job.outcomes.NEEDS_REVIEW + ' need review',
    ...(job.failed ? [job.failed + ' failed'] : []),
    ...(job.skipped ? [job.skipped + ' skipped'] : []),
  ].join(' · ');

/** A finished job's summary stays until this browser dismisses it. */
const seenKey = (projectId: number) => 'innovista:qualification-job-seen:' + projectId;
function seenJob(projectId: number) {
  try {
    return Number(localStorage.getItem(seenKey(projectId))) || 0;
  } catch {
    return 0;
  }
}

/**
 * The project's qualification job (server/qualification-jobs.ts): its progress while it runs,
 * for everyone on the project, with Stop for whoever started it and administrators; its outcome
 * once it ends; and, while results are mixed across training versions, the way to start one.
 * The lead list shows it above the table; the Training page beside the live version.
 */
export function QualificationJob({
  project,
  refresh = 0,
  notify,
  onProgress,
  variant = 'list',
}: {
  project: Project;
  /** Changes when the page around it reloaded its leads, so the counts follow. */
  refresh?: number;
  notify: (text: string) => void;
  /** Leads changed: called as the job makes progress (at most every 5 s) and when it ends. */
  onProgress?: () => void;
  variant?: 'list' | 'training';
}) {
  const base = '/projects/' + project.id + '/qualification-jobs';
  const [state, setState] = useState<QualificationJobState | null>(null),
    [starting, setStarting] = useState<QualificationJobScope | null>(null),
    [stopping, setStopping] = useState(false),
    [error, setError] = useState(''),
    [seen, setSeen] = useState(() => seenJob(project.id));
  const job = state?.job || null;
  const running = job?.status === 'RUNNING';
  // Started or stopped elsewhere (the header's indicator): read it again at once.
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    const bump = () => setChanged((n) => n + 1);
    window.addEventListener(analysisChangedEvent, bump);
    return () => window.removeEventListener(analysisChangedEvent, bump);
  }, []);
  useEffect(() => {
    let cancelled = false;
    api<QualificationJobState>(base + '/current')
      .then((data) => !cancelled && setState(data))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [base, refresh, changed, project.active_version, project.revision]);
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api<QualificationJobState>(base + '/current')
        .then((data) => !cancelled && setState(data))
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [base, running]);
  // The page's own lists follow the job: when its done count moves (not more than every few
  // seconds, so a fast job does not reload the table on every lead) and when it ends.
  const reported = useRef<{ id: number; done: number; running: boolean; at: number } | null>(null);
  useEffect(() => {
    if (!job) return;
    const last = reported.current;
    const now = { id: job.id, done: job.done, running, at: Date.now() };
    if (!last || last.id !== job.id) {
      reported.current = now;
      return;
    }
    const ended = last.running && !running;
    if (ended || (job.done !== last.done && now.at - last.at >= REFRESH_MS)) {
      reported.current = now;
      onProgress?.();
      if (ended)
        notify(
          (job.status === 'DONE' ? 'Qualification finished: ' : 'Qualification stopped: ') +
            outcomeLine(job) +
            '.',
        );
    }
  }, [state]);

  async function stop() {
    if (!job) return;
    setStopping(true);
    setError('');
    try {
      const next = await api<QualificationJobState>(base + '/' + job.id + '/stop', {
        method: 'POST',
        body: json({}),
      });
      setState(next);
      analysisChanged();
      notify(
        next.job?.status === 'RUNNING'
          ? 'Stopping after the lead in progress.'
          : 'Qualification stopped.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  }
  function dismiss(id: number) {
    try {
      localStorage.setItem(seenKey(project.id), String(id));
    } catch {
      // A browser that keeps nothing simply shows the summary again next time.
    }
    setSeen(id);
  }

  if (!state) return null;
  const { counts } = state;
  const requalify = !running && state.ready && counts.requalify > 0;
  const startButton = (scope: QualificationJobScope, text: string) => (
    <button
      type="button"
      className="button secondary"
      onClick={() => {
        setError('');
        setStarting(scope);
      }}
    >
      <RotateCw size={15} />
      {text}
    </button>
  );
  return (
    <>
      {error && <Alert>{error}</Alert>}
      {job && running && (
        <section className="job-panel is-running" aria-label="Qualification in progress">
          <div className="job-panel-head">
            <LoaderCircle size={19} className="spin" aria-hidden="true" />
            <div>
              <strong>
                Qualifying {Math.min(processed(job) + 1, job.total)} of {job.total} on training v
                {job.training_version}
              </strong>
              <small>
                Started by {job.created_by}. It runs on the server one lead at a time, so this page
                can be closed.
                {variant === 'training' && ' Saving a rule change stops it.'}
              </small>
            </div>
            {job.can_stop && (
              <button
                type="button"
                className="button danger"
                disabled={stopping || job.stopping}
                onClick={() => void stop()}
              >
                <CircleStop size={15} />
                {job.stopping ? 'Stopping…' : 'Stop analysis'}
              </button>
            )}
          </div>
          <div
            className="job-progress"
            role="progressbar"
            aria-label="Leads processed"
            aria-valuemin={0}
            aria-valuemax={job.total}
            aria-valuenow={processed(job)}
          >
            <i style={{ width: (job.total ? (processed(job) / job.total) * 100 : 0) + '%' }} />
          </div>
          <small className="job-panel-detail">
            {[
              job.current_lead ? 'Now: ' + job.current_lead.name : '',
              job.done + ' done',
              job.failed ? job.failed + ' failed' : '',
              job.skipped ? job.skipped + ' already current' : '',
              job.stopping ? 'stopping after the lead in progress' : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </section>
      )}
      {job && !running && job.id !== seen && (
        <section
          className={'job-panel ' + (job.status === 'DONE' ? 'is-done' : 'is-stopped')}
          role="status"
        >
          <div className="job-panel-head">
            {job.status === 'DONE' ? (
              <CheckCircle2 size={19} aria-hidden="true" />
            ) : (
              <CircleStop size={19} aria-hidden="true" />
            )}
            <div>
              <strong>
                {job.status === 'DONE'
                  ? 'Qualification finished on training v' + job.training_version
                  : 'Qualification stopped after ' +
                    processed(job) +
                    ' of ' +
                    leads(job.total) +
                    ' on training v' +
                    job.training_version}
              </strong>
              <small>
                {outcomeLine(job)}
                {job.status === 'STOPPED' && job.stop_reason ? '. ' + job.stop_reason : ''}
              </small>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss this summary"
              title="Dismiss"
              onClick={() => dismiss(job.id)}
            >
              <X size={17} />
            </button>
          </div>
          {job.failures.length > 0 && (
            <ul className="job-failures">
              {job.failures.map((failure) => (
                <li key={failure.lead_id}>
                  <strong>{failure.lead_name}</strong> — {failure.error}
                </li>
              ))}
              {job.failed > job.failures.length && (
                <li>…and {job.failed - job.failures.length} more.</li>
              )}
            </ul>
          )}
        </section>
      )}
      {requalify && variant === 'list' && (
        <div className="inline-notice job-banner">
          <History size={20} />
          <span>
            <strong>
              {leads(counts.requalify)} {counts.requalify === 1 ? 'was' : 'were'} qualified on
              earlier training or changed since.
            </strong>{' '}
            Results stay mixed until {counts.requalify === 1 ? 'it is' : 'they are'} requalified on
            training v{state.training_version}.
          </span>
          {state.can_start_project_wide ? (
            startButton('stale', 'Requalify ' + leads(counts.requalify))
          ) : (
            <small>Ask an administrator to requalify them.</small>
          )}
        </div>
      )}
      {variant === 'training' && !running && state.ready && counts.total > 0 && (
        <div className="job-training-line">
          {requalify ? (
            <span>
              {leads(counts.requalify)} {counts.requalify === 1 ? 'was' : 'were'} qualified on an
              earlier version.
            </span>
          ) : (
            <span>Every analysed lead is on this version.</span>
          )}
          {!state.can_start_project_wide ? (
            requalify && <small>Ask an administrator to requalify them.</small>
          ) : requalify ? (
            startButton('stale', 'Requalify ' + leads(counts.requalify))
          ) : (
            // Rules can change outside a new version (a release changes how they are applied),
            // so an administrator can still redo every lead once.
            <button type="button" className="text-button" onClick={() => setStarting('all')}>
              Requalify every lead…
            </button>
          )}
        </div>
      )}
      {starting && (
        <StartJob
          base={base}
          state={state}
          initial={starting}
          onClose={() => setStarting(null)}
          onStarted={(next) => {
            setStarting(null);
            setState(next);
            analysisChanged();
            if (next.job) {
              reported.current = { id: next.job.id, done: 0, running: true, at: Date.now() };
              notify(
                'Qualifying ' +
                  leads(next.job.total) +
                  ' on the server, one at a time. You can leave this page.',
              );
            }
          }}
        />
      )}
    </>
  );
}

/**
 * Which leads to requalify, with live counts. It says plainly what the job costs and that it can
 * be stopped, because it spends an AI analysis on every lead it covers.
 */
function StartJob({
  base,
  state,
  initial,
  onClose,
  onStarted,
}: {
  base: string;
  state: QualificationJobState;
  initial: QualificationJobScope;
  onClose: () => void;
  onStarted: (state: QualificationJobState) => void;
}) {
  const { requalify, raw, total } = state.counts;
  const options: Array<{
    scope: QualificationJobScope;
    label: string;
    hint: string;
    count: number;
  }> = [
    {
      scope: 'stale',
      label: 'Leads needing requalification (' + requalify + ')',
      hint: 'Qualified on earlier training, or edited since their last analysis.',
      count: requalify,
    },
    {
      scope: 'stale_and_raw',
      label: 'Also leads never analysed (+' + raw + ')',
      hint: leads(requalify + raw) + ' in all.',
      count: raw ? requalify + raw : 0,
    },
    {
      scope: 'all',
      label: 'Every lead in the project (' + total + ') — after changing the rules',
      hint: 'Current results are redone too, so every lead is judged by the same rules.',
      count: total,
    },
  ];
  const [scope, setScope] = useState<QualificationJobScope>(
    options.find((option) => option.scope === initial && option.count)?.scope ||
      options.find((option) => option.count)?.scope ||
      'all',
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const count = options.find((option) => option.scope === scope)?.count || 0;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onStarted(await api<QualificationJobState>(base, { method: 'POST', body: json({ scope }) }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Requalify leads" onClose={() => !busy && onClose()}>
      <form className="form-stack" onSubmit={submit}>
        <p className="muted">
          The leads you choose are analysed against training v{state.training_version} on the
          server, one lead at a time, so you can leave this page. Each lead is a full AI analysis
          and uses AI credits. It can be stopped at any time; leads already done keep their new
          result. Archived leads are left out.
        </p>
        <div className="job-scopes" role="radiogroup" aria-label="Which leads">
          {options.map((option) => (
            <label key={option.scope} className={'job-scope' + (option.count ? '' : ' is-empty')}>
              <input
                type="radio"
                name="job-scope"
                checked={scope === option.scope}
                disabled={!option.count || busy}
                onChange={() => setScope(option.scope)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </span>
            </label>
          ))}
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="form-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !count}>
            {busy ? (
              <Spinner text="Starting…" />
            ) : (
              <>
                <RotateCw size={15} />
                Requalify {leads(count)}
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

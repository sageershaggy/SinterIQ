import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, CheckCircle2, CircleStop, LoaderCircle, X } from 'lucide-react';
import type { RunningAnalyses, RunningAnalysisJob } from '../shared/qualification-jobs';
import { api, json } from './api';
import {
  analysisChanged,
  analysisChangedEvent,
  dismissBrowserAnalysis,
  stopAllBrowserAnalyses,
  stopBrowserAnalysis,
  useBrowserAnalyses,
  type BrowserAnalysis,
} from './analysisActivity';
import { Alert } from './ui';
import './AnalysisIndicator.css';

/** How often the server's jobs are read: often while one runs, rarely otherwise. */
const RUNNING_POLL_MS = 4000;
const IDLE_POLL_MS = 60_000;
const leads = (n: number) => n + (n === 1 ? ' lead' : ' leads');

/** One line of the panel, whether the analysis runs on the server or in this tab. */
interface Row {
  key: string;
  projectId: number;
  projectName: string;
  status: 'RUNNING' | 'DONE' | 'STOPPED';
  total: number;
  /** Leads finished, for the progress bar. */
  processed: number;
  /** "Qualifying N of M" while it runs; the summary once it ended. */
  heading: string;
  /** The same, shortened for the header button. */
  short: string;
  detail: string;
  origin: string;
  stopping: boolean;
  canStop: boolean;
  stop: () => void;
  dismiss: () => void;
}

function jobRow(
  job: RunningAnalysisJob,
  stop: (job: RunningAnalysisJob) => void,
  dismiss: (id: number) => void,
  stopping: boolean,
): Row {
  const processed = job.done + job.failed + job.skipped;
  const running = job.status === 'RUNNING';
  const outcomes = [
    job.outcomes.QUALIFIED + ' qualified',
    job.outcomes.NOT_A_TARGET + ' not a target',
    job.outcomes.NEEDS_REVIEW + ' need review',
    ...(job.failed ? [job.failed + ' failed'] : []),
    ...(job.skipped ? [job.skipped + ' already current'] : []),
  ].join(' · ');
  return {
    key: 'job:' + job.id,
    projectId: job.project_id,
    projectName: job.project_name,
    status: job.status,
    total: job.total,
    processed,
    heading: running
      ? 'Qualifying ' + Math.min(processed + 1, job.total) + ' of ' + job.total
      : job.status === 'DONE'
        ? 'Analysis finished: ' + leads(processed)
        : 'Analysis stopped after ' + processed + ' of ' + job.total,
    short: running
      ? Math.min(processed + 1, job.total) + ' of ' + job.total
      : job.status === 'DONE'
        ? leads(processed)
        : 'after ' + processed + ' of ' + job.total,
    detail: running
      ? [
          job.current_lead ? 'Now: ' + job.current_lead.name : '',
          job.done + ' done',
          job.failed ? job.failed + ' failed' : '',
          job.skipped ? job.skipped + ' already current' : '',
          job.stopping ? 'stopping after the lead in progress' : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : outcomes + (job.status === 'STOPPED' && job.stop_reason ? '. ' + job.stop_reason : ''),
    origin:
      'Started by ' +
      (job.mine ? 'you' : job.created_by) +
      ' on training v' +
      job.training_version +
      '. It runs on the server, so closing this page does not stop it.',
    stopping: stopping || job.stopping,
    canStop: job.can_stop,
    stop: () => stop(job),
    dismiss: () => dismiss(job.id),
  };
}
function batchRow(batch: BrowserAnalysis): Row {
  const running = batch.status === 'RUNNING';
  const failed = batch.started - batch.completed - (running ? 1 : 0);
  return {
    key: 'batch:' + batch.id,
    projectId: batch.project_id,
    projectName: batch.project_name,
    status: batch.status,
    total: batch.total,
    processed: running ? Math.max(0, batch.started - 1) : batch.started,
    heading: running
      ? 'Qualifying ' + Math.max(1, batch.started) + ' of ' + batch.total
      : batch.status === 'DONE'
        ? 'Analysis finished: ' + leads(batch.started)
        : 'Analysis stopped after ' + batch.started + ' of ' + batch.total,
    short: running
      ? Math.max(1, batch.started) + ' of ' + batch.total
      : batch.status === 'DONE'
        ? leads(batch.started)
        : 'after ' + batch.started + ' of ' + batch.total,
    detail: running
      ? [
          'Selected leads',
          batch.completed + ' done',
          failed > 0 ? failed + ' failed' : '',
          batch.stopping ? 'stopping after the lead in progress' : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : [batch.completed + ' analysed', failed > 0 ? failed + ' failed' : '', batch.reason]
          .filter(Boolean)
          .join(' · '),
    origin: 'Started by you from the lead list. It runs in this browser tab: closing it ends it.',
    stopping: batch.stopping,
    canStop: running,
    stop: () => stopBrowserAnalysis(batch.id),
    dismiss: () => dismissBrowserAnalysis(batch.id),
  };
}
const statusIcon = (status: Row['status'], size: number): ReactNode =>
  status === 'RUNNING' ? (
    <LoaderCircle size={size} className="spin" aria-hidden="true" />
  ) : status === 'DONE' ? (
    <CheckCircle2 size={size} aria-hidden="true" />
  ) : (
    <CircleStop size={size} aria-hidden="true" />
  );

/**
 * "Analysis running", in the header of every page: each qualification job running in a project
 * the viewer can reach (server/qualification-jobs.ts, GET /api/analysis/running) and the lead
 * list's browser-side batch, with its progress, who started it, Stop analysis for whoever may stop
 * it, and a link to the lead list where it runs. Once one ends, a short summary stays until it is
 * dismissed. On a phone it is an icon with a count.
 */
export function AnalysisIndicator() {
  const [server, setServer] = useState<RunningAnalyses>({ running: [], recent: [] }),
    [dismissed, setDismissed] = useState<number[]>([]),
    [stopping, setStopping] = useState<number[]>([]),
    [open, setOpen] = useState(false),
    [top, setTop] = useState(64),
    [error, setError] = useState('');
  const batches = useBrowserAnalyses();
  const root = useRef<HTMLDivElement>(null);
  /** Jobs this tab saw running: their ending is news here, someone else's old job is not. */
  const seen = useRef(new Set<number>());
  const openedAt = useRef(new Date().toISOString());
  const sequence = useRef(0);
  async function load() {
    const request = ++sequence.current;
    try {
      const data = await api<RunningAnalyses>('/analysis/running');
      if (request !== sequence.current) return;
      for (const job of data.running) seen.current.add(job.id);
      setServer(data);
    } catch {
      // A server without the feed, or a moment offline: show nothing rather than an error on
      // every page. The panels on the lead list and Training still show their own job.
    }
  }
  const active = server.running.length > 0;
  useEffect(() => {
    let timer: number | undefined;
    const arm = () => {
      window.clearInterval(timer);
      timer = undefined;
      // A hidden tab asks nothing; it catches up as soon as it is shown again.
      if (!document.hidden)
        timer = window.setInterval(() => void load(), active ? RUNNING_POLL_MS : IDLE_POLL_MS);
    };
    const visibility = () => {
      if (!document.hidden) void load();
      arm();
    };
    const changed = () => void load();
    arm();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener(analysisChangedEvent, changed);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener(analysisChangedEvent, changed);
    };
  }, [active]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
      stopAllBrowserAnalyses();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    void load();
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        root.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  async function stopJob(job: RunningAnalysisJob) {
    setStopping((ids) => [...ids, job.id]);
    setError('');
    try {
      await api('/projects/' + job.project_id + '/qualification-jobs/' + job.id + '/stop', {
        method: 'POST',
        body: json({}),
      });
      analysisChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping((ids) => ids.filter((id) => id !== job.id));
    }
  }
  const dismissJob = (id: number) => setDismissed((ids) => [...ids, id]);
  const rows: Row[] = [
    ...batches.filter((batch) => batch.status === 'RUNNING').map(batchRow),
    ...server.running.map((job) => jobRow(job, stopJob, dismissJob, stopping.includes(job.id))),
    ...batches.filter((batch) => batch.status !== 'RUNNING').map(batchRow),
    ...server.recent
      .filter(
        (job) =>
          !dismissed.includes(job.id) &&
          (seen.current.has(job.id) || (job.mine && (job.finished_at || '') >= openedAt.current)),
      )
      .map((job) => jobRow(job, stopJob, dismissJob, false)),
  ];
  const running = rows.filter((row) => row.status === 'RUNNING');
  const ended = rows.filter((row) => row.status !== 'RUNNING');
  // Close an empty panel rather than leave a frame with nothing in it.
  useEffect(() => {
    if (!rows.length) setOpen(false);
  }, [rows.length]);
  const latest = ended[0];
  // Read out when an analysis ends, not at every lead it finishes.
  const live = (
    <span className="analysis-announce" aria-live="polite">
      {latest ? latest.heading + ' in ' + latest.projectName + '.' : ''}
    </span>
  );
  // The same element either way, so the live region survives the last summary's dismissal.
  if (!rows.length)
    return (
      <div className="analysis-indicator is-empty" ref={root}>
        {live}
      </div>
    );

  const lead = running[0] || latest;
  const projects = [...new Set((running.length ? running : ended).map((row) => row.projectName))];
  const title = running.length
    ? running.length === 1
      ? 'Analysis running'
      : running.length + ' analyses running'
    : ended.length === 1
      ? latest.status === 'DONE'
        ? 'Analysis finished'
        : 'Analysis stopped'
      : ended.length + ' analyses ended';
  const subtitle =
    (running.length || ended.length) === 1
      ? lead.projectName + ' · ' + lead.short
      : projects.join(', ');
  const tone = running.length ? 'is-running' : latest.status === 'DONE' ? 'is-done' : 'is-stopped';
  const count = running.length || ended.length;
  return (
    <div className={'analysis-indicator ' + tone} ref={root}>
      {live}
      <button
        type="button"
        className="analysis-pill"
        aria-expanded={open}
        aria-controls="analysis-panel"
        aria-label={title + ': ' + subtitle + '. Show details'}
        title={title + ' — ' + subtitle}
        onClick={(event) => {
          // On a phone the panel is pinned to the screen just under this button, wherever the
          // header's wrapping put it.
          setTop(Math.round(event.currentTarget.getBoundingClientRect().bottom) + 8);
          setOpen((value) => !value);
        }}
      >
        {statusIcon(running.length ? 'RUNNING' : latest.status, 17)}
        <span className="analysis-pill-text">
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </span>
        {/* On a phone the count is all there is room for; beside the words it adds only a 2+. */}
        <span
          className={'analysis-count' + (count === 1 ? ' is-phone-only' : '')}
          aria-hidden="true"
        >
          {count}
        </span>
        {running.length === 1 && (
          <span className="analysis-pill-bar" aria-hidden="true">
            <i style={{ width: (lead.total ? (lead.processed / lead.total) * 100 : 0) + '%' }} />
          </span>
        )}
      </button>
      {!running.length && (
        <button
          type="button"
          className="icon-button analysis-dismiss-all"
          aria-label="Dismiss the analysis summaries"
          title="Dismiss"
          onClick={() => ended.forEach((row) => row.dismiss())}
        >
          <X size={15} />
        </button>
      )}
      {open && (
        <section
          id="analysis-panel"
          className="analysis-panel"
          aria-label="Background analysis"
          style={{ '--analysis-panel-top': top + 'px' } as CSSProperties}
        >
          <div className="section-title">
            <h3>
              Background analysis{' '}
              <span className="muted">
                {running.length ? running.length + ' running' : 'nothing running'}
              </span>
            </h3>
          </div>
          {error && <Alert>{error}</Alert>}
          <ul className="analysis-list">
            {rows.map((row) => (
              <li key={row.key} className={'analysis-item is-' + row.status.toLowerCase()}>
                <div className="analysis-item-head">
                  {statusIcon(row.status, 17)}
                  <div>
                    <strong>{row.heading}</strong>
                    <small>{row.projectName}</small>
                  </div>
                  {row.status !== 'RUNNING' && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={'Dismiss: ' + row.heading + ' in ' + row.projectName}
                      title="Dismiss"
                      onClick={row.dismiss}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
                {row.status === 'RUNNING' && (
                  <div
                    className="analysis-progress"
                    role="progressbar"
                    aria-label={'Leads processed in ' + row.projectName}
                    aria-valuemin={0}
                    aria-valuemax={row.total}
                    aria-valuenow={row.processed}
                  >
                    <i
                      style={{ width: (row.total ? (row.processed / row.total) * 100 : 0) + '%' }}
                    />
                  </div>
                )}
                {row.detail && <p className="analysis-item-detail">{row.detail}</p>}
                {row.status === 'RUNNING' && <p className="analysis-item-origin">{row.origin}</p>}
                <div className="analysis-item-actions">
                  <a
                    className="text-button"
                    href={'#projects/' + row.projectId + '/leads'}
                    onClick={() => setOpen(false)}
                  >
                    Open lead list
                    <ArrowRight size={14} />
                  </a>
                  {row.status === 'RUNNING' &&
                    (row.canStop ? (
                      <button
                        type="button"
                        className="button danger"
                        disabled={row.stopping}
                        onClick={row.stop}
                      >
                        <CircleStop size={15} />
                        {row.stopping ? 'Stopping after this lead…' : 'Stop analysis'}
                      </button>
                    ) : (
                      <small>Only the person who started it or an administrator can stop it.</small>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

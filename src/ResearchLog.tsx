import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Globe, History, ListChecks, ScanLine, ShieldCheck, X } from 'lucide-react';
import type { Project } from '../shared/types';
import {
  fieldLabel,
  type QualificationEntry,
  type ResearchLogEntry,
  type ResearchLogKind,
  type ResearchLogPage,
  type ResearchPassEntry,
  type ReviewEntry,
} from '../shared/research-log';
import { api, safeHref } from './api';
import { leadLink } from './navigation';
import { Alert, Badge, Empty, Spinner } from './ui';
import './ResearchLog.css';

const kinds: Array<{ id: 'all' | ResearchLogKind; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'research', label: 'Website research' },
  { id: 'qualification', label: 'Analysis' },
  { id: 'review', label: 'Reviews' },
];
const kindLabels: Record<ResearchLogKind, string> = {
  research: 'Website research',
  qualification: 'Analysis',
  review: 'Human review',
};

/** "rotterdam-pumps.example.com/about" reads faster than a full URL. */
function pageName(url: string) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
  } catch {
    return url;
  }
}
function dayLabel(value: string) {
  const day = new Date(value);
  const today = new Date();
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(today) - start(day)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
const timeOf = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function Source({ url }: { url: string }) {
  const href = safeHref(url);
  return href ? (
    <a className="log-source" href={href} target="_blank" rel="noreferrer">
      {pageName(href)}
      <ArrowUpRight size={12} />
    </a>
  ) : (
    <span className="log-source">{url || 'Source not recorded'}</span>
  );
}

function ResearchDetails({ entry }: { entry: ResearchPassEntry }) {
  return (
    <>
      <p className="log-headline">
        {entry.found.length || entry.erased.length
          ? `Filled ${entry.found.length + entry.erased.length} missing detail${entry.found.length + entry.erased.length === 1 ? '' : 's'}`
          : 'Nothing new found'}
        {entry.website && (
          <span className="log-headline-muted">
            {' '}
            · {entry.discovered ? 'found and verified' : 'from'} {pageName(entry.website)}
          </span>
        )}
      </p>
      {(entry.found.length > 0 || entry.erased.length > 0) && (
        <dl className="log-findings">
          {entry.found.map((item) => (
            <div key={item.field}>
              <dt>{fieldLabel(item.field)}</dt>
              <dd>
                <strong>{item.value}</strong>
                {item.evidence ? (
                  <q>{item.evidence}</q>
                ) : (
                  <span className="log-check">The page names the company</span>
                )}
                <Source url={item.source_url} />
              </dd>
            </div>
          ))}
          {entry.erased.map((field) => (
            <div key={field} className="is-erased">
              <dt>{fieldLabel(field)}</dt>
              <dd>Removed with the contact, together with its quote.</dd>
            </div>
          ))}
        </dl>
      )}
      {entry.tried.length > 0 && <p className="log-meta-line">Checked: {entry.tried.join(', ')}</p>}
      {entry.notes.length > 0 && (
        <ul className="log-notes">
          {entry.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
      {entry.refused_count > 0 && (
        <p className="log-meta-line">
          {entry.refused_count} proposed value{entry.refused_count === 1 ? ' was' : 's were'} not
          saved: the page did not support {entry.refused_count === 1 ? 'it' : 'them'}.
        </p>
      )}
    </>
  );
}
function QualificationDetails({ entry }: { entry: QualificationEntry }) {
  return (
    <>
      <p className="log-headline">
        Analyzed against training v{entry.training_version}
        <Badge value={entry.decision} />
        <span className="log-score">Fit {entry.score}</span>
      </p>
      <p className="log-meta-line">
        Met {entry.criteria_met} of {entry.criteria_total} rule
        {entry.criteria_total === 1 ? '' : 's'}
        {entry.criteria_unknown > 0 && ` · ${entry.criteria_unknown} unable to verify`}
        {` · ${entry.exclusions_hit} exclusion${entry.exclusions_hit === 1 ? '' : 's'} hit`}
      </p>
      {entry.summary && <p className="log-summary">{entry.summary}</p>}
      {entry.pages.length > 0 && (
        <p className="log-meta-line log-pages">
          Read:{' '}
          {entry.pages.map((page, index) => (
            <span key={page}>
              {index > 0 && ', '}
              <Source url={page} />
            </span>
          ))}
        </p>
      )}
      {entry.gaps.length > 0 && (
        <p className="log-meta-line">Still missing: {entry.gaps.join('; ')}</p>
      )}
    </>
  );
}
function ReviewDetails({ entry }: { entry: ReviewEntry }) {
  return (
    <>
      <p className="log-headline">
        Decision recorded
        <Badge value={entry.decision} />
      </p>
      {entry.notes && <p className="log-summary">{entry.notes}</p>}
    </>
  );
}
const icons: Record<ResearchLogKind, ReactNode> = {
  research: <Globe size={16} />,
  qualification: <ScanLine size={16} />,
  review: <ShieldCheck size={16} />,
};

/**
 * The research history of a project as a log: per lead, what research was done, when and by
 * whom, and what it found or changed — each value with the sentence and page behind it. The
 * full audit record of the project stays one tab away.
 */
export default function ResearchLog({
  project,
  refresh,
  activity,
}: {
  project: Project;
  refresh: number;
  /** The project's complete audit record, shown under its own tab. */
  activity: ReactNode;
}) {
  const [tab, setTab] = useState<'log' | 'activity'>('log');
  const [kind, setKind] = useState<'all' | ResearchLogKind>('all');
  const [lead, setLead] = useState<{ id: number; name: string } | null>(null);
  const [entries, setEntries] = useState<ResearchLogEntry[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [loadingMore, setLoadingMore] = useState(false),
    [error, setError] = useState('');
  const sequence = useRef(0);
  const url = (before?: string) => {
    const params = new URLSearchParams({ kind });
    if (lead) params.set('lead_id', String(lead.id));
    if (before) params.set('before', before);
    return `/projects/${project.id}/research-log?${params}`;
  };
  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true);
    api<ResearchLogPage>(url())
      .then((page) => {
        if (request !== sequence.current) return;
        setEntries(page.entries);
        setNext(page.next_before);
        setError('');
      })
      .catch((e) => {
        if (request === sequence.current) setError((e as Error).message);
      })
      .finally(() => {
        if (request === sequence.current) setLoading(false);
      });
    // url() reads only these inputs.
  }, [project.id, kind, lead?.id, refresh]);
  async function older() {
    if (!next) return;
    const request = sequence.current;
    setLoadingMore(true);
    try {
      const page = await api<ResearchLogPage>(url(next));
      if (request !== sequence.current) return;
      setEntries((current) => [...current, ...page.entries]);
      setNext(page.next_before);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }
  const days: Array<{ label: string; items: ResearchLogEntry[] }> = [];
  for (const entry of entries) {
    const label = dayLabel(entry.created_at);
    if (days[days.length - 1]?.label === label) days[days.length - 1].items.push(entry);
    else days.push({ label, items: [entry] });
  }
  return (
    <div className="research-log">
      <div className="page-heading">
        <div>
          <span className="eyebrow">THE RESEARCH RECORD</span>
          <h1>
            Research log<span className="heading-dot">.</span>
          </h1>
          <p>
            What was researched on each lead in {project.name}, when and by whom — and what it found
            or changed, with the page behind every value.
          </p>
        </div>
      </div>
      <div className="result-tabs research-log-tabs" role="tablist" aria-label="Research history">
        <button
          role="tab"
          aria-selected={tab === 'log'}
          className={tab === 'log' ? 'active' : ''}
          onClick={() => setTab('log')}
        >
          <ListChecks size={16} />
          Research log
        </button>
        <button
          role="tab"
          aria-selected={tab === 'activity'}
          className={tab === 'activity' ? 'active' : ''}
          onClick={() => setTab('activity')}
        >
          <History size={16} />
          All project activity
        </button>
      </div>
      {tab === 'activity' ? (
        activity
      ) : (
        <section className="panel research-log-panel" aria-label="Research log">
          <div className="log-toolbar">
            <div className="log-kinds" role="group" aria-label="Show">
              {kinds.map((item) => (
                <button
                  key={item.id}
                  aria-pressed={kind === item.id}
                  className={kind === item.id ? 'active' : ''}
                  onClick={() => setKind(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {lead ? (
              <span className="log-lead-filter">
                Only <strong>{lead.name}</strong>
                <button
                  aria-label={'Show every lead, not only ' + lead.name}
                  onClick={() => setLead(null)}
                >
                  <X size={14} />
                </button>
              </span>
            ) : (
              <span className="log-hint">Select a company to see only its history.</span>
            )}
          </div>
          {error && <Alert>{error}</Alert>}
          {loading && !entries.length ? (
            <Spinner text="Loading the research log…" />
          ) : !entries.length && !error ? (
            <Empty icon={<History />} title="No research recorded yet">
              Research a lead’s missing details or analyze it against the training, and each step
              appears here with what it found.
            </Empty>
          ) : (
            <div className="log-days" aria-busy={loading}>
              {days.map((day) => (
                <section key={day.label} className="log-day">
                  <h2>{day.label}</h2>
                  {day.items.map((entry) => (
                    <article key={entry.id} className={'log-entry is-' + entry.kind}>
                      <span className="log-icon" aria-hidden="true">
                        {icons[entry.kind]}
                      </span>
                      <div className="log-body">
                        <header>
                          <button
                            className="log-lead"
                            title={'Show only ' + entry.lead_name}
                            onClick={() => setLead({ id: entry.lead_id, name: entry.lead_name })}
                          >
                            {entry.lead_name}
                          </button>
                          <span className="log-kind">{kindLabels[entry.kind]}</span>
                          <span className="log-when">
                            <time
                              dateTime={entry.created_at}
                              title={new Date(entry.created_at).toLocaleString()}
                            >
                              {timeOf(entry.created_at)}
                            </time>{' '}
                            · {entry.created_by}
                          </span>
                        </header>
                        {entry.kind === 'research' && <ResearchDetails entry={entry} />}
                        {entry.kind === 'qualification' && <QualificationDetails entry={entry} />}
                        {entry.kind === 'review' && <ReviewDetails entry={entry} />}
                      </div>
                      <a
                        className="icon-button log-open"
                        href={leadLink(
                          project.id,
                          entry.lead_id,
                          entry.kind === 'research' ? 'overview' : 'history',
                        )}
                        aria-label={'Open ' + entry.lead_name}
                        title={'Open ' + entry.lead_name}
                      >
                        <ArrowUpRight size={16} />
                      </a>
                    </article>
                  ))}
                </section>
              ))}
              {next && (
                <button
                  className="button secondary log-older"
                  disabled={loadingMore}
                  onClick={() => void older()}
                >
                  {loadingMore ? <Spinner text="Loading…" /> : 'Show older entries'}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

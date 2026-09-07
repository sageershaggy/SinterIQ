import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Download,
  FileText,
  Filter,
  Globe,
  History,
  Plus,
  ScanLine,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  Pencil,
  Phone,
  Mail,
  MessageSquareWarning,
} from 'lucide-react';
import { nextStepBands } from '../shared/types';
import type {
  Project,
  Lead,
  Decision,
  Run,
  CriterionResult,
  NextStep,
  LeadFeedback,
} from '../shared/types';
import { api, date, json, label } from './api';
import { Alert, Badge, Empty, ExternalLink, Modal, Spinner } from './ui';
import { PreviousResearch } from './PreviousResearch';

export default function Leads({
  project,
  queue,
  onChange,
  onTraining,
  notify,
}: {
  project: Project;
  queue: boolean;
  onChange: () => void;
  onTraining: () => void;
  notify: (text: string) => void;
}) {
  const base = '/projects/' + project.id;
  const [leads, setLeads] = useState<Lead[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(1);
  const [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [status, setStatus] = useState(queue ? 'REVIEW_QUEUE' : 'ALL');
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<number[]>([]),
    [detail, setDetail] = useState<number | null>(null),
    [create, setCreate] = useState(false),
    [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(''),
    mounted = useRef(true);
  const ready = project.active_version && project.revision === project.trained_revision;
  const reload = () => {
    setRefresh((n) => n + 1);
    onChange();
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelected([]);
    const params = new URLSearchParams({
      search: query,
      status,
      page: String(page),
      page_size: '30',
    });
    api<{ leads: Lead[]; total: number }>(base + '/leads?' + params)
      .then((data) => {
        if (!cancelled) {
          setLeads(data.leads);
          setTotal(data.total);
          setError('');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, project.active_version, project.revision, refresh, page, query, status]);
  async function bulkQualify() {
    setError('');
    let completed = 0;
    const failures: string[] = [];
    for (const [index, id] of selected.entries()) {
      if (!mounted.current) break;
      setBusy('Qualifying ' + (index + 1) + ' of ' + selected.length + '…');
      try {
        await api(base + '/leads/' + id + '/qualify', {
          method: 'POST',
          body: json({}),
        });
        completed++;
      } catch (e) {
        failures.push((leads.find((l) => l.id === id)?.name || id) + ': ' + (e as Error).message);
      }
    }
    if (mounted.current) {
      setBusy('');
      reload();
      setSelected([]);
      if (failures.length) setError(failures.join(' · '));
      notify(completed + ' lead' + (completed === 1 ? '' : 's') + ' qualified.');
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {queue ? 'HUMAN JUDGMENT, IN THE LOOP' : 'RESEARCH THAT FOLLOWS YOUR RULES'}
          </span>
          <h1>{queue ? 'A closer look.' : 'Find the right fit.'}</h1>
          <p>
            {queue
              ? 'Review uncertain findings, research new leads and revisit results when training changes.'
              : 'Analyze your leads against ' +
                project.name +
                ' training. Understand the evidence behind the fit.'}
          </p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" onClick={() => setImporting(true)}>
            <Upload size={16} />
            Import CSV
          </button>
          <button className="button primary" onClick={() => setCreate(true)}>
            <Plus size={17} />
            Add lead
          </button>
        </div>
      </div>
      {!ready && (
        <div className="inline-notice">
          <BookOpen size={20} />
          <span>
            <strong>Training comes first.</strong> Publish your current training to start qualifying
            these leads.
          </span>
          <button className="text-button" onClick={onTraining}>
            Open training
            <ArrowRight size={15} />
          </button>
        </div>
      )}
      <div className="lead-summary">
        <span>
          <Users size={16} />
          <strong>{project.lead_count}</strong> total leads
        </span>
        <span>
          <span className="small-dot green-dot" />
          <strong>{project.qualified_count}</strong> qualified on current training
        </span>
        <span>
          <span className="small-dot amber-dot" />
          <strong>{project.review_count}</strong> awaiting research
        </span>
        {ready && (
          <span className="training-version">
            <BookOpen size={14} />
            Training v{project.active_version}
          </span>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      <section className="panel leads-panel">
        <div className="table-toolbar">
          <div className="search-input">
            <Search size={17} />
            <input
              aria-label="Search leads"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search company, industry or country…"
            />
          </div>
          <div className="table-filter">
            <Filter size={15} />
            <select
              aria-label="Filter leads by status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="ALL">All leads</option>
              {queue && <option value="REVIEW_QUEUE">All awaiting research</option>}
              <option value="UNREVIEWED">Unreviewed</option>
              <option value="QUALIFIED">Qualified</option>
              <option value="CALL_READY">Call ready ({nextStepBands.call}–100)</option>
              <option value="SEND_EMAIL">
                Send an email ({nextStepBands.email}–{nextStepBands.call - 1})
              </option>
              <option value="REVIEW_WITH_CLIENT">
                Review with the client ({nextStepBands.review}–{nextStepBands.email - 1})
              </option>
              <option value="NEEDS_REVIEW">Needs review</option>
              <option value="NOT_A_TARGET">Not a target</option>
              <option value="STALE">Training or lead changed</option>
            </select>
          </div>
          <a className="button secondary export-button" href={'/api' + base + '/leads/export'}>
            <ArrowDownToLine size={15} />
            Export
          </a>
        </div>
        {selected.length > 0 && (
          <div className="selection-bar">
            <span>{selected.length} selected</span>
            <button className="button primary" disabled={!ready || !!busy} onClick={bulkQualify}>
              {busy ? (
                <Spinner text={busy} />
              ) : (
                <>
                  <Sparkles size={15} />
                  Qualify selected
                </>
              )}
            </button>
            <button className="text-button" disabled={!!busy} onClick={() => setSelected([])}>
              Clear selection
            </button>
          </div>
        )}
        {loading ? (
          <div className="table-loading">
            <Spinner text="Loading leads…" />
          </div>
        ) : !leads.length ? (
          <Empty
            icon={<ScanLine size={30} />}
            title={
              query || status !== 'ALL'
                ? 'No leads match this view'
                : 'Your next discovery starts here'
            }
            action={
              <button className="button secondary" onClick={() => setCreate(true)}>
                <Plus size={16} />
                Add a lead
              </button>
            }
          >
            {query || status !== 'ALL'
              ? 'Try another filter, or add a lead to this project.'
              : 'Add a company and its website, or import a CSV to build your research list.'}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="checkbox-cell">
                    <input
                      type="checkbox"
                      aria-label="Select up to 20 visible leads"
                      disabled={!!busy}
                      checked={
                        selected.length > 0 && selected.length === Math.min(20, leads.length)
                      }
                      onChange={(e) =>
                        setSelected(e.target.checked ? leads.slice(0, 20).map((l) => l.id) : [])
                      }
                    />
                  </th>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>Industry / location</th>
                  <th>Fit score</th>
                  <th>Next step</th>
                  <th>Qualification</th>
                  <th>
                    <span className="visually-hidden">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id}>
                    <td className="checkbox-cell">
                      <input
                        type="checkbox"
                        aria-label={'Select ' + lead.name}
                        checked={selected.includes(lead.id)}
                        disabled={!!busy || (!selected.includes(lead.id) && selected.length >= 20)}
                        onChange={(e) =>
                          setSelected((ids) =>
                            e.target.checked
                              ? [...ids, lead.id]
                              : ids.filter((id) => id !== lead.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <div className="lead-company">
                        <span className="lead-monogram">{lead.name.slice(0, 2).toUpperCase()}</span>
                        <div>
                          <button className="lead-name" onClick={() => setDetail(lead.id)}>
                            {lead.name}
                          </button>
                          <ExternalLink url={lead.website} />
                        </div>
                      </div>
                    </td>
                    <td>
                      {lead.contact_name ? (
                        <>
                          <span className="industry-text">{lead.contact_name}</span>
                          <small className="table-subtext">
                            {lead.contact_role || 'Role not published'}
                          </small>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className="industry-text">{lead.industry || 'Industry unknown'}</span>
                      <small className="table-subtext">{lead.country || 'Location unknown'}</small>
                    </td>
                    <td>
                      {lead.score === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <div className={'score-cell ' + (lead.stale ? 'score-stale' : '')}>
                          <strong>
                            {lead.score}
                            <small>/100</small>
                          </strong>
                          <span className="score-track">
                            <i style={{ width: lead.score + '%' }} />
                          </span>
                        </div>
                      )}
                    </td>
                    <td>
                      <NextStepBadge step={lead.next_step} />
                    </td>
                    <td>
                      <Badge value={lead.stale ? 'stale' : lead.status}>
                        {lead.stale ? 'Requalification needed' : label(lead.status)}
                      </Badge>
                      <small className="table-subtext">
                        {lead.reviewed && (
                          <>
                            <ShieldCheck size={12} /> Human reviewed ·{' '}
                          </>
                        )}
                        {lead.training_version ? 'Training v' + lead.training_version : 'No run'}
                      </small>
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        onClick={() => setDetail(lead.id)}
                        aria-label={'View reasoning for ' + lead.name}
                      >
                        <ArrowUpRight size={19} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <span>
            {total ? Math.min((page - 1) * 30 + 1, total) : 0}–{Math.min(page * 30, total)} of{' '}
            {total} leads
          </span>
          <span className="fine-print">Select up to 20 leads for a qualification batch.</span>
          <div>
            <button
              className="icon-button"
              disabled={page <= 1 || loading || !!busy}
              onClick={() => setPage((n) => n - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft size={18} />
            </button>
            <span>{page}</span>
            <button
              className="icon-button"
              disabled={page * 30 >= total || loading || !!busy}
              onClick={() => setPage((n) => n + 1)}
              aria-label="Next page"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </section>
      {create && (
        <LeadForm
          projectId={project.id}
          onClose={() => setCreate(false)}
          onSaved={(lead) => {
            setCreate(false);
            reload();
            setDetail(lead.id);
            notify('Lead added to ' + project.name + '.');
          }}
        />
      )}
      {importing && (
        <ImportModal
          projectId={project.id}
          onClose={() => setImporting(false)}
          onImported={(message) => {
            reload();
            notify(message);
          }}
        />
      )}
      {detail && (
        <LeadDetail
          project={project}
          leadId={detail}
          onClose={() => setDetail(null)}
          onChange={reload}
          onTraining={() => {
            setDetail(null);
            onTraining();
          }}
          notify={notify}
        />
      )}
    </>
  );
}
function LeadForm({
  projectId,
  lead,
  onClose,
  onSaved,
}: {
  projectId: number;
  lead?: Lead;
  onClose: () => void;
  onSaved: (lead: Lead) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      onSaved(
        await api<Lead>('/projects/' + projectId + '/leads' + (lead ? '/' + lead.id : ''), {
          method: lead ? 'PUT' : 'POST',
          body: json({
            ...data,
            ...(lead ? { revision: lead.revision } : {}),
          }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={lead ? 'Edit lead context' : 'Add a research lead'} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label>
          Company name
          <input name="name" required defaultValue={lead?.name} maxLength={200} autoFocus />
        </label>
        <label>
          Company website
          <input
            name="website"
            type="url"
            defaultValue={lead?.website}
            placeholder="https://example.com"
            maxLength={2000}
          />
          <small>A website helps support qualification with public evidence.</small>
        </label>
        <div className="form-grid">
          <label>
            Country
            <input name="country" defaultValue={lead?.country} maxLength={120} />
          </label>
          <label>
            Industry
            <input name="industry" defaultValue={lead?.industry} maxLength={200} />
          </label>
        </div>
        <label>
          Research context
          <textarea
            name="notes"
            rows={5}
            defaultValue={lead?.notes}
            maxLength={10000}
            placeholder="Known products, applications, company size, engineering capability or questions to investigate…"
          />
        </label>
        {error && <Alert>{error}</Alert>}
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : lead ? 'Save changes' : 'Add lead'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ImportModal({
  projectId,
  onClose,
  onImported,
}: {
  projectId: number;
  onClose: () => void;
  onImported: (text: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
    duplicates: string[];
  } | null>(null);
  return (
    <Modal title="Import research leads" onClose={onClose}>
      <div className="form-stack">
        <p className="muted">
          Import up to 500 leads from a UTF-8 CSV. Duplicate names or website domains in this
          project are skipped.
        </p>
        <div className="csv-example">
          <strong>CSV column headers</strong>
          <code>name,website,country,industry,notes</code>
          <small>Only name is required. The company_name column is also accepted.</small>
        </div>
        <a className="text-button" href="/branding/leads-template.csv" download>
          <Download size={15} />
          Download CSV template
        </a>
        <label className="upload-zone">
          <Upload size={27} />
          <strong>{file?.name || 'Choose a CSV file'}</strong>
          <small>Up to 1 MB · 500 rows</small>
          <input
            type="file"
            accept=".csv"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setResult(null);
            }}
          />
        </label>
        {error && <Alert>{error}</Alert>}
        {result && (
          <div className="import-result">
            <CheckCircle2 size={19} />
            <strong>
              {result.created} created · {result.skipped} duplicates skipped
            </strong>
            {result.duplicates.length > 0 && (
              <details>
                <summary>Skipped companies</summary>
                <ul>
                  {result.duplicates.map((name, i) => (
                    <li key={i}>{name}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        <div className="form-actions">
          <button className="button secondary" onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </button>
          <button
            className="button primary"
            disabled={busy || !file || !!result}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const data = new FormData();
                data.set('file', file!);
                const result = await api<{
                  created: number;
                  skipped: number;
                  duplicates: string[];
                }>('/projects/' + projectId + '/leads/import', {
                  method: 'POST',
                  body: data,
                });
                setResult(result);
                onImported(
                  result.created + ' leads imported; ' + result.skipped + ' duplicates skipped.',
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner text="Importing…" /> : 'Import leads'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
function LeadDetail({
  project,
  leadId,
  onClose,
  onChange,
  onTraining,
  notify,
}: {
  project: Project;
  leadId: number;
  onClose: () => void;
  onChange: () => void;
  onTraining: () => void;
  notify: (text: string) => void;
}) {
  const base = '/projects/' + project.id + '/leads/' + leadId;
  const [lead, setLead] = useState<Lead | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [runId, setRunId] = useState<number | null>(null),
    [decision, setDecision] = useState<Decision>('NEEDS_REVIEW'),
    [reviewNotes, setReviewNotes] = useState('');
  const [tab, setTab] = useState<'reasoning' | 'evidence' | 'history' | 'feedback'>('reasoning');
  const ready = project.active_version && project.revision === project.trained_revision;
  useEffect(() => {
    let cancelled = false;
    api<Lead>(base)
      .then((data) => {
        if (!cancelled) {
          setLead(data);
          setRunId(data.runs?.[0]?.id || null);
          setDecision(data.status === 'UNREVIEWED' ? 'NEEDS_REVIEW' : data.status);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [leadId, refresh, project.revision, project.active_version]);
  const run = lead?.runs?.find((r) => r.id === runId);
  async function qualifyLead() {
    setBusy(true);
    setError('');
    try {
      await api(base + '/qualify', { method: 'POST', body: json({}) });
      setRefresh((n) => n + 1);
      onChange();
      notify('Qualification complete. Review the evidence and reasoning.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function eraseContact() {
    setError('');
    try {
      await api(base + '/contact', { method: 'DELETE' });
      setRefresh((n) => n + 1);
      notify('Contact removed from this lead.');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function review(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(base + '/review', {
        method: 'POST',
        body: json({
          run_id: lead!.latest_run_id,
          decision,
          notes: reviewNotes,
        }),
      });
      setRefresh((n) => n + 1);
      setReviewNotes('');
      onChange();
      notify('Human review recorded.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (editing && lead)
    return (
      <LeadForm
        projectId={project.id}
        lead={lead}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          setRefresh((n) => n + 1);
          onChange();
          notify('Lead context updated. Requalify to use the new information.');
        }}
      />
    );
  return (
    <Modal title={lead?.name || 'Lead research'} onClose={onClose} wide>
      <div className="lead-detail">
        {error && <Alert>{error}</Alert>}
        {!lead ? (
          <Spinner text="Loading research…" />
        ) : (
          <>
            <div className="detail-heading">
              <div>
                <div className="detail-meta">
                  <ExternalLink url={lead.website} />
                  <span>{lead.country || 'Location unknown'}</span>
                  <span>{lead.industry || 'Industry unknown'}</span>
                </div>
                <div className="detail-badges">
                  <Badge value={lead.stale ? 'stale' : lead.status}>
                    {lead.stale ? 'Requalification needed' : label(lead.status)}
                  </Badge>
                  {lead.reviewed && <Badge value="ready">Human reviewed</Badge>}
                </div>
              </div>
              <button className="button secondary" onClick={() => setEditing(true)} disabled={busy}>
                <Pencil size={15} />
                Edit context
              </button>
            </div>
            <div className="detail-qualify">
              <div>
                <strong>
                  {ready
                    ? 'Qualify with training v' + project.active_version
                    : 'Project training is not ready'}
                </strong>
                <small>
                  {lead.latest_run_id
                    ? 'A new analysis keeps all previous results for comparison.'
                    : 'Analyze this company using approved project knowledge and public website evidence.'}
                </small>
              </div>
              <button
                className="button primary"
                disabled={busy}
                onClick={ready ? qualifyLead : onTraining}
              >
                {busy ? (
                  <Spinner text="Working…" />
                ) : (
                  <>
                    <Sparkles size={16} />
                    {ready
                      ? lead.latest_run_id
                        ? 'Requalify lead'
                        : 'Qualify lead'
                      : 'Open training'}
                  </>
                )}
              </button>
            </div>
            {lead.notes && (
              <details className="context-details">
                <summary>Lead context</summary>
                <p className="preserve-text">{lead.notes}</p>
              </details>
            )}
            {lead.legacy_json && <PreviousResearch lead={lead} projectName={project.name} />}
            {run ? (
              <>
                <div className="result-tabs" role="tablist" aria-label="Qualification details">
                  {(
                    [
                      { id: 'reasoning', title: 'Reasoning', icon: ScanLine },
                      {
                        id: 'evidence',
                        title: 'Source evidence',
                        icon: FileText,
                      },
                      {
                        id: 'history',
                        title: 'Analysis history',
                        icon: History,
                      },
                      {
                        id: 'feedback',
                        title: 'Training feedback',
                        icon: MessageSquareWarning,
                      },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      role="tab"
                      aria-selected={tab === item.id}
                      onClick={() => setTab(item.id)}
                      className={tab === item.id ? 'active' : ''}
                    >
                      <item.icon size={16} />
                      {item.title}
                    </button>
                  ))}
                </div>
                {tab === 'reasoning' && (
                  <div className="result-content">
                    <div className="result-metrics">
                      <div>
                        <small>AI DECISION</small>
                        <Badge value={run.result.decision} />
                      </div>
                      <div>
                        <small>FIT SCORE</small>
                        <strong>
                          {run.result.score}
                          <span>/100</span>
                        </strong>
                      </div>
                      <div>
                        <small>CONFIDENCE</small>
                        <strong>
                          {run.result.confidence}
                          <span>%</span>
                        </strong>
                      </div>
                      <div>
                        <small>TRAINING</small>
                        <strong>v{run.training_version}</strong>
                      </div>
                    </div>
                    <section className="reasoning-summary">
                      <span className="eyebrow">WHY THIS DECISION</span>
                      <p>{run.result.summary}</p>
                      <small>
                        {run.created_by} · {date(run.created_at)} · {run.model}
                      </small>
                    </section>
                    {(lead.next_step !== 'NONE' || run.result.outreach?.call_script) && (
                      <section className="outreach-box">
                        <div className="outreach-heading">
                          <NextStepBadge step={lead.next_step} />
                          <small>
                            Fit {run.result.score}/100 · {nextStepLabels[lead.next_step].hint}
                          </small>
                        </div>
                        {lead.contact_name && (
                          <p className="outreach-contact">
                            <Users size={15} />
                            <span>
                              <strong>{lead.contact_name}</strong>
                              {lead.contact_role && <small> · {lead.contact_role}</small>}
                            </span>
                            <button
                              className="text-button"
                              onClick={() => void eraseContact()}
                              title="Delete this contact from the lead"
                            >
                              Remove contact
                            </button>
                          </p>
                        )}
                        {run.result.outreach?.why_qualified && (
                          <>
                            <h3>Why this lead qualifies</h3>
                            <p>{run.result.outreach.why_qualified}</p>
                          </>
                        )}
                        {run.result.outreach?.call_script && (
                          <>
                            <h3>Call opener</h3>
                            <blockquote className="call-script">
                              {run.result.outreach.call_script}
                            </blockquote>
                            <small className="fine-print">
                              Read this as a starting point and verify every claim against the
                              evidence tab before contacting anyone.
                            </small>
                          </>
                        )}
                      </section>
                    )}
                    <h3>Qualification criteria</h3>
                    <Criteria items={run.result.criteria} />
                    <h3>Exclusion checks</h3>
                    {run.result.exclusions.length ? (
                      <Criteria items={run.result.exclusions} />
                    ) : (
                      <p className="muted">No exclusion rules defined in this training version.</p>
                    )}
                    {run.result.gaps.length > 0 && (
                      <section className="gaps-box">
                        <h3>Evidence gaps & review notes</h3>
                        <ul>
                          {run.result.gaps.map((gap, i) => (
                            <li key={i}>{gap}</li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {run.result.next_steps.length > 0 && (
                      <>
                        <h3>Next research steps</h3>
                        <ul className="next-steps">
                          {run.result.next_steps.map((step, i) => (
                            <li key={i}>{step}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
                {tab === 'evidence' && (
                  <div className="evidence-list">
                    <p className="muted">
                      These are the exact source excerpts supplied to this analysis. Source IDs
                      connect them to the reasoning.
                    </p>
                    {run.evidence.map((item) => (
                      <details key={item.id}>
                        <summary>
                          <span className="evidence-id">{item.id}</span>
                          {item.title}
                        </summary>
                        <div className="evidence-content">
                          {item.url && <ExternalLink url={item.url} />}
                          <small>Captured {date(item.captured_at)}</small>
                          <pre>{item.content}</pre>
                        </div>
                      </details>
                    ))}
                  </div>
                )}
                {tab === 'history' && (
                  <div className="history-list">
                    <h3>Qualification runs</h3>
                    {lead.runs?.map((item) => (
                      <button
                        className={'run-history ' + (item.id === runId ? 'selected' : '')}
                        key={item.id}
                        onClick={() => {
                          setRunId(item.id);
                          setTab('reasoning');
                        }}
                      >
                        <span>
                          <strong>
                            Training v{item.training_version} · lead revision {item.lead_revision}
                          </strong>
                          <small>
                            {date(item.created_at)} · {item.created_by} · {item.model}
                          </small>
                        </span>
                        <Badge value={item.result.decision} />
                        <ArrowRight size={16} />
                      </button>
                    ))}
                    <h3>Human review record</h3>
                    {lead.reviews?.length ? (
                      lead.reviews.map((item) => (
                        <div className="human-review-history" key={item.id}>
                          <div>
                            <Badge value={item.decision} />
                            <small>
                              {item.created_by} · {date(item.created_at)} · analysis #{item.run_id}
                            </small>
                          </div>
                          <p>{item.notes}</p>
                        </div>
                      ))
                    ) : (
                      <p className="muted">No human reviews yet.</p>
                    )}
                  </div>
                )}
                {tab === 'feedback' && (
                  <FeedbackTab
                    base={base}
                    runId={runId}
                    feedback={lead.feedback || []}
                    onSaved={() => {
                      setRefresh((n) => n + 1);
                      onChange();
                      notify(
                        'Feedback saved to the training library. Publish a new training version to apply it.',
                      );
                    }}
                  />
                )}
                {runId !== lead.latest_run_id && (
                  <div className="inline-notice">
                    <History size={17} />
                    <span>You are viewing an earlier analysis.</span>
                    <button className="text-button" onClick={() => setRunId(lead.latest_run_id)}>
                      View latest
                    </button>
                  </div>
                )}
                {runId === lead.latest_run_id && !lead.stale && (
                  <form className="human-review-form" onSubmit={review}>
                    <div className="section-title">
                      <h3>
                        <ShieldCheck size={18} />
                        Record your review
                      </h3>
                      <span className="muted">
                        {lead.reviewed ? 'Add a follow-up decision' : 'Human judgment'}
                      </span>
                    </div>
                    <label>
                      Final decision
                      <select
                        value={decision}
                        onChange={(e) => setDecision(e.target.value as Decision)}
                      >
                        <option value="QUALIFIED">Qualified</option>
                        <option value="NOT_A_TARGET">Not a target</option>
                        <option value="NEEDS_REVIEW">Needs more research</option>
                      </select>
                    </label>
                    <label>
                      Your reasoning
                      <textarea
                        rows={3}
                        value={reviewNotes}
                        onChange={(e) => setReviewNotes(e.target.value)}
                        minLength={15}
                        maxLength={6000}
                        required
                        placeholder="Explain the evidence you checked and why you agree or disagree…"
                      />
                    </label>
                    <button
                      className="button primary"
                      disabled={busy || reviewNotes.trim().length < 15}
                    >
                      <ClipboardCheck size={16} />
                      Save review
                    </button>
                  </form>
                )}
              </>
            ) : (
              <Empty icon={<ScanLine size={28} />} title="Ready for a closer look">
                {ready
                  ? 'Run qualification to see the fit score, evidence, rule-by-rule assessment and research gaps.'
                  : 'Publish project training, then return to qualify this lead.'}
              </Empty>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
function Criteria({ items }: { items: CriterionResult[] }) {
  return (
    <div className="criteria-list">
      {items.map((item, index) => (
        <div className="criterion" key={index}>
          <div>
            <span className="criterion-number">{String(index + 1).padStart(2, '0')}</span>
            <strong>{item.criterion}</strong>
            <Badge value={item.outcome} />
          </div>
          <p>{item.evidence}</p>
          <div className="evidence-tags">
            {item.source_ids.map((id) => (
              <span key={id}>{id}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const nextStepLabels: Record<NextStep, { label: string; hint: string }> = {
  CALL_READY: { label: 'Call ready', hint: 'Strong fit. Use the call script on the lead.' },
  SEND_EMAIL: { label: 'Send an email', hint: 'Good fit. Open with an email before calling.' },
  REVIEW_WITH_CLIENT: {
    label: 'Review with client',
    hint: 'Partial fit or open questions. Confirm before any outreach.',
  },
  NONE: { label: 'No outreach', hint: 'Not a target, or not qualified against current training.' },
};
export function NextStepBadge({ step }: { step: NextStep }) {
  const meta = nextStepLabels[step];
  const icon =
    step === 'CALL_READY' ? <Phone size={12} /> : step === 'SEND_EMAIL' ? <Mail size={12} /> : null;
  return (
    <span className={'next-step next-step-' + step.toLowerCase()} title={meta.hint}>
      {icon}
      {meta.label}
    </span>
  );
}
/**
 * Lead-level correction. It never rewrites the stored analysis; it joins the project
 * training library so the next published version reflects the reviewer's judgment.
 */
function FeedbackTab({
  base,
  runId,
  feedback,
  onSaved,
}: {
  base: string;
  runId: number | null;
  feedback: LeadFeedback[];
  onSaved: () => void;
}) {
  const [verdict, setVerdict] = useState<'CORRECT' | 'INCORRECT'>('INCORRECT');
  const [expected, setExpected] = useState<Decision>('NOT_A_TARGET');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="feedback-tab">
      <p className="muted">
        Tell the project what this analysis got right or wrong. Corrections become part of the
        training library and are applied when an administrator publishes the next training version.
        The stored analysis and the lead&apos;s decision are never rewritten.
      </p>
      {error && <Alert>{error}</Alert>}
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api(base + '/feedback', {
              method: 'POST',
              body: json({
                run_id: runId,
                verdict,
                expected_decision: verdict === 'INCORRECT' ? expected : null,
                notes,
              }),
            });
            setNotes('');
            onSaved();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          This qualification was
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)}>
            <option value="INCORRECT">Wrong — the training needs to change</option>
            <option value="CORRECT">Right — reinforce this reasoning</option>
          </select>
        </label>
        {verdict === 'INCORRECT' && (
          <label>
            It should have been
            <select value={expected} onChange={(e) => setExpected(e.target.value as Decision)}>
              <option value="NOT_A_TARGET">Not a target</option>
              <option value="QUALIFIED">Qualified</option>
              <option value="NEEDS_REVIEW">Needs review</option>
            </select>
          </label>
        )}
        <label>
          What the training should learn
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            minLength={15}
            maxLength={4000}
            required
            placeholder="Explain the rule or distinction that was missed, so future research applies it."
          />
          <small>At least 15 characters. Describe the rule, not just this one company.</small>
        </label>
        <div className="form-actions">
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner text="Saving…" /> : 'Add to training library'}
          </button>
        </div>
      </form>
      <h3>Feedback on this lead</h3>
      {feedback.length ? (
        feedback.map((item) => (
          <div className="human-review-history" key={item.id}>
            <div>
              <Badge value={item.verdict === 'CORRECT' ? 'QUALIFIED' : 'NEEDS_REVIEW'}>
                {item.verdict === 'CORRECT' ? 'Confirmed' : 'Corrected'}
              </Badge>
              <small>
                {item.created_by} · {date(item.created_at)} ·{' '}
                {item.applied_version
                  ? 'applied in training v' + item.applied_version
                  : 'awaiting the next published training version'}
              </small>
            </div>
            {item.expected_decision && (
              <p>
                <strong>Should have been:</strong> {label(item.expected_decision)}
              </p>
            )}
            <p>{item.notes}</p>
          </div>
        ))
      ) : (
        <p className="muted">No feedback recorded for this lead yet.</p>
      )}
    </div>
  );
}

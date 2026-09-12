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
  Trash2,
  ChevronDown,
  Phone,
  Mail,
  MessageSquareWarning,
  UserPlus,
  PhoneCall,
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
  CallLog,
  CallOutcome,
  EmailMessage,
  User,
} from '../shared/types';
import { api, date, json, label } from './api';
import { Alert, Badge, Empty, ExternalLink, Modal, Spinner } from './ui';
import { PreviousResearch } from './PreviousResearch';
import { EmailComposer } from './EmailComposer';

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
  const [filterOpen, setFilterOpen] = useState(false),
    filterRef = useRef<HTMLDivElement>(null),
    exportRef = useRef<HTMLDivElement>(null);
  const [exportOpen, setExportOpen] = useState(false),
    [confirmDelete, setConfirmDelete] = useState<number[] | null>(null),
    [assigning, setAssigning] = useState<number[] | null>(null),
    [assignees, setAssignees] = useState<User[]>([]);
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
    // Either menu closes on an outside click or Escape.
    if (!filterOpen && !exportOpen) return;
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!filterRef.current?.contains(target)) setFilterOpen(false);
      if (!exportRef.current?.contains(target)) setExportOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFilterOpen(false);
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [filterOpen, exportOpen]);
  useEffect(() => {
    api<User[]>(base + '/assignees')
      .then(setAssignees)
      .catch(() => setAssignees([]));
  }, [base]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelected([]);
    const params = new URLSearchParams({
      search: query,
      // "Assigned to me" is the ASSIGNED view narrowed to the signed-in account.
      status: status === 'ASSIGNED_TO_ME' ? 'ASSIGNED' : status,
      ...(status === 'ASSIGNED_TO_ME' ? { assigned_to: 'me' } : {}),
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
  async function qualifyOne(lead: Lead) {
    setBusy('lead-' + lead.id);
    setError('');
    try {
      await api(base + '/leads/' + lead.id + '/qualify', { method: 'POST', body: json({}) });
      if (!mounted.current) return;
      reload();
      notify(lead.name + ' researched. Open it to see the evidence.');
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy('');
    }
  }
  async function deleteLeads(ids: number[]) {
    setBusy('Deleting…');
    setError('');
    try {
      if (ids.length === 1) await api(base + '/leads/' + ids[0], { method: 'DELETE' });
      else await api(base + '/leads/delete', { method: 'POST', body: json({ ids }) });
      if (!mounted.current) return;
      setSelected([]);
      setConfirmDelete(null);
      reload();
      notify(ids.length + ' lead' + (ids.length === 1 ? '' : 's') + ' deleted.');
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy('');
    }
  }
  async function assignLeads(ids: number[], accountId: number | null) {
    setBusy('Assigning…');
    setError('');
    const who = assignees.find((person) => person.id === accountId)?.name || 'the team';
    try {
      if (ids.length === 1)
        await api(base + '/leads/' + ids[0] + '/assignment', {
          method: 'PUT',
          body: json({ account_id: accountId }),
        });
      else
        await api(base + '/leads/assign', {
          method: 'POST',
          body: json({ ids, account_id: accountId }),
        });
      if (!mounted.current) return;
      setAssigning(null);
      setSelected([]);
      reload();
      notify(
        accountId === null
          ? ids.length +
              ' lead' +
              (ids.length === 1 ? '' : 's') +
              ' returned to the pool — no longer assigned to anyone.'
          : ids.length +
              ' lead' +
              (ids.length === 1 ? '' : 's') +
              ' assigned to ' +
              who +
              ' for calling. They will see ' +
              (ids.length === 1 ? 'it' : 'them') +
              ' under “Assigned to me” in the Review queue.',
      );
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy('');
    }
  }
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
            Import leads
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
          {/* A real dropdown rather than a native select: the OS popup cannot be aligned
              or padded, and its hit area does not match the control. */}
          <div className="filter-menu" ref={filterRef}>
            <button
              className="table-filter"
              aria-haspopup="listbox"
              aria-expanded={filterOpen}
              onClick={() => {
                setFilterOpen((open) => !open);
                setExportOpen(false);
              }}
            >
              <Filter size={15} />
              <span className="filter-value">
                {statusFilters(queue).find((o) => o.value === status)?.label || 'All leads'}
              </span>
              <ChevronDown size={15} className={'filter-caret ' + (filterOpen ? 'is-open' : '')} />
            </button>
            {filterOpen && (
              <div className="filter-dropdown" role="listbox">
                {statusFilters(queue).map((option) => (
                  <button
                    key={option.value}
                    role="option"
                    aria-selected={status === option.value}
                    className={status === option.value ? 'is-selected' : ''}
                    onClick={() => {
                      setStatus(option.value);
                      setPage(1);
                      setFilterOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="export-menu" ref={exportRef}>
            <button
              className="button secondary"
              aria-expanded={exportOpen}
              aria-haspopup="true"
              onClick={() => {
                setExportOpen((open) => !open);
                setFilterOpen(false);
              }}
            >
              <ArrowDownToLine size={15} />
              Export
              <ChevronDown size={14} />
            </button>
            {exportOpen && (
              <div className="export-dropdown" role="menu">
                <a
                  role="menuitem"
                  href={
                    '/api' +
                    base +
                    '/leads/export?' +
                    new URLSearchParams({
                      status: status === 'ASSIGNED_TO_ME' ? 'ASSIGNED' : status,
                      ...(status === 'ASSIGNED_TO_ME' ? { assigned_to: 'me' } : {}),
                      search: query,
                    })
                  }
                  onClick={() => setExportOpen(false)}
                >
                  <strong>This view</strong>
                  <small>
                    {statusFilters(queue).find((o) => o.value === status)?.label}
                    {query ? ' · matching “' + query + '”' : ''} · {total} lead
                    {total === 1 ? '' : 's'}
                  </small>
                </a>
                <div className="export-divider" />
                {statusFilters(queue)
                  .filter((option) => option.value !== status)
                  .map((option) => (
                    <a
                      key={option.value}
                      role="menuitem"
                      href={'/api' + base + '/leads/export?status=' + option.value}
                      onClick={() => setExportOpen(false)}
                    >
                      {option.label}
                    </a>
                  ))}
              </div>
            )}
          </div>
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
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => setAssigning(selected)}
            >
              <UserPlus size={15} />
              Assign for calling
            </button>
            <button
              className="button danger"
              disabled={!!busy}
              onClick={() => setConfirmDelete(selected)}
            >
              <Trash2 size={15} />
              Delete selected
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
                  <th>Assigned to</th>
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
                      <button
                        className="assignee-cell"
                        disabled={!!busy}
                        onClick={() => setAssigning([lead.id])}
                        title="Assign this lead for calling"
                      >
                        {lead.assigned_to_name ? (
                          <>
                            <span className="assignee-avatar">{lead.assigned_to_name[0]}</span>
                            <span>
                              {lead.assigned_to_name}
                              {(lead.call_count || 0) > 0 && (
                                <small>
                                  {lead.call_count} call{lead.call_count === 1 ? '' : 's'} logged
                                </small>
                              )}
                            </span>
                          </>
                        ) : (
                          <>
                            <UserPlus size={14} />
                            <span className="muted">Assign</span>
                          </>
                        )}
                      </button>
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
                      <div className="row-actions">
                        <button
                          className="button small primary"
                          disabled={!ready || !!busy}
                          title={
                            ready
                              ? 'Research this lead with AI against training v' +
                                project.active_version
                              : 'Publish your training before qualifying leads'
                          }
                          onClick={() => void qualifyOne(lead)}
                        >
                          {busy === 'lead-' + lead.id ? (
                            <Spinner text="" />
                          ) : (
                            <>
                              <Sparkles size={14} />
                              {lead.latest_run_id ? 'Re-run' : 'Qualify'}
                            </>
                          )}
                        </button>
                        <button
                          className="icon-button"
                          onClick={() => setDetail(lead.id)}
                          aria-label={'View reasoning for ' + lead.name}
                          title="Open lead"
                        >
                          <ArrowUpRight size={18} />
                        </button>
                        <button
                          className="icon-button danger"
                          disabled={!!busy}
                          onClick={() => setConfirmDelete([lead.id])}
                          aria-label={'Delete ' + lead.name}
                          title="Delete lead"
                        >
                          <Trash2 size={17} />
                        </button>
                      </div>
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
      {assigning && (
        <Modal
          title={
            assigning.length === 1 ? 'Assign this lead for calling' : 'Assign leads for calling'
          }
          onClose={() => setAssigning(null)}
        >
          <div className="form-stack">
            <p className="muted">
              The person you pick sees these {assigning.length === 1 ? 'lead' : 'leads'} under
              &ldquo;Assigned to me&rdquo; in the Review queue, where they log each call. Only
              people with access to {project.name} can be assigned.
            </p>
            {assignees.length === 0 ? (
              <Alert>No one has access to this project yet. Assign it in Workspace settings.</Alert>
            ) : (
              <div className="assignment-list">
                {assignees.map((person) => (
                  <button
                    key={person.id}
                    className="assignee-option"
                    disabled={!!busy}
                    onClick={() => void assignLeads(assigning, person.id)}
                  >
                    <span className="assignee-avatar">{person.name[0]}</span>
                    <span>
                      <strong>{person.name}</strong>
                      <small>
                        @{person.username} ·{' '}
                        {person.role === 'admin' ? 'Administrator' : 'Researcher'}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="form-actions">
              <button className="button secondary" onClick={() => setAssigning(null)}>
                Cancel
              </button>
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => void assignLeads(assigning, null)}
              >
                Clear assignment
              </button>
            </div>
          </div>
        </Modal>
      )}
      {confirmDelete && (
        <Modal title="Delete leads" onClose={() => setConfirmDelete(null)}>
          {/* .form-stack carries the modal's padding — a bare child sits flush to the edge. */}
          <div className="form-stack">
            <p>
              Deleting {confirmDelete.length} lead{confirmDelete.length === 1 ? '' : 's'} also
              removes their qualification runs, human reviews and training feedback. Published
              training versions are unaffected. This cannot be undone.
            </p>
            <div className="form-actions">
              <button className="button secondary" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="button danger"
                disabled={!!busy}
                onClick={() => void deleteLeads(confirmDelete)}
              >
                {busy ? (
                  <Spinner text="Deleting…" />
                ) : (
                  <>
                    <Trash2 size={15} />
                    Delete {confirmDelete.length} lead{confirmDelete.length === 1 ? '' : 's'}
                  </>
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}
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
            City
            <input name="city" defaultValue={lead?.city} maxLength={120} />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Industry
            <input name="industry" defaultValue={lead?.industry} maxLength={200} />
          </label>
          <label>
            Employees
            <input
              name="employee_count"
              defaultValue={lead?.employee_count}
              maxLength={60}
              placeholder="e.g. 150 or 50–200"
            />
          </label>
        </div>
        <fieldset className="form-fieldset">
          <legend>Contact person</legend>
          <div className="form-grid">
            <label>
              Name
              <input name="contact_name" defaultValue={lead?.contact_name} maxLength={200} />
            </label>
            <label>
              Job title
              <input name="contact_role" defaultValue={lead?.contact_role} maxLength={200} />
            </label>
          </div>
          <div className="form-grid">
            <label>
              Email
              <input
                name="contact_email"
                type="email"
                defaultValue={lead?.contact_email}
                maxLength={200}
              />
            </label>
            <label>
              Phone
              <input name="contact_phone" defaultValue={lead?.contact_phone} maxLength={40} />
            </label>
          </div>
          <small>
            Research fills these in from the company website when it publishes them. Anything you
            enter here is kept as-is.
          </small>
        </fieldset>
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
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'update'>('skip');
  const [result, setResult] = useState<{
    created: number;
    updated: number;
    skipped: number;
    duplicates: string[];
    invalid: number;
    problems: Array<{ row: number; name: string; reason: string }>;
    warned: number;
    warnings: Array<{ row: number; name: string; reason: string }>;
  } | null>(null);
  return (
    <Modal title="Import research leads" onClose={onClose}>
      <div className="form-stack">
        <p className="muted">
          Import up to 5,000 leads from CSV, TSV, plain text, JSON or Excel (.xlsx). A lead already
          in this project is matched on company name or website domain.
        </p>
        <div className="csv-example">
          <strong>CSV column headers</strong>
          <code>
            name,website,country,city,industry,employee_count,contact_name,contact_role,contact_email,contact_phone,notes
          </code>
          <small>
            Only the company name is required. Common export headings are recognised too — Company
            Name, Company Website, Company Size, Full Name, Job Title, Emails, Phone Numbers,
            Locality. A row with no company name is reported and skipped, because a lead is a
            company.
          </small>
        </div>
        <a className="text-button" href="/branding/leads-template.csv" download>
          <Download size={15} />
          Download CSV template
        </a>
        <label className="upload-zone">
          <Upload size={27} />
          <strong>{file?.name || 'Choose a CSV file'}</strong>
          <small>CSV · TSV · TXT · JSON · XLSX — up to 4 MB, 5,000 rows</small>
          <input
            type="file"
            accept=".csv,.tsv,.txt,.json,.xlsx,text/csv,application/json"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setResult(null);
            }}
          />
        </label>
        <label>
          When a lead is already in this project
          <select
            value={onDuplicate}
            disabled={busy}
            onChange={(e) => setOnDuplicate(e.target.value as 'skip' | 'update')}
          >
            <option value="skip">Skip it and keep what is already there</option>
            <option value="update">Update it with the details in this file</option>
          </select>
          <small>
            Updating fills blank fields and refreshes changed ones, then marks the lead for
            requalification. It never blanks a value the CSV leaves empty.
          </small>
        </label>
        {error && <Alert>{error}</Alert>}
        {result && (
          <div className="import-result">
            <CheckCircle2 size={19} />
            <strong>
              {result.created} created · {result.updated} updated · {result.skipped} unchanged
              {result.invalid > 0 ? ' · ' + result.invalid + ' skipped' : ''}
            </strong>
            {result.warned > 0 && (
              <details>
                <summary>{result.warned} imported without a usable website</summary>
                <ul>
                  {result.warnings.map((warning, i) => (
                    <li key={i}>
                      <strong>Row {warning.row}</strong>
                      {warning.name ? ' · ' + warning.name : ''} — {warning.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {result.invalid > 0 && (
              <details>
                <summary>
                  {result.invalid} row{result.invalid === 1 ? '' : 's'} could not be imported
                </summary>
                <ul>
                  {result.problems.map((problem, i) => (
                    <li key={i}>
                      <strong>Row {problem.row}</strong>
                      {problem.name === '(no company)' ? '' : ' · ' + problem.name} —{' '}
                      {problem.reason}
                    </li>
                  ))}
                  {result.invalid > result.problems.length && (
                    <li>…and {result.invalid - result.problems.length} more.</li>
                  )}
                </ul>
              </details>
            )}
            {result.duplicates.length > 0 && (
              <details>
                <summary>Companies left unchanged</summary>
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
                data.set('on_duplicate', onDuplicate);
                const result = await api<{
                  created: number;
                  updated: number;
                  skipped: number;
                  duplicates: string[];
                  invalid: number;
                  problems: Array<{ row: number; name: string; reason: string }>;
                  warned: number;
                  warnings: Array<{ row: number; name: string; reason: string }>;
                }>('/projects/' + projectId + '/leads/import', {
                  method: 'POST',
                  body: data,
                });
                setResult(result);
                onImported(
                  result.created +
                    ' created, ' +
                    result.updated +
                    ' updated, ' +
                    result.skipped +
                    ' unchanged' +
                    (result.invalid ? ', ' + result.invalid + ' skipped' : '') +
                    '.',
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
  const [tab, setTab] = useState<
    'reasoning' | 'evidence' | 'history' | 'feedback' | 'calls' | 'email'
  >('reasoning');
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
                  <span>
                    {[lead.city, lead.country].filter(Boolean).join(', ') || 'Location unknown'}
                  </span>
                  <span>{lead.industry || 'Industry unknown'}</span>
                  {lead.employee_count && <span>{lead.employee_count} employees</span>}
                </div>
                {(lead.contact_name || lead.contact_phone || lead.contact_email) && (
                  <div className="detail-meta detail-contact">
                    {lead.contact_name && (
                      <span>
                        <Users size={13} />
                        {lead.contact_name}
                        {lead.contact_role ? ' · ' + lead.contact_role : ''}
                      </span>
                    )}
                    {lead.contact_phone && (
                      <a href={'tel:' + lead.contact_phone.replace(/[^+\d]/g, '')}>
                        <Phone size={13} />
                        {lead.contact_phone}
                      </a>
                    )}
                    {lead.contact_email && (
                      <a href={'mailto:' + lead.contact_email}>
                        <Mail size={13} />
                        {lead.contact_email}
                      </a>
                    )}
                  </div>
                )}
                <div className="detail-badges">
                  <Badge value={lead.stale ? 'stale' : lead.status}>
                    {lead.stale ? 'Requalification needed' : label(lead.status)}
                  </Badge>
                  {lead.reviewed && <Badge value="ready">Human reviewed</Badge>}
                  {lead.assigned_to_name && (
                    <Badge value="ready">Calling: {lead.assigned_to_name}</Badge>
                  )}
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
            <>
              <div className="result-tabs" role="tablist" aria-label="Lead details">
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
                    {
                      id: 'calls',
                      title: 'Calls',
                      icon: PhoneCall,
                    },
                    {
                      id: 'email',
                      title: 'Email',
                      icon: Mail,
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
              {tab === 'reasoning' && !run && (
                <Empty icon={<ScanLine size={28} />} title="Ready for a closer look">
                  {ready
                    ? 'Run qualification to see the fit score, evidence, rule-by-rule assessment and research gaps.'
                    : 'Publish project training, then return to qualify this lead.'}
                </Empty>
              )}
              {tab === 'reasoning' && run && (
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
              {tab === 'evidence' && !run && (
                <Empty icon={<ScanLine size={28} />} title="Ready for a closer look">
                  {ready
                    ? 'Run qualification to see the fit score, evidence, rule-by-rule assessment and research gaps.'
                    : 'Publish project training, then return to qualify this lead.'}
                </Empty>
              )}
              {tab === 'evidence' && run && (
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
              {tab === 'history' && !run && (
                <Empty icon={<ScanLine size={28} />} title="Ready for a closer look">
                  {ready
                    ? 'Run qualification to see the fit score, evidence, rule-by-rule assessment and research gaps.'
                    : 'Publish project training, then return to qualify this lead.'}
                </Empty>
              )}
              {tab === 'history' && run && (
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
              {tab === 'email' && (
                <div className="feedback-tab">
                  <EmailComposer
                    base={base}
                    lead={lead}
                    onSent={() => {
                      setRefresh((n) => n + 1);
                      onChange();
                      notify('Email sent and logged against this lead.');
                    }}
                  />
                  <h3>Email history</h3>
                  {(lead.emails || []).length ? (
                    (lead.emails || []).map((message) => (
                      <div className="human-review-history" key={message.id}>
                        <div>
                          <Badge value={message.status === 'SENT' ? 'QUALIFIED' : 'NEEDS_REVIEW'}>
                            {message.status === 'SENT' ? 'Sent' : 'Not delivered'}
                          </Badge>
                          <small>
                            {message.to_email} · {message.created_by} · {date(message.created_at)}
                          </small>
                        </div>
                        <p>
                          <strong>{message.subject}</strong>
                        </p>
                        <p className="preserve-text">{message.body}</p>
                      </div>
                    ))
                  ) : (
                    <p className="muted">No emails sent to this lead yet.</p>
                  )}
                </div>
              )}
              {tab === 'calls' && (
                <CallsTab
                  base={base}
                  lead={lead}
                  calls={lead.calls || []}
                  onSaved={() => {
                    setRefresh((n) => n + 1);
                    onChange();
                    notify('Call logged.');
                  }}
                />
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

/** Status filters shared by the table dropdown and the export menu. */
function statusFilters(queue: boolean) {
  return [
    { value: 'ALL', label: 'All leads' },
    ...(queue ? [{ value: 'REVIEW_QUEUE', label: 'All awaiting research' }] : []),
    { value: 'UNREVIEWED', label: 'Unreviewed' },
    { value: 'QUALIFIED', label: 'Qualified' },
    { value: 'CALL_READY', label: 'Call ready (' + nextStepBands.call + '–100)' },
    {
      value: 'SEND_EMAIL',
      label: 'Send an email (' + nextStepBands.email + '–' + (nextStepBands.call - 1) + ')',
    },
    {
      value: 'REVIEW_WITH_CLIENT',
      label:
        'Review with the client (' + nextStepBands.review + '–' + (nextStepBands.email - 1) + ')',
    },
    { value: 'ASSIGNED_TO_ME', label: 'Assigned to me' },
    { value: 'ASSIGNED', label: 'Assigned for calling (anyone)' },
    { value: 'UNASSIGNED', label: 'Qualified, not yet assigned' },
    { value: 'NEEDS_REVIEW', label: 'Needs review' },
    { value: 'NOT_A_TARGET', label: 'Not a target' },
    { value: 'STALE', label: 'Training or lead changed' },
  ];
}

const callOutcomes: Array<{ value: CallOutcome; label: string }> = [
  { value: 'CONNECTED', label: 'Connected' },
  { value: 'NO_ANSWER', label: 'No answer' },
  { value: 'CALLBACK', label: 'Call back later' },
  { value: 'MEETING_BOOKED', label: 'Meeting booked' },
  { value: 'NOT_INTERESTED', label: 'Not interested' },
  { value: 'WRONG_CONTACT', label: 'Wrong contact' },
];
/**
 * Call log for an assigned lead. Logging a call records what happened; it never
 * changes the qualification, the fit score or the decision.
 */
function CallsTab({
  base,
  lead,
  calls,
  onSaved,
}: {
  base: string;
  lead: Lead;
  calls: CallLog[];
  onSaved: () => void;
}) {
  const [outcome, setOutcome] = useState<CallOutcome>('CONNECTED');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="feedback-tab">
      <div className="call-contact">
        <div>
          <span className="eyebrow">WHO TO CALL</span>
          <strong>{lead.contact_name || 'No contact person recorded'}</strong>
          {lead.contact_role && <small>{lead.contact_role}</small>}
        </div>
        <div className="call-contact-channels">
          {lead.contact_phone ? (
            <a href={'tel:' + lead.contact_phone.replace(/[^+d]/g, '')}>
              <Phone size={14} />
              {lead.contact_phone}
            </a>
          ) : (
            <span className="muted">No phone number</span>
          )}
          {lead.contact_email ? (
            <a href={'mailto:' + lead.contact_email}>
              <Mail size={14} />
              {lead.contact_email}
            </a>
          ) : (
            <span className="muted">No email address</span>
          )}
        </div>
      </div>
      <p className="muted">
        {lead.assigned_to_name
          ? 'Assigned to ' + lead.assigned_to_name + '.'
          : 'This lead is not assigned to anyone yet.'}{' '}
        Logging a call records what happened; it never changes the qualification or the decision.
      </p>
      {error && <Alert>{error}</Alert>}
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api(base + '/calls', { method: 'POST', body: json({ outcome, notes }) });
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
          How did the call go?
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as CallOutcome)}>
            {callOutcomes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Call notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            minLength={5}
            maxLength={4000}
            required
            placeholder="Who you spoke to, what they said, and what happens next."
          />
        </label>
        <div className="form-actions">
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner text="Saving…" /> : 'Log this call'}
          </button>
        </div>
      </form>
      <h3>Call history</h3>
      {calls.length ? (
        calls.map((call) => (
          <div className="human-review-history" key={call.id}>
            <div>
              <span className={'next-step call-' + call.outcome.toLowerCase()}>
                {callOutcomes.find((o) => o.value === call.outcome)?.label || call.outcome}
              </span>
              <small>
                {call.created_by} · {date(call.created_at)}
              </small>
            </div>
            <p>{call.notes}</p>
          </div>
        ))
      ) : (
        <p className="muted">No calls logged yet.</p>
      )}
    </div>
  );
}

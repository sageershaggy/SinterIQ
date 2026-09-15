import { useEffect, useState } from 'react';
import { Plus, Pause, Play, Mail, ArrowLeft, Trash2, Users, GitBranch } from 'lucide-react';
import type { Lead, Project, User, EmailTemplate } from '../shared/types';
import type { Enrollment, Funnel, FunnelStep, OutreachOutcome } from '../shared/funnels';
import { api, json, label, date } from './api';
import { Alert, Badge, Empty, Modal, Spinner } from './ui';

const starterSteps: FunnelStep[] = [
  {
    delay_days: 0,
    subject: 'A question for {{company}}',
    body: 'Hello,\n\nI wanted to ask whether our services could be useful to {{company}}. Would a short introduction be helpful?\n\nBest regards,\n{{sender_name}}',
  },
  {
    delay_days: 3,
    subject: 'Following up with {{company}}',
    body: 'Hello,\n\nFollowing up on my introduction. Is there a relevant requirement at {{company}} that we could discuss?\n\nBest regards,\n{{sender_name}}',
  },
  {
    delay_days: 7,
    subject: 'Closing the loop',
    body: 'Hello,\n\nThis is my final follow-up. If a conversation would be useful, please reply whenever it suits you. Otherwise, I will leave it here.\n\nBest regards,\n{{sender_name}}',
  },
];

export default function Funnels({
  project,
  user,
  notify,
  onSettings,
}: {
  project: Project;
  user: User;
  notify: (message: string) => void;
  onSettings: () => void;
}) {
  const base = '/projects/' + project.id + '/funnels';
  const [items, setItems] = useState<Funnel[]>([]),
    [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<Funnel | 'new' | null>(null),
    [enrolling, setEnrolling] = useState(false);
  const [ready, setReady] = useState(false),
    [starting, setStarting] = useState(false),
    [busy, setBusy] = useState(false);
  const active = items.find((item) => item.id === selected);
  const reload = () => setRefresh((n) => n + 1);
  useEffect(() => {
    let cancelled = false;
    api<{ funnels: Funnel[]; delivery_ready: boolean }>(base)
      .then((result) => {
        if (!cancelled) {
          setItems(result.funnels);
          setReady(result.delivery_ready);
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
  }, [base, refresh]);
  async function changeStatus(status: 'ACTIVE' | 'PAUSED') {
    if (!active) return;
    setBusy(true);
    setError('');
    try {
      await api(base + '/' + active.id, {
        method: 'PATCH',
        body: json({ status, revision: active.revision }),
      });
      setStarting(false);
      reload();
      notify(
        status === 'ACTIVE'
          ? 'Funnel started. Due messages will enter the delivery queue.'
          : 'Funnel paused.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">OUTREACH WITH A PLAN</span>
          <h1>
            Email funnels<span className="heading-dot">.</span>
          </h1>
          <p>Choose an audience, review the sequence, and follow every response.</p>
        </div>
        {user.role === 'admin' && (
          <button className="button primary" onClick={() => setEditing('new')}>
            <Plus size={16} />
            New funnel
          </button>
        )}
      </div>
      {!ready && (
        <div className="funnel-setup">
          <Mail size={20} />
          <div>
            <strong>Delivery setup needed</strong>
            <p>
              Starting a funnel requires a workspace mailbox, a copy address and a public HTTPS app
              address. You can prepare sequences and queues now.
            </p>
          </div>
          {user.role === 'admin' && (
            <button className="button secondary" onClick={onSettings}>
              Mailbox settings
            </button>
          )}
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {loading ? (
        <Spinner text="Loading funnels…" />
      ) : !active ? (
        <>
          <div className="funnel-policy">
            <span>Up to 3 emails per recipient</span>
            <span>Delays in days or weeks</span>
            <span>Stops on recorded response or opt-out</span>
          </div>
          {items.length ? (
            <div className="funnel-grid">
              {items.map((item) => (
                <button className="funnel-card" key={item.id} onClick={() => setSelected(item.id)}>
                  <div className="funnel-card-top">
                    <GitBranch size={21} />
                    <Badge value={item.status}>{label(item.status)}</Badge>
                  </div>
                  <h2>{item.name}</h2>
                  <p>{item.audience || 'All relevant qualified leads'}</p>
                  <div className="funnel-metrics">
                    <span>
                      <strong>{item.steps.length}</strong>messages
                    </span>
                    <span>
                      <strong>{item.queued_count}</strong>in queue
                    </span>
                    <span>
                      <strong>{item.converted_count}</strong>converted
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              icon={<GitBranch size={30} />}
              title="Build your first email sequence"
              action={
                user.role === 'admin' && (
                  <button className="button primary" onClick={() => setEditing('new')}>
                    Create funnel
                  </button>
                )
              }
            >
              Keep different audiences in their own funnels. Enrollment and delivery remain visible
              at every step.
            </Empty>
          )}
        </>
      ) : (
        <>
          <button className="text-button" onClick={() => setSelected(null)}>
            <ArrowLeft size={15} /> All funnels
          </button>
          <div className="funnel-detail-heading">
            <div>
              <h2>{active.name}</h2>
              <p>{active.audience}</p>
            </div>
            <Badge value={active.status} />
            <button className="button secondary" onClick={() => setEnrolling(true)}>
              <Users size={15} />
              Add qualified leads
            </button>
            {user.role === 'admin' && (
              <>
                {active.enrolled_count === 0 && active.status !== 'ACTIVE' && (
                  <button className="button secondary" onClick={() => setEditing(active)}>
                    Edit sequence
                  </button>
                )}
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    active.status === 'ACTIVE' ? void changeStatus('PAUSED') : setStarting(true)
                  }
                >
                  {active.status === 'ACTIVE' ? <Pause size={15} /> : <Play size={15} />}
                  {active.status === 'ACTIVE' ? 'Pause funnel' : 'Review & start'}
                </button>
              </>
            )}
          </div>
          <div className="funnel-sequence">
            {active.steps.map((step, i) => (
              <details key={i} className="funnel-step">
                <summary>
                  <span className="funnel-number">{i + 1}</span>
                  <span>
                    <strong>{step.subject}</strong>
                    <small>
                      {i === 0
                        ? step.delay_days
                          ? step.delay_days + ' days after enrollment'
                          : 'When started'
                        : step.delay_days + ' days after the previous email'}
                    </small>
                  </span>
                </summary>
                <p className="preserve-text">{step.body}</p>
              </details>
            ))}
          </div>
          <FunnelQueue
            key={active.id}
            projectId={project.id}
            funnel={active}
            refresh={refresh}
            onChange={reload}
          />
        </>
      )}
      {editing && (
        <FunnelEditor
          base={base}
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(f) => {
            setEditing(null);
            setSelected(f.id);
            reload();
            notify('Funnel saved as a draft.');
          }}
        />
      )}
      {enrolling && active && (
        <EnrollmentPicker
          projectId={project.id}
          funnel={active}
          onClose={() => setEnrolling(false)}
          onSaved={(message) => {
            setEnrolling(false);
            reload();
            notify(message);
          }}
        />
      )}
      {starting && active && (
        <Modal title="Start this email sequence?" onClose={() => !busy && setStarting(false)}>
          <div className="form-stack">
            <p>
              <strong>{active.name}</strong> has {active.queued_count} queued leads and{' '}
              {active.steps.length} messages. Starting enables scheduled delivery, at most one due
              message per minute.
            </p>
            <p>
              Messages include the workspace sender, a copy to the configured address and an
              unsubscribe link. Record replies from your mailbox here to stop follow-ups; link
              opt-outs stop them automatically. Messages already handed to the mailbox cannot be
              recalled.
            </p>
            {error && <Alert>{error}</Alert>}
            {!ready && (
              <Alert>
                Finish the mailbox, copy address and public HTTPS origin setup before starting.
              </Alert>
            )}
            <div className="form-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setStarting(false)}
              >
                Keep paused
              </button>
              <button
                className="button primary"
                disabled={busy || !ready}
                onClick={() => void changeStatus('ACTIVE')}
              >
                {busy ? <Spinner /> : 'Start scheduled delivery'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function FunnelEditor({
  base,
  initial,
  onClose,
  onSaved,
}: {
  base: string;
  initial?: Funnel;
  onClose: () => void;
  onSaved: (f: Funnel) => void;
}) {
  const [name, setName] = useState(initial?.name || ''),
    [audience, setAudience] = useState(initial?.audience || '');
  const [steps, setSteps] = useState<FunnelStep[]>(
    initial?.steps || starterSteps.map((step) => ({ ...step })),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  useEffect(() => {
    let cancelled = false;
    api<{ templates: EmailTemplate[] }>(base.replace(/\/funnels$/, '') + '/email/templates')
      .then((result) => {
        if (!cancelled) setTemplates(result.templates);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);
  const update = (i: number, value: Partial<FunnelStep>) =>
    setSteps((list) => list.map((s, index) => (index === i ? { ...s, ...value } : s)));
  return (
    <Modal
      title={initial ? 'Edit funnel' : 'New email funnel'}
      wide
      onClose={() => !busy && onClose()}
    >
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            onSaved(
              await api<Funnel>(base + (initial ? '/' + initial.id : ''), {
                method: initial ? 'PUT' : 'POST',
                body: json({
                  name,
                  audience,
                  steps,
                  ...(initial ? { revision: initial.revision } : {}),
                }),
              }),
            );
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <label>
            Funnel name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              placeholder="UAE engineering introduction"
            />
          </label>
          <label>
            Audience or occasion
            <input
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              maxLength={500}
              placeholder="Industry, role, region or event"
            />
          </label>
        </div>
        <p className="muted">
          Edit the starter messages for this audience. Merge fields:{' '}
          {
            '{{company}}, {{contact_name}}, {{contact_first_name}}, {{contact_role}}, {{city}}, {{country}}, {{industry}}, {{sender_name}}'
          }
          . Missing fields block enrollment.
        </p>
        {steps.map((step, i) => (
          <fieldset className="form-fieldset" key={i}>
            <legend>Message {i + 1}</legend>
            <label>
              Use template text
              <select
                value=""
                onChange={(e) => {
                  const template = templates.find((item) => item.id === e.target.value);
                  if (!template) return;
                  const body = template.blocks
                    .map((block) => {
                      if ('text' in block) return block.text;
                      if (block.type === 'button') return block.label + ': ' + block.url;
                      if (block.type === 'image') return block.alt + ': ' + block.url;
                      return '';
                    })
                    .filter(Boolean)
                    .join('\n\n');
                  update(i, { subject: template.subject, body });
                }}
              >
                <option value="">Choose a saved or starter template…</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
              <small>
                Copies the text and links into this campaign message. Review it before saving.
              </small>
            </label>
            <div className="funnel-editor-heading">
              <label>
                {i === 0 ? 'Days after enrollment' : 'Days after the previous email'}
                <input
                  type="number"
                  min={i ? 1 : 0}
                  max={90}
                  required
                  value={step.delay_days}
                  onChange={(e) => update(i, { delay_days: Number(e.target.value) })}
                />
              </label>
              {steps.length > 1 && (
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={'Remove message ' + (i + 1)}
                  onClick={() => setSteps((list) => list.filter((_, n) => n !== i))}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <label>
              Subject
              <input
                value={step.subject}
                required
                maxLength={200}
                onChange={(e) => update(i, { subject: e.target.value })}
              />
            </label>
            <label>
              Message
              <textarea
                rows={7}
                value={step.body}
                required
                minLength={20}
                maxLength={10000}
                onChange={(e) => update(i, { body: e.target.value })}
              />
            </label>
          </fieldset>
        ))}
        {steps.length < 3 && (
          <button
            type="button"
            className="button secondary"
            onClick={() => setSteps((list) => [...list, { ...starterSteps[list.length] }])}
          >
            <Plus size={15} />
            Add follow-up
          </button>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="form-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : 'Save draft'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function EnrollmentPicker({
  projectId,
  funnel: preset,
  leadIds,
  onClose,
  onSaved,
}: {
  projectId: number;
  funnel?: Funnel;
  leadIds?: number[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const base = '/projects/' + projectId;
  const [funnels, setFunnels] = useState<Funnel[]>(preset ? [preset] : []),
    [funnelId, setFunnelId] = useState(preset?.id || 0);
  const [leads, setLeads] = useState<Lead[]>([]),
    [chosen, setChosen] = useState<number[]>(leadIds || []),
    [search, setSearch] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{ to: string; subject: string; body: string } | null>(
    null,
  );
  const active = funnels.find((f) => f.id === funnelId);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      Promise.all([
        api<{ funnels: Funnel[] }>(base + '/funnels'),
        leadIds
          ? Promise.resolve({ leads: [] })
          : api<{ leads: Lead[] }>(
              base + '/leads?status=QUALIFIED&page_size=50&search=' + encodeURIComponent(search),
            ),
      ])
        .then(([fs, ls]) => {
          if (!cancelled) {
            setFunnels(fs.funnels);
            setLeads(ls.leads);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [base, search, leadIds]);
  return (
    <Modal title="Add qualified leads to a funnel" onClose={() => !busy && onClose()} wide>
      <div className="form-stack">
        {error && <Alert>{error}</Alert>}
        <label>
          Funnel
          <select
            value={funnelId}
            onChange={(e) => {
              setFunnelId(Number(e.target.value));
              setPreview(null);
            }}
          >
            <option value={0}>Choose a funnel</option>
            {funnels.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} · {label(f.status)}
              </option>
            ))}
          </select>
        </label>
        {!loading && !funnels.length && <p>Create a funnel in the Email funnels section first.</p>}
        {!leadIds && (
          <>
            <label>
              Find qualified leads
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search company, industry or location"
              />
            </label>
            {loading ? (
              <Spinner />
            ) : (
              <div className="funnel-candidates">
                {leads.length ? (
                  leads.map((lead) => (
                    <label className="checkbox-label" key={lead.id}>
                      <input
                        type="checkbox"
                        checked={chosen.includes(lead.id)}
                        disabled={
                          lead.stale ||
                          !lead.contact_email ||
                          (chosen.length >= 100 && !chosen.includes(lead.id))
                        }
                        onChange={(e) => {
                          setPreview(null);
                          setChosen((list) =>
                            e.target.checked
                              ? [...list, lead.id]
                              : list.filter((id) => id !== lead.id),
                          );
                        }}
                      />
                      <span>
                        <strong>{lead.name}</strong>
                        <small>
                          {lead.stale
                            ? 'Needs requalification'
                            : lead.contact_email || 'Add a contact email first'}
                        </small>
                      </span>
                    </label>
                  ))
                ) : (
                  <p>No qualified leads match. Qualify leads in Lead research first.</p>
                )}
              </div>
            )}
            <small>Showing up to 50 matches. Refine the search to find more leads.</small>
          </>
        )}
        <p>
          {chosen.length} selected. Each needs a current qualification and email address. Existing
          enrollments are skipped. If a lead has conflicting or missing data, no new enrollments are
          saved.
        </p>
        {active?.status === 'ACTIVE' && (
          <Alert>
            This funnel is active. Enrolled leads become eligible for delivery at their scheduled
            time.
          </Alert>
        )}
        {preview && (
          <div className="funnel-preview">
            <small>To: {preview.to}</small>
            <strong>{preview.subject}</strong>
            <p className="preserve-text">{preview.body}</p>
            <small>
              The sender signature, copy recipient and unsubscribe footer are added at delivery.
            </small>
          </div>
        )}
        <div className="form-actions">
          <button className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="button secondary"
            disabled={busy || !active || !chosen.length}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                setPreview(
                  await api(base + '/funnels/' + funnelId + '/preview', {
                    method: 'POST',
                    body: json({ lead_id: chosen[0], step: 0 }),
                  }),
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Preview first email
          </button>
          <button
            className="button primary"
            disabled={busy || !active || !chosen.length}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const result = await api<{ enrolled: number; skipped: number }>(
                  base + '/funnels/' + funnelId + '/enrollments',
                  { method: 'POST', body: json({ lead_ids: chosen }) },
                );
                onSaved(
                  result.enrolled + ' enrolled; ' + result.skipped + ' already in this funnel.',
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : 'Confirm enrollment'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FunnelQueue({
  projectId,
  funnel,
  refresh,
  onChange,
}: {
  projectId: number;
  funnel: Funnel;
  refresh: number;
  onChange: () => void;
}) {
  const [rows, setRows] = useState<Enrollment[]>([]),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [error, setError] = useState('');
  const [outcomeFor, setOutcomeFor] = useState<Enrollment | null>(null),
    [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    api<{ enrollments: Enrollment[]; total: number }>(
      '/projects/' + projectId + '/funnels/' + funnel.id + '/enrollments?page=' + page,
    )
      .then((data) => {
        if (!cancelled) {
          setRows(data.enrollments);
          setTotal(data.total);
          setError('');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, funnel.id, refresh, tick, page]);
  return (
    <section className="panel funnel-queue">
      <div className="section-title">
        <h2>
          Delivery queue <span>{total}</span>
        </h2>
        <button className="text-button" onClick={onChange}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Replies arrive in the workspace mailbox. Record a reply, conversion or stop below to cancel
        further follow-ups. The qualification decision stays unchanged.
      </p>
      {error && <Alert>{error}</Alert>}
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Lead</th>
                <th>Progress</th>
                <th>Next delivery</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.lead_name}</strong>
                    <small className="table-subtext">{row.recipient}</small>
                  </td>
                  <td>
                    <Badge value={row.status} />
                    <small className="table-subtext">
                      {row.next_step} / {funnel.steps.length} sent
                    </small>
                  </td>
                  <td>
                    {row.status === 'QUEUED' ? (
                      <>
                        {funnel.status === 'ACTIVE'
                          ? new Date(row.next_send_at).toLocaleString()
                          : 'Waiting for funnel to start'}
                      </>
                    ) : (
                      row.reason || '—'
                    )}
                  </td>
                  <td>
                    <button className="button secondary small" onClick={() => setOutcomeFor(row)}>
                      Record response / stop
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No leads enrolled yet.</p>
      )}
      <div className="table-footer">
        <span>{total} enrollments</span>
        <button
          className="button secondary small"
          disabled={page === 1}
          onClick={() => setPage((n) => n - 1)}
        >
          Previous
        </button>
        <span>Page {page}</span>
        <button
          className="button secondary small"
          disabled={page * 50 >= total}
          onClick={() => setPage((n) => n + 1)}
        >
          Next
        </button>
      </div>
      {outcomeFor && (
        <Modal title={'Response from ' + outcomeFor.lead_name} onClose={() => setOutcomeFor(null)}>
          <OutreachOutcomeForm
            base={'/projects/' + projectId + '/leads/' + outcomeFor.lead_id}
            onSaved={() => {
              setOutcomeFor(null);
              onChange();
            }}
          />
        </Modal>
      )}
    </section>
  );
}

export function OutreachOutcomeForm({
  base,
  lead,
  onSaved,
}: {
  base: string;
  lead?: Lead;
  onSaved: () => void;
}) {
  const [outcome, setOutcome] = useState<OutreachOutcome>('REPLIED'),
    [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="form-stack">
      <h3>Response & email preferences</h3>
      {lead && (
        <p>
          Current outcome: <strong>{label(lead.outreach_status || 'NOT_CONTACTED')}</strong>
        </p>
      )}
      <p className="muted">
        Record replies from your mailbox here to stop further funnel emails. Unsubscribe also blocks
        individual emails, even if this address is imported again.
      </p>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api(base + '/outreach-events', {
              method: 'POST',
              body: json({ outcome, notes }),
            });
            setNotes('');
            onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as OutreachOutcome)}>
            {(['REPLIED', 'INTERESTED', 'CONVERTED', 'STOPPED', 'UNSUBSCRIBED'] as const).map(
              (value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          Notes
          <textarea
            required
            minLength={5}
            maxLength={2000}
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What did the recipient say?"
          />
        </label>
        {error && <Alert>{error}</Alert>}
        <button className="button primary" disabled={busy}>
          {busy ? <Spinner /> : 'Save outcome & stop follow-ups'}
        </button>
      </form>
      {lead?.outreach_events?.map((event) => (
        <div key={event.id} className="human-review-history">
          <strong>{label(event.outcome)}</strong>
          <small>
            {event.created_by} · {date(event.created_at)}
          </small>
          <p>{event.notes}</p>
        </div>
      ))}
    </div>
  );
}

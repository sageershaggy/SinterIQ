import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Pause,
  Play,
  Mail,
  ArrowLeft,
  Trash2,
  Users,
  GitBranch,
  ChevronDown,
  Paperclip,
  X,
  Braces,
  MessageSquareReply,
} from 'lucide-react';
import type { Lead, Project, User, EmailTemplate } from '../shared/types';
import type { EmailFile } from '../shared/email';
import type {
  Enrollment,
  FitBand,
  Funnel,
  FunnelProgress,
  FunnelStep,
  OutreachOutcome,
} from '../shared/funnels';
import { fitBandLabels } from '../shared/funnels';
import { blocksToHtml, htmlToText, mergeFieldsIn, textToHtml } from '../shared/email-html';
import { api, json, label, date } from './api';
import { RichEmailEditor } from './RichEmailEditor';
import { attachmentAccept, formatSize, uploadEmailFile } from './emailFiles';
import { Alert, Badge, Empty, Modal, Spinner } from './ui';
import './Funnels.css';

const starterSteps: FunnelStep[] = [
  {
    delay_days: 0,
    send_time: '09:00',
    to: '{{contact_email}}',
    subject: 'A question for {{company}}',
    body: 'Hello,\n\nI wanted to ask whether our services could be useful to {{company}}. Would a short introduction be helpful?\n\nBest regards,\n{{sender_name}}',
  },
  {
    delay_days: 3,
    send_time: '09:00',
    to: '{{contact_email}}',
    subject: 'Following up with {{company}}',
    body: 'Hello,\n\nFollowing up on my introduction. Is there a relevant requirement at {{company}} that we could discuss?\n\nBest regards,\n{{sender_name}}',
  },
  {
    delay_days: 7,
    send_time: '09:00',
    to: '{{contact_email}}',
    subject: 'Closing the loop',
    body: 'Hello,\n\nThis is my final follow-up. If a conversation would be useful, please reply whenever it suits you. Otherwise, I will leave it here.\n\nBest regards,\n{{sender_name}}',
  },
];

function localDateOffset(days: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function daysFromLocalDate(value: string, minDays: number): number {
  if (!value) return minDays;
  const picked = new Date(value + 'T12:00:00');
  if (Number.isNaN(picked.getTime())) return minDays;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((picked.getTime() - today.getTime()) / 86_400_000);
  return Math.min(90, Math.max(minDays, diff));
}

/** Prefer the sequence templates (2nd, 3rd, last email) near the top of the template menu. */
function funnelTemplateOrder(a: EmailTemplate, b: EmailTemplate): number {
  const rank = (template: EmailTemplate) =>
    template.custom
      ? 0
      : template.id.startsWith('follow-up-')
        ? Number(template.id.slice('follow-up-'.length))
        : 100 + template.id.length;
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}
/** A step's body as the rich-text editor shows it, however it was first written. */
const stepHtml = (step: FunnelStep) =>
  step.html || (step.blocks?.length ? blocksToHtml(step.blocks) : textToHtml(step.body));
/** The lead data a funnel relies on: every merge field its messages and recipients use. */
const funnelFields = (funnel: Pick<Funnel, 'steps'>) =>
  mergeFieldsIn(
    ...funnel.steps.flatMap((step) => [
      step.to || '{{contact_email}}',
      step.subject,
      stepHtml(step),
    ]),
  );
const emptyProgress: FunnelProgress = {
  waiting: [0, 0, 0],
  replied: 0,
  bounced: 0,
  stopped: 0,
  blocked: 0,
  completed: 0,
  total: 0,
};

interface StepDraft {
  delay_days: number;
  send_time: string;
  to: string;
  subject: string;
  html: string;
  attachments: EmailFile[];
}

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
          <p>
            Each funnel shows the messages it sends, the lead data it uses and where every lead is.
          </p>
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
              Starting a funnel requires this project’s mailbox, a copy address and a public HTTPS
              app address. You can prepare sequences and queues now.
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
            <span>You set the date and time of each follow-up</span>
            <span>Stops on a reply, a bounce or an opt-out</span>
          </div>
          {items.length ? (
            <div className="funnel-list">
              {items.map((item) => (
                <button className="funnel-row" key={item.id} onClick={() => setSelected(item.id)}>
                  <FunnelSummary funnel={item} />
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
          <section className="panel funnel-overview">
            <FunnelSummary funnel={active} detailed />
          </section>
          <div className="funnel-sequence">
            {active.steps.map((step, i) => (
              <details key={i} className="funnel-step">
                <summary>
                  <span className="funnel-number">{i + 1}</span>
                  <span>
                    <strong>{step.subject}</strong>
                    <small>
                      {step.to ? 'To: ' + step.to + ' · ' : ''}
                      {i === 0
                        ? step.delay_days
                          ? step.delay_days + ' days after enrollment'
                          : 'When started'
                        : step.delay_days + ' days after the previous email'}
                      {step.send_time ? ' at ' + step.send_time : ''}
                      {step.attachment_ids?.length
                        ? ' · ' +
                          step.attachment_ids.length +
                          ' attachment' +
                          (step.attachment_ids.length === 1 ? '' : 's')
                        : ''}
                    </small>
                  </span>
                </summary>
                <p className="preserve-text">{htmlToText(stepHtml(step))}</p>
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
          projectId={project.id}
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
              Messages are sent from this project’s mailbox, with a copy to the configured address
              and an unsubscribe link.{' '}
              {active.stop_on_reply
                ? 'A reply received in this project’s mailbox stops the remaining follow-ups.'
                : 'This funnel keeps sending after a reply; record a response to stop it.'}{' '}
              A bounced address and an opt-out stop it automatically. Messages already handed to the
              mailbox cannot be recalled.
            </p>
            {error && <Alert>{error}</Alert>}
            {!ready && (
              <Alert>
                Finish this project’s mailbox, copy address and public HTTPS origin setup before
                starting.
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

/**
 * One funnel, simply: which messages it sends and when, which lead data it uses, and how its
 * leads are progressing — waiting for message 1, 2 or 3, replied, bounced, stopped or done.
 */
function FunnelSummary({ funnel, detailed = false }: { funnel: Funnel; detailed?: boolean }) {
  const progress = funnel.progress || emptyProgress;
  const fields = funnelFields(funnel);
  const stages = [
    ...funnel.steps.map((_, index) => ({
      key: 'm' + index,
      label: 'Next: message ' + (index + 1),
      value: progress.waiting[index] || 0,
      tone: 'waiting',
    })),
    { key: 'replied', label: 'Replied', value: progress.replied, tone: 'good' },
    { key: 'completed', label: 'Completed', value: progress.completed, tone: 'good' },
    { key: 'bounced', label: 'Bounced', value: progress.bounced, tone: 'bad' },
    { key: 'stopped', label: 'Stopped', value: progress.stopped, tone: 'muted' },
    ...(progress.blocked
      ? [{ key: 'blocked', label: 'Needs attention', value: progress.blocked, tone: 'bad' }]
      : []),
  ];
  return (
    <div className={'funnel-summary' + (detailed ? ' is-detailed' : '')}>
      <div className="funnel-summary-head">
        <GitBranch size={19} />
        <div>
          <strong>{funnel.name}</strong>
          <small>{funnel.audience || 'All relevant qualified leads'}</small>
        </div>
        <Badge value={funnel.status}>{label(funnel.status)}</Badge>
      </div>
      <div className="funnel-tags">
        <span>{fitBandLabels[funnel.fit_band || 'ANY']}</span>
        <span>
          <MessageSquareReply size={12} />
          {funnel.stop_on_reply ? 'Stops when the lead replies' : 'Keeps going after a reply'}
        </span>
      </div>
      <div className="funnel-summary-grid">
        <div>
          <span className="funnel-summary-label">Messages it sends</span>
          <ol className="funnel-messages">
            {funnel.steps.map((step, index) => (
              <li key={index}>
                <strong>{step.subject}</strong>
                <small>
                  {index === 0
                    ? step.delay_days
                      ? 'Day ' + step.delay_days
                      : 'First'
                    : '+' + step.delay_days + ' day' + (step.delay_days === 1 ? '' : 's')}
                  {step.send_time ? ' · ' + step.send_time : ''}
                  {step.attachment_ids?.length
                    ? ' · ' + step.attachment_ids.length + ' file(s)'
                    : ''}
                </small>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <span className="funnel-summary-label">Lead data it uses</span>
          <div className="funnel-fields">
            {fields.length ? (
              fields.map((field) => (
                <code key={field}>
                  <Braces size={11} />
                  {field}
                </code>
              ))
            ) : (
              <small className="muted">No merge fields</small>
            )}
          </div>
        </div>
      </div>
      <div className="funnel-progress" aria-label="How leads are progressing">
        <span className="funnel-summary-label">
          How leads are progressing · {progress.total} in total
        </span>
        <ol>
          {stages.map((stage) => (
            <li key={stage.key} className={'tone-' + stage.tone + (stage.value ? '' : ' is-zero')}>
              <strong>{stage.value}</strong>
              <small>{stage.label}</small>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function FunnelEditor({
  base,
  projectId,
  initial,
  onClose,
  onSaved,
}: {
  base: string;
  projectId: number;
  initial?: Funnel;
  onClose: () => void;
  onSaved: (f: Funnel) => void;
}) {
  const [name, setName] = useState(initial?.name || ''),
    [audience, setAudience] = useState(initial?.audience || '');
  const [fitBand, setFitBand] = useState<FitBand>(initial?.fit_band || 'ANY'),
    [stopOnReply, setStopOnReply] = useState(initial?.stop_on_reply ?? true);
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    (initial?.steps || starterSteps).map((step) => ({
      delay_days: step.delay_days,
      send_time: step.send_time || '09:00',
      to: step.to || '{{contact_email}}',
      subject: step.subject,
      html: stepHtml(step),
      attachments: [],
    })),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [mergeFields, setMergeFields] = useState<string[]>([]);
  const [templateMenu, setTemplateMenu] = useState<number | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const templateMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const ids = [...new Set((initial?.steps || []).flatMap((step) => step.attachment_ids || []))];
    Promise.all([
      api<{ templates: EmailTemplate[]; merge_fields: string[] }>(
        base.replace(/\/funnels$/, '') + '/email/templates',
      ),
      ids.length
        ? api<EmailFile[]>(base.replace(/\/funnels$/, '') + '/email/files?ids=' + ids.join(','))
        : Promise.resolve([] as EmailFile[]),
    ])
      .then(([result, files]) => {
        if (cancelled) return;
        setTemplates(result.templates);
        setMergeFields(result.merge_fields);
        if (files.length)
          setSteps((list) =>
            list.map((step, index) => ({
              ...step,
              attachments: (initial?.steps[index]?.attachment_ids || [])
                .map((id) => files.find((file) => file.id === id))
                .filter((file): file is EmailFile => Boolean(file)),
            })),
          );
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);
  useEffect(() => {
    if (templateMenu === null) return;
    const away = (event: MouseEvent) => {
      if (!templateMenuRef.current?.contains(event.target as Node)) setTemplateMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTemplateMenu(null);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [templateMenu]);
  const update = (i: number, value: Partial<StepDraft>) =>
    setSteps((list) => list.map((s, index) => (index === i ? { ...s, ...value } : s)));
  async function attach(i: number, files: File[]) {
    setUploading(i);
    setError('');
    try {
      for (const file of files) {
        const stored = await uploadEmailFile(projectId, file, 'attachment');
        setSteps((list) =>
          list.map((step, index) =>
            index === i ? { ...step, attachments: [...step.attachments, stored] } : step,
          ),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(null);
    }
  }
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
                  fit_band: fitBand,
                  stop_on_reply: stopOnReply,
                  steps: steps.map((step) => ({
                    delay_days: step.delay_days,
                    send_time: step.send_time?.trim() || '',
                    to: step.to?.trim() || '{{contact_email}}',
                    subject: step.subject,
                    // The plain-text alternative travels with the rich text it came from.
                    body: htmlToText(step.html).slice(0, 10000),
                    html: step.html,
                    attachment_ids: step.attachments.map((file) => file.id),
                  })),
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
        <div className="form-grid">
          <label>
            Which leads is this campaign for?
            <select value={fitBand} onChange={(e) => setFitBand(e.target.value as FitBand)}>
              {(Object.keys(fitBandLabels) as FitBand[]).map((band) => (
                <option key={band} value={band}>
                  {fitBandLabels[band]}
                </option>
              ))}
            </select>
            <small>
              When someone emails a lead, this campaign is suggested for leads in this fit-score
              band. They can still pick another.
            </small>
          </label>
          <label className="funnel-toggle">
            <span>
              <input
                type="checkbox"
                checked={stopOnReply}
                onChange={(e) => setStopOnReply(e.target.checked)}
              />
              Stop the sequence when the lead replies
            </span>
            <small>
              On: a reply received in this project’s mailbox cancels the remaining follow-ups. A
              bounce, an opt-out or a response you record always stops it.
            </small>
          </label>
        </div>
        <p className="muted">
          Write each message in the editor; it is delivered as email-safe HTML with a plain-text
          copy. Set each message’s To address (default {'{{contact_email}}'}). Missing merge fields
          block enrollment.
        </p>
        {steps.map((step, i) => (
          <fieldset className="form-fieldset" key={i}>
            <legend>
              {i === 0
                ? 'Message 1'
                : i === steps.length - 1
                  ? 'Last message'
                  : 'Message ' + (i + 1)}
            </legend>
            <label>
              To (Recipient)
              <input
                value={step.to}
                maxLength={200}
                placeholder="{{contact_email}}"
                onChange={(e) => update(i, { to: e.target.value })}
              />
              <small>
                Default is {'{{contact_email}}'}. You can use another merge field or a fixed
                address.
              </small>
            </label>
            <div
              className="funnel-template-picker"
              ref={templateMenu === i ? templateMenuRef : undefined}
            >
              <span className="field-label">Start from a template</span>
              <div className="funnel-template-trigger-wrap">
                <button
                  type="button"
                  className="button secondary funnel-template-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={templateMenu === i}
                  onClick={() => setTemplateMenu((open) => (open === i ? null : i))}
                >
                  <span>Choose a saved or starter template…</span>
                  <ChevronDown size={15} />
                </button>
                {templateMenu === i && (
                  <div className="funnel-template-menu" role="listbox">
                    {templates.length ? (
                      [...templates].sort(funnelTemplateOrder).map((template) => (
                        <button
                          key={template.id}
                          type="button"
                          role="option"
                          onClick={() => {
                            update(i, {
                              subject: template.subject,
                              html: template.html || blocksToHtml(template.blocks),
                            });
                            setTemplateMenu(null);
                          }}
                        >
                          {template.name}
                        </button>
                      ))
                    ) : (
                      <p className="muted">No templates available yet.</p>
                    )}
                  </div>
                )}
              </div>
              <small>
                Copies the template’s subject and message, images included. Review it before saving.
              </small>
            </div>
            <div className="funnel-schedule">
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
              <label>
                Send date
                <input
                  type="date"
                  value={localDateOffset(step.delay_days)}
                  min={localDateOffset(i ? 1 : 0)}
                  onChange={(e) =>
                    update(i, { delay_days: daysFromLocalDate(e.target.value, i ? 1 : 0) })
                  }
                />
              </label>
              <label>
                Send time
                <input
                  type="time"
                  value={step.send_time || '09:00'}
                  onChange={(e) => update(i, { send_time: e.target.value })}
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
            <small className="funnel-schedule-hint">
              Sequences stay relative to each enrollment. The date is a planner for “if enrolled
              today”; the time is when the message may leave on its due day. When a lead starts this
              campaign from its Email tab, the sender picks each follow-up’s date and time.
            </small>
            <label>
              Subject
              <input
                value={step.subject}
                required
                maxLength={200}
                onChange={(e) => update(i, { subject: e.target.value })}
              />
            </label>
            <RichEmailEditor
              label={'Message ' + (i + 1)}
              value={step.html}
              onChange={(html) => update(i, { html })}
              projectId={projectId}
              mergeFields={mergeFields}
              onError={setError}
            />
            <div className="funnel-attachments">
              <label className="button secondary small funnel-attach">
                <Paperclip size={14} />
                {uploading === i ? 'Uploading…' : 'Attach files'}
                <input
                  type="file"
                  multiple
                  hidden
                  accept={attachmentAccept}
                  disabled={uploading !== null}
                  onChange={(e) => {
                    const files = [...(e.target.files || [])];
                    e.target.value = '';
                    void attach(i, files);
                  }}
                />
              </label>
              {step.attachments.map((file) => (
                <span key={file.id} className="funnel-file">
                  <Paperclip size={12} />
                  {file.filename}
                  <small>{formatSize(file.size)}</small>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={'Remove ' + file.filename}
                    onClick={() =>
                      update(i, {
                        attachments: step.attachments.filter((item) => item.id !== file.id),
                      })
                    }
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          </fieldset>
        ))}
        {steps.length < 3 && (
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              setSteps((list) => {
                const starter = starterSteps[list.length];
                return [
                  ...list,
                  {
                    delay_days: starter.delay_days,
                    send_time: starter.send_time || '09:00',
                    to: starter.to || '{{contact_email}}',
                    subject: starter.subject,
                    html: stepHtml(starter),
                    attachments: [],
                  },
                ];
              })
            }
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
          <button className="button primary" disabled={busy || uploading !== null}>
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
  const [preview, setPreview] = useState<{
    to: string;
    subject: string;
    body: string;
    /** The rendered email for a designed message; empty for a plain-text one. */
    html: string;
  } | null>(null);
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
            {preview.html ? (
              <div className="preview-frame desktop">
                {/* Sandboxed with no allow-scripts: the rendered email displays, it never executes. */}
                <iframe title="Message preview" sandbox="" srcDoc={preview.html} />
              </div>
            ) : (
              <p className="preserve-text">{preview.body}</p>
            )}
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
        Replies arrive in this project’s mailbox. Record a reply, conversion or stop below to cancel
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
                    {row.stop_cause === 'BOUNCED' ? (
                      <Badge value="blocked">Bounced</Badge>
                    ) : (
                      <Badge value={row.status} />
                    )}
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
        Record replies from this project’s mailbox here to stop further funnel emails. Unsubscribe
        also blocks individual emails, even if this address is imported again.
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

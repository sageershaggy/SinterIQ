import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  ChevronDown,
  CircleCheck,
  GitBranch,
  LayoutTemplate,
  Mail,
  Monitor,
  Paperclip,
  RotateCcw,
  Smartphone,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { EmailTemplate, Lead } from '../shared/types';
import type {
  BounceNotice,
  CampaignOption,
  CampaignSuggestion,
  EmailDraftDocument,
  EmailFile,
} from '../shared/email';
import { api, date, json, label } from './api';
import { Alert, Modal, Spinner } from './ui';
import { RichEmailEditor } from './RichEmailEditor';
import { CampaignPicker } from './CampaignPicker';
import {
  attachmentAccept,
  emailFileLimits,
  fileUrl,
  formatSize,
  uploadEmailFile,
} from './emailFiles';
import './EmailComposer.css';

interface Offer {
  subject: string;
  body: string;
  to: string;
  saved: { revision: number; document: EmailDraftDocument | null; updated_at: string | null };
  mailbox: { configured: boolean; from_email: string; from_name: string };
  campaigns: CampaignOption[];
  suggested: CampaignSuggestion;
  bounced: BounceNotice | null;
  files: EmailFile[];
}
interface Doc {
  to: string;
  subject: string;
  preview_text: string;
  html: string;
}
interface Followup {
  date: string;
  time: string;
}
type Stage = 'loading' | 'pick' | 'edit' | 'sent';
type Device = 'desktop' | 'mobile';
interface SentResult {
  id: number;
  campaign: { funnel_name: string; funnel_status: string; followups: string[] } | null;
  campaign_error: string;
}

const hour = 3_600_000;
const pad = (value: number) => String(value).padStart(2, '0');
function localParts(ms: number): Followup {
  const d = new Date(ms);
  return {
    date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
    time: pad(d.getHours()) + ':' + pad(d.getMinutes()),
  };
}
const followupTime = (value: Followup) =>
  new Date(value.date + 'T' + (value.time || '09:00')).getTime();
/** The same rule the server applies to a funnel's delays: the day, then the preferred clock. */
function nextSend(from: number, delayDays: number, sendTime: string) {
  const due = new Date(from + Math.max(0, delayDays) * 86_400_000);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) return due.getTime();
  const [hours, minutes] = sendTime.split(':').map(Number);
  due.setHours(hours, minutes, 0, 0);
  return Math.max(due.getTime(), from);
}
function defaultFollowups(campaign: CampaignOption | undefined): Followup[] {
  if (!campaign) return [];
  let previous = Date.now();
  return campaign.steps.slice(1).map((step) => {
    previous = nextSend(previous, Math.max(1, step.delay_days), step.send_time || '09:00');
    return localParts(previous);
  });
}
/** A preview frame for markup the server already sanitized; sandboxed, so nothing can run. */
const framed = (html: string) =>
  '<!doctype html><html><body style="margin:0;padding:12px 16px;font:14px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#25352e">' +
  html +
  '</body></html>';

/**
 * One lead's email. It opens by asking which campaign the email is for (or a one-off), then
 * shows a single-screen rich-text editor with the campaign's first message, sender and
 * attachments filled in, the server-rendered preview beside it, and — for a campaign — the
 * date and time of each follow-up. The draft is saved the moment the email is opened and
 * after every change, so it is always listed under the mailbox's My drafts.
 */
export function EmailComposer({
  base,
  lead,
  onSent,
  onCampaign,
}: {
  base: string;
  lead: Lead;
  onSent: () => void;
  onCampaign: () => void;
  /** Kept for callers of the earlier composer; the campaign question always comes first now. */
  startEditing?: boolean;
}) {
  const projectBase = base.split('/leads/')[0];
  const projectId = Number(projectBase.split('/').pop());
  const [stage, setStage] = useState<Stage>('loading');
  const [offer, setOffer] = useState<Offer | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [mergeFields, setMergeFields] = useState<string[]>([]);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [doc, setDoc] = useState<Doc>({
    to: lead.contact_email,
    subject: '',
    preview_text: '',
    html: '',
  });
  const [attachments, setAttachments] = useState<EmailFile[]>([]);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState(''),
    [conflict, setConflict] = useState(false);
  const revision = useRef(0),
    savedJson = useRef(''),
    seedJson = useRef('');
  const [preview, setPreview] = useState(''),
    [warnings, setWarnings] = useState<string[]>([]),
    [missing, setMissing] = useState<string[]>([]),
    [previewPending, setPreviewPending] = useState(false);
  const [device, setDevice] = useState<Device>('desktop');
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false),
    [sent, setSent] = useState<SentResult | null>(null);
  const [improving, setImproving] = useState(false),
    [suggestion, setSuggestion] = useState<{ subject: string; html: string; notes: string } | null>(
      null,
    );
  const [templateMenu, setTemplateMenu] = useState(false),
    [templateDialog, setTemplateDialog] = useState(false),
    [templateName, setTemplateName] = useState('');
  const [reload, setReload] = useState(0);
  const attachInput = useRef<HTMLInputElement>(null),
    templateRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The template menu closes on an outside click or Escape, like every other menu.
    if (!templateMenu) return;
    const away = (event: MouseEvent) => {
      if (!templateRef.current?.contains(event.target as Node)) setTemplateMenu(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTemplateMenu(false);
    };
    window.document.addEventListener('mousedown', away);
    window.document.addEventListener('keydown', key);
    return () => {
      window.document.removeEventListener('mousedown', away);
      window.document.removeEventListener('keydown', key);
    };
  }, [templateMenu]);
  const campaign = offer?.campaigns.find((item) => item.id === campaignId);

  /** The campaign's defaults: its first message, its files and its follow-up times. */
  async function seed(id: number | null, source: Offer, library: EmailTemplate[]) {
    const chosen = source.campaigns.find((item) => item.id === id);
    const support = library.find((template) => template.id === 'support');
    const next: Doc = chosen
      ? {
          to: source.to || lead.contact_email,
          subject: chosen.steps[0]?.subject || '',
          preview_text: '',
          html: chosen.steps[0]?.html || '',
        }
      : {
          to: source.to || lead.contact_email,
          subject: support?.subject || '',
          preview_text: support?.preview_text || '',
          html: support?.html || '',
        };
    const ids = chosen?.steps[0]?.attachment_ids || [];
    const files = ids.length
      ? await api<EmailFile[]>(projectBase + '/email/files?ids=' + ids.join(','))
      : [];
    setDoc(next);
    setAttachments(files);
    setFollowups(defaultFollowups(chosen));
    setCampaignId(id);
    seedJson.current = JSON.stringify([next, files.map((file) => file.id)]);
  }
  useEffect(() => {
    let cancelled = false;
    setStage('loading');
    Promise.all([
      api<{ templates: EmailTemplate[]; merge_fields: string[] }>(projectBase + '/email/templates'),
      api<Offer>(base + '/email/draft'),
    ])
      .then(async ([library, loaded]) => {
        if (cancelled) return;
        setTemplates(library.templates);
        setMergeFields(library.merge_fields);
        setOffer(loaded);
        revision.current = loaded.saved.revision;
        const saved = loaded.saved.document;
        if (saved) {
          const restored: Doc = {
            to: saved.to,
            subject: saved.subject,
            preview_text: saved.preview_text,
            html: saved.html || '',
          };
          const id = saved.funnel_id ?? null;
          setDoc(restored);
          setCampaignId(id);
          setAttachments(loaded.files);
          const chosen = loaded.campaigns.find((item) => item.id === id);
          const times = (saved.followups || []).map((value) => Date.parse(value));
          setFollowups(
            chosen && times.length === chosen.steps.length - 1 && times.every(Number.isFinite)
              ? times.map(localParts)
              : defaultFollowups(chosen),
          );
          seedJson.current = JSON.stringify([restored, loaded.files.map((file) => file.id)]);
          setSaveState('Draft restored');
          setStage('edit');
        } else {
          // Opening the email creates its draft at once, pre-filled for the suggested campaign.
          await seed(loaded.suggested.funnel_id, loaded, library.templates);
          if (!cancelled) setStage('pick');
        }
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [base, reload]);

  const followupIso = campaign
    ? followups.map((value) => {
        const time = followupTime(value);
        return Number.isFinite(time) ? new Date(time).toISOString() : '';
      })
    : [];
  const draftDocument: EmailDraftDocument = {
    ...doc,
    funnel_id: campaignId,
    attachment_ids: attachments.map((file) => file.id),
    followups: followupIso,
  };
  const documentJson = JSON.stringify(draftDocument);
  /** Saves run one after another, so each one carries the revision the last one returned. */
  const saving = useRef<Promise<void>>(Promise.resolve());
  function save(body: string) {
    saving.current = saving.current.then(async () => {
      if (body === savedJson.current) return;
      setSaveState('Saving…');
      try {
        const result = await api<{ revision: number; updated_at: string }>(base + '/email/draft', {
          method: 'PUT',
          body: json({ ...JSON.parse(body), revision: revision.current }),
        });
        revision.current = result.revision;
        savedJson.current = body;
        setSaveState(
          'Draft saved ' +
            new Date(result.updated_at).toLocaleTimeString([], { timeStyle: 'short' }),
        );
      } catch (e) {
        const message = (e as Error).message;
        if (/another tab/.test(message)) setConflict(true);
        setSaveState('Not saved');
        setError(message);
      }
    });
  }
  // Autosave: the draft is created the moment the email opens, then follows every change a
  // moment after typing stops.
  useEffect(() => {
    if (stage === 'loading' || stage === 'sent' || conflict || !offer) return;
    if (documentJson === savedJson.current) return;
    const timer = setTimeout(() => save(documentJson), savedJson.current ? 900 : 0);
    return () => clearTimeout(timer);
  }, [documentJson, stage, conflict, offer]);

  // The preview is rendered by the server, so what is shown is what will be delivered.
  useEffect(() => {
    if (stage !== 'edit') return;
    let cancelled = false;
    setPreviewPending(true);
    const timer = setTimeout(() => {
      api<{ html: string; warnings: string[]; missing_merge_fields: string[] }>(
        base + '/email/preview',
        {
          method: 'POST',
          body: json({ subject: doc.subject, preview_text: doc.preview_text, html: doc.html }),
        },
      )
        .then((result) => {
          if (cancelled) return;
          setPreview(result.html);
          setWarnings(result.warnings || []);
          setMissing(result.missing_merge_fields || []);
        })
        .catch((e) => {
          if (!cancelled) setError((e as Error).message);
        })
        .finally(() => {
          if (!cancelled) setPreviewPending(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc.subject, doc.preview_text, doc.html, stage, base]);

  const touched = JSON.stringify([doc, attachments.map((file) => file.id)]) !== seedJson.current;
  async function chooseCampaign(id: number | null) {
    if (!offer) return;
    // Until someone writes anything, the campaign's own first message follows the choice.
    if (!touched) await seed(id, offer, templates);
    else {
      setCampaignId(id);
      setFollowups(defaultFollowups(offer.campaigns.find((item) => item.id === id)));
    }
  }
  function applyTemplate(template: EmailTemplate) {
    setTemplateMenu(false);
    if (touched && !window.confirm('Replace the current message with “' + template.name + '”?'))
      return;
    setDoc((current) => ({
      ...current,
      subject: template.subject,
      preview_text: template.preview_text,
      html: template.html || '',
    }));
  }
  async function attach(files: File[]) {
    setError('');
    const total = attachments.reduce((sum, file) => sum + file.size, 0);
    if (attachments.length + files.length > emailFileLimits.count) {
      setError('Attach at most ' + emailFileLimits.count + ' files to one email.');
      return;
    }
    if (total + files.reduce((sum, file) => sum + file.size, 0) > emailFileLimits.perMessage) {
      setError('One email can carry 20 MB of files. Remove a file or send it separately.');
      return;
    }
    setUploading(true);
    try {
      for (const file of files) {
        const stored = await uploadEmailFile(projectId, file, 'attachment');
        setAttachments((current) => [...current, stored]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  async function improve() {
    setImproving(true);
    setError('');
    try {
      setSuggestion(
        await api(base + '/email/improve', {
          method: 'POST',
          body: json({ subject: doc.subject, html: doc.html }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImproving(false);
    }
  }
  const followupProblem = (() => {
    if (!campaign) return '';
    let previous = Date.now();
    for (const [index, value] of followups.entries()) {
      const time = followupTime(value);
      if (!Number.isFinite(time)) return 'Choose a date and time for message ' + (index + 2) + '.';
      if (time - previous < 12 * hour)
        return 'Message ' + (index + 2) + ' must be at least 12 hours after the message before it.';
      previous = time;
    }
    return '';
  })();
  const bouncedHere =
    offer?.bounced && offer.bounced.recipient === doc.to.trim().toLowerCase()
      ? offer.bounced
      : null;
  const blocked = campaign?.blocked || '';
  const size = attachments.reduce((sum, file) => sum + file.size, 0);
  async function send() {
    setSending(true);
    setError('');
    try {
      const result = await api<SentResult>(base + '/email', {
        method: 'POST',
        body: json({
          to: doc.to,
          subject: doc.subject,
          preview_text: doc.preview_text,
          html: doc.html,
          attachment_ids: attachments.map((file) => file.id),
          clear_draft: true,
          ...(campaign ? { funnel_id: campaign.id, followups: followupIso } : {}),
        }),
      });
      revision.current = 0;
      savedJson.current = documentJson;
      setSent(result);
      setStage('sent');
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  const grouped = useMemo(() => {
    const custom = templates.filter((template) => template.custom);
    const sequence = templates.filter(
      (template) => !template.custom && template.id.startsWith('follow-up-'),
    );
    const starters = templates.filter(
      (template) => !template.custom && !template.id.startsWith('follow-up-'),
    );
    return [
      { name: 'Saved in this project', items: custom },
      { name: 'Sequence: 2nd, 3rd and last email', items: sequence },
      { name: 'Starters', items: starters },
    ].filter((group) => group.items.length);
  }, [templates]);

  if (stage === 'loading')
    return error ? <Alert>{error}</Alert> : <Spinner text="Opening the email…" />;
  if (!offer) return null;
  const from = offer.mailbox.from_email
    ? (offer.mailbox.from_name ? offer.mailbox.from_name + ' <' : '<') +
      offer.mailbox.from_email +
      '>'
    : 'No sender yet — this project’s mailbox is not set up';

  if (stage === 'sent' && sent)
    return (
      <div className="composer composer-sent" role="status">
        <CircleCheck size={22} />
        <div>
          <strong>Email sent to {doc.to}.</strong>
          {sent.campaign ? (
            <>
              <p>
                {lead.name} is now in <strong>{sent.campaign.funnel_name}</strong>.{' '}
                {sent.campaign.followups.length
                  ? 'Follow-ups: ' +
                    sent.campaign.followups
                      .map(
                        (value, index) =>
                          'message ' +
                          (index + 2) +
                          ' on ' +
                          new Date(value).toLocaleString([], {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }),
                      )
                      .join(', ') +
                    '.'
                  : 'This campaign has no follow-ups.'}{' '}
                {sent.campaign.funnel_status !== 'ACTIVE' &&
                  'They wait until an administrator starts this campaign.'}
              </p>
              <button className="text-button" onClick={onCampaign}>
                See the campaign on this lead
              </button>
            </>
          ) : (
            <p>It is logged in this lead’s email history.</p>
          )}
          {sent.campaign_error && <Alert>{sent.campaign_error}</Alert>}
        </div>
        <button
          className="button secondary"
          onClick={() => {
            setSent(null);
            savedJson.current = '';
            setConflict(false);
            setReload((n) => n + 1);
          }}
        >
          Write another email
        </button>
      </div>
    );

  if (stage === 'pick')
    return (
      <div className="composer">
        {error && <Alert>{error}</Alert>}
        <CampaignPicker
          campaigns={offer.campaigns}
          suggested={offer.suggested}
          selected={campaignId}
          score={lead.stale ? null : lead.score}
          onSelect={(id) => void chooseCampaign(id)}
          onContinue={() => setStage('edit')}
        />
        <p className="fine-print compose-autosave">
          {saveState || 'Saving your draft…'} Drafts are private to you and listed under the
          mailbox’s My drafts.
        </p>
      </div>
    );

  return (
    <div className="composer compose">
      {error && <Alert>{error}</Alert>}
      <div className="compose-bar">
        <div className="compose-campaign">
          {campaign ? <GitBranch size={17} /> : <Mail size={17} />}
          <span>
            <small>STEP 2 OF 2 · {campaign ? 'CAMPAIGN' : 'ONE-OFF'}</small>
            <strong>
              {campaign
                ? campaign.name + ' · message 1 of ' + campaign.steps.length
                : 'One-off email'}
            </strong>
          </span>
          <button type="button" className="text-button" onClick={() => setStage('pick')}>
            Change
          </button>
        </div>
        <span className="compose-save" role="status">
          {saveState}
        </span>
        <div className="compose-bar-actions">
          <div className="compose-templates" ref={templateRef}>
            <button
              type="button"
              className="button secondary small"
              aria-haspopup="menu"
              aria-expanded={templateMenu}
              onClick={() => setTemplateMenu((open) => !open)}
            >
              <LayoutTemplate size={14} />
              Templates
              <ChevronDown size={13} />
            </button>
            {templateMenu && (
              <div className="compose-template-menu" role="menu">
                {grouped.map((group) => (
                  <div key={group.name} role="group" aria-label={group.name}>
                    <span className="compose-template-group">{group.name}</span>
                    {group.items.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        role="menuitem"
                        onClick={() => applyTemplate(template)}
                      >
                        <strong>{template.name}</strong>
                        <small>{template.description}</small>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="button secondary small"
            disabled={!doc.subject.trim() || !doc.html}
            onClick={() => {
              setTemplateName('');
              setTemplateDialog(true);
            }}
          >
            Save as template
          </button>
        </div>
      </div>
      {!offer.mailbox.configured && (
        <Alert>
          Your draft is saved. An administrator must connect this project’s mailbox before it can be
          sent.
        </Alert>
      )}
      {bouncedHere && (
        <Alert>
          Email to {bouncedHere.recipient} bounced on {date(bouncedHere.created_at)}, so it cannot
          be emailed again. Update the lead’s contact email first.
        </Alert>
      )}
      {campaign && blocked && (
        <Alert>
          {blocked}{' '}
          <button type="button" className="text-button" onClick={() => void chooseCampaign(null)}>
            Send as a one-off email instead
          </button>
        </Alert>
      )}
      {conflict && (
        <Alert>
          This draft changed in another tab, so it is no longer being saved here.{' '}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setConflict(false);
              setError('');
              savedJson.current = '';
              setReload((n) => n + 1);
            }}
          >
            Load the latest draft
          </button>
        </Alert>
      )}
      <div className="composer-grid">
        <div className="composer-edit">
          <div className="compose-fields">
            <div className="compose-from">
              <span>From</span>
              <strong>{from}</strong>
            </div>
            <label>
              To
              <input
                type="email"
                value={doc.to}
                maxLength={200}
                placeholder="No contact email on this lead yet"
                onChange={(e) => setDoc((current) => ({ ...current, to: e.target.value }))}
              />
            </label>
            <label>
              Subject
              <input
                value={doc.subject}
                maxLength={200}
                required
                onChange={(e) => setDoc((current) => ({ ...current, subject: e.target.value }))}
              />
            </label>
            <label>
              Preview text
              <input
                value={doc.preview_text}
                maxLength={200}
                placeholder="The line an inbox shows after the subject"
                onChange={(e) =>
                  setDoc((current) => ({ ...current, preview_text: e.target.value }))
                }
              />
            </label>
          </div>
          <RichEmailEditor
            value={doc.html}
            onChange={(html) => setDoc((current) => ({ ...current, html }))}
            projectId={projectId}
            mergeFields={mergeFields}
            onError={setError}
          />
          <div className="compose-attachments">
            <button
              type="button"
              className="button secondary small"
              disabled={uploading || attachments.length >= emailFileLimits.count}
              onClick={() => attachInput.current?.click()}
            >
              <Paperclip size={14} />
              {uploading ? 'Uploading…' : 'Attach files'}
            </button>
            <input
              ref={attachInput}
              type="file"
              multiple
              hidden
              accept={attachmentAccept}
              onChange={(e) => {
                const files = [...(e.target.files || [])];
                e.target.value = '';
                void attach(files);
              }}
            />
            <small className="muted">
              PDF, Word, Excel, PowerPoint, CSV, text or images · up to 10 MB each, 20 MB in total
              {attachments.length ? ' · ' + formatSize(size) + ' attached' : ''}
            </small>
            {attachments.length > 0 && (
              <ul className="compose-files">
                {attachments.map((file) => (
                  <li key={file.id}>
                    <Paperclip size={13} />
                    <a href={fileUrl(projectId, file.id)} target="_blank" rel="noreferrer">
                      {file.filename}
                    </a>
                    <small>{formatSize(file.size)}</small>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={'Remove ' + file.filename}
                      onClick={() =>
                        setAttachments((current) => current.filter((item) => item.id !== file.id))
                      }
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {suggestion && (
            <section className="ai-suggestion" aria-label="AI suggestion">
              <div className="ai-suggestion-head">
                <Sparkles size={15} />
                <strong>Suggested rewrite</strong>
                <small>Nothing changes unless you use it.</small>
              </div>
              <p className="ai-subject">
                <small>Subject</small>
                {suggestion.subject}
              </p>
              <iframe title="Suggested rewrite" sandbox="" srcDoc={framed(suggestion.html)} />
              {suggestion.notes && <p className="muted">{suggestion.notes}</p>}
              <div className="form-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setSuggestion(null)}
                >
                  Ignore
                </button>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    setDoc((current) => ({
                      ...current,
                      subject: suggestion.subject,
                      html: suggestion.html,
                    }));
                    setSuggestion(null);
                  }}
                >
                  Use this version
                </button>
              </div>
            </section>
          )}
        </div>
        <div className="composer-preview">
          <div className="compose-preview-head">
            <span className="eyebrow">PREVIEW</span>
            <div className="device-toggle">
              <button
                type="button"
                className={device === 'desktop' ? 'is-on' : ''}
                aria-label="Desktop preview"
                onClick={() => setDevice('desktop')}
              >
                <Monitor size={15} />
              </button>
              <button
                type="button"
                className={device === 'mobile' ? 'is-on' : ''}
                aria-label="Mobile preview"
                onClick={() => setDevice('mobile')}
              >
                <Smartphone size={15} />
              </button>
            </div>
          </div>
          {missing.length > 0 && (
            <Alert>
              Fill these fields or edit the message before sending:{' '}
              {missing.map((field) => '{{' + field + '}}').join(', ')}.
            </Alert>
          )}
          {warnings.length > 0 && (
            <div className="checks-box">
              <strong>
                <TriangleAlert size={15} />
                Before you send
              </strong>
              <ul>
                {warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <div className={'preview-frame ' + device}>
            {/* Sandboxed with no allow-scripts: the preview renders, it never executes. */}
            <iframe title="Email preview" sandbox="" srcDoc={preview} />
          </div>
        </div>
      </div>
      {campaign && (
        <section className="compose-followups" aria-label="Follow-ups">
          <div className="compose-followups-head">
            <CalendarClock size={17} />
            <div>
              <strong>After you send, {campaign.name} continues on its own</strong>
              <small>
                Set only the date and time of each follow-up. The messages come from the campaign
                {campaign.stop_on_reply ? ' and stop as soon as the lead replies' : ''}.
                {campaign.status !== 'ACTIVE' &&
                  ' This campaign is ' +
                    label(campaign.status).toLowerCase() +
                    ', so follow-ups wait until an administrator starts it.'}
              </small>
            </div>
          </div>
          {campaign.steps.length > 1 ? (
            <ol className="compose-followup-list">
              {campaign.steps.slice(1).map((step, index) => (
                <li key={index}>
                  <span>
                    <strong>Message {index + 2}</strong>
                    <small>{step.subject}</small>
                  </span>
                  <label>
                    Date
                    <input
                      type="date"
                      value={followups[index]?.date || ''}
                      onChange={(e) =>
                        setFollowups((list) =>
                          list.map((item, n) =>
                            n === index ? { ...item, date: e.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Time
                    <input
                      type="time"
                      value={followups[index]?.time || ''}
                      onChange={(e) =>
                        setFollowups((list) =>
                          list.map((item, n) =>
                            n === index ? { ...item, time: e.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">This campaign has a single message, so nothing follows.</p>
          )}
          {followupProblem && <p className="compose-followup-problem">{followupProblem}</p>}
        </section>
      )}
      <div className="compose-actions">
        <button
          type="button"
          className="button secondary"
          disabled={improving || !doc.html}
          onClick={() => void improve()}
          title="Suggests a clearer subject and message. Nothing is sent or saved until you accept it."
        >
          {improving ? (
            <Spinner text="Thinking…" />
          ) : (
            <>
              <Sparkles size={15} />
              Improve with AI
            </>
          )}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={async () => {
            if (!window.confirm('Discard this draft and start again?')) return;
            try {
              await api(base + '/email/draft', { method: 'DELETE' });
              savedJson.current = '';
              revision.current = 0;
              setReload((n) => n + 1);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <RotateCcw size={13} />
          Start over
        </button>
        <span className="compose-actions-gap" />
        <button
          type="button"
          className="button primary"
          disabled={
            sending ||
            previewPending ||
            !preview ||
            missing.length > 0 ||
            !offer.mailbox.configured ||
            !doc.subject.trim() ||
            !doc.to.trim() ||
            Boolean(bouncedHere) ||
            Boolean(blocked) ||
            Boolean(followupProblem)
          }
          onClick={() => void send()}
        >
          {sending ? (
            <Spinner text="Sending…" />
          ) : (
            <>
              <Mail size={15} />
              {campaign ? 'Send & start campaign' : 'Send email'}
            </>
          )}
        </button>
      </div>
      {templateDialog && (
        <Modal title="Save a project template" onClose={() => setTemplateDialog(false)}>
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              try {
                const template = await api<EmailTemplate>(projectBase + '/email/templates', {
                  method: 'POST',
                  body: json({
                    name: templateName,
                    category: 'outreach',
                    description: 'Saved by your project team',
                    subject: doc.subject,
                    preview_text: doc.preview_text,
                    html: doc.html,
                  }),
                });
                setTemplates((items) => [template, ...items]);
                setSaveState('Template saved');
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setTemplateDialog(false);
              }
            }}
          >
            <p className="muted">
              Everyone assigned to this project can use it, here and in campaigns. Images in the
              message are kept with the template. Use merge fields to keep it reusable.
            </p>
            <label>
              Template name
              <input
                autoFocus
                required
                value={templateName}
                maxLength={100}
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setTemplateDialog(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={!templateName.trim()}>
                Save template
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutTemplate, Mail, Type, Monitor, Smartphone, TriangleAlert, Save } from 'lucide-react';
import type { EmailBlock, EmailTemplate, Lead, TemplateCategory } from '../shared/types';
import { api, json } from './api';
import { BlockEditor, palette } from './BlockEditor';
import { Alert, Modal, Spinner } from './ui';

interface DraftDocument {
  to: string;
  subject: string;
  preview_text: string;
  blocks: EmailBlock[];
}
interface SavedDraft {
  revision: number;
  document: DraftDocument | null;
  updated_at: string | null;
}

type Device = 'desktop' | 'mobile';

/**
 * Block-based email for one lead: template picker, the shared BlockEditor, the saved
 * draft and the server-rendered preview. The blocks themselves are edited as structured
 * fields rather than as free HTML, because the delivered markup has to survive Outlook —
 * the server renders them into table-based, inline-styled HTML and reports its own
 * pre-send checks.
 */
export function EmailComposer({
  base,
  lead,
  onSent,
  onCampaign,
  startEditing = false,
}: {
  base: string;
  lead: Lead;
  onSent: () => void;
  onCampaign: () => void;
  /** When true, skip the template grid and open the editor with a blank message. */
  startEditing?: boolean;
}) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [categories, setCategories] = useState<Array<{ value: string; label: string }>>([]);
  const [mergeFields, setMergeFields] = useState<string[]>([]);
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [picking, setPicking] = useState(!startEditing);
  const [blocks, setBlocks] = useState<EmailBlock[]>(() =>
    startEditing ? [palette[1].make()] : [],
  );
  const [subject, setSubject] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [to, setTo] = useState(lead.contact_email);
  const toInputRef = useRef<HTMLInputElement | null>(null);
  const [device, setDevice] = useState<Device>('desktop');
  const [preview, setPreview] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [blockProblems, setBlockProblems] = useState<
    Array<{ index: number; type: string; message: string }>
  >([]);
  const [mailbox, setMailbox] = useState<{ configured: boolean; from_email: string } | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const [draftRevision, setDraftRevision] = useState(0),
    [savedDocument, setSavedDocument] = useState('');
  const [saving, setSaving] = useState(false),
    [savedMessage, setSavedMessage] = useState('');
  const [templateDialog, setTemplateDialog] = useState(false),
    [templateName, setTemplateName] = useState('');
  const [previewPending, setPreviewPending] = useState(false);
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const projectBase = base.split('/leads/')[0];
  const currentDocument = JSON.stringify({ to, subject, preview_text: previewText, blocks });
  const dirty = !picking && currentDocument !== savedDocument;
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const starterDocument = useRef('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{
        templates: EmailTemplate[];
        categories: Array<{ value: string; label: string }>;
        merge_fields: string[];
      }>(projectBase + '/email/templates'),
      api<{ to: string; saved: SavedDraft; mailbox: { configured: boolean; from_email: string } }>(
        base + '/email/draft',
      ),
    ])
      .then(([library, draft]) => {
        if (cancelled) return;
        setTemplates(library.templates);
        setCategories(library.categories);
        setMergeFields(library.merge_fields);
        setTo(draft.to || lead.contact_email);
        setMailbox(draft.mailbox);
        setDraftRevision(draft.saved.revision);
        if (draft.saved.document) {
          const saved = draft.saved.document;
          setTo(saved.to);
          setSubject(saved.subject);
          setPreviewText(saved.preview_text);
          setBlocks(saved.blocks);
          setSavedDocument(JSON.stringify(saved));
          setPicking(false);
          setSavedMessage('Your saved draft');
        } else {
          const support = library.templates.find((template) => template.id === 'support');
          if (support) {
            setSubject(support.subject);
            setPreviewText(support.preview_text);
            setBlocks(structuredClone(support.blocks));
            setPicking(false);
            setSavedMessage('Support template · edit before sending');
            starterDocument.current = JSON.stringify({
              to: draft.to || lead.contact_email,
              subject: support.subject,
              preview_text: support.preview_text,
              blocks: support.blocks,
            });
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, lead.contact_email]);

  useEffect(() => {
    if (loading || picking) return;
    const timer = setTimeout(() => toInputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [loading, picking]);

  // The preview is rendered by the server, so what is shown is what will be delivered.
  useEffect(() => {
    if (picking || !blocks.length) return;
    let cancelled = false;
    setPreviewPending(true);
    if (renderTimer.current) clearTimeout(renderTimer.current);
    renderTimer.current = setTimeout(() => {
      api<{
        html: string;
        warnings: string[];
        block_problems: Array<{ index: number; type: string; message: string }>;
        missing_merge_fields: string[];
      }>(base + '/email/preview', {
        method: 'POST',
        body: json({ subject, preview_text: previewText, blocks }),
      })
        .then((result) => {
          if (cancelled) return;
          setPreview(result.html);
          setWarnings(result.warnings);
          setBlockProblems(result.block_problems || []);
          setMissingFields(result.missing_merge_fields || []);
        })
        .catch((e) => {
          if (!cancelled) {
            setError((e as Error).message);
            setPreview('');
          }
        })
        .finally(() => {
          if (!cancelled) setPreviewPending(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      if (renderTimer.current) clearTimeout(renderTimer.current);
    };
  }, [blocks, subject, previewText, picking, base]);

  useEffect(() => {
    if (!dirty) return;
    const prevent = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);

  async function saveDraft() {
    setSaving(true);
    setError('');
    const document = currentDocument;
    try {
      const saved = await api<SavedDraft>(base + '/email/draft', {
        method: 'PUT',
        body: json({ ...JSON.parse(document), revision: draftRevision }),
      });
      setDraftRevision(saved.revision);
      setSavedDocument(document);
      setSavedMessage('Draft saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const shown = useMemo(
    () => templates.filter((t) => category === 'all' || t.category === category),
    [templates, category],
  );

  if (loading) return <Spinner text="Loading the editor…" />;

  if (picking)
    return (
      <div className="composer">
        <p className="muted">
          Create an email for {lead.name}. Templates are available on every lead, even before
          qualification.
        </p>
        <div className="composer-campaign-link">
          <span>Want scheduled follow-ups? Choose a campaign and review its sequence.</span>
          <button className="button secondary" onClick={onCampaign}>
            Add to campaign
          </button>
        </div>
        {error && <Alert>{error}</Alert>}
        {mailbox && !mailbox.configured && (
          <Alert>
            This project has no mailbox yet. An administrator sets one up in the project’s Mailbox
            settings, then you can send from here.
          </Alert>
        )}
        <div className="composer-head">
          <div>
            <span className="eyebrow">START FROM</span>
            <h3>Pick a template, or start blank</h3>
          </div>
          <div className="chip-row">
            {categories.map((option) => (
              <button
                key={option.value}
                className={'chip ' + (category === option.value ? 'is-on' : '')}
                onClick={() => setCategory(option.value as TemplateCategory | 'all')}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="template-grid">
          {shown.map((template) => (
            <button
              key={template.id}
              className="template-card"
              onClick={() => {
                setBlocks(template.blocks);
                setSubject(template.subject);
                setPreviewText(template.preview_text);
                setSelected(0);
                setPicking(false);
              }}
            >
              <LayoutTemplate size={18} />
              <strong>{template.name}</strong>
              <small>{template.description}</small>
              <span className="template-blocks">{template.blocks.length} blocks</span>
            </button>
          ))}
          <button
            className="template-card is-blank"
            onClick={() => {
              setBlocks([palette[1].make()]);
              setSubject('');
              setPreviewText('');
              setSelected(0);
              setPicking(false);
            }}
          >
            <Type size={18} />
            <strong>Blank</strong>
            <small>One text block to build from.</small>
          </button>
        </div>
      </div>
    );

  return (
    <div className="composer">
      {error && <Alert>{error}</Alert>}
      <div className="composer-campaign-link">
        <span>For scheduled messages, choose a campaign. Save this draft before leaving.</span>
        <button className="button secondary" disabled={busy || saving} onClick={onCampaign}>
          Add to campaign
        </button>
      </div>
      <div className="draft-bar">
        <span role="status">
          {dirty
            ? currentDocument === starterDocument.current
              ? 'Support template ready — edit before sending, or save as a draft.'
              : 'Unsaved changes — save before leaving this page.'
            : savedMessage || 'Draft editor'}{' '}
          <small>Your draft is private to you.</small>
        </span>
        <button
          className="button secondary"
          disabled={saving || busy || !dirty}
          onClick={() => void saveDraft()}
        >
          <Save size={15} />
          {saving ? 'Saving…' : 'Save draft'}
        </button>
        <button
          className="button secondary"
          disabled={busy || saving || !subject.trim()}
          onClick={() => {
            setTemplateName('');
            setTemplateDialog(true);
          }}
        >
          <LayoutTemplate size={15} />
          Save as template
        </button>
      </div>
      {!mailbox?.configured && (
        <Alert>
          You can save drafts and templates now. An administrator must connect this project’s
          mailbox before sending.
        </Alert>
      )}
      <div className="composer-head">
        <div>
          <span className="eyebrow">EDITING</span>
          <h3>{subject || 'Untitled email'}</h3>
        </div>
        <div className="composer-head-actions">
          <button
            className="text-button"
            onClick={() => {
              if (
                !dirty ||
                currentDocument === starterDocument.current ||
                window.confirm('Discard the unsaved changes and choose another template?')
              )
                setPicking(true);
            }}
          >
            <LayoutTemplate size={15} />
            Change template
          </button>
          <div className="device-toggle">
            <button
              className={device === 'desktop' ? 'is-on' : ''}
              aria-label="Desktop preview"
              onClick={() => setDevice('desktop')}
            >
              <Monitor size={15} />
            </button>
            <button
              className={device === 'mobile' ? 'is-on' : ''}
              aria-label="Mobile preview"
              onClick={() => setDevice('mobile')}
            >
              <Smartphone size={15} />
            </button>
          </div>
        </div>
      </div>

      <div className="composer-grid">
        <div className="composer-edit">
          <div className="form-stack">
            <label>
              To
              <input
                ref={toInputRef}
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                maxLength={200}
                placeholder="No contact email on this lead yet"
              />
            </label>
            <label>
              Subject
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                required
              />
            </label>
            <label>
              Preview text
              <input
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                maxLength={200}
              />
              <small>The line the inbox shows after the subject.</small>
            </label>
          </div>

          <BlockEditor
            blocks={blocks}
            onChange={setBlocks}
            mergeFields={mergeFields}
            problems={blockProblems}
            selected={selected}
            onSelect={setSelected}
          />
        </div>

        <div className="composer-preview">
          {missingFields.length > 0 && (
            <Alert>
              Fill these fields or edit the template before sending:{' '}
              {missingFields.map((field) => '{{' + field + '}}').join(', ')}.
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
          <div className="form-actions">
            <button
              className="button primary"
              title={
                blockProblems.length
                  ? 'Fix the highlighted block first: ' + blockProblems[0].message
                  : undefined
              }
              disabled={
                busy ||
                saving ||
                previewPending ||
                !preview ||
                missingFields.length > 0 ||
                !mailbox?.configured ||
                !subject.trim() ||
                !to.trim() ||
                blockProblems.length > 0
              }
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await api(base + '/email', {
                    method: 'POST',
                    body: json({ to, subject, preview_text: previewText, blocks }),
                  });
                  onSent();
                  setSavedMessage('Email sent. The saved draft is still available.');
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? (
                <Spinner text="Sending…" />
              ) : (
                <>
                  <Mail size={15} />
                  Send email
                </>
              )}
            </button>
          </div>
        </div>
      </div>
      {templateDialog && (
        <Modal title="Save a project template" onClose={() => setTemplateDialog(false)}>
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setSaving(true);
              setError('');
              try {
                const template = await api<EmailTemplate>(projectBase + '/email/templates', {
                  method: 'POST',
                  body: json({
                    name: templateName,
                    category: 'outreach',
                    description: 'Saved by your project team',
                    subject,
                    preview_text: previewText,
                    blocks,
                  }),
                });
                setTemplates((items) => [template, ...items]);
                setTemplateDialog(false);
                setSavedMessage('Project template saved');
              } catch (e) {
                setError((e as Error).message);
                setTemplateDialog(false);
              } finally {
                setSaving(false);
              }
            }}
          >
            <p className="muted">
              Everyone assigned to this project can use this template on their leads. Use merge
              fields to keep it reusable.
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
              <button className="button primary" disabled={saving || !templateName.trim()}>
                {saving ? 'Saving…' : 'Save template'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

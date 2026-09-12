import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Download,
  FileText,
  Globe,
  History,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
  X,
  CircleHelp,
} from 'lucide-react';
import type { Project, Source, Rubric, TrainingSnapshot } from '../shared/types';
import { api, date, json } from './api';
import { Alert, Badge, Empty, ExternalLink, Modal, Spinner } from './ui';

interface Version {
  version: number;
  revision: number;
  created_at: string;
  created_by: string;
}
type Editor = {
  summary: string;
  criteria: string;
  exclusions: string;
  questions: string;
};
const edit = (rubric: Rubric): Editor => ({
  summary: rubric.summary,
  criteria: rubric.criteria.join('\n'),
  exclusions: rubric.exclusions.join('\n'),
  questions: rubric.questions.join('\n'),
});
const lines = (value: string) =>
  value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
const domain = (value: string) => {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
export default function Training({
  project,
  onChange,
  onEditProject,
  notify,
}: {
  project: Project;
  onChange: () => void;
  onEditProject: () => void;
  notify: (text: string) => void;
}) {
  const base = '/projects/' + project.id;
  const [sources, setSources] = useState<Source[]>([]),
    [versions, setVersions] = useState<Version[]>([]),
    [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor>(edit(project.rubric)),
    [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [mode, setMode] = useState<'note' | 'website' | null>(null);
  const [preview, setPreview] = useState<Source | null>(null),
    [remove, setRemove] = useState<Source | null>(null);
  const [oldVersion, setOldVersion] = useState<{
    version: number;
    snapshot: TrainingSnapshot;
  } | null>(null);
  const [analyses, setAnalyses] = useState<
    Array<{ id: number; rubric: Rubric; revision: number; created_at: string }>
  >([]);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{ sources: Source[]; versions: Version[] }>(base),
      api<typeof analyses>(base + '/training/analyses'),
    ])
      .then(([data, history]) => {
        if (!cancelled) {
          setSources(data.sources);
          setVersions(data.versions);
          setAnalyses(history);
          setEditor(edit(project.rubric));
          setDirty(false);
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
  }, [project.id, project.revision, project.active_version]);
  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  function update(key: keyof Editor, value: string) {
    setEditor((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    await perform('save', async () => {
      await api(base + '/training/rubric', {
        method: 'PUT',
        body: json({
          revision: project.revision,
          rubric: {
            summary: editor.summary,
            criteria: lines(editor.criteria),
            exclusions: lines(editor.exclusions),
            questions: lines(editor.questions),
          },
        }),
      });
      onChange();
      setDirty(false);
      notify('Draft rules saved. Publish them when they are ready.');
    });
  }
  async function analyze() {
    await perform('analyze', async () => {
      const result = await api<{ rubric: Rubric; revision: number }>(base + '/training/analyze', {
        method: 'POST',
        body: json({ revision: project.revision }),
      });
      setEditor(edit(result.rubric));
      setDirty(true);
      notify('Training analysis is ready. Review the proposed rules below.');
    });
  }
  async function publish() {
    await perform('publish', async () => {
      await api(base + '/training/publish', {
        method: 'POST',
        body: json({ revision: project.revision }),
      });
      onChange();
      notify('Training published. Leads can now be qualified against this version.');
    });
  }
  const ready = project.trained_revision === project.revision;
  const checklist = [
    {
      done: sources.some((s) => s.kind === 'document' || s.kind === 'note'),
      text: 'Training document or research notes',
    },
    {
      done:
        Boolean(project.website) &&
        sources.some((s) => s.kind === 'website' && domain(s.url) === domain(project.website)),
      text: 'Business website and captured context',
    },
    {
      done:
        Boolean(editor.summary.trim()) &&
        lines(editor.criteria).length > 0 &&
        lines(editor.questions).length === 0,
      text: 'Qualification rules with open questions resolved',
    },
  ];
  /**
   * Publishing is gated, so say which gate is closed. A disabled button with generic
   * copy next to it reads as broken.
   */
  const openQuestions = lines(editor.questions).length;
  const blocker = !project.website
    ? 'Add the business website in Project settings first.'
    : !checklist[0].done
      ? 'Attach a training document or write research notes first.'
      : !checklist[1].done
        ? 'Capture the business website as a source — it must match the domain in Project settings.'
        : !editor.summary.trim()
          ? 'Write the business context and ideal customer above.'
          : lines(editor.criteria).length === 0
            ? 'Add at least one positive qualification criterion.'
            : openQuestions > 0
              ? 'Resolve and clear the ' +
                openQuestions +
                ' open question' +
                (openQuestions === 1 ? '' : 's') +
                ' above — publishing is blocked while any remain.'
              : '';
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">KNOWLEDGE BEFORE QUALIFICATION</span>
          <h1>Train with what you know.</h1>
          <p>The sources and rules that guide every qualification for {project.name}.</p>
        </div>
        <Badge value={ready ? 'ready' : 'draft'}>
          {ready
            ? 'Published · v' + project.active_version
            : 'Draft · revision ' + project.revision}
        </Badge>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="training-status">
        <div className="training-status-icon">
          <BookOpen size={23} />
        </div>
        <div>
          <strong>
            {ready
              ? 'Your project training is ready.'
              : project.active_version
                ? 'Your training has changed.'
                : 'Build and approve your training.'}
          </strong>
          <p>
            {ready
              ? 'Each analysis uses this approved version and retains its original source context.'
              : project.active_version
                ? 'Publish a new version to qualify with your latest context. Existing results are flagged for requalification.'
                : 'Add sources, review the rules, then publish. You stay in control of what qualifies a lead.'}
          </p>
        </div>
        {ready && <CheckCircle2 size={25} className="green" />}
      </div>
      <div className="training-layout">
        <div>
          <section className="panel">
            <div className="section-title">
              <h2>
                Source library <span>{sources.length}</span>
              </h2>
              <span className="muted">Project knowledge</span>
            </div>
            <div className="source-actions">
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={16} />
                Upload document
              </button>
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => setMode('website')}
              >
                <Globe size={16} />
                Add website
              </button>
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => setMode('note')}
              >
                <Plus size={16} />
                Write notes
              </button>
              <input
                ref={fileRef}
                className="visually-hidden"
                type="file"
                aria-label="Upload training document"
                accept=".pdf,.docx,.xlsx,.csv,.tsv,.md,.txt"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file)
                    void perform('upload', async () => {
                      const data = new FormData();
                      data.set('file', file);
                      data.set('revision', String(project.revision));
                      await api(base + '/sources/upload', {
                        method: 'POST',
                        body: data,
                      });
                      onChange();
                      notify('Document attached and text extracted.');
                    });
                }}
              />
            </div>
            <p className="fine-print source-hint">
              PDF, DOCX, Excel, CSV, TSV, Markdown or text · up to 5 MB per document · text-based
              PDFs
            </p>
            {busy === 'upload' && <Spinner text="Reading your document…" />}
            {loading ? (
              <Spinner text="Loading source library…" />
            ) : sources.length ? (
              <div className="source-list">
                {sources.map((source) => (
                  <div className="source-item" key={source.id}>
                    <span className={'source-icon ' + source.kind}>
                      {source.kind === 'website' ? <Globe size={21} /> : <FileText size={21} />}
                    </span>
                    <div>
                      <button className="source-title" onClick={() => setPreview(source)}>
                        {source.title}
                      </button>
                      <small>
                        {source.kind === 'website'
                          ? 'Website snapshot'
                          : source.kind === 'document'
                            ? 'Training document'
                            : 'Research notes'}{' '}
                        · {source.content.length.toLocaleString()} characters
                      </small>
                      <span className="source-date">Added {date(source.created_at)}</span>
                    </div>
                    <button
                      className="icon-button"
                      title="Remove source"
                      aria-label={'Remove ' + source.title}
                      disabled={!!busy}
                      onClick={() => setRemove(source)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon={<FileText size={26} />} title="Give your research some context">
                Upload your ideal customer profile, product guide, qualification handbook or a
                research brief.
              </Empty>
            )}
            <div className="source-library-footer">
              <Globe size={15} />
              <ExternalLink url={project.website} />
              <button className="text-button" onClick={onEditProject}>
                Edit project context
              </button>
            </div>
          </section>
          <section className="panel training-checklist">
            <div className="section-title">
              <h2>Ready to qualify?</h2>
              <ShieldCheckIcon />
            </div>
            {checklist.map((item) => (
              <div className={'checklist-row ' + (item.done ? 'complete' : '')} key={item.text}>
                {item.done ? <CheckCircle2 size={18} /> : <span className="empty-check" />}
                <span>{item.text}</span>
              </div>
            ))}
            <p className="fine-print">
              Publishing saves a version of your sources and rules. Future changes will require a
              new version.
            </p>
          </section>
          <section className="panel versions">
            <div className="section-title">
              <h2>Training versions</h2>
              <History size={18} />
            </div>
            {versions.length ? (
              versions.map((version) => (
                <button
                  key={version.version}
                  className="version-row"
                  onClick={() =>
                    void perform('version', async () =>
                      setOldVersion(await api(base + '/training/versions/' + version.version)),
                    )
                  }
                >
                  <span className="version-number">v{version.version}</span>
                  <span>
                    <strong>
                      {version.version === project.active_version
                        ? 'Latest published version'
                        : 'Previous version'}
                    </strong>
                    <small>
                      {date(version.created_at)} · {version.created_by}
                    </small>
                  </span>
                  <ArrowRight size={16} />
                </button>
              ))
            ) : (
              <p className="muted">Your first published version will appear here.</p>
            )}
            {analyses.length > 0 && (
              <details>
                <summary>Previous training analyses ({analyses.length})</summary>
                {analyses.map((item) => (
                  <button
                    className="analysis-history"
                    key={item.id}
                    disabled={!!busy}
                    onClick={() => {
                      setEditor(edit(item.rubric));
                      setDirty(true);
                      notify(
                        'Previous proposal loaded into the editor. Review it against the current sources.',
                      );
                    }}
                  >
                    {date(item.created_at)} · source revision {item.revision}
                    <ArrowRight size={14} />
                  </button>
                ))}
              </details>
            )}
          </section>
        </div>
        <section className="panel rubric-panel">
          <div className="section-title">
            <div>
              <span className="eyebrow">THE QUALIFICATION STANDARD</span>
              <h2>Project training rules</h2>
            </div>
            <Sparkles size={21} />
          </div>
          <p className="muted">
            Analyze your sources to draft rules, or write them yourself. Review every rule before
            publishing.
          </p>
          {project.pending_feedback_count > 0 && (
            <div className="inline-notice">
              <Sparkles size={20} />
              <span>
                <strong>
                  {project.pending_feedback_count} lead correction
                  {project.pending_feedback_count === 1 ? '' : 's'} waiting.
                </strong>{' '}
                Analyzing now rewrites the criteria and exclusions around this feedback. Publishing
                applies it to future research.
              </span>
            </div>
          )}
          <button
            className="button analyze-button"
            disabled={!!busy || !sources.length}
            onClick={analyze}
          >
            {busy === 'analyze' ? (
              <Spinner text="Analyzing your training…" />
            ) : (
              <>
                <Sparkles size={17} />
                Analyze training sources
                <ArrowRight size={16} />
              </>
            )}
          </button>
          <form onSubmit={save} className="form-stack">
            <label>
              Business context & ideal customer
              <textarea
                rows={5}
                value={editor.summary}
                onChange={(e) => update('summary', e.target.value)}
                placeholder="What is this project looking for, and why?"
                maxLength={6000}
                required
              />
            </label>
            <label>
              Positive qualification criteria
              <small>
                One criterion per line. Each criterion contributes equally to the fit score.
              </small>
              <textarea
                rows={7}
                value={editor.criteria}
                onChange={(e) => update('criteria', e.target.value)}
                placeholder="Has an in-house engineering team…"
                required
              />
            </label>
            <label>
              Exclusion rules
              <small>One exclusion per line. A supported exclusion can disqualify a lead.</small>
              <textarea
                rows={6}
                value={editor.exclusions}
                onChange={(e) => update('exclusions', e.target.value)}
                placeholder="Direct competitor manufacturing the same product…"
              />
            </label>
            <label>
              Open questions
              <small>Resolve these questions, then remove them before publishing.</small>
              <textarea
                rows={3}
                value={editor.questions}
                onChange={(e) => update('questions', e.target.value)}
                placeholder="No open questions"
              />
            </label>
            <div className="rubric-footer">
              <span className="fine-print">
                {dirty ? 'You have unsaved draft changes.' : 'Draft saved.'}
              </span>
              <button className="button secondary" disabled={!!busy || !dirty}>
                {busy === 'save' ? (
                  <Spinner />
                ) : (
                  <>
                    <Save size={15} />
                    Save draft
                  </>
                )}
              </button>
            </div>
          </form>
          <div className="publish-box">
            <div>
              <strong>
                {ready
                  ? 'Training v' + project.active_version + ' is published'
                  : 'Approve this training version'}
              </strong>
              <p>
                {ready
                  ? 'Every qualification runs against this version until you publish another.'
                  : dirty
                    ? 'Save your draft before publishing.'
                    : blocker ||
                      'Confirm that the sources and rules reflect how this project should qualify leads.'}
              </p>
            </div>
            <button
              className="button primary"
              disabled={!!busy || dirty || ready || !checklist.every((c) => c.done)}
              onClick={publish}
            >
              {busy === 'publish' ? (
                <Spinner />
              ) : (
                <>
                  <CheckCircle2 size={16} />
                  {ready ? 'Published' : 'Approve & publish'}
                </>
              )}
            </button>
          </div>
        </section>
      </div>
      {mode && (
        <SourceForm
          mode={mode}
          website={project.website}
          busy={!!busy}
          requestError={error}
          onClose={() => setMode(null)}
          onSubmit={(data) =>
            perform(mode, async () => {
              const result = await api<{ truncated?: boolean }>(
                base + '/sources' + (mode === 'website' ? '/website' : ''),
                {
                  method: 'POST',
                  body: json({ ...data, revision: project.revision }),
                },
              );
              setMode(null);
              onChange();
              notify(
                result.truncated
                  ? 'Website excerpt saved (first 30,000 characters).'
                  : 'Source added to the project library.',
              );
            })
          }
        />
      )}
      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} wide>
          <div className="source-preview">
            <div className="preview-meta">
              <Badge value="ready">Source text</Badge>
              {preview.url && <ExternalLink url={preview.url} />}
              <a
                className="button secondary"
                href={'/api' + base + '/sources/' + preview.id + '/download'}
              >
                <Download size={15} />
                Download
              </a>
            </div>
            <pre>{preview.content}</pre>
            <small className="fine-print">
              Captured {date(preview.created_at)} · Content fingerprint{' '}
              {preview.sha256.slice(0, 16)}
            </small>
          </div>
        </Modal>
      )}
      {remove && (
        <Modal title="Remove this source?" onClose={() => setRemove(null)}>
          <div className="form-stack">
            <p>
              Remove <strong>{remove.title}</strong> from the current library? Published versions
              keep their original source text. This changes the training draft.
            </p>
            <div className="form-actions">
              <button className="button secondary" onClick={() => setRemove(null)}>
                Keep source
              </button>
              <button
                className="button danger"
                disabled={!!busy}
                onClick={() =>
                  void perform('remove', async () => {
                    await api(base + '/sources/' + remove.id, {
                      method: 'DELETE',
                      body: json({ revision: project.revision }),
                    });
                    setRemove(null);
                    onChange();
                    notify('Source removed from the draft library.');
                  })
                }
              >
                Remove source
              </button>
            </div>
          </div>
        </Modal>
      )}
      {oldVersion && (
        <Modal
          title={'Training version ' + oldVersion.version}
          onClose={() => setOldVersion(null)}
          wide
        >
          <div className="source-preview">
            <h3>{oldVersion.snapshot.project.name}</h3>
            <p>{oldVersion.snapshot.rubric.summary}</p>
            <h4>Positive criteria</h4>
            <ul>
              {oldVersion.snapshot.rubric.criteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <h4>Exclusions</h4>
            <ul>
              {oldVersion.snapshot.rubric.exclusions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <h4>Preserved source context</h4>
            {oldVersion.snapshot.sources.map((s) => (
              <details key={s.id}>
                <summary>{s.title}</summary>
                {s.url && <ExternalLink url={s.url} />}
                <pre>{s.content}</pre>
              </details>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
function ShieldCheckIcon() {
  return <CheckCircle2 size={19} className="green" />;
}
function SourceForm({
  mode,
  website,
  busy,
  requestError,
  onClose,
  onSubmit,
}: {
  mode: 'note' | 'website';
  website: string;
  busy: boolean;
  requestError: string;
  onClose: () => void;
  onSubmit: (data: Record<string, FormDataEntryValue>) => Promise<void>;
}) {
  const [error, setError] = useState('');
  return (
    <Modal
      title={mode === 'website' ? 'Capture website context' : 'Add research notes'}
      onClose={onClose}
    >
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          try {
            await onSubmit(Object.fromEntries(new FormData(e.currentTarget)));
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {mode === 'website' ? (
          <>
            <p className="muted">
              Capture a public page as a source for your project training. Product, company and
              application pages work well.
            </p>
            <label>
              Website URL
              <input
                name="url"
                type="url"
                required
                defaultValue={website}
                placeholder="https://example.com/products"
                autoFocus
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Source title
              <input
                name="title"
                required
                maxLength={200}
                placeholder="e.g. Ideal customer profile"
                autoFocus
              />
            </label>
            <label>
              Training notes
              <textarea
                name="content"
                rows={10}
                required
                minLength={40}
                maxLength={60000}
                placeholder="Describe your business, target customers, qualification criteria and examples…"
              />
            </label>
          </>
        )}
        {(error || requestError) && <Alert>{error || requestError}</Alert>}
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Spinner text={mode === 'website' ? 'Reading website…' : 'Saving…'} />
            ) : mode === 'website' ? (
              'Capture website'
            ) : (
              'Add notes'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  LayoutTemplate,
  Mail,
  Minus,
  MoveVertical,
  Quote,
  SquareMousePointer,
  Trash2,
  Type,
  Heading as HeadingIcon,
  Monitor,
  Smartphone,
  TriangleAlert,
} from 'lucide-react';
import type { EmailBlock, EmailTemplate, Lead, TemplateCategory } from '../shared/types';
import { api, json } from './api';
import { Alert, Spinner } from './ui';

type Device = 'desktop' | 'mobile';
interface Palette {
  type: EmailBlock['type'];
  label: string;
  icon: typeof Type;
  make: () => EmailBlock;
}
/** The closed set the editor can produce. The renderer vouches for exactly these. */
const palette: Palette[] = [
  {
    type: 'heading',
    label: 'Heading',
    icon: HeadingIcon,
    make: () => ({ type: 'heading', text: 'A short heading', level: 'h1', align: 'left' }),
  },
  {
    type: 'text',
    label: 'Text',
    icon: Type,
    make: () => ({ type: 'text', text: 'Write your message here.', align: 'left' }),
  },
  {
    type: 'button',
    label: 'Button',
    icon: SquareMousePointer,
    make: () => ({ type: 'button', label: 'Book a call', url: 'https://', align: 'left' }),
  },
  {
    type: 'image',
    label: 'Image',
    icon: ImageIcon,
    make: () => ({ type: 'image', url: 'https://', alt: 'Describe the image', width: 560 }),
  },
  {
    type: 'quote',
    label: 'Quote',
    icon: Quote,
    make: () => ({ type: 'quote', text: 'A short quotation.', cite: '' }),
  },
  { type: 'divider', label: 'Divider', icon: Minus, make: () => ({ type: 'divider' }) },
  {
    type: 'spacer',
    label: 'Spacer',
    icon: MoveVertical,
    make: () => ({ type: 'spacer', size: 'medium' }),
  },
];

/**
 * Block-based email editor. Blocks are edited as structured fields rather than as free
 * HTML, because the delivered markup has to survive Outlook — the server renders the
 * blocks into table-based, inline-styled HTML and reports its own pre-send checks.
 */
export function EmailComposer({
  base,
  lead,
  onSent,
}: {
  base: string;
  lead: Lead;
  onSent: () => void;
}) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [categories, setCategories] = useState<Array<{ value: string; label: string }>>([]);
  const [mergeFields, setMergeFields] = useState<string[]>([]);
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [picking, setPicking] = useState(true);
  const [blocks, setBlocks] = useState<EmailBlock[]>([]);
  const [subject, setSubject] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [to, setTo] = useState(lead.contact_email);
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
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{
        templates: EmailTemplate[];
        categories: Array<{ value: string; label: string }>;
        merge_fields: string[];
      }>('/email/templates'),
      api<{ to: string; mailbox: { configured: boolean; from_email: string } }>(
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
  }, [base]);

  // The preview is rendered by the server, so what is shown is what will be delivered.
  useEffect(() => {
    if (picking || !blocks.length) return;
    if (renderTimer.current) clearTimeout(renderTimer.current);
    renderTimer.current = setTimeout(() => {
      api<{
        html: string;
        warnings: string[];
        block_problems: Array<{ index: number; type: string; message: string }>;
      }>(base + '/email/preview', {
        method: 'POST',
        body: json({ subject, preview_text: previewText, blocks }),
      })
        .then((result) => {
          setPreview(result.html);
          setWarnings(result.warnings);
          setBlockProblems(result.block_problems || []);
          setError('');
        })
        .catch((e) => setError((e as Error).message));
    }, 400);
    return () => {
      if (renderTimer.current) clearTimeout(renderTimer.current);
    };
  }, [blocks, subject, previewText, picking, base]);

  const shown = useMemo(
    () => templates.filter((t) => category === 'all' || t.category === category),
    [templates, category],
  );
  const update = (index: number, patch: Partial<EmailBlock>) =>
    setBlocks((current) =>
      current.map((block, i) => (i === index ? ({ ...block, ...patch } as EmailBlock) : block)),
    );
  const move = (index: number, delta: number) =>
    setBlocks((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      setSelected(target);
      return next;
    });

  if (loading) return <Spinner text="Loading the editor…" />;

  if (picking)
    return (
      <div className="composer">
        {error && <Alert>{error}</Alert>}
        {mailbox && !mailbox.configured && (
          <Alert>
            No workspace mailbox is configured yet. An administrator sets it up in Workspace
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
      <div className="composer-head">
        <div>
          <span className="eyebrow">EDITING</span>
          <h3>{subject || 'Untitled email'}</h3>
        </div>
        <div className="composer-head-actions">
          <button className="text-button" onClick={() => setPicking(true)}>
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

          <div className="merge-row">
            <span>Merge fields</span>
            {mergeFields.map((field) => (
              <button
                key={field}
                className="chip"
                title={'Insert {{' + field + '}} into the selected block'}
                onClick={() => {
                  const block = blocks[selected];
                  if (!block) return;
                  const token = ' {{' + field + '}}';
                  if (block.type === 'heading' || block.type === 'text' || block.type === 'quote')
                    update(selected, { text: block.text + token } as Partial<EmailBlock>);
                  else if (block.type === 'button')
                    update(selected, { label: block.label + token } as Partial<EmailBlock>);
                }}
              >
                {'{{' + field + '}}'}
              </button>
            ))}
          </div>

          <div className="palette-row">
            {palette.map((item) => (
              <button
                key={item.type}
                className="chip"
                onClick={() => {
                  setBlocks((current) => [...current, item.make()]);
                  setSelected(blocks.length);
                }}
              >
                <item.icon size={13} />
                {item.label}
              </button>
            ))}
          </div>

          <div className="block-list">
            {blocks.map((block, index) => (
              <div
                key={index}
                className={'block-card ' + (selected === index ? 'is-selected' : '')}
                onFocus={() => setSelected(index)}
                onClick={() => setSelected(index)}
              >
                <div className="block-card-head">
                  <strong>{palette.find((p) => p.type === block.type)?.label || block.type}</strong>
                  <button
                    className="icon-button"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ChevronUp size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Move down"
                    disabled={index === blocks.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ChevronDown size={15} />
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label="Remove block"
                    disabled={blocks.length === 1}
                    onClick={() => setBlocks((c) => c.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <BlockFields block={block} onChange={(patch) => update(index, patch)} />
                {blockProblems
                  .filter((problem) => problem.index === index)
                  .map((problem, i) => (
                    <p className="block-problem" key={i}>
                      <TriangleAlert size={13} />
                      {problem.message}
                    </p>
                  ))}
              </div>
            ))}
          </div>
        </div>

        <div className="composer-preview">
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
    </div>
  );
}

function BlockFields({
  block,
  onChange,
}: {
  block: EmailBlock;
  onChange: (patch: Partial<EmailBlock>) => void;
}) {
  const alignment = (value: 'left' | 'center') => (
    <div className="align-toggle">
      <button
        className={value === 'left' ? 'is-on' : ''}
        aria-label="Align left"
        onClick={() => onChange({ align: 'left' } as Partial<EmailBlock>)}
      >
        <AlignLeft size={14} />
      </button>
      <button
        className={value === 'center' ? 'is-on' : ''}
        aria-label="Align centre"
        onClick={() => onChange({ align: 'center' } as Partial<EmailBlock>)}
      >
        <AlignCenter size={14} />
      </button>
    </div>
  );
  switch (block.type) {
    case 'heading':
      return (
        <div className="form-stack">
          <input
            value={block.text}
            maxLength={200}
            onChange={(e) => onChange({ text: e.target.value } as Partial<EmailBlock>)}
          />
          <div className="block-controls">
            <select
              value={block.level}
              onChange={(e) => onChange({ level: e.target.value } as Partial<EmailBlock>)}
            >
              <option value="h1">Large</option>
              <option value="h2">Small</option>
            </select>
            {alignment(block.align)}
          </div>
        </div>
      );
    case 'text':
      return (
        <div className="form-stack">
          <textarea
            value={block.text}
            rows={4}
            maxLength={4000}
            onChange={(e) => onChange({ text: e.target.value } as Partial<EmailBlock>)}
          />
          <div className="block-controls">{alignment(block.align)}</div>
        </div>
      );
    case 'button':
      return (
        <div className="form-stack">
          <div className="form-grid">
            <label>
              Label
              <input
                value={block.label}
                maxLength={60}
                onChange={(e) => onChange({ label: e.target.value } as Partial<EmailBlock>)}
              />
            </label>
            <label>
              Link
              <input
                type="url"
                value={block.url}
                maxLength={2000}
                onChange={(e) => onChange({ url: e.target.value } as Partial<EmailBlock>)}
              />
            </label>
          </div>
          <div className="block-controls">{alignment(block.align)}</div>
        </div>
      );
    case 'image':
      return (
        <div className="form-stack">
          <div className="form-grid">
            <label>
              Image URL
              <input
                type="url"
                value={block.url}
                maxLength={2000}
                onChange={(e) => onChange({ url: e.target.value } as Partial<EmailBlock>)}
              />
            </label>
            <label>
              Width
              <input
                type="number"
                min={40}
                max={560}
                value={block.width}
                onChange={(e) => onChange({ width: Number(e.target.value) } as Partial<EmailBlock>)}
              />
            </label>
          </div>
          <label>
            Alt text
            <input
              value={block.alt}
              maxLength={200}
              onChange={(e) => onChange({ alt: e.target.value } as Partial<EmailBlock>)}
            />
            <small>Read aloud, and shown when images are blocked.</small>
          </label>
        </div>
      );
    case 'quote':
      return (
        <div className="form-stack">
          <textarea
            value={block.text}
            rows={3}
            maxLength={1000}
            onChange={(e) => onChange({ text: e.target.value } as Partial<EmailBlock>)}
          />
          <label>
            Attribution
            <input
              value={block.cite}
              maxLength={120}
              onChange={(e) => onChange({ cite: e.target.value } as Partial<EmailBlock>)}
            />
          </label>
        </div>
      );
    case 'spacer':
      return (
        <div className="block-controls">
          <select
            value={block.size}
            onChange={(e) => onChange({ size: e.target.value } as Partial<EmailBlock>)}
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </div>
      );
    case 'divider':
      return <p className="muted">A horizontal rule.</p>;
  }
}

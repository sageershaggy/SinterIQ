import {
  AlignCenter,
  AlignLeft,
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  Minus,
  MoveVertical,
  Quote,
  SquareMousePointer,
  Trash2,
  Type,
  Heading as HeadingIcon,
  TriangleAlert,
} from 'lucide-react';
import type { EmailBlock } from '../shared/types';

export interface Palette {
  type: EmailBlock['type'];
  label: string;
  icon: typeof Type;
  make: () => EmailBlock;
}
/** The closed set the editor can produce. The renderer vouches for exactly these. */
export const palette: Palette[] = [
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
 * The editing half of a block-based email: merge fields, the palette and the block cards.
 * Blocks are edited as structured fields rather than as free HTML, because the delivered
 * markup has to survive Outlook — the server renders them and reports its own checks, so
 * the problems shown per block are the server's, never a second opinion invented here.
 *
 * Every button is type="button" so the editor can sit inside a form — the funnel editor is
 * one — without a block edit submitting it.
 */
export function BlockEditor({
  blocks,
  onChange,
  mergeFields,
  problems,
  selected,
  onSelect,
}: {
  blocks: EmailBlock[];
  onChange: (blocks: EmailBlock[]) => void;
  mergeFields: string[];
  problems: Array<{ index: number; message: string }>;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const update = (index: number, patch: Partial<EmailBlock>) =>
    onChange(
      blocks.map((block, i) => (i === index ? ({ ...block, ...patch } as EmailBlock) : block)),
    );
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    onSelect(target);
  };
  return (
    <>
      <div className="merge-row">
        <span>Merge fields</span>
        {mergeFields.map((field) => (
          <button
            key={field}
            type="button"
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
            type="button"
            className="chip"
            onClick={() => {
              onChange([...blocks, item.make()]);
              onSelect(blocks.length);
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
            onFocus={() => onSelect(index)}
            onClick={() => onSelect(index)}
          >
            <div className="block-card-head">
              <strong>{palette.find((p) => p.type === block.type)?.label || block.type}</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ChevronUp size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Move down"
                disabled={index === blocks.length - 1}
                onClick={() => move(index, 1)}
              >
                <ChevronDown size={15} />
              </button>
              <button
                type="button"
                className="icon-button danger"
                aria-label="Remove block"
                disabled={blocks.length === 1}
                onClick={() => onChange(blocks.filter((_, i) => i !== index))}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <BlockFields block={block} onChange={(patch) => update(index, patch)} />
            {problems
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
    </>
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
        type="button"
        className={value === 'left' ? 'is-on' : ''}
        aria-label="Align left"
        onClick={() => onChange({ align: 'left' } as Partial<EmailBlock>)}
      >
        <AlignLeft size={14} />
      </button>
      <button
        type="button"
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

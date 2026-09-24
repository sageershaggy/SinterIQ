import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Bold,
  Braces,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Underline,
  Unlink,
} from 'lucide-react';
import type { EmailFile } from '../shared/email';
import { maxImageWidth, safeLink, sanitizeEmailHtml } from '../shared/email-html';
import { fileUrl, uploadEmailFile } from './emailFiles';
import './RichEmailEditor.css';

/**
 * A simple single-screen rich-text editor for email: bold, italic, underline, headings, lists,
 * links, images, quotes and merge fields, and nothing a mail client cannot show.
 *
 * The browser's editing surface does the typing; everything it produces is passed through the
 * shared email allowlist before it leaves this component, and the server runs the same
 * allowlist again before storing or sending. Pasted content is cleaned on the way in, and a
 * pasted or dropped picture is uploaded to the project rather than embedded.
 */
export function RichEmailEditor({
  value,
  onChange,
  projectId,
  mergeFields,
  label = 'Message',
  placeholder = 'Write your message…',
  onError,
}: {
  value: string;
  onChange: (html: string) => void;
  projectId: number;
  mergeFields: string[];
  label?: string;
  placeholder?: string;
  onError?: (message: string) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  /** What the editor last reported or was given, so outside changes can be told apart. */
  const current = useRef<string | null>(null);
  const saved = useRef<Range | null>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [linking, setLinking] = useState(false),
    [link, setLink] = useState('https://'),
    [linkError, setLinkError] = useState('');
  const [fields, setFields] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editor.current || value === current.current) return;
    editor.current.innerHTML = value;
    current.current = value;
  }, [value]);
  useEffect(() => {
    try {
      // New lines become paragraphs, which is what the allowlist and the renderer expect.
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch {
      /* Older engines ignore the setting; <div> is mapped to <p> by the sanitizer anyway. */
    }
    const track = () => {
      const selection = document.getSelection();
      if (!selection?.rangeCount || !editor.current?.contains(selection.anchorNode)) return;
      const block = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
      setActive({
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        insertUnorderedList: document.queryCommandState('insertUnorderedList'),
        insertOrderedList: document.queryCommandState('insertOrderedList'),
        h2: block === 'h2',
        h3: block === 'h3',
        blockquote: block === 'blockquote',
      });
    };
    document.addEventListener('selectionchange', track);
    return () => document.removeEventListener('selectionchange', track);
  }, []);

  function emit() {
    if (!editor.current) return;
    const html = sanitizeEmailHtml(editor.current.innerHTML, { projectId });
    current.current = html;
    onChange(html);
  }
  function remember() {
    const selection = document.getSelection();
    if (selection?.rangeCount && editor.current?.contains(selection.anchorNode))
      saved.current = selection.getRangeAt(0).cloneRange();
  }
  function restore() {
    editor.current?.focus();
    const selection = document.getSelection();
    if (saved.current && selection) {
      selection.removeAllRanges();
      selection.addRange(saved.current);
    }
  }
  function run(command: string, argument?: string) {
    editor.current?.focus();
    document.execCommand(command, false, argument);
    emit();
  }
  function block(tag: 'h2' | 'h3' | 'blockquote') {
    const currentBlock = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
    run('formatBlock', currentBlock === tag ? '<p>' : '<' + tag + '>');
  }
  function insertHtml(html: string) {
    restore();
    document.execCommand('insertHTML', false, sanitizeEmailHtml(html, { projectId }));
    emit();
  }
  async function addImages(files: File[]) {
    const images = files.filter((file) => /^image\/(png|jpeg)$/.test(file.type));
    if (!images.length) {
      onError?.('Add a PNG or JPG image.');
      return;
    }
    setUploading(true);
    try {
      for (const file of images) {
        const stored: EmailFile = await uploadEmailFile(projectId, file, 'image');
        const width = stored.width ? Math.min(stored.width, maxImageWidth) : maxImageWidth;
        const alt = stored.filename.replace(/\.[a-z]+$/i, '').replace(/"/g, '');
        insertHtml(
          '<img src="' +
            fileUrl(projectId, stored.id) +
            '" alt="' +
            alt +
            '" width="' +
            width +
            '">',
        );
      }
    } catch (e) {
      onError?.((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  function applyLink() {
    const href = safeLink(link);
    if (!href) {
      setLinkError('Use a full https:// address or a mailto: address.');
      return;
    }
    restore();
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed)
      document.execCommand(
        'insertHTML',
        false,
        sanitizeEmailHtml('<a href="' + href.replace(/"/g, '%22') + '">' + href + '</a>'),
      );
    else document.execCommand('createLink', false, href);
    emit();
    setLinking(false);
  }
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      remember();
      setLink('https://');
      setLinkError('');
      setLinking(true);
    }
  };
  const tool = (
    name: string,
    title: string,
    Icon: typeof Bold,
    action: () => void,
    pressed?: boolean,
  ) => (
    <button
      type="button"
      className={'rte-tool' + (pressed ? ' is-on' : '')}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      // Keep the text selection: a mousedown on a button would otherwise take the focus.
      onMouseDown={(event) => event.preventDefault()}
      onClick={action}
      key={name}
    >
      <Icon size={15} />
    </button>
  );
  return (
    <div className="rte">
      <div className="rte-toolbar" role="toolbar" aria-label={label + ' formatting'}>
        {tool('bold', 'Bold', Bold, () => run('bold'), active.bold)}
        {tool('italic', 'Italic', Italic, () => run('italic'), active.italic)}
        {tool('underline', 'Underline', Underline, () => run('underline'), active.underline)}
        <span className="rte-divider" />
        {tool('h2', 'Heading', Heading2, () => block('h2'), active.h2)}
        {tool('h3', 'Subheading', Heading3, () => block('h3'), active.h3)}
        {tool(
          'ul',
          'Bulleted list',
          List,
          () => run('insertUnorderedList'),
          active.insertUnorderedList,
        )}
        {tool(
          'ol',
          'Numbered list',
          ListOrdered,
          () => run('insertOrderedList'),
          active.insertOrderedList,
        )}
        {tool('quote', 'Quote', Quote, () => block('blockquote'), active.blockquote)}
        <span className="rte-divider" />
        {tool('link', 'Link (Ctrl+K)', Link2, () => {
          remember();
          setLink('https://');
          setLinkError('');
          setLinking(true);
        })}
        {tool('unlink', 'Remove link', Unlink, () => run('unlink'))}
        {tool('image', uploading ? 'Uploading image…' : 'Image', ImageIcon, () => {
          remember();
          fileInput.current?.click();
        })}
        <div className="rte-fields">
          <button
            type="button"
            className="rte-tool rte-tool-wide"
            aria-haspopup="menu"
            aria-expanded={fields}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              remember();
              setFields((open) => !open);
            }}
          >
            <Braces size={15} />
            Merge field
          </button>
          {fields && (
            <div className="rte-menu" role="menu">
              {mergeFields.map((field) => (
                <button
                  key={field}
                  type="button"
                  role="menuitem"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    restore();
                    document.execCommand('insertText', false, '{{' + field + '}}');
                    emit();
                    setFields(false);
                  }}
                >
                  {'{{' + field + '}}'}
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(event) => {
            const files = [...(event.target.files || [])];
            event.target.value = '';
            void addImages(files);
          }}
        />
      </div>
      {linking && (
        <div className="rte-linkbar">
          <label>
            Link address
            <input
              autoFocus
              value={link}
              maxLength={2000}
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyLink();
                }
                if (event.key === 'Escape') setLinking(false);
              }}
            />
          </label>
          <button type="button" className="button small primary" onClick={applyLink}>
            Add link
          </button>
          <button type="button" className="text-button" onClick={() => setLinking(false)}>
            Cancel
          </button>
          {linkError && <small className="rte-error">{linkError}</small>}
        </div>
      )}
      <div
        ref={editor}
        className="rte-surface"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        data-placeholder={placeholder}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={remember}
        onKeyDown={keys}
        onPaste={(event) => {
          event.preventDefault();
          const files = [...event.clipboardData.files];
          if (files.length) {
            remember();
            void addImages(files);
            return;
          }
          const html = event.clipboardData.getData('text/html');
          const text = event.clipboardData.getData('text/plain');
          if (html)
            document.execCommand('insertHTML', false, sanitizeEmailHtml(html, { projectId }));
          else document.execCommand('insertText', false, text);
          emit();
        }}
        onDrop={(event) => {
          const files = [...event.dataTransfer.files];
          if (!files.length) return;
          event.preventDefault();
          remember();
          void addImages(files);
        }}
      />
    </div>
  );
}

import type { EmailBlock } from './types';

/**
 * The one HTML dialect an email body may be written in.
 *
 * The rich-text editor produces it, templates and campaign messages store it, and the server
 * renders it into Outlook-safe tables with inline styles. Everything else is dropped: a pasted
 * Word document, a <script>, an event handler, a style sheet or a data: image cannot survive a
 * pass through here. The browser runs this to keep what it shows honest; the server runs it
 * again on everything it stores or sends, because only the server's copy is trusted.
 */
export const emailTags = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'a',
  'img',
  'h2',
  'h3',
  'blockquote',
] as const;
export type EmailTag = (typeof emailTags)[number];
export type Align = 'left' | 'center' | 'right';
export interface EmailElement {
  type: 'element';
  tag: EmailTag;
  href?: string;
  src?: string;
  alt?: string;
  width?: number;
  align?: Align;
  children: EmailNode[];
}
export type EmailNode = { type: 'text'; text: string } | EmailElement;

/** The longest body the editor may submit. A long email is a few kilobytes of markup. */
export const maxEmailHtml = 200_000;
/** The widest an image can be drawn inside the 560px email panel. */
export const maxImageWidth = 560;

const allowed = new Set<string>(emailTags);
/** Common tags with an allowed equivalent: browsers write <div> for a new line, Word writes <h1>. */
const renamed: Record<string, EmailTag> = {
  div: 'p',
  section: 'p',
  article: 'p',
  header: 'p',
  footer: 'p',
  h1: 'h2',
  h4: 'h3',
  h5: 'h3',
  h6: 'h3',
};
/** Everything inside these is dropped, not just the tag: their content is code or chrome. */
const dropped = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'noscript',
  'template',
  'svg',
  'math',
  'head',
  'title',
  'textarea',
  'select',
  'option',
  'button',
  'xmp',
  'noembed',
  'noframes',
  'frameset',
  'frame',
  'canvas',
  'video',
  'audio',
  'picture',
  'form',
]);
const blocks = new Set<EmailTag>(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote']);
const textBlocks = new Set<EmailTag>(['p', 'h2', 'h3']);
const voids = new Set<EmailTag>(['br', 'img']);
const maxDepth = 24;

const named: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  deg: '°',
};
export function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1));
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        return '';
      return String.fromCodePoint(code);
    }
    return named[body.toLowerCase()] ?? whole;
  });
}
export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
/** Control characters never belong in a message; tabs and newlines are only whitespace here. */
const cleanText = (value: string) =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[\r\n\t]+/g, ' ');

/** A project-scoped stored file, the only kind of image source that is not a public URL. */
export const filePath = (projectId: number, fileId: number) =>
  '/api/projects/' + projectId + '/email/files/' + fileId;
const filePattern = /^\/api\/projects\/([1-9]\d{0,9})\/email\/files\/([1-9]\d{0,12})$/;
export function fileIdFromSrc(src: string, projectId?: number) {
  const match = filePattern.exec(src);
  if (!match) return null;
  if (projectId !== undefined && Number(match[1]) !== projectId) return null;
  return Number(match[2]);
}

/** Links go to the web or to an address. javascript:, data: and relative links never do. */
export function safeLink(value: string | undefined) {
  const href = (value || '').trim();
  if (!href || href.length > 2000 || /[\s<>"]/.test(href.replace(/\{\{[^}]*\}\}/g, ''))) return;
  if (/^mailto:(?:[^@\s]{1,200}@[^@\s]{1,200}|\{\{\s*[a-z_]{1,40}\s*\}\})$/i.test(href))
    return href;
  if (!/^https?:\/\//i.test(href)) return;
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return href;
  } catch {
    return;
  }
}
/** Images come from a public URL or from this project's own uploads. Never data: or file:. */
export function safeImage(value: string | undefined, projectId?: number) {
  const src = (value || '').trim();
  if (fileIdFromSrc(src, projectId) !== null) return src;
  if (!/^https?:\/\//i.test(src) || src.length > 2000 || /[\s<>"]/.test(src)) return;
  try {
    const url = new URL(src);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return src;
  } catch {
    return;
  }
}

function attributes(raw: string) {
  const found: Record<string, string> = {};
  for (const match of raw.matchAll(
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    const name = match[1].toLowerCase();
    if (!(name in found)) found[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return found;
}
function alignment(attrs: Record<string, string>): Align | undefined {
  const fromStyle = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\b/i.exec(attrs.style || '');
  const value = (fromStyle?.[1] || attrs.align || '').toLowerCase();
  return value === 'center' || value === 'right' ? value : undefined;
}

/**
 * Parses untrusted markup into the allowed tree. Tags outside the allowlist are unwrapped (their
 * text is kept) unless they hold code, whose content goes too. Nesting is repaired the way a
 * browser would: a new paragraph closes the open one, a link never contains another link.
 */
export function parseEmailHtml(input: string, options: { projectId?: number } = {}): EmailNode[] {
  const root: EmailElement = { type: 'element', tag: 'p', children: [] };
  const stack: EmailElement[] = [root];
  const top = () => stack[stack.length - 1];
  const has = (tag: EmailTag) => stack.some((node, index) => index > 0 && node.tag === tag);
  const closeTo = (index: number) => {
    stack.length = Math.max(1, index);
  };
  const closeTag = (tag: EmailTag) => {
    for (let index = stack.length - 1; index > 0; index--)
      if (stack[index].tag === tag) return closeTo(index);
  };
  const text = (value: string) => {
    const clean = cleanText(decodeEntities(value));
    if (clean) top().children.push({ type: 'text', text: clean });
  };
  const open = (tag: EmailTag, attrs: Record<string, string>) => {
    if (blocks.has(tag)) {
      // A block cannot sit inside a paragraph, a heading or inline formatting; the browser
      // closes those first. Lists, list items and quotes may hold blocks, so they stay open.
      while (stack.length > 1 && (textBlocks.has(top().tag) || !blocks.has(top().tag)))
        closeTo(stack.length - 1);
      if (tag === 'li') {
        // A list item closes its open sibling; one outside any list becomes a paragraph.
        const list = [...stack]
          .reverse()
          .findIndex((node) => node.tag === 'ul' || node.tag === 'ol');
        if (list === -1) tag = 'p';
        else if (top().tag === 'li') closeTo(stack.length - 1);
      }
    }
    if (tag === 'a' && has('a')) closeTag('a');
    if (stack.length > maxDepth) return;
    const node: EmailElement = { type: 'element', tag, children: [] };
    if (tag === 'a') {
      const href = safeLink(attrs.href);
      if (!href) return;
      node.href = href;
    }
    if (tag === 'img') {
      const src = safeImage(attrs.src, options.projectId);
      if (!src) return;
      node.src = src;
      node.alt = cleanText(attrs.alt || '')
        .trim()
        .slice(0, 200);
      const width = Number.parseInt(attrs.width || '', 10);
      if (Number.isFinite(width) && width >= 16) node.width = Math.min(width, maxImageWidth);
    }
    if (tag === 'p' || tag === 'h2' || tag === 'h3' || tag === 'li') {
      const align = alignment(attrs);
      if (align) node.align = align;
    }
    top().children.push(node);
    if (!voids.has(tag)) stack.push(node);
  };
  const token =
    /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>?|<\?[^>]*>?|<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,30})((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  let skip = '';
  const source = input.slice(0, maxEmailHtml);
  for (const match of source.matchAll(token)) {
    const index = match.index ?? 0;
    if (!skip && index > last) text(source.slice(last, index));
    last = index + match[0].length;
    if (!match[2]) continue;
    const closing = match[1] === '/';
    const raw = match[2].toLowerCase();
    if (skip) {
      if (closing && raw === skip) skip = '';
      continue;
    }
    if (dropped.has(raw)) {
      if (!closing && !/\/\s*$/.test(match[3])) skip = raw;
      continue;
    }
    const tag = allowed.has(raw) ? (raw as EmailTag) : renamed[raw];
    if (!tag) {
      // An unknown row or cell still separates text, so words do not run together.
      if (!closing && /^(tr|td|th|table|dd|dt)$/.test(raw)) text(' ');
      continue;
    }
    if (closing) {
      if (!voids.has(tag)) closeTag(tag);
    } else open(tag, attributes(match[3]));
  }
  if (!skip && last < source.length) text(source.slice(last));
  return normalize(root.children, true);
}

const isEmpty = (node: EmailNode): boolean =>
  node.type === 'text'
    ? !node.text.trim()
    : node.tag !== 'br' && node.tag !== 'img' && node.children.every(isEmpty);
/**
 * Tidies a parsed tree: text left at the top level goes into a paragraph, and empty formatting
 * and empty paragraphs disappear. A blank line the author typed arrives as <p><br></p>, which
 * has content and stays; a paragraph a browser opened and a list closed at once does not.
 */
function normalize(nodes: EmailNode[], topLevel: boolean): EmailNode[] {
  const output: EmailNode[] = [];
  let loose: EmailNode[] = [];
  const flush = () => {
    if (loose.some((node) => !isEmpty(node)))
      output.push({ type: 'element', tag: 'p', children: normalize(loose, false) });
    loose = [];
  };
  for (const node of nodes) {
    if (node.type === 'element') {
      node.children = normalize(node.children, false);
      if (node.tag === 'ul' || node.tag === 'ol') {
        // A list holds list items only. Anything else, such as the nested list an indent
        // produces, joins the item before it rather than being lost.
        const items: EmailElement[] = [];
        for (const child of node.children) {
          if (child.type === 'element' && child.tag === 'li') items.push(child);
          else if (!isEmpty(child)) {
            const previous = items[items.length - 1];
            if (previous) previous.children.push(child);
            else items.push({ type: 'element', tag: 'li', children: [child] });
          }
        }
        node.children = items;
      }
      const inline = !blocks.has(node.tag);
      if (topLevel && inline) {
        loose.push(node);
        continue;
      }
      flush();
      if (!voids.has(node.tag) && !node.children.length) continue;
      output.push(node);
    } else if (topLevel) loose.push(node);
    else {
      const previous = output[output.length - 1];
      if (previous?.type === 'text') previous.text += node.text;
      else output.push({ ...node });
    }
  }
  flush();
  return output;
}

/** Serializes the tree back to canonical markup: the form the editor, drafts and storage use. */
export function serializeEmailHtml(nodes: EmailNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return escapeHtml(node.text).replace(/\u00a0/g, '&nbsp;');
      if (node.tag === 'br') return '<br>';
      if (node.tag === 'img')
        return (
          '<img src="' +
          escapeHtml(node.src || '') +
          '" alt="' +
          escapeHtml(node.alt || '') +
          '"' +
          (node.width ? ' width="' + node.width + '"' : '') +
          '>'
        );
      const attrs =
        (node.href ? ' href="' + escapeHtml(node.href) + '"' : '') +
        (node.align ? ' style="text-align:' + node.align + '"' : '');
      return (
        '<' + node.tag + attrs + '>' + serializeEmailHtml(node.children) + '</' + node.tag + '>'
      );
    })
    .join('');
}
/** The canonical, allowlisted form of any markup. */
export function sanitizeEmailHtml(input: string, options: { projectId?: number } = {}) {
  return serializeEmailHtml(parseEmailHtml(input, options));
}

/** Plain text for the text/plain alternative, the history log and the AI prompt. */
export function emailText(nodes: EmailNode[]): string {
  const blocksOut: string[] = [];
  const inline = (list: EmailNode[]): string =>
    list
      .map((node) => {
        if (node.type === 'text') return node.text.replace(/\u00a0/g, ' ');
        if (node.tag === 'br') return '\n';
        if (node.tag === 'img') return node.alt ? '[' + node.alt + ']' : '';
        const inner = inline(node.children);
        if (node.tag === 'a' && node.href) {
          const target = node.href.replace(/^mailto:/i, '');
          return inner.trim() && inner.trim() !== target ? inner + ' (' + target + ')' : target;
        }
        return inner;
      })
      .join('');
  const tidy = (value: string) =>
    value
      .split('\n')
      .map((line) => line.replace(/[ ]{2,}/g, ' ').trim())
      .join('\n')
      .trim();
  const walk = (list: EmailNode[], quote = '') => {
    for (const node of list) {
      if (node.type === 'text' || !blocks.has(node.tag)) {
        const value = tidy(inline([node]));
        if (value) blocksOut.push(quote + value);
        continue;
      }
      if (node.tag === 'ul' || node.tag === 'ol') {
        const items = node.children.map(
          (item, index) =>
            quote +
            (node.tag === 'ol' ? index + 1 + '. ' : '- ') +
            tidy(inline(item.type === 'element' ? item.children : [item])),
        );
        blocksOut.push(items.join('\n'));
      } else if (node.tag === 'blockquote') walk(node.children, quote + '> ');
      else {
        const value = tidy(inline(node.children));
        if (value)
          blocksOut.push(
            quote + (node.tag === 'h2' || node.tag === 'h3' ? value.toUpperCase() : value),
          );
      }
    }
  };
  walk(nodes);
  return blocksOut.join('\n\n');
}
export const htmlToText = (html: string) => emailText(parseEmailHtml(html));
/** True when a body says something: words, or at least an image. */
export const hasContent = (html: string) => {
  const nodes = parseEmailHtml(html);
  return (
    Boolean(
      emailText(nodes)
        .replace(/\[[^\]]*\]/g, '')
        .trim(),
    ) || fileIds(nodes).length > 0
  );
};

/** Every stored upload an HTML body shows inline. */
export function fileIds(nodes: EmailNode[], projectId?: number): number[] {
  const found = new Set<number>();
  const walk = (list: EmailNode[]) => {
    for (const node of list) {
      if (node.type !== 'element') continue;
      if (node.tag === 'img' && node.src) {
        const id = fileIdFromSrc(node.src, projectId);
        if (id !== null) found.add(id);
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return [...found];
}
/** Merge fields a piece of text relies on, e.g. to show what data a campaign uses. */
export function mergeFieldsIn(...values: string[]) {
  const found = new Set<string>();
  for (const value of values)
    for (const match of value.matchAll(/\{\{\s*([a-z_]{1,40})\s*\}\}/gi))
      found.add(match[1].toLowerCase());
  return [...found];
}

/** Plain text written before rich text existed, one paragraph per blank-line-separated block. */
export function textToHtml(text: string) {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => '<p>' + escapeHtml(part).replace(/\n/g, '<br>') + '</p>')
    .join('');
}
/**
 * Opens a template or draft written with the old block editor in the rich-text editor. Buttons
 * become a bold link, a spacer a blank line; a divider has no counterpart and is left out.
 */
export function blocksToHtml(list: EmailBlock[]) {
  const align = (value: string) => (value === 'center' ? ' style="text-align:center"' : '');
  const lines = (value: string) => escapeHtml(value).replace(/\n/g, '<br>');
  const html = list
    .map((block) => {
      switch (block.type) {
        case 'heading': {
          const tag = block.level === 'h1' ? 'h2' : 'h3';
          return '<' + tag + align(block.align) + '>' + lines(block.text) + '</' + tag + '>';
        }
        case 'text':
          return block.text
            .split(/\n{2,}/)
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => '<p' + align(block.align) + '>' + lines(part) + '</p>')
            .join('');
        case 'button':
          return (
            '<p' +
            align(block.align) +
            '><a href="' +
            escapeHtml(block.url) +
            '"><strong>' +
            escapeHtml(block.label) +
            '</strong></a></p>'
          );
        case 'image':
          return (
            '<p><img src="' +
            escapeHtml(block.url) +
            '" alt="' +
            escapeHtml(block.alt) +
            '" width="' +
            block.width +
            '"></p>'
          );
        case 'quote':
          return (
            '<blockquote><p>' +
            lines(block.text) +
            '</p>' +
            (block.cite ? '<p>— ' + escapeHtml(block.cite) + '</p>' : '') +
            '</blockquote>'
          );
        case 'spacer':
          return '<p><br></p>';
        case 'divider':
          return '';
      }
    })
    .join('');
  return sanitizeEmailHtml(html);
}

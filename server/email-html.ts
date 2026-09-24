import {
  emailText,
  escapeHtml,
  fileIdFromSrc,
  fileIds,
  maxImageWidth,
  parseEmailHtml,
  safeLink,
  type EmailElement,
  type EmailNode,
  type EmailTag,
} from '../shared/email-html';
import { applyMerge, emailDocument, emailRow, type MergeContext } from './email-blocks';
import type { OutgoingFile } from './outreach';

/**
 * Renders an email written in the rich-text editor. The body is parsed through the shared
 * allowlist again — whatever the browser sent — then merged, given inline styles tag by tag,
 * and placed in the same presentation-table frame as every other designed email, because
 * Outlook ignores style sheets and most layout. Merge values are inserted as text, so a lead
 * field containing markup is escaped like any other text.
 */
const font = "font-family:-apple-system,'Segoe UI',Arial,sans-serif;";
const body = font + 'font-size:15px;line-height:1.65;color:#25352e;';
const styles: Partial<Record<EmailTag, string>> = {
  p: 'margin:0 0 16px;' + body,
  h2: 'margin:0 0 14px;' + font + 'font-size:22px;line-height:1.3;font-weight:700;color:#192e26;',
  h3: 'margin:0 0 12px;' + font + 'font-size:18px;line-height:1.35;font-weight:700;color:#192e26;',
  ul: 'margin:0 0 16px;padding:0 0 0 24px;' + body,
  ol: 'margin:0 0 16px;padding:0 0 0 24px;' + body,
  li: 'margin:0 0 6px;' + body,
  blockquote:
    'margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid #315a3f;font-style:italic;' +
    body,
  a: 'color:#315a3f;text-decoration:underline;',
};

export interface StoredImage {
  filename: string;
  content_type: string;
  data: Buffer;
  width: number | null;
}
export type ImageLoader = (ids: number[]) => Map<number, StoredImage>;

/** Substitutes merge fields in text, links and alt text; an unresolved one is reported. */
function merge(nodes: EmailNode[], context: MergeContext, missing: Set<string>): EmailNode[] {
  const value = (text: string) => {
    const result = applyMerge(text, context);
    result.missing.forEach((field) => missing.add(field));
    return result.merged;
  };
  return nodes.flatMap((node): EmailNode[] => {
    if (node.type === 'text') return [{ type: 'text', text: value(node.text) }];
    const copy: EmailElement = { ...node, children: merge(node.children, context, missing) };
    if (copy.alt) copy.alt = value(copy.alt);
    if (copy.href) {
      const href = safeLink(value(copy.href));
      // A link a merge made unusable keeps its words and loses the link.
      if (!href) return copy.children;
      copy.href = href;
    }
    return [copy];
  });
}

function serialize(
  nodes: EmailNode[],
  image: (node: EmailElement) => string | null,
  parent?: EmailTag,
): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return escapeHtml(node.text).replace(/\u00a0/g, '&nbsp;');
      if (node.tag === 'br') return '<br />';
      if (node.tag === 'img') {
        const src = image(node);
        if (!src) return node.alt ? escapeHtml('[' + node.alt + ']') : '';
        return (
          '<img src="' +
          escapeHtml(src) +
          '" alt="' +
          escapeHtml(node.alt || '') +
          '"' +
          (node.width ? ' width="' + node.width + '"' : '') +
          ' style="display:block;max-width:100%;height:auto;border:0;margin:0 0 12px;" />'
        );
      }
      let style = styles[node.tag] || '';
      // Paragraphs inside a list item or a quote take their spacing from the container.
      if (node.tag === 'p' && (parent === 'li' || parent === 'blockquote'))
        style = style.replace('margin:0 0 16px;', 'margin:0 0 8px;');
      if (node.align) style += 'text-align:' + node.align + ';';
      const attrs =
        (node.href ? ' href="' + escapeHtml(node.href) + '"' : '') +
        (style ? ' style="' + style + '"' : '');
      return (
        '<' +
        node.tag +
        attrs +
        '>' +
        serialize(node.children, image, node.tag) +
        '</' +
        node.tag +
        '>'
      );
    })
    .join('');
}

export interface RenderedHtmlEmail {
  html: string;
  text: string;
  missingMergeFields: string[];
  /** Uploaded images the HTML shows, as cid attachments (only in 'cid' mode). */
  inline: OutgoingFile[];
  nodes: EmailNode[];
}
export function renderHtmlEmail(
  source: string,
  options: {
    projectId: number;
    context: MergeContext;
    fromName: string;
    fromEmail: string;
    signature: string;
    previewText: string;
    includeFooter?: boolean;
    /** cid: attach uploaded images for delivery. data: embed them for the preview frame. */
    images: 'cid' | 'data';
    loadImages: ImageLoader;
  },
): RenderedHtmlEmail {
  const missing = new Set<string>();
  const nodes = merge(
    parseEmailHtml(source, { projectId: options.projectId }),
    options.context,
    missing,
  );
  const stored = options.loadImages(fileIds(nodes, options.projectId));
  const inline = new Map<number, OutgoingFile>();
  const image = (node: EmailElement) => {
    const id = fileIdFromSrc(node.src || '', options.projectId);
    if (id === null) return node.src || null;
    const file = stored.get(id);
    if (!file || !file.content_type.startsWith('image/')) return null;
    // Never wider than the panel: a phone photo would otherwise blow the layout in Outlook.
    if (!node.width && file.width) node.width = Math.min(file.width, maxImageWidth);
    if (options.images === 'data')
      return 'data:' + file.content_type + ';base64,' + file.data.toString('base64');
    const cid = 'file-' + id + '@innovista';
    inline.set(id, {
      fileId: id,
      filename: file.filename,
      content: file.data,
      contentType: file.content_type,
      cid,
    });
    return 'cid:' + cid;
  };
  const content = emailRow(serialize(nodes, image));
  const document = emailDocument(content, emailText(nodes), {
    ...options,
    previewText: applyMerge(options.previewText, options.context).merged,
  });
  return {
    html: document.html,
    text: document.text,
    missingMergeFields: [...missing],
    inline: [...inline.values()],
    nodes,
  };
}

/** Pre-send advice for a rich-text email; unresolved merge fields also block delivery. */
export function checkHtml(rendered: RenderedHtmlEmail, subject: string) {
  const warnings: string[] = [];
  if (rendered.missingMergeFields.length)
    warnings.push(
      'Unresolved merge field' +
        (rendered.missingMergeFields.length === 1 ? '' : 's') +
        ': ' +
        rendered.missingMergeFields.map((field) => '{{' + field + '}}').join(', ') +
        ' — fill these fields or edit the message before sending.',
    );
  let images = 0,
    unlabelled = 0,
    links = 0;
  const walk = (list: EmailNode[]) => {
    for (const node of list) {
      if (node.type !== 'element') continue;
      if (node.tag === 'img') {
        images++;
        if (!node.alt) unlabelled++;
      }
      if (node.tag === 'a') links++;
      walk(node.children);
    }
  };
  walk(rendered.nodes);
  if (unlabelled)
    warnings.push(
      (unlabelled === 1 ? 'An image has' : unlabelled + ' images have') +
        ' no description, so it is unreadable when images are blocked.',
    );
  if (
    !emailText(rendered.nodes)
      .replace(/\[[^\]]*\]/g, '')
      .trim()
  )
    warnings.push(images ? 'There is no text, only images.' : 'The message is empty.');
  if (subject.length > 70)
    warnings.push(
      'The subject is ' + subject.length + ' characters; most inboxes cut off near 70.',
    );
  if (/\b(guarantee[d]?|risk[- ]free|act now|limited time|100% free)\b/i.test(rendered.text))
    warnings.push('The wording contains claim language that commonly trips spam filters.');
  if (links > 5) warnings.push(links + ' links in one email reads as a promotion.');
  return warnings;
}

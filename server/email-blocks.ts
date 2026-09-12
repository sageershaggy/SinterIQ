import { z } from 'zod';
import { text, requiredText, webUrl } from './validation';

/**
 * A typed block model, rendered server-side into email-safe HTML.
 *
 * Deliberately NOT a rich-text/contenteditable model. Outlook renders through Word: no
 * flexbox, no grid, and <style> blocks are frequently stripped. Everything here emits
 * nested tables with inline styles, which is the only layout that survives everywhere.
 * Blocks are a closed set, so the editor can never produce markup the renderer cannot vouch for.
 */
export const blockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('heading'),
      text: requiredText(200),
      level: z.enum(['h1', 'h2']).default('h1'),
      align: z.enum(['left', 'center']).default('left'),
    })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      text: requiredText(4000),
      align: z.enum(['left', 'center']).default('left'),
    })
    .strict(),
  z
    .object({
      type: z.literal('button'),
      label: requiredText(60),
      url: webUrl.refine((value) => value.length > 0, 'A button needs a link.'),
      align: z.enum(['left', 'center']).default('left'),
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      url: webUrl.refine((value) => value.length > 0, 'An image needs a URL.'),
      alt: requiredText(200),
      width: z.coerce.number().int().min(40).max(560).default(560),
    })
    .strict(),
  z.object({ type: z.literal('divider') }).strict(),
  z
    .object({
      type: z.literal('spacer'),
      size: z.enum(['small', 'medium', 'large']).default('medium'),
    })
    .strict(),
  z
    .object({ type: z.literal('quote'), text: requiredText(1000), cite: text(120).default('') })
    .strict(),
]);
export type EmailBlock = z.infer<typeof blockSchema>;
export const blocksSchema = z.array(blockSchema).min(1).max(60);

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The only substitutions allowed. An unknown field is left visible rather than blanked. */
export const mergeFields = [
  'company',
  'contact_name',
  'contact_first_name',
  'contact_role',
  'city',
  'country',
  'industry',
  'sender_name',
] as const;
export type MergeContext = Record<(typeof mergeFields)[number], string>;
/**
 * Substitution happens on the raw text, before escaping, so a value containing HTML is
 * still escaped by the renderer. An unresolved field is reported, never silently dropped.
 */
export function applyMerge(value: string, context: MergeContext) {
  const missing = new Set<string>();
  const merged = value.replace(/\{\{\s*([a-z_]{1,40})\s*\}\}/gi, (whole, rawKey: string) => {
    const key = rawKey.toLowerCase() as (typeof mergeFields)[number];
    if (!mergeFields.includes(key)) {
      missing.add(rawKey);
      return whole;
    }
    const replacement = context[key];
    if (!replacement) {
      missing.add(rawKey);
      return whole;
    }
    return replacement;
  });
  return { merged, missing: [...missing] };
}

const PANEL = 560;
const row = (content: string, padding = '0 32px') =>
  '<tr><td style="padding:' +
  padding +
  ";font-family:-apple-system,'Segoe UI',Arial,sans-serif;\">" +
  content +
  '</td></tr>';
const inline = (value: string) => escapeHtml(value).replace(/\n/g, '<br />');

function renderBlock(block: EmailBlock, context: MergeContext, missing: Set<string>) {
  const merge = (value: string) => {
    const result = applyMerge(value, context);
    result.missing.forEach((field) => missing.add(field));
    return result.merged;
  };
  switch (block.type) {
    case 'heading': {
      const size = block.level === 'h1' ? 26 : 20;
      return row(
        '<h' +
          (block.level === 'h1' ? '1' : '2') +
          ' style="margin:0;font-size:' +
          size +
          'px;line-height:1.3;font-weight:700;color:#192e26;text-align:' +
          block.align +
          ';">' +
          inline(merge(block.text)) +
          '</h' +
          (block.level === 'h1' ? '1' : '2') +
          '>',
      );
    }
    case 'text':
      return row(
        '<p style="margin:0;font-size:15px;line-height:1.65;color:#25352e;text-align:' +
          block.align +
          ';">' +
          inline(merge(block.text)) +
          '</p>',
      );
    case 'button':
      // A table-wrapped anchor is the only button shape Outlook lays out correctly.
      return row(
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:' +
          (block.align === 'center' ? '0 auto' : '0') +
          ';"><tr><td style="background:#315a3f;border-radius:7px;">' +
          '<a href="' +
          escapeHtml(block.url) +
          '" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">' +
          escapeHtml(merge(block.label)) +
          '</a></td></tr></table>',
      );
    case 'image':
      return row(
        '<img src="' +
          escapeHtml(block.url) +
          '" alt="' +
          escapeHtml(merge(block.alt)) +
          '" width="' +
          block.width +
          '" style="display:block;width:100%;max-width:' +
          block.width +
          'px;height:auto;border:0;" />',
      );
    case 'divider':
      return row('<div style="height:1px;background:#e5e8e0;line-height:1px;">&nbsp;</div>');
    case 'spacer':
      return row(
        '<div style="height:' +
          (block.size === 'small' ? 10 : block.size === 'large' ? 34 : 20) +
          'px;line-height:1px;">&nbsp;</div>',
        '0',
      );
    case 'quote':
      return row(
        '<div style="border-left:3px solid #315a3f;padding:4px 0 4px 16px;">' +
          '<p style="margin:0;font-size:15px;line-height:1.65;color:#25352e;font-style:italic;">' +
          inline(merge(block.text)) +
          '</p>' +
          (block.cite
            ? '<p style="margin:8px 0 0;font-size:12px;color:#6b7566;">— ' +
              escapeHtml(merge(block.cite)) +
              '</p>'
            : '') +
          '</div>',
      );
  }
}

export interface BlockProblem {
  index: number;
  type: string;
  message: string;
}
const fieldWording: Record<string, string> = {
  url: 'needs a complete https:// link',
  text: 'needs some text',
  label: 'needs a label',
  alt: 'needs alt text',
  width: 'needs a width between 40 and 560',
};
/**
 * Validates blocks one at a time so a problem can be attributed to its position in the
 * document. A validator path like "5.url" means nothing to someone editing an email.
 */
export function validateBlocks(input: unknown[]): {
  blocks: EmailBlock[];
  problems: BlockProblem[];
} {
  const blocks: EmailBlock[] = [];
  const problems: BlockProblem[] = [];
  input.forEach((candidate, index) => {
    const parsed = blockSchema.safeParse(candidate);
    if (parsed.success) {
      blocks.push(parsed.data);
      return;
    }
    const issue = parsed.error.issues[0];
    const field = String(issue.path[0] ?? '');
    const kind =
      candidate && typeof candidate === 'object' && 'type' in candidate
        ? String((candidate as { type: unknown }).type)
        : 'block';
    problems.push({
      index,
      type: kind,
      message:
        'Block ' +
        (index + 1) +
        ' (' +
        kind +
        ') ' +
        (fieldWording[field] || (field ? field + ': ' + issue.message : issue.message)) +
        '.',
    });
  });
  return { blocks, problems };
}
export interface RenderedEmail {
  html: string;
  text: string;
  missingMergeFields: string[];
}
/** Renders blocks into an email-safe document plus a plain-text alternative. */
export function renderBlocks(
  blocks: EmailBlock[],
  options: {
    context: MergeContext;
    fromName: string;
    fromEmail: string;
    signature: string;
    previewText: string;
  },
): RenderedEmail {
  const missing = new Set<string>();
  const body = blocks
    .map((block, index) => {
      const rendered = renderBlock(block, options.context, missing);
      // Consecutive content blocks need breathing room; spacers manage their own.
      const gap =
        index < blocks.length - 1 && block.type !== 'spacer'
          ? row('<div style="height:16px;line-height:1px;">&nbsp;</div>', '0')
          : '';
      return rendered + gap;
    })
    .join('');
  const signature = options.signature.trim()
    ? row(
        '<div style="padding-top:16px;border-top:1px solid #e5e8e0;font-size:13px;line-height:1.6;color:#6b7566;">' +
          inline(options.signature) +
          '</div>',
      )
    : '';
  const footer = row(
    '<div style="font-size:11px;line-height:1.6;color:#8a9184;">' +
      escapeHtml(options.fromName || options.fromEmail) +
      ' &lt;' +
      escapeHtml(options.fromEmail) +
      '&gt;<br />Reply with “unsubscribe” and we will not contact you again.' +
      '</div>',
  );
  // Hidden preheader: what the inbox shows after the subject.
  const preheader = options.previewText.trim()
    ? '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">' +
      escapeHtml(applyMerge(options.previewText, options.context).merged) +
      '</div>'
    : '';
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
    '<meta name="x-apple-disable-message-reformatting" />' +
    '</head><body style="margin:0;padding:0;background:#f6f7f3;">' +
    preheader +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f3;"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="' +
    PANEL +
    '" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:' +
    PANEL +
    'px;background:#ffffff;border-radius:12px;">' +
    row('<div style="height:28px;line-height:1px;">&nbsp;</div>', '0') +
    body +
    row('<div style="height:8px;line-height:1px;">&nbsp;</div>', '0') +
    signature +
    footer +
    row('<div style="height:28px;line-height:1px;">&nbsp;</div>', '0') +
    '</table></td></tr></table></body></html>';
  // The text alternative matters: some clients and most filters read it.
  const plain = blocks
    .map((block) => {
      const merge = (value: string) => applyMerge(value, options.context).merged;
      switch (block.type) {
        case 'heading':
          return merge(block.text).toUpperCase();
        case 'text':
          return merge(block.text);
        case 'button':
          return merge(block.label) + ': ' + block.url;
        case 'image':
          return '[' + merge(block.alt) + ']';
        case 'quote':
          return '"' + merge(block.text) + '"' + (block.cite ? ' — ' + merge(block.cite) : '');
        case 'divider':
          return '---';
        case 'spacer':
          return '';
      }
    })
    .filter((line) => line !== '')
    .join('\n\n');
  return {
    html,
    text:
      plain +
      (options.signature.trim() ? '\n\n' + options.signature.trim() : '') +
      '\n\n' +
      (options.fromName || options.fromEmail) +
      ' <' +
      options.fromEmail +
      '>\nReply with "unsubscribe" and we will not contact you again.',
    missingMergeFields: [...missing],
  };
}

/**
 * Pre-send checks, mirroring the concept's "claims, links, alt text, merge fields".
 * Advisory: they are surfaced to the sender, they do not block the send.
 */
export function checkBlocks(blocks: EmailBlock[], rendered: RenderedEmail, subject: string) {
  const warnings: string[] = [];
  if (rendered.missingMergeFields.length)
    warnings.push(
      'Unresolved merge field' +
        (rendered.missingMergeFields.length === 1 ? '' : 's') +
        ': ' +
        rendered.missingMergeFields.map((field) => '{{' + field + '}}').join(', ') +
        ' — the placeholder will be sent as written.',
    );
  if (blocks.some((block) => block.type === 'image' && !block.alt.trim()))
    warnings.push('An image has no alt text, so it is unreadable when images are blocked.');
  if (!blocks.some((block) => block.type === 'text'))
    warnings.push('There is no body text, only headings or media.');
  if (subject.length > 70)
    warnings.push(
      'The subject is ' + subject.length + ' characters; most inboxes cut off near 70.',
    );
  if (/\b(guarantee[d]?|risk[- ]free|act now|limited time|100% free)\b/i.test(rendered.text))
    warnings.push('The wording contains claim language that commonly trips spam filters.');
  const links = blocks.filter((block) => block.type === 'button').length;
  if (links > 3) warnings.push(links + ' buttons in one email reads as a promotion.');
  return warnings;
}

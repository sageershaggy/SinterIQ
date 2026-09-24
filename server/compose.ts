import type { Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { DB, Secrets } from './database';
import { getAiConfig, type Generate } from './ai';
import {
  applyMerge,
  checkBlocks,
  mergeContext,
  mergeFields,
  renderBlocks,
  validateBlocks,
} from './email-blocks';
import { starterTemplates, templateCategories } from './email-templates';
import { assertAddress, draftFor, getEmailConfig, renderEmail } from './email';
import { checkHtml, renderHtmlEmail } from './email-html';
import { fileMeta, imageLoader, loadFiles } from './email-files';
import { messageIds } from './imap';
import type { createFunnels } from './funnels';
import type { createOutreach, OutgoingFile } from './outreach';
import { savedDraft } from './workspace';
import { HttpError, positiveId, requiredText, text } from './validation';
import {
  blocksToHtml,
  emailText,
  fileIdFromSrc,
  fileIds,
  hasContent,
  maxEmailHtml,
  parseEmailHtml,
  sanitizeEmailHtml,
  serializeEmailHtml,
  type EmailNode,
} from '../shared/email-html';
import type { EmailDraftDocument } from '../shared/email';
import type { Lead, Project, User } from '../shared/types';

/**
 * Writing and sending one lead's email: the draft, the preview, the send, the campaign it may
 * start, and the AI's suggested rewrite. Every body is re-sanitized and rendered here, whatever
 * the browser sent, and the send path keeps every rule the outreach sender enforces.
 */
const sendSchema = z
  .object({
    reply_to_message_id: z.number().int().positive().optional(),
    to: requiredText(200),
    subject: requiredText(200).min(3),
    preview_text: text(200).default(''),
    // A rich-text body, a block document from the earlier editor, or a plain note.
    html: z.string().max(maxEmailHtml).optional(),
    blocks: z.array(z.unknown()).max(60).optional(),
    body: text(20000).default(''),
    attachment_ids: z.array(z.number().int().positive()).max(10).default([]),
    /** The campaign this email starts: it becomes message 1 and the follow-ups are queued. */
    funnel_id: z.number().int().positive().nullable().optional(),
    followups: z.array(z.string().max(40)).max(2).optional(),
    clear_draft: z.boolean().default(false),
  })
  .strict();
const improveSchema = z
  .object({ subject: text(200).default(''), html: z.string().max(maxEmailHtml) })
  .strict();
const suggestionSchema = z.object({
  subject: requiredText(200),
  html: z.string().min(1).max(maxEmailHtml),
  notes: text(600).default(''),
});
const improvePrompt = [
  'You edit short business outreach emails. Improve the draft for clarity, tone and structure',
  'without changing what it says. Return strict JSON: {"subject": string, "html": string, "notes": string}.',
  'Rules: keep every merge field such as {{company}} exactly as written and never invent new ones.',
  'Use only these HTML tags: p, br, strong, em, u, ul, ol, li, a, h2, h3, blockquote, img.',
  'Keep every <img> tag and every link URL exactly as given.',
  'Never add facts, figures, prices, claims, guarantees or promises that are not in the draft.',
  'Do not add a signature, a sender name or an unsubscribe line; those are added when it is sent.',
  'Keep it concise and plain. "notes" is one or two sentences on what you changed.',
].join(' ');

export function installCompose(
  app: Express,
  options: {
    db: DB;
    secrets: Secrets;
    getProject: (db: DB, id: number, user?: User) => Project;
    getLead: (db: DB, project: Project, id: number) => Lead;
    outreach: ReturnType<typeof createOutreach>;
    funnels: ReturnType<typeof createFunnels>;
    generate: Generate;
  },
) {
  const { db, secrets, getProject, getLead, outreach, funnels } = options;
  const perUser = (limit: number, error: string) =>
    rateLimit({
      windowMs: 15 * 60_000,
      limit,
      keyGenerator: (req) => String(req.user.id),
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error },
    });
  const mailLimit = perUser(60, 'Email send limit reached. Please retry in 15 minutes.');
  const aiLimit = perUser(30, 'AI suggestion limit reached. Please retry in 15 minutes.');
  const scope = (projectId: unknown, leadId: unknown, user: User) => {
    const project = getProject(db, positiveId(projectId), user);
    return { project, lead: getLead(db, project, positiveId(leadId)) };
  };
  const lead = (path: string) => '/api/projects/:projectId/leads/:leadId/email' + path;

  /** Starter templates for the editor, grouped the way the picker shows them. */
  app.get('/api/email/templates', (_req, res) =>
    res.json({
      templates: starterTemplates,
      categories: templateCategories,
      merge_fields: mergeFields,
    }),
  );

  /**
   * Everything the composer opens with: the saved draft (or a first draft built from the
   * approved qualification), the sender, the campaigns this lead can start and the one to
   * pre-select, and whether this address has bounced.
   */
  app.get(lead('/draft'), (req, res) => {
    const { project, lead } = scope(req.params.projectId, req.params.leadId, req.user);
    const run = lead.latest_run_id
      ? (db
          .prepare('SELECT result_json FROM qualification_runs WHERE id=? AND project_id=?')
          .get(lead.latest_run_id, project.id) as { result_json: string } | undefined)
      : undefined;
    const result = run ? JSON.parse(run.result_json) : undefined;
    const saved = savedDraft(db, project.id, lead.id, req.user.id);
    const document = saved.document as EmailDraftDocument | null;
    // A draft saved by the block editor opens in the rich-text editor as HTML.
    if (document && document.html === undefined && Array.isArray(document.blocks))
      document.html = blocksToHtml(document.blocks as Parameters<typeof blocksToHtml>[0]);
    const config = getEmailConfig(db, secrets, project.id);
    const bounce = lead.contact_email
      ? (db
          .prepare(
            'SELECT recipient,source,created_at FROM email_bounces WHERE recipient=? ORDER BY id DESC LIMIT 1',
          )
          .get(lead.contact_email.trim().toLowerCase()) as object | undefined)
      : undefined;
    res.json({
      ...draftFor(lead, result?.outreach?.why_qualified || '', result?.outreach?.call_script || ''),
      to: lead.contact_email,
      saved,
      mailbox: {
        configured: config.configured,
        from_email: config.from_email,
        from_name: config.from_name,
      },
      ...funnels.campaignOptions(project, lead),
      bounced: bounce || null,
      files: fileMeta(db, project.id, document?.attachment_ids || []),
    });
  });
  /** Discards the caller's own draft for this lead. Other people's drafts are untouched. */
  app.delete(lead('/draft'), (req, res) => {
    const { project, lead } = scope(req.params.projectId, req.params.leadId, req.user);
    db.prepare('DELETE FROM email_drafts WHERE project_id=? AND lead_id=? AND account_id=?').run(
      project.id,
      lead.id,
      req.user.id,
    );
    res.json(savedDraft(db, project.id, lead.id, req.user.id));
  });

  app.post(lead(''), mailLimit, async (req, res) => {
    const { project, lead } = scope(req.params.projectId, req.params.leadId, req.user);
    if ((lead as Lead & { archived_at?: string | null }).archived_at)
      throw new HttpError(409, 'This lead is archived. Restore it before emailing it.');
    const input = sendSchema.parse(req.body);
    const config = getEmailConfig(db, secrets, project.id);
    if (!config.configured)
      throw new HttpError(
        409,
        'This project has no mailbox yet. An administrator sets one up in the project Mailbox settings.',
      );
    // One header-safe recipient per request. Bulk sending is a separate, throttled path.
    const to = assertAddress(input.to, 'The recipient address');
    let inReplyTo: string | undefined;
    if (input.reply_to_message_id) {
      const incoming = db
        .prepare(
          'SELECT internet_message_id,from_email FROM incoming_messages WHERE project_id=? AND lead_id=? AND id=?',
        )
        .get(project.id, lead.id, input.reply_to_message_id) as
        { internet_message_id: string; from_email: string } | undefined;
      if (!incoming) throw new HttpError(404, 'Reply message not found for this lead.');
      if (incoming.from_email.toLowerCase() !== to.toLowerCase())
        throw new HttpError(400, 'Send this reply to the original sender.');
      inReplyTo = messageIds(incoming.internet_message_id)[0];
    }
    const sender = config.from_name || req.user.name;
    const context = mergeContext(lead, sender);
    // The subject carries merge fields too. A template subject is the most visible place
    // an unresolved {{company}} would surface, so it is merged like the body.
    const mergedSubject = applyMerge(input.subject.replace(/[\r\n]+/g, ' ').trim(), context);
    if (mergedSubject.missing.length)
      throw new HttpError(400, 'Fill missing subject fields: ' + mergedSubject.missing.join(', '));
    const subject = mergedSubject.merged;
    // Starting a campaign is checked before anything is sent, so a lead that cannot follow on
    // is never mailed its first message by accident.
    const plan = input.funnel_id
      ? funnels.planCampaign(project, lead.id, input.funnel_id, to, input.followups, config, sender)
      : null;
    let inline: OutgoingFile[] = [];
    const built =
      input.html !== undefined
        ? (() => {
            if (!hasContent(input.html))
              throw new HttpError(400, 'Write the message before sending.');
            const rendered = renderHtmlEmail(input.html, {
              projectId: project.id,
              context,
              fromName: config.from_name,
              fromEmail: config.from_email,
              signature: config.signature,
              previewText: input.preview_text,
              includeFooter: false,
              images: 'cid',
              loadImages: imageLoader(db, project.id),
            });
            if (rendered.missingMergeFields.length)
              throw new HttpError(
                400,
                'Fill missing message fields: ' + rendered.missingMergeFields.join(', '),
              );
            const shown = fileIds(
              parseEmailHtml(input.html, { projectId: project.id }),
              project.id,
            );
            if (rendered.inline.length !== shown.length)
              throw new HttpError(
                400,
                'An image in this email is no longer available. Add it again.',
              );
            inline = rendered.inline;
            return { html: rendered.html, text: rendered.text };
          })()
        : input.blocks
          ? (() => {
              const { blocks, problems } = validateBlocks(input.blocks);
              if (problems.length) throw new HttpError(400, problems[0].message);
              if (!blocks.length)
                throw new HttpError(400, 'Add at least one block before sending.');
              const rendered = renderBlocks(blocks, {
                context,
                fromName: config.from_name,
                fromEmail: config.from_email,
                signature: config.signature,
                previewText: input.preview_text,
                includeFooter: false,
              });
              if (rendered.missingMergeFields.length)
                throw new HttpError(
                  400,
                  'Fill missing message fields: ' + rendered.missingMergeFields.join(', '),
                );
              return { html: rendered.html, text: rendered.text };
            })()
          : (() => {
              if (input.body.trim().length < 20)
                throw new HttpError(400, 'Write a message of at least 20 characters.');
              const body = applyMerge(input.body, context);
              if (body.missing.length)
                throw new HttpError(400, 'Fill missing message fields: ' + body.missing.join(', '));
              return {
                html: renderEmail({
                  body: body.merged,
                  fromName: config.from_name,
                  fromEmail: config.from_email,
                  signature: config.signature,
                  leadName: lead.name,
                  includeFooter: false,
                }),
                text: body.merged,
              };
            })();
    // Every file must belong to this project and together fit in one message.
    const loaded = loadFiles(
      db,
      project.id,
      input.attachment_ids,
      inline.map((file) => file.fileId),
    );
    const files: OutgoingFile[] = [
      ...inline,
      ...loaded.attachments.map((file) => ({
        fileId: file.id,
        filename: file.filename,
        content: file.data,
        contentType: file.content_type,
      })),
    ];
    const id = await outreach.send({
      projectId: project.id,
      leadId: lead.id,
      actor: req.user.name,
      config,
      to,
      subject,
      text: built.text,
      html: built.html,
      inReplyTo,
      files,
      beforeSend: () => {
        const account = db
          .prepare('SELECT id,username,name,role FROM accounts WHERE id=? AND active=1')
          .get(req.user.id) as User | undefined;
        if (!account) throw new HttpError(409, 'Your account is no longer active.');
        getProject(db, project.id, account);
        const current = getLead(db, project, lead.id);
        if (current.revision !== lead.revision)
          throw new HttpError(409, 'Lead details changed. Review the message again.');
      },
    });
    if (input.clear_draft)
      db.prepare('DELETE FROM email_drafts WHERE project_id=? AND lead_id=? AND account_id=?').run(
        project.id,
        lead.id,
        req.user.id,
      );
    // The email is already on its way; a failure to queue the follow-ups must not hide that.
    let campaign = null,
      campaign_error = '';
    if (plan)
      try {
        campaign = funnels.startCampaign(project, plan, req.user);
      } catch (error) {
        campaign_error =
          'The email was sent, but its follow-ups could not be scheduled: ' +
          (error instanceof HttpError ? error.message : 'the campaign changed.');
      }
    res.status(201).json({ id, campaign, campaign_error });
  });

  /** Renders the body for the desktop/mobile preview, and returns the pre-send checks. */
  app.post(lead('/preview'), (req, res) => {
    const { project, lead } = scope(req.params.projectId, req.params.leadId, req.user);
    const input = z
      .object({
        subject: text(200).default(''),
        preview_text: text(200).default(''),
        html: z.string().max(maxEmailHtml).optional(),
        blocks: z.array(z.unknown()).max(60).optional(),
      })
      .strict()
      .parse(req.body);
    const config = getEmailConfig(db, secrets, project.id);
    const context = mergeContext(lead, config.from_name || req.user.name);
    const subject = applyMerge(input.subject, context);
    const frame = {
      context,
      fromName: config.from_name,
      fromEmail: config.from_email || 'not-configured@example.invalid',
      signature: config.signature,
      previewText: input.preview_text,
    };
    if (input.html !== undefined) {
      const rendered = renderHtmlEmail(input.html, {
        ...frame,
        projectId: project.id,
        images: 'data',
        loadImages: imageLoader(db, project.id),
      });
      return void res.json({
        html: rendered.html,
        text: rendered.text,
        missing_merge_fields: [...new Set([...rendered.missingMergeFields, ...subject.missing])],
        warnings: checkHtml(rendered, subject.merged),
        block_problems: [],
      });
    }
    // Problems are reported, not thrown: the editor shows them beside the block.
    const { blocks, problems } = validateBlocks(input.blocks || []);
    if (!blocks.length)
      return void res.json({ html: '', text: '', warnings: [], block_problems: problems });
    const rendered = renderBlocks(blocks, frame);
    res.json({
      html: rendered.html,
      text: rendered.text,
      missing_merge_fields: [...new Set([...rendered.missingMergeFields, ...subject.missing])],
      warnings: checkBlocks(blocks, rendered, subject.merged),
      block_problems: problems,
    });
  });

  /**
   * Suggests a better subject and body from the configured AI provider. It only suggests: the
   * author accepts or ignores it in the editor, and nothing here can send or save anything.
   */
  app.post(lead('/improve'), aiLimit, async (req, res) => {
    const { project, lead } = scope(req.params.projectId, req.params.leadId, req.user);
    const input = improveSchema.parse(req.body);
    const nodes = parseEmailHtml(input.html, { projectId: project.id });
    if (!emailText(nodes).trim())
      throw new HttpError(400, 'Write a first version; the AI improves what is already there.');
    const raw = await options.generate(getAiConfig(db, secrets), improvePrompt, {
      subject: input.subject,
      html: serializeEmailHtml(nodes),
      company: { industry: lead.industry, country: lead.country, city: lead.city },
      contact_role: lead.contact_role,
      merge_fields: mergeFields,
    });
    const parsed = suggestionSchema.safeParse(raw);
    if (!parsed.success)
      throw new HttpError(502, 'The AI returned an unusable suggestion. Nothing was changed.');
    let html = sanitizeEmailHtml(parsed.data.html, { projectId: project.id });
    // The author's own images stay, even when the model dropped them.
    const kept = new Set(fileIds(parseEmailHtml(html, { projectId: project.id }), project.id));
    const originals = new Map<number, string>();
    const collect = (list: EmailNode[]) => {
      for (const node of list) {
        if (node.type !== 'element') continue;
        const id = node.tag === 'img' ? fileIdFromSrc(node.src || '', project.id) : null;
        if (id !== null && !originals.has(id)) originals.set(id, serializeEmailHtml([node]));
        collect(node.children);
      }
    };
    collect(nodes);
    for (const [id, image] of originals) if (!kept.has(id)) html += '<p>' + image + '</p>';
    if (!hasContent(html))
      throw new HttpError(502, 'The AI returned an empty suggestion. Nothing was changed.');
    res.json({
      subject: parsed.data.subject
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, 200),
      html,
      notes: parsed.data.notes,
    });
  });
}

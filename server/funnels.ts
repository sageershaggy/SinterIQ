import type { Express } from 'express';
import { notifyLead } from './workspace';
import { z } from 'zod';
import { audit, now, type DB, type Secrets } from './database';
import { adminOnly } from './auth';
import { HttpError, positiveId, requiredText, text } from './validation';
import { getEmailConfig, renderEmail, type SmtpConfig } from './email';
import {
  applyMerge,
  blocksSchema,
  mergeContext,
  renderBlocks,
  validateBlocks,
} from './email-blocks';
import { renderHtmlEmail, type ImageLoader } from './email-html';
import { fileMeta, imageLoader, loadFiles } from './email-files';
import {
  assertCanContact,
  recipientKey,
  suppressRecipient,
  type createOutreach,
  type OutgoingFile,
} from './outreach';
import {
  blocksToHtml,
  fileIds,
  hasContent,
  maxEmailHtml,
  parseEmailHtml,
  sanitizeEmailHtml,
  textToHtml,
} from '../shared/email-html';
import { suggestCampaign } from '../shared/funnels';
import type { Funnel, FunnelProgress, FunnelStep } from '../shared/funnels';
import type { CampaignOption } from '../shared/email';
import type { Lead, Project, User } from '../shared/types';

const day = 86_400_000;
const hour = 3_600_000;

/** HH:mm on a 24-hour clock, or empty to send as soon as the delay elapses. */
const sendTimeSchema = text(5)
  .optional()
  .default('')
  .refine((s) => !s || /^([01]\d|2[0-3]):[0-5]\d$/.test(s), 'Use a send time like 09:00.');

/**
 * Due time for a funnel step: delay_days after `fromMs`, then the preferred clock time on
 * that calendar day (local). If that clock has already passed for a same-day step, send now.
 */
export function scheduleNextSend(fromMs: number, delayDays: number, sendTime = ''): number {
  const base = new Date(fromMs + Math.max(0, delayDays) * day);
  if (!sendTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) return base.getTime();
  const [hours, minutes] = sendTime.split(':').map(Number);
  const due = new Date(base);
  due.setHours(hours, minutes, 0, 0);
  if (due.getTime() <= fromMs) return fromMs;
  return due.getTime();
}

/**
 * Reports a bad block the way the composer does. Left to the schema alone, a designed step
 * fails with a validator path like "steps.0.blocks.2.url", which means nothing to someone
 * editing a campaign message; the usual cause is leaving a Button on its placeholder link.
 */
function assertDesignedSteps(body: unknown) {
  if (!body || typeof body !== 'object') return;
  const steps = (body as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return;
  steps.forEach((step, index) => {
    const blocks = step && typeof step === 'object' ? (step as { blocks?: unknown }).blocks : null;
    if (!Array.isArray(blocks) || !blocks.length) return;
    const { problems } = validateBlocks(blocks);
    if (problems.length)
      throw new HttpError(400, 'Message ' + (index + 1) + ' — ' + problems[0].message);
  });
}
export const funnelSchema = z
  .object({
    name: requiredText(120),
    audience: text(500).default(''),
    /** A matched incoming reply stops the rest of the sequence. On unless someone turns it off. */
    stop_on_reply: z.boolean().default(true),
    /** Which fit scores this campaign is for; the composer pre-selects by it. */
    fit_band: z.enum(['ANY', 'HIGH', 'EMAIL']).default('ANY'),
    steps: z
      .array(
        z
          .object({
            delay_days: z.number().int().min(0).max(90),
            send_time: sendTimeSchema,
            to: text(200)
              .optional()
              .default('{{contact_email}}')
              .refine((s) => !/[\r\n]/.test(s), 'Recipient cannot contain line breaks.'),
            subject: requiredText(200).refine(
              (s) => !/[\r\n]/.test(s),
              'Subject cannot contain line breaks.',
            ),
            body: text(10000).default(''),
            blocks: blocksSchema.optional(),
            html: z.string().max(maxEmailHtml).optional(),
            attachment_ids: z.array(z.number().int().positive()).max(10).optional(),
          })
          .strict()
          .refine(
            (step) =>
              Boolean(step.blocks?.length) ||
              Boolean(step.html && hasContent(step.html)) ||
              step.body.trim().length >= 20,
            'Write the message, or design it with blocks.',
          ),
      )
      .min(1)
      .max(3),
  })
  .strict()
  .refine(
    (f) => f.steps.slice(1).every((s) => s.delay_days >= 1),
    'Follow-ups must be at least one day apart.',
  );
type StoredFunnel = Omit<Funnel, 'steps' | 'stop_on_reply'> & {
  steps_json: string;
  stop_on_reply: number;
};
interface Job {
  id: number;
  project_id: number;
  funnel_id: number;
  lead_id: number;
  recipient: string;
  lead_revision: number;
  training_version: number;
  account_id: number;
  created_by: string;
  status: string;
  next_step: number;
  next_send_at: number;
  schedule_json: string;
}
const selectFunnel = `SELECT f.*,
  (SELECT COUNT(*) FROM funnel_enrollments e WHERE e.funnel_id=f.id AND e.project_id=f.project_id) enrolled_count,
  (SELECT COUNT(*) FROM funnel_enrollments e WHERE e.funnel_id=f.id AND e.project_id=f.project_id AND e.status IN ('QUEUED','SENDING')) queued_count,
  (SELECT COUNT(*) FROM funnel_enrollments e WHERE e.funnel_id=f.id AND e.project_id=f.project_id AND e.status='CONVERTED') converted_count
  FROM funnels f`;
const serialize = ({ steps_json, stop_on_reply, ...row }: StoredFunnel): Funnel => ({
  ...row,
  stop_on_reply: Boolean(stop_on_reply),
  steps: JSON.parse(steps_json),
});
/** The body a step shows in the rich-text editor, whichever way it was written. */
export function stepHtml(step: FunnelStep) {
  if (step.html) return step.html;
  if (step.blocks?.length) return blocksToHtml(step.blocks);
  return textToHtml(step.body);
}
/** Follow-up times chosen when a campaign started from a hand-sent first message. */
function parseSchedule(value: string): Array<number | null> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => (typeof v === 'number' ? v : null)) : [];
  } catch {
    return [];
  }
}

export function createFunnels(options: {
  db: DB;
  secrets: Secrets;
  publicOrigin: string;
  outreach: ReturnType<typeof createOutreach>;
  getProject: (db: DB, id: number, user?: User) => Project;
}) {
  const { db, secrets, publicOrigin, outreach, getProject } = options;
  const getFunnel = (projectId: number, id: number) => {
    const row = db.prepare(selectFunnel + ' WHERE f.project_id=? AND f.id=?').get(projectId, id) as
      StoredFunnel | undefined;
    if (!row) throw new HttpError(404, 'Funnel not found in this project.');
    return serialize(row);
  };
  /** Where each funnel's leads are: waiting for which message, or how their sequence ended. */
  function progress(projectId: number) {
    const rows = db
      .prepare(
        `SELECT funnel_id,status,next_step,stop_cause,COUNT(*) n FROM funnel_enrollments
        WHERE project_id=? GROUP BY funnel_id,status,next_step,stop_cause`,
      )
      .all(projectId) as Array<{
      funnel_id: number;
      status: string;
      next_step: number;
      stop_cause: string;
      n: number;
    }>;
    const byFunnel = new Map<number, FunnelProgress>();
    for (const row of rows) {
      const entry = byFunnel.get(row.funnel_id) || {
        waiting: [0, 0, 0],
        replied: 0,
        bounced: 0,
        stopped: 0,
        blocked: 0,
        completed: 0,
        total: 0,
      };
      entry.total += row.n;
      if (row.status === 'QUEUED' || row.status === 'SENDING')
        entry.waiting[Math.min(2, Math.max(0, row.next_step))] += row.n;
      else if (row.stop_cause === 'BOUNCED') entry.bounced += row.n;
      else if (['REPLIED', 'INTERESTED', 'CONVERTED'].includes(row.status)) entry.replied += row.n;
      else if (row.status === 'COMPLETED') entry.completed += row.n;
      else if (row.status === 'BLOCKED') entry.blocked += row.n;
      else entry.stopped += row.n;
      byFunnel.set(row.funnel_id, entry);
    }
    return byFunnel;
  }
  function eligible(
    project: Project,
    leadId: number,
    rules: { allowReplied?: boolean } = {},
  ): Lead {
    const lead = db
      .prepare('SELECT * FROM leads WHERE id=? AND project_id=?')
      .get(leadId, project.id) as
      (Lead & { outreach_status: string; archived_at: string | null }) | undefined;
    if (!lead) throw new HttpError(404, 'Lead not found in this project.');
    if (lead.archived_at)
      throw new HttpError(409, lead.name + ' is archived. Restore it before emailing it.');
    if (
      lead.status !== 'QUALIFIED' ||
      !lead.latest_run_id ||
      !project.active_version ||
      project.revision !== project.trained_revision ||
      lead.training_version !== project.active_version ||
      lead.qualified_revision !== lead.revision
    )
      throw new HttpError(
        409,
        lead.name + ' needs a current, qualified result before enrollment or sending.',
      );
    if (lead.outreach_status === 'BOUNCED')
      throw new HttpError(409, 'Email to ' + lead.name + ' bounced. Update the contact first.');
    if (
      ['INTERESTED', 'CONVERTED', 'UNSUBSCRIBED', 'STOPPED'].includes(lead.outreach_status) ||
      (lead.outreach_status === 'REPLIED' && !rules.allowReplied)
    )
      throw new HttpError(409, lead.name + ' has a response or stop recorded.');
    return lead;
  }
  /** Checks that every file a step names still belongs to the project and fits one message. */
  function assertStepFiles(projectId: number, steps: FunnelStep[]) {
    steps.forEach((step, index) => {
      const inline = step.html ? fileIds(parseEmailHtml(step.html, { projectId }), projectId) : [];
      const ids = [...new Set([...(step.attachment_ids || []), ...inline])];
      const found = fileMeta(db, projectId, ids);
      if (found.length !== ids.length)
        throw new HttpError(
          400,
          'Message ' +
            (index + 1) +
            ' — a file is no longer available. Remove it and add it again.',
        );
      const size = found.reduce((sum, file) => sum + file.size, 0);
      if (size > 20 * 1024 * 1024)
        throw new HttpError(413, 'Message ' + (index + 1) + ' — files add up to more than 20 MB.');
    });
  }
  /** The stored form: rich text re-sanitized here, and nothing added a step did not have. */
  function storedSteps(projectId: number, steps: z.infer<typeof funnelSchema>['steps']) {
    const stored = steps.map((step) => {
      const { html, attachment_ids, blocks, ...rest } = step;
      return {
        ...rest,
        ...(blocks ? { blocks } : {}),
        ...(html !== undefined ? { html: sanitizeEmailHtml(html, { projectId }) } : {}),
        ...(attachment_ids?.length ? { attachment_ids: [...new Set(attachment_ids)] } : {}),
      } as FunnelStep;
    });
    assertStepFiles(projectId, stored);
    return stored;
  }
  /**
   * Builds one message for one lead. 'send' attaches files and inline images; 'preview' embeds
   * images for the preview frame; 'check' only proves every merge field resolves.
   */
  function compose(
    step: FunnelStep,
    lead: Lead,
    config: SmtpConfig,
    sender: string,
    mode: 'send' | 'preview' | 'check' = 'send',
  ) {
    const context = mergeContext(lead, sender);
    const subject = applyMerge(step.subject, context);
    const to = step.to ? applyMerge(step.to, context) : null;
    const refuse = (missing: string[]) => {
      if (missing.length)
        throw new HttpError(
          409,
          'Fill missing merge fields for ' + lead.name + ': ' + missing.join(', '),
        );
    };
    if (to?.missing.length) {
      refuse(to.missing);
    }
    const attachments = (inline: number[]): OutgoingFile[] =>
      mode === 'send'
        ? loadFiles(db, lead.project_id, step.attachment_ids || [], inline).attachments.map(
            (file) => ({
              fileId: file.id,
              filename: file.filename,
              content: file.data,
              contentType: file.content_type,
            }),
          )
        : [];
    if (step.html) {
      const noImages: ImageLoader = () => new Map();
      const rendered = renderHtmlEmail(step.html, {
        projectId: lead.project_id,
        context,
        fromName: sender,
        fromEmail: config.from_email,
        signature: config.signature,
        previewText: '',
        includeFooter: false,
        images: mode === 'send' ? 'cid' : 'data',
        loadImages: mode === 'check' ? noImages : imageLoader(db, lead.project_id),
      });
      refuse([
        ...new Set([...(to?.missing || []), ...subject.missing, ...rendered.missingMergeFields]),
      ]);
      return {
        to: to?.merged,
        subject: subject.merged,
        body: rendered.text,
        html: rendered.html,
        files: [...rendered.inline, ...attachments(rendered.inline.map((file) => file.fileId))],
      };
    }
    if (step.blocks?.length) {
      // Rendered by the same server-side renderer the composer previews, so a designed
      // funnel message is delivered as the editor showed it, Outlook-safe tables and all.
      const rendered = renderBlocks(step.blocks, {
        context,
        fromName: sender,
        fromEmail: config.from_email,
        signature: config.signature,
        previewText: '',
        includeFooter: false,
      });
      refuse([
        ...new Set([...(to?.missing || []), ...subject.missing, ...rendered.missingMergeFields]),
      ]);
      return {
        to: to?.merged,
        subject: subject.merged,
        body: rendered.text,
        html: rendered.html,
        files: attachments([]),
      };
    }
    const body = applyMerge(step.body, context);
    refuse([...new Set([...(to?.missing || []), ...subject.missing, ...body.missing])]);
    return {
      to: to?.merged,
      subject: subject.merged,
      body: body.merged,
      html: '',
      files: attachments([]),
    };
  }
  /** Every step may name its own recipient; fall back to the lead contact when unset. */
  function stepRecipient(built: { to?: string }, fallback: string) {
    return recipientKey((built.to || '').trim() || fallback);
  }
  function recordOutcome(
    project: Project,
    leadId: number,
    outcome: string,
    notes: string,
    actor: string,
  ) {
    const lead = db
      .prepare('SELECT contact_email FROM leads WHERE id=? AND project_id=?')
      .get(leadId, project.id) as { contact_email: string } | undefined;
    if (!lead) throw new HttpError(404, 'Lead not found in this project.');
    db.transaction(() => {
      db.prepare(
        'INSERT INTO outreach_events (project_id,lead_id,outcome,notes,created_by,created_at) VALUES (?,?,?,?,?,?)',
      ).run(project.id, leadId, outcome, notes, actor, now());
      db.prepare(
        "UPDATE leads SET outreach_status=CASE WHEN outreach_status='UNSUBSCRIBED' THEN outreach_status ELSE ? END WHERE id=? AND project_id=?",
      ).run(outcome, leadId, project.id);
      db.prepare(
        `UPDATE funnel_enrollments SET status=?,reason=?,updated_at=?
        WHERE project_id=? AND lead_id=? AND status!='UNSUBSCRIBED'`,
      ).run(outcome, notes, now(), project.id, leadId);
      // Stop the recipient's other queued funnels too; do not disclose other project data.
      if (lead.contact_email) {
        const recipient = recipientKey(lead.contact_email);
        if (outcome === 'UNSUBSCRIBED')
          suppressRecipient(db, recipient, 'Unsubscribe recorded by the team.');
        else
          db.prepare(
            `UPDATE funnel_enrollments SET status='STOPPED',reason='Recipient response recorded.',updated_at=?
          WHERE recipient=? AND status IN ('QUEUED','SENDING')`,
          ).run(now(), recipient);
      }
      audit(
        db,
        project.id,
        actor,
        'lead.outreach_' + outcome.toLowerCase(),
        'Lead #' + leadId + ': ' + notes,
      );
      notifyLead(
        db,
        project.id,
        leadId,
        'outcome',
        'A response was recorded: ' + outcome.replaceAll('_', ' ').toLowerCase(),
      );
    })();
  }
  /** The reason this lead cannot start this campaign, or '' when it can. */
  function blockedReason(project: Project, leadId: number, funnel: Funnel) {
    try {
      const lead = eligible(project, leadId);
      if (!lead.contact_email) return 'Add a contact email to this lead first.';
      const recipient = recipientKey(lead.contact_email);
      assertCanContact(db, recipient);
      if (
        db
          .prepare(
            'SELECT 1 FROM funnel_enrollments WHERE project_id=? AND funnel_id=? AND lead_id=?',
          )
          .get(project.id, funnel.id, lead.id)
      )
        return lead.name + ' has already been in this campaign.';
      if (
        db
          .prepare(
            "SELECT 1 FROM funnel_enrollments WHERE (lead_id=? OR recipient=?) AND status IN ('QUEUED','SENDING')",
          )
          .get(lead.id, recipient)
      )
        return lead.name + ' already has an active sequence.';
      if (funnel.steps.length > 3) return 'This campaign has too many messages.';
      return '';
    } catch (error) {
      return error instanceof HttpError ? error.message : 'This lead cannot join this campaign.';
    }
  }
  /** The project's campaigns as the composer offers them, and which one to pre-select. */
  function campaignOptions(project: Project, lead: Lead & { stale?: boolean }) {
    const campaigns: CampaignOption[] = (
      db
        .prepare(selectFunnel + ' WHERE f.project_id=? ORDER BY f.id DESC')
        .all(project.id) as StoredFunnel[]
    )
      .map(serialize)
      .map((funnel) => ({
        id: funnel.id,
        name: funnel.name,
        audience: funnel.audience,
        status: funnel.status,
        fit_band: funnel.fit_band,
        stop_on_reply: funnel.stop_on_reply,
        steps: funnel.steps.map((step) => ({
          subject: step.subject,
          html: stepHtml(step),
          delay_days: step.delay_days,
          send_time: step.send_time || '',
          attachment_ids: step.attachment_ids || [],
        })),
        blocked: blockedReason(project, lead.id, funnel),
      }));
    return { campaigns, suggested: suggestCampaign(lead, campaigns) };
  }
  /**
   * Validates, BEFORE the first message is sent by hand, that this lead can start the
   * campaign: eligibility, recipient, every later message's merge fields, and the follow-up
   * times the author picked. Nothing is sent when any of it fails.
   */
  function planCampaign(
    project: Project,
    leadId: number,
    funnelId: number,
    to: string,
    followups: string[] | undefined,
    config: SmtpConfig,
    sender: string,
  ) {
    const funnel = getFunnel(project.id, funnelId);
    const reason = blockedReason(project, leadId, funnel);
    if (reason) throw new HttpError(409, reason);
    const lead = eligible(project, leadId);
    const recipient = recipientKey(lead.contact_email);
    if (recipientKey(to) !== recipient)
      throw new HttpError(
        400,
        'A campaign continues to the lead’s contact email (' +
          lead.contact_email +
          '). Send to that address, or choose One-off email.',
      );
    for (const step of funnel.steps.slice(1)) {
      const built = compose(step, lead, config, sender, 'check');
      assertCanContact(db, stepRecipient(built, lead.contact_email));
    }
    const start = Date.now();
    let times: number[];
    if (followups === undefined) {
      times = [];
      let previous = start;
      for (const step of funnel.steps.slice(1)) {
        previous = scheduleNextSend(previous, step.delay_days, step.send_time);
        times.push(previous);
      }
    } else {
      if (followups.length !== funnel.steps.length - 1)
        throw new HttpError(400, 'Choose a date and time for each follow-up.');
      times = followups.map((value) => Date.parse(value));
      let previous = start;
      for (const time of times) {
        if (!Number.isFinite(time))
          throw new HttpError(400, 'Choose a date and time for each follow-up.');
        if (time - previous < 12 * hour)
          throw new HttpError(
            400,
            'Space each follow-up at least 12 hours after the message before it.',
          );
        if (time - start > 180 * day)
          throw new HttpError(400, 'Schedule follow-ups within the next 180 days.');
        previous = time;
      }
    }
    return { funnel, lead, recipient, schedule: [null, ...times] as Array<number | null> };
  }
  /** Enrolls the lead with its first message already sent and its follow-ups scheduled. */
  function startCampaign(project: Project, plan: ReturnType<typeof planCampaign>, user: User) {
    const next = plan.schedule[1] ?? Date.now();
    const done = plan.funnel.steps.length <= 1;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO funnel_enrollments
        (project_id,funnel_id,lead_id,recipient,lead_revision,training_version,account_id,created_by,
         status,next_step,next_send_at,schedule_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
      ).run(
        project.id,
        plan.funnel.id,
        plan.lead.id,
        plan.recipient,
        plan.lead.revision,
        project.active_version,
        user.id,
        user.name,
        done ? 'COMPLETED' : 'QUEUED',
        next,
        JSON.stringify(plan.schedule),
        now(),
        now(),
      );
      audit(
        db,
        project.id,
        user.name,
        'funnel.enrolled',
        plan.lead.name + ' started ' + plan.funnel.name + ' with a hand-sent first message.',
      );
    })();
    return {
      funnel_id: plan.funnel.id,
      funnel_name: plan.funnel.name,
      funnel_status: plan.funnel.status,
      followups: plan.schedule.slice(1).map((time) => (time ? new Date(time).toISOString() : '')),
    };
  }

  function install(app: Express) {
    const base = '/api/projects/:projectId/funnels';
    // Resolve membership before role checks so inaccessible projects always return 404.
    app.use(base, (req, _res, next) => {
      getProject(db, positiveId(req.params.projectId), req.user);
      next();
    });
    app.get(base, (req, res) => {
      const p = getProject(db, positiveId(req.params.projectId), req.user);
      const counts = progress(p.id);
      res.json({
        funnels: (
          db
            .prepare(selectFunnel + ' WHERE f.project_id=? ORDER BY f.id DESC')
            .all(p.id) as StoredFunnel[]
        )
          .map(serialize)
          .map((funnel) => ({
            ...funnel,
            progress: counts.get(funnel.id) || {
              waiting: [0, 0, 0],
              replied: 0,
              bounced: 0,
              stopped: 0,
              blocked: 0,
              completed: 0,
              total: 0,
            },
          })),
        delivery_ready: (() => {
          const config = getEmailConfig(db, secrets, p.id);
          return Boolean(
            publicOrigin.startsWith('https://') && config.configured && config.copy_to,
          );
        })(),
      });
    });
    app.post(base, adminOnly, (req, res) => {
      const p = getProject(db, positiveId(req.params.projectId), req.user);
      assertDesignedSteps(req.body);
      const input = funnelSchema.parse(req.body);
      const steps = storedSteps(p.id, input.steps);
      const id = Number(
        db
          .prepare(
            'INSERT INTO funnels (project_id,name,audience,steps_json,stop_on_reply,fit_band,created_at,created_by) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            p.id,
            input.name,
            input.audience,
            JSON.stringify(steps),
            input.stop_on_reply ? 1 : 0,
            input.fit_band,
            now(),
            req.user.name,
          ).lastInsertRowid,
      );
      audit(db, p.id, req.user.name, 'funnel.created', input.name);
      res.status(201).json(getFunnel(p.id, id));
    });
    app.put(base + '/:funnelId', adminOnly, (req, res) => {
      const p = getProject(db, positiveId(req.params.projectId), req.user);
      const f = getFunnel(p.id, positiveId(req.params.funnelId));
      const { revision, ...body } = req.body;
      if (positiveId(revision) !== f.revision)
        throw new HttpError(409, 'The funnel changed. Refresh before saving.');
      if (f.enrolled_count || f.status === 'ACTIVE')
        throw new HttpError(
          409,
          'This sequence is already in use. Create a new funnel to change its messages.',
        );
      assertDesignedSteps(body);
      const input = funnelSchema.parse(body);
      const steps = storedSteps(p.id, input.steps);
      db.prepare(
        'UPDATE funnels SET name=?,audience=?,steps_json=?,stop_on_reply=?,fit_band=?,revision=revision+1 WHERE id=? AND project_id=?',
      ).run(
        input.name,
        input.audience,
        JSON.stringify(steps),
        input.stop_on_reply ? 1 : 0,
        input.fit_band,
        f.id,
        p.id,
      );
      res.json(getFunnel(p.id, f.id));
    });
    app.patch(base + '/:funnelId', adminOnly, (req, res) => {
      const p = getProject(db, positiveId(req.params.projectId), req.user);
      const f = getFunnel(p.id, positiveId(req.params.funnelId));
      const input = z
        .object({ status: z.enum(['ACTIVE', 'PAUSED']), revision: z.number().int().positive() })
        .strict()
        .parse(req.body);
      if (input.revision !== f.revision)
        throw new HttpError(409, 'The funnel changed. Refresh before saving.');
      if (input.status === 'ACTIVE') {
        const config = getEmailConfig(db, secrets, p.id);
        if (!publicOrigin.startsWith('https://') || !config.configured || !config.copy_to)
          throw new HttpError(
            409,
            'Configure a public HTTPS app origin, this project mailbox and a copy address before starting.',
          );
        funnelSchema.parse({ name: f.name, audience: f.audience, steps: f.steps });
      }
      db.prepare('UPDATE funnels SET status=?,revision=revision+1 WHERE id=? AND project_id=?').run(
        input.status,
        f.id,
        p.id,
      );
      audit(db, p.id, req.user.name, 'funnel.' + input.status.toLowerCase(), f.name);
      res.json(getFunnel(p.id, f.id));
    });
    app.get(base + '/:funnelId/enrollments', (req, res) => {
      const p = getProject(db, positiveId(req.params.projectId), req.user);
      const f = getFunnel(p.id, positiveId(req.params.funnelId));
      const input = z
        .object({ page: z.coerce.number().int().min(1).default(1), search: text(200).default('') })
        .parse(req.query);
      const search = '%' + input.search.replace(/[!%_]/g, '!$&') + '%';
      const where =
        "e.project_id=? AND e.funnel_id=? AND (l.name LIKE ? ESCAPE '!' OR e.recipient LIKE ? ESCAPE '!')";
      res.json({
        enrollments: db
          .prepare(
            'SELECT e.*,l.name lead_name FROM funnel_enrollments e JOIN leads l ON l.id=e.lead_id AND l.project_id=e.project_id WHERE ' +
              where +
              ' ORDER BY e.id DESC LIMIT 50 OFFSET ?',
          )
          .all(p.id, f.id, search, search, (input.page - 1) * 50),
        total: (
          db
            .prepare(
              'SELECT COUNT(*) n FROM funnel_enrollments e JOIN leads l ON l.id=e.lead_id AND l.project_id=e.project_id WHERE ' +
                where,
            )
            .get(p.id, f.id, search, search) as { n: number }
        ).n,
      });
    });
    app.post(base + '/:funnelId/enrollments', (req, res) => {
      const p = getProject(db, positiveId(req.params.projectId), req.user);
      const f = getFunnel(p.id, positiveId(req.params.funnelId));
      const input = z
        .object({ lead_ids: z.array(z.number().int().positive()).min(1).max(100) })
        .strict()
        .parse(req.body);
      const config = getEmailConfig(db, secrets, p.id);
      let skipped = 0;
      const enrolled = db.transaction(() => {
        let count = 0;
        for (const leadId of new Set(input.lead_ids)) {
          const lead = eligible(p, leadId);
          if (
            db
              .prepare(
                'SELECT 1 FROM funnel_enrollments WHERE project_id=? AND funnel_id=? AND lead_id=?',
              )
              .get(p.id, f.id, lead.id)
          ) {
            skipped++;
            continue;
          }
          // Enrollment is keyed to the lead contact for identity checks, but each step may
          // merge to a different address — assert and de-conflict every address that will
          // actually be mailed, not only contact_email.
          const recipient = recipientKey(lead.contact_email);
          if (
            db
              .prepare(
                "SELECT 1 FROM funnel_enrollments WHERE lead_id=? AND status IN ('QUEUED','SENDING')",
              )
              .get(lead.id)
          )
            throw new HttpError(
              409,
              lead.name + ' already has an active sequence for this recipient.',
            );
          const stepRecipients = new Set<string>();
          for (const step of f.steps) {
            const built = compose(step, lead, config, config.from_name || req.user.name, 'check');
            const stepTo = stepRecipient(built, lead.contact_email);
            assertCanContact(db, stepTo);
            stepRecipients.add(stepTo);
          }
          assertCanContact(db, recipient);
          for (const stepTo of stepRecipients) {
            if (
              db
                .prepare(
                  "SELECT 1 FROM funnel_enrollments WHERE recipient=? AND status IN ('QUEUED','SENDING')",
                )
                .get(stepTo)
            )
              throw new HttpError(
                409,
                lead.name + ' already has an active sequence for this recipient.',
              );
          }
          db.prepare(
            `INSERT INTO funnel_enrollments
            (project_id,funnel_id,lead_id,recipient,lead_revision,training_version,account_id,created_by,next_send_at,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            p.id,
            f.id,
            lead.id,
            recipient,
            lead.revision,
            p.active_version,
            req.user.id,
            req.user.name,
            scheduleNextSend(Date.now(), f.steps[0].delay_days, f.steps[0].send_time),
            now(),
            now(),
          );
          count++;
        }
        audit(
          db,
          p.id,
          req.user.name,
          'funnel.enrolled',
          count + ' leads added to ' + f.name + '.',
        );
        return count;
      })();
      res.status(201).json({ enrolled, skipped });
    });
    app.post(base + '/:funnelId/preview', (req, res) => {
      const p = getProject(db, positiveId(req.params.projectId), req.user);
      const f = getFunnel(p.id, positiveId(req.params.funnelId));
      const input = z
        .object({ lead_id: z.number().int().positive(), step: z.number().int().min(0).max(2) })
        .strict()
        .parse(req.body);
      if (!f.steps[input.step]) throw new HttpError(400, 'Message not found.');
      const lead = eligible(p, input.lead_id),
        config = getEmailConfig(db, secrets, p.id);
      const step = f.steps[input.step];
      const built = compose(step, lead, config, config.from_name || req.user.name, 'preview');
      res.json({
        to: stepRecipient(built, lead.contact_email),
        subject: built.subject,
        body: built.body,
        html: built.html,
        attachments: fileMeta(db, p.id, step.attachment_ids || []),
      });
    });
    app.post('/api/projects/:projectId/leads/:leadId/outreach-events', (req, res) => {
      const p = getProject(db, positiveId(req.params.projectId), req.user);
      const input = z
        .object({
          outcome: z.enum(['REPLIED', 'INTERESTED', 'CONVERTED', 'STOPPED', 'UNSUBSCRIBED']),
          notes: requiredText(2000).min(5),
        })
        .strict()
        .parse(req.body);
      recordOutcome(p, positiveId(req.params.leadId), input.outcome, input.notes, req.user.name);
      res.status(201).json({ ok: true });
    });
  }

  let running = false;
  async function tick(time = Date.now()) {
    if (running) return;
    running = true;
    try {
      outreach.recover();
      const job = db.transaction(() => {
        db.prepare(
          `UPDATE funnel_enrollments SET status='BLOCKED',reason='Delivery interrupted; inspect email history before contacting again.',updated_at=?
          WHERE status='SENDING' AND updated_at<?`,
        ).run(now(), new Date(Date.now() - 10 * 60_000).toISOString());
        // Across processes/restarts: reserve one slot per minute PER PROJECT, even if the
        // previous send failed. Each project sends from its own mailbox with its own sending
        // reputation, so one project's queue must not starve behind another's.
        const slotKey = (projectId: number) => 'funnel_last_tick:' + projectId;
        const paced = db.prepare('SELECT value FROM meta WHERE key=?');
        // Pick the PROJECT first, then its oldest due job. Scanning a window of jobs instead
        // would let one project with a deep queue fill the window and starve the others.
        // A project whose own mailbox is enabled but failing does not send at all: its replies
        // are not being ingested, so the "they already replied" stop cannot fire and a
        // sequence would keep mailing someone who has already asked to be left alone.
        const due = db
          .prepare(
            `SELECT DISTINCT e.project_id FROM funnel_enrollments e
            JOIN funnels f ON f.id=e.funnel_id AND f.project_id=e.project_id
          WHERE f.status='ACTIVE' AND e.status='QUEUED' AND e.next_send_at<=?
            AND NOT EXISTS (SELECT 1 FROM project_mailboxes m
              WHERE m.project_id=e.project_id AND m.imap_enabled=1 AND m.last_error<>'')`,
          )
          .all(time) as Array<{ project_id: number }>;
        const ready = due
          .map((row) => row.project_id)
          .filter((projectId) => {
            const slot = paced.get(slotKey(projectId)) as { value: string } | undefined;
            return !slot || time - Number(slot.value) >= 60_000;
          });
        if (!ready.length) return;
        const selected = db
          .prepare(
            `SELECT e.* FROM funnel_enrollments e JOIN funnels f ON f.id=e.funnel_id AND f.project_id=e.project_id
          WHERE f.status='ACTIVE' AND e.status='QUEUED' AND e.next_send_at<=?
            AND e.project_id IN (${ready.map(() => '?').join(',')})
          ORDER BY e.next_send_at,e.id LIMIT 1`,
          )
          .get(time, ...ready) as Job | undefined;
        if (!selected) return;
        db.prepare(
          'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        ).run(slotKey(selected.project_id), String(time));
        db.prepare(
          "UPDATE funnel_enrollments SET status='SENDING',updated_at=? WHERE id=? AND project_id=?",
        ).run(now(), selected.id, selected.project_id);
        return selected;
      })();
      if (!job) return;
      try {
        const verify = () => {
          const account = db
            .prepare('SELECT id,username,name,role FROM accounts WHERE id=? AND active=1')
            .get(job.account_id) as User | undefined;
          if (!account) throw new HttpError(409, 'The enrolling account is inactive.');
          const p = getProject(db, job.project_id, account);
          const f = getFunnel(p.id, job.funnel_id);
          const current = db
            .prepare('SELECT status FROM funnel_enrollments WHERE id=? AND project_id=?')
            .get(job.id, p.id) as { status: string };
          if (f.status !== 'ACTIVE' || current.status !== 'SENDING')
            throw new HttpError(409, 'The sequence was paused or stopped.');
          // With stop-on-reply turned off, a reply keeps the sequence going. Every other
          // recorded response, an opt-out or a bounce still stops it.
          const lead = eligible(p, job.lead_id, { allowReplied: !f.stop_on_reply });
          if (
            lead.revision !== job.lead_revision ||
            p.active_version !== job.training_version ||
            recipientKey(lead.contact_email) !== job.recipient
          )
            throw new HttpError(
              409,
              'Lead, recipient or training changed after enrollment. Review this lead before contacting again.',
            );
          return { f, lead };
        };
        const { f, lead } = verify();
        const config = getEmailConfig(db, secrets, job.project_id);
        if (!publicOrigin.startsWith('https://') || !config.copy_to)
          throw new HttpError(409, 'Public origin or copy address is missing.');
        const step = f.steps[job.next_step];
        if (!step) throw new HttpError(409, 'The sequence is complete.');
        const built = compose(step, lead, config, config.from_name);
        const sendTo = stepRecipient(built, job.recipient);
        // verify() only proves the lead contact still matches enrollment; the step may mail
        // a different merged address, so re-check suppression and the three-email limit on
        // the address that will actually leave the mailbox (before outreach reserves a slot).
        assertCanContact(db, sendTo);
        await outreach.send({
          projectId: job.project_id,
          leadId: job.lead_id,
          actor: job.created_by,
          config,
          to: sendTo,
          subject: built.subject,
          text: built.body,
          html:
            built.html ||
            renderEmail({
              body: built.body,
              fromName: config.from_name,
              fromEmail: config.from_email,
              signature: config.signature,
              leadName: lead.name,
              includeFooter: false,
            }),
          files: built.files,
          deliveryKey: 'funnel:' + job.id + ':' + job.next_step,
          beforeSend: () => {
            // Do not call assertCanContact here: outreach already reserved a SENDING row,
            // which counts toward the three-email limit and would falsely block the 3rd send.
            const { lead: current } = verify();
            const again = compose(step, current, config, config.from_name, 'check');
            if (stepRecipient(again, job.recipient) !== sendTo)
              throw new HttpError(
                409,
                'Lead, recipient or training changed after enrollment. Review this lead before contacting again.',
              );
          },
        });
        const next = job.next_step + 1;
        // A time the author picked for this follow-up wins over the funnel's own delay.
        const chosen = parseSchedule(job.schedule_json)[next];
        db.prepare(
          `UPDATE funnel_enrollments SET next_step=?,status=?,next_send_at=?,updated_at=?
          WHERE id=? AND project_id=? AND status='SENDING'`,
        ).run(
          next,
          next === f.steps.length ? 'COMPLETED' : 'QUEUED',
          chosen ??
            scheduleNextSend(
              Math.max(time, Date.now()),
              f.steps[next]?.delay_days || 0,
              f.steps[next]?.send_time,
            ),
          now(),
          job.id,
          job.project_id,
        );
      } catch (error) {
        const blocked = db.prepare(
          `UPDATE funnel_enrollments SET status='BLOCKED',reason=?,updated_at=?
          WHERE id=? AND project_id=? AND status='SENDING'`,
        );
        if (!(error instanceof HttpError))
          // The enrollment keeps a generic reason, but an unexpected cause must not vanish:
          // without this, a blocked sequence has no explanation anywhere.
          console.error(
            '[mail] Delivery failed for enrollment ' + job.id + ':',
            (error as { code?: string; name?: string })?.code ||
              (error as { name?: string })?.name ||
              'UnknownError',
          );
        blocked.run(
          error instanceof HttpError
            ? error.message
            : 'Delivery stopped. Check mailbox settings and lead eligibility.',
          now(),
          job.id,
          job.project_id,
        );
      }
    } finally {
      running = false;
    }
  }
  return { install, tick, campaignOptions, planCampaign, startCampaign, compose };
}

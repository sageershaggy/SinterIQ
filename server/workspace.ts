import type { Express } from 'express';
import { z } from 'zod';
import { audit, now, type DB } from './database';
import { blocksSchema } from './email-blocks';
import { emailTemplates, templateCategories } from './email-templates';
import { mergeFields } from './email-blocks';
import { HttpError, positiveId, requiredText, text } from './validation';
import type { Project, User } from '../shared/types';

// Drafts may contain incomplete URLs and empty fields. Sending still applies the strict renderer.
const draftString = z.string().max(4000);
const draftBlocks = z
  .array(
    z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('heading'),
          text: draftString,
          level: z.enum(['h1', 'h2']),
          align: z.enum(['left', 'center']),
        })
        .strict(),
      z
        .object({ type: z.literal('text'), text: draftString, align: z.enum(['left', 'center']) })
        .strict(),
      z
        .object({
          type: z.literal('button'),
          label: draftString,
          url: draftString,
          align: z.enum(['left', 'center']),
        })
        .strict(),
      z
        .object({
          type: z.literal('image'),
          url: draftString,
          alt: draftString,
          width: z.number().int().min(40).max(560),
        })
        .strict(),
      z.object({ type: z.literal('quote'), text: draftString, cite: draftString }).strict(),
      z.object({ type: z.literal('divider') }).strict(),
      z.object({ type: z.literal('spacer'), size: z.enum(['small', 'medium', 'large']) }).strict(),
    ]),
  )
  .max(60);
const draftSchema = z
  .object({
    revision: z.number().int().min(0),
    to: z.string().max(200),
    subject: z.string().max(200),
    preview_text: z.string().max(200),
    blocks: draftBlocks,
  })
  .strict();

export function savedDraft(db: DB, projectId: number, leadId: number, accountId: number) {
  const row = db
    .prepare(
      'SELECT revision,document_json,updated_at FROM email_drafts WHERE project_id=? AND lead_id=? AND account_id=?',
    )
    .get(projectId, leadId, accountId) as
    { revision: number; document_json: string; updated_at: string } | undefined;
  return {
    revision: row?.revision || 0,
    document: row ? JSON.parse(row.document_json) : null,
    updated_at: row?.updated_at || null,
  };
}

/** Recipient lists are captured at creation, then access is checked again on every read. */
export function notifyLead(
  db: DB,
  projectId: number,
  leadId: number,
  kind: string,
  title: string,
  accountId?: number,
) {
  db.prepare(
    `INSERT INTO notifications (account_id,project_id,lead_id,kind,title,created_at)
    SELECT a.id,?,?,?,?,? FROM accounts a
    WHERE a.active=1 AND (? IS NULL OR a.id=?)
    AND (a.role='admin' OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=? AND m.account_id=a.id))
    AND EXISTS (SELECT 1 FROM leads l WHERE l.project_id=? AND l.id=?)`,
  ).run(
    projectId,
    leadId,
    kind,
    title.slice(0, 300),
    now(),
    accountId ?? null,
    accountId ?? null,
    projectId,
    projectId,
    leadId,
  );
}

export function installWorkspace(
  app: Express,
  db: DB,
  getProject: (db: DB, id: number, user: User) => Project,
) {
  const scope = (projectId: unknown, leadId: unknown, user: User) => {
    const project = getProject(db, positiveId(projectId), user);
    const id = positiveId(leadId);
    if (!db.prepare('SELECT 1 FROM leads WHERE project_id=? AND id=?').get(project.id, id))
      throw new HttpError(404, 'Lead not found.');
    return { project, id };
  };
  app.put('/api/projects/:projectId/leads/:leadId/email/draft', (req, res) => {
    const { project, id } = scope(req.params.projectId, req.params.leadId, req.user);
    const { revision, ...document } = draftSchema.parse(req.body);
    db.transaction(() => {
      const current = savedDraft(db, project.id, id, req.user.id);
      if (revision !== current.revision)
        throw new HttpError(
          409,
          'This draft changed in another tab. Reload the saved draft before making more changes. Your current text has been kept in this editor.',
        );
      db.prepare(
        `INSERT INTO email_drafts (project_id,lead_id,account_id,revision,document_json,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(project_id,lead_id,account_id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json,updated_at=excluded.updated_at`,
      ).run(project.id, id, req.user.id, revision + 1, JSON.stringify(document), now());
    })();
    res.json(savedDraft(db, project.id, id, req.user.id));
  });
  app.get('/api/projects/:projectId/email/templates', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const custom = db
      .prepare(
        'SELECT * FROM project_email_templates WHERE project_id=? ORDER BY id DESC LIMIT 100',
      )
      .all(project.id) as Array<Record<string, unknown>>;
    res.json({
      templates: [
        ...custom.map(({ blocks_json, ...row }) => ({
          ...row,
          id: 'project-' + row.id,
          blocks: JSON.parse(String(blocks_json)),
          custom: true,
        })),
        ...emailTemplates,
      ],
      categories: templateCategories,
      merge_fields: mergeFields,
    });
  });
  app.post('/api/projects/:projectId/email/templates', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = z
      .object({
        name: requiredText(100),
        category: z.enum(['outreach', 'follow_up', 'meeting', 'transactional']),
        description: text(300).default(''),
        subject: requiredText(200),
        preview_text: text(200).default(''),
        blocks: blocksSchema,
      })
      .strict()
      .parse(req.body);
    const count = db
      .prepare('SELECT COUNT(*) total FROM project_email_templates WHERE project_id=?')
      .get(project.id) as { total: number };
    if (count.total >= 100)
      throw new HttpError(409, 'This project already has 100 saved templates.');
    const result = db
      .prepare(
        'INSERT INTO project_email_templates (project_id,name,category,description,subject,preview_text,blocks_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        project.id,
        input.name,
        input.category,
        input.description,
        input.subject,
        input.preview_text,
        JSON.stringify(input.blocks),
        req.user.name,
        now(),
      );
    audit(db, project.id, req.user.name, 'email.template_created', input.name);
    res.status(201).json({ ...input, id: 'project-' + result.lastInsertRowid, custom: true });
  });
  // The notification feed (lead and project updates, grouped) lives in server/notifications.ts.
}

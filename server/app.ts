import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { openDatabase, audit, hash, nameKey, websiteKey, now, type DB } from './database';
import { installAuth, adminOnly } from './auth';
import { fetchWebsite, checkedUrl } from './network';
import { extractDocument } from './documents';
import { preservedRecords, previousResearchContext } from './legacy';
import {
  analyzeTraining,
  generate,
  getAiConfig,
  publicSettings,
  qualify,
  type Generate,
} from './ai';
import {
  HttpError,
  positiveId,
  projectSchema,
  leadSchema,
  rubricSchema,
  decisionSchema,
  feedbackSchema,
  callSchema,
  emailSettingsSchema,
  emailSendSchema,
  requiredText,
  text,
  webUrl,
} from './validation';
import { readImportRows, mapImportRows } from './import';
import {
  applyMerge,
  blocksSchema,
  validateBlocks,
  checkBlocks,
  mergeFields,
  renderBlocks,
  type MergeContext,
} from './email-blocks';
import { emailTemplates, templateCategories } from './email-templates';
import {
  assertAddress,
  assertMailHost,
  draftFor,
  getEmailConfig,
  publicEmailSettings,
  renderEmail,
  sendMail,
  type Send,
} from './email';
import { nextStepFor, nextStepBands } from '../shared/types';
import type { Lead, Project, Source, TrainingSnapshot, Evidence, User } from '../shared/types';

const sourceColumns = 'id,project_id,kind,title,url,content,filename,sha256,created_at';
const projectSelect = `SELECT p.*,
  (p.id=(SELECT CAST(value AS INTEGER) FROM meta WHERE key='starter_project_id')) is_starter,
  (SELECT COUNT(*) FROM leads WHERE project_id=p.id AND legacy_id IS NOT NULL) preserved_lead_count,
  (SELECT COUNT(*) FROM preserved_research WHERE project_id=p.id AND kind='contacts') preserved_contact_count,
  (SELECT COUNT(*) FROM preserved_research WHERE project_id=p.id AND kind<>'contacts') preserved_activity_count,
  (SELECT COUNT(*) FROM sources WHERE project_id=p.id) source_count,
  (SELECT COUNT(*) FROM project_members WHERE project_id=p.id) member_count,
  (SELECT COUNT(*) FROM lead_feedback WHERE project_id=p.id AND applied_version IS NULL) pending_feedback_count,
  (SELECT COUNT(*) FROM leads WHERE project_id=p.id) lead_count,
  (SELECT COUNT(*) FROM leads WHERE project_id=p.id AND status='QUALIFIED' AND training_version=p.active_version AND qualified_revision=revision AND p.trained_revision=p.revision) qualified_count,
  (SELECT COUNT(*) FROM leads WHERE project_id=p.id AND (status IN ('UNREVIEWED','NEEDS_REVIEW') OR training_version IS NOT p.active_version OR qualified_revision IS NOT revision OR p.trained_revision IS NOT p.revision)) review_count
  FROM projects p`;
const serializeProject = (row: Record<string, unknown>) => {
  const { rubric_json, ...rest } = row;
  return {
    ...rest,
    is_starter: Boolean(rest.is_starter),
    rubric: JSON.parse(String(rubric_json)),
  } as unknown as Project;
};
/**
 * Administrators reach every project. A researcher reaches only assigned projects, and an
 * unassigned project is reported as missing so membership cannot be probed by ID.
 */
export function getProject(db: DB, id: number, user?: User) {
  const row = db.prepare(projectSelect + ' WHERE p.id=?').get(id) as
    Record<string, unknown> | undefined;
  if (!row || (user && !canReach(db, user, id))) throw new HttpError(404, 'Project not found.');
  return serializeProject(row);
}
export function canReach(db: DB, user: User, projectId: number) {
  return (
    user.role === 'admin' ||
    Boolean(
      db
        .prepare('SELECT 1 FROM project_members WHERE project_id=? AND account_id=?')
        .get(projectId, user.id),
    )
  );
}
function getSources(db: DB, projectId: number) {
  return db
    .prepare('SELECT ' + sourceColumns + ' FROM sources WHERE project_id=? ORDER BY id')
    .all(projectId) as Source[];
}
function trainingSnapshot(db: DB, project: Project): TrainingSnapshot {
  return {
    project: {
      name: project.name,
      description: project.description,
      website: project.website,
    },
    rubric: project.rubric,
    sources: getSources(db, project.id),
    // Accumulated reviewer corrections travel with the snapshot, so a published
    // version keeps the exact feedback it was approved against.
    feedback: db
      .prepare(
        'SELECT l.name lead_name,f.verdict,f.expected_decision,f.notes FROM lead_feedback f JOIN leads l ON l.id=f.lead_id WHERE f.project_id=? ORDER BY f.id DESC LIMIT 50',
      )
      .all(project.id) as TrainingSnapshot['feedback'],
  };
}
function changed(db: DB, id: number) {
  db.prepare('UPDATE projects SET revision=revision+1,updated_at=? WHERE id=?').run(now(), id);
}
function assertRevision(actual: number, expected: unknown) {
  if (positiveId(expected) !== actual)
    throw new HttpError(409, 'This record changed in another session. Refresh before saving.');
}
function serializeLead(row: Lead, project: Project): Lead {
  const stale = Boolean(
    row.latest_run_id &&
    (row.training_version !== project.active_version ||
      row.qualified_revision !== row.revision ||
      project.revision !== project.trained_revision),
  );
  return {
    ...row,
    reviewed: Boolean(row.reviewed),
    stale,
    // A superseded result must not keep advertising an outreach step.
    next_step: stale ? 'NONE' : nextStepFor(row.status, row.score),
  };
}
export const leadQuerySchema = z.object({
  search: text(200).default(''),
  status: z
    .enum([
      'ALL',
      'REVIEW_QUEUE',
      'UNREVIEWED',
      'QUALIFIED',
      'NOT_A_TARGET',
      'NEEDS_REVIEW',
      'STALE',
      'CALL_READY',
      'SEND_EMAIL',
      'REVIEW_WITH_CLIENT',
      'ASSIGNED',
      'UNASSIGNED',
    ])
    .default('ALL'),
  assigned_to: z.enum(['any', 'me']).default('any'),
});
/**
 * One filter definition, shared by the lead list and the CSV export so both agree.
 * Columns are qualified with `l.` so callers can join the assignee and call count.
 */
function leadFilter(project: Project, input: z.infer<typeof leadQuerySchema>, viewerId: number) {
  let where = 'l.project_id=?';
  const params: (string | number)[] = [project.id];
  if (input.search) {
    where +=
      " AND (l.name LIKE ? ESCAPE '\\' OR l.industry LIKE ? ESCAPE '\\' OR l.country LIKE ? ESCAPE '\\' OR l.city LIKE ? ESCAPE '\\' OR l.contact_name LIKE ? ESCAPE '\\')";
    const q = '%' + input.search.replace(/[\\%_]/g, '\\$&') + '%';
    params.push(q, q, q, q, q);
  }
  const current = [project.active_version || 0, project.trained_revision || 0, project.revision];
  const stale =
    '(l.training_version IS NOT ? OR l.qualified_revision IS NOT l.revision OR ? IS NOT ?)';
  if (input.status === 'REVIEW_QUEUE') {
    where +=
      " AND (l.status IN ('UNREVIEWED','NEEDS_REVIEW') OR l.assigned_to IS NOT NULL OR (l.latest_run_id IS NOT NULL AND " +
      stale +
      '))';
    params.push(...current);
  } else if (input.status === 'STALE') {
    where += ' AND l.latest_run_id IS NOT NULL AND ' + stale;
    params.push(...current);
  } else if (input.status === 'ASSIGNED') {
    where += ' AND l.assigned_to IS NOT NULL';
  } else if (input.status === 'UNASSIGNED') {
    where += " AND l.assigned_to IS NULL AND l.status='QUALIFIED'";
  } else if (
    input.status === 'CALL_READY' ||
    input.status === 'SEND_EMAIL' ||
    input.status === 'REVIEW_WITH_CLIENT'
  ) {
    // Mirrors nextStepFor: outreach bands only describe results from the current training.
    const band =
      input.status === 'CALL_READY'
        ? " AND l.status='QUALIFIED' AND l.score>=" + nextStepBands.call
        : input.status === 'SEND_EMAIL'
          ? " AND l.status='QUALIFIED' AND l.score>=" +
            nextStepBands.email +
            ' AND l.score<' +
            nextStepBands.call
          : " AND (l.status='NEEDS_REVIEW' OR (l.status='QUALIFIED' AND l.score>=" +
            nextStepBands.review +
            ' AND l.score<' +
            nextStepBands.email +
            '))';
    where +=
      band +
      ' AND l.latest_run_id IS NOT NULL AND l.training_version IS ? AND l.qualified_revision IS l.revision AND ? IS ?';
    params.push(...current);
  } else if (input.status !== 'ALL') {
    where += ' AND l.status=?';
    params.push(input.status);
  }
  if (input.assigned_to === 'me') {
    where += ' AND l.assigned_to=?';
    params.push(viewerId);
  }
  return { where, params };
}
const fieldLabels: Record<string, string> = {
  name: 'Company name',
  website: 'Website',
  country: 'Country',
  city: 'City',
  industry: 'Industry',
  employee_count: 'Employees',
  contact_name: 'Contact name',
  contact_role: 'Job title',
  contact_email: 'Contact email',
  contact_phone: 'Contact phone',
  notes: 'Notes',
};
/** Turns a validator issue into something a person reading a spreadsheet can act on. */
function friendlyIssue(path: string, message: string) {
  const label = fieldLabels[path] || 'This row';
  if (/expected string to have >=1|too small/i.test(message)) return label + ' is empty.';
  if (/at most|too big|>=?d+ characters/i.test(message)) return label + ' is too long.';
  if (/email/i.test(message)) return label + ' is not a valid email address.';
  if (/phone/i.test(message)) return label + ' is not a valid phone number.';
  if (/http/i.test(message)) return label + ' must be a complete http(s) address.';
  return label + ': ' + message;
}
/** The only values a merge field can resolve to. */
function mergeContext(lead: Lead, senderName: string): MergeContext {
  return {
    company: lead.name,
    contact_name: lead.contact_name,
    contact_first_name: lead.contact_name.split(' ')[0] || '',
    contact_role: lead.contact_role,
    city: lead.city,
    country: lead.country,
    industry: lead.industry,
    sender_name: senderName,
  };
}
function getLead(db: DB, project: Project, id: number) {
  const row = db.prepare('SELECT * FROM leads WHERE id=? AND project_id=?').get(id, project.id) as
    Lead | undefined;
  if (!row) throw new HttpError(404, 'Lead not found in this project.');
  return serializeLead(row, project);
}
function insertLead(db: DB, projectId: number, lead: z.infer<typeof leadSchema>) {
  const nKey = nameKey(lead.name),
    wKey = websiteKey(lead.website);
  const duplicate = db
    .prepare(
      "SELECT id,name FROM leads WHERE project_id=? AND ((name_key=? AND name_key<>'') OR (website_key=? AND website_key<>'')) LIMIT 1",
    )
    .get(projectId, nKey, wKey) as { id: number; name: string } | undefined;
  if (duplicate) return { duplicate };
  const id = Number(
    db
      .prepare(
        'INSERT INTO leads (project_id,name,name_key,website,website_key,country,city,industry,employee_count,contact_name,contact_role,contact_email,contact_phone,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        projectId,
        lead.name,
        nKey,
        lead.website,
        wKey,
        lead.country,
        lead.city,
        lead.industry,
        lead.employee_count,
        lead.contact_name,
        lead.contact_role,
        lead.contact_email,
        lead.contact_phone,
        lead.notes,
        now(),
        now(),
      ).lastInsertRowid,
  );
  return { id };
}

export function createApp(options: {
  dataDir: string;
  legacyPath?: string;
  production?: boolean;
  origin?: string;
  generate?: Generate;
  fetchWebsite?: typeof fetchWebsite;
  extractDocument?: typeof extractDocument;
  sendMail?: Send;
}) {
  const production = options.production || false;
  const { db, secrets } = openDatabase(options.dataDir, options.legacyPath);
  const callAi = options.generate || generate;
  const readWebsite = options.fetchWebsite || fetchWebsite;
  const readDocument = options.extractDocument || extractDocument;
  const deliver = options.sendMail || sendMail;
  const app = express();
  app.disable('x-powered-by');
  if (production && !options.origin?.startsWith('https://'))
    throw new Error('Production requires INNOVISTA_ORIGIN with an HTTPS origin.');
  if (process.env.INNOVISTA_TRUST_PROXY === '1') app.set('trust proxy', 1);
  const origin = options.origin ? new URL(options.origin).origin : '';
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: production ? ["'self'"] : ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: production ? ["'self'"] : ["'self'", 'ws://localhost:*', 'ws://127.0.0.1:*'],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      strictTransportSecurity: production ? { maxAge: 31536000 } : false,
      xFrameOptions: { action: 'deny' },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const host = req.headers.host || '';
    const allowedHosts = origin
      ? [
          new URL(origin).host,
          'localhost:' + (process.env.PORT || 3000),
          '127.0.0.1:' + (process.env.PORT || 3000),
        ]
      : [];
    if (
      origin
        ? !allowedHosts.includes(host)
        : !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
    )
      return res.status(403).json({ error: 'Unrecognized host.' });
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
      const expectedOrigin = origin || 'http://' + host;
      if (req.headers.origin && req.headers.origin !== expectedOrigin)
        return res.status(403).json({ error: 'Cross-origin request refused.' });
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.headers['x-requested-with'] !== 'Innovista'
      )
        return res.status(403).json({ error: 'Request verification header required.' });
    }
    next();
  });
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many requests. Retry shortly.' },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  installAuth(app, db, production);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5_000_000,
      files: 1,
      fields: 5,
      fieldSize: 4000,
      parts: 7,
    },
  });
  const expensiveLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 40,
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Analysis limit reached. Please retry in 15 minutes.' },
  });
  const fileLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 40,
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Upload limit reached. Please retry in 15 minutes.' },
  });
  const busy = new Set<string>();
  async function single<T>(key: string, work: () => Promise<T>) {
    if (busy.has(key)) throw new HttpError(409, 'Analysis is already running for this item.');
    if (busy.size >= 3)
      throw new HttpError(
        429,
        'Three analyses are already running. Please retry when one finishes.',
      );
    busy.add(key);
    try {
      return await work();
    } finally {
      busy.delete(key);
    }
  }
  app.get('/api/health', (_req, res) => {
    try {
      const initialized = db.prepare("SELECT 1 FROM meta WHERE key='initialized'").get();
      if (!initialized) throw new Error('Database is not initialized.');
      res.json({ ok: true, application: 'Innovista Research AI', database: 'connected' });
    } catch {
      res
        .status(503)
        .json({ ok: false, application: 'Innovista Research AI', database: 'unavailable' });
    }
  });
  app.get('/api/projects', (req, res) =>
    res.json(
      (
        db
          .prepare(
            projectSelect +
              (req.user.role === 'admin'
                ? ''
                : ' JOIN project_members m ON m.project_id=p.id AND m.account_id=?') +
              ' ORDER BY p.id',
          )
          .all(...(req.user.role === 'admin' ? [] : [req.user.id])) as Record<string, unknown>[]
      ).map(serializeProject),
    ),
  );
  app.post('/api/projects', adminOnly, (req, res) => {
    const input = projectSchema.parse(req.body);
    if (input.website) checkedUrl(input.website);
    const id = Number(
      db
        .prepare(
          'INSERT INTO projects (name,description,website,created_at,updated_at) VALUES (?,?,?,?,?)',
        )
        .run(input.name, input.description, input.website, now(), now()).lastInsertRowid,
    );
    audit(db, id, req.user.name, 'project.created', input.name);
    res.status(201).json(getProject(db, id));
  });
  app.get('/api/projects/:projectId', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    res.json({
      project,
      sources: getSources(db, project.id),
      versions: db
        .prepare(
          'SELECT version,revision,created_at,created_by FROM training_versions WHERE project_id=? ORDER BY version DESC',
        )
        .all(project.id),
    });
  });
  app.put('/api/projects/:projectId', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const { revision, ...body } = req.body;
    assertRevision(project.revision, revision);
    const input = projectSchema.parse(body);
    if (input.website) checkedUrl(input.website);
    db.prepare(
      'UPDATE projects SET name=?,description=?,website=?,revision=revision+1,updated_at=? WHERE id=?',
    ).run(input.name, input.description, input.website, now(), project.id);
    audit(
      db,
      project.id,
      req.user.name,
      'project.updated',
      'Project context changed; training requires publishing again.',
    );
    res.json(getProject(db, project.id));
  });

  function addSource(
    project: Project,
    source: {
      kind: Source['kind'];
      title: string;
      url?: string;
      content: string;
      filename?: string;
      original?: Buffer;
      mime?: string;
    },
    actor: string,
  ) {
    return db.transaction(() => {
      const current = getProject(db, project.id);
      assertRevision(current.revision, project.revision);
      const existing = getSources(db, project.id);
      if (
        existing.length >= 30 ||
        existing.reduce((total, item) => total + item.content.length, 0) + source.content.length >
          120000
      )
        throw new HttpError(
          413,
          'A project supports 30 sources and 120,000 characters of training text. Remove or shorten a source first.',
        );
      const digest = hash(source.content);
      if (existing.some((item) => item.sha256 === digest))
        throw new HttpError(409, 'This source content is already attached.');
      const id = Number(
        db
          .prepare(
            'INSERT INTO sources (project_id,kind,title,url,content,filename,original,mime,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            project.id,
            source.kind,
            source.title,
            source.url || '',
            source.content,
            source.filename || '',
            source.original || null,
            source.mime || 'text/plain',
            digest,
            now(),
          ).lastInsertRowid,
      );
      changed(db, project.id);
      audit(db, project.id, actor, 'source.added', source.title);
      return db.prepare('SELECT ' + sourceColumns + ' FROM sources WHERE id=?').get(id);
    })();
  }
  app.post('/api/projects/:projectId/sources', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = z
      .object({
        title: requiredText(200),
        content: requiredText(60000).min(40),
        revision: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    assertRevision(project.revision, input.revision);
    res
      .status(201)
      .json(
        addSource(
          project,
          { kind: 'note', title: input.title, content: input.content },
          req.user.name,
        ),
      );
  });
  app.post(
    '/api/projects/:projectId/sources/upload',
    fileLimit,
    upload.single('file'),
    async (req, res) => {
      const project = getProject(db, positiveId(req.params.projectId), req.user);
      assertRevision(project.revision, req.body.revision);
      if (!req.file) throw new HttpError(400, 'Select a training document.');
      const content = await single('document:' + req.user.id, () => readDocument(req.file!));
      const filename = req.file.originalname.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 180);
      res.status(201).json(
        addSource(
          project,
          {
            kind: 'document',
            title: filename,
            filename,
            original: req.file.buffer,
            content,
            mime: 'application/octet-stream',
          },
          req.user.name,
        ),
      );
    },
  );
  app.post('/api/projects/:projectId/sources/website', expensiveLimit, async (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = z
      .object({ url: webUrl.min(1), revision: z.number().int().positive() })
      .strict()
      .parse(req.body);
    assertRevision(project.revision, input.revision);
    const page = await single('website:' + project.id, () => readWebsite(input.url));
    const source = addSource(
      project,
      {
        kind: 'website',
        title: new URL(page.url).hostname + (page.truncated ? ' · excerpt' : ''),
        url: page.url,
        content: page.content,
      },
      req.user.name,
    );
    res.status(201).json({ source, truncated: page.truncated });
  });
  app.get('/api/projects/:projectId/sources/:sourceId/download', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const source = db
      .prepare('SELECT * FROM sources WHERE id=? AND project_id=?')
      .get(positiveId(req.params.sourceId), project.id) as
      (Source & { original: Buffer | null }) | undefined;
    if (!source) throw new HttpError(404, 'Source not found in this project.');
    const filename = (source.filename || source.title + '.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.type('application/octet-stream').send(source.original || Buffer.from(source.content));
  });
  app.delete('/api/projects/:projectId/sources/:sourceId', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    assertRevision(project.revision, req.body.revision);
    const result = db
      .prepare('DELETE FROM sources WHERE id=? AND project_id=?')
      .run(positiveId(req.params.sourceId), project.id);
    if (!result.changes) throw new HttpError(404, 'Source not found in this project.');
    changed(db, project.id);
    audit(
      db,
      project.id,
      req.user.name,
      'source.removed',
      String(req.params.sourceId) + '. Published snapshots retain their source text.',
    );
    res.json({ ok: true });
  });
  app.put('/api/projects/:projectId/training/rubric', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    assertRevision(project.revision, req.body.revision);
    const rubric = rubricSchema.parse(req.body.rubric);
    db.prepare('UPDATE projects SET rubric_json=?,revision=revision+1,updated_at=? WHERE id=?').run(
      JSON.stringify(rubric),
      now(),
      project.id,
    );
    audit(
      db,
      project.id,
      req.user.name,
      'training.rubric_saved',
      'Draft qualification rules updated.',
    );
    res.json(getProject(db, project.id));
  });
  app.post('/api/projects/:projectId/training/analyze', expensiveLimit, async (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    assertRevision(project.revision, req.body.revision);
    const snapshot = trainingSnapshot(db, project);
    if (!snapshot.sources.length)
      throw new HttpError(400, 'Attach at least one source before analyzing training.');
    const config = getAiConfig(db, secrets);
    const result = await single('training:' + project.id, () =>
      analyzeTraining(config, snapshot, callAi),
    );
    assertRevision(getProject(db, project.id).revision, project.revision);
    db.prepare(
      'INSERT INTO training_analyses (project_id,revision,result_json,model,created_at,created_by) VALUES (?,?,?,?,?,?)',
    ).run(project.id, project.revision, JSON.stringify(result), config.model, now(), req.user.name);
    audit(
      db,
      project.id,
      req.user.name,
      'training.analyzed',
      'Proposed rules generated; approval required before use.',
    );
    res.json({ rubric: result, revision: project.revision });
  });
  app.get('/api/projects/:projectId/training/analyses', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    res.json(
      (
        db
          .prepare('SELECT * FROM training_analyses WHERE project_id=? ORDER BY id DESC LIMIT 20')
          .all(project.id) as Array<Record<string, unknown>>
      ).map(({ result_json, ...row }) => ({
        ...row,
        rubric: JSON.parse(String(result_json)),
      })),
    );
  });
  app.post('/api/projects/:projectId/training/publish', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    assertRevision(project.revision, req.body.revision);
    const snapshot = trainingSnapshot(db, project);
    rubricSchema.parse(snapshot.rubric);
    if (
      !snapshot.project.website ||
      !snapshot.sources.some(
        (s) => s.kind === 'website' && websiteKey(s.url) === websiteKey(snapshot.project.website),
      ) ||
      !snapshot.sources.some((s) => s.kind === 'note' || s.kind === 'document')
    )
      throw new HttpError(
        400,
        'Attach a training document or note and capture the business website before publishing. The captured website must match the domain in Project settings.',
      );
    if (snapshot.rubric.questions.length)
      throw new HttpError(
        400,
        'Resolve and remove the open questions in the rubric before publishing.',
      );
    if (project.trained_revision === project.revision)
      throw new HttpError(409, 'This training revision is already published.');
    const version = (project.active_version || 0) + 1;
    db.transaction(() => {
      db.prepare(
        'INSERT INTO training_versions (project_id,version,revision,snapshot_json,created_at,created_by) VALUES (?,?,?,?,?,?)',
      ).run(project.id, version, project.revision, JSON.stringify(snapshot), now(), req.user.name);
      db.prepare(
        'UPDATE projects SET active_version=?,trained_revision=?,updated_at=? WHERE id=?',
      ).run(version, project.revision, now(), project.id);
      db.prepare(
        'UPDATE lead_feedback SET applied_version=? WHERE project_id=? AND applied_version IS NULL',
      ).run(version, project.id);
      audit(
        db,
        project.id,
        req.user.name,
        'training.published',
        'Version ' + version + ' approved for qualification.',
      );
    })();
    res.json(getProject(db, project.id));
  });
  app.get('/api/projects/:projectId/training/versions/:version', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const row = db
      .prepare('SELECT * FROM training_versions WHERE project_id=? AND version=?')
      .get(project.id, positiveId(req.params.version)) as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, 'Training version not found.');
    const { snapshot_json, ...rest } = row;
    res.json({ ...rest, snapshot: JSON.parse(String(snapshot_json)) });
  });

  app.get('/api/projects/:projectId/leads', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = leadQuerySchema
      .extend({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        page_size: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const { where, params } = leadFilter(project, input, req.user.id);
    const { count } = db
      .prepare('SELECT COUNT(*) count FROM leads l WHERE ' + where)
      .get(...params) as { count: number };
    const rows = db
      .prepare(
        'SELECT l.*,a.name assigned_to_name,(SELECT COUNT(*) FROM call_logs c WHERE c.lead_id=l.id) call_count' +
          ' FROM leads l LEFT JOIN accounts a ON a.id=l.assigned_to WHERE ' +
          where +
          ' ORDER BY l.updated_at DESC,l.id DESC LIMIT ? OFFSET ?',
      )
      .all(...params, input.page_size, (input.page - 1) * input.page_size) as Lead[];
    res.json({
      leads: rows.map((row) => serializeLead(row, project)),
      total: count,
      page: input.page,
      page_size: input.page_size,
    });
  });
  app.post('/api/projects/:projectId/leads', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = leadSchema.parse(req.body);
    if (input.website) checkedUrl(input.website);
    const result = insertLead(db, project.id, input);
    if (result.duplicate)
      return res.status(409).json({
        error: 'This lead already exists in this project: ' + result.duplicate.name,
        existing_id: result.duplicate.id,
      });
    audit(db, project.id, req.user.name, 'lead.created', input.name);
    res.status(201).json(getLead(db, project, result.id!));
  });
  app.post(
    '/api/projects/:projectId/leads/import',
    fileLimit,
    upload.single('file'),
    async (req, res) => {
      const project = getProject(db, positiveId(req.params.projectId), req.user);
      if (!req.file) throw new HttpError(400, 'Choose a file to import.');
      // 'update' refreshes the leads that already exist instead of skipping them.
      const onDuplicate = req.body.on_duplicate === 'update' ? 'update' : 'skip';
      const rows = await readImportRows(req.file.originalname, req.file.buffer);
      // Reasons name the field in plain words — never a raw validator message.
      const { leads, problems, warnings } = mapImportRows(rows, (candidate) => {
        // An unusable website must not cost us the company. Blank it, keep the lead, and
        // say so — the researcher can add the real address and qualify it afterwards.
        let warning = '';
        if (candidate.website) {
          const supplied = candidate.website;
          let usable = false;
          try {
            usable = checkedUrl(supplied).hostname.includes('.');
          } catch {
            usable = false;
          }
          if (!usable) {
            candidate.website = '';
            warning =
              'Imported without a website: "' +
              supplied.slice(0, 120) +
              '" is not a usable public address. Add the real website, then qualify the lead.';
          }
        }
        const parsed = leadSchema.safeParse(candidate);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return { ok: false, reason: friendlyIssue(String(issue.path[0] ?? ''), issue.message) };
        }
        return { ok: true, value: parsed.data, warning };
      });
      if (!leads.length)
        throw new HttpError(
          400,
          'Nothing in that file could be imported as a company lead. This importer creates companies, so each row needs a Company Name (or Name) value. ' +
            (problems.length
              ? 'First problem — row ' + problems[0].row + ': ' + problems[0].reason
              : ''),
        );
      const results = db.transaction(() => {
        let created = 0,
          updated = 0;
        const duplicates: string[] = [];
        for (const lead of leads) {
          const result = insertLead(db, project.id, lead);
          if (!result.duplicate) {
            created++;
            continue;
          }
          if (onDuplicate !== 'update') {
            duplicates.push(lead.name);
            continue;
          }
          // Only fill in values the CSV actually carries, so a sparse row never blanks a lead.
          const current = db
            .prepare('SELECT * FROM leads WHERE id=? AND project_id=?')
            .get(result.duplicate.id, project.id) as Lead;
          const merged = {
            website: lead.website || current.website,
            country: lead.country || current.country,
            industry: lead.industry || current.industry,
            notes: lead.notes || current.notes,
          };
          const changedFields =
            merged.website !== current.website ||
            merged.country !== current.country ||
            merged.industry !== current.industry ||
            merged.notes !== current.notes;
          if (!changedFields) {
            duplicates.push(lead.name);
            continue;
          }
          db.prepare(
            'UPDATE leads SET website=?,website_key=?,country=?,industry=?,notes=?,revision=revision+1,reviewed=0,updated_at=? WHERE id=? AND project_id=?',
          ).run(
            merged.website,
            websiteKey(merged.website),
            merged.country,
            merged.industry,
            merged.notes,
            now(),
            result.duplicate.id,
            project.id,
          );
          updated++;
        }
        audit(
          db,
          project.id,
          req.user.name,
          'leads.imported',
          created +
            ' created; ' +
            updated +
            ' updated; ' +
            duplicates.length +
            ' unchanged duplicates skipped; ' +
            warnings.length +
            ' imported without a usable website; ' +
            problems.length +
            ' rows could not be read.',
        );
        return {
          updated,
          total: rows.length,
          created,
          skipped: duplicates.length,
          duplicates,
        };
      })();
      // Rows that could not be read are reported, never silently dropped.
      res.json({
        ...results,
        invalid: problems.length,
        problems: problems.slice(0, 50),
        warned: warnings.length,
        warnings: warnings.slice(0, 50),
      });
    },
  );
  app.get('/api/projects/:projectId/leads/export', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    // Export follows the same filter as the table, so "export what I am looking at" holds.
    const input = leadQuerySchema.parse(req.query);
    const { where, params } = leadFilter(project, input, req.user.id);
    const rows = db
      .prepare(
        'SELECT l.*,a.name assigned_to_name FROM leads l LEFT JOIN accounts a ON a.id=l.assigned_to WHERE ' +
          where +
          ' ORDER BY l.name',
      )
      .all(...params) as Lead[];
    const cell = (value: unknown) => {
      let v = String(value ?? '');
      if (/^[\s]*[=+@-]|^[\t\r\n]/.test(v)) v = "'" + v;
      return '"' + v.replace(/"/g, '""') + '"';
    };
    const csv = [
      [
        'name',
        'website',
        'contact_name',
        'contact_role',
        'contact_email',
        'contact_phone',
        'country',
        'city',
        'industry',
        'employee_count',
        'assigned_to',
        'calls_logged',
        'last_call_outcome',
        'last_call_notes',
        'decision',
        'score',
        'confidence',
        'next_step',
        'training_version',
        'needs_requalification',
        'human_reviewed',
        'ai_decision',
        'ai_reasoning',
        'why_qualified',
        'call_script',
        'human_review_reasoning',
        'reviewer',
        'reviewed_at',
      ] as unknown[],
      ...rows.map((row) => {
        const run = row.latest_run_id
          ? (db
              .prepare('SELECT result_json FROM qualification_runs WHERE id=? AND project_id=?')
              .get(row.latest_run_id, project.id) as { result_json: string } | undefined)
          : undefined;
        const review = row.latest_run_id
          ? (db
              .prepare(
                'SELECT notes,created_by,created_at FROM reviews WHERE run_id=? ORDER BY id DESC LIMIT 1',
              )
              .get(row.latest_run_id) as
              { notes: string; created_by: string; created_at: string } | undefined)
          : undefined;
        const result = run ? JSON.parse(run.result_json) : undefined;
        const serialized = serializeLead(row, project);
        const calls = {
          total: (
            db.prepare('SELECT COUNT(*) n FROM call_logs WHERE lead_id=?').get(row.id) as {
              n: number;
            }
          ).n,
          last: db
            .prepare('SELECT outcome,notes FROM call_logs WHERE lead_id=? ORDER BY id DESC LIMIT 1')
            .get(row.id) as { outcome: string; notes: string } | undefined,
        };
        return [
          row.name,
          row.website,
          row.contact_name,
          row.contact_role,
          row.contact_email,
          row.contact_phone,
          row.country,
          row.city,
          row.industry,
          row.employee_count,
          row.assigned_to_name || '',
          calls.total,
          calls.last?.outcome || '',
          calls.last?.notes || '',
          row.status,
          row.score,
          row.confidence,
          serialized.next_step,
          row.training_version,
          serialized.stale,
          Boolean(row.reviewed),
          result?.decision || '',
          result?.summary || '',
          result?.outreach?.why_qualified || '',
          result?.outreach?.call_script || '',
          review?.notes || '',
          review?.created_by || '',
          review?.created_at || '',
        ];
      }),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="innovista-' + input.status.toLowerCase() + '-leads.csv"',
    );
    res.type('text/csv').send('\uFEFF' + csv);
  });
  app.get('/api/projects/:projectId/leads/:leadId', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    const runs = (
      db
        .prepare(
          'SELECT * FROM qualification_runs WHERE lead_id=? AND project_id=? ORDER BY id DESC',
        )
        .all(lead.id, project.id) as Array<Record<string, unknown>>
    ).map(({ result_json, evidence_json, ...row }) => ({
      ...row,
      result: JSON.parse(String(result_json)),
      evidence: JSON.parse(String(evidence_json)),
    }));
    const reviews = db
      .prepare(
        'SELECT r.* FROM reviews r JOIN qualification_runs q ON q.id=r.run_id WHERE q.lead_id=? AND q.project_id=? ORDER BY r.id DESC',
      )
      .all(lead.id, project.id);
    res.json({
      ...lead,
      runs,
      reviews,
      preserved_records: preservedRecords(db, project.id, lead.id),
      feedback: db
        .prepare(
          'SELECT f.*,l.name lead_name FROM lead_feedback f JOIN leads l ON l.id=f.lead_id WHERE f.lead_id=? AND f.project_id=? ORDER BY f.id DESC',
        )
        .all(lead.id, project.id),
      calls: db
        .prepare(
          'SELECT * FROM call_logs WHERE lead_id=? AND project_id=? ORDER BY id DESC LIMIT 100',
        )
        .all(lead.id, project.id),
      emails: db
        .prepare(
          'SELECT * FROM email_messages WHERE lead_id=? AND project_id=? ORDER BY id DESC LIMIT 100',
        )
        .all(lead.id, project.id),
      assigned_to_name: lead.assigned_to
        ? ((
            db.prepare('SELECT name FROM accounts WHERE id=?').get(lead.assigned_to) as
              { name: string } | undefined
          )?.name ?? null)
        : null,
    });
  });
  app.put('/api/projects/:projectId/leads/:leadId', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    const { revision, ...body } = req.body;
    assertRevision(lead.revision, revision);
    const input = leadSchema.parse(body);
    if (input.website) checkedUrl(input.website);
    const duplicate = db
      .prepare(
        "SELECT id FROM leads WHERE project_id=? AND id<>? AND ((name_key=? AND name_key<>'') OR (website_key=? AND website_key<>''))",
      )
      .get(project.id, lead.id, nameKey(input.name), websiteKey(input.website));
    if (duplicate)
      throw new HttpError(409, 'A lead with that name or website already exists in this project.');
    db.prepare(
      'UPDATE leads SET name=?,name_key=?,website=?,website_key=?,country=?,city=?,industry=?,employee_count=?,contact_name=?,contact_role=?,contact_email=?,contact_phone=?,notes=?,revision=revision+1,reviewed=0,updated_at=? WHERE id=? AND project_id=?',
    ).run(
      input.name,
      nameKey(input.name),
      input.website,
      websiteKey(input.website),
      input.country,
      input.city,
      input.industry,
      input.employee_count,
      input.contact_name,
      input.contact_role,
      input.contact_email,
      input.contact_phone,
      input.notes,
      now(),
      lead.id,
      project.id,
    );
    audit(
      db,
      project.id,
      req.user.name,
      'lead.updated',
      input.name + '. Previous qualification retained for comparison.',
    );
    res.json(getLead(db, project, lead.id));
  });
  app.post('/api/projects/:projectId/leads/:leadId/qualify', expensiveLimit, async (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    if (!project.active_version || project.revision !== project.trained_revision)
      throw new HttpError(409, 'Publish the current project training before qualifying leads.');
    const version = db
      .prepare('SELECT snapshot_json FROM training_versions WHERE project_id=? AND version=?')
      .get(project.id, project.active_version) as { snapshot_json: string };
    const snapshot = JSON.parse(version.snapshot_json) as TrainingSnapshot;
    const result = await single('lead:' + lead.id, async () => {
      const config = getAiConfig(db, secrets);
      if (!config.api_key && !options.generate)
        throw new HttpError(409, 'Configure an AI provider in Settings first.');
      const evidence: Evidence[] = [
        {
          id: 'E1',
          kind: 'lead_record',
          title: 'User-provided lead record (unverified)',
          url: '',
          captured_at: now(),
          content: JSON.stringify({
            name: lead.name,
            country: lead.country,
            industry: lead.industry,
            notes: lead.notes,
          }),
        },
      ];
      const fetchFailures: string[] = [];
      if (lead.website) {
        const urls = [lead.website];
        for (let index = 0; index < Math.min(urls.length, 3); index++) {
          const url = urls[index];
          try {
            const page = await readWebsite(url);
            if (index === 0)
              urls.push(...(page.links || []).filter((link) => link !== url).slice(0, 2));
            if (!evidence.some((item) => item.content === page.content))
              evidence.push({
                id: 'E' + (evidence.length + 1),
                kind: 'website',
                title: new URL(page.url).hostname + new URL(page.url).pathname,
                url: page.url,
                content: page.content.slice(0, 15000),
                captured_at: now(),
              });
          } catch {
            fetchFailures.push(url);
          }
        }
      }
      const previous = previousResearchContext(
        lead.legacy_json,
        preservedRecords(db, project.id, lead.id),
      );
      if (previous)
        evidence.push({
          id: 'E' + (evidence.length + 1),
          kind: 'lead_record',
          title: 'Earlier company research (historical, unverified)',
          url: '',
          captured_at: now(),
          content: previous,
        });
      const qualified = await qualify(config, snapshot, lead, evidence, callAi);
      if (fetchFailures.length)
        qualified.next_steps.push('Some pages were unavailable: ' + fetchFailures.join(', '));
      return db.transaction(() => {
        const current = getProject(db, project.id),
          currentLead = getLead(db, current, lead.id);
        if (
          current.revision !== project.revision ||
          current.active_version !== project.active_version ||
          currentLead.revision !== lead.revision ||
          currentLead.latest_run_id !== lead.latest_run_id ||
          currentLead.updated_at !== lead.updated_at
        )
          throw new HttpError(
            409,
            'Training, lead data or a review changed during analysis. Retry against the latest version.',
          );
        const id = Number(
          db
            .prepare(
              'INSERT INTO qualification_runs (project_id,lead_id,training_version,lead_revision,result_json,evidence_json,provider,model,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
              project.id,
              lead.id,
              project.active_version,
              lead.revision,
              JSON.stringify(qualified),
              JSON.stringify(evidence),
              config.provider,
              config.model,
              now(),
              req.user.name,
            ).lastInsertRowid,
        );
        db.prepare(
          'UPDATE leads SET status=?,score=?,confidence=?,latest_run_id=?,training_version=?,qualified_revision=?,contact_name=?,contact_role=?,reviewed=0,updated_at=? WHERE id=? AND project_id=?',
        ).run(
          qualified.decision,
          qualified.score,
          qualified.confidence,
          id,
          project.active_version,
          lead.revision,
          qualified.outreach.contact_name,
          qualified.outreach.contact_role,
          now(),
          lead.id,
          project.id,
        );
        audit(
          db,
          project.id,
          req.user.name,
          'lead.qualified',
          lead.name + ': ' + qualified.decision + ' against training v' + project.active_version,
        );
        return { run_id: id, result: qualified };
      })();
    });
    res.json(result);
  });
  app.post('/api/projects/:projectId/leads/:leadId/review', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    const input = z
      .object({
        run_id: z.number().int().positive(),
        decision: decisionSchema,
        notes: requiredText(6000).min(15),
      })
      .strict()
      .parse(req.body);
    if (!lead.latest_run_id || input.run_id !== lead.latest_run_id || lead.stale)
      throw new HttpError(
        409,
        'Qualify this lead against the current training before reviewing it.',
      );
    db.transaction(() => {
      db.prepare(
        'INSERT INTO reviews (run_id,decision,notes,created_by,created_at) VALUES (?,?,?,?,?)',
      ).run(input.run_id, input.decision, input.notes, req.user.name, now());
      db.prepare(
        'UPDATE leads SET status=?,reviewed=1,updated_at=? WHERE id=? AND project_id=?',
      ).run(input.decision, now(), lead.id, project.id);
      audit(db, project.id, req.user.name, 'lead.reviewed', lead.name + ': ' + input.decision);
    })();
    res.json(getLead(db, project, lead.id));
  });
  /**
   * Lead-level training feedback. A correction is project knowledge, so it does not
   * change the stored run or the lead's decision; publishing the next training version
   * folds it into that version's snapshot.
   */
  app.post('/api/projects/:projectId/leads/:leadId/feedback', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    const input = feedbackSchema.parse(req.body);
    if (input.run_id !== null) {
      const run = db
        .prepare('SELECT 1 FROM qualification_runs WHERE id=? AND lead_id=? AND project_id=?')
        .get(input.run_id, lead.id, project.id);
      if (!run) throw new HttpError(404, 'That analysis does not belong to this lead.');
    }
    if (input.verdict === 'INCORRECT' && !input.expected_decision)
      throw new HttpError(400, 'Say which decision the lead should have received.');
    const id = Number(
      db
        .prepare(
          'INSERT INTO lead_feedback (project_id,lead_id,run_id,verdict,expected_decision,notes,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          project.id,
          lead.id,
          input.run_id,
          input.verdict,
          input.verdict === 'INCORRECT' ? input.expected_decision : null,
          input.notes,
          req.user.name,
          now(),
        ).lastInsertRowid,
    );
    // Feedback is new project knowledge, so the training needs publishing again before it applies.
    changed(db, project.id);
    audit(
      db,
      project.id,
      req.user.name,
      'training.feedback_added',
      lead.name +
        ': ' +
        input.verdict.toLowerCase() +
        '. Publish a training version to apply it to future research.',
    );
    res.status(201).json({ id, project: getProject(db, project.id) });
  });
  app.get('/api/projects/:projectId/feedback', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    res.json(
      db
        .prepare(
          'SELECT f.*,l.name lead_name FROM lead_feedback f JOIN leads l ON l.id=f.lead_id WHERE f.project_id=? ORDER BY f.id DESC LIMIT 200',
        )
        .all(project.id),
    );
  });
  /**
   * Assignment hands a lead to one researcher for calling. Only accounts that can already
   * reach the project may be assigned, so assignment never widens access.
   */
  function assign(project: Project, ids: number[], accountId: number | null, actor: string) {
    if (accountId !== null) {
      const account = db
        .prepare('SELECT id,name,role,active FROM accounts WHERE id=?')
        .get(accountId) as
        { id: number; name: string; role: User['role']; active: number } | undefined;
      if (!account || !account.active) throw new HttpError(404, 'That team member was not found.');
      if (!canReach(db, { ...account, username: '' } as User, project.id))
        throw new HttpError(
          400,
          account.name + ' is not assigned to this project. Grant project access first.',
        );
    }
    return db.transaction(() => {
      const found = db
        .prepare(
          'SELECT id FROM leads WHERE project_id=? AND id IN (' +
            ids.map(() => '?').join(',') +
            ')',
        )
        .all(project.id, ...ids) as Array<{ id: number }>;
      const update = db.prepare(
        'UPDATE leads SET assigned_to=?,assigned_at=?,updated_at=? WHERE id=? AND project_id=?',
      );
      for (const lead of found)
        update.run(accountId, accountId === null ? null : now(), now(), lead.id, project.id);
      audit(
        db,
        project.id,
        actor,
        accountId === null ? 'leads.unassigned' : 'leads.assigned',
        found.length + ' lead(s)' + (accountId === null ? ' returned to the pool.' : ' assigned.'),
      );
      return found.length;
    })();
  }
  app.put('/api/projects/:projectId/leads/:leadId/assignment', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    const input = z
      .object({ account_id: z.number().int().positive().nullable() })
      .strict()
      .parse(req.body);
    assign(project, [lead.id], input.account_id, req.user.name);
    res.json(getLead(db, project, lead.id));
  });
  app.post('/api/projects/:projectId/leads/assign', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = z
      .object({
        ids: z.array(z.number().int().positive()).min(1).max(500),
        account_id: z.number().int().positive().nullable(),
      })
      .strict()
      .parse(req.body);
    const count = assign(project, [...new Set(input.ids)], input.account_id, req.user.name);
    if (!count) throw new HttpError(404, 'No matching leads in this project.');
    res.json({ assigned: count });
  });
  /** Researchers who may hold an assignment in this project. */
  app.get('/api/projects/:projectId/assignees', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    res.json(
      db
        .prepare(
          "SELECT DISTINCT a.id,a.name,a.username,a.role FROM accounts a LEFT JOIN project_members m ON m.account_id=a.id AND m.project_id=? WHERE a.active=1 AND (a.role='admin' OR m.project_id IS NOT NULL) ORDER BY a.name",
        )
        .all(project.id),
    );
  });
  /** Append-only call log. Calling never changes the qualification or the decision. */
  app.post('/api/projects/:projectId/leads/:leadId/calls', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    const input = callSchema.parse(req.body);
    const id = Number(
      db
        .prepare(
          'INSERT INTO call_logs (project_id,lead_id,outcome,notes,created_by,created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(project.id, lead.id, input.outcome, input.notes, req.user.name, now()).lastInsertRowid,
    );
    db.prepare('UPDATE leads SET updated_at=? WHERE id=? AND project_id=?').run(
      now(),
      lead.id,
      project.id,
    );
    audit(db, project.id, req.user.name, 'lead.call_logged', lead.name + ': ' + input.outcome);
    res.status(201).json({ id });
  });
  /**
   * Removing a lead removes its research with it: runs, reviews, feedback and any
   * preserved reference records. Training versions are unaffected.
   */
  function removeLeads(project: Project, ids: number[], actor: string) {
    return db.transaction(() => {
      const found = db
        .prepare(
          'SELECT id,name FROM leads WHERE project_id=? AND id IN (' +
            ids.map(() => '?').join(',') +
            ')',
        )
        .all(project.id, ...ids) as Array<{ id: number; name: string }>;
      for (const lead of found) {
        db.prepare(
          'DELETE FROM reviews WHERE run_id IN (SELECT id FROM qualification_runs WHERE lead_id=? AND project_id=?)',
        ).run(lead.id, project.id);
        db.prepare('DELETE FROM lead_feedback WHERE lead_id=? AND project_id=?').run(
          lead.id,
          project.id,
        );
        db.prepare('DELETE FROM call_logs WHERE lead_id=? AND project_id=?').run(
          lead.id,
          project.id,
        );
        db.prepare('DELETE FROM email_messages WHERE lead_id=? AND project_id=?').run(
          lead.id,
          project.id,
        );
        // Detach the lead's last run before deleting the runs it points at.
        db.prepare('UPDATE leads SET latest_run_id=NULL WHERE id=? AND project_id=?').run(
          lead.id,
          project.id,
        );
        db.prepare('DELETE FROM qualification_runs WHERE lead_id=? AND project_id=?').run(
          lead.id,
          project.id,
        );
        db.prepare('DELETE FROM preserved_research WHERE lead_id=? AND project_id=?').run(
          lead.id,
          project.id,
        );
        db.prepare('DELETE FROM leads WHERE id=? AND project_id=?').run(lead.id, project.id);
      }
      audit(
        db,
        project.id,
        actor,
        'leads.deleted',
        found.length +
          ' lead(s) removed: ' +
          found
            .map((l) => l.name)
            .join(', ')
            .slice(0, 500),
      );
      return found.length;
    })();
  }
  app.delete('/api/projects/:projectId/leads/:leadId', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    removeLeads(project, [lead.id], req.user.name);
    res.json({ deleted: 1 });
  });
  app.post('/api/projects/:projectId/leads/delete', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = z
      .object({ ids: z.array(z.number().int().positive()).min(1).max(500) })
      .strict()
      .parse(req.body);
    const deleted = removeLeads(project, [...new Set(input.ids)], req.user.name);
    if (!deleted) throw new HttpError(404, 'No matching leads in this project.');
    res.json({ deleted });
  });
  // Erasure for a contact captured from a public website.
  app.delete('/api/projects/:projectId/leads/:leadId/contact', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    db.prepare(
      "UPDATE leads SET contact_name='',contact_role='',updated_at=? WHERE id=? AND project_id=?",
    ).run(now(), lead.id, project.id);
    audit(db, project.id, req.user.name, 'lead.contact_removed', lead.name);
    res.json(getLead(db, project, lead.id));
  });
  app.get('/api/projects/:projectId/activity', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const current = db
      .prepare('SELECT * FROM audit_events WHERE project_id=? ORDER BY id DESC LIMIT 100')
      .all(project.id) as Array<{ id: number | string; created_at: string }>;
    const previous = preservedRecords(db, project.id)
      .filter((record) => record.kind !== 'contacts')
      .map((record) => ({
        id: 'preserved-' + record.id,
        project_id: project.id,
        action:
          'previous research.' +
          (record.kind === 'notes'
            ? 'note'
            : record.kind === 'research_history'
              ? 'research session'
              : 'activity'),
        actor: String(record.data.performed_by || record.data.author || 'Previous workspace'),
        detail: [
          record.data.subject || record.data.company_name,
          record.data.details || record.data.message || record.data.results_json,
        ]
          .filter(Boolean)
          .join(' — '),
        created_at: String(
          record.data.activity_date || record.data.created_at || record.imported_at,
        ),
      }));
    res.json(
      [...current, ...previous]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 100),
    );
  });

  app.get('/api/settings/llm', adminOnly, (_req, res) =>
    res.json(publicSettings(getAiConfig(db, secrets))),
  );
  app.put('/api/settings/llm', adminOnly, (req, res) => {
    const input = z
      .object({
        provider: z.enum(['gemini', 'openai_compatible']),
        model: requiredText(200),
        base_url: webUrl.min(1),
        api_key: text(1000).default(''),
        clear_api_key: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    if (input.provider === 'openai_compatible') {
      const url = checkedUrl(input.base_url);
      if (url.protocol !== 'https:' || url.search || url.hash)
        throw new HttpError(400, 'Use a public HTTPS base URL without query parameters.');
    }
    const current = getAiConfig(db, secrets);
    if (
      current.api_key &&
      !input.api_key &&
      !input.clear_api_key &&
      (input.provider !== current.provider ||
        new URL(input.base_url).origin !== new URL(current.base_url).origin)
    )
      throw new HttpError(400, 'Enter a new API key when switching providers or endpoint domains.');
    db.transaction(() => {
      const save = db.prepare(
        'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      );
      for (const key of ['provider', 'model', 'base_url'] as const) save.run(key, input[key]);
      if (input.clear_api_key) save.run('api_key', '');
      else if (input.api_key) save.run('api_key', secrets.encrypt(input.api_key));
      audit(db, null, req.user.name, 'settings.updated', 'AI provider configuration updated.');
    })();
    res.json(publicSettings(getAiConfig(db, secrets)));
  });
  app.get('/api/settings/email', adminOnly, (_req, res) =>
    res.json(publicEmailSettings(getEmailConfig(db, secrets))),
  );
  app.put('/api/settings/email', adminOnly, async (req, res) => {
    const input = emailSettingsSchema.parse(req.body);
    if (input.host) await assertMailHost(input.host, input.port);
    if (input.from_email) assertAddress(input.from_email, 'The sender address');
    if (input.reply_to) assertAddress(input.reply_to, 'The reply-to address');
    if (input.host && !input.from_email)
      throw new HttpError(400, 'A sender address is required — recipients must see who sent it.');
    db.transaction(() => {
      const save = db.prepare(
        'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      );
      save.run('smtp_host', input.host);
      save.run('smtp_port', String(input.port));
      save.run('smtp_secure', input.secure ? '1' : '0');
      save.run('smtp_username', input.username);
      save.run('smtp_from_name', input.from_name);
      save.run('smtp_from_email', input.from_email);
      save.run('smtp_reply_to', input.reply_to);
      save.run('smtp_signature', input.signature);
      if (input.clear_password) save.run('smtp_password', '');
      else if (input.password) save.run('smtp_password', secrets.encrypt(input.password));
      audit(db, null, req.user.name, 'settings.email_updated', 'Workspace mailbox updated.');
    })();
    res.json(publicEmailSettings(getEmailConfig(db, secrets)));
  });
  /** Sends to the configured sender address, so setup can be proven before any lead is mailed. */
  app.post('/api/settings/email/test', adminOnly, expensiveLimit, async (req, res) => {
    const config = getEmailConfig(db, secrets);
    if (!config.configured)
      throw new HttpError(409, 'Save the mailbox settings with a password first.');
    await single('email-test', () =>
      deliver(config, {
        to: config.from_email,
        subject: 'Innovista Research AI — mailbox test',
        text: 'Your workspace mailbox is configured correctly.',
        html: '<p>Your workspace mailbox is configured correctly.</p>',
        replyTo: config.reply_to || config.from_email,
      }),
    );
    audit(db, null, req.user.name, 'settings.email_tested', 'Test message sent.');
    res.json({ ok: true, sent_to: config.from_email });
  });
  /** The draft a researcher edits before sending, built from the approved qualification. */
  app.get('/api/projects/:projectId/leads/:leadId/email/draft', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    const run = lead.latest_run_id
      ? (db
          .prepare('SELECT result_json FROM qualification_runs WHERE id=? AND project_id=?')
          .get(lead.latest_run_id, project.id) as { result_json: string } | undefined)
      : undefined;
    const result = run ? JSON.parse(run.result_json) : undefined;
    res.json({
      ...draftFor(lead, result?.outreach?.why_qualified || '', result?.outreach?.call_script || ''),
      to: lead.contact_email,
      mailbox: publicEmailSettings(getEmailConfig(db, secrets)),
    });
  });
  app.post('/api/projects/:projectId/leads/:leadId/email', expensiveLimit, async (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    const input = emailSendSchema.parse(req.body);
    const config = getEmailConfig(db, secrets);
    if (!config.configured)
      throw new HttpError(
        409,
        'No workspace mailbox is configured. An administrator sets it up in Workspace settings.',
      );
    // One header-safe recipient per request. Bulk sending is a separate, throttled path.
    const to = assertAddress(input.to, 'The recipient address');
    // The subject carries merge fields too. A template subject is the most visible place
    // an unresolved {{company}} would surface, so it is merged like the body.
    const subject = applyMerge(
      input.subject.replace(/[\r\n]+/g, ' ').trim(),
      mergeContext(lead, config.from_name || req.user.name),
    ).merged;
    // The editor sends a block document; a quick note sends plain text.
    const built = input.blocks
      ? (() => {
          const { blocks, problems } = validateBlocks(input.blocks);
          if (problems.length) throw new HttpError(400, problems[0].message);
          if (!blocks.length) throw new HttpError(400, 'Add at least one block before sending.');
          const rendered = renderBlocks(blocks, {
            context: mergeContext(lead, config.from_name || req.user.name),
            fromName: config.from_name,
            fromEmail: config.from_email,
            signature: config.signature,
            previewText: input.preview_text,
          });
          return { html: rendered.html, text: rendered.text };
        })()
      : (() => {
          if (input.body.trim().length < 20)
            throw new HttpError(400, 'Write a message of at least 20 characters.');
          return {
            html: renderEmail({
              body: input.body,
              fromName: config.from_name,
              fromEmail: config.from_email,
              signature: config.signature,
              leadName: lead.name,
            }),
            text: input.body,
          };
        })();
    const html = built.html;
    const record = db.prepare(
      'INSERT INTO email_messages (project_id,lead_id,to_email,subject,body,status,error,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    try {
      await single('email:' + lead.id, () =>
        deliver(config, {
          to,
          subject,
          text: built.text,
          html,
          replyTo: config.reply_to || config.from_email,
        }),
      );
    } catch (error) {
      // A refused message is still recorded, so the history stays truthful.
      record.run(
        project.id,
        lead.id,
        to,
        subject,
        built.text,
        'FAILED',
        'Delivery refused.',
        req.user.name,
        now(),
      );
      audit(db, project.id, req.user.name, 'lead.email_failed', lead.name + ' to ' + to);
      // Never surface a transport error: it can carry credentials and message content.
      // Sanitized here rather than in the transport, so this holds for every transport.
      throw error instanceof HttpError
        ? error
        : new HttpError(
            502,
            'The mail server rejected the message. Check the mailbox settings and try again.',
          );
    }
    const id = Number(
      record.run(project.id, lead.id, to, subject, built.text, 'SENT', '', req.user.name, now())
        .lastInsertRowid,
    );
    db.prepare('UPDATE leads SET updated_at=? WHERE id=? AND project_id=?').run(
      now(),
      lead.id,
      project.id,
    );
    audit(db, project.id, req.user.name, 'lead.email_sent', lead.name + ' to ' + to);
    res.status(201).json({ id });
  });
  /** Starter templates for the editor, grouped the way the picker shows them. */
  app.get('/api/email/templates', (_req, res) =>
    res.json({
      templates: emailTemplates,
      categories: templateCategories,
      merge_fields: mergeFields,
    }),
  );
  /** Renders a block document for the desktop/mobile preview, and returns the pre-send checks. */
  app.post('/api/projects/:projectId/leads/:leadId/email/preview', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const lead = getLead(db, project, positiveId(req.params.leadId));
    const input = z
      .object({
        subject: text(200).default(''),
        preview_text: text(200).default(''),
        blocks: z.array(z.unknown()).max(60),
      })
      .strict()
      .parse(req.body);
    // Problems are reported, not thrown: the editor shows them beside the block.
    const { blocks, problems } = validateBlocks(input.blocks);
    if (!blocks.length)
      return void res.json({ html: '', text: '', warnings: [], block_problems: problems });
    const config = getEmailConfig(db, secrets);
    const rendered = renderBlocks(blocks, {
      context: mergeContext(lead, config.from_name || req.user.name),
      fromName: config.from_name,
      fromEmail: config.from_email || 'not-configured@example.invalid',
      signature: config.signature,
      previewText: input.preview_text,
    });
    res.json({
      html: rendered.html,
      text: rendered.text,
      warnings: checkBlocks(
        blocks,
        rendered,
        applyMerge(input.subject, mergeContext(lead, config.from_name || req.user.name)).merged,
      ),
      block_problems: problems,
    });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof HttpError)
      return void res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError)
      return void res.status(400).json({
        error: error.issues
          .map((issue) => issue.path.join('.') + ': ' + issue.message)
          .join('; ')
          .slice(0, 1000),
      });
    if (error instanceof multer.MulterError)
      return void res.status(400).json({
        error: 'Upload rejected. Choose one supported file smaller than 5 MB.',
      });
    if (error?.type === 'entity.too.large')
      return void res.status(413).json({ error: 'Request exceeds the size limit.' });
    if (error instanceof SyntaxError && 'body' in error)
      return void res.status(400).json({ error: 'Invalid JSON request.' });
    console.error('[server] Request failed:', error?.code || error?.name || 'UnknownError');
    res.status(500).json({ error: 'The request could not be completed. Please retry.' });
  };
  app.use(errorHandler);
  return { app, db, errorHandler };
}

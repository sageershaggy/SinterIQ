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
  requiredText,
  text,
  webUrl,
} from './validation';
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
        'INSERT INTO leads (project_id,name,name_key,website,website_key,country,industry,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        projectId,
        lead.name,
        nKey,
        lead.website,
        wKey,
        lead.country,
        lead.industry,
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
}) {
  const production = options.production || false;
  const { db, secrets } = openDatabase(options.dataDir, options.legacyPath);
  const callAi = options.generate || generate;
  const readWebsite = options.fetchWebsite || fetchWebsite;
  const readDocument = options.extractDocument || extractDocument;
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
    const input = z
      .object({
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
          ])
          .default('ALL'),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        page_size: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    let where = 'project_id=?';
    const params: (string | number)[] = [project.id];
    if (input.search) {
      where +=
        " AND (name LIKE ? ESCAPE '\\' OR industry LIKE ? ESCAPE '\\' OR country LIKE ? ESCAPE '\\')";
      const q = '%' + input.search.replace(/[\\%_]/g, '\\$&') + '%';
      params.push(q, q, q);
    }
    if (input.status === 'REVIEW_QUEUE') {
      where +=
        " AND (status IN ('UNREVIEWED','NEEDS_REVIEW') OR (latest_run_id IS NOT NULL AND (training_version IS NOT ? OR qualified_revision IS NOT revision OR ? IS NOT ?)))";
      params.push(project.active_version || 0, project.trained_revision || 0, project.revision);
    } else if (input.status === 'STALE') {
      where +=
        ' AND latest_run_id IS NOT NULL AND (training_version IS NOT ? OR qualified_revision IS NOT revision OR ? IS NOT ?)';
      params.push(project.active_version || 0, project.trained_revision || 0, project.revision);
    } else if (
      input.status === 'CALL_READY' ||
      input.status === 'SEND_EMAIL' ||
      input.status === 'REVIEW_WITH_CLIENT'
    ) {
      // Mirrors nextStepFor: outreach bands only describe results from the current training.
      const fresh =
        ' AND latest_run_id IS NOT NULL AND training_version IS ? AND qualified_revision IS revision AND ? IS ?';
      const band =
        input.status === 'CALL_READY'
          ? " AND status='QUALIFIED' AND score>=" + nextStepBands.call
          : input.status === 'SEND_EMAIL'
            ? " AND status='QUALIFIED' AND score>=" +
              nextStepBands.email +
              ' AND score<' +
              nextStepBands.call
            : " AND (status='NEEDS_REVIEW' OR (status='QUALIFIED' AND score>=" +
              nextStepBands.review +
              ' AND score<' +
              nextStepBands.email +
              '))';
      where += band + fresh;
      params.push(project.active_version || 0, project.trained_revision || 0, project.revision);
    } else if (input.status !== 'ALL') {
      where += ' AND status=?';
      params.push(input.status);
    }
    const { count } = db
      .prepare('SELECT COUNT(*) count FROM leads WHERE ' + where)
      .get(...params) as { count: number };
    const rows = db
      .prepare(
        'SELECT id,project_id,name,website,country,industry,notes,revision,status,score,confidence,latest_run_id,training_version,qualified_revision,contact_name,contact_role,reviewed,created_at,updated_at FROM leads WHERE ' +
          where +
          ' ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?',
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
    (req, res) => {
      const project = getProject(db, positiveId(req.params.projectId), req.user);
      if (!req.file || !/\.csv$/i.test(req.file.originalname))
        throw new HttpError(400, 'Select a UTF-8 CSV file.');
      if (req.file.size > 1_000_000)
        throw new HttpError(413, 'CSV files must be smaller than 1 MB.');
      let records: Record<string, string>[];
      try {
        records = parse(new TextDecoder('utf-8', { fatal: true }).decode(req.file.buffer), {
          columns: (headers: string[]) =>
            headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')),
          bom: true,
          trim: true,
          skip_empty_lines: true,
          max_record_size: 20000,
        });
      } catch {
        throw new HttpError(
          400,
          'The CSV is malformed. Use headers: name, website, country, industry, notes.',
        );
      }
      if (!records.length || records.length > 500)
        throw new HttpError(400, 'Import between 1 and 500 leads per CSV.');
      const leads = records.map((row, i) => {
        let website = row.website || row.company_website || '';
        if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
        const parsed = leadSchema.safeParse({
          name: row.name || row.company_name || '',
          website,
          country: row.country || '',
          industry: row.industry || '',
          notes: row.notes || row.description || '',
        });
        if (!parsed.success)
          throw new HttpError(400, 'CSV row ' + (i + 2) + ': ' + parsed.error.issues[0].message);
        if (parsed.data.website) checkedUrl(parsed.data.website);
        return parsed.data;
      });
      const results = db.transaction(() => {
        let created = 0;
        const duplicates: string[] = [];
        for (const lead of leads) {
          const result = insertLead(db, project.id, lead);
          if (result.duplicate) duplicates.push(lead.name);
          else created++;
        }
        audit(
          db,
          project.id,
          req.user.name,
          'leads.imported',
          created + ' created; ' + duplicates.length + ' duplicates skipped.',
        );
        return {
          total: leads.length,
          created,
          skipped: duplicates.length,
          duplicates,
        };
      })();
      res.json(results);
    },
  );
  app.get('/api/projects/:projectId/leads/export', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const rows = db
      .prepare('SELECT * FROM leads WHERE project_id=? ORDER BY name')
      .all(project.id) as Lead[];
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
        'country',
        'industry',
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
        return [
          row.name,
          row.website,
          row.contact_name,
          row.contact_role,
          row.country,
          row.industry,
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
    res.setHeader('Content-Disposition', 'attachment; filename="innovista-qualification.csv"');
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
      'UPDATE leads SET name=?,name_key=?,website=?,website_key=?,country=?,industry=?,notes=?,revision=revision+1,reviewed=0,updated_at=? WHERE id=? AND project_id=?',
    ).run(
      input.name,
      nameKey(input.name),
      input.website,
      websiteKey(input.website),
      input.country,
      input.industry,
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

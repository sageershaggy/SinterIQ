import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { audit, now, type DB } from './database';
import { HttpError, positiveId } from './validation';
import type { Project, User } from '../shared/types';
import type { EmailFile } from '../shared/email';

/** One file, one message, and the number of files a message may carry. */
export const fileLimits = {
  perFile: 10 * 1024 * 1024,
  perMessage: 20 * 1024 * 1024,
  perMessageCount: 10,
  perProject: 2000,
} as const;
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024) + ' MB';

interface FileType {
  extensions: string[];
  contentType: string;
  image: boolean;
  /** The bytes must look like the extension says. A renamed executable is refused. */
  matches: (data: Buffer) => boolean;
}
const zipWith = (folder: string) => (data: Buffer) =>
  data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
  data.includes('[Content_Types].xml') &&
  data.includes(folder);
const text = (data: Buffer) => {
  if (data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
};
const fileTypes: FileType[] = [
  {
    extensions: ['pdf'],
    contentType: 'application/pdf',
    image: false,
    matches: (data) => data.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  {
    extensions: ['docx'],
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    image: false,
    matches: zipWith('word/'),
  },
  {
    extensions: ['xlsx'],
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    image: false,
    matches: zipWith('xl/'),
  },
  {
    extensions: ['pptx'],
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    image: false,
    matches: zipWith('ppt/'),
  },
  { extensions: ['csv'], contentType: 'text/csv', image: false, matches: text },
  { extensions: ['txt'], contentType: 'text/plain', image: false, matches: text },
  {
    extensions: ['png'],
    contentType: 'image/png',
    image: true,
    matches: (data) =>
      data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    extensions: ['jpg', 'jpeg'],
    contentType: 'image/jpeg',
    image: true,
    matches: (data) => data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  },
];
export const allowedExtensions = fileTypes.flatMap((type) => type.extensions);

/** A filename safe to show and to put in a MIME header: no path, no control characters. */
export function cleanFilename(name: string) {
  const base = name.split(/[\\/]/).pop() || '';
  const clean = base
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 ? clean.slice(dot) : '';
  const stem = (dot > 0 ? clean.slice(0, dot) : clean).slice(0, 120 - extension.length);
  return (stem || 'file') + extension;
}
/** Detects an allowed type from the name AND the bytes, or refuses the file. */
export function detectFileType(filename: string, data: Buffer, imagesOnly = false) {
  const extension = (filename.split('.').pop() || '').toLowerCase();
  const type = fileTypes.find((candidate) => candidate.extensions.includes(extension));
  if (!type || (imagesOnly && !type.image))
    throw new HttpError(
      400,
      imagesOnly
        ? 'Choose a PNG or JPG image.'
        : 'That file type cannot be attached. Use PDF, Word, Excel, PowerPoint, CSV, text, PNG or JPG.',
    );
  if (!type.matches(data))
    throw new HttpError(400, 'The file does not match its .' + extension + ' extension.');
  return type;
}
/** Pixel size of a PNG or JPEG, read from its header, so the email never draws it wider. */
export function imageSize(data: Buffer, contentType: string) {
  if (contentType === 'image/png' && data.length >= 24)
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (contentType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) return null;
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  return null;
}

interface FileRow extends EmailFile {
  data: Buffer;
}
const publicColumns = 'id,project_id,kind,filename,content_type,size,width,height,created_at';
/** Metadata for files that belong to the project. An id from elsewhere is simply not found. */
export function fileMeta(db: DB, projectId: number, ids: number[]): EmailFile[] {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  return db
    .prepare(
      `SELECT ${publicColumns} FROM email_files WHERE project_id=? AND id IN (${unique.map(() => '?').join(',')})`,
    )
    .all(projectId, ...unique) as EmailFile[];
}
/**
 * Loads files for delivery: every id must belong to the project, and together they must fit
 * in one message. Nothing is sent when one of them is missing.
 */
export function loadFiles(
  db: DB,
  projectId: number,
  attachmentIds: number[],
  inlineIds: number[] = [],
) {
  const all = [...new Set([...attachmentIds, ...inlineIds])];
  if (attachmentIds.length > fileLimits.perMessageCount)
    throw new HttpError(
      400,
      'Attach at most ' + fileLimits.perMessageCount + ' files to one email.',
    );
  const rows = all.length
    ? (db
        .prepare(
          `SELECT ${publicColumns},data FROM email_files WHERE project_id=? AND id IN (${all.map(() => '?').join(',')})`,
        )
        .all(projectId, ...all) as FileRow[])
    : [];
  if (rows.length !== all.length)
    throw new HttpError(
      400,
      'An attached file is no longer available. Remove it and attach it again.',
    );
  const total = rows.reduce((sum, row) => sum + row.size, 0);
  if (total > fileLimits.perMessage)
    throw new HttpError(
      413,
      'Attachments and images add up to ' +
        mb(total) +
        '. One email can carry ' +
        mb(fileLimits.perMessage) +
        '.',
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    attachments: [...new Set(attachmentIds)].map((id) => byId.get(id)!),
    inline: [...new Set(inlineIds)].map((id) => byId.get(id)!),
  };
}

/** Reads a project's stored images for rendering. An id from another project is not found. */
export function imageLoader(db: DB, projectId: number) {
  return (ids: number[]) => {
    const unique = [...new Set(ids)].slice(0, 50);
    const rows = unique.length
      ? (db
          .prepare(
            `SELECT id,filename,content_type,data,width FROM email_files
            WHERE project_id=? AND content_type LIKE 'image/%' AND id IN (${unique.map(() => '?').join(',')})`,
          )
          .all(projectId, ...unique) as Array<{
          id: number;
          filename: string;
          content_type: string;
          data: Buffer;
          width: number | null;
        }>)
      : [];
    return new Map(rows.map((row) => [row.id, row]));
  };
}

export function installEmailFiles(
  app: Express,
  options: { db: DB; getProject: (db: DB, id: number, user: User) => Project },
) {
  const { db, getProject } = options;
  const upload = multer({
    storage: multer.memoryStorage(),
    // Browsers send the file name as UTF-8; multer would otherwise read it as Latin-1.
    defParamCharset: 'utf8',
    limits: { fileSize: fileLimits.perFile, files: 1, fields: 2, fieldSize: 100, parts: 3 },
  }).single('file');
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 60,
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Upload limit reached. Please retry in 15 minutes.' },
  });
  const base = '/api/projects/:projectId/email/files';
  app.post(base, limiter, async (req: Request, res: Response) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    await new Promise<void>((resolve, reject) =>
      upload(req, res, (error: unknown) => {
        if (!error) return resolve();
        reject(
          error instanceof multer.MulterError
            ? new HttpError(
                error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
                error.code === 'LIMIT_FILE_SIZE'
                  ? 'Each file can be up to ' + mb(fileLimits.perFile) + '.'
                  : 'Upload one file at a time.',
              )
            : error,
        );
      }),
    );
    if (!req.file) throw new HttpError(400, 'Choose a file to attach.');
    const kind = req.body?.kind === 'image' ? 'image' : 'attachment';
    const filename = cleanFilename(req.file.originalname);
    const type = detectFileType(filename, req.file.buffer, kind === 'image');
    const { count } = db
      .prepare('SELECT COUNT(*) count FROM email_files WHERE project_id=?')
      .get(project.id) as { count: number };
    if (count >= fileLimits.perProject)
      throw new HttpError(
        409,
        'This project already stores ' + fileLimits.perProject + ' email files.',
      );
    const size = type.image ? imageSize(req.file.buffer, type.contentType) : null;
    const id = Number(
      db
        .prepare(
          `INSERT INTO email_files (project_id,kind,filename,content_type,size,sha256,data,width,height,account_id,created_by,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          project.id,
          kind,
          filename,
          type.contentType,
          req.file.size,
          crypto.createHash('sha256').update(req.file.buffer).digest('hex'),
          req.file.buffer,
          size?.width || null,
          size?.height || null,
          req.user.id,
          req.user.name,
          now(),
        ).lastInsertRowid,
    );
    audit(db, project.id, req.user.name, 'email.file_uploaded', filename);
    res.status(201).json(fileMeta(db, project.id, [id])[0]);
  });
  app.get(base, (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const ids = z
      .string()
      .max(400)
      .regex(/^[\d,]*$/)
      .parse(String(req.query.ids || ''))
      .split(',')
      .filter(Boolean)
      .map(Number)
      .slice(0, 50);
    res.json(fileMeta(db, project.id, ids));
  });
  app.get(base + '/:fileId', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const row = db
      .prepare('SELECT filename,content_type,data FROM email_files WHERE project_id=? AND id=?')
      .get(project.id, positiveId(req.params.fileId)) as
      { filename: string; content_type: string; data: Buffer } | undefined;
    if (!row) throw new HttpError(404, 'File not found.');
    const image = row.content_type.startsWith('image/');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader(
      'Content-Disposition',
      (image ? 'inline' : 'attachment') +
        '; filename="' +
        row.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') +
        "\"; filename*=UTF-8''" +
        encodeURIComponent(row.filename),
    );
    res.type(row.content_type).send(row.data);
  });
  /** The files each logged message carried, for the lead's email history. */
  app.get('/api/projects/:projectId/leads/:leadId/email/files', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const leadId = positiveId(req.params.leadId);
    if (!db.prepare('SELECT 1 FROM leads WHERE project_id=? AND id=?').get(project.id, leadId))
      throw new HttpError(404, 'Lead not found in this project.');
    const rows = db
      .prepare(
        `SELECT mf.message_id,mf.disposition,f.id,f.filename,f.content_type,f.size
        FROM email_message_files mf JOIN email_messages m ON m.id=mf.message_id
        JOIN email_files f ON f.id=mf.file_id AND f.project_id=m.project_id
        WHERE m.project_id=? AND m.lead_id=? ORDER BY mf.message_id DESC,f.id`,
      )
      .all(project.id, leadId) as Array<{
      message_id: number;
      disposition: string;
      id: number;
      filename: string;
      content_type: string;
      size: number;
    }>;
    const grouped: Record<number, typeof rows> = {};
    for (const row of rows) (grouped[row.message_id] ||= []).push(row);
    res.json(grouped);
  });
}

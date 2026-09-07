import crypto from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { audit, hash, now, type DB } from './database';
import { credentialsSchema, HttpError } from './validation';
import type { User } from '../shared/types';

declare global {
  namespace Express {
    interface Request {
      user: User;
      csrfToken: string;
      sessionHash: string;
    }
  }
}
function derivePasswordKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}
const COOKIE = 'innovista_session';
export async function passwordHash(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await derivePasswordKey(password, salt);
  return 'scrypt:v1:' + salt + ':' + key.toString('hex');
}
export async function createInitialAdministrator(db: DB, value: unknown): Promise<User> {
  const ensureEmpty = () => {
    if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get())
      throw new HttpError(
        409,
        'Administrator setup is already complete. Existing accounts are unchanged.',
      );
  };
  ensureEmpty();
  const input = credentialsSchema.parse(value);
  const encoded = await passwordHash(input.password);
  return db.transaction(() => {
    ensureEmpty();
    const id = Number(
      db
        .prepare(
          'INSERT INTO accounts (username,name,password_hash,role,created_at) VALUES (?,?,?,?,?)',
        )
        .run(input.username, input.name, encoded, 'admin', now()).lastInsertRowid,
    );
    audit(db, null, input.name, 'account.setup', 'Initial administrator created.');
    return { id, username: input.username, name: input.name, role: 'admin' as const };
  })();
}
async function passwordMatches(password: string, stored: string) {
  const [, version, salt, expected] = stored.split(':');
  if (version !== 'v1' || !salt || !expected) return false;
  const key = await derivePasswordKey(password, salt);
  const buffer = Buffer.from(expected, 'hex');
  return key.length === buffer.length && crypto.timingSafeEqual(key, buffer);
}
function cookieToken(req: Request) {
  const cookie = req.headers.cookie
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(COOKIE + '='));
  return cookie?.slice(COOKIE.length + 1) || '';
}
function publicUser(row: User): User {
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}
export function adminOnly(req: Request, _res: Response, next: NextFunction) {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Administrator access required.');
  next();
}
export function installAuth(app: Express, db: DB, production: boolean) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: production,
    path: '/',
  };
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 15,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: 'Too many sign-in attempts. Please retry in 15 minutes.',
    },
  });
  // Password changes are authenticated, so they are budgeted per account rather than
  // sharing the address-based sign-in budget with every colleague behind the same address.
  const passwordLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 15,
    keyGenerator: (req: Request) => String(req.user.id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: 'Too many password change attempts. Please retry in 15 minutes.',
    },
  });
  const createSession = (res: Response, user: User) => {
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare(
      'INSERT INTO sessions (token_hash,account_id,csrf_token,expires_at) VALUES (?,?,?,?)',
    ).run(hash(token), user.id, csrfToken, Date.now() + 12 * 60 * 60_000);
    res.cookie(COOKIE, token, { ...cookieOptions, maxAge: 12 * 60 * 60_000 });
    return {
      user: publicUser(user),
      csrf_token: csrfToken,
      setup_required: false,
    };
  };
  app.use('/api', (req, _res, next) => {
    const token = cookieToken(req);
    if (/^[a-f0-9]{64}$/.test(token)) {
      const row = db
        .prepare(
          'SELECT a.id,a.username,a.name,a.role,s.csrf_token FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>? AND a.active=1',
        )
        .get(hash(token), Date.now()) as (User & { csrf_token: string }) | undefined;
      if (row) {
        req.user = publicUser(row);
        req.csrfToken = row.csrf_token;
        req.sessionHash = hash(token);
      }
    }
    next();
  });
  app.get('/api/auth/me', (req, res) =>
    res.json({
      user: req.user || null,
      csrf_token: req.csrfToken || '',
      setup_required: !db.prepare('SELECT 1 FROM accounts LIMIT 1').get(),
    }),
  );
  app.post('/api/auth/setup', limiter, async (req, res) => {
    if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get())
      throw new HttpError(409, 'Workspace setup is already complete.');
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
      req.socket.remoteAddress || '',
    );
    const configured = process.env.INNOVISTA_SETUP_TOKEN;
    const token = typeof req.body.setup_token === 'string' ? req.body.setup_token : '';
    if (
      (production || !loopback || configured) &&
      (!configured ||
        !crypto.timingSafeEqual(
          crypto.createHash('sha256').update(token).digest(),
          crypto.createHash('sha256').update(configured).digest(),
        ))
    ) {
      throw new HttpError(
        403,
        'Enter the setup token configured by the server administrator. Local setup is available on the server computer.',
      );
    }
    const user = await createInitialAdministrator(db, req.body);
    res.status(201).json(createSession(res, user));
  });
  const dummyHash =
    'scrypt:v1:' +
    crypto.randomBytes(16).toString('hex') +
    ':' +
    crypto.randomBytes(64).toString('hex');
  app.post('/api/auth/login', limiter, async (req, res) => {
    const input = z
      .object({
        username: z.string().trim().toLowerCase().max(120),
        password: z.string().max(128),
      })
      .parse(req.body);
    const user = db
      .prepare('SELECT * FROM accounts WHERE username=? AND active=1')
      .get(input.username) as (User & { password_hash: string }) | undefined;
    const matches = await passwordMatches(input.password, user?.password_hash || dummyHash);
    if (!user || !matches) throw new HttpError(401, 'Invalid username or password.');
    res.json(createSession(res, user));
  });
  app.use('/api', (req, _res, next) => {
    if (req.path === '/health') return next();
    if (!req.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers['x-csrf-token'] !== req.csrfToken
    )
      throw new HttpError(
        403,
        'The security token is missing or expired. Reload the page and retry.',
      );
    next();
  });
  app.post('/api/auth/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    res.clearCookie(COOKIE, cookieOptions).json({ ok: true });
  });
  app.post('/api/auth/password', passwordLimiter, async (req, res) => {
    const input = z
      .object({
        current_password: z.string().max(128),
        password: z.string().min(15).max(128),
      })
      .parse(req.body);
    const row = db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(req.user.id) as {
      password_hash: string;
    };
    if (!(await passwordMatches(input.current_password, row.password_hash)))
      throw new HttpError(400, 'Current password is incorrect.');
    const encoded = await passwordHash(input.password);
    db.transaction(() => {
      db.prepare('UPDATE accounts SET password_hash=? WHERE id=?').run(encoded, req.user.id);
      db.prepare('DELETE FROM sessions WHERE account_id=?').run(req.user.id);
    })();
    res.json(createSession(res, req.user));
  });
  app.get('/api/users', adminOnly, (_req, res) => {
    const accounts = db
      .prepare('SELECT id,username,name,role,active FROM accounts ORDER BY id')
      .all() as Array<User & { active: number }>;
    const memberships = db
      .prepare('SELECT account_id,project_id FROM project_members')
      .all() as Array<{ account_id: number; project_id: number }>;
    res.json(
      accounts.map((account) => ({
        ...account,
        active: Boolean(account.active),
        project_ids: memberships
          .filter((row) => row.account_id === account.id)
          .map((row) => row.project_id),
      })),
    );
  });
  // Administrators reach every project by role, so assignment is stored for researchers only.
  app.put('/api/users/:id/projects', adminOnly, (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const input = z
      .object({ project_ids: z.array(z.number().int().positive()).max(200) })
      .strict()
      .parse(req.body);
    const account = db.prepare('SELECT id,name,role FROM accounts WHERE id=?').get(id) as
      { id: number; name: string; role: User['role'] } | undefined;
    if (!account) throw new HttpError(404, 'Account not found.');
    const wanted = [...new Set(input.project_ids)];
    db.transaction(() => {
      for (const projectId of wanted)
        if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))
          throw new HttpError(404, 'Project ' + projectId + ' not found.');
      db.prepare('DELETE FROM project_members WHERE account_id=?').run(id);
      const add = db.prepare(
        'INSERT INTO project_members (project_id,account_id,assigned_by,assigned_at) VALUES (?,?,?,?)',
      );
      for (const projectId of wanted) add.run(projectId, id, req.user.name, now());
      audit(
        db,
        null,
        req.user.name,
        'account.projects_assigned',
        account.name + ': ' + (wanted.length ? wanted.join(', ') : 'no projects'),
      );
    })();
    res.json({ id, project_ids: wanted });
  });
  app.post('/api/users', adminOnly, async (req, res) => {
    const input = credentialsSchema
      .extend({ role: z.enum(['admin', 'researcher']) })
      .parse(req.body);
    const encoded = await passwordHash(input.password);
    if (db.prepare('SELECT 1 FROM accounts WHERE username=?').get(input.username))
      throw new HttpError(409, 'That username already exists.');
    const id = db
      .prepare(
        'INSERT INTO accounts (username,name,password_hash,role,created_at) VALUES (?,?,?,?,?)',
      )
      .run(input.username, input.name, encoded, input.role, now()).lastInsertRowid;
    audit(db, null, req.user.name, 'account.created', input.username);
    res.status(201).json({ id: Number(id) });
  });
  app.patch('/api/users/:id', adminOnly, (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const input = z.object({ active: z.boolean() }).strict().parse(req.body);
    if (id === req.user.id) throw new HttpError(400, 'You cannot deactivate your own account.');
    const result = db
      .prepare('UPDATE accounts SET active=? WHERE id=?')
      .run(Number(input.active), id);
    if (!result.changes) throw new HttpError(404, 'Account not found.');
    db.prepare('DELETE FROM sessions WHERE account_id=?').run(id);
    audit(db, null, req.user.name, 'account.access_changed', String(id) + ': ' + input.active);
    res.json({ ok: true });
  });
}

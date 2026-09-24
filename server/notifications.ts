import type { Express } from 'express';
import { z } from 'zod';
import { now, type DB } from './database';
import { HttpError, positiveId } from './validation';
import type {
  NotificationFeed,
  NotificationItem,
  NotificationScope,
  ProjectNotificationKind,
} from '../shared/notifications';
import type { User } from '../shared/types';

/** How many recent notifications per account are gathered into rows, and how many rows show. */
const WINDOW = 500;
const ROWS = 50;

/**
 * An update about a project as a whole. Like a lead notification, the recipient list is captured
 * now — every active administrator and every member of the project — and access is checked
 * again on every read, so losing the project also loses its updates.
 */
export function notifyProject(
  db: DB,
  projectId: number,
  kind: ProjectNotificationKind,
  title: string,
) {
  db.prepare(
    `INSERT INTO project_notifications (account_id,project_id,kind,title,created_at)
    SELECT a.id,?,?,?,? FROM accounts a
    WHERE a.active=1
    AND (a.role='admin' OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=? AND m.account_id=a.id))`,
  ).run(projectId, kind, title.slice(0, 300), now(), projectId);
}

/**
 * The two stores behind one feed. A lead notification also needs its lead to still be in the
 * project, so a deleted or moved lead never leaves a link behind.
 */
const member = `(?='admin' OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=n.project_id AND m.account_id=?))`;
const stores = {
  lead: {
    table: 'notifications',
    access: `n.account_id=? AND EXISTS (SELECT 1 FROM leads l WHERE l.id=n.lead_id AND l.project_id=n.project_id) AND ${member}`,
    lead: 'n.lead_id',
    // What makes two notifications "the same": four analyses of one lead that each ended in
    // "needs review" are one thing to look at, not four.
    identity: ['project_id', 'lead_id', 'kind', 'title'],
  },
  project: {
    table: 'project_notifications',
    access: `n.account_id=? AND ${member}`,
    lead: 'NULL',
    identity: ['project_id', 'kind', 'title'],
  },
} as const;
const scopes = Object.keys(stores) as NotificationScope[];
const accessParams = (user: User) => [user.id, user.role, user.id];

function groupedRows(db: DB, scope: NotificationScope, user: User) {
  const { table, access, lead, identity } = stores[scope];
  const columns = identity.map((column) => 'n.' + column).join(',');
  return db
    .prepare(
      `SELECT MAX(n.id) id,'${scope}' scope,n.project_id,p.name project_name,${lead} lead_id,n.kind,n.title,
        MAX(n.created_at) created_at,MIN(n.created_at) first_at,COUNT(*) count,
        SUM(n.read_at IS NULL) unread,
        CASE WHEN SUM(n.read_at IS NULL)>0 THEN NULL ELSE MAX(n.read_at) END read_at
      FROM ${table} n JOIN projects p ON p.id=n.project_id
      WHERE n.id IN (SELECT id FROM ${table} WHERE account_id=? ORDER BY id DESC LIMIT ${WINDOW})
      AND ${access}
      GROUP BY ${columns} ORDER BY MAX(n.id) DESC LIMIT ${ROWS}`,
    )
    .all(user.id, ...accessParams(user)) as NotificationItem[];
}
/** Unread as the panel shows it: a group with anything unread counts once. */
function unreadRows(db: DB, scope: NotificationScope, user: User) {
  const { table, access, identity } = stores[scope];
  const columns = identity.map((column) => 'n.' + column).join(',');
  return (
    db
      .prepare(
        `SELECT COUNT(*) unread FROM (SELECT 1 FROM ${table} n WHERE ${access} AND n.read_at IS NULL GROUP BY ${columns})`,
      )
      .get(...accessParams(user)) as { unread: number }
  ).unread;
}

/**
 * Reading one row reads its whole group: the row stands for every identical notification up to
 * the one that was clicked, and nothing newer that arrived since.
 */
function readGroup(db: DB, scope: NotificationScope, user: User, id: number) {
  const { table, access, identity } = stores[scope];
  const target = db
    .prepare(`SELECT n.* FROM ${table} n WHERE ${access} AND n.id=?`)
    .get(...accessParams(user), id) as Record<string, unknown> | undefined;
  if (!target) throw new HttpError(404, 'Notification not found.');
  db.prepare(
    `UPDATE ${table} AS n SET read_at=? WHERE ${access} AND n.id<=? AND n.read_at IS NULL AND ` +
      identity.map((column) => 'n.' + column + '=?').join(' AND '),
  ).run(now(), ...accessParams(user), id, ...identity.map((column) => target[column]));
}

export function installNotifications(app: Express, db: DB) {
  app.get('/api/notifications', (req, res) => {
    const items = scopes
      .flatMap((scope) => groupedRows(db, scope, req.user))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
      .slice(0, ROWS);
    const unread = scopes.reduce((total, scope) => total + unreadRows(db, scope, req.user), 0);
    res.json({ items, unread } satisfies NotificationFeed);
  });
  /**
   * "Mark all read" names the newest row of each kind the panel showed, so anything that
   * arrives while the panel is open stays unread. A caller that names only one kind (as the
   * earlier client did) marks the other kind up to the same moment.
   */
  app.post('/api/notifications/read', (req, res) => {
    const input = z
      .object({
        through_id: z.number().int().positive().optional(),
        through_project_id: z.number().int().positive().optional(),
      })
      .strict()
      .parse(req.body);
    const through: Record<NotificationScope, number | undefined> = {
      lead: input.through_id,
      project: input.through_project_id,
    };
    if (!through.lead && !through.project)
      throw new HttpError(400, 'Say which notifications have been seen.');
    const params = accessParams(req.user);
    const moment = (scope: NotificationScope) => {
      const { table, access } = stores[scope];
      const row = db
        .prepare(`SELECT n.created_at FROM ${table} n WHERE ${access} AND n.id=?`)
        .get(...params, through[scope]) as { created_at: string } | undefined;
      return row?.created_at;
    };
    const read = now();
    db.transaction(() => {
      for (const scope of scopes) {
        const { table, access } = stores[scope];
        const own = through[scope];
        if (own) {
          db.prepare(
            `UPDATE ${table} AS n SET read_at=? WHERE ${access} AND n.id<=? AND n.read_at IS NULL`,
          ).run(read, ...params, own);
          continue;
        }
        const until = moment(scope === 'lead' ? 'project' : 'lead');
        if (until)
          db.prepare(
            `UPDATE ${table} AS n SET read_at=? WHERE ${access} AND n.created_at<=? AND n.read_at IS NULL`,
          ).run(read, ...params, until);
      }
    })();
    res.json({ ok: true });
  });
  app.post('/api/notifications/:id/read', (req, res) => {
    readGroup(db, 'lead', req.user, positiveId(req.params.id));
    res.json({ ok: true });
  });
  app.post('/api/notifications/project/:id/read', (req, res) => {
    readGroup(db, 'project', req.user, positiveId(req.params.id));
    res.json({ ok: true });
  });
}

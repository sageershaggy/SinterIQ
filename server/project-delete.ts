import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import { adminOnly } from './auth';
import { audit, type DB } from './database';
import { HttpError, positiveId } from './validation';
import type { Project, User } from '../shared/types';
import type { ProjectDeletionResult, ProjectDeletionSummary } from '../shared/project-deletion';

/**
 * Deleting a whole project, administrator-only.
 *
 * Nothing in the workspace deletes itself, so this is the one deliberate exception, and it is
 * built to be recoverable and complete:
 *
 * - A snapshot of the whole database is written first (VACUUM INTO, the same consistent copy
 *   scripts/backup.ts makes), under <data directory>/backups. No snapshot, no deletion.
 * - Every row that belongs to the project goes in ONE transaction. The tables are found from the
 *   schema rather than listed here, so a table added later by anyone is covered without touching
 *   this file: every table with a project_id column or a foreign key to projects, then every row
 *   that references one of those rows through a foreign key, and so on until nothing new is found.
 * - A row that belongs to another project is never deleted: if it only points at this project
 *   through a second column (mail this project's inbox received, linked to another project's
 *   lead), that pointer is cleared instead.
 * - Two tables are kept on purpose, because AGENTS.md makes them workspace-wide and keyed by the
 *   recipient's address: email_deliveries (the three-email limit) and email_bounces (why an address
 *   stopped receiving mail). Suppressions and unsubscribe tokens have no project column at all.
 *   The kept rows are detached from the ids that are going away, because SQLite hands a deleted
 *   highest id to the next row: a new project or lead must never inherit this one's history.
 * - Meta keys that point at the project (starter_project_id, funnel_last_tick:<id>) go too.
 * - foreign_key_check must report nothing new afterwards, or the whole transaction rolls back.
 */

/** Workspace-wide history keyed by recipient address: kept whatever project sent the mail. */
const KEPT_TABLES = new Set(['email_deliveries', 'email_bounces']);

const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"';

interface ForeignKey {
  child: string;
  from: string[];
  parent: string;
  to: string[];
  onDelete: string;
}
interface Column {
  name: string;
  notnull: number;
  pk: number;
}

/** The live schema: every ordinary table, its columns and its foreign keys. */
function readSchema(db: DB) {
  const tables = (
    db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string; sql: string | null }>
  ).filter((table) => !/^\s*CREATE\s+VIRTUAL/i.test(table.sql || ''));
  const columns = new Map<string, Column[]>();
  const keys: ForeignKey[] = [];
  for (const { name, sql } of tables) {
    // Rows are collected by rowid, which a WITHOUT ROWID table does not have. None exists today;
    // refusing is safer than silently skipping one.
    if (/WITHOUT\s+ROWID\s*;?\s*$/i.test(sql || ''))
      throw new Error('Table ' + name + ' has no rowid; project deletion cannot cover it.');
    columns.set(
      name,
      db.prepare('SELECT name,"notnull",pk FROM pragma_table_info(?)').all(name) as Column[],
    );
  }
  for (const { name } of tables) {
    const rows = db
      .prepare(
        'SELECT id,seq,"table" AS parent,"from" AS source,"to" AS target,on_delete FROM pragma_foreign_key_list(?) ORDER BY id,seq',
      )
      .all(name) as Array<{
      id: number;
      parent: string;
      source: string;
      target: string | null;
      on_delete: string;
    }>;
    const grouped = new Map<number, ForeignKey>();
    for (const row of rows) {
      const key = grouped.get(row.id) || {
        child: name,
        from: [],
        parent: row.parent,
        to: [],
        onDelete: row.on_delete.toUpperCase(),
      };
      key.from.push(row.source);
      if (row.target) key.to.push(row.target);
      grouped.set(row.id, key);
    }
    for (const key of grouped.values()) {
      // A reference written without columns means the parent's primary key.
      if (!key.to.length)
        key.to = (columns.get(key.parent) || [])
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name);
      if (columns.has(key.parent)) keys.push(key);
    }
  }
  return { columns, keys };
}

/** For every table: the columns that name a project (project_id, or a foreign key to projects). */
function projectColumns(schema: ReturnType<typeof readSchema>) {
  const result = new Map<string, string[]>();
  for (const [table, columns] of schema.columns) {
    if (table === 'projects') continue;
    const names = new Set<string>();
    if (columns.some((column) => column.name === 'project_id')) names.add('project_id');
    for (const key of schema.keys)
      if (key.child === table && key.parent === 'projects' && key.from.length === 1)
        names.add(key.from[0]);
    if (names.size) result.set(table, [...names]);
  }
  return result;
}

export function installProjectDeletion(
  app: Express,
  options: {
    db: DB;
    dataDir: string;
    getProject: (db: DB, id: number, user: User) => Project;
    /** True while an incoming-mail poll for that project is in flight. */
    mailboxSyncing?: (projectId: number) => boolean;
  },
) {
  const { db, dataDir, getProject } = options;
  const count = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  function summary(project: Project): ProjectDeletionSummary {
    const id = project.id;
    const inProject = (table: string, extra = '') =>
      count('SELECT COUNT(*) n FROM ' + table + ' WHERE project_id=?' + extra, id);
    return {
      project_id: id,
      name: project.name,
      counts: {
        leads: inProject('leads'),
        archived_leads: inProject('leads', ' AND archived_at IS NOT NULL'),
        sources: inProject('sources'),
        training_versions: inProject('training_versions'),
        runs: inProject('qualification_runs'),
        emails: inProject('email_messages'),
        calls: inProject('call_logs'),
        comments: inProject('lead_comments'),
        campaigns: inProject('funnels'),
        queued_sequences: inProject('funnel_enrollments', " AND status IN ('QUEUED','BLOCKED')"),
        contacts: inProject('lead_contacts'),
        members: inProject('project_members'),
        // Mail this inbox received for another project's lead stays with that lead.
        incoming_messages: count(
          'SELECT COUNT(*) n FROM incoming_messages WHERE project_id=? OR (project_id IS NULL AND mailbox_project_id=?)',
          id,
          id,
        ),
      },
      mailbox: Boolean(db.prepare('SELECT 1 FROM project_mailboxes WHERE project_id=?').get(id)),
    };
  }

  /** Nothing may be half-sent when its history disappears. */
  function assertIdle(project: Project) {
    if (
      db
        .prepare(
          "SELECT 1 FROM email_deliveries WHERE project_id=? AND status='SENDING' UNION ALL SELECT 1 FROM funnel_enrollments WHERE project_id=? AND status='SENDING'",
        )
        .get(project.id, project.id)
    )
      throw new HttpError(
        409,
        'A message from this project is being sent right now. Wait a minute for it to finish, then delete the project.',
      );
    if (options.mailboxSyncing?.(project.id))
      throw new HttpError(
        409,
        'This project’s inbox is being checked right now. Wait a minute for it to finish, then delete the project.',
      );
  }

  /** A consistent copy of the whole database, read back before anything is deleted. */
  function snapshot(project: Project) {
    const directory = path.join(dataDir, 'backups');
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.(\d+)Z$/, '$1Z');
    const name = 'before-delete-project-' + project.id + '-' + stamp + '.db';
    const target = path.join(directory, name);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      db.prepare('VACUUM INTO ?').run(target);
      fs.chmodSync(target, 0o600);
      const copy = new Database(target, { readonly: true, fileMustExist: true });
      try {
        const check = copy.pragma('quick_check', { simple: true });
        const kept = copy.prepare('SELECT 1 FROM projects WHERE id=?').get(project.id);
        if (check !== 'ok' || !kept) throw new Error('SnapshotUnreadable');
      } finally {
        copy.close();
      }
    } catch (error) {
      fs.rmSync(target, { force: true });
      console.error(
        '[projects] Safety snapshot failed:',
        (error as { code?: string })?.code || (error as Error)?.message || 'UnknownError',
      );
      throw new HttpError(
        500,
        'A safety snapshot of the database could not be written, so nothing was deleted. Check the free space in the data directory and retry.',
      );
    }
    return 'backups/' + name;
  }

  function remove(project: Project, actor: string, snapshotPath: string) {
    const id = project.id;
    const schema = readSchema(db);
    const owned = projectColumns(schema);
    const violations = () =>
      new Set(
        (
          db.pragma('foreign_key_check') as Array<{
            table: string;
            rowid: number | null;
            parent: string;
            fkid: number;
          }>
        ).map((row) => row.table + ':' + row.rowid + ':' + row.parent + ':' + row.fkid),
      );
    return db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(id))
        throw new HttpError(404, 'Project not found.');
      // Problems that were already in the database are not this deletion's to fix, and must
      // not block it either: only a violation this transaction introduces rolls it back.
      const before = violations();
      db.pragma('defer_foreign_keys = ON');

      // 1. The recipient history that outlives the project. Messages sent before the delivery
      //    ledger existed are counted from email_messages, which is going away, so they get a
      //    ledger row first (the same step lead deletion takes).
      db.prepare(
        `INSERT INTO email_deliveries (delivery_key,project_id,lead_id,recipient,status,message_id,started_at)
        SELECT 'legacy:' || m.id || ':' || m.created_at,m.project_id,m.lead_id,lower(trim(m.to_email)),'SENT',m.id,0
        FROM email_messages m WHERE m.project_id=? AND m.status='SENT'
        AND NOT EXISTS (SELECT 1 FROM email_deliveries d WHERE d.message_id=m.id)`,
      ).run(id);
      db.prepare(
        'UPDATE email_deliveries SET message_id=NULL,lead_id=0,project_id=0 WHERE project_id=?',
      ).run(id);
      db.prepare('UPDATE email_bounces SET project_id=NULL,lead_id=NULL WHERE project_id=?').run(
        id,
      );

      // 2. Collect every row that goes, by table and rowid.
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS doomed_rows (
        tbl TEXT NOT NULL, rid INTEGER NOT NULL, PRIMARY KEY (tbl, rid)) WITHOUT ROWID`);
      db.exec('DELETE FROM temp.doomed_rows');
      const doom = (table: string, where: string, ...params: unknown[]) =>
        db
          .prepare(
            'INSERT OR IGNORE INTO temp.doomed_rows (tbl,rid) SELECT ?,rowid FROM ' +
              quote(table) +
              ' WHERE ' +
              where,
          )
          .run(table, ...params).changes;
      doom('projects', 'id=?', id);
      for (const [table, names] of owned) {
        if (KEPT_TABLES.has(table)) continue;
        const others = names.filter((name) => name !== 'project_id');
        const anyOther = others.map((name) => quote(name) + '=?').join(' OR ');
        if (names.includes('project_id')) {
          doom(
            table,
            'project_id=?' +
              (others.length ? ' OR (project_id IS NULL AND (' + anyOther + '))' : ''),
            id,
            ...others.map(() => id),
          );
          // Owned by another project, only pointing here: clear the pointer, keep the row.
          const columns = schema.columns.get(table) || [];
          for (const name of others) {
            const column = columns.find((entry) => entry.name === name);
            const elsewhere = 'project_id IS NOT NULL AND project_id<>? AND ' + quote(name) + '=?';
            if (column && !column.notnull)
              db.prepare(
                'UPDATE ' + quote(table) + ' SET ' + quote(name) + '=NULL WHERE ' + elsewhere,
              ).run(id, id);
            else doom(table, elsewhere, id, id);
          }
        } else doom(table, anyOther, ...others.map(() => id));
      }
      // Then everything that references a collected row, until nothing new turns up. A
      // reference that the schema itself clears on delete (ON DELETE SET NULL) keeps its row.
      const references = schema.keys.filter(
        (key) =>
          !KEPT_TABLES.has(key.child) &&
          key.onDelete !== 'SET NULL' &&
          key.onDelete !== 'SET DEFAULT' &&
          key.from.length === key.to.length,
      );
      for (let added = 1; added;) {
        added = 0;
        for (const key of references)
          added += db
            .prepare(
              'INSERT OR IGNORE INTO temp.doomed_rows (tbl,rid) SELECT ?,c.rowid FROM ' +
                quote(key.child) +
                ' c JOIN ' +
                quote(key.parent) +
                ' p ON ' +
                key.from
                  .map((from, i) => 'c.' + quote(from) + '=p.' + quote(key.to[i]))
                  .join(' AND ') +
                ' WHERE p.rowid IN (SELECT rid FROM temp.doomed_rows WHERE tbl=?)',
            )
            .run(key.child, key.parent).changes;
      }

      // 3. Delete them. Foreign keys are checked at commit, so the order does not matter.
      const removed = Object.fromEntries(
        (
          db
            .prepare('SELECT tbl,COUNT(*) n FROM temp.doomed_rows GROUP BY tbl ORDER BY tbl')
            .all() as Array<{ tbl: string; n: number }>
        ).map((row) => [row.tbl, row.n]),
      ) as Record<string, number>;
      for (const table of Object.keys(removed))
        db.prepare(
          'DELETE FROM ' +
            quote(table) +
            ' WHERE rowid IN (SELECT rid FROM temp.doomed_rows WHERE tbl=?)',
        ).run(table);
      db.exec('DROP TABLE temp.doomed_rows');

      // 4. Scheduling and bookkeeping that name the project: the funnel pacing slot and the
      //    starter marker. Queued deliveries and the inbox cursor went with their tables.
      db.prepare("DELETE FROM meta WHERE key GLOB ('*:' || ?)").run(String(id));
      db.prepare("DELETE FROM meta WHERE key='starter_project_id' AND value=?").run(String(id));

      // 5. Prove it: nothing still names the project, and nothing now dangles.
      for (const [table, names] of owned) {
        if (KEPT_TABLES.has(table)) continue;
        for (const name of names)
          if (
            db
              .prepare('SELECT 1 FROM ' + quote(table) + ' WHERE ' + quote(name) + '=? LIMIT 1')
              .get(id)
          )
            throw new Error('ProjectRowsRemain:' + table);
      }
      const after = violations();
      if ([...after].some((violation) => !before.has(violation)))
        throw new Error('ForeignKeyViolation');

      const counted = (table: string) => removed[table] || 0;
      audit(
        db,
        null,
        actor,
        'project.deleted',
        'Project ' +
          project.name +
          ' deleted, with ' +
          [
            counted('leads') + ' leads',
            counted('sources') + ' sources',
            counted('training_versions') + ' training versions',
            counted('qualification_runs') + ' qualification runs',
            counted('email_messages') + ' emails',
            counted('call_logs') + ' calls',
            counted('lead_comments') + ' comments',
            counted('funnels') + ' campaigns',
          ].join(', ') +
          '. Snapshot kept at ' +
          snapshotPath +
          '.',
      );
      return removed;
    })();
  }

  app.get('/api/projects/:projectId/deletion-summary', adminOnly, (req, res) => {
    res.json(summary(getProject(db, positiveId(req.params.projectId), req.user)));
  });

  app.delete('/api/projects/:projectId', adminOnly, (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = z
      .object({ confirm_name: z.string().max(200).optional() })
      .strict()
      .parse(req.body || {});
    // Typed, not clicked: the name has to match exactly, so a slip on the wrong card cannot
    // delete a project.
    if ((input.confirm_name || '').trim() !== project.name.trim())
      throw new HttpError(400, 'Type the project name exactly as shown to confirm the deletion.');
    assertIdle(project);
    const snapshotPath = snapshot(project);
    let removed: Record<string, number>;
    try {
      removed = remove(project, req.user.name, snapshotPath);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.error(
        '[projects] Deletion rolled back:',
        (error as { code?: string })?.code || (error as Error)?.message || 'UnknownError',
      );
      throw new HttpError(
        500,
        'The project could not be deleted cleanly, so nothing was removed. The safety snapshot is kept at ' +
          snapshotPath +
          '.',
      );
    }
    const result: ProjectDeletionResult = {
      deleted: true,
      name: project.name,
      snapshot: snapshotPath,
      removed,
    };
    res.json(result);
  });
}

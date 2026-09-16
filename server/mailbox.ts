import type { Express, Request } from 'express';
import { z } from 'zod';
import { adminOnly } from './auth';
import { audit, hash, now, type DB, type Secrets } from './database';
import { getEmailConfig, resolveMailHost } from './email';
import {
  readInbox,
  type InboxConfig,
  type InboxCursor,
  type ReadInbox,
  type ReceivedMail,
} from './imap';
import { HttpError, positiveId } from './validation';
import { notifyLead } from './workspace';
import type { IncomingSettings, MailFolder, MailRow } from '../shared/mailbox';
import type { Project, User } from '../shared/types';

const settingsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    host: z
      .string()
      .trim()
      .max(253)
      .regex(/^[a-zA-Z0-9.-]*$/),
    username: z
      .string()
      .trim()
      .max(200)
      .regex(/^[^\r\n\0]*$/),
    folder: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\r\n\0]*$/),
    password: z.string().max(2000).optional(),
    clear_password: z.boolean().optional(),
    enabled: z.boolean(),
  })
  .strict();
interface StoredSettings extends InboxConfig {
  revision: number;
  enabled: boolean;
  enabled_by: number;
  last_sync: string;
  last_error: string;
}
const incomingColumns = `i.id,i.project_id,i.lead_id,l.name AS company,i.from_email,i.from_name,
  i.to_email,i.subject,i.body,i.received_at,i.read_at,i.attachment_count,i.notice`;

export function createMailbox(options: {
  db: DB;
  secrets: Secrets;
  getProject: (db: DB, id: number, user: User) => Project;
  readInbox?: ReadInbox;
}) {
  const { db, secrets, getProject } = options;
  const receive = options.readInbox || readInbox;
  // Single-flight per project: one project's slow provider must not block another's poll.
  const running = new Map<number, Promise<{ received: number }>>();
  function stored(projectId: number): StoredSettings {
    const row = db
      .prepare(
        `SELECT imap_host host,imap_username username,imap_password password,imap_folder folder,
          imap_enabled enabled,imap_enabled_by enabled_by,revision,last_sync,last_error
        FROM project_mailboxes WHERE project_id=?`,
      )
      .get(projectId) as
      | (InboxConfig & {
          enabled: number;
          enabled_by: number;
          revision: number;
          last_sync: string;
          last_error: string;
        })
      | undefined;
    return row
      ? { ...row, enabled: Boolean(row.enabled) }
      : {
          revision: 0,
          host: '',
          username: '',
          password: '',
          folder: 'INBOX',
          enabled: false,
          enabled_by: 0,
          last_sync: '',
          last_error: '',
        };
  }
  function save(projectId: number, config: StoredSettings) {
    db.prepare('INSERT OR IGNORE INTO project_mailboxes(project_id) VALUES(?)').run(projectId);
    db.prepare(
      `UPDATE project_mailboxes SET imap_host=?,imap_username=?,imap_password=?,imap_folder=?,
        imap_enabled=?,imap_enabled_by=?,revision=?,last_sync=?,last_error=? WHERE project_id=?`,
    ).run(
      config.host,
      config.username,
      config.password,
      config.folder,
      config.enabled ? 1 : 0,
      config.enabled_by,
      config.revision,
      config.last_sync,
      config.last_error,
      projectId,
    );
  }
  function publicSettings(projectId: number): IncomingSettings {
    const c = stored(projectId);
    return {
      project_id: projectId,
      shared_with: c.host ? sharedWith(projectId, c.host, c.username).map((p) => p.name) : [],
      host: c.host,
      username: c.username,
      folder: c.folder,
      enabled: c.enabled,
      has_password: !!c.password,
      revision: c.revision,
      last_sync: c.last_sync,
      last_error: c.last_error,
    };
  }
  /** Another project already polling the same inbox would ingest its own copy of every message. */
  function sharedWith(projectId: number, host: string, username: string) {
    return db
      .prepare(
        `SELECT p.name FROM project_mailboxes m JOIN projects p ON p.id=m.project_id
        WHERE m.project_id!=? AND m.imap_enabled=1 AND lower(m.imap_host)=? AND lower(m.imap_username)=?`,
      )
      .all(projectId, host.toLowerCase(), username.toLowerCase()) as Array<{ name: string }>;
  }
  function requireLead(projectId: number, leadId: number, user: User) {
    getProject(db, projectId, user);
    if (!db.prepare('SELECT 1 FROM leads WHERE project_id=? AND id=?').get(projectId, leadId))
      throw new HttpError(404, 'Lead not found in this project.');
  }
  function linkedReply(
    id: number,
    projectId: number,
    leadId: number,
    mail: Pick<ReceivedMail, 'from_email' | 'received_at'>,
  ) {
    db.prepare(
      'UPDATE incoming_messages SET project_id=?,lead_id=?,linked_at=? WHERE id=? AND project_id IS NULL AND lead_id IS NULL',
    ).run(projectId, leadId, now(), id);
    db.prepare(
      "INSERT INTO outreach_events(project_id,lead_id,outcome,notes,created_by,created_at) VALUES(?,?,'REPLIED',?,'Mailbox',?)",
    ).run(
      projectId,
      leadId,
      'Incoming reply #' + id + ' received. Review the message before choosing an outcome.',
      now(),
    );
    // A historical reply must not reset a newer deliberate outcome or a new campaign.
    db.prepare(
      `UPDATE leads SET outreach_status='REPLIED' WHERE project_id=? AND id=?
      AND outreach_status IN ('NOT_CONTACTED','CONTACTED')
      AND NOT EXISTS(SELECT 1 FROM outreach_events e WHERE e.project_id=? AND e.lead_id=? AND e.outcome!='REPLIED' AND e.created_at>?)`,
    ).run(projectId, leadId, projectId, leadId, mail.received_at);
    db.prepare(
      `UPDATE funnel_enrollments SET status='REPLIED',reason='An incoming reply was received.',updated_at=?
      WHERE project_id=? AND lead_id=? AND recipient=? AND status IN ('QUEUED','SENDING') AND created_at<=?`,
    ).run(now(), projectId, leadId, mail.from_email, mail.received_at);
    db.prepare(
      `UPDATE funnel_enrollments SET status='STOPPED',reason='Recipient response received.',updated_at=?
      WHERE recipient=? AND status IN ('QUEUED','SENDING') AND created_at<=?`,
    ).run(now(), mail.from_email, mail.received_at);
    notifyLead(db, projectId, leadId, 'email', 'New email reply received');
  }
  async function runSync(projectId: number) {
    const config = stored(projectId);
    if (!config.enabled) return { received: 0 };
    const stillAuthorized = () => {
      if (stored(projectId).revision !== config.revision)
        throw new HttpError(
          409,
          'Mailbox settings changed during sync. Retry with the current settings.',
        );
      if (
        !db
          .prepare("SELECT 1 FROM accounts WHERE id=? AND active=1 AND role='admin'")
          .get(config.enabled_by)
      )
        throw new HttpError(409, 'An administrator must enable this connection again.');
    };
    // The project is part of the identity, so two projects on one inbox keep separate
    // histories and separate resume points instead of fighting over one cursor.
    const accountKey = hash(
      JSON.stringify([projectId, config.host, config.username, config.folder]),
    );
    const cursor = db
      .prepare('SELECT uid_validity,last_uid FROM project_mailbox_cursors WHERE project_id=?')
      .get(projectId) as InboxCursor | undefined;
    try {
      stillAuthorized();
      const batch = await receive(
        { ...config, password: secrets.decrypt(config.password) },
        cursor || null,
      );
      stillAuthorized();
      return db.transaction(() => {
        let received = 0;
        for (const mail of batch.messages) {
          // UID validity can change during server maintenance. Avoid duplicating the same message/outcome.
          if (
            mail.message_id &&
            db
              .prepare(
                // Keyed on the project rather than on account_key: mail received before
                // mailboxes became per project carries the old key shape, so keying on the
                // hash would leave all of it unprotected the next time UID validity changes.
                `SELECT 1 FROM incoming_messages WHERE mailbox_project_id=? AND internet_message_id=?
            AND from_email=? AND received_at=? AND subject=?`,
              )
              .get(projectId, mail.message_id, mail.from_email, mail.received_at, mail.subject)
          )
            continue;
          const inserted = db
            .prepare(
              `INSERT OR IGNORE INTO incoming_messages
            (mailbox_project_id,account_key,uid_validity,uid,internet_message_id,references_json,from_email,from_name,to_email,subject,body,received_at,attachment_count,notice,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              projectId,
              accountKey,
              batch.uid_validity,
              mail.uid,
              mail.message_id,
              JSON.stringify(mail.references),
              mail.from_email,
              mail.from_name,
              mail.to_email,
              mail.subject,
              mail.body,
              mail.received_at,
              mail.attachment_count,
              mail.notice,
              now(),
            );
          if (!inserted.changes) continue;
          received++;
          // Match an app-generated unpredictable Message-ID AND its original recipient. No guessed contact matching.
          const matches = new Map<string, { project_id: number; lead_id: number }>();
          for (const reference of mail.references) {
            // Only this project's own sent mail can claim the reply: a mailbox must never
            // link a message to a lead in a project it does not belong to.
            const rows = db
              .prepare(
                `SELECT DISTINCT m.project_id,m.lead_id FROM email_messages m
              JOIN leads l ON l.project_id=m.project_id AND l.id=m.lead_id
              WHERE m.project_id=? AND m.internet_message_id=? AND lower(trim(m.to_email))=? AND m.created_at<=?`,
              )
              .all(projectId, reference, mail.from_email, mail.received_at) as Array<{
              project_id: number;
              lead_id: number;
            }>;
            rows.forEach((row) => matches.set(`${row.project_id}:${row.lead_id}`, row));
          }
          if (matches.size === 1) {
            const match = [...matches.values()][0];
            linkedReply(Number(inserted.lastInsertRowid), match.project_id, match.lead_id, mail);
          }
        }
        db.prepare(
          'INSERT OR REPLACE INTO project_mailbox_cursors(project_id,uid_validity,last_uid) VALUES(?,?,?)',
        ).run(projectId, batch.uid_validity, batch.last_uid);
        save(projectId, { ...config, last_sync: now(), last_error: '' });
        return { received };
      })();
    } catch (error) {
      const message =
        error instanceof HttpError
          ? error.message
          : 'Incoming connection failed. Check the IMAP host, account password and provider settings.';
      if (stored(projectId).revision === config.revision)
        save(projectId, { ...config, last_error: message });
      throw new HttpError(error instanceof HttpError ? error.status : 502, message);
    }
  }
  function sync(projectId: number) {
    const inflight = running.get(projectId);
    if (inflight) return inflight;
    const started = runSync(projectId).finally(() => running.delete(projectId));
    running.set(projectId, started);
    return started;
  }
  /**
   * Polls every project whose mailbox is enabled. One project's failing provider is reported
   * and skipped rather than stopping the rest of the workspace.
   */
  async function syncAll() {
    const projects = db
      .prepare('SELECT project_id FROM project_mailboxes WHERE imap_enabled=1 ORDER BY project_id')
      .all() as Array<{ project_id: number }>;
    let received = 0;
    const failures: string[] = [];
    for (const { project_id } of projects)
      try {
        received += (await sync(project_id)).received;
      } catch (error) {
        failures.push(
          'project ' + project_id + ': ' + (error instanceof Error ? error.message : 'sync failed'),
        );
      }
    return { received, failures };
  }
  function install(app: Express) {
    const base = '/api/projects/:projectId/mailbox';
    const owner = (req: Request) => getProject(db, positiveId(req.params.projectId), req.user);
    app.get(base + '/settings', adminOnly, (req, res) => res.json(publicSettings(owner(req).id)));
    app.put(base + '/settings', adminOnly, async (req, res) => {
      const project = owner(req);
      const input = settingsSchema.parse(req.body),
        current = stored(project.id);
      if (input.revision !== current.revision)
        throw new HttpError(409, 'Mailbox settings changed. Reload before saving.');
      const host = input.host.toLowerCase();
      if (
        (host !== current.host || input.username !== current.username) &&
        current.password &&
        !input.password &&
        !input.clear_password
      )
        throw new HttpError(400, 'Enter a new password when changing the host or account.');
      const password = input.clear_password
        ? ''
        : input.password
          ? secrets.encrypt(input.password)
          : current.password;
      if (input.enabled && (!host || !input.username || !password))
        throw new HttpError(
          400,
          'Enter the IMAP host, username and password before enabling incoming mail.',
        );
      if (host) await resolveMailHost(host);
      if (stored(project.id).revision !== current.revision)
        throw new HttpError(409, 'Mailbox settings changed. Reload before saving.');
      if (
        !db
          .prepare("SELECT 1 FROM accounts WHERE id=? AND active=1 AND role='admin'")
          .get(req.user.id)
      )
        throw new HttpError(403, 'Administrator access required.');
      // A UID cursor belongs to one account and folder. Resuming a different inbox at that
      // UID would silently skip every message below it, so repointing starts clean.
      if (
        host !== current.host ||
        input.username !== current.username ||
        input.folder !== current.folder
      )
        db.prepare('DELETE FROM project_mailbox_cursors WHERE project_id=?').run(project.id);
      save(project.id, {
        host,
        username: input.username,
        folder: input.folder,
        password,
        enabled: input.enabled,
        enabled_by: req.user.id,
        revision: current.revision + 1,
        last_sync: '',
        last_error: '',
      });
      audit(
        db,
        project.id,
        req.user.name,
        'mailbox.incoming_settings',
        input.enabled ? 'Incoming sync enabled.' : 'Incoming sync disabled.',
      );
      res.json(publicSettings(project.id));
    });
    app.post(base + '/sync', adminOnly, async (req, res) => {
      const project = owner(req);
      if (!stored(project.id).enabled)
        throw new HttpError(409, 'Enable incoming mail for this project first.');
      const result = await sync(project.id);
      if (
        !db
          .prepare("SELECT 1 FROM accounts WHERE id=? AND active=1 AND role='admin'")
          .get(req.user.id)
      )
        throw new HttpError(403, 'Administrator access required.');
      res.json(result);
    });
    app.get(base, adminOnly, (req, res) => {
      const project = owner(req);
      const folder = z
        .enum(['inbox', 'outbox', 'sent', 'drafts'])
        .parse(req.query.folder || 'inbox');
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .parse(req.query.page || 1);
      const query = z
        .string()
        .max(200)
        .parse(req.query.q || '')
        .toLowerCase();
      const sql: Record<MailFolder, string> = {
        inbox: `SELECT i.id,'incoming' AS kind,i.project_id,i.lead_id,l.name AS company,i.from_email AS address,
          i.subject,i.body,CASE WHEN i.read_at IS NULL THEN 'UNREAD' ELSE 'READ' END AS status,
          i.received_at AS timestamp,i.notice FROM incoming_messages i LEFT JOIN leads l ON l.project_id=i.project_id AND l.id=i.lead_id
          WHERE i.mailbox_project_id=${project.id}`,
        sent: `SELECT m.id,'outgoing' AS kind,m.project_id,m.lead_id,l.name AS company,m.to_email AS address,
          m.subject,m.body,m.status,m.created_at AS timestamp,m.error AS notice FROM email_messages m
          JOIN leads l ON l.project_id=m.project_id AND l.id=m.lead_id WHERE m.status='SENT' AND m.project_id=${project.id}`,
        outbox: `SELECT m.id,'outgoing' AS kind,m.project_id,m.lead_id,l.name AS company,m.to_email AS address,
          m.subject,m.body,COALESCE(d.status,m.status) AS status,m.created_at AS timestamp,m.error AS notice
          FROM email_messages m JOIN leads l ON l.project_id=m.project_id AND l.id=m.lead_id
          LEFT JOIN email_deliveries d ON d.project_id=m.project_id AND d.lead_id=m.lead_id AND d.message_id=m.id WHERE m.status!='SENT' AND m.project_id=${project.id}
          UNION ALL SELECT e.id,'queue',e.project_id,e.lead_id,l.name,e.recipient,f.name,'',
          CASE WHEN f.status='ACTIVE' THEN e.status ELSE f.status END,
          strftime('%Y-%m-%dT%H:%M:%fZ',e.next_send_at/1000.0,'unixepoch'),e.reason
          FROM funnel_enrollments e JOIN funnels f ON f.project_id=e.project_id AND f.id=e.funnel_id
          JOIN leads l ON l.project_id=e.project_id AND l.id=e.lead_id WHERE e.status='QUEUED' AND e.project_id=${project.id}`,
        drafts: `SELECT d.lead_id AS id,'draft' AS kind,d.project_id,d.lead_id,l.name AS company,
          json_extract(d.document_json,'$.to') AS address,json_extract(d.document_json,'$.subject') AS subject,
          '' AS body,'DRAFT' AS status,d.updated_at AS timestamp,'' AS notice FROM email_drafts d
          JOIN leads l ON l.project_id=d.project_id AND l.id=d.lead_id
          WHERE d.account_id=${req.user.id} AND d.project_id=${project.id}`,
      };
      const counts = Object.fromEntries(
        Object.entries(sql).map(([key, value]) => [
          key,
          (db.prepare('SELECT count(*) AS n FROM (' + value + ')').get() as { n: number }).n,
        ]),
      );
      const filtered = ` FROM (${sql[folder]}) WHERE instr(lower(coalesce(subject,'')||' '||coalesce(company,'')||' '||address),?)>0`;
      const items = db
        .prepare('SELECT *' + filtered + ' ORDER BY timestamp DESC,id DESC LIMIT 30 OFFSET ?')
        .all(query, (page - 1) * 30) as MailRow[];
      res.json({
        items,
        counts,
        total: (db.prepare('SELECT count(*) AS n' + filtered).get(query) as { n: number }).n,
        incoming: publicSettings(project.id),
        outgoing_configured: getEmailConfig(db, secrets, project.id).configured,
      });
    });
    app.post(base + '/incoming/:id/read', adminOnly, (req, res) => {
      const project = owner(req);
      if (
        !db
          .prepare(
            'UPDATE incoming_messages SET read_at=COALESCE(read_at,?) WHERE id=? AND mailbox_project_id=?',
          )
          .run(now(), positiveId(req.params.id), project.id).changes
      )
        throw new HttpError(404, 'Message not found.');
      res.json({ ok: true });
    });
    app.post(base + '/incoming/:id/link', adminOnly, (req, res) => {
      const project = owner(req);
      const input = z.object({ lead_id: z.number().int().positive() }).strict().parse(req.body);
      // The lead must live in the project whose mailbox received the message: linking is
      // never a way to move mail across the project boundary.
      requireLead(project.id, input.lead_id, req.user);
      const id = positiveId(req.params.id);
      const mail = db
        .prepare(
          'SELECT from_email,received_at,project_id FROM incoming_messages WHERE id=? AND mailbox_project_id=?',
        )
        .get(id, project.id) as
        { from_email: string; received_at: string; project_id: number | null } | undefined;
      if (!mail) throw new HttpError(404, 'Message not found.');
      if (mail.project_id !== null) throw new HttpError(409, 'This message is already linked.');
      db.transaction(() => linkedReply(id, project.id, input.lead_id, mail))();
      res.json({ ok: true });
    });
    app.get('/api/projects/:projectId/leads/:leadId/incoming', (req, res) => {
      const projectId = positiveId(req.params.projectId),
        leadId = positiveId(req.params.leadId);
      requireLead(projectId, leadId, req.user);
      const before = z.coerce
        .number()
        .int()
        .positive()
        .parse(req.query.before || Number.MAX_SAFE_INTEGER);
      res.json(
        db
          .prepare(
            `SELECT ${incomingColumns} FROM incoming_messages i
        JOIN leads l ON l.project_id=i.project_id AND l.id=i.lead_id
        WHERE i.project_id=? AND i.lead_id=? AND i.id<? ORDER BY i.id DESC LIMIT 30`,
          )
          .all(projectId, leadId, before),
      );
    });
  }
  return { install, sync, syncAll };
}

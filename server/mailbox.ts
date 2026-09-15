import type { Express } from 'express';
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
  let running: Promise<{ received: number }> | null = null;
  function stored(): StoredSettings {
    const row = db.prepare("SELECT value FROM settings WHERE key='imap_config'").get() as
      { value: string } | undefined;
    return row
      ? JSON.parse(row.value)
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
  function save(config: StoredSettings) {
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('imap_config',?)").run(
      JSON.stringify(config),
    );
  }
  function publicSettings(): IncomingSettings {
    const c = stored();
    return {
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
  async function runSync() {
    const config = stored();
    if (!config.enabled) return { received: 0 };
    const stillAuthorized = () => {
      if (stored().revision !== config.revision)
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
    const accountKey = hash(JSON.stringify([config.host, config.username, config.folder]));
    const cursor = db
      .prepare('SELECT uid_validity,last_uid FROM mailbox_cursors WHERE account_key=?')
      .get(accountKey) as InboxCursor | undefined;
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
                `SELECT 1 FROM incoming_messages WHERE account_key=? AND internet_message_id=?
            AND from_email=? AND received_at=? AND subject=?`,
              )
              .get(accountKey, mail.message_id, mail.from_email, mail.received_at, mail.subject)
          )
            continue;
          const inserted = db
            .prepare(
              `INSERT OR IGNORE INTO incoming_messages
            (account_key,uid_validity,uid,internet_message_id,references_json,from_email,from_name,to_email,subject,body,received_at,attachment_count,notice,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
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
            const rows = db
              .prepare(
                `SELECT DISTINCT m.project_id,m.lead_id FROM email_messages m
              JOIN leads l ON l.project_id=m.project_id AND l.id=m.lead_id
              WHERE m.internet_message_id=? AND lower(trim(m.to_email))=? AND m.created_at<=?`,
              )
              .all(reference, mail.from_email, mail.received_at) as Array<{
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
          'INSERT OR REPLACE INTO mailbox_cursors(account_key,uid_validity,last_uid) VALUES(?,?,?)',
        ).run(accountKey, batch.uid_validity, batch.last_uid);
        save({ ...config, last_sync: now(), last_error: '' });
        return { received };
      })();
    } catch (error) {
      const message =
        error instanceof HttpError
          ? error.message
          : 'Incoming connection failed. Check the IMAP host, account password and provider settings.';
      if (stored().revision === config.revision) save({ ...config, last_error: message });
      throw new HttpError(error instanceof HttpError ? error.status : 502, message);
    }
  }
  function sync() {
    if (!running)
      running = runSync().finally(() => {
        running = null;
      });
    return running;
  }
  function install(app: Express) {
    app.get('/api/settings/incoming', adminOnly, (_req, res) => res.json(publicSettings()));
    app.put('/api/settings/incoming', adminOnly, async (req, res) => {
      const input = settingsSchema.parse(req.body),
        current = stored();
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
      if (stored().revision !== current.revision)
        throw new HttpError(409, 'Mailbox settings changed. Reload before saving.');
      if (
        !db
          .prepare("SELECT 1 FROM accounts WHERE id=? AND active=1 AND role='admin'")
          .get(req.user.id)
      )
        throw new HttpError(403, 'Administrator access required.');
      save({
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
        null,
        req.user.name,
        'mailbox.incoming_settings',
        input.enabled ? 'Incoming sync enabled.' : 'Incoming sync disabled.',
      );
      res.json(publicSettings());
    });
    app.post('/api/mailbox/sync', adminOnly, async (req, res) => {
      if (!stored().enabled)
        throw new HttpError(409, 'Enable incoming mail in Workspace settings first.');
      const result = await sync();
      if (
        !db
          .prepare("SELECT 1 FROM accounts WHERE id=? AND active=1 AND role='admin'")
          .get(req.user.id)
      )
        throw new HttpError(403, 'Administrator access required.');
      res.json(result);
    });
    app.get('/api/mailbox', adminOnly, (req, res) => {
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
          i.received_at AS timestamp,i.notice FROM incoming_messages i LEFT JOIN leads l ON l.project_id=i.project_id AND l.id=i.lead_id`,
        sent: `SELECT m.id,'outgoing' AS kind,m.project_id,m.lead_id,l.name AS company,m.to_email AS address,
          m.subject,m.body,m.status,m.created_at AS timestamp,m.error AS notice FROM email_messages m
          JOIN leads l ON l.project_id=m.project_id AND l.id=m.lead_id WHERE m.status='SENT'`,
        outbox: `SELECT m.id,'outgoing' AS kind,m.project_id,m.lead_id,l.name AS company,m.to_email AS address,
          m.subject,m.body,COALESCE(d.status,m.status) AS status,m.created_at AS timestamp,m.error AS notice
          FROM email_messages m JOIN leads l ON l.project_id=m.project_id AND l.id=m.lead_id
          LEFT JOIN email_deliveries d ON d.project_id=m.project_id AND d.lead_id=m.lead_id AND d.message_id=m.id WHERE m.status!='SENT'
          UNION ALL SELECT e.id,'queue',e.project_id,e.lead_id,l.name,e.recipient,f.name,'',
          CASE WHEN f.status='ACTIVE' THEN e.status ELSE f.status END,
          strftime('%Y-%m-%dT%H:%M:%fZ',e.next_send_at/1000.0,'unixepoch'),e.reason
          FROM funnel_enrollments e JOIN funnels f ON f.project_id=e.project_id AND f.id=e.funnel_id
          JOIN leads l ON l.project_id=e.project_id AND l.id=e.lead_id WHERE e.status='QUEUED'`,
        drafts: `SELECT d.lead_id AS id,'draft' AS kind,d.project_id,d.lead_id,l.name AS company,
          json_extract(d.document_json,'$.to') AS address,json_extract(d.document_json,'$.subject') AS subject,
          '' AS body,'DRAFT' AS status,d.updated_at AS timestamp,'' AS notice FROM email_drafts d
          JOIN leads l ON l.project_id=d.project_id AND l.id=d.lead_id WHERE d.account_id=${req.user.id}`,
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
        incoming: publicSettings(),
        outgoing_configured: getEmailConfig(db, secrets).configured,
      });
    });
    app.post('/api/mailbox/incoming/:id/read', adminOnly, (req, res) => {
      if (
        !db
          .prepare('UPDATE incoming_messages SET read_at=COALESCE(read_at,?) WHERE id=?')
          .run(now(), positiveId(req.params.id)).changes
      )
        throw new HttpError(404, 'Message not found.');
      res.json({ ok: true });
    });
    app.post('/api/mailbox/incoming/:id/link', adminOnly, (req, res) => {
      const input = z
        .object({ project_id: z.number().int().positive(), lead_id: z.number().int().positive() })
        .strict()
        .parse(req.body);
      requireLead(input.project_id, input.lead_id, req.user);
      const id = positiveId(req.params.id);
      const mail = db
        .prepare('SELECT from_email,received_at,project_id FROM incoming_messages WHERE id=?')
        .get(id) as
        { from_email: string; received_at: string; project_id: number | null } | undefined;
      if (!mail) throw new HttpError(404, 'Message not found.');
      if (mail.project_id !== null) throw new HttpError(409, 'This message is already linked.');
      db.transaction(() => linkedReply(id, input.project_id, input.lead_id, mail))();
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
  return { install, sync };
}

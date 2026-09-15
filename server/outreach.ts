import crypto from 'node:crypto';
import type { Express } from 'express';
import { audit, hash, now, type DB } from './database';
import { assertAddress, type Send, type SmtpConfig } from './email';
import { HttpError } from './validation';
import { notifyLead } from './workspace';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const recipientKey = (value: string) => assertAddress(value, 'Recipient').toLowerCase();

export function remainingSends(db: DB, recipient: string) {
  // Old messages predate the ledger. Exclude those already linked to a delivery.
  const { count } = db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM email_deliveries WHERE recipient=? AND status IN ('SENDING','SENT','UNKNOWN')) +
    (SELECT COUNT(*) FROM email_messages m WHERE lower(trim(m.to_email))=? AND m.status='SENT'
      AND NOT EXISTS (SELECT 1 FROM email_deliveries d WHERE d.message_id=m.id)) AS count`,
    )
    .get(recipient, recipient) as { count: number };
  return Math.max(0, 3 - count);
}

export function suppressRecipient(db: DB, recipient: string, reason: string) {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO email_suppressions VALUES (?,?,?)').run(
      recipient,
      reason,
      now(),
    );
    db.prepare(
      `UPDATE funnel_enrollments SET status='UNSUBSCRIBED',reason=?,updated_at=?
      WHERE recipient=? AND status IN ('QUEUED','SENDING','BLOCKED')`,
    ).run(reason, now(), recipient);
    db.prepare(
      "UPDATE leads SET outreach_status='UNSUBSCRIBED' WHERE lower(trim(contact_email))=?",
    ).run(recipient);
  })();
}

export function assertCanContact(db: DB, recipient: string) {
  if (db.prepare('SELECT 1 FROM email_suppressions WHERE recipient=?').get(recipient))
    throw new HttpError(409, 'This recipient has opted out. No further email can be sent.');
  if (!remainingSends(db, recipient))
    throw new HttpError(409, 'The three-email limit for this recipient has been reached.');
}

export function createOutreach(db: DB, deliver: Send, publicOrigin: string) {
  function recover() {
    // SMTP acceptance may have preceded a crash. Never automatically resend that attempt.
    db.prepare(
      `UPDATE email_messages SET error='Delivery interrupted; check the mailbox before contacting again.'
      WHERE EXISTS (SELECT 1 FROM email_deliveries d WHERE d.message_id=email_messages.id
        AND d.project_id=email_messages.project_id AND d.lead_id=email_messages.lead_id
        AND d.status='SENDING' AND d.started_at<?)`,
    ).run(Date.now() - 10 * 60_000);
    db.prepare(
      `UPDATE email_deliveries SET status='UNKNOWN',error='Delivery interrupted; check the mailbox before contacting again.'
      WHERE status='SENDING' AND started_at<?`,
    ).run(Date.now() - 10 * 60_000);
  }

  async function send(options: {
    projectId: number;
    leadId: number;
    actor: string;
    config: SmtpConfig;
    to: string;
    subject: string;
    text: string;
    html: string;
    deliveryKey?: string;
    beforeSend?: () => void;
    inReplyTo?: string;
  }) {
    const recipient = recipientKey(options.to);
    const key = options.deliveryKey || crypto.randomUUID();
    const internetMessageId =
      '<' +
      crypto.randomUUID() +
      '@' +
      (options.config.from_email.split('@')[1] || 'innovista.invalid') +
      '>';
    const subject = options.subject.replace(/[\r\n]+/g, ' ').trim();
    if (!subject || subject.length > 400)
      throw new HttpError(400, 'Use a subject of 1–400 characters.');
    const record = db.prepare(`INSERT INTO email_messages
      (project_id,lead_id,to_email,subject,body,status,error,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    let pendingMessageId: number | undefined;
    const log = (status: 'SENT' | 'FAILED', error = '') => {
      if (
        status === 'FAILED' &&
        error !== 'Delivery pending; mailbox acceptance is not yet confirmed.'
      )
        notifyLead(
          db,
          options.projectId,
          options.leadId,
          'email',
          'Email needs attention: ' + subject,
        );
      if (pendingMessageId !== undefined) {
        db.prepare(
          'UPDATE email_messages SET status=?,error=? WHERE id=? AND project_id=? AND lead_id=?',
        ).run(status, error, pendingMessageId, options.projectId, options.leadId);
        return pendingMessageId;
      }
      return Number(
        record.run(
          options.projectId,
          options.leadId,
          recipient,
          subject,
          options.text,
          status,
          error,
          options.actor,
          now(),
        ).lastInsertRowid,
      );
    };
    let deliveryId: number;
    try {
      const reservation = db.transaction(() => {
        if (db.prepare('SELECT 1 FROM email_deliveries WHERE delivery_key=?').get(key))
          throw new HttpError(
            409,
            'This message already has a delivery attempt. Check its history.',
          );
        assertCanContact(db, recipient);
        if (!options.config.configured)
          throw new HttpError(
            409,
            'No workspace mailbox is configured. Ask an administrator to configure it.',
          );
        assertAddress(options.config.from_email, 'Sender');
        assertAddress(options.config.reply_to || options.config.from_email, 'Reply-to');
        if (options.config.copy_to) assertAddress(options.config.copy_to, 'Copy address');
        if (
          db
            .prepare("SELECT 1 FROM email_deliveries WHERE recipient=? AND status='SENDING'")
            .get(recipient)
        )
          throw new HttpError(409, 'A message is already being sent to this recipient.');
        options.beforeSend?.();
        const id = Number(
          db
            .prepare(
              `INSERT INTO email_deliveries
          (delivery_key,project_id,lead_id,recipient,status,started_at) VALUES (?,?,?,?,'SENDING',?)`,
            )
            .run(key, options.projectId, options.leadId, recipient, Date.now()).lastInsertRowid,
        );
        const messageId = log(
          'FAILED',
          'Delivery pending; mailbox acceptance is not yet confirmed.',
        );
        db.prepare('UPDATE email_deliveries SET message_id=? WHERE id=?').run(messageId, id);
        return { id, messageId };
      })();
      deliveryId = reservation.id;
      pendingMessageId = reservation.messageId;
      db.prepare(
        'UPDATE email_messages SET internet_message_id=? WHERE project_id=? AND lead_id=? AND id=?',
      ).run(internetMessageId, options.projectId, options.leadId, pendingMessageId);
    } catch (error) {
      // Idempotency conflicts should not duplicate history.
      if (!db.prepare('SELECT 1 FROM email_deliveries WHERE delivery_key=?').get(key))
        log('FAILED', error instanceof HttpError ? error.message : 'Delivery blocked.');
      throw error;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const unsubscribeUrl = publicOrigin ? publicOrigin + '/unsubscribe/' + token : '';
    if (unsubscribeUrl)
      db.prepare('INSERT INTO unsubscribe_tokens VALUES (?,?)').run(hash(token), recipient);
    const sender = assertAddress(options.config.from_email, 'Sender');
    const replyTo = assertAddress(options.config.reply_to || sender, 'Reply-to');
    const footer =
      '\n\n' +
      (options.config.signature ? options.config.signature + '\n' : '') +
      options.config.from_name +
      ' <' +
      sender +
      '>\n' +
      (unsubscribeUrl
        ? 'Unsubscribe: ' + unsubscribeUrl
        : 'Reply with "unsubscribe" to stop further emails.');
    const footerHtml =
      '<p style="font:12px sans-serif;color:#59644f;padding:16px">' +
      escapeHtml(options.config.from_name) +
      ' &lt;' +
      escapeHtml(sender) +
      '&gt; · ' +
      (unsubscribeUrl
        ? '<a href="' + escapeHtml(unsubscribeUrl) + '">Unsubscribe</a>'
        : 'Reply with “unsubscribe” to stop further emails.') +
      '</p>';
    const html = options.html.includes('<!--outreach-footer-->')
      ? options.html.replace('<!--outreach-footer-->', footerHtml)
      : options.html.includes('</body>')
        ? options.html.replace('</body>', footerHtml + '</body>')
        : options.html + footerHtml;
    try {
      await deliver(options.config, {
        to: recipient,
        subject,
        text: options.text + footer,
        messageId: internetMessageId,
        inReplyTo: options.inReplyTo,
        html,
        replyTo,
        bcc: options.config.copy_to
          ? assertAddress(options.config.copy_to, 'Copy address')
          : undefined,
        unsubscribeUrl: unsubscribeUrl || undefined,
        beforeSend: () => {
          if (db.prepare('SELECT 1 FROM email_suppressions WHERE recipient=?').get(recipient))
            throw new HttpError(409, 'The recipient opted out before delivery.');
          options.beforeSend?.();
        },
      });
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) {
        const messageId = log('FAILED', error.message);
        db.prepare(
          "UPDATE email_deliveries SET status='BLOCKED',message_id=?,error=? WHERE id=?",
        ).run(messageId, error.message, deliveryId);
        throw error;
      }
      // An SMTP connection failure can occur after acceptance. Count it conservatively.
      const messageId = log(
        'FAILED',
        'Delivery could not be confirmed. Check the mailbox; it will not be retried automatically.',
      );
      db.prepare(
        "UPDATE email_deliveries SET status='UNKNOWN',message_id=?,error=? WHERE id=?",
      ).run(messageId, 'Delivery could not be confirmed.', deliveryId);
      throw new HttpError(
        502,
        'Delivery could not be confirmed. Check the mailbox before contacting again.',
      );
    }
    return db.transaction(() => {
      const id = log('SENT');
      notifyLead(db, options.projectId, options.leadId, 'email', 'Email sent: ' + options.subject);
      db.prepare("UPDATE email_deliveries SET status='SENT',message_id=? WHERE id=?").run(
        id,
        deliveryId,
      );
      db.prepare(
        `UPDATE leads SET outreach_status=CASE WHEN outreach_status='NOT_CONTACTED' THEN 'CONTACTED' ELSE outreach_status END
        WHERE id=? AND project_id=?`,
      ).run(options.leadId, options.projectId);
      audit(
        db,
        options.projectId,
        options.actor,
        'lead.email_sent',
        'Message accepted by the mailbox for lead #' + options.leadId + '.',
      );
      return id;
    })();
  }
  return { send, recover };
}

/** Recipient-owned preference endpoint. The unguessable token is its authority, not a workspace session. */
export function installUnsubscribe(app: Express, db: DB) {
  const page = (message: string, form = '') =>
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Email preferences</title></head><body><main><h1>Email preferences</h1><p>' +
    message +
    '</p>' +
    form +
    '</main></body></html>';
  app.get('/unsubscribe/:token', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const token = String(req.params.token);
    if (
      !/^[a-f0-9]{64}$/.test(token) ||
      !db.prepare('SELECT 1 FROM unsubscribe_tokens WHERE token_hash=?').get(hash(token))
    )
      return void res.status(404).send(page('This link is not valid.'));
    res
      .type('html')
      .send(
        page(
          'Stop further emails from this workspace.',
          '<form method="post"><button type="submit">Unsubscribe</button></form>',
        ),
      );
  });
  app.post('/unsubscribe/:token', (req, res) => {
    const token = String(req.params.token);
    const row = /^[a-f0-9]{64}$/.test(token)
      ? (db
          .prepare('SELECT recipient FROM unsubscribe_tokens WHERE token_hash=?')
          .get(hash(token)) as { recipient: string } | undefined)
      : undefined;
    if (!row) return void res.status(404).send(page('This link is not valid.'));
    suppressRecipient(db, row.recipient, 'Recipient requested unsubscribe.');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(page('You have been unsubscribed. No further emails will be sent.'));
  });
}

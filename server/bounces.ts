import { audit, now, type DB } from './database';
import { notifyLead } from './workspace';

/**
 * A delivery-status notification, read from the raw message. Only a permanent failure (a 5.x.x
 * status, or an unmistakable "address not found" from a mailer daemon) counts as a bounce; a
 * delayed or temporary report changes nothing.
 */
export interface BounceReport {
  permanent: boolean;
  /** Final-Recipient addresses the report says failed permanently. */
  recipients: string[];
  /** Every address the report mentions, for a report that is not in the standard format. */
  mentioned: string[];
  /** Message-IDs of the returned original, which is how a report is tied to our own mail. */
  original_message_ids: string[];
  status: string;
}
const daemon = /^(mailer-daemon|mailerdaemon|mail-daemon|postmaster)@/i;
const addressPattern = /[a-z0-9._%+'-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi;

export function detectBounce(
  source: string,
  mail: { from_email: string; subject: string },
): BounceReport | undefined {
  const text = source.slice(0, 600_000);
  const split = /\r?\n\r?\n/.exec(text);
  const head = split ? text.slice(0, split.index) : text;
  const body = split ? text.slice(split.index) : '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const report =
    /^content-type:\s*multipart\/report\b[^\n]*report-type\s*=\s*"?delivery-status/im.test(
      unfolded,
    );
  if (!report && !daemon.test(mail.from_email)) return;
  const recipients = new Set<string>();
  let permanent = false;
  let structured = false;
  let status = '';
  // One block per recipient in the delivery-status part, separated by blank lines.
  for (const block of body.split(/\r?\n[ \t]*\r?\n/)) {
    const final = /^final-recipient:\s*rfc822\s*;\s*<?([^\s<>;]+@[^\s<>;]+?)>?\s*$/im.exec(block);
    if (!final) continue;
    structured = true;
    const action = /^action:\s*([a-z]+)/im.exec(block)?.[1].toLowerCase();
    const code = /^status:\s*([245])\.(\d{1,3})\.(\d{1,3})/im.exec(block);
    const diagnostic = /^diagnostic-code:[^\n]*\b(5\d\d)\b/im.test(block);
    if (action === 'failed' && (code ? code[1] === '5' : diagnostic)) {
      recipients.add(final[1].toLowerCase());
      permanent = true;
      status ||= code ? code[1] + '.' + code[2] + '.' + code[3] : '5xx';
    }
  }
  if (!structured && daemon.test(mail.from_email)) {
    // A non-standard report from a mailer daemon: permanent only when it says so in words and
    // carries a permanent SMTP code. It is still tied to our mail by its Message-ID later. A
    // standard report that only says "delayed" is taken at its word instead.
    const code = /\b(5\.\d{1,3}\.\d{1,3})\b|\b(55[0-4])\b/.exec(body);
    if (
      code &&
      /undeliver|could not be delivered|delivery (?:has )?failed|address not found|user unknown|no such user|does not exist|mailbox unavailable|recipient rejected/i.test(
        mail.subject + '\n' + body,
      )
    ) {
      permanent = true;
      status = code[1] || code[2];
    }
  }
  const originals = new Set<string>();
  for (const match of body.matchAll(/^message-id:\s*(<[^<>\s]{1,250}>)/gim))
    originals.add(match[1]);
  // Addresses in the explanation only: the returned original below it repeats the lead's own To
  // header even when the address that failed was the copy recipient.
  const returned =
    /^(?:content-type:\s*(?:message\/rfc822|text\/rfc822-headers)|received:|return-path:|message-id:|from:\s)/im.exec(
      body,
    );
  const explanation = returned ? body.slice(0, returned.index) : body;
  const mentioned = new Set<string>();
  for (const match of explanation.slice(0, 200_000).matchAll(addressPattern)) {
    mentioned.add(match[0].toLowerCase());
    if (mentioned.size >= 200) break;
  }
  return {
    permanent,
    recipients: [...recipients],
    mentioned: [...mentioned],
    original_message_ids: [...originals].slice(0, 30),
    status,
  };
}

/**
 * Records a permanent bounce. The address is suppressed workspace-wide like an opt-out, every
 * sequence still due to reach it stops, and the lead's outreach shows it bounced. The lead's
 * qualification is untouched, and nothing is deleted.
 */
export function recordBounce(
  db: DB,
  bounce: {
    recipient: string;
    projectId: number | null;
    leadId: number | null;
    source: 'SMTP' | 'DSN';
    status: string;
  },
) {
  const recipient = bounce.recipient.trim().toLowerCase();
  const when = now();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO email_bounces (recipient,project_id,lead_id,source,status_code,created_at) VALUES (?,?,?,?,?,?)',
    ).run(
      recipient,
      bounce.projectId,
      bounce.leadId,
      bounce.source,
      bounce.status.slice(0, 20),
      when,
    );
    db.prepare('INSERT OR IGNORE INTO email_suppressions VALUES (?,?,?)').run(
      recipient,
      'Email bounced: the receiving server rejected this address permanently.',
      when,
    );
    // The same rule an opt-out follows: sequences keyed to the address, and any sequence that
    // already mailed it through a step with its own To.
    db.prepare(
      `UPDATE funnel_enrollments SET status='STOPPED',stop_cause='BOUNCED',
        reason='The email to this address bounced, so the remaining messages will not be sent.',updated_at=?
      WHERE status IN ('QUEUED','SENDING','BLOCKED') AND (
        recipient=?
        OR lead_id IN (SELECT lead_id FROM email_deliveries
          WHERE recipient=? AND status IN ('SENDING','SENT','UNKNOWN','BLOCKED'))
      )`,
    ).run(when, recipient, recipient);
    db.prepare(
      `UPDATE leads SET outreach_status='BOUNCED'
      WHERE lower(trim(contact_email))=? AND outreach_status IN ('NOT_CONTACTED','CONTACTED')`,
    ).run(recipient);
    if (bounce.projectId !== null && bounce.leadId !== null) {
      db.prepare(
        "INSERT INTO outreach_events(project_id,lead_id,outcome,notes,created_by,created_at) VALUES(?,?,'BOUNCED',?,'Mailbox',?)",
      ).run(
        bounce.projectId,
        bounce.leadId,
        'The email to ' +
          recipient +
          ' bounced' +
          (bounce.source === 'SMTP' ? ' when it was sent' : ' (delivery failure report)') +
          '. No further email will be sent to this address.',
        when,
      );
      audit(
        db,
        bounce.projectId,
        'Mailbox',
        'lead.email_bounced',
        'Lead #' + bounce.leadId + ': the email address bounced.',
      );
      notifyLead(db, bounce.projectId, bounce.leadId, 'email', 'Email bounced: ' + recipient);
    }
  })();
}

/**
 * Applies a bounce report that arrived through a project's own inbox. Like reply matching, it
 * only considers mail this project sent: the report must quote one of our Message-IDs and name
 * the address that message went to, or — when it quotes none — name an address this project
 * has actually delivered to. A report about the copy address therefore never suppresses the lead.
 */
export function applyIncomingBounce(
  db: DB,
  projectId: number,
  incomingId: number,
  mail: { received_at: string; references: string[]; bounce?: BounceReport },
) {
  const report = mail.bounce;
  if (!report?.permanent) return 0;
  // A standard report names its failed recipients; only a non-standard one falls back to the
  // addresses its explanation mentions.
  const named = new Set(report.recipients.length ? report.recipients : report.mentioned);
  const matches = new Map<string, number>();
  const ids = [...new Set([...report.original_message_ids, ...mail.references])];
  if (ids.length) {
    const rows = db
      .prepare(
        `SELECT m.lead_id,lower(trim(m.to_email)) recipient FROM email_messages m
        JOIN leads l ON l.project_id=m.project_id AND l.id=m.lead_id
        WHERE m.project_id=? AND m.created_at<=? AND m.internet_message_id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(projectId, mail.received_at, ...ids) as Array<{ lead_id: number; recipient: string }>;
    for (const row of rows) if (named.has(row.recipient)) matches.set(row.recipient, row.lead_id);
  }
  if (!matches.size)
    for (const recipient of report.recipients) {
      const row = db
        .prepare(
          `SELECT m.lead_id FROM email_messages m JOIN leads l ON l.project_id=m.project_id AND l.id=m.lead_id
          WHERE m.project_id=? AND lower(trim(m.to_email))=? AND m.status='SENT' AND m.created_at<=?
          ORDER BY m.id DESC LIMIT 1`,
        )
        .get(projectId, recipient, mail.received_at) as { lead_id: number } | undefined;
      if (row) matches.set(recipient, row.lead_id);
    }
  for (const [recipient, leadId] of matches)
    recordBounce(db, { recipient, projectId, leadId, source: 'DSN', status: report.status });
  const leads = new Set(matches.values());
  // One lead: file the report with it, so the delivery failure shows on its email tab.
  if (leads.size === 1)
    db.prepare(
      `UPDATE incoming_messages SET project_id=?,lead_id=?,linked_at=?,
        notice=trim(notice||' Delivery failure report: the address bounced and will not be mailed again.')
      WHERE id=? AND mailbox_project_id=? AND project_id IS NULL`,
    ).run(projectId, [...leads][0], now(), incomingId, projectId);
  return matches.size;
}

import dns from 'node:dns/promises';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { HttpError } from './validation';
import { isPublicIp } from './network';
import type { DB, Secrets } from './database';
import type { EmailSettings, Lead } from '../shared/types';

/** Submission ports only. 25 is excluded: it is for server-to-server relay, not submission. */
const allowedPorts = [465, 587, 2525];

export interface SmtpConfig extends EmailSettings {
  password: string;
}
interface MailboxRow {
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  smtp_username: string;
  smtp_password: string;
  from_name: string;
  from_email: string;
  reply_to: string;
  copy_to: string;
  signature: string;
}
/**
 * The sending half of one project's mailbox. The project is a required argument because there
 * is no workspace sender to fall back to: a caller cannot accidentally send one project's mail
 * from another project's address.
 */
export function getEmailConfig(db: DB, secrets: Secrets, projectId: number): SmtpConfig {
  const row = db
    .prepare(
      `SELECT smtp_host,smtp_port,smtp_secure,smtp_username,smtp_password,
        from_name,from_email,reply_to,copy_to,signature
      FROM project_mailboxes WHERE project_id=?`,
    )
    .get(projectId) as MailboxRow | undefined;
  return {
    project_id: projectId,
    host: row?.smtp_host || '',
    port: Number(row?.smtp_port || 587),
    secure: Boolean(row?.smtp_secure),
    username: row?.smtp_username || '',
    from_name: row?.from_name || '',
    from_email: row?.from_email || '',
    reply_to: row?.reply_to || '',
    copy_to: row?.copy_to || '',
    signature: row?.signature || '',
    configured: Boolean(row?.smtp_host && row?.from_email && row?.smtp_password),
    has_password: Boolean(row?.smtp_password),
    password: row?.smtp_password ? secrets.decrypt(row.smtp_password) : '',
  };
}
/**
 * Writes the sending half. A password of null clears it and undefined keeps the stored one, so
 * saving settings never round-trips the secret through the browser.
 */
export function saveEmailConfig(
  db: DB,
  projectId: number,
  values: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    from_name: string;
    from_email: string;
    reply_to: string;
    copy_to: string;
    signature: string;
    password?: string | null;
  },
) {
  db.prepare('INSERT OR IGNORE INTO project_mailboxes(project_id) VALUES(?)').run(projectId);
  db.prepare(
    `UPDATE project_mailboxes SET smtp_host=?,smtp_port=?,smtp_secure=?,smtp_username=?,
      from_name=?,from_email=?,reply_to=?,copy_to=?,signature=? WHERE project_id=?`,
  ).run(
    values.host,
    values.port,
    values.secure ? 1 : 0,
    values.username,
    values.from_name,
    values.from_email,
    values.reply_to,
    values.copy_to,
    values.signature,
    projectId,
  );
  if (values.password !== undefined)
    db.prepare('UPDATE project_mailboxes SET smtp_password=? WHERE project_id=?').run(
      values.password || '',
      projectId,
    );
}
export function publicEmailSettings(config: SmtpConfig): EmailSettings {
  const { password: _password, ...rest } = config;
  return rest;
}

/**
 * A mail host is an outbound connection target, so it gets the same treatment as a
 * website fetch: public addresses only, on a submission port.
 */
export async function assertMailHost(host: string, port: number) {
  if (!allowedPorts.includes(port))
    throw new HttpError(400, 'Use SMTP submission port 587, 465 or 2525.');
  return resolveMailHost(host);
}
/** Shared public-network validation for TLS mail connections. */
export async function resolveMailHost(host: string) {
  const clean = host.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(clean) || clean.length > 253 || clean.startsWith('-'))
    throw new HttpError(400, 'Enter a valid mail server hostname.');
  if (clean === 'localhost' || /\.(localhost|local|internal|test|invalid)$/.test(clean))
    throw new HttpError(400, 'The mail server must be a public host.');
  if (net.isIP(clean)) {
    if (!isPublicIp(clean)) throw new HttpError(400, 'The mail server must be a public host.');
    return { address: clean, servername: clean };
  }
  let records: Array<{ address: string }>;
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    records = await Promise.race([
      dns.lookup(clean, { all: true }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS timeout')), 5000);
      }),
    ]).finally(() => clearTimeout(timeout));
  } catch {
    throw new HttpError(400, 'That mail server hostname could not be resolved.');
  }
  if (!records.length || records.some((record) => !isPublicIp(record.address)))
    throw new HttpError(400, 'That mail server resolves to a private or reserved network.');
  return { address: records[0].address, servername: clean };
}

/** CR and LF in a header value are how header injection happens. */
function headerSafe(value: string, label: string) {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  if (clean !== value.trim()) throw new HttpError(400, label + ' cannot contain line breaks.');
  return clean;
}
const emailShape = /^[^\s@<>,;]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export function assertAddress(value: string, label: string) {
  const clean = headerSafe(value, label);
  if (!emailShape.test(clean)) throw new HttpError(400, label + ' is not a valid email address.');
  return clean;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
/**
 * Renders the plain-text body into a simple, well-supported HTML email. Inline styles and
 * table-free markup only — email clients discard stylesheets. Every interpolated value is
 * escaped: the body is author-supplied, the lead fields are not trusted at all.
 */
export function renderEmail(options: {
  body: string;
  fromName: string;
  fromEmail: string;
  signature: string;
  leadName: string;
  includeFooter?: boolean;
}) {
  const paragraphs = options.body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) =>
        '<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#25352e;">' +
        escapeHtml(block).replace(/\n/g, '<br />') +
        '</p>',
    )
    .join('');
  const signature = options.signature.trim()
    ? '<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e8e0;font-size:13px;line-height:1.6;color:#6b7566;">' +
      escapeHtml(options.signature).replace(/\n/g, '<br />') +
      '</div>'
    : '';
  // A named sender and a working opt-out are required for commercial mail in the EU and US.
  const footer =
    '<div style="margin-top:20px;font-size:11px;line-height:1.6;color:#8a9184;">' +
    escapeHtml(options.fromName || options.fromEmail) +
    ' &lt;' +
    escapeHtml(options.fromEmail) +
    '&gt;<br />You are receiving this because we believe ' +
    escapeHtml(options.leadName) +
    ' may have a relevant technical requirement. Reply with “unsubscribe” and we will not contact you again.' +
    '</div>';
  return (
    '<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f3;">' +
    '<div style="max-width:600px;margin:0 auto;padding:28px 24px;background:#ffffff;font-family:-apple-system,Segoe UI,Arial,sans-serif;">' +
    paragraphs +
    signature +
    (options.includeFooter === false ? '<!--outreach-footer-->' : footer) +
    '</div></body></html>'
  );
}

/** A file sent with a message. With a cid it is an inline image the HTML refers to. */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  cid?: string;
}
/**
 * The receiving server refused the recipient outright (a 5xx reply to RCPT TO). Unlike a
 * dropped connection this is not ambiguous: the message was not accepted for that address,
 * so the caller may record a bounce. The SMTP reply text is never passed on.
 */
export class RecipientRejected extends HttpError {
  constructor(
    public recipient: string,
    public responseCode: number,
  ) {
    super(
      422,
      'The recipient’s mail server rejected this address permanently (SMTP ' +
        responseCode +
        '). It will not be emailed again.',
    );
  }
}
interface SmtpFailure {
  code?: string;
  command?: string;
  responseCode?: number;
  recipient?: string;
  rejectedErrors?: SmtpFailure[];
}
/** The permanent RCPT rejection for this address, if the transport reported one. */
function permanentRejection(failures: SmtpFailure[] | undefined, address: string) {
  const found = (failures || []).find(
    (failure) =>
      failure.command === 'RCPT TO' &&
      String(failure.recipient || '').toLowerCase() === address.toLowerCase() &&
      Number(failure.responseCode) >= 500 &&
      Number(failure.responseCode) < 600,
  );
  return found ? new RecipientRejected(address, Number(found.responseCode)) : null;
}

export type Send = (
  config: SmtpConfig,
  message: {
    to: string;
    subject: string;
    text: string;
    html: string;
    replyTo: string;
    bcc?: string;
    unsubscribeUrl?: string;
    messageId?: string;
    inReplyTo?: string;
    attachments?: MailAttachment[];
    beforeSend?: () => void;
  },
) => Promise<void>;
export const sendMail: Send = async (config, message) => {
  const target = await assertMailHost(config.host, config.port);
  message.beforeSend?.();
  const transport = nodemailer.createTransport({
    host: target.address,
    tls: { servername: target.servername, rejectUnauthorized: true },
    port: config.port,
    secure: config.secure,
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
    requireTLS: !config.secure,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    // Never let message content reach the filesystem or the network.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const result = await transport.sendMail({
      from: { name: config.from_name || config.from_email, address: config.from_email },
      to: message.to,
      bcc: message.bcc,
      headers: message.unsubscribeUrl
        ? {
            'List-Unsubscribe': '<' + message.unsubscribeUrl + '>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }
        : undefined,
      replyTo: message.replyTo || config.reply_to || config.from_email,
      subject: message.subject,
      messageId: message.messageId,
      inReplyTo: message.inReplyTo,
      references: message.inReplyTo,
      text: message.text,
      html: message.html,
      attachments: message.attachments?.map((file) => ({
        filename: file.filename.replace(/[\r\n]+/g, ' '),
        content: file.content,
        contentType: file.contentType,
        ...(file.cid ? { cid: file.cid, contentDisposition: 'inline' as const } : {}),
      })),
    });
    // Partial acceptance must not look like a confirmed send with its required copy.
    const accepted = result.accepted.map((address) => String(address).toLowerCase());
    if (!accepted.includes(message.to.toLowerCase())) {
      const rejected = permanentRejection(
        (result as { rejectedErrors?: SmtpFailure[] }).rejectedErrors,
        message.to,
      );
      if (rejected) throw rejected;
    }
    if (
      ![message.to, ...(message.bcc ? [message.bcc] : [])].every((address) =>
        accepted.includes(address.toLowerCase()),
      )
    )
      throw new Error('A recipient was not accepted.');
  } catch (error) {
    if (error instanceof RecipientRejected) throw error;
    // Every recipient refused at RCPT TO: the transport says which, and with what reply code.
    const failure = error as SmtpFailure;
    const rejected =
      failure?.code === 'EENVELOPE'
        ? permanentRejection([failure, ...(failure.rejectedErrors || [])], message.to)
        : null;
    if (rejected) throw rejected;
    // Provider errors can carry credentials and full message content.
    throw new HttpError(
      502,
      'The mail server rejected the message. Check the SMTP settings and try again.',
    );
  } finally {
    transport.close();
  }
};

/** A first draft built from the approved qualification, for the researcher to edit. */
export function draftFor(lead: Lead, whyQualified: string, callScript: string) {
  const greeting = lead.contact_name ? 'Hello ' + lead.contact_name.split(' ')[0] : 'Hello';
  const reason = whyQualified.trim() || callScript.trim();
  return {
    subject: lead.name + ' — a quick question about working together',
    body:
      greeting +
      ',\n\n' +
      (reason
        ? 'I was reading about ' + lead.name + '. ' + reason
        : 'I was reading about ' + lead.name + ' and wanted to get in touch.') +
      '\n\nWould it make sense to have a short conversation about whether there is a fit? ' +
      'Happy to keep it brief.\n\nBest regards',
  };
}

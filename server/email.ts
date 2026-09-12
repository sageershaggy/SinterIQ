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
export function getEmailConfig(db: DB, secrets: Secrets): SmtpConfig {
  const saved = Object.fromEntries(
    (
      db.prepare("SELECT key,value FROM settings WHERE key LIKE 'smtp_%'").all() as Array<{
        key: string;
        value: string;
      }>
    ).map((row) => [row.key, row.value]),
  );
  return {
    host: saved.smtp_host || '',
    port: Number(saved.smtp_port || 587),
    secure: saved.smtp_secure === '1',
    username: saved.smtp_username || '',
    from_name: saved.smtp_from_name || '',
    from_email: saved.smtp_from_email || '',
    reply_to: saved.smtp_reply_to || '',
    signature: saved.smtp_signature || '',
    configured: Boolean(saved.smtp_host && saved.smtp_from_email && saved.smtp_password),
    has_password: Boolean(saved.smtp_password),
    password: saved.smtp_password ? secrets.decrypt(saved.smtp_password) : '',
  };
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
  const clean = host.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(clean) || clean.length > 253 || clean.startsWith('-'))
    throw new HttpError(400, 'Enter a valid mail server hostname.');
  if (clean === 'localhost' || /\.(localhost|local|internal|test|invalid)$/.test(clean))
    throw new HttpError(400, 'The mail server must be a public host.');
  if (!allowedPorts.includes(port))
    throw new HttpError(400, 'Use SMTP submission port 587, 465 or 2525.');
  if (net.isIP(clean)) {
    if (!isPublicIp(clean)) throw new HttpError(400, 'The mail server must be a public host.');
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await dns.lookup(clean, { all: true });
  } catch {
    throw new HttpError(400, 'That mail server hostname could not be resolved.');
  }
  if (!records.length || records.some((record) => !isPublicIp(record.address)))
    throw new HttpError(400, 'That mail server resolves to a private or reserved network.');
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
    footer +
    '</div></body></html>'
  );
}

export type Send = (
  config: SmtpConfig,
  message: { to: string; subject: string; text: string; html: string; replyTo: string },
) => Promise<void>;
export const sendMail: Send = async (config, message) => {
  await assertMailHost(config.host, config.port);
  const transport = nodemailer.createTransport({
    host: config.host,
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
    await transport.sendMail({
      from: { name: config.from_name || config.from_email, address: config.from_email },
      to: message.to,
      replyTo: message.replyTo || config.reply_to || config.from_email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } catch {
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
    subject: lead.name + ' — a quick question about your bearing requirements',
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

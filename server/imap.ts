import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { resolveMailHost } from './email';
import { detectBounce, type BounceReport } from './bounces';

export interface InboxConfig {
  host: string;
  username: string;
  password: string;
  folder: string;
}
export interface InboxCursor {
  uid_validity: string;
  last_uid: number;
}
export interface ReceivedMail {
  uid: number;
  message_id: string;
  references: string[];
  from_email: string;
  from_name: string;
  to_email: string;
  subject: string;
  body: string;
  received_at: string;
  attachment_count: number;
  notice: string;
  /** Present when the message is a delivery-status report (a bounce or a delay). */
  bounce?: BounceReport;
}
export type ReadInbox = (
  config: InboxConfig,
  cursor: InboxCursor | null,
) => Promise<{
  uid_validity: string;
  last_uid: number;
  messages: ReceivedMail[];
}>;
const maxSource = 512_000;
const clean = (value: string | undefined, max = 300) =>
  (value || '').replace(/[\r\n\0]/g, ' ').slice(0, max);
export const messageIds = (value: string) => (value.match(/<[^<>\s]{1,250}>/g) || []).slice(-30);

/** Bounded MIME, displayed as text only. HTML and attachment bytes are never persisted. */
export async function parseReceived(message: FetchMessageObject): Promise<ReceivedMail> {
  const envelope = message.envelope;
  const timestamp = new Date(message.internalDate || 0);
  const validDate = Number.isFinite(timestamp.getTime()) && timestamp.getTime() > 0;
  const output: ReceivedMail = {
    uid: message.uid,
    message_id: messageIds(envelope?.messageId || '')[0] || '',
    references: messageIds(envelope?.inReplyTo || ''),
    from_email: clean(envelope?.from?.length === 1 ? envelope.from[0].address : '').toLowerCase(),
    from_name: clean(envelope?.from?.[0]?.name),
    to_email: clean(envelope?.to?.[0]?.address),
    subject: clean(envelope?.subject) || '(No subject)',
    body: '',
    received_at: validDate ? timestamp.toISOString() : new Date(0).toISOString(),
    attachment_count: 0,
    notice: validDate ? '' : 'The original received date is unavailable. ',
  };
  if (!message.source || message.source.length > maxSource || (message.size || 0) > maxSource) {
    output.notice +=
      'This message is larger than the preview limit. Read its contents and attachments in your original mailbox.';
    return output;
  }
  try {
    const parsed = await simpleParser(message.source, {
      maxHtmlLengthToParse: maxSource,
      skipTextToHtml: true,
      skipImageLinks: true,
      skipTextLinks: true,
      keepCidLinks: true,
    });
    output.message_id = messageIds(parsed.messageId || output.message_id)[0] || '';
    output.references = messageIds(
      [
        parsed.inReplyTo || '',
        ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references || '']),
      ].join(' '),
    );
    output.body = (parsed.text || '').replace(/\0/g, '').slice(0, 20_000);
    output.attachment_count = parsed.attachments.length;
    if ((parsed.text?.length || 0) > 20_000)
      output.notice += 'Long message: showing the first 20,000 characters.';
    if (output.attachment_count) output.notice += ' Attachments remain in your original mailbox.';
    // Read from the raw report: its machine-readable part names the address that failed and
    // quotes the Message-ID of the original, which is what ties it to our own mail.
    const bounce = detectBounce(message.source.toString('latin1'), output);
    if (bounce) output.bounce = bounce;
  } catch {
    output.notice += 'This message could not be previewed. Open it in your original mailbox.';
  }
  return output;
}

/** Read-only TLS IMAP. Pin DNS, disable logs/remote images, and bound every batch. */
export const readInbox: ReadInbox = async (config, cursor) => {
  const target = await resolveMailHost(config.host);
  const client = new ImapFlow({
    host: target.address,
    port: 993,
    secure: true,
    servername: target.servername,
    auth: { user: config.username, pass: config.password },
    tls: { servername: target.servername, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000,
    maxLineLength: 64_000,
    maxLiteralSize: 576_000,
    maxResponseSize: 2_000_000,
  });
  client.on('error', () => {
    /* Callers receive a fixed, credential-free error. */
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    await client.connect();
    const lock = await client.getMailboxLock(config.folder, { readOnly: true });
    try {
      const box = client.mailbox;
      if (!box) throw new Error('Mailbox unavailable');
      const validity = String(box.uidValidity);
      const highest = box.uidNext - 1;
      const fresh = !cursor || cursor.uid_validity !== validity;
      let last = fresh ? highest : cursor.last_uid;
      const end = fresh ? highest : Math.min(highest, last + 1000);
      const metadata =
        box.exists && (fresh || last < highest)
          ? await client.fetchAll(
              fresh ? `${Math.max(1, box.exists - 19)}:${box.exists}` : `${last + 1}:${end}`,
              { uid: true, envelope: true, size: true, internalDate: true },
              { uid: !fresh },
            )
          : [];
      metadata.sort((a, b) => a.uid - b.uid);
      const messages: ReceivedMail[] = [];
      for (const info of metadata.slice(0, 20)) {
        const content =
          (info.size || 0) <= maxSource
            ? await client.fetchOne(
                String(info.uid),
                { source: { start: 0, maxLength: maxSource } },
                { uid: true },
              )
            : null;
        messages.push(
          await parseReceived({ ...info, source: content ? content.source : undefined }),
        );
        last = Math.max(last, info.uid);
      }
      if (!fresh && metadata.length <= 20) last = end;
      return { uid_validity: validity, last_uid: last, messages };
    } finally {
      lock.release();
    }
  };
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          client.close();
          reject(new Error('Mailbox timeout'));
        }, 45_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    client.close();
  }
};

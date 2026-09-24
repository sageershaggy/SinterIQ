import { useEffect, useState } from 'react';
import { Inbox, Send, Settings } from 'lucide-react';
import type { IncomingSettings } from '../shared/mailbox';
import { sendingGaps } from '../shared/mailbox-status';
import type { EmailSettings, Project } from '../shared/types';
import { api } from './api';
import { Badge } from './ui';
import './MailboxStatus.css';

/** What the incoming half still lacks. The server enables sync only once all of it is there. */
function incomingGaps(settings: IncomingSettings) {
  const gaps: string[] = [];
  if (!settings.host) gaps.push('IMAP host missing');
  if (!settings.username) gaps.push('Username missing');
  if (!settings.has_password) gaps.push('Password missing');
  if (!gaps.length && !settings.enabled) gaps.push('Sync is turned off');
  return gaps;
}

/**
 * Which mailbox this project sends from and receives replies at, at the top of its mailbox
 * screen. "Not configured" always says what is missing, because a form with every visible box
 * filled in can still lack the one field that matters.
 */
export function MailboxStatus({
  project,
  incoming,
  refresh,
  onConfigure,
}: {
  project: Project;
  /** Loaded with the mailbox page; null while it loads. */
  incoming: IncomingSettings | null;
  refresh: number;
  /** Offered while the settings form is closed. */
  onConfigure?: () => void;
}) {
  const [sending, setSending] = useState<EmailSettings | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<EmailSettings>(`/projects/${project.id}/mailbox/email`)
      .then((value) => {
        if (!cancelled) {
          setSending(value);
          setError('');
        }
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, refresh]);
  const gaps = sending ? sendingGaps(sending) : [];
  const ready = Boolean(sending?.configured);
  const replies = incoming ? incomingGaps(incoming) : [];
  const receiving = Boolean(incoming?.enabled && !incoming.last_error);
  return (
    <section className="mailbox-status" aria-label={`Mailbox connected to ${project.name}`}>
      <div className={'mailbox-status-card' + (sending && !ready ? ' needs-setup' : '')}>
        <span className="mailbox-status-icon" aria-hidden="true">
          <Send size={17} />
        </span>
        <div className="mailbox-status-text">
          <span className="mailbox-status-label">Sends from</span>
          {!sending ? (
            <p>{error || 'Loading…'}</p>
          ) : (
            <>
              <strong>
                {sending.from_name || sending.from_email ? (
                  <>
                    {sending.from_name || project.name}
                    {sending.from_email && <span> &lt;{sending.from_email}&gt;</span>}
                  </>
                ) : (
                  'No sender set'
                )}
              </strong>
              <p>
                {ready
                  ? `Every email from ${project.name} leaves through ${sending.host}:${sending.port}.`
                  : 'Cannot send yet: ' + gaps.join(' · ') + '.'}
              </p>
              <small>
                {sending.copy_to
                  ? `A copy of each outreach email goes to ${sending.copy_to}.`
                  : 'No copy address — needed before an email funnel can start.'}
              </small>
            </>
          )}
        </div>
        {sending && (
          <Badge value={ready ? 'ready' : 'draft'}>
            {ready ? 'Ready to send' : 'Not configured'}
          </Badge>
        )}
      </div>
      <div
        className={
          'mailbox-status-card' + (incoming && (!receiving || replies.length) ? ' needs-setup' : '')
        }
      >
        <span className="mailbox-status-icon" aria-hidden="true">
          <Inbox size={17} />
        </span>
        <div className="mailbox-status-text">
          <span className="mailbox-status-label">Receives replies at</span>
          {!incoming ? (
            <p>Loading…</p>
          ) : (
            <>
              <strong>{incoming.username || 'No inbox connected'}</strong>
              <p>
                {incoming.last_error
                  ? 'Needs attention — see the message below.'
                  : incoming.enabled
                    ? incoming.last_sync
                      ? 'Last synced ' + new Date(incoming.last_sync).toLocaleString()
                      : 'Connected · waiting for the first sync'
                    : 'Replies are not collected: ' + replies.join(' · ') + '.'}
              </p>
              {incoming.host && (
                <small>
                  {incoming.host} · {incoming.folder || 'INBOX'}
                </small>
              )}
            </>
          )}
        </div>
        {incoming && (
          <Badge value={receiving ? 'ready' : 'draft'}>
            {incoming.last_error
              ? 'Needs attention'
              : incoming.enabled
                ? 'Connected'
                : 'Not connected'}
          </Badge>
        )}
      </div>
      {onConfigure && sending && (!ready || !receiving) && (
        <button className="button secondary small mailbox-status-fix" onClick={onConfigure}>
          <Settings size={14} />
          Complete the setup
        </button>
      )}
    </section>
  );
}

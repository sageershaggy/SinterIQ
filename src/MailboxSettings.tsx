import { useEffect, useState } from 'react';
import { Mail, Send, Users } from 'lucide-react';
import type { EmailSettings, Project } from '../shared/types';
import { sendingGaps } from '../shared/mailbox-status';
import { api, json } from './api';
import { Alert, Badge, Spinner } from './ui';
import { IncomingSettings } from './IncomingSettings';

/** Sending and receiving for one project's own mailbox: no mailbox is shared by the workspace. */
export function MailboxSettings({
  project,
  notify,
  onSaved,
}: {
  project: Project;
  notify: (message: string) => void;
  /** Lets the mailbox screen refresh its connection state instead of showing a stale one. */
  onSaved?: () => void;
}) {
  const base = '/projects/' + project.id + '/mailbox/email';
  const [mailbox, setMailbox] = useState<EmailSettings | null>(null),
    // What the server holds, so the status names what is missing from the saved mailbox rather
    // than from whatever is half-typed in the form.
    [stored, setStored] = useState<EmailSettings | null>(null),
    [password, setPassword] = useState(''),
    [clearPassword, setClearPassword] = useState(false),
    [test, setTest] = useState('');
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<EmailSettings>(base)
      .then((value) => {
        if (!cancelled) {
          setMailbox(value);
          setStored(value);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);
  return (
    <div className="mailbox-settings">
      {error && <Alert>{error}</Alert>}
      <section className="panel">
        <div className="section-title">
          <h2>
            <Mail size={20} />
            Sending mailbox
          </h2>
          {stored && (
            <Badge value={stored.configured ? 'ready' : 'draft'}>
              {stored.configured
                ? 'Ready to send'
                : 'Not configured · ' + sendingGaps(stored).join(' · ')}
            </Badge>
          )}
        </div>
        <p className="muted">
          {project.name} sends all of its outbound email from this mailbox. Researchers compose and
          send from a lead in this project; every message is logged against that lead. Use an SMTP
          submission port — 587 with STARTTLS, or 465 with TLS.
        </p>
        {!mailbox ? (
          !error && <Spinner text="Loading mailbox…" />
        ) : (
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy('mailbox');
              setError('');
              setTest('');
              try {
                const saved = await api<EmailSettings>(base, {
                  method: 'PUT',
                  body: json({
                    host: mailbox.host,
                    port: mailbox.port,
                    secure: mailbox.secure,
                    username: mailbox.username,
                    password,
                    clear_password: clearPassword,
                    from_name: mailbox.from_name,
                    from_email: mailbox.from_email,
                    reply_to: mailbox.reply_to,
                    copy_to: mailbox.copy_to || '',
                    signature: mailbox.signature,
                  }),
                });
                setMailbox(saved);
                setStored(saved);
                setPassword('');
                setClearPassword(false);
                onSaved?.();
                notify('Mailbox saved for ' + project.name + '.');
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy('');
              }
            }}
          >
            <div className="form-grid">
              <label>
                SMTP host
                <input
                  value={mailbox.host}
                  onChange={(e) => setMailbox({ ...mailbox, host: e.target.value })}
                  maxLength={253}
                  placeholder="smtp.yourprovider.com"
                />
              </label>
              <label>
                Port
                <select
                  value={String(mailbox.port)}
                  onChange={(e) =>
                    setMailbox({
                      ...mailbox,
                      port: Number(e.target.value),
                      secure: e.target.value === '465',
                    })
                  }
                >
                  <option value="587">587 — STARTTLS</option>
                  <option value="465">465 — TLS</option>
                  <option value="2525">2525 — STARTTLS</option>
                </select>
              </label>
            </div>
            <div className="form-grid">
              <label>
                Username
                <input
                  value={mailbox.username}
                  onChange={(e) => setMailbox({ ...mailbox, username: e.target.value })}
                  maxLength={200}
                  autoComplete="off"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  maxLength={400}
                  autoComplete="new-password"
                  placeholder={
                    mailbox.has_password ? 'Saved · leave blank to keep' : 'Mailbox password'
                  }
                />
                <small>Encrypted at rest and never shown again.</small>
              </label>
            </div>
            <div className="form-grid">
              <label>
                Sender name
                <input
                  value={mailbox.from_name}
                  onChange={(e) => setMailbox({ ...mailbox, from_name: e.target.value })}
                  maxLength={120}
                  placeholder={project.name}
                />
              </label>
              <label>
                Sender address
                <input
                  type="email"
                  value={mailbox.from_email}
                  onChange={(e) => setMailbox({ ...mailbox, from_email: e.target.value })}
                  maxLength={200}
                  placeholder="research@yourcompany.com"
                />
              </label>
            </div>
            <label>
              Reply-to (optional)
              <input
                type="email"
                value={mailbox.reply_to}
                onChange={(e) => setMailbox({ ...mailbox, reply_to: e.target.value })}
                maxLength={200}
              />
              <small>Connect this inbox below to receive its replies inside the app.</small>
            </label>
            <label>
              Copy every outreach email to
              <input
                type="email"
                value={mailbox.copy_to || ''}
                maxLength={200}
                onChange={(e) => setMailbox({ ...mailbox, copy_to: e.target.value })}
              />
              <small>
                Receives a BCC of sent messages. Required before starting an email funnel in this
                project.
              </small>
            </label>
            <label>
              Signature
              <textarea
                rows={3}
                value={mailbox.signature}
                onChange={(e) => setMailbox({ ...mailbox, signature: e.target.value })}
                maxLength={1000}
                placeholder="Name, company, phone"
              />
            </label>
            {mailbox.has_password && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={clearPassword}
                  onChange={(e) => setClearPassword(e.target.checked)}
                />
                Clear the saved password on save
              </label>
            )}
            <p className="fine-print">
              Every message names the sender and carries an opt-out line. Commercial email is
              regulated — GDPR and PECR in the EU, CAN-SPAM in the US — so send only where you have
              a lawful basis, and honour replies asking to stop.
            </p>
            {test && <div className="import-result">{test}</div>}
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                disabled={!!busy || !mailbox.configured}
                onClick={async () => {
                  setBusy('mailtest');
                  setError('');
                  setTest('');
                  try {
                    const result = await api<{ sent_to: string }>(base + '/test', {
                      method: 'POST',
                      body: json({}),
                    });
                    setTest('Test message sent to ' + result.sent_to + '.');
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy('');
                  }
                }}
              >
                {busy === 'mailtest' ? (
                  <Spinner text="Sending…" />
                ) : (
                  <>
                    <Send size={15} />
                    Send a test
                  </>
                )}
              </button>
              <button className="button primary" disabled={busy === 'mailbox'}>
                {busy === 'mailbox' ? <Spinner text="Saving…" /> : 'Save mailbox'}
              </button>
            </div>
          </form>
        )}
      </section>
      {sharedWith.length > 0 && (
        <div className="mailbox-shared-notice" role="note">
          <Users size={19} />
          <div>
            <strong>This inbox is also polled by {sharedWith.join(', ')}.</strong>
            <p>
              Each of those projects collects its own copy of every message that arrives here, and
              its administrators can read them. Give {project.name} its own inbox, or turn the sync
              off in the projects that should not receive this mail.
            </p>
          </div>
        </div>
      )}
      <IncomingSettings
        project={project}
        notify={notify}
        onLoaded={(settings) => setSharedWith(settings.shared_with)}
      />
    </div>
  );
}

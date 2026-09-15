import { useEffect, useState, type FormEvent } from 'react';
import { Inbox, RefreshCw } from 'lucide-react';
import type { IncomingSettings as Settings } from '../shared/mailbox';
import { api, json } from './api';
import { Alert, Badge, Spinner } from './ui';

export function IncomingSettings({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [password, setPassword] = useState(''),
    [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<Settings>('/settings/incoming')
      .then((value) => {
        if (!cancelled) {
          setSettings(value);
          setSaved(JSON.stringify(value));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<Settings>('/settings/incoming', {
        method: 'PUT',
        body: json({
          revision: settings.revision,
          host: settings.host,
          username: settings.username,
          folder: settings.folder,
          enabled: settings.enabled,
          password,
          clear_password: clear,
        }),
      });
      setSettings(result);
      setSaved(JSON.stringify(result));
      setPassword('');
      setClear(false);
      notify(
        result.enabled
          ? 'Incoming mail enabled. Sync now to verify the connection.'
          : 'Incoming settings saved. Sync is off.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" id="incoming-settings">
      <div className="section-title">
        <h2>
          <Inbox size={20} /> Incoming mail
        </h2>
        <Badge value={settings?.enabled ? 'ready' : 'draft'}>
          {settings?.enabled ? 'Sync enabled' : 'Not connected'}
        </Badge>
      </div>
      <p className="muted">
        Connect the inbox that receives replies to your outgoing emails. Messages appear in Mailbox
        and matched replies appear on their lead.
      </p>
      {error && <Alert>{error}</Alert>}
      {!settings ? (
        !error && <Spinner text="Loading connection…" />
      ) : (
        <form onSubmit={save}>
          <fieldset disabled={busy} className="mail-settings-fields">
            <div className="form-row">
              <label>
                IMAP host
                <input
                  value={settings.host}
                  maxLength={253}
                  placeholder="imap.your-provider.com"
                  onChange={(e) => setSettings({ ...settings, host: e.target.value })}
                />
              </label>
              <label>
                Connection
                <input value="TLS · port 993" readOnly />
              </label>
            </div>
            <label>
              Incoming username
              <input
                autoComplete="off"
                value={settings.username}
                maxLength={200}
                onChange={(e) => setSettings({ ...settings, username: e.target.value })}
              />
            </label>
            <label>
              Incoming password or app password
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                maxLength={2000}
                disabled={clear}
                placeholder={
                  settings.has_password
                    ? 'Saved · leave blank to keep'
                    : 'Provider password or app password'
                }
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <small className="muted">
              Use an account with IMAP password access enabled by its provider. Accounts requiring
              OAuth are not supported by this connection.
            </small>
            <label>
              Mail folder
              <input
                value={settings.folder}
                maxLength={200}
                required
                onChange={(e) => setSettings({ ...settings, folder: e.target.value })}
              />
            </label>
            {settings.has_password && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={clear}
                  onChange={(e) => {
                    setClear(e.target.checked);
                    setPassword('');
                  }}
                />{' '}
                Remove saved incoming password
              </label>
            )}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
              />{' '}
              Enable automatic incoming sync every minute
            </label>
            <p className="muted">
              First sync imports the latest 20 messages. Further syncs collect new messages in
              batches. Reading here leaves the original mailbox unchanged.
            </p>
            {settings.last_sync && (
              <p className="muted">
                Last successful sync: {new Date(settings.last_sync).toLocaleString()}
              </p>
            )}
            {settings.last_error && <Alert>{settings.last_error}</Alert>}
            <div className="form-actions">
              <a className="button secondary" href="#mailbox">
                Open mailbox
              </a>
              <button
                className="button secondary"
                type="button"
                disabled={
                  !settings.enabled || JSON.stringify(settings) !== saved || !!password || clear
                }
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    const result = await api<{ received: number }>('/mailbox/sync', {
                      method: 'POST',
                    });
                    const current = await api<Settings>('/settings/incoming');
                    setSettings(current);
                    setSaved(JSON.stringify(current));
                    notify(`Connection verified. ${result.received} new messages received.`);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RefreshCw size={15} /> Verify & sync
              </button>
              <button className="button primary">
                {busy ? 'Working…' : 'Save incoming settings'}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}

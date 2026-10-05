import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, RefreshCw, Save, XCircle, Zap } from 'lucide-react';
import type { JevSettings as Settings } from '../shared/types';
import { cleanKey } from '../shared/ai-providers';
import { api, json } from './api';
import { Alert, Badge, Spinner } from './ui';
import './AiProviderSettings.css';

const notACredential = {
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;
const sources: Record<Settings['source'], string> = {
  saved: 'Saved here, encrypted.',
  environment: 'From OPENROUTER_API_KEY on the server.',
  chat: 'Using the saved OpenRouter key of the AI provider.',
  none: 'No Jev key yet.',
};

/**
 * Settings → Fast decisions. The OpenRouter key TypeSafe Jev uses for the fast lead decisions
 * and the import quick screen: saved encrypted, never shown again, and sent only to OpenRouter's
 * Decisions API.
 */
export function JevSettings({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [key, setKey] = useState(''),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<Settings>('/settings/jev')
      .then((data) => {
        if (!cancelled) setSettings(data);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function check() {
    setBusy('check');
    setError('');
    try {
      setSettings(await api<Settings>('/settings/jev/test', { method: 'POST', body: json({}) }));
      notify('Jev answered: fast decisions are ready.');
    } catch (e) {
      setError((e as Error).message);
      setSettings(await api<Settings>('/settings/jev').catch(() => settings));
    } finally {
      setBusy('');
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy('save');
    setError('');
    try {
      const saved = await api<Settings>('/settings/jev', {
        method: 'PUT',
        body: json({ api_key: cleanKey(key) }),
      });
      setSettings(saved);
      setKey('');
      notify('Jev key saved.');
      await check();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function clear() {
    setBusy('clear');
    setError('');
    try {
      setSettings(
        await api<Settings>('/settings/jev', { method: 'PUT', body: json({ clear_api_key: true }) }),
      );
      notify('Jev key removed.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const status = settings?.status;
  const typed = cleanKey(key);
  return (
    <section className="panel ai-provider">
      <div className="section-title">
        <h2>
          <Zap size={20} />
          Fast decisions (Jev)
        </h2>
        {settings && (
          <Badge value={!settings.has_key ? 'draft' : status?.ok ? 'ready' : status ? 'blocked' : 'draft'}>
            {!settings.has_key
              ? 'Not set up'
              : status?.ok
                ? 'Connected'
                : status
                  ? 'Not connected'
                  : 'Not checked yet'}
          </Badge>
        )}
      </div>
      <p className="muted">
        TypeSafe Jev judges a lead against every training rule in about a second, for a fast
        first decision on which leads to qualify in full, and it screens imported lists. It uses
        an OpenRouter key; the full, evidence-backed qualification still uses the AI provider
        above.
      </p>
      {error && <Alert>{error}</Alert>}
      {!settings ? (
        <Spinner text="Loading…" />
      ) : (
        <form className="form-stack" onSubmit={save} autoComplete="off">
          <label>
            OpenRouter key for Jev
            <input
              type="password"
              name="jev-api-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              maxLength={400}
              autoComplete="new-password"
              spellCheck={false}
              {...notACredential}
              placeholder={
                settings.has_key
                  ? 'Key ' + settings.key_preview + ' · paste a new key to replace it'
                  : 'sk-or-v1-…'
              }
            />
            <span className="ai-key-note">
              {typed && !typed.startsWith('sk-or-')
                ? 'A Jev key is an OpenRouter key: it starts with sk-or-.'
                : sources[settings.source] +
                  ' Model ' +
                  settings.model +
                  '. Sent only to OpenRouter’s Decisions API.'}
            </span>
          </label>
          <div className={'ai-connection' + (status ? (status.ok ? ' is-ok' : ' is-error') : '')} aria-live="polite">
            {busy === 'check' ? (
              <Spinner text="Asking Jev…" />
            ) : status ? (
              <>
                {status.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                <span>
                  {status.ok
                    ? 'Connected · answered in ' + status.latency_ms + ' ms'
                    : 'Not connected: ' + status.message}
                  <small> · checked {new Date(status.checked_at).toLocaleString()}</small>
                </span>
              </>
            ) : (
              <span>{settings.has_key ? 'Check the key to confirm Jev answers.' : 'Paste a key to turn on fast decisions.'}</span>
            )}
          </div>
          <div className="form-actions">
            <button className="button primary" disabled={!!busy || !typed || !typed.startsWith('sk-or-')}>
              {busy === 'save' ? (
                <Spinner text="Saving…" />
              ) : (
                <>
                  <Save size={16} />
                  Save and check
                </>
              )}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy || !settings.has_key}
              onClick={() => void check()}
            >
              <RefreshCw size={16} />
              Check
            </button>
            {settings.source === 'saved' && (
              <button
                type="button"
                className="button secondary"
                disabled={!!busy}
                onClick={() => void clear()}
              >
                Remove key
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

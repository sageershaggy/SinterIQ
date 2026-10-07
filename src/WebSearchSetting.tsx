import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import type { ResearchSearchSettings } from '../shared/research';
import { api, json } from './api';
import { Alert, Badge } from './ui';
import './WebSearchSetting.css';

/**
 * Settings → Fast decisions → "Use web search in research" (server/research-settings.ts). Lead
 * research searches the web for a company's official site, or a person's employer, through
 * OpenRouter's web plugin on the same OpenRouter key; each search is charged per result.
 */
export function WebSearchSetting({
  notify,
  keyChanged,
}: {
  notify: (message: string) => void;
  /** Changes when the Jev key is saved or removed, so the key line is read again. */
  keyChanged?: unknown;
}) {
  const [settings, setSettings] = useState<ResearchSearchSettings | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<ResearchSearchSettings>('/settings/research')
      .then((data) => {
        if (!cancelled) setSettings(data);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [keyChanged]);

  async function toggle(on: boolean) {
    setBusy(true);
    setError('');
    try {
      const saved = await api<ResearchSearchSettings>('/settings/research', {
        method: 'PUT',
        body: json({ web_search: on }),
      });
      setSettings(saved);
      notify(on ? 'Web search in research is on.' : 'Web search in research is off.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return error ? <Alert>{error}</Alert> : null;
  const state = settings.active ? 'On' : !settings.enabled ? 'Off' : 'Needs a key';
  return (
    <div className="web-search-setting">
      <label className="web-search-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={busy}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span className="web-search-text">
          <strong>
            <Globe size={15} aria-hidden="true" />
            Use web search in research
          </strong>
          <small>
            Finds a company’s official website, or a person’s employer, when the record has none.
            Every result is still opened and checked before anything is saved.
          </small>
        </span>
        <Badge value={settings.active ? 'ready' : 'draft'}>{state}</Badge>
      </label>
      <p className="web-search-cost">
        Cost: OpenRouter’s web plugin is charged per result (up to {settings.max_results} per
        search), on the OpenRouter key above.
        {settings.enabled && !settings.has_key && ' Add the key to start searching.'}
      </p>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

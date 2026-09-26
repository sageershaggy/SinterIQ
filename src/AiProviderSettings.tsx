import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, PlugZap, RefreshCw, Save, XCircle } from 'lucide-react';
import type { Settings as AiSettings } from '../shared/types';
import {
  cleanKey,
  presetInfo,
  presetsForKey,
  providerPresets,
  type ConnectionStatus,
  type ProviderDetection,
  type ProviderModel,
  type ProviderPreset,
} from '../shared/ai-providers';
import { api, json } from './api';
import { Alert, Badge, Spinner } from './ui';
import './AiProviderSettings.css';

/** Attributes that keep password managers from treating the key as a site password. */
const notACredential = {
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;
const OTHER_MODEL = '__other__';

function ago(value: string) {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' h ago';
  return new Date(value).toLocaleDateString();
}

type Connection =
  | { state: 'idle' }
  | { state: 'connecting'; label: string }
  | { state: 'done'; status: ConnectionStatus };

/**
 * Settings → AI provider. Paste a key and the provider is recognised from it, its models are
 * listed and a good one is chosen; saving connects straight away and says whether it worked.
 * Every error is shown here, beside the fields that caused it.
 */
export function AiProviderSettings({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<AiSettings | null>(null),
    [preset, setPreset] = useState<ProviderPreset>('gemini'),
    [baseUrl, setBaseUrl] = useState(''),
    [model, setModel] = useState(''),
    [customModel, setCustomModel] = useState(false),
    [key, setKey] = useState(''),
    [clearKey, setClearKey] = useState(false),
    [models, setModels] = useState<ProviderModel[]>([]),
    [detect, setDetect] = useState<
      { state: 'idle' } | { state: 'checking' } | { state: 'found'; text: string } | { state: 'error'; text: string }
    >({ state: 'idle' }),
    [connection, setConnection] = useState<Connection>({ state: 'idle' }),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [jev, setJev] = useState('');
  const detectRun = useRef(0);

  function adopt(data: AiSettings) {
    setSettings(data);
    setPreset(data.preset);
    setBaseUrl(data.preset === 'custom' ? data.base_url : presetInfo(data.preset).base_url);
    setModel(data.model);
    setConnection(data.status ? { state: 'done', status: data.status } : { state: 'idle' });
  }
  function applyDetection(found: ProviderDetection, announce: boolean) {
    setPreset(found.preset);
    if (found.preset === 'custom') setBaseUrl(found.base_url);
    else setBaseUrl(presetInfo(found.preset).base_url);
    setModels(found.models);
    const keep = found.models.some((item) => item.id === model) && found.preset === preset;
    const chosen = keep ? model : found.recommended;
    setModel(chosen);
    setCustomModel(!found.models.some((item) => item.id === chosen) && !!found.models.length);
    const open = found.models.filter((item) => item.open).length;
    if (announce)
      setDetect({
        state: 'found',
        text:
          'Recognised: ' +
          presetInfo(found.preset).label +
          (found.verified
            ? ' · ' +
              found.models.length +
              ' model' +
              (found.models.length === 1 ? '' : 's') +
              (open ? ' (' + open + ' open)' : '')
            : ' · it does not list models, so the recommended ones are shown') +
          ' · ' +
          chosen +
          ' selected.',
      });
  }

  useEffect(() => {
    let cancelled = false;
    api<AiSettings>('/settings/llm')
      .then((data) => {
        if (cancelled) return;
        adopt(data);
        // The saved key's models, for the model list; quietly skipped if it cannot be read.
        if (data.has_api_key && data.source === 'database')
          api<ProviderDetection>('/settings/llm/detect', { method: 'POST', body: json({}) })
            .then((found) => {
              if (!cancelled) {
                setModels(found.models);
                setCustomModel(!found.models.some((item) => item.id === data.model));
              }
            })
            .catch(() => undefined);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Checks a typed key (or the saved one for its own provider) and fills in provider and model. */
  async function runDetect(options: { key: string; preset?: ProviderPreset; base?: string }) {
    const run = ++detectRun.current;
    setDetect({ state: 'checking' });
    try {
      const found = await api<ProviderDetection>('/settings/llm/detect', {
        method: 'POST',
        body: json({
          api_key: options.key || undefined,
          preset: options.preset,
          base_url: options.preset === 'custom' ? options.base : undefined,
        }),
      });
      if (run === detectRun.current) applyDetection(found, true);
    } catch (e) {
      if (run === detectRun.current) setDetect({ state: 'error', text: (e as Error).message });
    }
  }
  // Typing or pasting a key recognises it once the typing pauses.
  useEffect(() => {
    const typed = cleanKey(key);
    if (typed.length < 20) {
      if (!typed) setDetect({ state: 'idle' });
      return;
    }
    const timer = setTimeout(() => void runDetect({ key: typed }), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function choosePreset(next: ProviderPreset) {
    setPreset(next);
    setBaseUrl(next === 'custom' ? '' : presetInfo(next).base_url);
    setModels([]);
    const first = presetInfo(next).recommended[0] || '';
    setModel(next === settings?.preset ? settings.model : first);
    setCustomModel(!first);
    setDetect({ state: 'idle' });
    // The typed key stays; it is checked against the provider just chosen.
    const typed = cleanKey(key);
    if (typed && next !== 'custom') void runDetect({ key: typed, preset: next });
    else if (!typed && settings?.has_api_key && next === settings.preset && next !== 'custom')
      void runDetect({ key: '', preset: next });
  }

  async function check(label: string) {
    setConnection({ state: 'connecting', label });
    try {
      const result = await api<{ status: ConnectionStatus | null; model: string; latency_ms: number }>(
        '/settings/llm/test',
        { method: 'POST', body: json({ mode: 'chat' }) },
      );
      const status = result.status || {
        ok: true,
        message: 'Connected',
        model: result.model,
        latency_ms: result.latency_ms,
        checked_at: new Date().toISOString(),
      };
      setConnection({ state: 'done', status });
      notify('Connected to ' + presetInfo(preset).label + ' · ' + status.model + '.');
    } catch (e) {
      setConnection({
        state: 'done',
        status: {
          ok: false,
          message: (e as Error).message,
          model,
          latency_ms: null,
          checked_at: new Date().toISOString(),
        },
      });
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy('save');
    setError('');
    const info = presetInfo(preset);
    try {
      const saved = await api<AiSettings>('/settings/llm', {
        method: 'PUT',
        body: json({
          provider: info.provider,
          preset,
          model: model.trim(),
          base_url: preset === 'custom' ? baseUrl.trim() : info.base_url,
          api_key: cleanKey(key),
          clear_api_key: clearKey,
        }),
      });
      adopt(saved);
      setKey('');
      setClearKey(false);
      setDetect({ state: 'idle' });
      notify('AI provider saved.');
      if (saved.has_api_key) await check('Connecting to ' + info.label + ' · ' + saved.model + '…');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function testJev() {
    setBusy('jev');
    setError('');
    setJev('');
    try {
      const res = await api<{
        model: string;
        latency_ms: number;
        answers?: Record<string, { type: string; noul?: number }>;
      }>('/settings/llm/test', {
        method: 'POST',
        body: json({
          provider: 'openai_compatible',
          model: 'typesafe/jev-1.13',
          base_url: 'https://openrouter.ai/api/v1',
          api_key: cleanKey(key) || undefined,
          mode: 'decisions',
        }),
      });
      const noul = res.answers?.ok?.type === 'noul' ? res.answers.ok.noul : undefined;
      setJev(
        'Jev decision OK via ' +
          res.model +
          ' (' +
          res.latency_ms +
          ' ms)' +
          (noul !== undefined ? ' · health ' + noul.toFixed(2) : ''),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const info = presetInfo(preset);
  const typed = cleanKey(key);
  const guessed = typed ? presetsForKey(typed) : [];
  const keyForOtherProvider =
    !!settings?.has_api_key && !typed && !clearKey && settings.preset !== preset;
  const status =
    connection.state === 'done' ? connection.status : null;
  const badge =
    connection.state === 'connecting'
      ? { value: 'draft', text: 'Connecting…' }
      : !settings?.has_api_key
        ? { value: 'draft', text: 'Setup required' }
        : status?.ok
          ? { value: 'ready', text: 'Connected' }
          : status
            ? { value: 'blocked', text: 'Not connected' }
            : { value: 'draft', text: 'Not checked yet' };
  const openGroup = providerPresets.filter((item) => item.open_models && item.id !== 'custom');
  const otherGroup = providerPresets.filter(
    (item) => !item.open_models && item.id !== 'gemini' && item.id !== 'openai',
  );

  return (
    <section className="panel ai-provider">
      <div className="section-title">
        <h2>
          <KeyRound size={20} />
          AI provider
        </h2>
        {settings && <Badge value={badge.value}>{badge.text}</Badge>}
      </div>
      <p className="muted">
        Training analysis, research and qualification use this provider. Paste a key and the
        provider and model are chosen for you; open-model providers such as OpenRouter, Groq,
        Together, Hugging Face and DeepSeek work too.
      </p>
      {error && <Alert>{error}</Alert>}
      {!settings ? (
        <Spinner text="Loading configuration…" />
      ) : (
        <form className="form-stack" onSubmit={save} autoComplete="off">
          <label>
            API key
            <input
              type="password"
              name="ai-provider-api-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              maxLength={1000}
              autoComplete="new-password"
              spellCheck={false}
              {...notACredential}
              placeholder={
                settings.has_api_key
                  ? 'Saved ' + presetInfo(settings.preset).label + ' key ' + settings.api_key_preview + ' · paste a new key to replace it'
                  : 'Paste a key from Google AI Studio, OpenAI, OpenRouter, Groq, Hugging Face…'
              }
            />
            <span className="ai-key-note" aria-live="polite">
              {detect.state === 'checking' ? (
                <Spinner text="Checking the key…" />
              ) : detect.state === 'found' ? (
                <span className="ai-note-ok">
                  <CheckCircle2 size={14} />
                  {detect.text}
                </span>
              ) : detect.state === 'error' ? (
                <span className="ai-note-error">
                  <XCircle size={14} />
                  {detect.text}
                </span>
              ) : typed && !guessed.length ? (
                'Choose the provider below; this key format is not one we recognise.'
              ) : settings.has_api_key ? (
                'Loaded from ' + settings.source + '. Saved keys are encrypted and never shown again.'
              ) : (
                'A provider key is required for AI analysis.'
              )}
            </span>
          </label>
          <div className="ai-provider-row">
            <label>
              Provider
              <select value={preset} onChange={(e) => choosePreset(e.target.value as ProviderPreset)}>
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI</option>
                <optgroup label="Open models">
                  {openGroup.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Other">
                  {otherGroup.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                  <option value="custom">Other OpenAI-compatible endpoint</option>
                </optgroup>
              </select>
            </label>
            <label>
              Model
              {models.length > 0 && !customModel ? (
                <select
                  value={model}
                  onChange={(e) => {
                    if (e.target.value === OTHER_MODEL) setCustomModel(true);
                    else setModel(e.target.value);
                  }}
                >
                  {models.map((item, index) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                      {index === 0 && info.recommended.includes(item.id) ? ' · recommended' : ''}
                      {item.open ? ' · open model' : ''}
                    </option>
                  ))}
                  <option value={OTHER_MODEL}>Other model ID…</option>
                </select>
              ) : (
                <input
                  name="ai-model-id"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  required
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                  {...notACredential}
                  placeholder={info.recommended[0] || 'model-id'}
                />
              )}
            </label>
          </div>
          {models.length > 0 && customModel && (
            <button type="button" className="text-button ai-model-back" onClick={() => setCustomModel(false)}>
              Choose from the {models.length} models this key offers
            </button>
          )}
          {preset === 'custom' ? (
            <label>
              API base URL
              <input
                type="url"
                name="ai-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                maxLength={2000}
                autoComplete="off"
                {...notACredential}
                placeholder="https://your-endpoint.example.com/v1"
              />
              <small>
                Any public HTTPS endpoint that speaks the OpenAI chat-completions API — a hosted
                open-model service or your own vLLM or Ollama server behind HTTPS.{' '}
                <button
                  type="button"
                  className="text-button"
                  disabled={!baseUrl || (!typed && !settings.has_api_key)}
                  onClick={() => void runDetect({ key: typed, preset: 'custom', base: baseUrl })}
                >
                  Load its models
                </button>
              </small>
            </label>
          ) : (
            info.provider === 'openai_compatible' && (
              <p className="fine-print ai-endpoint">
                Endpoint <code>{info.base_url}</code>
                {info.key_url && (
                  <>
                    {' · '}
                    <a href={info.key_url} target="_blank" rel="noreferrer">
                      Get your {info.label} key
                    </a>
                  </>
                )}
              </p>
            )
          )}
          {preset === 'gemini' && (
            <p className="fine-print ai-endpoint">
              <a href={info.key_url} target="_blank" rel="noreferrer">
                Get a Gemini key in Google AI Studio
              </a>
            </p>
          )}
          {keyForOtherProvider && (
            <p className="fine-print ai-warning">
              The saved key belongs to {presetInfo(settings.preset).label}. Paste a{' '}
              {info.label} key to switch; a saved key is never sent to another provider.
            </p>
          )}
          {settings.source === 'database' && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(e) => setClearKey(e.target.checked)}
              />
              Clear the saved key on save
            </label>
          )}

          <div className={'ai-connection' + (status ? (status.ok ? ' is-ok' : ' is-error') : '')} aria-live="polite">
            {connection.state === 'connecting' ? (
              <Spinner text={connection.label} />
            ) : status ? (
              <>
                {status.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                <span>
                  {status.ok
                    ? 'Connected to ' +
                      presetInfo(settings.preset).label +
                      ' · ' +
                      status.model +
                      (status.latency_ms !== null ? ' · ' + status.latency_ms + ' ms' : '')
                    : 'Not connected: ' + status.message}
                  <small> · checked {ago(status.checked_at)}</small>
                </span>
              </>
            ) : settings.has_api_key ? (
              <>
                <PlugZap size={16} />
                <span>Not checked yet. Check the connection to confirm the key and model work.</span>
              </>
            ) : (
              <>
                <PlugZap size={16} />
                <span>No key saved yet.</span>
              </>
            )}
          </div>
          {jev && <p className="fine-print ai-note-ok">{jev}</p>}

          <div className="form-actions">
            <button
              className="button primary"
              disabled={!!busy || connection.state === 'connecting' || !model.trim() || keyForOtherProvider}
            >
              {busy === 'save' ? (
                <Spinner text="Saving…" />
              ) : (
                <>
                  <Save size={16} />
                  Save and connect
                </>
              )}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy || connection.state === 'connecting' || !settings.has_api_key}
              onClick={() =>
                void check('Connecting to ' + presetInfo(settings.preset).label + ' · ' + settings.model + '…')
              }
              title="Checks the saved provider, model and key"
            >
              <RefreshCw size={16} />
              Check connection
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={() => void testJev()}
              title="Uses the key typed above, OPENROUTER_API_KEY on the server, or a saved OpenRouter key — never a Gemini key"
            >
              {busy === 'jev' ? <Spinner text="Testing Jev…" /> : 'Test Jev decision'}
            </button>
          </div>
          <p className="fine-print">
            Test Jev uses OpenRouter&apos;s Decisions API with <code>typesafe/jev-1.13</code>: paste
            an OpenRouter key above or set <code>OPENROUTER_API_KEY</code> on the server.
          </p>
        </form>
      )}
    </section>
  );
}

import React, { useEffect, useState } from 'react';
import { Bot, Save, Settings2 } from 'lucide-react';
import { LlmSettings } from './appTypes';

const defaultSettings: LlmSettings = {
  provider_type: 'gemini',
  provider_name: 'Gemini',
  model: 'gemini-2.5-flash',
  base_url: '',
  api_key: '',
  has_api_key: false,
  source: 'default',
  supports_web_search: true,
};

export default function SettingsTab() {
  const [settings, setSettings] = useState<LlmSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadSettings = async () => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/settings/llm');
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load settings');
      }

      setSettings({
        ...defaultSettings,
        ...payload,
      });
    } catch (loadError) {
      console.error(loadError);
      setError(loadError instanceof Error ? loadError.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
  }, []);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const response = await fetch('/api/settings/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to save settings');
      }

      setSettings((currentValue) => ({
        ...currentValue,
        ...payload,
        api_key: currentValue.api_key,
      }));
      setSuccess('LLM settings saved.');
    } catch (saveError) {
      console.error(saveError);
      setError(saveError instanceof Error ? saveError.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-500">Loading settings...</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">Configure which LLM powers research and qualification.</p>
      </div>

      <form onSubmit={handleSave} className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Settings2 className="w-5 h-5 text-blue-500" />
          <h2 className="text-lg font-semibold text-slate-900">LLM Provider</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Provider Type</label>
            <select
              value={settings.provider_type}
              onChange={(event) =>
                setSettings((currentValue) => ({
                  ...currentValue,
                  provider_type: event.target.value as LlmSettings['provider_type'],
                  provider_name: event.target.value === 'gemini' ? 'Gemini' : currentValue.provider_name,
                  base_url: event.target.value === 'gemini' ? '' : currentValue.base_url || 'https://api.openai.com/v1',
                }))
              }
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
            >
              <option value="gemini">Gemini</option>
              <option value="openai_compatible">OpenAI-Compatible</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Provider Name</label>
            <input
              type="text"
              value={settings.provider_name}
              onChange={(event) => setSettings({ ...settings, provider_name: event.target.value })}
              placeholder={settings.provider_type === 'gemini' ? 'Gemini' : 'OpenAI, Groq, Ollama, Together...'}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Model</label>
            <input
              type="text"
              value={settings.model}
              onChange={(event) => setSettings({ ...settings, model: event.target.value })}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          </div>

          {settings.provider_type === 'openai_compatible' && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Base URL</label>
              <input
                type="text"
                value={settings.base_url}
                onChange={(event) => setSettings({ ...settings, base_url: event.target.value })}
                placeholder="https://api.openai.com/v1"
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>
          )}

          <div className={settings.provider_type === 'gemini' ? 'md:col-span-2' : ''}>
            <label className="block text-sm font-medium text-slate-700 mb-1">API Key</label>
            <input
              type="password"
              value={settings.api_key}
              onChange={(event) => setSettings({ ...settings, api_key: event.target.value })}
              placeholder={settings.has_api_key ? 'Stored key present. Enter a new key to replace it.' : 'Paste API key'}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 space-y-2">
          <div className="flex items-center gap-2 text-slate-900 font-medium">
            <Bot className="w-4 h-4 text-indigo-500" />
            Active source: {settings.source}
          </div>
          <p>
            {settings.provider_type === 'gemini'
              ? 'Gemini uses built-in Google Search for research and qualification.'
              : 'OpenAI-compatible mode works with any chat-completions endpoint. Web search is not automatic in this mode, so results depend on the model and the fetched company website context.'}
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
            {success}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}

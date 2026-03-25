import React, { useEffect, useState } from 'react';
import { Bot, Save, Settings2, ExternalLink, CheckCircle2, Globe } from 'lucide-react';
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

interface ProviderPreset {
  name: string;
  type: 'gemini' | 'openai_compatible';
  provider_name: string;
  model: string;
  base_url: string;
  api_key_label: string;
  api_key_url: string;
  supports_web_search: boolean;
  badge?: string;
  description: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  // --- Google Gemini ---
  {
    name: 'Gemini 2.5 Flash',
    type: 'gemini',
    provider_name: 'Gemini',
    model: 'gemini-2.5-flash',
    base_url: '',
    api_key_label: 'Gemini API Key',
    api_key_url: 'https://aistudio.google.com/apikey',
    supports_web_search: true,
    badge: 'Recommended',
    description: 'Fast, cheap, web search grounding. Best for AI Qualify & Lead Research.',
  },
  {
    name: 'Gemini 2.5 Pro',
    type: 'gemini',
    provider_name: 'Gemini',
    model: 'gemini-2.5-pro',
    base_url: '',
    api_key_label: 'Gemini API Key',
    api_key_url: 'https://aistudio.google.com/apikey',
    supports_web_search: true,
    description: 'Most capable Gemini. Deep reasoning + web search. Higher cost.',
  },
  {
    name: 'Gemini 3.1 Pro',
    type: 'gemini',
    provider_name: 'Gemini',
    model: 'gemini-3.1-pro',
    base_url: '',
    api_key_label: 'Gemini API Key',
    api_key_url: 'https://aistudio.google.com/apikey',
    supports_web_search: true,
    badge: 'Latest',
    description: 'Latest Gemini 3.1 Pro. Best-in-class reasoning + web search grounding.',
  },
  {
    name: 'Gemini 3.1 Flash',
    type: 'gemini',
    provider_name: 'Gemini',
    model: 'gemini-3.1-flash',
    base_url: '',
    api_key_label: 'Gemini API Key',
    api_key_url: 'https://aistudio.google.com/apikey',
    supports_web_search: true,
    description: 'Latest Gemini 3.1 Flash. Ultra-fast + web search at lowest cost.',
  },
  // --- OpenAI ---
  {
    name: 'GPT-5.4 (OpenAI)',
    type: 'openai_compatible',
    provider_name: 'OpenAI',
    model: 'gpt-5.4',
    base_url: 'https://api.openai.com/v1',
    api_key_label: 'OpenAI API Key',
    api_key_url: 'https://platform.openai.com/api-keys',
    supports_web_search: false,
    badge: 'Latest',
    description: 'Latest GPT-5.4 — most capable OpenAI model for deep analysis.',
  },
  {
    name: 'GPT-5.4-mini (OpenAI)',
    type: 'openai_compatible',
    provider_name: 'OpenAI',
    model: 'gpt-5.4-mini',
    base_url: 'https://api.openai.com/v1',
    api_key_label: 'OpenAI API Key',
    api_key_url: 'https://platform.openai.com/api-keys',
    supports_web_search: false,
    description: 'Fast, cheap GPT-5.4-mini. Great for high-volume qualification.',
  },
  {
    name: 'GPT-4.1 (OpenAI)',
    type: 'openai_compatible',
    provider_name: 'OpenAI',
    model: 'gpt-4.1',
    base_url: 'https://api.openai.com/v1',
    api_key_label: 'OpenAI API Key',
    api_key_url: 'https://platform.openai.com/api-keys',
    supports_web_search: false,
    description: 'GPT-4.1 — proven, reliable for complex analysis.',
  },
  {
    name: 'GPT-4.1-mini (OpenAI)',
    type: 'openai_compatible',
    provider_name: 'OpenAI',
    model: 'gpt-4.1-mini',
    base_url: 'https://api.openai.com/v1',
    api_key_label: 'OpenAI API Key',
    api_key_url: 'https://platform.openai.com/api-keys',
    supports_web_search: false,
    description: 'Budget GPT-4.1-mini. Good balance of cost and quality.',
  },
  {
    name: 'o4-mini (OpenAI)',
    type: 'openai_compatible',
    provider_name: 'OpenAI',
    model: 'o4-mini',
    base_url: 'https://api.openai.com/v1',
    api_key_label: 'OpenAI API Key',
    api_key_url: 'https://platform.openai.com/api-keys',
    supports_web_search: false,
    description: 'OpenAI reasoning model. Step-by-step thinking for complex qualification.',
  },
  // --- Anthropic Claude ---
  {
    name: 'Claude Opus 4.7 (Anthropic)',
    type: 'openai_compatible',
    provider_name: 'Anthropic',
    model: 'claude-opus-4-7',
    base_url: 'https://api.anthropic.com/v1',
    api_key_label: 'Anthropic API Key',
    api_key_url: 'https://console.anthropic.com/settings/keys',
    supports_web_search: false,
    badge: 'Latest',
    description: 'Latest Claude Opus 4.7. Most capable Claude — premium reasoning & writing.',
  },
  {
    name: 'Claude Sonnet 4.7 (Anthropic)',
    type: 'openai_compatible',
    provider_name: 'Anthropic',
    model: 'claude-sonnet-4-7',
    base_url: 'https://api.anthropic.com/v1',
    api_key_label: 'Anthropic API Key',
    api_key_url: 'https://console.anthropic.com/settings/keys',
    supports_web_search: false,
    description: 'Latest Claude Sonnet 4.7. Best speed-to-quality ratio for sales scripts.',
  },
  {
    name: 'Claude Opus 4 (Anthropic)',
    type: 'openai_compatible',
    provider_name: 'Anthropic',
    model: 'claude-opus-4-0-20250514',
    base_url: 'https://api.anthropic.com/v1',
    api_key_label: 'Anthropic API Key',
    api_key_url: 'https://console.anthropic.com/settings/keys',
    supports_web_search: false,
    description: 'Claude Opus 4. Excellent reasoning, analysis & writing.',
  },
  {
    name: 'Claude Sonnet 4 (Anthropic)',
    type: 'openai_compatible',
    provider_name: 'Anthropic',
    model: 'claude-sonnet-4-0-20250514',
    base_url: 'https://api.anthropic.com/v1',
    api_key_label: 'Anthropic API Key',
    api_key_url: 'https://console.anthropic.com/settings/keys',
    supports_web_search: false,
    description: 'Claude Sonnet 4. Strong balance of speed & quality.',
  },
  {
    name: 'Claude Haiku 3.5 (Anthropic)',
    type: 'openai_compatible',
    provider_name: 'Anthropic',
    model: 'claude-3-5-haiku-20241022',
    base_url: 'https://api.anthropic.com/v1',
    api_key_label: 'Anthropic API Key',
    api_key_url: 'https://console.anthropic.com/settings/keys',
    supports_web_search: false,
    description: 'Fast & affordable Claude. Good for bulk qualification.',
  },
  // --- Meta / Groq ---
  {
    name: 'Llama 4 Maverick (Groq)',
    type: 'openai_compatible',
    provider_name: 'Groq',
    model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    base_url: 'https://api.groq.com/openai/v1',
    api_key_label: 'Groq API Key',
    api_key_url: 'https://console.groq.com/keys',
    supports_web_search: false,
    badge: 'Fast & Free',
    description: 'Latest Llama 4 Maverick 128 experts. Top open-source on Groq.',
  },
  {
    name: 'Llama 4 Scout (Groq)',
    type: 'openai_compatible',
    provider_name: 'Groq',
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    base_url: 'https://api.groq.com/openai/v1',
    api_key_label: 'Groq API Key',
    api_key_url: 'https://console.groq.com/keys',
    supports_web_search: false,
    description: 'Llama 4 Scout 16 experts. Fast inference, generous free tier.',
  },
  {
    name: 'Llama 3.3 70B (Groq)',
    type: 'openai_compatible',
    provider_name: 'Groq',
    model: 'llama-3.3-70b-versatile',
    base_url: 'https://api.groq.com/openai/v1',
    api_key_label: 'Groq API Key',
    api_key_url: 'https://console.groq.com/keys',
    supports_web_search: false,
    description: 'Proven Llama 3.3 70B. Reliable, free tier available.',
  },
  {
    name: 'DeepSeek R1 (Groq)',
    type: 'openai_compatible',
    provider_name: 'Groq',
    model: 'deepseek-r1-distill-llama-70b',
    base_url: 'https://api.groq.com/openai/v1',
    api_key_label: 'Groq API Key',
    api_key_url: 'https://console.groq.com/keys',
    supports_web_search: false,
    description: 'DeepSeek R1 distilled on Groq. Ultra-fast reasoning at no cost.',
  },
  // --- DeepSeek ---
  {
    name: 'DeepSeek V3 (0324)',
    type: 'openai_compatible',
    provider_name: 'DeepSeek',
    model: 'deepseek-chat',
    base_url: 'https://api.deepseek.com/v1',
    api_key_label: 'DeepSeek API Key',
    api_key_url: 'https://platform.deepseek.com/api_keys',
    supports_web_search: false,
    badge: 'Cost-efficient',
    description: 'Latest DeepSeek V3. Very cheap, strong reasoning for bulk tasks.',
  },
  {
    name: 'DeepSeek R1',
    type: 'openai_compatible',
    provider_name: 'DeepSeek',
    model: 'deepseek-reasoner',
    base_url: 'https://api.deepseek.com/v1',
    api_key_label: 'DeepSeek API Key',
    api_key_url: 'https://platform.deepseek.com/api_keys',
    supports_web_search: false,
    description: 'DeepSeek reasoning model. Chain-of-thought for complex qualification.',
  },
  // --- Mistral ---
  {
    name: 'Mistral Large (2025)',
    type: 'openai_compatible',
    provider_name: 'Mistral',
    model: 'mistral-large-latest',
    base_url: 'https://api.mistral.ai/v1',
    api_key_label: 'Mistral API Key',
    api_key_url: 'https://console.mistral.ai/api-keys',
    supports_web_search: false,
    description: 'Top Mistral model. Strong multilingual (German/Arabic/English).',
  },
  {
    name: 'Mistral Small (2025)',
    type: 'openai_compatible',
    provider_name: 'Mistral',
    model: 'mistral-small-latest',
    base_url: 'https://api.mistral.ai/v1',
    api_key_label: 'Mistral API Key',
    api_key_url: 'https://console.mistral.ai/api-keys',
    supports_web_search: false,
    description: 'Fast & cheap Mistral. Good for simple scoring and filtering.',
  },
  // --- xAI ---
  {
    name: 'Grok 3 (xAI)',
    type: 'openai_compatible',
    provider_name: 'xAI',
    model: 'grok-3',
    base_url: 'https://api.x.ai/v1',
    api_key_label: 'xAI API Key',
    api_key_url: 'https://console.x.ai',
    supports_web_search: false,
    description: 'xAI Grok 3. Strong reasoning, real-time knowledge from X/Twitter.',
  },
  {
    name: 'Grok 3 Mini (xAI)',
    type: 'openai_compatible',
    provider_name: 'xAI',
    model: 'grok-3-mini',
    base_url: 'https://api.x.ai/v1',
    api_key_label: 'xAI API Key',
    api_key_url: 'https://console.x.ai',
    supports_web_search: false,
    description: 'Lightweight Grok. Fast reasoning at lower cost.',
  },
  // --- Local / Self-hosted ---
  {
    name: 'Ollama (Local)',
    type: 'openai_compatible',
    provider_name: 'Ollama',
    model: 'llama3.2',
    base_url: 'http://localhost:11434/v1',
    api_key_label: 'API Key (leave blank for local)',
    api_key_url: 'https://ollama.com',
    supports_web_search: false,
    description: 'Run models locally — no data leaves your machine.',
  },
  {
    name: 'Custom / Other',
    type: 'openai_compatible',
    provider_name: '',
    model: '',
    base_url: '',
    api_key_label: 'API Key',
    api_key_url: '',
    supports_web_search: false,
    description: 'Any OpenAI-compatible endpoint (Together AI, Perplexity, LM Studio, vLLM, etc.).',
  },
];

export default function SettingsTab() {
  const [settings, setSettings] = useState<LlmSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [selectedPreset, setSelectedPreset] = useState<string>('Gemini');

  const loadSettings = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/settings/llm');
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || 'Failed to load settings');
      const loaded = { ...defaultSettings, ...payload };
      setSettings(loaded);
      // Try to match to a preset
      const match = PROVIDER_PRESETS.find(
        (p) => p.type === loaded.provider_type && (p.type === 'gemini' || p.base_url === loaded.base_url)
      );
      setSelectedPreset(match?.name || 'Custom / Other');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadSettings(); }, []);

  const applyPreset = (preset: ProviderPreset) => {
    setSelectedPreset(preset.name);
    setSettings((prev) => ({
      ...prev,
      provider_type: preset.type,
      provider_name: preset.provider_name || prev.provider_name,
      model: preset.model || prev.model,
      base_url: preset.base_url,
      api_key: '',
    }));
  };

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
      if (!response.ok) throw new Error(payload?.error || 'Failed to save settings');
      setSettings((prev) => ({ ...prev, ...payload, api_key: prev.api_key }));
      setSuccess('Settings saved successfully.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const currentPreset = PROVIDER_PRESETS.find((p) => p.name === selectedPreset);

  if (loading) return <div className="p-8 text-center text-slate-500">Loading settings...</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">Configure which AI model powers research, qualification, and sales scripts.</p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">

        {/* Provider Picker */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-blue-500" />
            <h2 className="text-lg font-semibold text-slate-900">Choose AI Provider</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {PROVIDER_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => applyPreset(preset)}
                className={`relative text-left p-3 rounded-xl border-2 transition-all ${
                  selectedPreset === preset.name
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                {preset.badge && (
                  <span className={`absolute top-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                    preset.badge === 'Recommended' ? 'bg-green-100 text-green-700' :
                    preset.badge === 'Fast & Free' ? 'bg-blue-100 text-blue-700' :
                    'bg-orange-100 text-orange-700'
                  }`}>{preset.badge}</span>
                )}
                <div className="font-semibold text-sm text-slate-900 mb-1 pr-16">{preset.name}</div>
                <div className="text-xs text-slate-500 leading-snug">{preset.description}</div>
                {preset.supports_web_search && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-green-600 font-medium">
                    <Globe className="w-3 h-3" /> Web search included
                  </div>
                )}
                {selectedPreset === preset.name && (
                  <CheckCircle2 className="absolute bottom-2 right-2 w-4 h-4 text-blue-500" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Configuration */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">Configuration</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Provider Name</label>
              <input
                type="text"
                value={settings.provider_name}
                onChange={(e) => setSettings({ ...settings, provider_name: e.target.value })}
                placeholder="e.g. Groq, Together AI, My Ollama"
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Model</label>
              <input
                type="text"
                value={settings.model}
                onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                placeholder="e.g. gemini-2.5-flash, gpt-4o, llama3.2"
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            {settings.provider_type === 'openai_compatible' && (
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Base URL</label>
                <input
                  type="text"
                  value={settings.base_url}
                  onChange={(e) => setSettings({ ...settings, base_url: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono text-xs"
                />
              </div>
            )}

            <div className="md:col-span-2">
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-slate-700">
                  {currentPreset?.api_key_label || 'API Key'}
                </label>
                {currentPreset?.api_key_url && (
                  <a
                    href={currentPreset.api_key_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-blue-600 hover:underline flex items-center gap-0.5"
                  >
                    Get API key <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
              <input
                type="password"
                value={settings.api_key}
                onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
                placeholder={settings.has_api_key ? 'Key stored. Enter new key to replace.' : 'Paste API key here'}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Status info */}
          <div className={`rounded-lg border p-4 text-sm space-y-2 ${
            settings.has_api_key ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
          }`}>
            <div className="flex items-center gap-2 font-medium text-slate-900">
              <Bot className="w-4 h-4 text-indigo-500" />
              <span>API Key: {settings.has_api_key
                ? <span className="text-green-700">Configured ({settings.source === 'environment' ? 'System .env' : settings.source === 'database' ? 'Saved in app' : settings.source})</span>
                : <span className="text-red-700">Not configured — AI features will not work</span>
              }</span>
              {settings.has_api_key && <CheckCircle2 className="w-4 h-4 text-green-500 ml-auto" />}
            </div>
            <p className="text-slate-600">
              {settings.provider_type === 'gemini'
                ? 'Gemini uses built-in Google Search for real-time web research during AI qualification.'
                : `OpenAI-compatible mode — web search not automatic. Works with ${settings.provider_name || 'any compatible endpoint'}.`
              }
            </p>
          </div>

          {/* System-level API key info */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm space-y-2">
            <div className="font-medium text-slate-800 flex items-center gap-2">
              <svg className="w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
              System-Level API Key (Server Admin)
            </div>
            <p className="text-slate-500 text-xs leading-relaxed">
              For production: set the API key as an environment variable instead of entering it in the UI. This keeps the key secure and applies to all team members automatically.
            </p>
            <div className="bg-white border border-slate-200 rounded-md p-3 font-mono text-xs text-slate-700 space-y-1">
              <div><span className="text-slate-400"># Create .env.local in project root:</span></div>
              <div>GEMINI_API_KEY=<span className="text-blue-600">your-gemini-key-here</span></div>
              <div className="text-slate-400 mt-2"># Or for OpenAI-compatible providers:</div>
              <div>LLM_API_KEY=<span className="text-blue-600">your-openai-key-here</span></div>
              <div>LLM_BASE_URL=<span className="text-blue-600">https://api.openai.com/v1</span></div>
              <div>LLM_MODEL=<span className="text-blue-600">gpt-4.1</span></div>
            </div>
            <p className="text-slate-400 text-xs">Restart the server after changing .env.local. System keys take precedence when no key is saved in the UI.</p>
          </div>
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
        {success && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">{success}</div>}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}

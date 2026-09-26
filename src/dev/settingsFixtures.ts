/**
 * Harness fixtures for Settings → AI provider. A pasted key starting "sk-or-" is recognised as
 * OpenRouter, "gsk_" as Groq, anything else as refused; the saved key is a Gemini key.
 */
const now = () => new Date().toISOString();
let saved = {
  provider: 'gemini',
  preset: 'gemini',
  model: 'gemini-2.5-flash',
  base_url: 'https://api.openai.com/v1',
  has_api_key: true,
  api_key_preview: '••••fc0f',
  source: 'database',
  status: {
    ok: true,
    message: 'Connected',
    model: 'gemini-2.5-flash',
    latency_ms: 412,
    checked_at: new Date(Date.now() - 6 * 60_000).toISOString(),
  } as null | Record<string, unknown>,
};
const geminiModels = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemma-3-27b-it'];
const detection = (preset: string, base_url: string, ids: string[], recommended: string) => ({
  preset,
  provider: preset === 'gemini' ? 'gemini' : 'openai_compatible',
  base_url,
  models: ids.map((id) => ({ id, open: /llama|qwen|deepseek|gemma|gpt-oss/i.test(id) })),
  recommended,
  verified: true,
});

export const settingsRoutes: Array<[RegExp, () => unknown]> = [
  [/^\/settings\/llm$/, () => saved],
  [/^\/users$/, () => []],
];

export const settingsWrites: Array<[string, RegExp, (body: unknown) => unknown]> = [
  [
    'POST',
    /^\/settings\/llm\/detect$/,
    (body) => {
      const key = String((body as { api_key?: string })?.api_key || '');
      if (!key) return detection('gemini', '', geminiModels, 'gemini-2.5-flash');
      if (key.startsWith('sk-or-'))
        return detection(
          'openrouter',
          'https://openrouter.ai/api/v1',
          [
            'google/gemini-2.5-flash',
            'openai/gpt-4.1-mini',
            'meta-llama/llama-3.3-70b-instruct',
            'deepseek/deepseek-chat-v3-0324',
            'qwen/qwen-2.5-72b-instruct',
            'anthropic/claude-sonnet-4',
          ],
          'google/gemini-2.5-flash',
        );
      if (key.startsWith('gsk_'))
        return detection(
          'groq',
          'https://api.groq.com/openai/v1',
          ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'],
          'llama-3.3-70b-versatile',
        );
      return { error: 'This key’s format is not one we recognise.' };
    },
  ],
  [
    'PUT',
    /^\/settings\/llm$/,
    (body) => {
      const input = body as { preset: string; provider: string; model: string; base_url: string; api_key: string };
      saved = {
        ...saved,
        preset: input.preset,
        provider: input.provider,
        model: input.model,
        base_url: input.base_url || saved.base_url,
        api_key_preview: input.api_key ? '••••' + input.api_key.slice(-4) : saved.api_key_preview,
        status: null,
      };
      return saved;
    },
  ],
  [
    'POST',
    /^\/settings\/llm\/test$/,
    () => {
      saved.status = { ok: true, message: 'Connected', model: saved.model, latency_ms: 388, checked_at: now() };
      return { ok: true, mode: 'chat', model: saved.model, latency_ms: 388, status: saved.status };
    },
  ],
];

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

/** Settings → Fast decisions (Jev), and the fast decisions themselves. */
let jev = {
  has_key: false,
  key_preview: '',
  source: 'none',
  model: 'typesafe/jev-1.13',
  status: null as null | Record<string, unknown>,
};
const rule = (text: string, call: string, p: number) => ({
  rule: text,
  call,
  probabilities:
    call === 'MEETS'
      ? { meets: p, does_not_meet: 0.05, unknown: 1 - p - 0.05 }
      : call === 'DOES_NOT_MEET'
        ? { meets: 0.05, does_not_meet: p, unknown: 1 - p - 0.05 }
        : { meets: 0.2, does_not_meet: 0.1, unknown: p },
});
export const harnessQuickDecision = () => ({
  verdict: 'LIKELY_QUALIFIED',
  score: 75,
  excluded_by: '',
  unknown_share: 0.25,
  overall: { level: 3, label: 'Probably a fit' },
  criteria: [
    rule('Business type is an SMB, startup, or growing e-commerce/service business.', 'MEETS', 0.91),
    rule('Company size is roughly 2–200 employees.', 'UNKNOWN', 0.71),
    rule('Has a clear need matching an Innovista service.', 'MEETS', 0.84),
    rule('Shows an evidenced website or digital gap.', 'MEETS', 0.77),
  ],
  exclusions: [
    rule('The company is permanently closed, dormant or no longer operating.', 'DOES_NOT_MEET', 0.93),
  ],
  website_read: true,
  model: 'typesafe/jev-1.13',
  latency_ms: 412,
  lead_revision: 3,
  training_version: 10,
  created_at: now(),
  created_by: 'Workspace Administrator',
  stale: false,
});
settingsRoutes.push([/^\/settings\/jev$/, () => jev]);
settingsWrites.push(
  [
    'PUT',
    /^\/settings\/jev$/,
    (body) => {
      const input = body as { api_key?: string; clear_api_key?: boolean };
      jev = input.clear_api_key
        ? { ...jev, has_key: false, key_preview: '', source: 'none', status: null }
        : input.api_key
          ? { ...jev, has_key: true, key_preview: '••••' + input.api_key.slice(-4), source: 'saved', status: null }
          : jev;
      return jev;
    },
  ],
  [
    'POST',
    /^\/settings\/jev\/test$/,
    () => {
      jev.status = { ok: true, message: 'Connected', latency_ms: 287, checked_at: now() };
      return jev;
    },
  ],
  ['POST', /^\/projects\/2\/leads\/\d+\/quick-decision$/, () => harnessQuickDecision()],
  [
    'POST',
    /^\/projects\/2\/quick-decisions$/,
    (body) => ({
      results: ((body as { lead_ids: number[] }).lead_ids || []).map((lead_id, index) => ({
        lead_id,
        decision: { ...harnessQuickDecision(), verdict: ['LIKELY_QUALIFIED', 'UNSURE', 'LIKELY_NOT'][index % 3] },
      })),
    }),
  ],
);

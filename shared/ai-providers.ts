/**
 * The AI providers Settings offers, and how a pasted key identifies one. Every provider except
 * Gemini speaks the OpenAI chat-completions protocol, so qualification only needs a base URL,
 * a model and a key; the preset is what the person picked or what their key identified.
 *
 * Several of these host open models (Llama, Qwen, DeepSeek, Gemma, gpt-oss, Mistral…), which is
 * how an account with an open-model provider is used here.
 */
export const providerPresetIds = [
  'gemini',
  'openai',
  'openrouter',
  'groq',
  'together',
  'huggingface',
  'deepseek',
  'mistral',
  'cerebras',
  'fireworks',
  'xai',
  'custom',
] as const;
export type ProviderPreset = (typeof providerPresetIds)[number];

export interface ProviderPresetInfo {
  id: ProviderPreset;
  label: string;
  provider: 'gemini' | 'openai_compatible';
  /** Empty for Gemini (its SDK knows the endpoint) and for a custom endpoint. */
  base_url: string;
  /** Hosts open models, so it belongs under "open models" in the provider list. */
  open_models: boolean;
  /** Where an administrator creates a key. */
  key_url: string;
  /** Preferred models in order; the first one the account actually offers is chosen. */
  recommended: string[];
}

export const providerPresets: ProviderPresetInfo[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    provider: 'gemini',
    base_url: '',
    open_models: false,
    key_url: 'https://aistudio.google.com/app/apikey',
    recommended: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai_compatible',
    base_url: 'https://api.openai.com/v1',
    open_models: false,
    key_url: 'https://platform.openai.com/api-keys',
    recommended: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openai_compatible',
    base_url: 'https://openrouter.ai/api/v1',
    open_models: true,
    key_url: 'https://openrouter.ai/keys',
    recommended: [
      'google/gemini-2.5-flash',
      'openai/gpt-4.1-mini',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat-v3-0324',
      'qwen/qwen-2.5-72b-instruct',
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    provider: 'openai_compatible',
    base_url: 'https://api.groq.com/openai/v1',
    open_models: true,
    key_url: 'https://console.groq.com/keys',
    recommended: [
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'qwen/qwen3-32b',
      'llama-3.1-8b-instant',
    ],
  },
  {
    id: 'together',
    label: 'Together AI',
    provider: 'openai_compatible',
    base_url: 'https://api.together.xyz/v1',
    open_models: true,
    key_url: 'https://api.together.ai/settings/api-keys',
    recommended: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-V3',
    ],
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    provider: 'openai_compatible',
    base_url: 'https://router.huggingface.co/v1',
    open_models: true,
    key_url: 'https://huggingface.co/settings/tokens',
    recommended: [
      'meta-llama/Llama-3.3-70B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'deepseek-ai/DeepSeek-V3-0324',
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'openai_compatible',
    base_url: 'https://api.deepseek.com/v1',
    open_models: true,
    key_url: 'https://platform.deepseek.com/api_keys',
    recommended: ['deepseek-chat'],
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    provider: 'openai_compatible',
    base_url: 'https://api.mistral.ai/v1',
    open_models: true,
    key_url: 'https://console.mistral.ai/api-keys',
    recommended: ['mistral-small-latest', 'mistral-large-latest', 'open-mistral-nemo'],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    provider: 'openai_compatible',
    base_url: 'https://api.cerebras.ai/v1',
    open_models: true,
    key_url: 'https://cloud.cerebras.ai',
    recommended: ['llama-3.3-70b', 'qwen-3-32b', 'llama3.1-8b'],
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    provider: 'openai_compatible',
    base_url: 'https://api.fireworks.ai/inference/v1',
    open_models: true,
    key_url: 'https://fireworks.ai/account/api-keys',
    recommended: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/deepseek-v3',
    ],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    provider: 'openai_compatible',
    base_url: 'https://api.x.ai/v1',
    open_models: false,
    key_url: 'https://console.x.ai',
    recommended: ['grok-3-mini', 'grok-3'],
  },
  {
    id: 'custom',
    label: 'Other OpenAI-compatible endpoint',
    provider: 'openai_compatible',
    base_url: '',
    open_models: true,
    key_url: '',
    recommended: [],
  },
];

export function presetInfo(id: ProviderPreset): ProviderPresetInfo {
  return providerPresets.find((preset) => preset.id === id)!;
}

/** The trimmed key a person meant: pasted keys often carry spaces or a line break. */
export const cleanKey = (key: string) => key.replace(/\s+/g, '');

/**
 * Which providers a key's format points to, most likely first. Formats are only a hint: the
 * server confirms by asking the provider, and a plain `sk-` key is tried against OpenAI and
 * DeepSeek in turn because both issue that shape.
 */
export function presetsForKey(raw: string): ProviderPreset[] {
  const key = cleanKey(raw);
  if (/^AIza[0-9A-Za-z_-]{30,}$/.test(key)) return ['gemini'];
  if (key.startsWith('sk-or-')) return ['openrouter'];
  if (key.startsWith('sk-ant-')) return [];
  if (key.startsWith('gsk_')) return ['groq'];
  if (key.startsWith('hf_')) return ['huggingface'];
  if (key.startsWith('xai-')) return ['xai'];
  if (key.startsWith('csk-')) return ['cerebras'];
  if (key.startsWith('fw_')) return ['fireworks'];
  if (key.startsWith('tgp_')) return ['together'];
  if (/^sk-(proj|svcacct|admin)-/.test(key)) return ['openai'];
  if (/^sk-[0-9a-f]{32}$/.test(key)) return ['deepseek', 'openai'];
  if (key.startsWith('sk-')) return ['openai', 'deepseek'];
  if (/^[0-9a-f]{64}$/.test(key)) return ['together'];
  if (/^[A-Za-z0-9]{32}$/.test(key)) return ['mistral'];
  return [];
}

/** Why a key could not be matched, in words an administrator can act on. */
export function unrecognisedKeyMessage(raw: string) {
  if (cleanKey(raw).startsWith('sk-ant-'))
    return 'Anthropic (Claude) keys cannot be used here yet. Use Google Gemini, OpenAI, OpenRouter or another listed provider — OpenRouter also offers Claude models.';
  return 'This key’s format is not one we recognise. Choose the provider from the list, then check the connection.';
}

/** Models that cannot answer a chat request (embeddings, speech, images, moderation…). */
const notChat =
  /(embed|tts|whisper|dall-?e|image|imagen|veo|moderation|audio|realtime|transcribe|speech|rerank|guard|aqa|babbage|davinci|text-similarity|search-preview|computer-use|learnlm)/i;
export const isChatModel = (id: string) => !notChat.test(id);

/** Families published with open weights, marked so an open-model account is easy to use. */
const openFamilies =
  /(llama|qwen|deepseek|gemma|gpt-oss|mixtral|open-mistral|mistral-nemo|mistral-7b|phi-?[34]|olmo|falcon|nemotron|hermes)/i;
export const isOpenModel = (id: string) => openFamilies.test(id);

/** The first recommended model the account offers, else its first chat model. */
export function pickModel(preset: ProviderPreset, available: string[]): string {
  const offered = new Set(available);
  const recommended = presetInfo(preset).recommended;
  return (
    recommended.find((model) => offered.has(model)) ||
    available[0] ||
    recommended[0] ||
    ''
  );
}

/** A model the provider offers, as the settings screen lists it. */
export interface ProviderModel {
  id: string;
  open: boolean;
}
/** What checking a key against a provider found. */
export interface ProviderDetection {
  preset: ProviderPreset;
  provider: 'gemini' | 'openai_compatible';
  base_url: string;
  models: ProviderModel[];
  recommended: string;
  /** False when the provider does not list models, so the key itself is not yet proven. */
  verified: boolean;
}
/** The last connection check of the saved configuration. */
export interface ConnectionStatus {
  ok: boolean;
  message: string;
  model: string;
  latency_ms: number | null;
  checked_at: string;
}

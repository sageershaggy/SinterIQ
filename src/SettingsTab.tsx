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
  // --- OpenRouter ---
  {
    name: 'OpenRouter Auto',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'openrouter/auto',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    badge: 'Flexible',
    description: 'One OpenRouter key for many models. Router picks a suitable model automatically.',
  },
  {
    name: 'OpenRouter DeepSeek V4 Flash',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'deepseek/deepseek-v4-flash',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    badge: 'Cost-efficient',
    description: 'DeepSeek V4 Flash through OpenRouter. Fast long-context reasoning for bulk qualification.',
  },
  {
    name: 'OpenRouter DeepSeek V4 Pro',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'deepseek/deepseek-v4-pro',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    description: 'DeepSeek V4 Pro through OpenRouter for higher-quality complex lead analysis.',
  },
  {
    name: 'OpenRouter Kimi K2.6',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'moonshotai/kimi-k2.6',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    badge: 'Latest',
    description: 'Kimi K2.6 through OpenRouter. Strong agentic writing and long-horizon analysis.',
  },
  {
    name: 'OpenRouter GLM 4.7',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'z-ai/glm-4.7',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    description: 'Z.AI GLM 4.7 through OpenRouter. Strong reasoning, coding, and structured writing.',
  },
  {
    name: 'OpenRouter GLM 5.1',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'z-ai/glm-5.1',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    badge: 'Latest',
    description: 'Z.AI GLM 5.1 through OpenRouter. Current GLM option for deeper analysis.',
  },
  {
    name: 'OpenRouter Gemma 4 Free',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'google/gemma-4-26b-a4b-it:free',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    badge: 'Open Source',
    description: 'Google Gemma open model through OpenRouter. Free endpoint when available.',
  },
  {
    name: 'OpenRouter Ling 2.6 Flash Free',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'inclusionai/ling-2.6-flash:free',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    badge: 'Open Source',
    description: 'Fast open model option through OpenRouter. Useful for low-cost testing.',
  },
  {
    name: 'OpenRouter Qwen3.6 Plus',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'qwen/qwen3.6-plus',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    badge: 'Latest',
    description: 'Qwen3.6 Plus through OpenRouter. Large-context reasoning and agentic analysis.',
  },
  {
    name: 'OpenRouter Qwen3 Coder Next',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'qwen/qwen3-coder-next',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    badge: 'Open Source',
    description: 'Open-weight Qwen coding model through OpenRouter. Strong for structured and technical tasks.',
  },
  {
    name: 'OpenRouter Qwen3 Next 80B Free',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'qwen/qwen3-next-80b-a3b-instruct:free',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    badge: 'Open Source',
    description: 'Free Qwen3 Next 80B instruct route through OpenRouter when capacity is available.',
  },
  {
    name: 'OpenRouter Qwen3 235B Instruct',
    type: 'openai_compatible',
    provider_name: 'OpenRouter',
    model: 'qwen/qwen3-235b-a22b-instruct-2507',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_label: 'OpenRouter API Key',
    api_key_url: 'https://openrouter.ai/keys',
    supports_web_search: false,
    badge: 'Open Source',
    description: 'Large open-weight Qwen MoE model through OpenRouter for high-quality reasoning.',
  },
  // --- Qwen / Alibaba Model Studio ---
  {
    name: 'Qwen Plus Latest',
    type: 'openai_compatible',
    provider_name: 'Qwen',
    model: 'qwen-plus-latest',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    api_key_label: 'Alibaba Model Studio API Key',
    api_key_url: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
    supports_web_search: false,
    badge: 'Balanced',
    description: 'Direct Qwen Plus via Alibaba Model Studio. Good default for analysis and writing.',
  },
  {
    name: 'Qwen Flash',
    type: 'openai_compatible',
    provider_name: 'Qwen',
    model: 'qwen-flash',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    api_key_label: 'Alibaba Model Studio API Key',
    api_key_url: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
    supports_web_search: false,
    badge: 'Fast',
    description: 'Direct Qwen Flash. Lower-cost option for high-volume qualification.',
  },
  {
    name: 'Qwen3 Max',
    type: 'openai_compatible',
    provider_name: 'Qwen',
    model: 'qwen3-max',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    api_key_label: 'Alibaba Model Studio API Key',
    api_key_url: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
    supports_web_search: false,
    badge: 'Latest',
    description: 'Direct Qwen flagship model for harder reasoning and strategic lead analysis.',
  },
  {
    name: 'Qwen3 Coder Plus',
    type: 'openai_compatible',
    provider_name: 'Qwen',
    model: 'qwen3-coder-plus',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    api_key_label: 'Alibaba Model Studio API Key',
    api_key_url: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
    supports_web_search: false,
    description: 'Direct Qwen coder model. Useful for technical decomposition and structured outputs.',
  },
  {
    name: 'Qwen3 Next 80B Instruct',
    type: 'openai_compatible',
    provider_name: 'Qwen',
    model: 'qwen3-next-80b-a3b-instruct',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    api_key_label: 'Alibaba Model Studio API Key',
    api_key_url: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
    supports_web_search: false,
    badge: 'Open Source',
    description: 'Direct open Qwen model through Alibaba Model Studio. Stable long-context instruction following.',
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
    name: 'DeepSeek V4 Flash',
    type: 'openai_compatible',
    provider_name: 'DeepSeek',
    model: 'deepseek-v4-flash',
    base_url: 'https://api.deepseek.com',
    api_key_label: 'DeepSeek API Key',
    api_key_url: 'https://platform.deepseek.com/api_keys',
    supports_web_search: false,
    badge: 'Cost-efficient',
    description: 'Current DeepSeek V4 Flash. Very low cost, long context, strong bulk qualification.',
  },
  {
    name: 'DeepSeek V4 Pro',
    type: 'openai_compatible',
    provider_name: 'DeepSeek',
    model: 'deepseek-v4-pro',
    base_url: 'https://api.deepseek.com',
    api_key_label: 'DeepSeek API Key',
    api_key_url: 'https://platform.deepseek.com/api_keys',
    supports_web_search: false,
    description: 'Current DeepSeek V4 Pro. Better quality for complex strategic lead scoring.',
  },
  {
    name: 'DeepSeek Chat (Legacy)',
    type: 'openai_compatible',
    provider_name: 'DeepSeek',
    model: 'deepseek-chat',
    base_url: 'https://api.deepseek.com',
    api_key_label: 'DeepSeek API Key',
    api_key_url: 'https://platform.deepseek.com/api_keys',
    supports_web_search: false,
    description: 'Legacy DeepSeek chat alias. Kept for accounts still using old model names.',
  },
  {
    name: 'DeepSeek Reasoner (Legacy)',
    type: 'openai_compatible',
    provider_name: 'DeepSeek',
    model: 'deepseek-reasoner',
    base_url: 'https://api.deepseek.com',
    api_key_label: 'DeepSeek API Key',
    api_key_url: 'https://platform.deepseek.com/api_keys',
    supports_web_search: false,
    description: 'Legacy DeepSeek reasoning alias. Use V4 Flash/Pro for new setups.',
  },
  // --- Kimi / Moonshot ---
  {
    name: 'Kimi K2.6',
    type: 'openai_compatible',
    provider_name: 'Kimi',
    model: 'kimi-k2.6',
    base_url: 'https://api.moonshot.ai/v1',
    api_key_label: 'Kimi API Key',
    api_key_url: 'https://platform.kimi.ai',
    supports_web_search: false,
    badge: 'Latest',
    description: 'Latest Kimi direct API. Strong agentic writing, coding, and long-horizon analysis.',
  },
  {
    name: 'Kimi K2.5',
    type: 'openai_compatible',
    provider_name: 'Kimi',
    model: 'kimi-k2.5',
    base_url: 'https://api.moonshot.ai/v1',
    api_key_label: 'Kimi API Key',
    api_key_url: 'https://platform.kimi.ai',
    supports_web_search: false,
    description: 'Kimi K2.5 direct API. Good for multilingual sales writing and structured analysis.',
  },
  // --- Z.AI / GLM ---
  {
    name: 'GLM 5.1 (Z.AI)',
    type: 'openai_compatible',
    provider_name: 'Z.AI',
    model: 'glm-5.1',
    base_url: 'https://api.z.ai/api/paas/v4',
    api_key_label: 'Z.AI API Key',
    api_key_url: 'https://docs.z.ai',
    supports_web_search: false,
    badge: 'Latest',
    description: 'Latest GLM direct API. Strong general reasoning and multilingual analysis.',
  },
  {
    name: 'GLM 4.7 (Z.AI)',
    type: 'openai_compatible',
    provider_name: 'Z.AI',
    model: 'glm-4.7',
    base_url: 'https://api.z.ai/api/paas/v4',
    api_key_label: 'Z.AI API Key',
    api_key_url: 'https://docs.z.ai',
    supports_web_search: false,
    description: 'GLM 4.7 direct API. Good for reasoning, coding-style decomposition, and polished writing.',
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

interface ProviderGroup {
  api_key_label: string;
  api_key_url: string;
  badge?: string;
  base_url: string;
  description: string;
  key: string;
  presets: ProviderPreset[];
  provider_name: string;
  supports_web_search: boolean;
  title: string;
  type: 'gemini' | 'openai_compatible';
}

const PROVIDER_GROUP_META: Record<string, { badge?: string; description: string; title: string }> = {
  gemini: {
    badge: 'Web search',
    title: 'Gemini',
    description: 'Google Gemini models with built-in search grounding for research-heavy qualification.',
  },
  openrouter: {
    badge: 'Many models',
    title: 'OpenRouter',
    description: 'One API key for DeepSeek, Kimi, GLM, Qwen, Gemma, Claude, and other routed models.',
  },
  qwen: {
    badge: 'Open model',
    title: 'Qwen / Alibaba',
    description: 'Direct Qwen models through Alibaba Cloud Model Studio using an OpenAI-compatible API.',
  },
  deepseek: {
    badge: 'Open model',
    title: 'DeepSeek',
    description: 'Direct DeepSeek API for cost-efficient long-context analysis.',
  },
  kimi: {
    badge: 'Open model',
    title: 'Kimi / Moonshot',
    description: 'Direct Kimi API for multilingual writing, coding, and long-context reasoning.',
  },
  zai: {
    badge: 'Open model',
    title: 'GLM / Z.AI',
    description: 'Direct GLM API for reasoning, structured writing, and multilingual analysis.',
  },
  groq: {
    badge: 'Fast open models',
    title: 'Groq',
    description: 'Very fast hosted open models such as Llama and DeepSeek distill.',
  },
  mistral: {
    badge: 'Open model',
    title: 'Mistral',
    description: 'European hosted models with strong multilingual performance.',
  },
  ollama: {
    badge: 'Local',
    title: 'Ollama',
    description: 'Run open models locally when you want data to stay on this machine.',
  },
  openai: {
    title: 'OpenAI',
    description: 'OpenAI-compatible API for GPT models.',
  },
  anthropic: {
    title: 'Anthropic',
    description: 'Claude models. Prefer OpenRouter Claude routes unless your endpoint is OpenAI-compatible.',
  },
  xai: {
    title: 'xAI',
    description: 'Grok models through an OpenAI-compatible endpoint.',
  },
  custom: {
    title: 'Custom / Other',
    description: 'Any OpenAI-compatible endpoint, including Together AI, Fireworks, LM Studio, or vLLM.',
  },
};

const PROVIDER_GROUP_ORDER = [
  'gemini',
  'openrouter',
  'qwen',
  'deepseek',
  'kimi',
  'zai',
  'groq',
  'mistral',
  'ollama',
  'openai',
  'anthropic',
  'xai',
  'custom',
];

function getProviderKey(preset: ProviderPreset) {
  const providerName = preset.provider_name.toLowerCase();
  if (preset.type === 'gemini' || providerName.includes('gemini')) return 'gemini';
  if (providerName.includes('openrouter')) return 'openrouter';
  if (providerName.includes('qwen') || providerName.includes('alibaba')) return 'qwen';
  if (providerName.includes('deepseek')) return 'deepseek';
  if (providerName.includes('kimi') || providerName.includes('moonshot')) return 'kimi';
  if (providerName.includes('z.ai') || providerName.includes('zhipu')) return 'zai';
  if (providerName.includes('groq')) return 'groq';
  if (providerName.includes('mistral')) return 'mistral';
  if (providerName.includes('ollama')) return 'ollama';
  if (providerName.includes('openai')) return 'openai';
  if (providerName.includes('anthropic')) return 'anthropic';
  if (providerName.includes('xai')) return 'xai';
  return 'custom';
}

const PROVIDER_GROUPS = PROVIDER_PRESETS.reduce<Record<string, ProviderGroup>>((groups, preset) => {
  const key = getProviderKey(preset);
  const meta = PROVIDER_GROUP_META[key] || PROVIDER_GROUP_META.custom;

  if (!groups[key]) {
    groups[key] = {
      api_key_label: preset.api_key_label,
      api_key_url: preset.api_key_url,
      badge: meta.badge || preset.badge,
      base_url: preset.base_url,
      description: meta.description,
      key,
      presets: [],
      provider_name: preset.provider_name,
      supports_web_search: preset.supports_web_search,
      title: meta.title,
      type: preset.type,
    };
  }

  groups[key].presets.push(preset);
  groups[key].supports_web_search = groups[key].supports_web_search || preset.supports_web_search;

  return groups;
}, {});

const ORDERED_PROVIDER_GROUPS = Object.values(PROVIDER_GROUPS).sort((a, b) => {
  const aIndex = PROVIDER_GROUP_ORDER.indexOf(a.key);
  const bIndex = PROVIDER_GROUP_ORDER.indexOf(b.key);
  return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
});

export default function SettingsTab() {
  const [settings, setSettings] = useState<LlmSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [selectedPreset, setSelectedPreset] = useState<string>('Gemini 2.5 Flash');
  const [selectedProviderKey, setSelectedProviderKey] = useState<string>('gemini');

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
        (p) =>
          p.type === loaded.provider_type &&
          p.model === loaded.model &&
          (p.type === 'gemini' || p.base_url === loaded.base_url),
      ) || PROVIDER_PRESETS.find(
        (p) => p.type === loaded.provider_type && (p.type === 'gemini' || p.base_url === loaded.base_url),
      );
      setSelectedPreset(match?.name || 'Custom / Other');
      if (match) {
        setSelectedProviderKey(getProviderKey(match));
      } else {
        setSelectedProviderKey('custom');
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadSettings(); }, []);

  const applyPreset = (preset: ProviderPreset) => {
    setSelectedPreset(preset.name);
    setSelectedProviderKey(getProviderKey(preset));
    setSettings((prev) => ({
      ...prev,
      provider_type: preset.type,
      provider_name: preset.provider_name || prev.provider_name,
      model: preset.model || prev.model,
      base_url: preset.base_url,
      api_key: '',
    }));
  };

  const applyProviderGroup = (provider: ProviderGroup) => {
    const currentProviderPreset = provider.presets.find((preset) => preset.name === selectedPreset);
    applyPreset(currentProviderPreset || provider.presets[0]);
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
  const currentProvider = ORDERED_PROVIDER_GROUPS.find((provider) => provider.key === selectedProviderKey);

  if (loading) return <div className="p-8 text-center text-slate-500">Loading settings...</div>;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">Configure the intelligence layer for research, qualification, and sales scripts.</p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">

        {/* Provider Picker */}
        <div className="sinter-card rounded-lg p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Settings2 className="w-5 h-5 text-blue-500" />
              <h2 className="text-lg font-semibold text-slate-900">Choose AI Organization</h2>
            </div>
            <div className="text-xs text-slate-500">Select provider, then model</div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {ORDERED_PROVIDER_GROUPS.map((provider) => {
              const isSelected = selectedProviderKey === provider.key;
              const selectedModel = provider.presets.find((preset) => preset.name === selectedPreset) || provider.presets[0];
              const providerBadge = provider.badge || selectedModel.badge;

              return (
                <div
                  key={provider.key}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  onClick={() => applyProviderGroup(provider)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      applyProviderGroup(provider);
                    }
                  }}
                  className={`relative text-left p-4 rounded-lg transition-all min-h-[186px] cursor-pointer ${
                    isSelected ? 'sinter-provider-card-selected' : 'sinter-provider-card'
                  }`}
                >
                  {providerBadge && (
                    <span className={`absolute top-3 right-3 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      providerBadge === 'Web search' || providerBadge === 'Recommended' ? 'bg-green-100 text-green-700' :
                      providerBadge === 'Fast & Free' || providerBadge === 'Fast open models' ? 'bg-blue-100 text-blue-700' :
                      providerBadge === 'Open Source' || providerBadge === 'Open model' ? 'bg-emerald-100 text-emerald-700' :
                      'bg-orange-100 text-orange-700'
                    }`}>{providerBadge}</span>
                  )}

                  <div className="pr-24">
                    <div className="font-semibold text-base text-slate-900 mb-1">{provider.title}</div>
                    <div className="text-xs text-slate-500 leading-snug min-h-[34px]">{provider.description}</div>
                  </div>

                  <div className="mt-4">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Model</label>
                    <select
                      value={selectedModel.name}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        event.stopPropagation();
                        const nextPreset = provider.presets.find((preset) => preset.name === event.target.value);
                        if (nextPreset) applyPreset(nextPreset);
                      }}
                      className="sinter-select w-full text-slate-700 px-3 py-2 rounded-md text-sm outline-none"
                    >
                      {provider.presets.map((preset) => (
                        <option key={preset.name} value={preset.name}>{preset.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    {provider.supports_web_search ? (
                      <div className="flex items-center gap-1 text-xs text-green-600 font-medium">
                        <Globe className="w-3 h-3" /> Web search included
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400">{provider.type === 'openai_compatible' ? 'OpenAI-compatible API' : 'Native API'}</div>
                    )}
                    {isSelected && <CheckCircle2 className="w-4 h-4 text-blue-500 shrink-0" />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Configuration */}
        <div className="sinter-card rounded-lg p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Configuration</h2>
            <p className="text-xs text-slate-500 mt-1">
              Current selection: {currentProvider?.title || settings.provider_name || 'Custom'} / {currentPreset?.name || settings.model || 'Custom model'}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Provider Name</label>
              <input
                type="text"
                value={settings.provider_name}
                onChange={(e) => setSettings({ ...settings, provider_name: e.target.value })}
                placeholder="e.g. Groq, Together AI, My Ollama"
                className="sinter-input w-full rounded-md px-3 py-2 text-sm outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Model</label>
              <input
                type="text"
                value={settings.model}
                onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                placeholder="e.g. gemini-2.5-flash, gpt-4o, llama3.2"
                className="sinter-input w-full rounded-md px-3 py-2 text-sm outline-none"
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
                  className="sinter-input w-full rounded-md px-3 py-2 text-xs font-mono outline-none"
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
                className="sinter-input w-full rounded-md px-3 py-2 text-sm outline-none"
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
          <div className="rounded-lg border border-slate-200 bg-[#f8f9f7] p-4 text-sm space-y-2">
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
              <div>LLM_PROVIDER_NAME=<span className="text-blue-600">OpenRouter</span></div>
              <div>LLM_API_KEY=<span className="text-blue-600">your-provider-key-here</span></div>
              <div>LLM_BASE_URL=<span className="text-blue-600">https://openrouter.ai/api/v1</span></div>
              <div>LLM_MODEL=<span className="text-blue-600">deepseek/deepseek-v4-flash</span></div>
              <div className="text-slate-400 mt-2"># Examples: Qwen https://dashscope-intl.aliyuncs.com/compatible-mode/v1, DeepSeek https://api.deepseek.com, Kimi https://api.moonshot.ai/v1, GLM https://api.z.ai/api/paas/v4</div>
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
            className="sinter-button-primary flex items-center gap-2 text-white px-5 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}

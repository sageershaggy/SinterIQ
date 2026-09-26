import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { hash, type DB, type Secrets } from './database';
import { adminOnly } from './auth';
import { getAiConfig, type AiConfig } from './ai';
import { checkedUrl, publicRequest } from './network';
import { HttpError } from './validation';
import {
  cleanKey,
  isChatModel,
  isOpenModel,
  pickModel,
  presetInfo,
  presetsForKey,
  providerPresetIds,
  unrecognisedKeyMessage,
  type ConnectionStatus,
  type ProviderDetection,
  type ProviderPreset,
} from '../shared/ai-providers';

/** What asking a provider for its models found: the models, or why it refused. */
export type ModelListing =
  | { ok: true; models: string[] }
  | { ok: false; status: number; reason: string };
export type ListModels = (target: {
  provider: AiConfig['provider'];
  base_url: string;
  api_key: string;
}) => Promise<ModelListing>;

function providerReason(text: string) {
  try {
    const data = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message =
      typeof data.error === 'string'
        ? data.error
        : typeof data.error?.message === 'string'
          ? data.error.message
          : typeof data.message === 'string'
            ? data.message
            : '';
    return message.slice(0, 200);
  } catch {
    return '';
  }
}

/** A public HTTPS base URL with no query, the only kind a key may be sent to. */
export function assertProviderBase(base_url: string) {
  const url = checkedUrl(base_url);
  if (url.protocol !== 'https:' || url.search || url.hash)
    throw new HttpError(400, 'Use a public HTTPS base URL without query parameters.');
  return url.href.replace(/\/$/, '');
}

/**
 * Asks the provider which models this key may use. The key travels only to the provider's own
 * public HTTPS host, through the same pinned public request as every other outbound call, and a
 * redirect is refused rather than followed so the key never reaches another host.
 */
export const listModels: ListModels = async ({ provider, base_url, api_key }) => {
  const gemini = provider === 'gemini';
  const endpoint = gemini
    ? 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
    : assertProviderBase(base_url) + '/models';
  const response = await publicRequest(endpoint, {
    headers: gemini ? { 'x-goog-api-key': api_key } : { Authorization: 'Bearer ' + api_key },
    timeout: 15000,
    maxBytes: 6_000_000,
    followRedirects: false,
  });
  if (response.status < 200 || response.status >= 300)
    return { ok: false, status: response.status, reason: providerReason(response.text) };
  let data: unknown;
  try {
    data = JSON.parse(response.text);
  } catch {
    return { ok: false, status: 502, reason: 'The provider did not return a model list.' };
  }
  if (gemini) {
    const models = ((data as { models?: unknown }).models || []) as Array<{
      name?: unknown;
      supportedGenerationMethods?: unknown;
    }>;
    return {
      ok: true,
      models: models
        .filter(
          (model) =>
            typeof model.name === 'string' &&
            Array.isArray(model.supportedGenerationMethods) &&
            model.supportedGenerationMethods.includes('generateContent'),
        )
        .map((model) => String(model.name).replace(/^models\//, '')),
    };
  }
  const items = (Array.isArray(data) ? data : (data as { data?: unknown }).data) as unknown;
  if (!Array.isArray(items))
    return { ok: false, status: 502, reason: 'The provider did not return a model list.' };
  return {
    ok: true,
    models: items
      .map((item) => (item as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string' && id.length <= 200),
  };
};

function detection(
  preset: ProviderPreset,
  base_url: string,
  available: string[] | null,
): ProviderDetection {
  const info = presetInfo(preset);
  const chat = (available ?? info.recommended)
    .filter(isChatModel)
    .filter((id, index, all) => all.indexOf(id) === index);
  // Recommended first, then the rest in the provider's own order, open models marked.
  const recommended = pickModel(preset, chat);
  const ordered = [
    ...info.recommended.filter((id) => chat.includes(id)),
    ...chat.filter((id) => !info.recommended.includes(id)),
  ].slice(0, 600);
  return {
    preset,
    provider: info.provider,
    base_url: info.provider === 'gemini' ? '' : base_url,
    models: ordered.map((id) => ({ id, open: isOpenModel(id) })),
    recommended,
    verified: available !== null,
  };
}

/**
 * Tries a key against each candidate provider in turn and returns the first that accepts it.
 * A provider that does not list models (404) is accepted unverified with its recommended
 * models; the connection check that follows saving is what proves the key.
 */
export async function detectProvider(
  list: ListModels,
  key: string,
  candidates: ProviderPreset[],
  customBase?: string,
): Promise<ProviderDetection> {
  const refusals: string[] = [];
  for (const preset of candidates) {
    const info = presetInfo(preset);
    const base_url = preset === 'custom' ? assertProviderBase(customBase || '') : info.base_url;
    let listing: ModelListing;
    try {
      listing = await list({ provider: info.provider, base_url, api_key: key });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      refusals.push(info.label + ' could not be reached');
      continue;
    }
    if (listing.ok) return detection(preset, base_url, listing.models);
    if (listing.status === 404 || listing.status === 405) return detection(preset, base_url, null);
    refusals.push(
      info.label +
        (listing.status === 401 || listing.status === 403 || listing.status === 400
          ? ' refused this key'
          : ' answered HTTP ' + listing.status) +
        (listing.reason ? ' (' + listing.reason + ')' : ''),
    );
  }
  throw new HttpError(
    400,
    refusals.join('; ') + '. Check that the whole key was copied, or choose the provider yourself.',
  );
}

/** The saved configuration's identity, so a check of an older setup is never shown as current. */
function fingerprint(config: AiConfig) {
  return hash([config.provider, config.base_url, config.model, config.api_key].join('\n'));
}
export function readStatus(db: DB, config: AiConfig): ConnectionStatus | null {
  const row = db.prepare("SELECT value FROM settings WHERE key='llm_status'").get() as
    | { value: string }
    | undefined;
  if (!row || !config.api_key) return null;
  try {
    const saved = JSON.parse(row.value) as ConnectionStatus & { fingerprint: string };
    if (saved.fingerprint !== fingerprint(config)) return null;
    const { fingerprint: _omit, ...status } = saved;
    return status;
  } catch {
    return null;
  }
}
export function recordStatus(
  db: DB,
  config: AiConfig,
  result: { ok: boolean; message: string; latency_ms: number | null },
) {
  const status = {
    ...result,
    message: result.message.slice(0, 400),
    model: config.model,
    checked_at: new Date().toISOString(),
    fingerprint: fingerprint(config),
  };
  db.prepare(
    "INSERT INTO settings (key,value) VALUES ('llm_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(JSON.stringify(status));
}

const detectSchema = z
  .object({
    api_key: z.string().max(1000).optional(),
    preset: z.enum(providerPresetIds).optional(),
    base_url: z.string().trim().max(2000).optional(),
  })
  .strict();

/**
 * Settings → AI provider: recognising a key and listing its models. Administrator-only like the
 * rest of the provider settings. A typed key is only ever sent to the providers its own format
 * points to (or the one the administrator chose); the saved key is only ever sent to the
 * provider it was saved for.
 */
export function installAiSettings(
  app: Express,
  deps: { db: DB; secrets: Secrets; list: ListModels; limit: RequestHandler },
) {
  const { db, secrets, list, limit } = deps;
  app.post('/api/settings/llm/detect', adminOnly, limit, async (req, res) => {
    const input = detectSchema.parse(req.body);
    const typed = cleanKey(input.api_key || '');
    if (typed) {
      const candidates = input.preset ? [input.preset] : presetsForKey(typed);
      if (!candidates.length) throw new HttpError(422, unrecognisedKeyMessage(typed));
      res.json(await detectProvider(list, typed, candidates, input.base_url));
      return;
    }
    const saved = getAiConfig(db, secrets);
    if (!saved.api_key) throw new HttpError(400, 'Paste an API key first.');
    if (input.preset && input.preset !== saved.preset)
      throw new HttpError(400, 'Paste the key for this provider: the saved key belongs to another.');
    res.json(await detectProvider(list, saved.api_key, [saved.preset], saved.base_url));
  });
}

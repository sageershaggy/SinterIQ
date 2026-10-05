import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { audit, hash, type DB, type Secrets } from './database';
import { adminOnly } from './auth';
import { getAiConfig } from './ai';
import { DEFAULT_JEV_MODEL, createDecision, healthDecisionQuestions } from './decisions';
import { HttpError } from './validation';
import { cleanKey } from '../shared/ai-providers';
import type { JevSettings } from '../shared/types';

/**
 * The Jev key: an OpenRouter key used only for TypeSafe Jev on OpenRouter's Decisions API, for
 * the fast decisions. It is separate from the AI provider key, so the chat provider can stay
 * Gemini or anything else.
 *
 * Kept like every provider key: encrypted at rest, never returned (only its last four
 * characters), administrator-only, and sent nowhere but OpenRouter's fixed Decisions address
 * (server/decisions.ts). In order of use: the saved Jev key, OPENROUTER_API_KEY on the server,
 * then a saved OpenRouter chat key.
 */
export function getJevKey(db: DB, secrets: Secrets) {
  const read = (key: string) =>
    (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)
      ?.value || '';
  const saved = read('jev_api_key');
  const model = read('jev_model') || DEFAULT_JEV_MODEL;
  if (saved) return { key: secrets.decrypt(saved), source: 'saved' as const, model };
  const env = process.env.OPENROUTER_API_KEY?.trim();
  if (env) return { key: env, source: 'environment' as const, model };
  const chat = getAiConfig(db, secrets);
  if (chat.preset === 'openrouter' && chat.api_key)
    return { key: chat.api_key, source: 'chat' as const, model };
  return { key: '', source: 'none' as const, model };
}

type JevStatus = NonNullable<JevSettings['status']>;
const fingerprint = (key: string, model: string) => hash(key + '\n' + model);
function readStatus(db: DB, key: string, model: string): JevStatus | null {
  const row = db.prepare("SELECT value FROM settings WHERE key='jev_status'").get() as
    | { value: string }
    | undefined;
  if (!row || !key) return null;
  try {
    const saved = JSON.parse(row.value) as JevStatus & { fingerprint: string };
    if (saved.fingerprint !== fingerprint(key, model)) return null;
    const { fingerprint: _omit, ...status } = saved;
    return status;
  } catch {
    return null;
  }
}
function recordStatus(db: DB, key: string, model: string, status: JevStatus) {
  db.prepare(
    "INSERT INTO settings (key,value) VALUES ('jev_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(JSON.stringify({ ...status, fingerprint: fingerprint(key, model) }));
}

export function jevSettings(db: DB, secrets: Secrets): JevSettings {
  const { key, source, model } = getJevKey(db, secrets);
  return {
    has_key: Boolean(key),
    key_preview: key ? '••••' + key.slice(-4) : '',
    source,
    model,
    status: readStatus(db, key, model),
  };
}

/** An OpenRouter key: what the Decisions API accepts, and nothing that could be a password. */
const jevKey = z
  .string()
  .max(400)
  .transform(cleanKey)
  .refine(
    (key) => !key || /^sk-or-[A-Za-z0-9_-]{20,300}$/.test(key),
    'A Jev key is an OpenRouter key: it starts with sk-or-.',
  );
const jevModel = z
  .string()
  .trim()
  .regex(/^typesafe\/[a-z0-9._-]{1,60}$/i, 'Jev models are named typesafe/… on OpenRouter.');

export function installJevSettings(
  app: Express,
  deps: { db: DB; secrets: Secrets; decide: typeof createDecision; limit: RequestHandler },
) {
  const { db, secrets, decide, limit } = deps;
  app.get('/api/settings/jev', adminOnly, (_req, res) => {
    res.json(jevSettings(db, secrets));
  });
  app.put('/api/settings/jev', adminOnly, (req, res) => {
    const input = z
      .object({
        api_key: jevKey.default(''),
        clear_api_key: z.boolean().default(false),
        model: jevModel.optional(),
      })
      .strict()
      .parse(req.body);
    db.transaction(() => {
      const save = db.prepare(
        'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      );
      if (input.clear_api_key) save.run('jev_api_key', '');
      else if (input.api_key) save.run('jev_api_key', secrets.encrypt(input.api_key));
      if (input.model) save.run('jev_model', input.model);
      audit(
        db,
        null,
        req.user.name,
        'settings.updated',
        input.clear_api_key
          ? 'Jev key removed.'
          : input.api_key
            ? 'Jev key saved for fast decisions.'
            : 'Jev settings updated.',
      );
    })();
    res.json(jevSettings(db, secrets));
  });
  /** Proves the key and model with one tiny decision, and records the result as the status. */
  app.post('/api/settings/jev/test', adminOnly, limit, async (_req, res) => {
    const { key, model } = getJevKey(db, secrets);
    if (!key) throw new HttpError(400, 'Save a Jev key first.');
    try {
      const result = await decide({
        apiKey: key,
        model,
        state: 'Innovista Research AI health check ping.',
        questions: healthDecisionQuestions(),
      });
      recordStatus(db, key, model, {
        ok: true,
        message: 'Connected',
        latency_ms: result.latency_ms,
        checked_at: new Date().toISOString(),
      });
    } catch (error) {
      recordStatus(db, key, model, {
        ok: false,
        message:
          error instanceof HttpError ? error.message : 'OpenRouter could not be reached.',
        latency_ms: null,
        checked_at: new Date().toISOString(),
      });
      throw error;
    }
    res.json(jevSettings(db, secrets));
  });
}

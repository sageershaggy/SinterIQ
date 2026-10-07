import type { Express } from 'express';
import { z } from 'zod';
import { audit, type DB, type Secrets } from './database';
import { adminOnly } from './auth';
import { getJevKey } from './jev';
import { searchMaxResults, searchModel, type SearchHit, type WebSearch } from './web-search';
import type { ResearchSearchSettings } from '../shared/research';

/**
 * Settings → Fast decisions → "Use web search in research". On by default whenever an OpenRouter
 * key is available (the Jev key, OPENROUTER_API_KEY, or a saved OpenRouter chat key — the order
 * getJevKey uses); an administrator can turn it off, because each search is charged per result.
 */
const settingKey = 'research_web_search';

export function researchSearchSettings(db: DB, secrets: Secrets): ResearchSearchSettings {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(settingKey) as
    | { value: string }
    | undefined;
  const enabled = row?.value !== '0';
  const has_key = Boolean(getJevKey(db, secrets).key);
  return {
    enabled,
    has_key,
    active: enabled && has_key,
    model: searchModel,
    max_results: searchMaxResults,
  };
}

/** What research may search with: a search bound to the key, or the reason there is none. */
export interface ResearchSearch {
  search?: (query: string) => Promise<SearchHit[]>;
  /** Said in the research notes when search is not used. */
  off: string;
}
export function researchSearch(db: DB, secrets: Secrets, search: WebSearch): ResearchSearch {
  const settings = researchSearchSettings(db, secrets);
  if (!settings.enabled)
    return { off: 'Web search is turned off in Settings, so only the record’s own clues were checked.' };
  const { key } = getJevKey(db, secrets);
  if (!key)
    return {
      off: 'No OpenRouter key is set up for web search, so likely addresses were checked instead.',
    };
  // The key is read here and handed only to the search, which sends it to OpenRouter alone.
  return { search: (query) => search({ query, apiKey: key }), off: '' };
}

export function installResearchSettings(app: Express, deps: { db: DB; secrets: Secrets }) {
  const { db, secrets } = deps;
  app.get('/api/settings/research', adminOnly, (_req, res) => {
    res.json(researchSearchSettings(db, secrets));
  });
  app.put('/api/settings/research', adminOnly, (req, res) => {
    const input = z.object({ web_search: z.boolean() }).strict().parse(req.body);
    db.transaction(() => {
      db.prepare(
        'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(settingKey, input.web_search ? '1' : '0');
      audit(
        db,
        null,
        req.user.name,
        'settings.updated',
        input.web_search ? 'Web search in research turned on.' : 'Web search in research turned off.',
      );
    })();
    res.json(researchSearchSettings(db, secrets));
  });
}

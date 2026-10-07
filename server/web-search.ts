import { publicRequest } from './network';
import { HttpError } from './validation';

/**
 * Web search for lead research, through OpenRouter's web plugin.
 *
 * Until this existed, a record without a website could only be researched from its email
 * domain and from domains a model proposed out of memory: a company that was easy to find on
 * the web stayed "not found", and a lead with only a name and a country was judged on nothing.
 *
 * Rules that keep a search from becoming a source of invented facts or a leaked key:
 *
 * - The key (the Jev / OpenRouter key, server/jev.ts) goes to exactly one address, fixed here,
 *   by POST, and a redirect is never followed with it (publicRequest refuses redirects on POST).
 * - Only the addresses in the response's url_citation annotations are used — the results the
 *   search itself returned. The model's prose is never read: a URL or a company name it writes
 *   is the model talking, not something found.
 * - A result is only ever a candidate. Research fetches it through server/network.ts and
 *   verifies it exactly like any other candidate before anything is written.
 * - Only the lead's name, city and country are sent, never the contact's name, email or phone.
 */
export const searchEndpoint = 'https://openrouter.ai/api/v1/chat/completions';
/** A low-cost model with no native search of its own, so the web plugin's own engine runs. */
export const searchModel = 'google/gemini-2.5-flash-lite';
/** Results per search. OpenRouter's web plugin is charged per result. */
export const searchMaxResults = 5;

export interface SearchHit {
  url: string;
  title: string;
}
/** One search, with the key passed in by the caller and sent to searchEndpoint alone. */
export type WebSearch = (input: { query: string; apiKey: string }) => Promise<SearchHit[]>;

/**
 * The search results in an OpenRouter chat completion: the url_citation annotations of the
 * message, public http(s) addresses only, each once. Anything else in the answer is ignored.
 */
export function searchCitations(raw: unknown): SearchHit[] {
  const choices = (raw as { choices?: unknown })?.choices;
  const message = Array.isArray(choices)
    ? (choices[0] as { message?: { annotations?: unknown } })?.message
    : undefined;
  const annotations = Array.isArray(message?.annotations) ? message.annotations : [];
  const hits: SearchHit[] = [];
  for (const entry of annotations as Array<Record<string, unknown>>) {
    if (!entry || entry.type !== 'url_citation') continue;
    const citation = (entry.url_citation ?? entry) as Record<string, unknown>;
    const url = typeof citation.url === 'string' ? citation.url.trim() : '';
    if (!url || url.length > 2000) continue;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        continue;
    } catch {
      continue;
    }
    if (hits.some((hit) => hit.url === url)) continue;
    const title = typeof citation.title === 'string' ? citation.title.slice(0, 200) : '';
    hits.push({ url, title });
    if (hits.length >= 10) break;
  }
  return hits;
}

const instructions =
  'Search the web for the query and answer in one short sentence, citing the pages you found. ' +
  'Prefer the organisation’s own official website and its own pages over directories or social networks.';

/** The real search; tests build one around a stub request instead of reaching OpenRouter. */
export function createWebSearch(request: typeof publicRequest = publicRequest): WebSearch {
  return async ({ query, apiKey }) => {
    if (!apiKey) throw new HttpError(409, 'Web search needs an OpenRouter key.');
    const response = await request(searchEndpoint, {
      method: 'POST',
      followRedirects: false,
      timeout: 45000,
      connectTimeout: 10000,
      maxBytes: 1_000_000,
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://innovista-ai.local',
        'X-Title': 'Innovista Research AI',
      },
      body: JSON.stringify({
        model: searchModel,
        plugins: [{ id: 'web', max_results: searchMaxResults }],
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: query.slice(0, 300) },
        ],
        max_tokens: 300,
        temperature: 0,
      }),
    });
    // The status only: a provider's own error text can quote the request.
    if (response.status < 200 || response.status >= 300)
      throw new HttpError(
        502,
        response.status === 401 || response.status === 403
          ? 'Web search was refused: check the OpenRouter key (HTTP ' + response.status + ').'
          : response.status === 402
            ? 'Web search needs OpenRouter credits (HTTP 402).'
            : 'Web search failed (HTTP ' + response.status + ').',
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new HttpError(502, 'Web search returned an unreadable answer.');
    }
    return searchCitations(parsed);
  };
}
export const webSearch = createWebSearch();

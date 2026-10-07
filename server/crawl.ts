import type { WebsitePage } from './network';
import { crawlCategories, type CrawlCategory, type PageRead } from '../shared/research';

/**
 * Reading more of a company's own site than its home page.
 *
 * A home page rarely says what a company actually does in enough detail to judge it: the
 * services, products, industries, careers, news and references pages do, and a "Not a target"
 * built on a home page alone is a verdict on a banner. Research and the qualification evidence
 * both read the same pages, chosen here by category in the owner's priority order — About,
 * Services, Products, Industries, Careers, News, Case studies, Contact — one page per category
 * before a second of any, so seven pages cover seven different things rather than seven news
 * posts. Only links the home page really carries are followed, only on the same site, and a
 * page that redirects off the site or repeats one already read is not used.
 */

/** Pages read besides the home page. */
export const crawlLimit = 7;
/** Pages fetched at once: a small company site should not see a burst of requests. */
const concurrency = 3;

/** Path patterns per category, in priority order (shared/research.ts holds the order). */
const categoryPatterns: Record<CrawlCategory, RegExp> = {
  about:
    /\b(about|about-us|aboutus|company|our-company|who-we-are|our-story|profile|unternehmen|ueber-uns|uber-uns|ueber|firma|qui-sommes-nous|chi-siamo|empresa|nosotros)\b/i,
  services:
    /\b(services?|solutions?|what-we-do|capabilities|expertise|offerings?|leistungen|dienstleistungen|loesungen|losungen|servicios|soluciones)\b/i,
  products:
    /\b(products?|produkte?|catalog(ue)?|range|portfolio|applications?|anwendungen|produits|productos|prodotti|technology|technologies)\b/i,
  industries:
    /\b(industr(y|ies)|markets?|sectors?|branchen?|maerkte|markte|segments?|clients?)\b/i,
  careers: /\b(careers?|jobs?|vacanc(y|ies)|karriere|stellen(angebote)?|join-us|work-with-us|hiring)\b/i,
  news: /\b(news|press|blog|media|aktuelles|neuigkeiten|presse|insights?|articles?|events?|newsroom)\b/i,
  cases:
    /\b(case-stud(y|ies)|casestud(y|ies)|cases|references?|referenzen|projects?|projekte|success-stor(y|ies)|customers?|kunden)\b/i,
  contact:
    /\b(contact|contact-us|kontakt|imprint|impressum|legal-notice|team|our-team|people|staff|leadership|management|board|vorstand|geschaeftsfuehrung)\b/i,
};
/** Files and feeds, which are not pages about the company. */
const notAPage = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|mp3|xml|rss|json|css|js)$/i;

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
/** A link reduced to what identifies the page, so /about and /about/ are read once. */
function pageKey(url: string) {
  try {
    const parsed = new URL(url);
    return (hostOf(url) + parsed.pathname.replace(/\/+$/, '') + parsed.search).toLowerCase();
  } catch {
    return url;
  }
}

/**
 * The category a link belongs to, from its own path. The last path segment decides first
 * ("/company/news" is news, not about); the whole path only when the last segment says nothing.
 */
export function categorize(url: string): CrawlCategory | 'other' {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 'other';
  }
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  for (const text of [last, path])
    for (const category of crawlCategories)
      if (categoryPatterns[category].test(text)) return category;
  return 'other';
}

/**
 * The same-site pages to read after the home page, in reading order: one per category in
 * priority order, then second pages of a category, then links of no known category (a test or
 * an unusual site may offer only those). `ensure` keeps a category in the plan even past the
 * limit — research keeps a contact or team page, because that is where people are named.
 */
export function crawlPlan(
  home: Pick<WebsitePage, 'url' | 'links' | 'contact_links'>,
  options: { limit?: number; ensure?: CrawlCategory[] } = {},
): PageRead[] {
  const limit = options.limit ?? crawlLimit;
  const site = hostOf(home.url);
  const seen = new Set([pageKey(home.url)]);
  const candidates: PageRead[] = [];
  for (const url of [...(home.links || []), ...(home.contact_links || [])]) {
    if (!url || hostOf(url) !== site || notAPage.test(url.split(/[?#]/)[0])) continue;
    const key = pageKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ url, category: categorize(url) });
  }
  const rank = (category: string) => {
    const index = crawlCategories.indexOf(category as CrawlCategory);
    return index < 0 ? crawlCategories.length : index;
  };
  const ordered = [...candidates].sort((a, b) => rank(a.category) - rank(b.category));
  const first: PageRead[] = [];
  const more: PageRead[] = [];
  const covered = new Set<string>();
  for (const item of ordered) {
    if (item.category !== 'other' && !covered.has(item.category)) {
      covered.add(item.category);
      first.push(item);
    } else more.push(item);
  }
  const plan = [...first, ...more].slice(0, limit);
  // A category left out can only have been cut by the limit, so it takes the last place.
  for (const category of options.ensure || []) {
    if (!plan.length || plan.some((item) => item.category === category)) continue;
    const kept = first.find((item) => item.category === category);
    if (kept) plan[plan.length - 1] = kept;
  }
  return plan;
}

export interface CrawledPage {
  page: WebsitePage;
  category: CrawlCategory | 'home' | 'other';
}
export interface SiteReading {
  /** The home page first, then the pages read in plan order. Empty when the home page failed. */
  pages: CrawledPage[];
  /** Addresses that could not be read. */
  failures: string[];
  /** What was skipped and why, in the system's own words. */
  notes: string[];
}

/** Reads a fixed list with a few requests at a time, keeping the list's order in the result. */
async function readAll<T>(items: T[], read: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await read(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/**
 * Reads a company site: the given home page (already fetched, or fetched here) and up to
 * `limit` category pages from its links. Never follows a page off the site.
 */
export async function readSite(
  start: string | WebsitePage,
  fetchPage: (url: string) => Promise<WebsitePage>,
  options: { limit?: number; ensure?: CrawlCategory[] } = {},
): Promise<SiteReading> {
  const reading: SiteReading = { pages: [], failures: [], notes: [] };
  let home: WebsitePage;
  if (typeof start === 'string')
    try {
      home = await fetchPage(start);
    } catch {
      reading.failures.push(start);
      return reading;
    }
  else home = start;
  reading.pages.push({ page: home, category: 'home' });
  const plan = crawlPlan(home, options);
  const site = hostOf(home.url);
  const results: Array<CrawledPage | null> = plan.map(() => null);
  await readAll(
    plan.map((item, index) => ({ ...item, index })),
    async (item) => {
      try {
        const page = await fetchPage(item.url);
        if (hostOf(page.url) !== site) {
          reading.notes.push(item.url + ' redirected off the company site, so it was not read.');
          return;
        }
        results[item.index] = { page, category: item.category as CrawlCategory | 'other' };
      } catch {
        reading.failures.push(item.url);
      }
    },
  );
  for (const result of results) {
    if (!result) continue;
    // The same text under two addresses (a language redirect, a tracking parameter) is one page.
    if (reading.pages.some((known) => known.page.content === result.page.content)) continue;
    reading.pages.push(result);
  }
  return reading;
}

/** What a run says it read: each page and the category it was chosen for. */
export const pagesRead = (reading: Pick<SiteReading, 'pages'>): PageRead[] =>
  reading.pages.map(({ page, category }) => ({ url: page.url, category }));

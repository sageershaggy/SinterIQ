/**
 * Harness fixtures for Phase 3 research: Settings → Fast decisions → "Use web search in
 * research", and the web searches and pages read that a lead's research and run show.
 * Development only (see harness.html).
 */
import type { PageRead, ResearchSearchSettings, SearchRecord } from '../../shared/research';
import { settingsRoutes, settingsWrites } from './settingsFixtures';

let research: ResearchSearchSettings = {
  enabled: true,
  has_key: true,
  active: true,
  model: 'google/gemini-2.5-flash-lite',
  max_results: 5,
};
settingsRoutes.push([/^\/settings\/research$/, () => research]);
settingsWrites.push([
  'PUT',
  /^\/settings\/research$/,
  (body) => {
    const enabled = Boolean((body as { web_search?: boolean }).web_search);
    research = { ...research, enabled, active: enabled && research.has_key };
    return research;
  },
]);

/** The requalify dialog's counts, with leads already Qualified on this training (Phase 3 R7). */
settingsRoutes.push([
  /^\/projects\/2\/qualification-jobs\/current$/,
  () => ({
    job: null,
    counts: { requalify: 6, raw: 150, total: 198, qualified: 21 },
    ready: true,
    training_version: 10,
    can_start_project_wide: true,
  }),
]);

/** The search a research pass ran for a company with no website on record. */
export const harnessSearches = (site: string): SearchRecord[] => [
  {
    query: 'Amusement Whitewater (L.L.C) Dubai official website',
    purpose: 'website',
    results: [
      'linkedin.com (profile; cannot be read)',
      'https://www.kompass.com/c/amusement-whitewater-llc/ae0123/',
      site + '/about-us',
    ],
    verified: new URL(site).hostname,
  },
];
/** The home page and one page per kind, as the crawl reads them. */
export const harnessPagesRead = (site: string): PageRead[] => [
  { url: site + '/', category: 'home' },
  { url: site + '/about-us', category: 'about' },
  { url: site + '/services/water-rides', category: 'services' },
  { url: site + '/products', category: 'products' },
  { url: site + '/industries/resorts-and-hotels', category: 'industries' },
  { url: site + '/careers', category: 'careers' },
  { url: site + '/news/2026-expansion-in-saudi-arabia', category: 'news' },
  { url: site + '/projects', category: 'cases' },
];

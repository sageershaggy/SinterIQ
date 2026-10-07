import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { validateQualification, type Generate } from '../server/ai';
import { categorize, crawlPlan } from '../server/crawl';
import { domainGuesses, looksLikePerson, pageNamesCompany } from '../server/enrich';
import { siteLinks, type WebsitePage } from '../server/network';
import {
  createWebSearch,
  searchCitations,
  searchEndpoint,
  searchMaxResults,
  type SearchHit,
  type WebSearch,
} from '../server/web-search';
import type {
  Evidence,
  Lead,
  Project,
  Qualification,
  ResearchOutcome,
  Run,
  TrainingSnapshot,
} from '../shared/types';
import type { ResearchSearchSettings } from '../shared/research';
import type { ResearchLogPage, ResearchPassEntry } from '../shared/research-log';
import type { QualificationJobState } from '../shared/qualification-jobs';

/**
 * Phase 3 research: web search through OpenRouter (stubbed here, never reached), a deeper read of
 * the company's own site, no verdict without evidence, a person's employer, the opportunity, and
 * research that is reused rather than repeated. Every outbound call is a stub: searches through
 * createApp's webSearch option, pages through fetchWebsite, the model through generate.
 */

const rubric = {
  summary: 'Find pump manufacturers with engineering teams. Reach the purchasing manager.',
  criteria: ['Manufactures pumps', 'Employs engineers'],
  exclusions: ['Manufactures bearings'],
  questions: [],
  categories: [
    { name: 'Pump retrofits', description: 'Companies upgrading or expanding pump lines.' },
  ],
};
const trainingSite =
  'Example Research helps industrial suppliers find pump manufacturers across Europe and the Gulf.';
/** A key in the OpenRouter shape. Never sent anywhere: every search is a stub. */
const searchKey = 'sk-or-v1-' + 'phase3testkey'.repeat(4);

interface Model {
  discover?: (input: Record<string, unknown>) => unknown;
  extract?: (input: Record<string, unknown>) => unknown;
  qualify?: (input: QualifyInput, attempt: number) => unknown;
}
interface QualifyInput {
  approved_training: TrainingSnapshot;
  evidence: Evidence[];
  research_before_evaluation: Record<string, unknown> | null;
  lead: { name: string };
}
/** A complete answer meeting every rule from the first website evidence, if there is any. */
function complete(input: QualifyInput) {
  const snapshot = input.approved_training;
  const cite = input.evidence.find((item) => item.kind === 'website')?.id ?? 'E1';
  return {
    decision: 'NOT_A_TARGET',
    score: 10,
    confidence: 60,
    summary: 'A pump maker.',
    criteria: snapshot.rubric.criteria.map((criterion) => ({
      criterion,
      outcome: 'MATCH',
      evidence: 'The website describes pumps and engineers.',
      source_ids: [cite],
    })),
    exclusions: snapshot.rubric.exclusions.map((criterion) => ({
      criterion,
      outcome: 'NO_MATCH',
      evidence: 'Buys bearings.',
      source_ids: [cite],
    })),
    gaps: [],
    next_steps: [],
  };
}

function fixture(
  model: Model,
  pages: Record<string, string | WebsitePage>,
  searches: (query: string) => SearchHit[] = () => [],
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-phase3-'));
  const calls = {
    discover: [] as unknown[],
    extract: [] as Array<Record<string, unknown>>,
    qualify: [] as QualifyInput[],
    search: [] as Array<{ query: string; apiKey: string }>,
    fetched: [] as string[],
  };
  const generate: Generate = async (_config, system, input) => {
    if (system.includes('proposed qualification rubric')) return rubric;
    if (system.includes('candidate official website domains')) {
      calls.discover.push(input);
      return model.discover?.(input as Record<string, unknown>) ?? { domains: [] };
    }
    if (system.includes('extract company facts')) {
      calls.extract.push(input as Record<string, unknown>);
      return model.extract?.(input as Record<string, unknown>) ?? { fields: [], notes: [] };
    }
    calls.qualify.push(input as QualifyInput);
    return model.qualify
      ? model.qualify(input as QualifyInput, calls.qualify.length - 1)
      : complete(input as QualifyInput);
  };
  const webSearch: WebSearch = async ({ query, apiKey }) => {
    calls.search.push({ query, apiKey });
    return searches(query);
  };
  const instance = createApp({
    dataDir: dir,
    generate,
    webSearch,
    runJobs: false,
    fetchWebsite: async (url) => {
      calls.fetched.push(url);
      const page = pages[url];
      if (page === undefined) throw new Error('This website could not be reached.');
      return typeof page === 'string' ? { url, content: page, truncated: false, links: [] } : page;
    },
  });
  const { app, db } = instance;
  const agent = request.agent(app);
  let csrf = '';
  const send = (method: 'post' | 'put' | 'delete', url: string, body: object = {}) =>
    agent[method]('/api' + url)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf)
      .send(body);
  const f = {
    db,
    calls,
    jobs: instance.qualificationJobs,
    post: (url: string, body: object = {}) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    get: (url: string) => agent.get('/api' + url),
    async setup(withKey = true) {
      const response = await send('post', '/auth/setup', {
        name: 'Phase Three Administrator',
        username: 'phase3-admin',
        password: 'A-long-phase-three-password-2026',
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      csrf = response.body.csrf_token;
      if (withKey) {
        const saved = await send('put', '/settings/jev', { api_key: searchKey });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
      }
    },
    async project(name = 'Pump Research') {
      let project = (await send('post', '/projects', { name, website: 'https://example.org' }))
        .body as Project;
      let added = await send('post', '/projects/' + project.id + '/sources', {
        revision: project.revision,
        title: 'Training brief',
        content: 'Target pump manufacturers with engineering teams. Exclude bearing makers.',
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      project = (await agent.get('/api/projects/' + project.id)).body.project;
      added = await send('post', '/projects/' + project.id + '/sources/website', {
        revision: project.revision,
        url: 'https://example.org',
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      project = (await agent.get('/api/projects/' + project.id)).body.project;
      return f.publish(project, rubric);
    },
    async publish(project: Project, next: typeof rubric) {
      const current = (await agent.get('/api/projects/' + project.id)).body.project as Project;
      const saved = await send('put', '/projects/' + project.id + '/training/rubric', {
        revision: current.revision,
        rubric: next,
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const published = await send('post', '/projects/' + project.id + '/training/publish', {
        revision: saved.body.revision,
      });
      assert.equal(published.status, 200, JSON.stringify(published.body));
      return published.body as Project;
    },
    async lead(projectId: number, lead: Partial<Lead> & { name: string }) {
      const created = await send('post', '/projects/' + projectId + '/leads', lead);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return { lead: created.body as Lead, base: '/projects/' + projectId + '/leads/' + created.body.id };
    },
    dispose() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return f;
}
const page = (url: string, content: string, links: string[] = []): WebsitePage => ({
  url,
  content,
  truncated: false,
  links,
});
const researchLog = async (f: ReturnType<typeof fixture>, projectId: number, leadId: number) =>
  (
    (await f.get('/projects/' + projectId + '/research-log?kind=research&lead_id=' + leadId))
      .body as ResearchLogPage
  ).entries as ResearchPassEntry[];

// --- R1, R2, R6: a sparse record is researched before it is judged --------------------------

test('name and country only: a web search finds the site, it is verified, and the lead is judged on its pages', async () => {
  const home = 'https://kestrel-pumps.example.de';
  const f = fixture(
    {},
    {
      'https://example.org': trainingSite,
      [home]: page(
        home,
        'Kestrel Pump Works manufactures centrifugal pumps in Hamburg. Our engineers design every pump in house.',
      ),
    },
    () => [
      { url: 'https://www.linkedin.com/company/kestrel-pump-works', title: 'Kestrel | LinkedIn' },
      { url: 'https://www.kompass.com/c/kestrel-pump-works/de123/', title: 'Kestrel - Kompass' },
      { url: home + '/en/about', title: 'About Kestrel Pump Works' },
    ],
  );
  try {
    await f.setup();
    const project = await f.project();
    const { base, lead } = await f.lead(project.id, { name: 'Kestrel Pump Works', country: 'Germany' });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const result = qualified.body.result as Qualification;

    // The search ran with the saved key, for the company's official site in its country.
    assert.deepEqual(f.calls.search, [
      { query: 'Kestrel Pump Works Germany official website', apiKey: searchKey },
    ]);
    // A verified search result needs no model guess, and a directory or profile is never fetched.
    assert.equal(f.calls.discover.length, 0);
    assert.ok(!f.calls.fetched.some((url) => /linkedin|kompass/.test(url)), f.calls.fetched.join());
    // Enriched first: the website was written before the evaluation, which then read it.
    const after = (await f.get(base)).body as Lead & { runs: Run[] };
    assert.equal(after.website, home);
    assert.equal(after.revision, lead.revision + 1);
    assert.equal(after.qualified_revision, after.revision);
    assert.ok(result.research?.ran);
    assert.deepEqual(result.research?.filled, ['website']);
    assert.equal(result.research?.searches?.[0].verified, 'kestrel-pumps.example.de');
    const input = f.calls.qualify[0];
    assert.ok(input.evidence.some((item) => item.kind === 'website' && item.url === home));
    // Judged on evidence: both rules met from the page, so Qualified whatever the model suggested.
    assert.equal(result.decision, 'QUALIFIED');
    assert.equal(result.score, 100);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.pages_read, [{ url: home, category: 'home' }]);

    // The research log says which search ran and what it returned; a profile only by its site.
    const [pass] = await researchLog(f, project.id, lead.id);
    assert.equal(pass.searches?.length, 1);
    assert.equal(pass.searches![0].query, 'Kestrel Pump Works Germany official website');
    assert.deepEqual(pass.searches![0].results, [
      'linkedin.com (profile; cannot be read)',
      'https://www.kompass.com/c/kestrel-pump-works/de123/',
      home + '/en/about',
    ]);
    assert.equal(pass.searches![0].verified, 'kestrel-pumps.example.de');
    assert.ok(pass.notes.some((note) => /2 search results were directories, social networks or search sites/.test(note)));
  } finally {
    f.dispose();
  }
});

test('nothing found: Needs review saying what was searched, never Not a target; real evidence that scores low stays Not a target', async () => {
  const f = fixture(
    {
      // The model would happily call it Not a target on nothing: the server does not let it.
      qualify: (input) => ({
        ...complete(input),
        criteria: input.approved_training.rubric.criteria.map((criterion) => ({
          criterion,
          outcome: 'NO_MATCH',
          evidence: 'Nothing suggests it.',
          source_ids: ['E1'],
        })),
      }),
    },
    { 'https://example.org': trainingSite },
    () => [],
  );
  try {
    await f.setup();
    const project = await f.project();
    const { base } = await f.lead(project.id, { name: 'Obscure Valve Works', country: 'Oman' });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const result = qualified.body.result as Qualification;
    assert.equal(result.decision, 'NEEDS_REVIEW');
    assert.equal(result.score, 0);
    assert.equal(result.blockers?.length, 1, JSON.stringify(result.blockers));
    const blocker = result.blockers![0];
    assert.match(blocker, /^Not enough found to judge: no company website could be verified and there is no list data\./);
    assert.match(blocker, /searched the web for “Obscure Valve Works Oman official website” \(no results\)/);
    // The likely addresses for the name under Oman's ending and .com were checked too.
    assert.match(blocker, /obscurevalveworks\.om/);
    assert.deepEqual(result.research?.searches?.[0].results, []);
    assert.equal(((await f.get(base)).body as Lead).status, 'NEEDS_REVIEW');

    // The team's own list data is evidence: a lead judged on it that scores low is Not a target.
    const imported = await f.post('/projects/' + project.id + '/leads/import/rows', {
      leads: [{ name: 'Listed Valve Works', country: 'Oman', list_data: { Event: 'Valve World 2026' } }],
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const listed = await f.post(
      '/projects/' + project.id + '/leads/' + imported.body.created_ids[0] + '/qualify',
    );
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const judged = listed.body.result as Qualification;
    assert.equal(judged.decision, 'NOT_A_TARGET');
    assert.deepEqual(judged.blockers, []);
  } finally {
    f.dispose();
  }
});

test('a website on record still decides as before: no "Not enough found" when a page was read', () => {
  const snapshot: TrainingSnapshot = {
    project: { name: 'Status Research', description: '', website: '' },
    rubric: { ...rubric, questions: [] },
    sources: [],
  };
  const record: Evidence = {
    id: 'E1',
    kind: 'lead_record',
    title: 'User-provided lead record (unverified)',
    url: '',
    content: '{}',
    captured_at: '2026-10-07T00:00:00.000Z',
  };
  const site: Evidence = { ...record, id: 'E2', kind: 'website', title: 'x.example/', url: 'https://x.example/' };
  const raw = {
    decision: 'NOT_A_TARGET',
    score: 0,
    confidence: 50,
    summary: 'Not a pump maker.',
    criteria: rubric.criteria.map((criterion) => ({
      criterion,
      outcome: 'NO_MATCH',
      evidence: 'The page sells software.',
      source_ids: ['E2'],
    })),
    exclusions: rubric.exclusions.map((criterion) => ({
      criterion,
      outcome: 'NO_MATCH',
      evidence: 'No bearings.',
      source_ids: ['E2'],
    })),
    gaps: [],
    next_steps: [],
  };
  const judged = validateQualification(raw, snapshot, [record, site], { name: 'X' });
  assert.equal(judged.decision, 'NOT_A_TARGET');
  assert.deepEqual(judged.blockers, []);
  const nothing = validateQualification(raw, snapshot, [record], {
    name: 'X',
    searched: 'Research searched the web for “X”.',
  });
  assert.equal(nothing.decision, 'NEEDS_REVIEW');
  assert.deepEqual(nothing.blockers, ['Not enough found to judge: Research searched the web for “X”.']);
});

// --- R3: more than the home page -------------------------------------------------------------

const crawlHome = 'https://crawl-pumps.example.com';
const crawlLinks = [
  crawlHome + '/news/2026-expansion',
  crawlHome + '/news',
  crawlHome + '/careers',
  crawlHome + '/contact',
  crawlHome + '/references',
  crawlHome + '/industries',
  crawlHome + '/products',
  crawlHome + '/services',
  crawlHome + '/about-us',
  crawlHome + '/blog/post-1',
  crawlHome + '/brochure.pdf',
  'https://elsewhere.example.net/about',
  crawlHome + '/',
];
function crawlSite() {
  const pages: Record<string, string | WebsitePage> = {
    'https://example.org': trainingSite,
    [crawlHome]: page(crawlHome, 'Crawl Pumps manufactures process pumps for chemical plants.', crawlLinks),
  };
  for (const url of crawlLinks)
    if (url.startsWith(crawlHome) && !url.endsWith('/') && !url.endsWith('.pdf'))
      pages[url] = 'Crawl Pumps page ' + new URL(url).pathname + ' with its own distinct text about pumps.';
  return pages;
}

test('the crawl chooses one page per kind in the owner’s priority order, on the same site, capped', () => {
  assert.equal(categorize(crawlHome + '/company/news'), 'news');
  assert.equal(categorize(crawlHome + '/products/pump-x'), 'products');
  assert.equal(categorize(crawlHome + '/en/'), 'other');
  assert.equal(categorize(crawlHome + '/ueber-uns'), 'about');
  assert.equal(categorize(crawlHome + '/impressum'), 'contact');
  const plan = crawlPlan(page(crawlHome, '', crawlLinks));
  assert.deepEqual(
    plan.map((item) => item.category),
    ['about', 'services', 'products', 'industries', 'careers', 'news', 'cases'],
  );
  // The first news link the page carries, not the second; no file, no other site, no home again.
  assert.equal(plan.find((item) => item.category === 'news')?.url, crawlHome + '/news/2026-expansion');
  // Research keeps a contact page, where people are named, in the last place.
  const research = crawlPlan(page(crawlHome, '', crawlLinks), { ensure: ['contact'] });
  assert.equal(research.length, 7);
  assert.equal(research[6].category, 'contact');
  // Only links to pages of a known kind are offered by the fetcher, in page order.
  assert.deepEqual(
    siteLinks(
      '<a href="/about">A</a><a href="/pricing-calculator">P</a><a href="https://other.example/services">O</a><a href="/careers#jobs">C</a>',
      'https://acme.example/',
    ),
    ['https://acme.example/about', 'https://acme.example/careers'],
  );
});

test('qualification reads the category pages in priority order, at most seven besides the home page', async () => {
  const f = fixture({}, crawlSite());
  try {
    await f.setup(false);
    const project = await f.project();
    // Every field filled, so no research runs: this is the qualification's own reading.
    const { base } = await f.lead(project.id, {
      name: 'Crawl Pumps',
      website: crawlHome,
      industry: 'Pumps',
      country: 'Germany',
      city: 'Essen',
      employee_count: '120',
      contact_name: 'Front Desk',
      contact_role: 'Reception',
      contact_email: 'desk@crawl-pumps.example.com',
      contact_phone: '+49 201 555 0101',
    });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const result = qualified.body.result as Qualification;
    const expected = [
      [crawlHome, 'home'],
      [crawlHome + '/about-us', 'about'],
      [crawlHome + '/services', 'services'],
      [crawlHome + '/products', 'products'],
      [crawlHome + '/industries', 'industries'],
      [crawlHome + '/careers', 'careers'],
      [crawlHome + '/news/2026-expansion', 'news'],
      [crawlHome + '/references', 'cases'],
    ];
    assert.deepEqual(
      result.pages_read?.map((item) => [item.url, item.category]),
      expected,
    );
    const website = f.calls.qualify[0].evidence.filter((item) => item.kind === 'website');
    assert.deepEqual(
      website.map((item) => item.url),
      expected.map(([url]) => url),
    );
    assert.equal(result.research, undefined);
    for (const skipped of ['/contact', '/news', '/blog/post-1', '/brochure.pdf'])
      assert.ok(!f.calls.fetched.includes(crawlHome + skipped), skipped);
    assert.ok(!f.calls.fetched.includes('https://elsewhere.example.net/about'));
    // The run log lists the pages read.
    const log = (await f.get('/projects/' + project.id + '/research-log?kind=qualification'))
      .body as ResearchLogPage;
    assert.equal((log.entries[0] as { pages: string[] }).pages.length, 8);
  } finally {
    f.dispose();
  }
});

test('research reads the same pages, keeps a contact page, and the qualification right after does not fetch them again', async () => {
  const f = fixture(
    {
      extract: (input) => {
        const pages = input.pages as Array<{ url: string; text: string }>;
        return {
          fields: [],
          facts: [],
          opportunities: [
            {
              rule: 'Pump retrofits',
              quote: 'Crawl Pumps page /news/2026-expansion with its own distinct text about pumps.',
              page_url: pages.find((item) => item.url.endsWith('2026-expansion'))?.url,
            },
            // Not on any page: dropped.
            { rule: 'Pump retrofits', quote: 'Crawl Pumps is replacing every pump it owns next year.' },
          ],
          notes: [],
        };
      },
    },
    crawlSite(),
  );
  try {
    await f.setup(false);
    const project = await f.project();
    const { base } = await f.lead(project.id, { name: 'Crawl Pumps', website: crawlHome });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const result = qualified.body.result as Qualification;
    assert.deepEqual(
      result.pages_read?.map((item) => item.category),
      ['home', 'about', 'services', 'products', 'industries', 'careers', 'news', 'contact'],
    );
    // The extraction saw all eight pages, and every page was fetched exactly once.
    assert.equal((f.calls.extract[0].pages as unknown[]).length, 8);
    const counts = new Map<string, number>();
    for (const url of f.calls.fetched) counts.set(url, (counts.get(url) || 0) + 1);
    assert.ok([...counts.values()].every((n) => n === 1), JSON.stringify([...counts]));

    // R5: the opportunity research quoted reaches the evaluation first, as website evidence.
    const input = f.calls.qualify[0];
    const found = input.evidence.find((item) => item.title.startsWith('Details found by research'));
    assert.ok(found, JSON.stringify(input.evidence.map((item) => item.title)));
    assert.equal(found.kind, 'website');
    assert.match(
      found.content.split('\n')[0],
      /^Opportunity \(Pump retrofits\): “Crawl Pumps page \/news\/2026-expansion/,
    );
    assert.ok(!found.content.includes('replacing every pump'));
    assert.equal(input.research_before_evaluation?.opportunities_found, 1);
    assert.equal(result.research?.opportunities, 1);
  } finally {
    f.dispose();
  }
});

// --- R2: search results are candidates, never facts ---------------------------------------

test('search addresses come only from the url_citation annotations, never from the model’s prose', () => {
  const response = {
    choices: [
      {
        message: {
          content:
            'The official website is https://invented-by-the-model.example and they employ 400 people.',
          annotations: [
            { type: 'url_citation', url_citation: { url: 'https://kestrel.example.de/', title: 'Kestrel' } },
            { type: 'url_citation', url_citation: { url: 'https://kestrel.example.de/', title: 'Again' } },
            { type: 'url_citation', url_citation: { url: 'javascript:alert(1)', title: 'No' } },
            { type: 'url_citation', url_citation: { url: 'https://user:pw@evil.example/', title: 'No' } },
            { type: 'file', file: { url: 'https://not-a-citation.example' } },
            { type: 'url_citation', url_citation: { url: 'https://www.kompass.com/kestrel', title: 'Dir' } },
          ],
        },
      },
    ],
  };
  assert.deepEqual(searchCitations(response), [
    { url: 'https://kestrel.example.de/', title: 'Kestrel' },
    { url: 'https://www.kompass.com/kestrel', title: 'Dir' },
  ]);
  assert.deepEqual(searchCitations({ choices: [{ message: { content: 'https://x.example' } }] }), []);
  assert.deepEqual(searchCitations('not json at all'), []);
});

test('a search result that does not name the company is refused, and nothing is written', async () => {
  const namesake = 'https://kestrel-group.example.com';
  const f = fixture(
    {},
    {
      'https://example.org': trainingSite,
      // A real, readable site — of a different company with a similar name.
      [namesake]: page(namesake, 'Kestrel Group is a hotel chain with properties across Spain.'),
      'https://parked-kestrel.example.com': page(
        'https://parked-kestrel.example.com',
        'Kestrel Pump Works — this domain may be for sale.',
      ),
    },
    () => [
      { url: namesake + '/about', title: 'Kestrel Group' },
      { url: 'https://parked-kestrel.example.com', title: 'Kestrel Pump Works' },
    ],
  );
  try {
    await f.setup();
    const project = await f.project();
    const { base, lead } = await f.lead(project.id, { name: 'Kestrel Pump Works', country: 'Spain' });
    const research = await f.post(base + '/research');
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    assert.equal(outcome.discovered, false);
    assert.deepEqual(outcome.applied, []);
    assert.ok(outcome.tried.includes('kestrel-group.example.com'));
    assert.ok(
      outcome.notes.includes('kestrel-group.example.com was reachable but its page does not name this company.'),
      JSON.stringify(outcome.notes),
    );
    assert.ok(outcome.notes.some((note) => /parked-kestrel\.example\.com is a parked/.test(note)));
    assert.equal(outcome.searches?.[0].verified, '');
    const after = (await f.get(base)).body as Lead;
    assert.equal(after.website, '');
    assert.equal(after.revision, lead.revision);
  } finally {
    f.dispose();
  }
});

test('a domain never verifies itself: its own address printed on the page is not the company’s name', () => {
  assert.equal(
    pageNamesCompany('Scoped Lead', 'Welcome. Write to info@scoped-lead.com or visit https://scoped-lead.com today.'),
    false,
  );
  assert.equal(pageNamesCompany('Scoped Lead', '© scoped-lead.com 2026. All rights reserved here.'), false);
  assert.equal(pageNamesCompany('Scoped Lead', 'Scoped Lead builds pumps.'), true);
  assert.deepEqual(domainGuesses('Kestrel Pump Works GmbH', 'Germany'), [
    'kestrelpumpworks.de',
    'kestrelpumpworks.com',
    'kestrel-pump-works.de',
    'kestrel-pump-works.com',
  ]);
  assert.deepEqual(domainGuesses('Amusement Whitewater (L.L.C)', 'Dubai'), [
    'amusementwhitewater.ae',
    'amusementwhitewater.com',
    'amusement-whitewater.ae',
    'amusement-whitewater.com',
  ]);
  assert.deepEqual(domainGuesses('ABC', ''), []);
});

// --- The key goes to OpenRouter and nowhere else -------------------------------------------

test('the search key is sent only to OpenRouter’s fixed address, by POST, never through a redirect', async () => {
  const sent: Array<{ url: string; options: Record<string, unknown> }> = [];
  const search = createWebSearch((async (url: string, options: Record<string, unknown> = {}) => {
    sent.push({ url, options });
    return {
      status: 200,
      url,
      contentType: 'application/json',
      text: JSON.stringify({
        choices: [
          {
            message: {
              content: 'See https://prose.example',
              annotations: [{ type: 'url_citation', url_citation: { url: 'https://found.example/', title: 'F' } }],
            },
          },
        ],
      }),
    };
  }) as never);
  const hits = await search({ query: 'Kestrel Pump Works Germany official website', apiKey: searchKey });
  assert.deepEqual(hits, [{ url: 'https://found.example/', title: 'F' }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, searchEndpoint);
  assert.equal(new URL(sent[0].url).hostname, 'openrouter.ai');
  assert.equal(sent[0].options.method, 'POST');
  assert.equal(sent[0].options.followRedirects, false);
  assert.equal((sent[0].options.headers as Record<string, string>).Authorization, 'Bearer ' + searchKey);
  const body = JSON.parse(String(sent[0].options.body));
  assert.deepEqual(body.plugins, [{ id: 'web', max_results: searchMaxResults }]);
  assert.equal(searchMaxResults, 5);
  assert.ok(!String(sent[0].options.body).includes(searchKey), 'the key is a header, not content');

  // A refusal reports its status, never the provider's own text.
  const refused = createWebSearch((async () => ({
    status: 500,
    url: searchEndpoint,
    contentType: 'application/json',
    text: '{"error":{"message":"internal detail with ' + searchKey + '"}}',
  })) as never);
  await assert.rejects(
    refused({ query: 'x', apiKey: searchKey }),
    (error: Error) => error.message === 'Web search failed (HTTP 500).',
  );
  await assert.rejects(search({ query: 'x', apiKey: '' }), /needs an OpenRouter key/);
});

test('in the app the key reaches only the search; no page fetch, setting, log or result carries it', async () => {
  const home = 'https://kestrel-pumps.example.de';
  const f = fixture(
    {},
    { 'https://example.org': trainingSite, [home]: page(home, 'Kestrel Pump Works builds pumps with engineers.') },
    () => [{ url: home, title: 'Kestrel' }],
  );
  try {
    await f.setup();
    const project = await f.project();
    const { base, lead } = await f.lead(project.id, { name: 'Kestrel Pump Works', country: 'Germany' });
    assert.equal((await f.post(base + '/qualify')).status, 200);
    assert.ok(f.calls.search.length > 0);
    assert.ok(f.calls.search.every((call) => call.apiKey === searchKey));
    assert.ok(f.calls.fetched.every((url) => !url.includes(searchKey) && !url.includes('openrouter')));
    const settings = await f.get('/settings/research');
    assert.equal(settings.status, 200);
    assert.ok(!settings.text.includes(searchKey));
    assert.deepEqual(settings.body as ResearchSearchSettings, {
      enabled: true,
      has_key: true,
      active: true,
      model: settings.body.model,
      max_results: 5,
    });
    const stored = JSON.stringify([
      f.db.prepare('SELECT * FROM lead_research_runs').all(),
      f.db.prepare('SELECT * FROM research_log_passes').all(),
      f.db.prepare('SELECT * FROM qualification_runs').all(),
      f.db.prepare('SELECT * FROM audit_events').all(),
    ]);
    assert.ok(!stored.includes(searchKey));
    assert.ok(!(await f.get(base)).text.includes(searchKey));
    assert.ok(!(await f.get('/projects/' + project.id + '/research-log?lead_id=' + lead.id)).text.includes(searchKey));
  } finally {
    f.dispose();
  }
});

// --- The setting ------------------------------------------------------------------------------

test('"Use web search in research" turns search off: no search runs, and the research says so', async () => {
  const f = fixture({}, { 'https://example.org': trainingSite }, () => [
    { url: 'https://should-not-be-used.example', title: 'x' },
  ]);
  try {
    await f.setup();
    const project = await f.project();
    const off = await f.put('/settings/research', { web_search: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.deepEqual(
      { enabled: off.body.enabled, has_key: off.body.has_key, active: off.body.active },
      { enabled: false, has_key: true, active: false },
    );
    assert.equal((await f.put('/settings/research', { web_search: 'no' })).status, 400);
    const { base } = await f.lead(project.id, { name: 'Quiet Valve Works', country: 'Germany' });
    const outcome = (await f.post(base + '/research')).body as ResearchOutcome;
    assert.equal(f.calls.search.length, 0);
    assert.deepEqual(outcome.searches, []);
    assert.ok(
      outcome.notes.some((note) => /Web search is turned off in Settings/.test(note)),
      JSON.stringify(outcome.notes),
    );
    // The fallback still runs: likely addresses for the name, each verified.
    assert.deepEqual(outcome.tried, [
      'quietvalveworks.de',
      'quietvalveworks.com',
      'quiet-valve-works.de',
      'quiet-valve-works.com',
    ]);
    // On again: the next pass searches.
    assert.equal((await f.put('/settings/research', { web_search: true })).body.active, true);
    const { base: second } = await f.lead(project.id, { name: 'Loud Valve Works', country: 'Germany' });
    await f.post(second + '/research');
    assert.equal(f.calls.search.length, 1);
  } finally {
    f.dispose();
  }
  // With no key at all there is nothing to search with, whatever the setting says.
  const bare = fixture({}, { 'https://example.org': trainingSite }, () => []);
  try {
    await bare.setup(false);
    const project = await bare.project();
    const settings = (await bare.get('/settings/research')).body as ResearchSearchSettings;
    assert.deepEqual([settings.enabled, settings.has_key, settings.active], [true, false, false]);
    const { base } = await bare.lead(project.id, { name: 'Keyless Valve Works', country: 'Germany' });
    const outcome = (await bare.post(base + '/research')).body as ResearchOutcome;
    assert.equal(bare.calls.search.length, 0);
    assert.ok(outcome.notes.some((note) => /No OpenRouter key is set up for web search/.test(note)));
  } finally {
    bare.dispose();
  }
});

// --- R4: a person in the record -----------------------------------------------------------

test('a person in the record: the employer counts only when its own team page names them; a profile is never fetched', async () => {
  const employer = 'https://weber-maschinen.example.de';
  const team = employer + '/team';
  const news = 'https://news.example.com/2024/hannah-weber-joins';
  const teamText =
    'Our team. Hannah Weber, Head of Purchasing, leads supplier selection for all pump lines at Weber Maschinen.';
  const f = fixture(
    {
      extract: (input) => {
        assert.equal(input.person_in_record, 'Hannah Weber');
        return {
          fields: [
            { field: 'contact_name', value: 'Hannah Weber', evidence: 'Hannah Weber, Head of Purchasing, leads supplier selection for all pump lines at Weber Maschinen.', page_url: team },
            { field: 'contact_role', value: 'Head of Purchasing', evidence: 'Hannah Weber, Head of Purchasing, leads supplier selection for all pump lines at Weber Maschinen.', page_url: team },
            { field: 'industry', value: 'Pump manufacturing', evidence: 'Weber Maschinen designs and builds pump manufacturing lines in Stuttgart.', page_url: employer },
          ],
          notes: [],
        };
      },
    },
    {
      'https://example.org': trainingSite,
      // A news story naming her proves nothing about where she works.
      [news]: page(news, 'Industry news: Hannah Weber spoke at a trade fair about procurement.'),
      [team]: page(team, teamText),
      [employer]: page(employer, 'Weber Maschinen designs and builds pump manufacturing lines in Stuttgart.'),
    },
    () => [
      { url: 'https://de.linkedin.com/in/hannah-weber-123', title: 'Hannah Weber | LinkedIn' },
      { url: news, title: 'Hannah Weber joins' },
      { url: team, title: 'Team | Weber Maschinen' },
    ],
  );
  try {
    await f.setup();
    const project = await f.project();
    const { base, lead } = await f.lead(project.id, { name: 'Hannah Weber', country: 'Germany' });
    assert.ok(looksLikePerson(lead));
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.deepEqual(f.calls.search.map((call) => call.query), ['"Hannah Weber" Germany company']);
    assert.ok(!f.calls.fetched.some((url) => url.includes('linkedin')), f.calls.fetched.join());
    const after = (await f.get(base)).body as Lead;
    assert.equal(after.website, employer);
    assert.equal(after.contact_name, 'Hannah Weber');
    assert.equal(after.contact_role, 'Head of Purchasing');
    assert.equal(after.industry, 'Pump manufacturing');
    assert.equal(after.revision, lead.revision + 1);
    const result = qualified.body.result as Qualification;
    assert.equal(result.research?.person_record, true);
    assert.equal(f.calls.qualify[0].research_before_evaluation?.record_names_person, true);
    assert.equal(result.decision, 'QUALIFIED');
    const search = result.research?.searches?.[0];
    assert.equal(search?.purpose, 'person');
    assert.equal(search?.verified, 'weber-maschinen.example.de');
    assert.ok(search?.results.includes('de.linkedin.com (profile; cannot be read)'));
    const [pass] = await researchLog(f, project.id, lead.id);
    assert.ok(pass.notes.some((note) => /not one of the site’s own about, team or contact pages/.test(note)));
    assert.ok(pass.notes.some((note) => /profiles cannot be read/.test(note)));
    // A name that is a company is not taken for a person.
    for (const name of ['Kestrel Pump Works', 'Meridian Vacuum Systems', 'ACME GMBH', 'Weber & Sohn'])
      assert.equal(looksLikePerson({ name, website: '', industry: '', contact_name: '' }), false, name);
    assert.equal(
      looksLikePerson({ name: 'Weber Maschinen', website: '', industry: '', contact_name: 'Weber Maschinen' }),
      true,
      'the contact’s own name entered as the company is a person',
    );
  } finally {
    f.dispose();
  }
});

test('a person whose search finds no company page stays unjudged, and no address is guessed from their name', async () => {
  const f = fixture({}, { 'https://example.org': trainingSite }, () => [
    { url: 'https://www.linkedin.com/in/jonas-brandt', title: 'Jonas Brandt' },
  ]);
  try {
    await f.setup();
    const project = await f.project();
    const { base } = await f.lead(project.id, { name: 'Jonas Brandt', country: 'Germany' });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const result = qualified.body.result as Qualification;
    assert.equal(result.decision, 'NEEDS_REVIEW');
    assert.match(result.blockers![0], /^Not enough found to judge: /);
    assert.match(result.blockers![0], /“"Jonas Brandt" Germany company”/);
    assert.ok(!f.calls.fetched.some((url) => /jonasbrandt|jonas-brandt/.test(url)), f.calls.fetched.join());
  } finally {
    f.dispose();
  }
});

// --- R5: the opportunity outweighs an organisation-type exclusion -------------------------

test('an evidenced opportunity is never excluded on the kind of organisation alone', () => {
  const snapshot: TrainingSnapshot = {
    project: { name: 'Status Research', description: '', website: '' },
    rubric: {
      summary: 'Find pump users.',
      criteria: ['Runs pumps', 'Has engineers', 'Plans an expansion', 'Exports', 'Has a test bench'],
      exclusions: ['Nonprofit organisations', 'Manufactures bearings'],
      questions: [],
    },
    sources: [],
  };
  const evidence: Evidence[] = [
    { id: 'E1', kind: 'lead_record', title: 'Record', url: '', content: '{}', captured_at: '' },
    { id: 'E2', kind: 'website', title: 'site/', url: 'https://water.example/', content: 'x', captured_at: '' },
  ];
  const answer = (opportunity: boolean, excluded: number) => ({
    decision: 'NOT_A_TARGET',
    score: 0,
    confidence: 70,
    summary: 'A water charity running pumping stations.',
    criteria: snapshot.rubric.criteria.map((criterion, index) => ({
      criterion,
      outcome: index < 3 ? 'MATCH' : 'UNKNOWN',
      evidence: 'The site says so.',
      source_ids: index < 3 ? ['E2'] : [],
    })),
    exclusions: snapshot.rubric.exclusions.map((criterion, index) => ({
      criterion,
      outcome: index === excluded ? 'MATCH' : 'NO_MATCH',
      evidence: 'The site says so.',
      source_ids: ['E2'],
    })),
    gaps: [],
    next_steps: [],
    opportunity: opportunity
      ? { summary: 'It is replacing twelve pumping stations in 2026.', source_ids: ['E2'] }
      : { summary: '', source_ids: [] },
  });
  const judge = (raw: unknown) => validateQualification(raw, snapshot, evidence, { name: 'Water' });
  // A nonprofit with an evidenced opportunity: not excluded; at 60 the unverified exclusion
  // holds it for a person instead.
  const kept = judge(answer(true, 0));
  assert.equal(kept.exclusions[0].outcome, 'UNKNOWN');
  assert.equal(kept.score, 60);
  assert.equal(kept.decision, 'NEEDS_REVIEW');
  assert.deepEqual(kept.blockers, ['Could not verify the exclusion: Nonprofit organisations']);
  assert.ok(kept.gaps.some((gap) => gap.startsWith('Not counted as met: Nonprofit organisations')));
  // Without an opportunity the exclusion stands.
  const out = judge(answer(false, 0));
  assert.equal(out.decision, 'NOT_A_TARGET');
  assert.equal(out.score, 0);
  // An exclusion about what the company does is not an organisation type: it still excludes.
  const bearings = judge(answer(true, 1));
  assert.equal(bearings.exclusions[1].outcome, 'MATCH');
  assert.equal(bearings.decision, 'NOT_A_TARGET');
});

// --- R7: research is reused, not repeated ---------------------------------------------------

test('research is not repeated on the same revision — not by a new run, a job, or a re-import', async () => {
  const home = 'https://kestrel-pumps.example.de';
  const f = fixture(
    {},
    {
      'https://example.org': trainingSite,
      [home]: page(home, 'Kestrel Pump Works manufactures centrifugal pumps. Our engineers design them.'),
    },
    () => [{ url: home, title: 'Kestrel' }],
  );
  try {
    await f.setup();
    let project = await f.project();
    const { base, lead } = await f.lead(project.id, { name: 'Kestrel Pump Works', country: 'Germany' });
    // Manual research fills the website, which makes a new revision: the one research created.
    const researched = (await f.post(base + '/research')).body as ResearchOutcome;
    assert.deepEqual(researched.applied, ['website']);
    assert.equal(f.calls.search.length, 1);
    assert.equal(f.calls.extract.length, 1);
    const revision = ((await f.get(base)).body as Lead).revision;
    assert.equal(revision, lead.revision + 1);

    // A qualification of that revision reuses the pass.
    const first = (await f.post(base + '/qualify')).body.result as Qualification;
    assert.equal(first.research?.ran, false);
    assert.equal(f.calls.search.length, 1);
    assert.equal(f.calls.extract.length, 1);

    // New training makes the result stale; the job that requalifies it still reuses the research.
    project = await f.publish(project, { ...rubric, summary: rubric.summary + ' Updated.' });
    const started = await f.post('/projects/' + project.id + '/qualification-jobs', { scope: 'stale' });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(await f.jobs.drain(project.id), 'finished');
    const job = (await f.get('/projects/' + project.id + '/qualification-jobs/current'))
      .body as QualificationJobState;
    assert.equal(job.job?.done, 1);
    assert.equal(f.calls.search.length, 1);
    assert.equal(f.calls.extract.length, 1);
    assert.equal(f.calls.qualify.length, 2);

    // "Every lead" leaves a lead already Qualified on this training alone.
    const again = await f.post('/projects/' + project.id + '/qualification-jobs', { scope: 'all' });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(f.calls.qualify.length, 2);

    // Importing the same row again finds the lead: nothing new, the revision does not move, and
    // the website research found, written another way, is not a change either.
    const imported = await f.post('/projects/' + project.id + '/leads/import/rows', {
      on_duplicate: 'update',
      leads: [
        { name: 'Kestrel Pump Works', country: 'Germany' },
        { name: 'Kestrel Pump Works GmbH', website: 'https://www.kestrel-pumps.example.de/', country: 'Germany' },
      ],
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.deepEqual(imported.body.created_ids, []);
    assert.equal(imported.body.updated, 0);
    const leads = (await f.get('/projects/' + project.id + '/leads?status=ALL')).body as {
      total: number;
    };
    assert.equal(leads.total, 1);
    const after = (await f.get(base)).body as Lead;
    assert.equal(after.revision, revision);
    assert.equal(after.stale, false);
    assert.equal(after.status, 'QUALIFIED');
    // And a further run on that revision still does not research.
    const third = (await f.post(base + '/qualify')).body.result as Qualification;
    assert.equal(third.research?.ran, false);
    assert.equal(f.calls.search.length, 1);
    assert.equal(f.calls.extract.length, 1);
  } finally {
    f.dispose();
  }
});

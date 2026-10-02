import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { leadServiceFit, validateQualification, type Generate } from '../server/ai';
import { rubricSchema } from '../server/validation';
import type {
  Evidence,
  Lead,
  Project,
  Qualification,
  Rubric,
  Run,
  TrainingSnapshot,
} from '../shared/types';
import type { LeadFacetOptions } from '../shared/lead-filters';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;

const categories = [
  {
    name: 'Website development',
    description: 'An outdated or missing website, or no way to order online.',
  },
  { name: 'App development', description: 'Field staff or customers who would use an app.' },
  { name: 'Marketing support', description: 'No visible campaigns or social presence.' },
];
const rubric: Rubric = {
  summary: 'Find small manufacturers that need digital services.',
  criteria: ['Manufactures its own products', 'Sells to businesses'],
  exclusions: ['Is a digital agency itself'],
  questions: [],
  categories,
};

// --- The rubric ---------------------------------------------------------------------------

test('a rubric reads with or without service categories, and names must differ', () => {
  const { categories: _left, ...older } = rubric;
  // Stored rubrics and published snapshots from before categories offer none.
  assert.deepEqual(rubricSchema.parse(older).categories, []);
  assert.deepEqual(rubricSchema.parse(rubric).categories, categories);
  // A category without a description is still a category.
  assert.deepEqual(
    rubricSchema.parse({ ...rubric, categories: [{ name: 'AI engineering' }] }).categories,
    [{ name: 'AI engineering', description: '' }],
  );
  const repeated = rubricSchema.safeParse({
    ...rubric,
    categories: [...categories, { name: '  website   DEVELOPMENT ', description: '' }],
  });
  assert.equal(repeated.success, false);
  assert.match(JSON.stringify(repeated.error?.issues), /different name/);
  assert.equal(
    rubricSchema.safeParse({
      ...rubric,
      categories: Array.from({ length: 13 }, (_, i) => ({ name: 'Service ' + i, description: '' })),
    }).success,
    false,
  );
  assert.equal(
    rubricSchema.safeParse({ ...rubric, categories: [{ name: 'x'.repeat(81), description: '' }] })
      .success,
    false,
  );
  assert.equal(
    rubricSchema.safeParse({
      ...rubric,
      categories: [{ name: 'Websites', description: 'x'.repeat(601) }],
    }).success,
    false,
  );
});

// --- Service fit on a qualification -------------------------------------------------------

const snapshot: TrainingSnapshot = {
  project: { name: 'Digital Services', description: '', website: '' },
  rubric,
  sources: [],
};
const recordItem: Evidence = {
  id: 'E1',
  kind: 'lead_record',
  title: 'User-provided lead record (unverified)',
  url: '',
  content: '{"name":"Fit Works"}',
  captured_at: '2026-10-01T00:00:00.000Z',
};
const pageItem: Evidence = {
  id: 'E2',
  kind: 'website',
  title: 'fit-works.example.com/',
  url: 'https://fit-works.example.com/',
  content: 'Fit Works makes garden tools. Orders by fax only.',
  captured_at: '2026-10-01T00:00:00.000Z',
};
/** Both criteria met from the page, the exclusion cleared, and the given service ratings. */
function answer(serviceFit: unknown, extra: Record<string, unknown> = {}) {
  return {
    decision: 'QUALIFIED',
    score: 100,
    confidence: 80,
    summary: 'A tool maker that takes orders by fax.',
    criteria: rubric.criteria.map((criterion) => ({
      criterion,
      outcome: 'MATCH',
      evidence: 'The home page says so.',
      source_ids: ['E2'],
    })),
    exclusions: rubric.exclusions.map((criterion) => ({
      criterion,
      outcome: 'NO_MATCH',
      evidence: 'A tool maker, not an agency.',
      source_ids: ['E2'],
    })),
    gaps: [],
    next_steps: [],
    service_fit: serviceFit,
    ...extra,
  };
}
const judge = (raw: unknown, training = snapshot) =>
  validateQualification(raw, training, [recordItem, pageItem], { name: 'Fit Works' });

test('a good or possible fit stands only with a retrieved source', () => {
  const result = judge(
    answer([
      {
        category: 'Website development',
        fit: 'GOOD',
        reason: 'Orders are taken by fax only.',
        source_ids: ['E2'],
      },
      // Written another way, the citation is still the page.
      {
        category: 'App development',
        fit: 'possible',
        reason: 'Sells to garden centres.',
        source_ids: ['https://fit-works.example.com'],
      },
      {
        category: 'Marketing support',
        fit: 'GOOD',
        reason: 'The record says they never advertise.',
        source_ids: ['E1'],
      },
    ]),
  );
  assert.deepEqual(result.service_fit, [
    {
      category: 'Website development',
      fit: 'GOOD',
      reason: 'Orders are taken by fax only.',
      source_ids: ['E2'],
    },
    {
      category: 'App development',
      fit: 'POSSIBLE',
      reason: 'Sells to garden centres.',
      source_ids: ['E2'],
    },
    // The lead record alone proves no need.
    {
      category: 'Marketing support',
      fit: 'NONE',
      reason: 'No website evidence was cited for this.',
      source_ids: ['E1'],
    },
  ]);
  assert.ok(
    result.gaps.includes(
      'No retrieved source for the service fit: Marketing support (only the unverified lead record was cited)',
    ),
    JSON.stringify(result.gaps),
  );
  // The fit score and decision are untouched by service fit.
  assert.equal(result.score, 100);
  assert.equal(result.decision, 'QUALIFIED');
  assert.deepEqual(leadServiceFit(result.service_fit), [
    { category: 'Website development', fit: 'GOOD' },
    { category: 'App development', fit: 'POSSIBLE' },
  ]);
});

test('a category left out is Not assessed, and the answer is matched to the training’s names', () => {
  const result = judge(
    answer([
      // Another order, another case and a number: still the training's category.
      { category: '2. app DEVELOPMENT', fit: 'GOOD', reason: 'Has a field sales team.', source_ids: ['E2'] },
      // A category the training does not name is not kept.
      { category: 'Logo design', fit: 'GOOD', reason: 'Plain logo.', source_ids: ['E2'] },
      // An unreadable entry is dropped on its own, not the evaluation.
      { category: 'Website development', fit: 'MAYBE', reason: '', source_ids: ['E2'] },
    ]),
  );
  assert.deepEqual(
    result.service_fit?.map((item) => [item.category, item.fit, item.reason]),
    [
      ['Website development', 'NONE', 'Not assessed'],
      ['App development', 'GOOD', 'Has a field sales team.'],
      ['Marketing support', 'NONE', 'Not assessed'],
    ],
  );
  // An invented citation loses the rating, with its own gap.
  const invented = judge(
    answer([{ category: 'Website development', fit: 'GOOD', reason: 'Fax.', source_ids: ['E9'] }]),
  );
  assert.equal(invented.service_fit?.[0].fit, 'NONE');
  assert.ok(
    invented.gaps.includes(
      'The AI cited a source that was not supplied for the service fit: Website development; it was not counted.',
    ),
  );
  // A model that leaves service_fit out, or writes null, has rated nothing.
  for (const missing of [undefined, null, 'none'])
    assert.deepEqual(
      judge(answer(missing)).service_fit?.map((item) => item.fit),
      ['NONE', 'NONE', 'NONE'],
    );
});

test('an excluded lead keeps no service fit, and a training without categories rates nothing', () => {
  const raw = answer([
    { category: 'Website development', fit: 'GOOD', reason: 'Fax only.', source_ids: ['E2'] },
  ]);
  raw.exclusions[0] = {
    ...raw.exclusions[0],
    outcome: 'MATCH',
    evidence: 'The page says they are a web agency.',
  };
  const excluded = judge(raw);
  assert.equal(excluded.decision, 'NOT_A_TARGET');
  assert.deepEqual(
    excluded.service_fit?.map((item) => item.fit),
    ['NONE', 'NONE', 'NONE'],
  );
  assert.deepEqual(leadServiceFit(excluded.service_fit), []);
  const plain = judge(
    answer([{ category: 'Website development', fit: 'GOOD', reason: 'x', source_ids: ['E2'] }]),
    { ...snapshot, rubric: { ...rubric, categories: undefined } },
  );
  assert.deepEqual(plain.service_fit, []);
});

test('the team’s own lead list can show a service need, like a page can', () => {
  const listItem: Evidence = {
    id: 'E3',
    kind: 'provided_list',
    title: 'Your lead list (provided data)',
    url: '',
    content: 'Event: Hannover Messe 2026\nApp: none listed',
    captured_at: '2026-10-01T00:00:00.000Z',
  };
  const result = validateQualification(
    answer([
      {
        category: 'App development',
        fit: 'POSSIBLE',
        reason: 'The list says they have no app for the fair.',
        source_ids: ['E3'],
      },
    ]),
    snapshot,
    [recordItem, pageItem, listItem],
    { name: 'Fit Works' },
  );
  assert.deepEqual(result.service_fit?.[1], {
    category: 'App development',
    fit: 'POSSIBLE',
    reason: 'The list says they have no app for the fair.',
    source_ids: ['E3'],
  });
  assert.deepEqual(leadServiceFit(result.service_fit), [
    { category: 'App development', fit: 'POSSIBLE' },
  ]);
});

// --- Through the API ----------------------------------------------------------------------

const trainingSite = 'Example Digital builds websites, apps and campaigns for manufacturers.';
function fixture(options: { proposal?: unknown } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-service-fit-'));
  const prompts: Array<{ system: string; input: unknown }> = [];
  /** The ratings the next qualifications return, by lead name. */
  const ratings = new Map<string, Array<{ category: string; fit: string }>>();
  const generate: Generate = async (_config, system, input) => {
    prompts.push({ system, input });
    if (system.includes('proposed qualification rubric')) return options.proposal ?? rubric;
    if (system.includes('candidate official website domains')) return { domains: [] };
    if (system.includes('extract company facts')) return { fields: [], notes: [] };
    const typed = input as {
      approved_training: TrainingSnapshot;
      lead: { name: string };
      evidence: Evidence[];
    };
    const page = typed.evidence.find((item) => item.kind === 'website')?.id ?? 'E1';
    return {
      ...answer([]),
      criteria: typed.approved_training.rubric.criteria.map((criterion) => ({
        criterion,
        outcome: 'MATCH',
        evidence: 'The home page says so.',
        source_ids: [page],
      })),
      exclusions: typed.approved_training.rubric.exclusions.map((criterion) => ({
        criterion,
        outcome: 'NO_MATCH',
        evidence: 'Not an agency.',
        source_ids: [page],
      })),
      service_fit: (ratings.get(typed.lead.name) || []).map((item) => ({
        ...item,
        reason: 'The home page shows it.',
        source_ids: [page],
      })),
    };
  };
  const { app, db } = createApp({
    dataDir: dir,
    generate,
    fetchWebsite: async (url) => ({
      url,
      content: url.includes('example.org') ? trainingSite : 'A manufacturer. ' + url,
      truncated: false,
      links: [],
    }),
  });
  const agent = request.agent(app);
  let csrf = '';
  const send = (method: 'post' | 'put', url: string, body: object = {}) =>
    agent[method]('/api' + url)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf)
      .send(body);
  return {
    app,
    db,
    agent,
    prompts,
    ratings,
    post: (url: string, body: object = {}) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    get: (url: string) => agent.get('/api' + url),
    async setup() {
      const response = await send('post', '/auth/setup', {
        name: 'Fit Administrator',
        username: 'fit-admin',
        password: 'A-long-service-fit-password-2026',
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      csrf = response.body.csrf_token;
    },
    dispose() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
/** A project whose library is ready to publish, with its draft revision. */
async function libraryProject(f: Fixture) {
  const created = await f.post('/projects', { name: 'Digital Services', website: 'https://example.org' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id as number;
  let project: Project = (await f.get('/projects/' + id)).body.project;
  assert.equal(
    (
      await f.post('/projects/' + id + '/sources', {
        revision: project.revision,
        title: 'Criteria documents',
        content: 'We sell website development, app development and marketing support.',
      })
    ).status,
    201,
  );
  project = (await f.get('/projects/' + id)).body.project;
  assert.equal(
    (
      await f.post('/projects/' + id + '/sources/website', {
        revision: project.revision,
        url: 'https://example.org',
      })
    ).status,
    201,
  );
  return (await f.get('/projects/' + id)).body.project as Project;
}
async function publishedProject(f: Fixture, training: Rubric = rubric) {
  const project = await libraryProject(f);
  const saved = await f.put('/projects/' + project.id + '/training/rubric', {
    revision: project.revision,
    rubric: training,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const published = await f.post('/projects/' + project.id + '/training/publish', {
    revision: saved.body.revision,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return published.body as Project;
}

test('Train AI proposes service categories, tidied, and they publish with the version', async () => {
  const f = fixture({
    proposal: {
      ...rubric,
      categories: [
        ...categories,
        // A repeat and a nameless entry are dropped; a bare name is a category without a description.
        { name: 'WEBSITE DEVELOPMENT', description: 'Again.' },
        { name: '', description: 'Nothing to call it.' },
        'AI engineering',
      ],
    },
  });
  try {
    await f.setup();
    const project = await libraryProject(f);
    const analyzed = await f.post('/projects/' + project.id + '/training/analyze', {
      revision: project.revision,
    });
    assert.equal(analyzed.status, 200, JSON.stringify(analyzed.body));
    assert.deepEqual(analyzed.body.rubric.categories, [
      ...categories,
      { name: 'AI engineering', description: '' },
    ]);
    assert.match(f.prompts[0].system, /service categories/);
    // A person saves and publishes the draft; the categories travel with the version.
    const duplicate = await f.put('/projects/' + project.id + '/training/rubric', {
      revision: project.revision,
      rubric: { ...rubric, categories: [...categories, { name: 'app development' }] },
    });
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.body.error, /different name/);
    const saved = await f.put('/projects/' + project.id + '/training/rubric', {
      revision: project.revision,
      rubric: analyzed.body.rubric,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((saved.body as Project).rubric.categories?.length, 4);
    const published = await f.post('/projects/' + project.id + '/training/publish', {
      revision: saved.body.revision,
    });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const version = await f.get('/projects/' + project.id + '/training/versions/1');
    assert.deepEqual(
      (version.body.snapshot as TrainingSnapshot).rubric.categories?.map((item) => item.name),
      ['Website development', 'App development', 'Marketing support', 'AI engineering'],
    );
  } finally {
    f.dispose();
  }
});

test('the lead keeps its current service fit for the list, the Service fit filter and the export', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await publishedProject(f);
    const base = '/projects/' + project.id + '/leads';
    const add = async (name: string, website: string) => {
      const created = await f.post(base, { name, website });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body as Lead;
    };
    const fax = await add('Fax Tools', 'https://fax-tools.example.com');
    const field = await add('Field Pumps', 'https://field-pumps.example.com');
    const quiet = await add('Quiet Metals', 'https://quiet-metals.example.com');
    await add('Never Analysed', 'https://never.example.com');
    f.ratings.set('Fax Tools', [
      { category: 'Marketing support', fit: 'POSSIBLE' },
      { category: 'Website development', fit: 'GOOD' },
      { category: 'App development', fit: 'POSSIBLE' },
    ]);
    f.ratings.set('Field Pumps', [{ category: 'App development', fit: 'GOOD' }]);
    f.ratings.set('Quiet Metals', [{ category: 'Website development', fit: 'NONE' }]);
    for (const lead of [fax, field, quiet]) {
      const qualified = await f.post(base + '/' + lead.id + '/qualify');
      assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    }
    // The model was handed the categories with the published training.
    const input = f.prompts.at(-1)!.input as { approved_training: TrainingSnapshot };
    assert.equal(input.approved_training.rubric.categories?.length, 3);
    assert.match(f.prompts.at(-1)!.system, /service_fit/);

    // GOOD first, then POSSIBLE, in the training's order within each.
    const detail = (await f.get(base + '/' + fax.id)).body as Lead & { runs: Run[] };
    assert.deepEqual(detail.service_fit, [
      { category: 'Website development', fit: 'GOOD' },
      { category: 'App development', fit: 'POSSIBLE' },
      { category: 'Marketing support', fit: 'POSSIBLE' },
    ]);
    assert.equal((detail.runs[0].result as Qualification).service_fit?.length, 3);
    const row = f.db
      .prepare('SELECT service_fit FROM leads WHERE id=?')
      .get(fax.id) as { service_fit: string };
    assert.deepEqual(JSON.parse(row.service_fit), detail.service_fit);

    const names = async (query: string) => {
      const response = await f.get(base + '?page_size=100&' + query);
      assert.equal(response.status, 200, query + ' → ' + JSON.stringify(response.body));
      return (response.body.leads as Lead[]).map((lead) => lead.name).sort();
    };
    assert.deepEqual(await names('service_fit=App%20development'), ['Fax Tools', 'Field Pumps']);
    // Case does not matter, and values within the facet OR together.
    assert.deepEqual(await names('service_fit=website%20DEVELOPMENT'), ['Fax Tools']);
    assert.deepEqual(
      await names('service_fit=Website%20development&service_fit=App%20development'),
      ['Fax Tools', 'Field Pumps'],
    );
    assert.deepEqual(await names('service_fit=Marketing%20support'), ['Fax Tools']);
    // The values are bound, never spliced: a quote in one is just a name nothing holds.
    assert.deepEqual(await names("service_fit=x')%20OR%201%3D1--"), []);

    const options = (await f.get('/projects/' + project.id + '/lead-facets'))
      .body as LeadFacetOptions;
    assert.deepEqual(options.service_fit, [
      { value: 'Website development', count: 1 },
      { value: 'App development', count: 2 },
      { value: 'Marketing support', count: 1 },
    ]);

    const exported = await f.agent.get('/api' + base + '/export?service_fit=App%20development');
    assert.equal(exported.status, 200);
    const [header, ...lines] = exported.text.replace(/^﻿/, '').split('\r\n');
    assert.ok(header.includes('"service_fit"'));
    assert.equal(lines.filter(Boolean).length, 2);
    assert.ok(
      exported.text.includes(
        '"Website development (good); App development (possible); Marketing support (possible)"',
      ),
    );

    // Editing the lead supersedes its result: still shown (stale), no longer filtered on.
    const edited = await f.put(base + '/' + field.id, {
      revision: field.revision,
      name: 'Field Pumps',
      website: 'https://field-pumps.example.com',
      city: 'Leeds',
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const stale = (await f.get(base + '/' + field.id)).body as Lead;
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.service_fit, [{ category: 'App development', fit: 'GOOD' }]);
    assert.deepEqual(await names('service_fit=App%20development'), ['Fax Tools']);
    const after = (await f.get('/projects/' + project.id + '/lead-facets')).body as LeadFacetOptions;
    assert.equal(after.service_fit.find((item) => item.value === 'App development')?.count, 1);

    // Requalifying replaces the stored fit with the new run's.
    f.ratings.set('Field Pumps', []);
    assert.equal((await f.post(base + '/' + field.id + '/qualify')).status, 200);
    assert.deepEqual(((await f.get(base + '/' + field.id)).body as Lead).service_fit, []);
  } finally {
    f.dispose();
  }
});

test('a project without categories offers no Service fit values and stores none', async () => {
  const { categories: _none, ...plain } = rubric;
  const f = fixture();
  try {
    await f.setup();
    const project = await publishedProject(f, plain as Rubric);
    const base = '/projects/' + project.id + '/leads';
    const created = await f.post(base, { name: 'Plain Tools', website: 'https://plain.example.com' });
    f.ratings.set('Plain Tools', [{ category: 'Website development', fit: 'GOOD' }]);
    const qualified = await f.post(base + '/' + created.body.id + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.deepEqual((qualified.body.result as Qualification).service_fit, []);
    assert.deepEqual(((await f.get(base + '/' + created.body.id)).body as Lead).service_fit, []);
    const options = (await f.get('/projects/' + project.id + '/lead-facets'))
      .body as LeadFacetOptions;
    assert.deepEqual(options.service_fit, []);
  } finally {
    f.dispose();
  }
});

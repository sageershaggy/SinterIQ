import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { validateQualification, type Generate } from '../server/ai';
import type { Evidence, Lead, Project, Run, TrainingSnapshot } from '../shared/types';
import type { ResearchProfile } from '../shared/research';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;

const rubric = {
  summary: 'Find community organisations that run services in New York.',
  criteria: ['Runs community services'],
  exclusions: ['Is a government agency'],
  questions: [],
};
const home = 'https://camba.example.org';
const headquarters = 'CAMBA has its headquarters at 1720 Church Avenue, Brooklyn, NY 11226.';
const pageText =
  'CAMBA runs housing, legal and youth services. ' +
  headquarters +
  ' CAMBA employs 1,800 people across the city.';

// --- Which reported conflicts are kept ------------------------------------------------------

const snapshot: TrainingSnapshot = {
  project: { name: 'Community Research', description: '', website: '' },
  rubric,
  sources: [],
};
const recordItem: Evidence = {
  id: 'E1',
  kind: 'lead_record',
  title: 'User-provided lead record (unverified)',
  url: '',
  content: '{"name":"CAMBA","city":"Arverne"}',
  captured_at: '2026-10-01T00:00:00.000Z',
};
const pageItem: Evidence = {
  id: 'E2',
  kind: 'website',
  title: 'camba.example.org/',
  url: home + '/',
  content: pageText,
  captured_at: '2026-10-01T00:00:00.000Z',
};
const record = {
  city: 'Arverne',
  country: 'United States',
  industry: 'Nonprofit',
  employee_count: '200',
};
function answer(conflicts: unknown) {
  return {
    decision: 'QUALIFIED',
    score: 100,
    confidence: 80,
    summary: 'The record says Arverne; the company’s website gives Brooklyn, NY.',
    criteria: [
      {
        criterion: rubric.criteria[0],
        outcome: 'MATCH',
        evidence: 'Runs housing and youth services.',
        source_ids: ['E2'],
      },
    ],
    exclusions: [
      {
        criterion: rubric.exclusions[0],
        outcome: 'NO_MATCH',
        evidence: 'A nonprofit.',
        source_ids: ['E2'],
      },
    ],
    gaps: [],
    next_steps: [],
    conflicts,
  };
}
const brooklyn = {
  field: 'city',
  record_value: 'Arverne',
  found_value: 'Brooklyn, NY',
  quote: headquarters,
  source_ids: ['E2'],
};
/** `given` null evaluates with no record at all. */
const judge = (conflicts: unknown, given: Partial<typeof record> | null = record) =>
  validateQualification(answer(conflicts), snapshot, [recordItem, pageItem], {
    name: 'CAMBA',
    record: given ?? undefined,
  }).conflicts;

test('a conflict is kept with a quote that is on the cited page and states the value', () => {
  assert.deepEqual(judge([brooklyn]), [brooklyn]);
  // The record value is matched ignoring case and spacing, and stored as the record has it; the
  // page can be cited by its address, and the quote may be spaced differently from the page.
  assert.deepEqual(
    judge([
      {
        ...brooklyn,
        record_value: '  arverne ',
        quote: 'CAMBA has its headquarters at 1720 Church Avenue,\n Brooklyn, NY 11226.',
        source_ids: [home],
      },
    ]),
    [{ ...brooklyn, quote: headquarters }],
  );
  // A headcount needs a sentence about people, and the number in it.
  assert.deepEqual(
    judge([
      {
        field: 'employee_count',
        record_value: '200',
        found_value: '1,800',
        quote: 'CAMBA employs 1,800 people across the city.',
        source_ids: ['E2'],
      },
    ])?.map((item) => [item.field, item.found_value]),
    [['employee_count', '1,800']],
  );
  // Without the record it was evaluated against, no conflict can be checked.
  assert.deepEqual(judge([brooklyn], null), []);
  // An answer without the field has reported none.
  assert.deepEqual(judge(undefined), []);
});

test('a conflict that cannot be verified is dropped, with no gap', () => {
  const dropped = [
    // The quote is not on the page.
    { ...brooklyn, quote: 'CAMBA moved its headquarters to Brooklyn, NY last year.' },
    // The record does not hold that value.
    { ...brooklyn, record_value: 'Queens' },
    // The quote does not contain the value.
    { ...brooklyn, found_value: 'Manhattan, NY' },
    // The lead form would not accept the value.
    {
      ...brooklyn,
      found_value: 'Brooklyn, NY '.repeat(11),
      quote: headquarters.replace('Brooklyn, NY', 'Brooklyn, NY '.repeat(11)),
    },
    // Only the lead record is cited.
    { ...brooklyn, source_ids: ['E1'] },
    // A source that was never supplied.
    { ...brooklyn, source_ids: ['E7'] },
    // Not a detail a conflict may change.
    { ...brooklyn, field: 'website' },
    { ...brooklyn, field: 'contact_email' },
    // The same value, written differently, is no conflict.
    { ...brooklyn, record_value: 'Arverne', found_value: 'ARVERNE' },
  ];
  for (const item of dropped) assert.deepEqual(judge([item]), [], JSON.stringify(item));
  const result = validateQualification(answer(dropped), snapshot, [recordItem, pageItem], {
    name: 'CAMBA',
    record,
  });
  assert.deepEqual(result.gaps, []);
  // A blank record field has no conflict: research fills blanks.
  assert.deepEqual(judge([{ ...brooklyn, record_value: '' }], { ...record, city: '' }), []);
  // One per field: the first that verifies.
  assert.deepEqual(
    judge([{ ...brooklyn, quote: 'Not on the page at all, in Brooklyn, NY.' }, brooklyn, brooklyn]),
    [brooklyn],
  );
});

// --- Using the website's value -------------------------------------------------------------

const trainingSite = 'Example Research finds community organisations in New York.';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-conflicts-'));
  const systems: string[] = [];
  const generate: Generate = async (_config, system, input) => {
    if (system.includes('proposed qualification rubric')) return rubric;
    if (system.includes('candidate official website domains')) return { domains: [] };
    if (system.includes('extract company facts')) return { fields: [], notes: [] };
    systems.push(system);
    const typed = input as { lead: { city: string }; evidence: Evidence[] };
    const page = typed.evidence.find((item) => item.kind === 'website')?.id ?? 'E1';
    return {
      ...answer([{ ...brooklyn, record_value: typed.lead.city, source_ids: [page] }]),
      criteria: answer([]).criteria.map((item) => ({ ...item, source_ids: [page] })),
      exclusions: answer([]).exclusions.map((item) => ({ ...item, source_ids: [page] })),
    };
  };
  const { app, db } = createApp({
    dataDir: dir,
    generate,
    fetchWebsite: async (url) => ({
      url,
      content: url.includes('example.org/') || url === 'https://example.org' ? trainingSite : pageText,
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
    systems,
    post: (url: string, body: object = {}) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    get: (url: string) => agent.get('/api' + url),
    async setup() {
      const response = await send('post', '/auth/setup', {
        name: 'Conflict Administrator',
        username: 'conflict-admin',
        password: 'A-long-conflict-password-2026',
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
async function readyProject(f: Fixture, name = 'Community Research') {
  const created = await f.post('/projects', { name, website: 'https://example.org' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id as number;
  let project: Project = (await f.get('/projects/' + id)).body.project;
  await f.post('/projects/' + id + '/sources', {
    revision: project.revision,
    title: 'Brief',
    content: 'Target community organisations that run services in New York.',
  });
  project = (await f.get('/projects/' + id)).body.project;
  await f.post('/projects/' + id + '/sources/website', {
    revision: project.revision,
    url: 'https://example.org',
  });
  project = (await f.get('/projects/' + id)).body.project;
  const saved = await f.put('/projects/' + id + '/training/rubric', {
    revision: project.revision,
    rubric,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const published = await f.post('/projects/' + id + '/training/publish', {
    revision: saved.body.revision,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return published.body as Project;
}
type Detail = Lead & { runs: Run[] };
async function qualifiedLead(f: Fixture, project: Project, name = 'CAMBA', website = home) {
  const base = '/projects/' + project.id + '/leads';
  const created = await f.post(base, {
    name,
    website,
    city: 'Arverne',
    country: 'United States',
    industry: 'Nonprofit',
    employee_count: '200',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const leadBase = base + '/' + created.body.id;
  const qualified = await f.post(leadBase + '/qualify');
  assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
  return { leadBase, run_id: qualified.body.run_id as number };
}

test('“Use website value” writes the verified value as a recorded edit with its citation', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const { leadBase, run_id } = await qualifiedLead(f, project);
    // The evaluation was told to name both values rather than silently pick one.
    assert.match(f.systems[0], /name both/);
    const before = (await f.get(leadBase)).body as Detail;
    assert.equal(before.city, 'Arverne');
    assert.equal(before.stale, false);
    assert.deepEqual(before.runs[0].result.conflicts, [
      { ...brooklyn, source_ids: [before.runs[0].evidence.find((e) => e.kind === 'website')!.id] },
    ]);
    // Reporting it wrote nothing.
    assert.equal(before.revision, 1);

    const stale = await f.post(leadBase + '/conflicts/apply', {
      run_id,
      field: 'city',
      revision: before.revision + 1,
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const none = await f.post(leadBase + '/conflicts/apply', {
      run_id,
      field: 'country',
      revision: before.revision,
    });
    assert.equal(none.status, 404);
    assert.equal(
      (
        await f.post(leadBase + '/conflicts/apply', {
          run_id,
          field: 'contact_email',
          revision: before.revision,
        })
      ).status,
      400,
    );

    const applied = await f.post(leadBase + '/conflicts/apply', {
      run_id,
      field: 'city',
      revision: before.revision,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual(applied.body, { field: 'city', value: 'Brooklyn, NY', revision: 2 });
    const after = (await f.get(leadBase)).body as Detail;
    assert.equal(after.city, 'Brooklyn, NY');
    assert.equal(after.revision, 2);
    assert.equal(after.reviewed, false);
    // The earlier qualification now reads "Requalification needed", as with any edit.
    assert.equal(after.stale, true);
    assert.notEqual(after.updated_at, before.updated_at);
    // The value stays traceable to the page and sentence, like a researched one.
    const profile = (await f.get(leadBase + '/research-profile')).body as ResearchProfile;
    const citation = profile.citations.find((item) => item.field === 'city');
    assert.equal(citation?.value, 'Brooklyn, NY');
    assert.equal(citation?.evidence, headquarters);
    assert.equal(citation?.source_url, home);
    assert.equal(citation?.created_by, 'Conflict Administrator');
    const event = f.db
      .prepare("SELECT detail FROM audit_events WHERE action='lead.conflict_resolved'")
      .get() as { detail: string };
    assert.match(event.detail, /City changed from "Arverne" to "Brooklyn, NY"/);

    // Applying again finds the field no longer holds the record's value.
    const again = await f.post(leadBase + '/conflicts/apply', {
      run_id,
      field: 'city',
      revision: after.revision,
    });
    assert.equal(again.status, 409);
    assert.equal(((await f.get(leadBase)).body as Lead).revision, 2);
  } finally {
    f.dispose();
  }
});

test('a value typed since the analysis, a newer run or another lead’s run is never overwritten', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const first = await qualifiedLead(f, project);
    const second = await qualifiedLead(
      f,
      project,
      'CAMBA Housing',
      'https://housing.camba.example.org',
    );
    const lead = (await f.get(first.leadBase)).body as Lead;

    // Another lead's run is not this lead's analysis.
    const foreign = await f.post(first.leadBase + '/conflicts/apply', {
      run_id: second.run_id,
      field: 'city',
      revision: lead.revision,
    });
    assert.equal(foreign.status, 404);

    // Someone types a city: the website's value must not replace it.
    const edited = await f.put(first.leadBase, {
      revision: lead.revision,
      name: 'CAMBA',
      website: home,
      city: 'Queens',
      country: 'United States',
      industry: 'Nonprofit',
      employee_count: '200',
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const typed = await f.post(first.leadBase + '/conflicts/apply', {
      run_id: first.run_id,
      field: 'city',
      revision: edited.body.revision,
    });
    assert.equal(typed.status, 409);
    assert.match(typed.body.error, /City was changed since the analysis/);
    assert.equal(((await f.get(first.leadBase)).body as Lead).city, 'Queens');

    // A newer run replaces the old one's findings.
    const newer = await f.post(second.leadBase + '/qualify');
    assert.equal(newer.status, 200, JSON.stringify(newer.body));
    const current = (await f.get(second.leadBase)).body as Lead;
    const old = await f.post(second.leadBase + '/conflicts/apply', {
      run_id: second.run_id,
      field: 'city',
      revision: current.revision,
    });
    assert.equal(old.status, 409);
    assert.equal(((await f.get(second.leadBase)).body as Lead).city, 'Arverne');

    // A project the caller cannot reach answers 404, as every project-scoped route does.
    const account = await f.post('/users', {
      name: 'Outside Researcher',
      username: 'outside-researcher',
      password: 'A-long-researcher-password-2026',
      role: 'researcher',
    });
    assert.equal(account.status, 201, JSON.stringify(account.body));
    const researcher = request.agent(f.app);
    const login = await researcher
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'outside-researcher', password: 'A-long-researcher-password-2026' });
    assert.equal(login.status, 200);
    const outside = await researcher
      .post('/api' + second.leadBase + '/conflicts/apply')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', login.body.csrf_token)
      .send({ run_id: newer.body.run_id, field: 'city', revision: current.revision });
    assert.equal(outside.status, 404);
    assert.equal(((await f.get(second.leadBase)).body as Lead).city, 'Arverne');
    // Without the CSRF token nothing is written either.
    const forged = await f.agent
      .post('/api' + second.leadBase + '/conflicts/apply')
      .set('X-Requested-With', 'Innovista')
      .send({ run_id: newer.body.run_id, field: 'city', revision: current.revision });
    assert.equal(forged.status, 403);
    assert.equal(((await f.get(second.leadBase)).body as Lead).city, 'Arverne');
  } finally {
    f.dispose();
  }
});

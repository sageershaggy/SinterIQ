import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../server/app';
import { addedRange, leadFacetShape } from '../server/lead-filters';
import { HttpError } from '../server/validation';
import { type Generate } from '../server/ai';
import { facetParams, emptyFacets, type LeadFacetOptions } from '../shared/lead-filters';
import type { Lead, Project, TrainingSnapshot } from '../shared/types';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;

const rubric = {
  summary: 'Find pump manufacturers with engineering teams.',
  criteria: ['Manufactures pumps'],
  exclusions: ['Manufactures bearings'],
  questions: [],
};
const generated: Generate = async (_config, system, input) => {
  if (system.includes('proposed qualification rubric')) return rubric;
  const snapshot = (input as { approved_training: TrainingSnapshot }).approved_training;
  return {
    decision: 'QUALIFIED',
    score: 99,
    confidence: 90,
    summary: 'This company manufactures pumps with its own engineering team.',
    criteria: snapshot.rubric.criteria.map((criterion) => ({
      criterion,
      outcome: 'MATCH',
      evidence: 'The company describes its pump manufacturing.',
      source_ids: ['E2'],
    })),
    exclusions: snapshot.rubric.exclusions.map((criterion) => ({
      criterion,
      outcome: 'NO_MATCH',
      evidence: 'The company buys its bearings.',
      source_ids: ['E2'],
    })),
    gaps: [],
    next_steps: [],
    outreach: {
      contact_name: '',
      contact_role: '',
      contact_source_ids: [],
      why_qualified: '',
      call_script: '',
    },
  };
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-filters-'));
  const { app, db } = createApp({
    dataDir: dir,
    generate: generated,
    fetchWebsite: async (url) => ({
      url,
      content:
        'Example company designs and manufactures industrial pumps with its own engineering team. ' +
        url,
      truncated: false,
      links: [],
    }),
  });
  const agent = request.agent(app);
  let csrf = '';
  const send = (method: 'post' | 'put', url: string, body: object) =>
    agent[method]('/api' + url)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf)
      .send(body);
  return {
    app,
    db,
    agent,
    post: (url: string, body: object) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    async setup() {
      const response = await send('post', '/auth/setup', {
        name: 'Test Administrator',
        username: 'test-admin',
        password: 'A-long-test-password-2026',
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

async function readyProject(f: Fixture, name = 'Pump Research') {
  const created = await f.post('/projects', { name, website: 'https://example.org' });
  assert.equal(created.status, 201);
  const id = created.body.id as number;
  let project: Project = (await f.agent.get('/api/projects/' + id)).body.project;
  const source = await f.post('/projects/' + id + '/sources', {
    revision: project.revision,
    title: 'Training brief',
    content: 'Target pump manufacturers with their own engineering teams.',
  });
  assert.equal(source.status, 201);
  project = (await f.agent.get('/api/projects/' + id)).body.project;
  const site = await f.post('/projects/' + id + '/sources/website', {
    revision: project.revision,
    url: 'https://example.org',
  });
  assert.equal(site.status, 201, JSON.stringify(site.body));
  project = (await f.agent.get('/api/projects/' + id)).body.project;
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

const day = 24 * 60 * 60_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Seven leads that between them occupy every value of every facet, plus one lead in another
 * project that must never show up. Set directly in the database where the API would need a
 * model run, a call history or a week of waiting.
 */
async function seeded(f: Fixture) {
  await f.setup();
  const project = await readyProject(f);
  const base = '/projects/' + project.id + '/leads';
  const now = Date.now();
  const adminId = (
    f.db.prepare("SELECT id FROM accounts WHERE username='test-admin'").get() as { id: number }
  ).id;
  const specs = [
    {
      name: 'Alpha Pumps',
      industry: 'Pump manufacturing',
      country: 'Germany',
      city: 'Berlin',
      website: 'https://alpha.example.com',
      run: { status: 'QUALIFIED', score: 92 },
      assigned: true,
      calls: ['CONNECTED'],
      outreach: 'CONTACTED',
      created: new Date(now).toISOString(),
    },
    {
      name: 'Beta Law',
      industry: 'law firm',
      country: 'Germany',
      city: 'Munich',
      website: 'https://beta.example.com',
      run: { status: 'QUALIFIED', score: 65 },
      assigned: true,
      calls: [],
      outreach: 'REPLIED',
      created: new Date(now - 3 * day).toISOString(),
    },
    {
      name: 'Gamma Legal',
      industry: 'Law Firm',
      country: 'France',
      city: 'Paris',
      website: 'https://gamma.example.com',
      run: { status: 'NEEDS_REVIEW', score: 55 },
      assigned: false,
      // The most recent call decides: a callback request followed by an unanswered call.
      calls: ['CALLBACK', 'NO_ANSWER'],
      outreach: 'NOT_CONTACTED',
      created: new Date(now - 10 * day).toISOString(),
    },
    {
      name: 'Delta Trading',
      industry: '',
      country: '',
      city: '',
      website: '',
      run: null,
      assigned: false,
      calls: [],
      outreach: 'NOT_CONTACTED',
      created: new Date(now - 45 * day).toISOString(),
    },
    {
      name: 'Epsilon Works',
      industry: 'Pump manufacturing',
      country: 'France',
      city: '',
      website: 'https://epsilon.example.com',
      run: { status: 'NOT_A_TARGET', score: 30 },
      assigned: false,
      calls: ['CALLBACK'],
      outreach: 'NOT_CONTACTED',
      created: new Date(now - 20 * day).toISOString(),
    },
    {
      name: 'Zeta Stale',
      industry: 'Maintenance',
      country: 'UAE',
      city: 'Dubai',
      website: 'https://zeta.example.com',
      run: { status: 'QUALIFIED', score: 85, stale: true },
      assigned: false,
      calls: ['WRONG_CONTACT'],
      outreach: 'NOT_CONTACTED',
      // The legacy migration kept the old system's "YYYY-MM-DD HH:MM:SS" timestamps.
      created: '2020-01-01 10:00:00',
    },
    {
      name: 'Eta Raw Researched',
      industry: '',
      country: 'UAE',
      city: '',
      website: 'https://eta.example.com',
      run: null,
      assigned: false,
      calls: [],
      outreach: 'NOT_CONTACTED',
      created: new Date(now - 1000).toISOString(),
      cited: true,
    },
  ];
  const ids: Record<string, number> = {};
  for (const [index, spec] of specs.entries()) {
    const response = await f.post(base, {
      name: spec.name,
      industry: spec.industry,
      country: spec.country,
      city: spec.city,
      website: spec.website,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = response.body.id as number;
    ids[spec.name] = id;
    f.db
      .prepare('UPDATE leads SET created_at=?,updated_at=?,outreach_status=? WHERE id=?')
      .run(spec.created, new Date(now - index * 60_000).toISOString(), spec.outreach, id);
    if (spec.run)
      f.db
        .prepare(
          'UPDATE leads SET status=?,score=?,confidence=80,latest_run_id=?,training_version=?,qualified_revision=revision-? WHERE id=?',
        )
        .run(
          spec.run.status,
          spec.run.score,
          9000 + index,
          project.active_version,
          'stale' in spec.run ? 1 : 0,
          id,
        );
    if (spec.assigned)
      f.db
        .prepare('UPDATE leads SET assigned_to=?,assigned_at=? WHERE id=?')
        .run(adminId, new Date(now).toISOString(), id);
    for (const outcome of spec.calls)
      f.db
        .prepare(
          'INSERT INTO call_logs (project_id,lead_id,outcome,notes,created_by,created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(project.id, id, outcome, 'Logged in the test.', 'Test Administrator', spec.created);
    if ('cited' in spec)
      f.db
        .prepare(
          `INSERT INTO lead_research_citations
            (project_id,lead_id,field,value,evidence,source_url,created_at,created_by)
          VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          project.id,
          id,
          'country',
          'UAE',
          'Our workshop is in the UAE.',
          'https://eta.example.com',
          spec.created,
          'Test Administrator',
        );
  }
  // Another project's lead shares an industry and a country with this one and must never leak.
  const other = await f.post('/projects', { name: 'Other Project' });
  assert.equal(other.status, 201);
  const leaked = await f.post('/projects/' + other.body.id + '/leads', {
    name: 'Other Project Pumps',
    industry: 'Pump manufacturing',
    country: 'Germany',
  });
  assert.equal(leaked.status, 201);
  const list = (query: string) => f.agent.get('/api' + base + '?page_size=100&' + query);
  const names = async (query: string) => {
    const response = await list(query);
    assert.equal(response.status, 200, query + ' → ' + JSON.stringify(response.body));
    return (response.body.leads as Lead[]).map((lead) => lead.name).sort();
  };
  const exportNames = async (query: string) => {
    const response = await f.agent.get('/api' + base + '/export?' + query);
    assert.equal(response.status, 200, query + ' → ' + response.text);
    return response.text
      .replace(/^﻿/, '')
      .split('\r\n')
      .slice(1)
      .filter(Boolean)
      .map((line) => /^"((?:[^"]|"")*)"/.exec(line)![1].replace(/""/g, '"'));
  };
  return { project, base, adminId, ids, now, list, names, exportNames };
}

test('every Filters facet narrows the lead list on the server', async () => {
  const f = fixture();
  try {
    const { names, adminId, list } = await seeded(f);
    const all = [
      'Alpha Pumps',
      'Beta Law',
      'Delta Trading',
      'Epsilon Works',
      'Eta Raw Researched',
      'Gamma Legal',
      'Zeta Stale',
    ];
    assert.deepEqual(await names(''), all);

    // Qualification: a partition that matches the badge the table shows.
    assert.deepEqual(await names('qualification=RAW'), ['Delta Trading', 'Eta Raw Researched']);
    assert.deepEqual(await names('qualification=QUALIFIED'), ['Alpha Pumps', 'Beta Law']);
    assert.deepEqual(await names('qualification=NEEDS_REVIEW'), ['Gamma Legal']);
    assert.deepEqual(await names('qualification=NOT_QUALIFIED'), ['Epsilon Works']);
    assert.deepEqual(await names('qualification=REQUALIFY'), ['Zeta Stale']);
    assert.deepEqual(await names('qualification=RAW&qualification=QUALIFIED'), [
      'Alpha Pumps',
      'Beta Law',
      'Delta Trading',
      'Eta Raw Researched',
    ]);
    const stale = (await list('qualification=REQUALIFY')).body.leads as Lead[];
    assert.ok(stale.every((lead) => lead.stale));
    const current = (await list('qualification=QUALIFIED')).body.leads as Lead[];
    assert.ok(current.every((lead) => !lead.stale && lead.status === 'QUALIFIED'));

    // Fit score: the owner's ranges; an unscored lead is in none of them.
    assert.deepEqual(await names('score=80_100'), ['Alpha Pumps', 'Zeta Stale']);
    assert.deepEqual(await names('score=60_79'), ['Beta Law']);
    assert.deepEqual(await names('score=50_59'), ['Gamma Legal']);
    assert.deepEqual(await names('score=BELOW_50'), ['Epsilon Works']);
    assert.deepEqual(await names('score=80_100&score=BELOW_50'), [
      'Alpha Pumps',
      'Epsilon Works',
      'Zeta Stale',
    ]);

    // Call status, from the assignment and the most recent logged call.
    assert.deepEqual(await names('call=ASSIGNED'), ['Beta Law']);
    assert.deepEqual(await names('call=PENDING'), ['Gamma Legal']);
    assert.deepEqual(await names('call=COMPLETED'), ['Alpha Pumps']);
    assert.deepEqual(await names('call=FOLLOW_UP'), ['Epsilon Works', 'Zeta Stale']);
    assert.deepEqual(await names('call=NONE'), ['Delta Trading', 'Eta Raw Researched']);

    // Industry and location: case-insensitive, and an empty value selects the blank ones.
    assert.deepEqual(await names('industry=LAW%20FIRM'), ['Beta Law', 'Gamma Legal']);
    assert.deepEqual(await names('industry=Pump%20manufacturing'), [
      'Alpha Pumps',
      'Epsilon Works',
    ]);
    assert.deepEqual(await names('industry='), ['Delta Trading', 'Eta Raw Researched']);
    assert.deepEqual(await names('industry=maintenance&industry='), [
      'Delta Trading',
      'Eta Raw Researched',
      'Zeta Stale',
    ]);
    assert.deepEqual(await names('country=germany'), ['Alpha Pumps', 'Beta Law']);
    assert.deepEqual(await names('country=UAE&city=Dubai'), ['Zeta Stale']);
    assert.deepEqual(await names('city=Paris&city=Munich'), ['Beta Law', 'Gamma Legal']);
    assert.deepEqual(await names('city='), [
      'Delta Trading',
      'Epsilon Works',
      'Eta Raw Researched',
    ]);

    // Assigned to: an account, nobody, or either.
    assert.deepEqual(await names('assignee=' + adminId), ['Alpha Pumps', 'Beta Law']);
    assert.deepEqual(await names('assignee=none'), [
      'Delta Trading',
      'Epsilon Works',
      'Eta Raw Researched',
      'Gamma Legal',
      'Zeta Stale',
    ]);
    assert.deepEqual(await names('assignee=none&assignee=' + adminId), all);
    assert.deepEqual(await names('assignee=999'), []);

    // Lead status is the outreach status today.
    assert.deepEqual(await names('lead_status=REPLIED'), ['Beta Law']);
    assert.deepEqual(await names('lead_status=CONTACTED&lead_status=REPLIED'), [
      'Alpha Pumps',
      'Beta Law',
    ]);

    // Research status. "Missing details" overlaps the others on purpose.
    assert.deepEqual(await names('research=NOT_RESEARCHED'), ['Delta Trading']);
    assert.deepEqual(
      await names('research=RESEARCHED'),
      all.filter((name) => name !== 'Delta Trading'),
    );
    assert.deepEqual(await names('research=MISSING_DETAILS'), [
      'Delta Trading',
      'Eta Raw Researched',
    ]);

    // Date added, in the viewer's day; legacy timestamps are read too.
    assert.deepEqual(await names('added=TODAY&tz=0'), ['Alpha Pumps', 'Eta Raw Researched']);
    assert.deepEqual(await names('added=7D&tz=0'), [
      'Alpha Pumps',
      'Beta Law',
      'Eta Raw Researched',
    ]);
    assert.deepEqual(await names('added=30D&tz=0'), [
      'Alpha Pumps',
      'Beta Law',
      'Epsilon Works',
      'Eta Raw Researched',
      'Gamma Legal',
    ]);
    const now = Date.now();
    assert.deepEqual(
      await names(
        'added=CUSTOM&tz=0&added_from=' +
          isoDay(now - 12 * day) +
          '&added_to=' +
          isoDay(now - 8 * day),
      ),
      ['Gamma Legal'],
    );
    assert.deepEqual(await names('added=CUSTOM&added_to=2020-01-01'), ['Zeta Stale']);

    // Facets AND with each other, with the status view and with the search box.
    assert.deepEqual(await names('qualification=QUALIFIED&country=Germany&search=Beta'), [
      'Beta Law',
    ]);
    assert.deepEqual(await names('status=NOT_A_TARGET&score=BELOW_50'), ['Epsilon Works']);
    assert.deepEqual(await names('industry=Pump%20manufacturing&call=COMPLETED'), ['Alpha Pumps']);
    assert.deepEqual(await names('status=ASSIGNED&assigned_to=me&score=60_79'), ['Beta Law']);

    // Unknown values are refused rather than silently ignored.
    for (const bad of [
      'qualification=BOGUS',
      'score=90',
      'call=MAYBE',
      'assignee=someone',
      'lead_status=WON',
      'research=HALF',
      'added=YESTERDAY',
      'added=CUSTOM',
      'added=CUSTOM&added_from=2026-02-30',
      'added=CUSTOM&added_from=2026-09-20&added_to=2026-09-01',
      'tz=900&added=TODAY',
      'sort=random',
    ])
      assert.equal((await list(bad)).status, 400, bad);
  } finally {
    f.dispose();
  }
});

test('sorting orders the list and the export the same way', async () => {
  const f = fixture();
  try {
    const { list, exportNames } = await seeded(f);
    const ordered = async (sort: string) =>
      ((await list(sort ? 'sort=' + sort : '')).body.leads as Lead[]).map((lead) => lead.name);
    const expected: Record<string, string[]> = {
      updated: [
        'Alpha Pumps',
        'Beta Law',
        'Gamma Legal',
        'Delta Trading',
        'Epsilon Works',
        'Zeta Stale',
        'Eta Raw Researched',
      ],
      added_desc: [
        'Alpha Pumps',
        'Eta Raw Researched',
        'Beta Law',
        'Gamma Legal',
        'Epsilon Works',
        'Delta Trading',
        'Zeta Stale',
      ],
      name_asc: [
        'Alpha Pumps',
        'Beta Law',
        'Delta Trading',
        'Epsilon Works',
        'Eta Raw Researched',
        'Gamma Legal',
        'Zeta Stale',
      ],
      // Unscored leads last in both directions.
      score_desc: [
        'Alpha Pumps',
        'Zeta Stale',
        'Beta Law',
        'Gamma Legal',
        'Epsilon Works',
        'Delta Trading',
        'Eta Raw Researched',
      ],
      score_asc: [
        'Epsilon Works',
        'Gamma Legal',
        'Beta Law',
        'Zeta Stale',
        'Alpha Pumps',
        'Delta Trading',
        'Eta Raw Researched',
      ],
      // Case-insensitive; blank industries last in both directions.
      industry_asc: [
        'Beta Law',
        'Gamma Legal',
        'Zeta Stale',
        'Alpha Pumps',
        'Epsilon Works',
        'Delta Trading',
        'Eta Raw Researched',
      ],
      industry_desc: [
        'Alpha Pumps',
        'Epsilon Works',
        'Zeta Stale',
        'Beta Law',
        'Gamma Legal',
        'Delta Trading',
        'Eta Raw Researched',
      ],
    };
    expected.added_asc = [...expected.added_desc].reverse();
    expected.name_desc = [...expected.name_asc].reverse();
    for (const [sort, names] of Object.entries(expected)) {
      assert.deepEqual(await ordered(sort), names, sort);
      assert.deepEqual(await exportNames('sort=' + sort), names, 'export ' + sort);
    }
    // No sort given is "recently updated".
    assert.deepEqual(await ordered(''), expected.updated);
  } finally {
    f.dispose();
  }
});

test('the CSV export selects exactly the rows the list shows, in the same order', async () => {
  const f = fixture();
  try {
    const { base, list, exportNames, adminId } = await seeded(f);
    const queries = [
      '',
      'qualification=RAW&qualification=REQUALIFY',
      'score=80_100&sort=score_asc',
      'call=FOLLOW_UP&sort=name_desc',
      'industry=law%20firm&country=France',
      'assignee=none&lead_status=NOT_CONTACTED&sort=industry_asc',
      'assignee=' + adminId,
      'research=MISSING_DETAILS&research=NOT_RESEARCHED',
      'added=30D&tz=240&sort=added_asc',
      'status=REVIEW_QUEUE&score=50_59',
      'search=a&qualification=QUALIFIED&sort=name_asc',
    ];
    for (const query of queries) {
      const shown = ((await list(query)).body.leads as Lead[]).map((lead) => lead.name);
      assert.deepEqual(await exportNames(query), shown, query);
    }
    // The browser builds both links from one function, so they carry identical facets.
    const params = new URLSearchParams(
      facetParams(
        {
          ...emptyFacets,
          qualification: ['QUALIFIED', 'NEEDS_REVIEW'],
          industry: ['', 'Law Firm'],
          added: 'CUSTOM',
          added_from: '2020-01-01',
          sort: 'score_desc',
        },
        0,
      ),
    ).toString();
    const shown = ((await list(params)).body.leads as Lead[]).map((lead) => lead.name);
    assert.deepEqual(shown, ['Beta Law', 'Gamma Legal']);
    assert.deepEqual(await exportNames(params), shown);
    // A bad facet is refused by the export too, not answered with everything.
    assert.equal((await f.agent.get('/api' + base + '/export?score=100')).status, 400);
  } finally {
    f.dispose();
  }
});

test('pagination reports the page count and never runs past the last page', async () => {
  const f = fixture();
  try {
    const { base, list } = await seeded(f);
    const page = (n: number | string, extra = '') =>
      f.agent.get('/api' + base + '?page_size=3&sort=name_asc&page=' + n + extra);
    const first = await page(1);
    assert.equal(first.status, 200);
    assert.deepEqual([first.body.total, first.body.pages, first.body.page], [7, 3, 1]);
    const seen = new Set<string>();
    for (const n of [1, 2, 3]) {
      const body = (await page(n)).body;
      assert.equal(body.leads.length, n === 3 ? 1 : 3);
      for (const lead of body.leads as Lead[]) {
        assert.ok(!seen.has(lead.name), 'pages overlap at ' + lead.name);
        seen.add(lead.name);
      }
    }
    assert.equal(seen.size, 7);
    // Past the end answers with the last page, and says which page that is.
    const beyond = await page(40);
    assert.equal(beyond.body.page, 3);
    assert.deepEqual(
      (beyond.body.leads as Lead[]).map((lead) => lead.name),
      ['Zeta Stale'],
    );
    // An empty result still has one (empty) page.
    const empty = await page(5, '&industry=Nothing%20like%20this');
    assert.deepEqual([empty.body.total, empty.body.pages, empty.body.page], [0, 1, 1]);
    assert.deepEqual(empty.body.leads, []);
    for (const bad of ['page=0', 'page=-1', 'page=abc', 'page_size=0', 'page_size=101'])
      assert.equal((await list(bad)).status, 400, bad);
  } finally {
    f.dispose();
  }
});

test('the counts above the table cover the whole project and each one is a working filter', async () => {
  const f = fixture();
  try {
    const { list } = await seeded(f);
    const expected = {
      total: 7,
      raw: 2,
      qualified: 2,
      needs_review: 1,
      not_qualified: 1,
      requalify: 1,
    };
    assert.deepEqual((await list('')).body.summary, expected);
    // The counts describe the project, not the current filter, the search or the page.
    assert.deepEqual((await list('qualification=RAW&search=Delta&page=2')).body.summary, expected);
    // Clicking a count applies that qualification facet: it must find exactly that many.
    for (const [state, key] of [
      ['RAW', 'raw'],
      ['QUALIFIED', 'qualified'],
      ['NOT_QUALIFIED', 'not_qualified'],
      ['NEEDS_REVIEW', 'needs_review'],
      ['REQUALIFY', 'requalify'],
    ] as const)
      assert.equal((await list('qualification=' + state)).body.total, expected[key], state);
  } finally {
    f.dispose();
  }
});

test('a real qualification lands in Qualified, and editing the lead moves it to Requalification needed', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = '/projects/' + project.id + '/leads';
    const created = await f.post(base, {
      name: 'Real Run Pumps',
      website: 'https://realrun.example.com',
      industry: 'Pumps',
      country: 'Germany',
    });
    assert.equal(created.status, 201);
    const id = created.body.id as number;
    const names = async (query: string) =>
      ((await f.agent.get('/api' + base + '?' + query)).body.leads as Lead[]).map((l) => l.name);
    assert.deepEqual(await names('qualification=RAW&research=NOT_RESEARCHED'), ['Real Run Pumps']);
    assert.equal((await f.post(base + '/' + id + '/qualify', {})).status, 200);
    assert.deepEqual(await names('qualification=QUALIFIED&score=80_100&research=RESEARCHED'), [
      'Real Run Pumps',
    ]);
    assert.equal((await f.agent.get('/api' + base)).body.summary.qualified, 1);
    const lead = (await f.agent.get('/api' + base + '/' + id)).body as Lead;
    const edited = await f.put(base + '/' + id, {
      revision: lead.revision,
      name: lead.name,
      website: lead.website,
      industry: 'Pump manufacturing',
      country: 'Germany',
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(await names('qualification=QUALIFIED'), []);
    assert.deepEqual(await names('qualification=REQUALIFY'), ['Real Run Pumps']);
    const summary = (await f.agent.get('/api' + base)).body.summary;
    assert.deepEqual([summary.qualified, summary.requalify], [0, 1]);
  } finally {
    f.dispose();
  }
});

test('facet options list the project’s own values with counts, and stay inside the project', async () => {
  const f = fixture();
  try {
    const { project, adminId } = await seeded(f);
    const response = await f.agent.get('/api/projects/' + project.id + '/lead-facets');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const options = response.body as LeadFacetOptions;
    // Grouped case-insensitively; the other project's pump lead is not counted.
    assert.deepEqual(options.industry, [
      { value: '', count: 2 },
      { value: 'Law Firm', count: 2 },
      { value: 'Maintenance', count: 1 },
      { value: 'Pump manufacturing', count: 2 },
    ]);
    assert.deepEqual(
      options.country.map((option) => [option.value, option.count]),
      [
        ['', 1],
        ['France', 2],
        ['Germany', 2],
        ['UAE', 2],
      ],
    );
    assert.ok(options.city.some((option) => option.value === 'Dubai' && option.count === 1));
    assert.deepEqual(options.assignee, [
      { value: 'none', label: 'Unassigned', count: 5 },
      { value: String(adminId), label: 'Test Administrator', count: 2 },
    ]);
    // A researcher without the project gets the same 404 as every project-scoped route.
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
    assert.equal(
      (await researcher.get('/api/projects/' + project.id + '/lead-facets')).status,
      404,
    );
    assert.equal(
      (await request(f.app).get('/api/projects/' + project.id + '/lead-facets')).status,
      401,
    );
  } finally {
    f.dispose();
  }
});

test('date-added presets count whole days in the viewer’s time zone', () => {
  const parse = (input: object) => z.object(leadFacetShape).parse(input);
  // 01:30 UTC on 24 September: still the 23rd in New York, already mid-morning in Dubai.
  const now = Date.UTC(2026, 8, 24, 1, 30);
  assert.deepEqual(addedRange(parse({}), now), {});
  assert.deepEqual(addedRange(parse({ added: 'TODAY' }), now), {
    from: '2026-09-24T00:00:00.000Z',
  });
  assert.deepEqual(addedRange(parse({ added: 'TODAY', tz: '240' }), now), {
    from: '2026-09-23T20:00:00.000Z',
  });
  assert.deepEqual(addedRange(parse({ added: 'TODAY', tz: '-240' }), now), {
    from: '2026-09-23T04:00:00.000Z',
  });
  assert.deepEqual(addedRange(parse({ added: '7D' }), now), { from: '2026-09-18T00:00:00.000Z' });
  assert.deepEqual(addedRange(parse({ added: '30D' }), now), { from: '2026-08-26T00:00:00.000Z' });
  // Both ends included; the range ends at the start of the following local day.
  assert.deepEqual(
    addedRange(
      parse({ added: 'CUSTOM', added_from: '2026-08-31', added_to: '2026-09-30', tz: '240' }),
      now,
    ),
    { from: '2026-08-30T20:00:00.000Z', to: '2026-09-30T20:00:00.000Z' },
  );
  assert.throws(
    () =>
      addedRange(parse({ added: 'CUSTOM', added_from: '2026-09-02', added_to: '2026-09-01' }), now),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

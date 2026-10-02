import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { type Generate } from '../server/ai';
import { csvCell } from '../shared/csv';
import type { ImportLead, ImportPreview, ScreenVerdict } from '../shared/lead-import';
import type { Lead, Project } from '../shared/types';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;

const rubric = {
  summary: 'Find pump manufacturers with engineering teams.',
  criteria: ['Manufactures industrial pumps', 'Employs its own engineering team'],
  exclusions: ['Staffing or recruitment agency'],
  questions: [],
};
interface ScreenCall {
  system: string;
  input: {
    training: Record<string, unknown>;
    rows: Array<Record<string, unknown> & { id: number }>;
    missing_ids?: number[];
  };
}
/**
 * A deterministic screen: the row's own industry decides. The model is the only party that
 * could leak a contact or a source document, so every call it receives is kept for inspection.
 */
function screenModel(calls: ScreenCall[], answer?: (call: ScreenCall) => unknown): Generate {
  return async (_config, system, input) => {
    if (system.includes('quick-screen')) {
      const call = { system, input: input as ScreenCall['input'] };
      calls.push(call);
      if (answer) return answer(call);
      return { verdicts: call.input.rows.map(verdictFor) };
    }
    if (system.includes('proposed qualification rubric')) return rubric;
    throw new Error('Unexpected AI call in the import tests.');
  };
}
function verdictFor(row: Record<string, unknown> & { id: number }) {
  const industry = String(row.industry || '').toLowerCase();
  if (industry.includes('staffing'))
    return {
      id: row.id,
      verdict: 'REJECT',
      reason: '  Matches exclusion:\nstaffing agency  ',
      // Numbered and in another case: still that rule.
      rule: '1. staffing or recruitment agency',
    };
  if (industry.includes('pump'))
    return {
      id: row.id,
      verdict: 'pass',
      reason: 'Industry is pump manufacturing, a target sector.',
      rule: 'A rule the training does not contain',
    };
  return { id: row.id, verdict: 'UNCLEAR', reason: 'The row says too little to judge.', rule: '' };
}

function fixture(call: Generate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-import-'));
  const fetched: string[] = [];
  const { app, db } = createApp({
    dataDir: dir,
    generate: call,
    fetchWebsite: async (url) => {
      fetched.push(url);
      return {
        url,
        content: 'Example company designs and manufactures industrial pumps. ' + url,
        truncated: false,
        links: [],
      };
    },
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
    fetched,
    post: (url: string, body: object) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    upload: (url: string, csv: string, fields: Record<string, string> = {}) => {
      const req = agent
        .post('/api' + url)
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', csrf);
      for (const [key, value] of Object.entries(fields)) req.field(key, value);
      return req.attach('file', Buffer.from(csv), 'leads.csv');
    },
    get csrf() {
      return csrf;
    },
    async setup() {
      const response = await send('post', '/auth/setup', {
        name: 'Test Administrator',
        username: 'test-admin',
        password: 'A-long-test-password-2026',
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      csrf = response.body.csrf_token;
    },
    count: (table: string) =>
      (db.prepare('SELECT COUNT(*) n FROM ' + table).get() as { n: number }).n,
    dispose() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
/** A project whose current training is published, as the quick screen requires. */
async function publishedProject(f: Fixture) {
  const created = await f.post('/projects', {
    name: 'Pump Research',
    description: 'Research pump manufacturers',
    website: 'https://example.org',
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  let project: Project = created.body;
  const note = await f.post('/projects/' + id + '/sources', {
    revision: project.revision,
    title: 'Training brief',
    content:
      'SOURCE DOCUMENT TEXT. Target pump manufacturers with their own engineering teams. Exclude staffing agencies.',
  });
  assert.equal(note.status, 201);
  project = (await f.agent.get('/api/projects/' + id)).body.project;
  const site = await f.post('/projects/' + id + '/sources/website', {
    revision: project.revision,
    url: 'https://example.org',
  });
  assert.equal(site.status, 201);
  project = (await f.agent.get('/api/projects/' + id)).body.project;
  const saved = await f.put('/projects/' + id + '/training/rubric', {
    revision: project.revision,
    rubric,
  });
  assert.equal(saved.status, 200);
  const published = await f.post('/projects/' + id + '/training/publish', {
    revision: saved.body.revision,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return published.body as Project;
}
const lead = (fields: Partial<ImportLead> & { name: string }): ImportLead => ({
  website: '',
  country: '',
  city: '',
  industry: '',
  employee_count: '',
  contact_name: '',
  contact_role: '',
  contact_email: '',
  contact_phone: '',
  notes: '',
  ...fields,
});

test('preview reads and checks a file, flags project duplicates and writes nothing', async () => {
  const f = fixture(screenModel([]));
  try {
    await f.setup();
    const project = await publishedProject(f);
    const base = '/projects/' + project.id + '/leads';
    assert.equal(
      (await f.post(base, { name: 'Existing Pumps GmbH', website: 'https://existing.example' }))
        .status,
      201,
    );
    const before = {
      leads: f.count('leads'),
      audit: f.count('audit_events'),
      notifications: f.count('project_notifications'),
    };
    const preview = await f.upload(
      base + '/import/preview',
      'Company Name,Company Website,Industry,LinkedIn\n' +
        'Alpha Pumps,alpha-pumps.example,Pump manufacturing,in/alpha\n' +
        ',no-name.example,Staffing,\n' +
        'Existing Pumps,https://www.existing.example/about,Pumps,\n' +
        'Local Thing,http://localhost:8080,Staffing,in/local\n',
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const body = preview.body as ImportPreview;
    assert.equal(body.total, 4);
    assert.deepEqual(body.columns, ['company_name', 'company_website', 'industry', 'linkedin']);
    assert.deepEqual(
      body.rows.map((row) => [row.row, row.lead.name, row.lead.website, Boolean(row.duplicate)]),
      [
        [2, 'Alpha Pumps', 'https://alpha-pumps.example', false],
        [4, 'Existing Pumps', 'https://www.existing.example/about', true],
        // An unusable website is blanked with a warning, exactly as the file import does.
        [5, 'Local Thing', '', false],
      ],
    );
    // The original cells travel with the row, so a rejected row can be downloaded as it was.
    assert.deepEqual(body.rows[0].cells, [
      'Alpha Pumps',
      'alpha-pumps.example',
      'Pump manufacturing',
      'in/alpha',
    ]);
    assert.equal(body.rows[1].duplicate?.name, 'Existing Pumps GmbH');
    assert.deepEqual(
      body.problems.map((p) => p.row),
      [3],
    );
    assert.deepEqual(
      body.warnings.map((w) => w.row),
      [5],
    );
    assert.deepEqual(body.screening, { available: true, reason: '' });
    assert.deepEqual(
      {
        leads: f.count('leads'),
        audit: f.count('audit_events'),
        notifications: f.count('project_notifications'),
      },
      before,
    );
    // The starter project has no published training, so the screen is offered with the reason.
    const unpublished = await f.upload('/projects/1/leads/import/preview', 'name\nSome Company\n');
    assert.equal(unpublished.status, 200);
    assert.equal(unpublished.body.screening.available, false);
    assert.match(unpublished.body.screening.reason, /Publish the current training/);
    // A file with nothing importable is refused like the file import refuses it.
    const empty = await f.upload(base + '/import/preview', 'name,website\n,https://a.example\n');
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /First problem — row 2/);
  } finally {
    f.dispose();
  }
});

test('the quick screen answers every row from the row data alone, against the rubric only', async () => {
  const calls: ScreenCall[] = [];
  const f = fixture(screenModel(calls));
  try {
    await f.setup();
    const project = await publishedProject(f);
    const fetchedBefore = f.fetched.length;
    const rows = [
      lead({
        name: 'Alpha Pumps',
        industry: 'Pump manufacturing',
        contact_name: 'Private Person',
        contact_email: 'private.person@alpha.example',
        contact_phone: '+49 30 1234567',
        contact_role: 'Head of Engineering',
        notes: 'N'.repeat(5000),
        website: 'https://alpha.example',
        list_data: {
          Event: 'Hannover Messe 2026',
          Products: 'P'.repeat(300),
          // Sent by hand rather than from a preview: still cleaned before the AI sees it.
          'Booth contact': 'Private Person',
        },
      }),
      lead({ name: 'Beta Staffing', industry: 'Staffing services' }),
      lead({ name: 'Gamma Holdings' }),
    ];
    const screened = await f.post('/projects/' + project.id + '/leads/import/screen', { rows });
    assert.equal(screened.status, 200, JSON.stringify(screened.body));
    const verdicts = screened.body.verdicts as ScreenVerdict[];
    assert.deepEqual(
      verdicts.map((v) => [v.index, v.verdict]),
      [
        [0, 'PASS'],
        [1, 'REJECT'],
        [2, 'UNCLEAR'],
      ],
    );
    // One line, and a rule only when it is one of the approved rules, in the training's words.
    assert.equal(verdicts[1].reason, 'Matches exclusion: staffing agency');
    assert.equal(verdicts[1].rule, 'Staffing or recruitment agency');
    assert.equal(verdicts[0].rule, '');
    assert.equal(calls.length, 1);
    const sent = calls[0];
    assert.deepEqual(sent.input.training, {
      summary: rubric.summary,
      criteria: rubric.criteria,
      exclusions: rubric.exclusions,
    });
    const text = JSON.stringify(sent.input);
    assert.ok(!text.includes('SOURCE DOCUMENT TEXT'), 'source documents stay out');
    assert.ok(!text.includes('Private Person'), 'the contact name stays out');
    assert.ok(!text.includes('private.person@alpha.example'), 'the contact email stays out');
    assert.ok(!text.includes('1234567'), 'the contact phone stays out');
    assert.equal(sent.input.rows[0].contact_role, 'Head of Engineering');
    assert.ok(String(sent.input.rows[0].notes).length <= 601, 'notes are truncated');
    // The list's other columns are row data too, shortened like the notes.
    const listed = sent.input.rows[0].list_data as Record<string, string>;
    assert.deepEqual(Object.keys(listed), ['Event', 'Products']);
    assert.equal(listed.Event, 'Hannover Messe 2026');
    assert.equal(listed.Products, 'P'.repeat(120) + '…');
    assert.deepEqual(sent.input.rows[1].list_data, {});
    assert.match(sent.system, /list_data holds the other columns of the uploader’s own list/);
    assert.match(sent.system, /remembered/);
    assert.match(sent.system, /nonprofit/);
    // No website is opened: that is the detailed qualification's job.
    assert.equal(f.fetched.length, fetchedBefore);
    // The screen saves nothing.
    assert.equal(f.count('leads'), 0);
  } finally {
    f.dispose();
  }
});

test('rows the model leaves out are asked for once, then come back as Not screened', async () => {
  const calls: ScreenCall[] = [];
  const f = fixture(
    screenModel(calls, (call) => {
      const ids = call.input.rows.map((row) => row.id);
      if (calls.length === 1)
        return {
          verdicts: [
            // Row 1 answered twice is ambiguous; row 2 left out; row 3 fine; row 9 never asked.
            { id: 1, verdict: 'PASS', reason: 'Pumps.' },
            { id: 1, verdict: 'REJECT', reason: 'Staffing.' },
            { id: 3, verdict: 'UNCLEAR', reason: 'Too thin.' },
            { id: 9, verdict: 'REJECT', reason: 'Extra row.' },
          ],
        };
      // The repair answers only row 1; row 2 is left out again.
      assert.deepEqual(ids, [1, 2]);
      return { verdicts: [{ id: '1', verdict: 'PASS', reason: 'Pumps.' }] };
    }),
  );
  try {
    await f.setup();
    const project = await publishedProject(f);
    const response = await f.post('/projects/' + project.id + '/leads/import/screen', {
      rows: [lead({ name: 'One' }), lead({ name: 'Two' }), lead({ name: 'Three' })],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(calls.length, 2, 'exactly one repair call');
    assert.deepEqual(calls[1].input.missing_ids, [1, 2]);
    assert.match(calls[1].system, /missing_ids/);
    assert.deepEqual(
      (response.body.verdicts as ScreenVerdict[]).map((v) => [v.verdict, v.reason]),
      [
        ['PASS', 'Pumps.'],
        ['UNCLEAR', 'Not screened'],
        ['UNCLEAR', 'Too thin.'],
      ],
    );
  } finally {
    f.dispose();
  }
});

test('the screen refuses an oversized batch, an unpublished training and an unreachable project', async () => {
  const calls: ScreenCall[] = [];
  const f = fixture(screenModel(calls));
  try {
    await f.setup();
    const project = await publishedProject(f);
    const many = Array.from({ length: 41 }, (_, i) => lead({ name: 'Company ' + i }));
    const tooMany = await f.post('/projects/' + project.id + '/leads/import/screen', {
      rows: many,
    });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /at most 40 rows/);
    // Project 1 is the starter project, whose training has not been published.
    const unpublished = await f.post('/projects/1/leads/import/screen', {
      rows: [lead({ name: 'Some Company' })],
    });
    assert.equal(unpublished.status, 409);
    assert.equal(calls.length, 0);

    // A researcher assigned only to the starter project cannot reach the other one, by any route.
    const account = await f.post('/users', {
      name: 'Assigned Researcher',
      username: 'assigned-researcher',
      password: 'Another-long-password',
      role: 'researcher',
    });
    assert.equal(account.status, 201);
    assert.equal(
      (await f.put('/users/' + account.body.id + '/projects', { project_ids: [1] })).status,
      200,
    );
    const researcher = request.agent(f.app);
    const login = await researcher
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'assigned-researcher', password: 'Another-long-password' });
    assert.equal(login.status, 200);
    const as = (url: string) =>
      researcher
        .post('/api/projects/' + project.id + url)
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', login.body.csrf_token);
    assert.equal(
      (await as('/leads/import/screen').send({ rows: [lead({ name: 'X' })] })).status,
      404,
    );
    assert.equal(
      (await as('/leads/import/rows').send({ leads: [lead({ name: 'X' })] })).status,
      404,
    );
    assert.equal(
      (await as('/leads/import/preview').attach('file', Buffer.from('name\nX\n'), 'x.csv')).status,
      404,
    );
    assert.equal(calls.length, 0);
    assert.equal(f.count('leads'), 0);
  } finally {
    f.dispose();
  }
});

test('rows already in the project are answered by duplicate matching and never sent to the AI', async () => {
  const calls: ScreenCall[] = [];
  const f = fixture(screenModel(calls));
  try {
    await f.setup();
    const project = await publishedProject(f);
    const base = '/projects/' + project.id + '/leads';
    await f.post(base, { name: 'Müller Pumpen GmbH', website: 'https://mueller.example' });
    const response = await f.post(base + '/import/screen', {
      rows: [
        lead({ name: 'Mueller Pumpen', industry: 'Pumps' }),
        lead({ name: 'New Pumps', industry: 'Pump manufacturing' }),
        lead({ name: 'Renamed Co', website: 'https://www.mueller.example/de' }),
      ],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const verdicts = response.body.verdicts as ScreenVerdict[];
    assert.deepEqual(
      verdicts.map((v) => [v.index, v.verdict]),
      [
        [0, 'DUPLICATE'],
        [1, 'PASS'],
        [2, 'DUPLICATE'],
      ],
    );
    assert.equal(verdicts[0].duplicate?.name, 'Müller Pumpen GmbH');
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].input.rows.map((row) => row.name),
      ['New Pumps'],
    );
    // A batch of nothing but duplicates makes no AI call at all.
    const only = await f.post(base + '/import/screen', {
      rows: [lead({ name: 'Mueller Pumpen' })],
    });
    assert.equal(only.status, 200);
    assert.equal(only.body.verdicts[0].verdict, 'DUPLICATE');
    assert.equal(calls.length, 1);
  } finally {
    f.dispose();
  }
});

test('chosen rows import atomically through the same write path and report the new lead ids', async () => {
  const f = fixture(screenModel([]));
  try {
    await f.setup();
    const project = await publishedProject(f);
    const base = '/projects/' + project.id + '/leads';
    const existing = await f.post(base, {
      name: 'Existing Pumps GmbH',
      website: 'https://existing.example',
    });
    // One bad row imports nothing.
    const bad = await f.post(base + '/import/rows', {
      leads: [lead({ name: 'Good Row' }), lead({ name: 'Bad Row', contact_email: 'not-an-email' })],
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Lead 2 \(Bad Row\): Contact email is not a valid email address/);
    assert.equal(f.count('leads'), 1);

    const imported = await f.post(base + '/import/rows', {
      leads: [
        lead({ name: 'Alpha Pumps', industry: 'Pump manufacturing' }),
        lead({ name: 'Existing Pumps', country: 'Germany' }),
        lead({ name: 'Beta Pumps', website: 'https://beta.example' }),
      ],
      on_duplicate: 'skip',
      screened: { rejected: 41, unclear: 7 },
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.created, 2);
    assert.equal(imported.body.skipped, 1);
    assert.deepEqual(imported.body.duplicates, ['Existing Pumps']);
    const ids = (
      f.db
        .prepare('SELECT id FROM leads WHERE project_id=? AND id<>? ORDER BY id')
        .all(project.id, existing.body.id) as Array<{ id: number }>
    ).map((row) => row.id);
    assert.deepEqual(imported.body.created_ids, ids);
    // Only the rows sent were imported: the rejected and unclear ones never reached the server.
    assert.equal(f.count('leads'), 3);
    const event = f.db
      .prepare(
        "SELECT detail FROM audit_events WHERE project_id=? AND action='leads.imported' ORDER BY id DESC",
      )
      .get(project.id) as { detail: string };
    assert.equal(
      event.detail,
      '2 created; 0 updated; 1 unchanged duplicates skipped; 0 imported without a usable website; quick screen left out 41 rejected and 7 unclear or unscreened rows.',
    );

    const updated = await f.post(base + '/import/rows', {
      leads: [lead({ name: 'Existing Pumps', country: 'Germany' })],
      on_duplicate: 'update',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.updated, 1);
    assert.deepEqual(updated.body.created_ids, []);
    const refreshed = await f.agent.get('/api' + base + '/' + existing.body.id);
    assert.equal(refreshed.body.country, 'Germany');

    // A full file's rows far exceed the 1 MB other routes accept; this route takes them.
    const large = Array.from({ length: 220 }, (_, i) =>
      lead({ name: 'Large Import ' + i, notes: 'x'.repeat(9000) }),
    );
    const big = await f.post(base + '/import/rows', { leads: large });
    assert.equal(big.status, 200, JSON.stringify(big.body).slice(0, 300));
    assert.equal(big.body.created, 220);
    // Every other route still refuses a body over 1 MB.
    const tooBig = await f.post(base, { name: 'Huge', notes: 'x'.repeat(1_100_000) });
    assert.equal(tooBig.status, 413);
  } finally {
    f.dispose();
  }
});

test('an import keeps the list’s other columns as list data, never a personal detail', async () => {
  const f = fixture(screenModel([]));
  try {
    await f.setup();
    const project = await publishedProject(f);
    const base = '/projects/' + project.id + '/leads';
    const csv =
      'Company Name,Website,Event,Funding Round,Announced,Stand,Booth Contact,Speaker Email,Fax,LinkedIn,Remarks,Rep,Raised\n' +
      'Fair Pumps,fair-pumps.example,Hannover Messe 2026,Series B,2026-03-15,Hall 3 A12,Jana Weber,jana@fair.example,+49 30 7654321,in/jana-weber,Call Jana on +49 30 1234567,rep@fair.example,€12.500.000\n';
    const preview = await f.upload(base + '/import/preview', csv);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const row = (preview.body as ImportPreview).rows[0];
    // A column whose header names a person or a way to reach one is left out, and so is any
    // value holding an email address or a phone number. Dates and amounts are not phone numbers.
    const kept = {
      Event: 'Hannover Messe 2026',
      'Funding round': 'Series B',
      Announced: '2026-03-15',
      Stand: 'Hall 3 A12',
      Raised: '€12.500.000',
    };
    assert.deepEqual(row.lead.list_data, kept);
    assert.equal(row.lead.contact_name, '');

    // The dialog sends the previewed row back, and the lead keeps its list data.
    const imported = await f.post(base + '/import/rows', { leads: [row.lead] });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const id = imported.body.created_ids[0] as number;
    const url = '/api' + base + '/' + id;
    const created = (await f.agent.get(url)).body as Lead;
    assert.deepEqual(created.list_data, kept);
    assert.ok(!JSON.stringify(created).includes('Jana'), 'no personal detail reached the lead');

    // The lead form neither carries nor clears it.
    const edited = await f.put(base + '/' + id, {
      revision: created.revision,
      name: created.name,
      website: created.website,
      country: 'Germany',
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.list_data, kept);
    const refused = await f.put(base + '/' + id, {
      revision: edited.body.revision,
      name: created.name,
      list_data: {},
    });
    assert.equal(refused.status, 400);

    // Updating a duplicate merges the columns: a new value replaces the same column, the rest
    // stay, and like any other merged change it moves the revision and clears the review.
    f.db.prepare('UPDATE leads SET reviewed=1 WHERE id=?').run(id);
    const merged = await f.post(base + '/import/rows', {
      leads: [lead({ name: 'Fair Pumps', list_data: { 'FUNDING ROUND': 'Series C', Hall: '4' } })],
      on_duplicate: 'update',
    });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(merged.body.updated, 1);
    const after = (await f.agent.get(url)).body as Lead;
    assert.deepEqual(after.list_data, { ...kept, 'Funding round': 'Series C', Hall: '4' });
    assert.equal(after.revision, edited.body.revision + 1);
    assert.equal(after.reviewed, false);
    // The same columns again change nothing, and skipping a duplicate never touches them.
    const same = await f.post(base + '/import/rows', {
      leads: [lead({ name: 'Fair Pumps', list_data: { Hall: '4' } })],
      on_duplicate: 'update',
    });
    assert.deepEqual([same.body.updated, same.body.skipped], [0, 1]);
    const skipped = await f.post(base + '/import/rows', {
      leads: [lead({ name: 'Fair Pumps', list_data: { Hall: '9' } })],
    });
    assert.equal(skipped.body.skipped, 1);
    const unchanged = (await f.agent.get(url)).body as Lead;
    assert.equal(unchanged.list_data?.Hall, '4');
    assert.equal(unchanged.revision, after.revision);

    // A hand-made request is cleaned by the same rule, and held to the same limits.
    const crafted = await f.post(base + '/import/rows', {
      leads: [
        lead({
          name: 'Crafted Pumps',
          list_data: {
            Event: 'Achema 2027',
            'Contact person': 'Jana Weber',
            Note: 'jana@crafted.example',
            Industry: 'Pumps',
            ['Long ' + 'x'.repeat(80)]: 'y'.repeat(400),
          },
        }),
        lead({
          name: 'Wide Pumps',
          list_data: Object.fromEntries(
            Array.from({ length: 30 }, (_, i) => ['Column ' + (i + 1), 'v' + (i + 1)]),
          ),
        }),
        lead({
          name: 'Long Pumps',
          list_data: Object.fromEntries(
            Array.from({ length: 20 }, (_, i) => ['Column ' + (i + 1), 'z'.repeat(300)]),
          ),
        }),
      ],
    });
    assert.equal(crafted.status, 200, JSON.stringify(crafted.body));
    const stored = (name: string) =>
      JSON.parse(
        (
          f.db
            .prepare('SELECT list_data FROM leads WHERE project_id=? AND name=?')
            .get(project.id, name) as { list_data: string }
        ).list_data,
      ) as Record<string, string>;
    const long = 'Long ' + 'x'.repeat(55);
    assert.deepEqual(stored('Crafted Pumps'), {
      Event: 'Achema 2027',
      [long]: 'y'.repeat(299) + '…',
    });
    assert.equal(long.length, 60);
    const wide = stored('Wide Pumps');
    assert.equal(Object.keys(wide).length, 25);
    assert.equal(wide['Column 25'], 'v25');
    const packed = stored('Long Pumps');
    assert.ok(JSON.stringify(packed).length <= 4000);
    assert.ok(Object.keys(packed).length >= 12, JSON.stringify(Object.keys(packed)));

    // The one-shot file import keeps the same columns.
    const oneShot = await f.upload(
      base + '/import',
      'name,event,email\nSolo Pumps,Achema 2027,a@solo.example\n',
    );
    assert.equal(oneShot.status, 200, JSON.stringify(oneShot.body));
    assert.deepEqual(stored('Solo Pumps'), { Event: 'Achema 2027' });
    // A lead added by hand has none.
    assert.equal((await f.post(base, { name: 'Typed Pumps' })).status, 201);
    assert.deepEqual(stored('Typed Pumps'), {});
  } finally {
    f.dispose();
  }
});

test('the one-shot file import is unchanged', async () => {
  const f = fixture(screenModel([]));
  try {
    await f.setup();
    const csv =
      'name,website,country\nAlpha GmbH,https://alpha.example,Germany\n,broken\nBravo Ltd,http://localhost,France\n';
    const first = await f.upload('/projects/1/leads/import', csv);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.total, 3);
    assert.equal(first.body.created, 2);
    assert.equal(first.body.updated, 0);
    assert.equal(first.body.skipped, 0);
    assert.equal(first.body.invalid, 1);
    assert.equal(first.body.problems[0].row, 3);
    assert.equal(first.body.warned, 1);
    assert.match(first.body.warnings[0].reason, /^Imported without a website/);
    const again = await f.upload('/projects/1/leads/import', 'name,country\nAlpha GmbH,Austria\n', {
      on_duplicate: 'update',
    });
    assert.equal(again.body.updated, 1);
    const skipped = await f.upload('/projects/1/leads/import', 'name\nAlpha GmbH\n');
    assert.equal(skipped.body.skipped, 1);
    assert.deepEqual(skipped.body.duplicates, ['Alpha GmbH']);
    const event = f.db
      .prepare(
        "SELECT detail FROM audit_events WHERE project_id=1 AND action='leads.imported' ORDER BY id",
      )
      .get() as { detail: string };
    assert.equal(
      event.detail,
      '2 created; 0 updated; 0 unchanged duplicates skipped; 1 imported without a usable website; 1 rows could not be read.',
    );
  } finally {
    f.dispose();
  }
});

test('the rejected-rows download neutralizes spreadsheet formulas the way the export does', () => {
  assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(csvCell(' +1'), '"\' +1"');
  assert.equal(csvCell('@cmd'), '"\'@cmd"');
  assert.equal(csvCell('Say "hi"'), '"Say ""hi"""');
  assert.equal(csvCell(null), '""');
});

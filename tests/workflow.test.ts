import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { type Generate } from '../server/ai';
import type { Project, TrainingSnapshot, Qualification, Evidence } from '../shared/types';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;
const rubric = {
  summary:
    'Find pump manufacturers with engineering teams. Bearing manufacturers are direct competitors.',
  criteria: ['Manufactures pumps', 'Employs engineers'],
  exclusions: ['Manufactures bearings'],
  questions: [],
};
test('preserved company research is project-scoped and supports AI context without copying contact channels or old decisions', async () => {
  let supplied: Evidence[] = [];
  const f = fixture(async (config, system, input) => {
    supplied = (input as { evidence: Evidence[] }).evidence;
    return generated(config, system, input);
  });
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Historical pump manufacturer',
      website: 'https://example.com',
    });
    const id = created.body.id;
    f.db.prepare('UPDATE leads SET legacy_id=?,legacy_json=? WHERE id=? AND project_id=?').run(
      42,
      JSON.stringify({
        company_name: 'Historical pump manufacturer',
        lead_status: 'APPROVED',
        lead_score: 7,
        product_fit: 'Hybrid bearings',
        opportunity_notes: 'Prior hygienic pump application',
        qualification_notes: 'Previous company research',
      }),
      id,
      project.id,
    );
    const insert = f.db.prepare(
      'INSERT INTO preserved_research (project_id,lead_id,kind,legacy_id,data_json,imported_at) VALUES (?,?,?,?,?,?)',
    );
    insert.run(
      project.id,
      id,
      'contacts',
      1,
      JSON.stringify({
        full_name: 'Private Contact Name',
        email: 'private-contact@example.com',
        phone_direct: '+49 12345',
        job_title: 'Application engineer',
        operating_media: 'Corrosive process fluids',
      }),
      '2026-01-01',
    );
    insert.run(
      project.id,
      id,
      'activities',
      1,
      JSON.stringify({
        subject: 'Earlier research visit',
        details: 'Investigated pump applications',
        activity_date: '2024-01-02',
      }),
      '2026-01-01',
    );
    const detail = await f.agent.get('/api/projects/' + project.id + '/leads/' + id);
    assert.equal(detail.body.preserved_records.length, 2);
    assert.equal(detail.body.preserved_records[0].data.email, 'private-contact@example.com');
    assert.equal((await f.agent.get('/api/projects/1/leads/' + id)).status, 404);
    const summary = (await f.agent.get('/api/projects/' + project.id)).body.project;
    assert.equal(summary.is_starter, false);
    assert.equal(summary.preserved_lead_count, 1);
    assert.equal(summary.preserved_contact_count, 1);
    assert.equal(summary.preserved_activity_count, 1);
    const other = (await f.agent.get('/api/projects/1')).body.project;
    assert.equal(other.is_starter, true);
    assert.equal(other.preserved_contact_count, 0);
    const activity = (await f.agent.get('/api/projects/' + project.id + '/activity')).body;
    assert.ok(
      activity.some((row: { detail: string }) => row.detail.includes('Earlier research visit')),
    );
    assert.ok(
      !(await f.agent.get('/api/projects/1/activity')).text.includes('Earlier research visit'),
    );
    const qualified = await f.post('/projects/' + project.id + '/leads/' + id + '/qualify', {});
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const previous = supplied.find((item) => item.title.includes('Earlier company research'));
    assert.ok(previous);
    assert.equal(previous.kind, 'lead_record');
    assert.match(previous.content, /Prior hygienic pump application/);
    assert.match(previous.content, /Corrosive process fluids/);
    assert.match(previous.content, /unverified/);
    assert.ok(!previous.content.includes('Private Contact Name'));
    assert.ok(!previous.content.includes('private-contact@example.com'));
    assert.ok(!previous.content.includes('+49 12345'));
    const after = (await f.agent.get('/api/projects/' + project.id + '/leads/' + id)).body;
    assert.equal(after.score, 100);
    assert.equal(JSON.parse(after.legacy_json).lead_score, 7);
    assert.deepEqual(after.preserved_records, detail.body.preserved_records);
    assert.equal(
      after.runs[0].evidence.find((item: Evidence) => item.id === previous.id).content,
      previous.content,
    );
  } finally {
    f.dispose();
  }
});
const generated: Generate = async (_config, system, input) => {
  if (system.includes('proposed qualification rubric')) return rubric;
  const snapshot = (input as { approved_training: TrainingSnapshot }).approved_training;
  return {
    decision: 'QUALIFIED',
    score: 99,
    confidence: 92,
    summary:
      'This company manufactures pumps with its own engineering team and does not manufacture bearings.',
    criteria: snapshot.rubric.criteria.map((criterion) => ({
      criterion,
      outcome: 'MATCH',
      evidence: 'The company describes its pump manufacturing and engineering team.',
      source_ids: ['E2'],
    })),
    exclusions: snapshot.rubric.exclusions.map((criterion) => ({
      criterion,
      outcome: 'NO_MATCH',
      evidence: 'The company buys third-party bearings for its own pumps.',
      source_ids: ['E2'],
    })),
    gaps: [],
    next_steps: ['Confirm the relevant product applications.'],
    outreach: {
      contact_name: 'Dana Prakash',
      contact_role: 'Head of Engineering',
      contact_source_ids: ['E2'],
      why_qualified: 'Builds pumps in house and specifies third-party bearings.',
      call_script: 'Ask which pump lines rely on third-party bearings today.',
    },
  };
};
function fixture(call: Generate = generated) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-test-'));
  const { app, db } = createApp({
    dataDir: dir,
    generate: call,
    fetchWebsite: async (url) => ({
      url,
      content:
        'Example company designs and manufactures industrial pumps. Its engineering team specifies third-party bearings, and it does not manufacture bearings. ' +
        url,
      truncated: false,
      links: [new URL('/about', url).href, new URL('/products', url).href],
    }),
  });
  const agent = request.agent(app);
  let csrf = '';
  const post = (url: string, body: object) =>
    agent
      .post('/api' + url)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf)
      .send(body);
  const put = (url: string, body: object) =>
    agent
      .put('/api' + url)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf)
      .send(body);
  return {
    app,
    db,
    agent,
    post,
    put,
    get csrf() {
      return csrf;
    },
    async setup() {
      const response = await post('/auth/setup', {
        name: 'Test Administrator',
        username: 'test-admin',
        password: 'A-long-test-password-2026',
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      csrf = response.body.csrf_token;
      return response;
    },
    dispose() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function readyProject(f: ReturnType<typeof fixture>) {
  const response = await f.post('/projects', {
    name: 'Pump Research',
    description: 'Research pump manufacturers',
    website: 'https://example.org',
  });
  assert.equal(response.status, 201);
  const id = response.body.id;
  let project: Project = response.body;
  let added = await f.post('/projects/' + id + '/sources', {
    revision: project.revision,
    title: 'Training brief',
    content:
      'Target pump manufacturers with their own engineering teams. Exclude direct bearing manufacturers. Technical resellers are acceptable.',
  });
  assert.equal(added.status, 201);
  project = (await f.agent.get('/api/projects/' + id)).body.project;
  added = await f.post('/projects/' + id + '/sources/website', {
    revision: project.revision,
    url: 'https://example.org',
  });
  assert.equal(added.status, 201);
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
test('secure setup, authentication, CSRF, origin validation, explicit roles and logout revocation', async () => {
  const f = fixture();
  try {
    assert.equal((await f.agent.get('/api/projects')).status, 401);
    assert.equal((await f.agent.get('/api/auth/me')).body.setup_required, true);
    assert.equal(
      (
        await f.agent.post('/api/auth/setup').send({
          name: 'No',
          username: 'no-user',
          password: 'some-long-password',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.post('/auth/setup', {
          name: 'No',
          username: 'no-user',
          password: 'short',
        })
      ).status,
      400,
    );
    const setup = await f.setup();
    assert.match(setup.headers['set-cookie'][0], /HttpOnly/);
    assert.match(setup.headers['set-cookie'][0], /SameSite=Strict/);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    assert.equal(
      (
        await f.post('/auth/setup', {
          name: 'Second',
          username: 'second',
          password: 'some-long-password',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.agent
          .post('/api/projects')
          .set('X-Requested-With', 'Innovista')
          .send({ name: 'No CSRF' })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.agent
          .post('/api/projects')
          .set('X-Requested-With', 'Innovista')
          .set('X-CSRF-Token', f.csrf)
          .set('Origin', 'https://evil.example')
          .send({ name: 'Cross origin' })
      ).status,
      403,
    );
    assert.equal((await f.agent.get('/api/projects').set('Host', 'evil.example')).status, 403);
    assert.equal(
      (await request(f.app).get('/api/projects').set('Cookie', 'innovista_session=%ZZ')).status,
      401,
    );
    assert.equal((await f.post('/auth/logout', {})).status, 200);
    assert.equal((await request(f.app).get('/api/projects').set('Cookie', cookie)).status, 401);
    assert.equal(
      (
        await f.post('/auth/login', {
          username: 'sageer',
          password: 'sageer@135',
        })
      ).status,
      401,
    );
  } finally {
    f.dispose();
  }
});
test('training is required; publishing makes a source snapshot; every rule is assessed; human review preserves AI result', async () => {
  const f = fixture();
  try {
    await f.setup();
    const raw = await f.post('/projects/1/leads', {
      name: 'Untrained Lead',
      website: 'https://example.com',
    });
    assert.equal((await f.post('/projects/1/leads/' + raw.body.id + '/qualify', {})).status, 409);
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Apex Pumps',
      website: 'https://example.com',
      industry: 'Industrial pumps',
      country: 'Germany',
    });
    assert.equal(created.status, 201);
    const base = '/projects/' + project.id + '/leads/' + created.body.id;
    const qualified = await f.post(base + '/qualify', {});
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.equal(qualified.body.result.score, 100);
    assert.equal(qualified.body.result.decision, 'QUALIFIED');
    let lead = (await f.agent.get('/api' + base)).body;
    assert.equal(lead.runs[0].training_version, 1);
    assert.equal(lead.runs[0].evidence.length, 4);
    assert.equal(lead.stale, false);
    assert.equal(
      (
        await f.post(base + '/review', {
          run_id: lead.latest_run_id,
          decision: 'NOT_A_TARGET',
          notes: 'short',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.post(base + '/review', {
          run_id: lead.latest_run_id,
          decision: 'NOT_A_TARGET',
          notes: 'A reviewer confirmed the entity is a competitor.',
        })
      ).status,
      200,
    );
    lead = (await f.agent.get('/api' + base)).body;
    assert.equal(lead.status, 'NOT_A_TARGET');
    assert.equal(lead.reviewed, true);
    assert.equal(lead.runs[0].result.decision, 'QUALIFIED');
    assert.equal(lead.reviews[0].created_by, 'Test Administrator');
    const snapshot = (await f.agent.get('/api/projects/' + project.id + '/training/versions/1'))
      .body.snapshot;
    assert.deepEqual(snapshot.rubric, rubric);
    assert.equal(snapshot.sources.length, 2);
    const saved = await f.put('/projects/' + project.id + '/training/rubric', {
      revision: project.revision,
      rubric: {
        ...rubric,
        summary: 'Updated context for a different pump market and engineering scope.',
      },
    });
    assert.equal(saved.status, 200);
    lead = (await f.agent.get('/api' + base)).body;
    assert.equal(lead.stale, true);
    assert.equal((await f.post(base + '/qualify', {})).status, 409);
    assert.equal(
      (
        await f.post(base + '/review', {
          run_id: lead.latest_run_id,
          decision: 'QUALIFIED',
          notes: 'Trying to approve stale context.',
        })
      ).status,
      409,
    );
    assert.deepEqual(
      (await f.agent.get('/api/projects/' + project.id + '/training/versions/1')).body.snapshot,
      snapshot,
    );
    assert.equal(
      (
        await f.post('/projects/' + project.id + '/training/publish', {
          revision: saved.body.revision,
        })
      ).status,
      200,
    );
    assert.equal((await f.post(base + '/qualify', {})).status, 200);
    lead = (await f.agent.get('/api' + base)).body;
    assert.equal(lead.runs.length, 2);
    assert.equal(lead.runs[0].training_version, 2);
    assert.equal(lead.reviewed, false);
  } finally {
    f.dispose();
  }
});
test('project scope prevents cross-project reads, source downloads, updates, qualification and reviews', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Scoped Lead',
    });
    const id = created.body.id;
    const source = (await f.agent.get('/api/projects/' + project.id)).body.sources[0];
    assert.equal((await f.agent.get('/api/projects/1/leads/' + id)).status, 404);
    assert.equal(
      (await f.put('/projects/1/leads/' + id, { revision: 1, name: 'Leak' })).status,
      404,
    );
    assert.equal((await f.post('/projects/1/leads/' + id + '/qualify', {})).status, 404);
    assert.equal((await f.post('/projects/1/leads/' + id + '/review', {})).status, 404);
    assert.equal(
      (await f.agent.get('/api/projects/1/sources/' + source.id + '/download')).status,
      404,
    );
    assert.equal(
      (
        await f.agent
          .delete('/api/projects/1/sources/' + source.id)
          .set('X-Requested-With', 'Innovista')
          .set('X-CSRF-Token', f.csrf)
          .send({ revision: 1 })
      ).status,
      404,
    );
    assert.equal((await f.agent.get('/api/projects/1/training/versions/1')).status, 404);
    assert.equal((await f.agent.get('/api/projects/1/leads')).body.total, 0);
  } finally {
    f.dispose();
  }
});
test('malformed, invented-source and incomplete-rule AI results cannot change leads', async () => {
  let mode = 'invalid';
  const f = fixture(async (...args) => {
    if (mode === 'invalid') return { decision: 'QUALIFIED', score: 100 };
    const result = (await generated(...args)) as Qualification;
    if (mode === 'source') result.criteria[0].source_ids = ['invented'];
    else result.criteria.pop();
    return result;
  });
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Validation Lead',
      website: 'https://example.com',
    });
    for (mode of ['invalid', 'source', 'rule']) {
      assert.equal(
        (await f.post('/projects/' + project.id + '/leads/' + created.body.id + '/qualify', {}))
          .status,
        502,
      );
      const lead = (await f.agent.get('/api/projects/' + project.id + '/leads/' + created.body.id))
        .body;
      assert.equal(lead.status, 'UNREVIEWED');
      assert.equal(lead.runs.length, 0);
    }
  } finally {
    f.dispose();
  }
});
test('low confidence and missing public website evidence route to review', async () => {
  const f = fixture(async (...args) => {
    const result = (await generated(...args)) as Qualification;
    result.confidence = 50;
    result.criteria.forEach((c) => (c.source_ids = ['E1']));
    result.exclusions.forEach((c) => (c.source_ids = ['E1']));
    return result;
  });
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'No Website Lead',
    });
    const response = await f.post(
      '/projects/' + project.id + '/leads/' + created.body.id + '/qualify',
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.result.decision, 'NEEDS_REVIEW');
    assert.ok(
      response.body.result.gaps.some((g: string) => g.includes('No readable public website')),
    );
  } finally {
    f.dispose();
  }
});
test('lead edits invalidate qualifications and stale edit requests are rejected', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Editable Lead',
      website: 'https://example.com',
    });
    const base = '/projects/' + project.id + '/leads/' + created.body.id;
    await f.post(base + '/qualify', {});
    const updated = await f.put(base, {
      revision: 1,
      name: 'New Identity',
      website: 'https://example.org',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.stale, true);
    assert.equal((await f.put(base, { revision: 1, name: 'Stale Edit' })).status, 409);
  } finally {
    f.dispose();
  }
});
test('CSV import validates atomically, deduplicates within project, and export neutralizes formulas', async () => {
  const f = fixture();
  try {
    await f.setup();
    const upload = (csv: string) =>
      f.agent
        .post('/api/projects/1/leads/import')
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', f.csrf)
        .attach('file', Buffer.from(csv), 'leads.csv');
    assert.equal(
      (await upload('name,website\nValid Lead,https://example.com\n,broken')).status,
      400,
    );
    assert.equal((await f.agent.get('/api/projects/1/leads')).body.total, 0);
    const result = await upload(
      'name,website,country\nMüller GmbH,https://example.com,Germany\nMueller GmbH,https://other.org,Germany\n=SUM(A1),https://formula.example,France',
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.created, 2);
    assert.equal(result.body.skipped, 1);
    const exported = await f.agent.get('/api/projects/1/leads/export');
    assert.equal(exported.status, 200);
    assert.ok(exported.text.includes("'=SUM(A1)"));
    const other = await f.post('/projects', { name: 'Another Project' });
    assert.equal(
      (
        await f.post('/projects/' + other.body.id + '/leads', {
          name: 'Mueller GmbH',
          website: 'https://example.com',
        })
      ).status,
      201,
    );
    assert.equal((await f.agent.get('/api/projects/1/leads?search=%25')).body.total, 0);
    assert.equal(
      (await f.agent.get('/api/projects/1/leads?search=%27%20OR%201%3D1--')).body.total,
      0,
    );
  } finally {
    f.dispose();
  }
});
test('training analysis is a proposal, not an implicit publication', async () => {
  const f = fixture();
  try {
    await f.setup();
    const analyzed = await f.post('/projects/1/training/analyze', {
      revision: 1,
    });
    assert.equal(analyzed.status, 200);
    assert.deepEqual(analyzed.body.rubric, rubric);
    const project = (await f.agent.get('/api/projects/1')).body.project;
    assert.equal(project.active_version, null);
    assert.notEqual(project.rubric.summary, rubric.summary);
    assert.equal((await f.agent.get('/api/projects/1/training/analyses')).body.length, 1);
  } finally {
    f.dispose();
  }
});

test('password changes revoke previous sessions and return a fresh CSRF token', async () => {
  const f = fixture();
  try {
    const setup = await f.setup();
    const oldCookie = setup.headers['set-cookie'][0].split(';')[0];
    const response = await f.post('/auth/password', {
      current_password: 'A-long-test-password-2026',
      password: 'A-different-long-password-2026',
    });
    assert.equal(response.status, 200);
    assert.notEqual(response.body.csrf_token, f.csrf);
    assert.equal((await request(f.app).get('/api/projects').set('Cookie', oldCookie)).status, 401);
    assert.equal((await f.agent.get('/api/projects')).status, 200);
    assert.equal(
      (
        await f.post('/auth/login', {
          username: 'test-admin',
          password: 'A-long-test-password-2026',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.post('/auth/login', {
          username: 'test-admin',
          password: 'A-different-long-password-2026',
        })
      ).status,
      200,
    );
  } finally {
    f.dispose();
  }
});

test('a changed business website and unresolved training questions block publication', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const saved = await f.put('/projects/' + project.id + '/training/rubric', {
      revision: project.revision,
      rubric: { ...rubric, questions: ['Confirm the target geography.'] },
    });
    assert.equal(
      (
        await f.post('/projects/' + project.id + '/training/publish', {
          revision: saved.body.revision,
        })
      ).status,
      400,
    );
    const clean = await f.put('/projects/' + project.id + '/training/rubric', {
      revision: saved.body.revision,
      rubric,
    });
    const updated = await f.put('/projects/' + project.id, {
      revision: clean.body.revision,
      name: project.name,
      description: project.description,
      website: 'https://different.example.com',
    });
    assert.equal(
      (
        await f.post('/projects/' + project.id + '/training/publish', {
          revision: updated.body.revision,
        })
      ).status,
      400,
    );
    assert.equal((await f.agent.get('/api/projects/' + project.id)).body.versions.length, 1);
  } finally {
    f.dispose();
  }
});
test('admin settings encrypt keys, never expose plaintext, block key forwarding and enforce roles', async () => {
  const f = fixture();
  try {
    await f.setup();
    const secret = 'unique-fixture-api-secret-that-must-not-leak';
    const response = await f.put('/settings/llm', {
      provider: 'openai_compatible',
      model: 'fixture-model',
      base_url: 'https://api.example.com/v1',
      api_key: secret,
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.stringify(response.body).includes(secret), false);
    assert.equal(response.body.has_api_key, true);
    const stored = f.db.prepare("SELECT value FROM settings WHERE key='api_key'").get() as {
      value: string;
    };
    assert.ok(stored.value.startsWith('enc:v1:'));
    assert.equal(stored.value.includes(secret), false);
    assert.equal(
      (
        await f.put('/settings/llm', {
          provider: 'openai_compatible',
          model: 'fixture-model',
          base_url: 'https://evil.example/v1',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.put('/settings/llm', {
          provider: 'openai_compatible',
          model: 'fixture-model',
          base_url: 'https://127.0.0.1/v1',
          api_key: 'x',
        })
      ).status,
      400,
    );
    const account = await f.post('/users', {
      name: 'Admin Impersonator',
      username: 'researcher-admin',
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
      .send({
        username: 'researcher-admin',
        password: 'Another-long-password',
      });
    assert.equal(login.status, 200);
    assert.equal((await researcher.get('/api/settings/llm')).status, 403);
    assert.equal((await researcher.get('/api/users')).status, 403);
    assert.equal((await researcher.get('/api/projects')).status, 200);
    const forbidden = await researcher
      .post('/api/projects')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', login.body.csrf_token)
      .set('X-User-Name', 'Forged User')
      .send({ name: 'Audit Identity' });
    assert.equal(forbidden.status, 403);
    assert.equal((await researcher.get('/api/projects')).body.length, 1);
    const created = await researcher
      .post('/api/projects/1/leads')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', login.body.csrf_token)
      .set('X-User-Name', 'Forged User')
      .send({ name: 'Audit Identity' });
    assert.equal(created.status, 201);
    const event = (await researcher.get('/api/projects/1/activity')).body[0];
    assert.equal(event.actor, 'Admin Impersonator');
    await f.agent
      .patch('/api/users/' + account.body.id)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', f.csrf)
      .send({ active: false });
    assert.equal((await researcher.get('/api/projects')).status, 401);
  } finally {
    f.dispose();
  }
});
test('concurrent qualification is bounded and training edits during analysis prevent stale writes', async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (...args) => {
    started();
    await gate;
    return generated(...args);
  });
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Concurrent Lead',
      website: 'https://example.com',
    });
    const base = '/projects/' + project.id + '/leads/' + created.body.id;
    const pending = f.post(base + '/qualify', {}).then((r) => r);
    await waiting;
    assert.equal((await f.post(base + '/qualify', {})).status, 409);
    assert.equal(
      (
        await f.put('/projects/' + project.id + '/training/rubric', {
          revision: project.revision,
          rubric: {
            ...rubric,
            summary: 'Updated qualification context after this run started.',
          },
        })
      ).status,
      200,
    );
    release();
    assert.equal((await pending).status, 409);
    assert.equal((await f.agent.get('/api' + base)).body.runs.length, 0);
  } finally {
    release();
    f.dispose();
  }
});
test('source uploads reject binary/mislabeled files and preserve original text downloads', async () => {
  const f = fixture();
  try {
    await f.setup();
    const upload = (name: string, content: Buffer) =>
      f.agent
        .post('/api/projects/1/sources/upload')
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', f.csrf)
        .field('revision', '1')
        .attach('file', content, name);
    assert.equal((await upload('fake.pdf', Buffer.from('not pdf'))).status, 400);
    assert.equal((await upload('fake.docx', Buffer.from('not zip'))).status, 400);
    assert.equal((await upload('malware.exe', Buffer.alloc(100))).status, 400);
    assert.equal((await upload('binary.txt', Buffer.alloc(100))).status, 400);
    const content =
      '# Research brief\nThis is a sufficiently long training document for testing attachment integrity and UTF-8 handling.\n';
    const response = await upload('brief.md', Buffer.from(content));
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const downloaded = await f.agent.get(
      '/api/projects/1/sources/' + response.body.id + '/download',
    );
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers['content-disposition'], /attachment/);
    assert.equal(downloaded.body.toString('utf8'), content);
  } finally {
    f.dispose();
  }
});
test('document extraction is bounded per researcher, so colleagues never block each other', async () => {
  let release!: () => void;
  let firstStarted!: () => void;
  let bothStarted!: () => void;
  let running = 0;
  const first = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const both = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-test-'));
  const { app, db } = createApp({
    dataDir: dir,
    generate: generated,
    // Stand in for the forked worker so the extraction window is deterministic.
    extractDocument: async () => {
      running++;
      if (running === 1) firstStarted();
      if (running === 2) bothStarted();
      await gate;
      return 'Extracted training text long enough to pass the readable-content threshold.';
    },
  });
  const admin = request.agent(app);
  const send = (agent: ReturnType<typeof request.agent>, url: string, csrf: string) =>
    agent
      .post('/api' + url)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf);
  try {
    const setup = await send(admin, '/auth/setup', '').send({
      name: 'Test Administrator',
      username: 'test-admin',
      password: 'A-long-test-password-2026',
    });
    assert.equal(setup.status, 201, JSON.stringify(setup.body));
    const adminCsrf = setup.body.csrf_token;
    const created = await send(admin, '/users', adminCsrf).send({
      username: 'second-researcher',
      name: 'Second Researcher',
      password: 'Another-long-test-password-2026',
      role: 'researcher',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const colleague = request.agent(app);
    const login = await send(colleague, '/auth/login', '').send({
      username: 'second-researcher',
      password: 'Another-long-test-password-2026',
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    // Separate projects, so only the extraction lock — not the project revision — can conflict.
    const second = await send(admin, '/projects', adminCsrf).send({ name: 'Second Project' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const assigned = await admin
      .put('/api/users/' + created.body.id + '/projects')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', adminCsrf)
      .send({ project_ids: [second.body.id] });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    const attach = (
      agent: ReturnType<typeof request.agent>,
      csrf: string,
      projectId: number,
      revision: number,
    ) =>
      send(agent, '/projects/' + projectId + '/sources/upload', csrf)
        .field('revision', String(revision))
        .attach('file', Buffer.from('placeholder'), 'brief.docx')
        .then((response) => response);
    const mine = attach(admin, adminCsrf, 1, 1);
    await first;
    const theirs = attach(colleague, login.body.csrf_token, second.body.id, second.body.revision);
    // Resolves via `both` once the colleague's extraction overlaps, or via `theirs` if it was refused.
    await Promise.race([both, theirs]);
    release();
    for (const response of await Promise.all([mine, theirs]))
      assert.equal(response.status, 201, JSON.stringify(response.body));
  } finally {
    release();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('project assignment is an access boundary that researchers cannot cross', async () => {
  const f = fixture();
  try {
    await f.setup();
    const open = await readyProject(f);
    const closed = await f.post('/projects', { name: 'Unassigned Project' });
    assert.equal(closed.status, 201);
    const account = await f.post('/users', {
      name: 'Assigned Researcher',
      username: 'assigned-researcher',
      password: 'A-long-researcher-password-2026',
      role: 'researcher',
    });
    assert.equal(account.status, 201);
    const researcher = request.agent(f.app);
    const login = await researcher
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'assigned-researcher', password: 'A-long-researcher-password-2026' });
    assert.equal(login.status, 200);
    // Nothing is visible until an administrator assigns a project.
    assert.deepEqual((await researcher.get('/api/projects')).body, []);
    assert.equal((await researcher.get('/api/projects/' + open.id)).status, 404);
    assert.equal(
      (await f.put('/users/' + account.body.id + '/projects', { project_ids: [open.id] })).status,
      200,
    );
    const visible = await researcher.get('/api/projects');
    assert.equal(visible.body.length, 1);
    assert.equal(visible.body[0].id, open.id);
    assert.equal((await researcher.get('/api/projects/' + open.id)).status, 200);
    // An unassigned project stays unreachable on every project-scoped route.
    assert.equal((await researcher.get('/api/projects/' + closed.body.id)).status, 404);
    assert.equal((await researcher.get('/api/projects/' + closed.body.id + '/leads')).status, 404);
    assert.equal(
      (await researcher.get('/api/projects/' + closed.body.id + '/activity')).status,
      404,
    );
    assert.equal(
      (await researcher.get('/api/projects/' + closed.body.id + '/leads/export')).status,
      404,
    );
    const write = await researcher
      .post('/api/projects/' + closed.body.id + '/leads')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', login.body.csrf_token)
      .send({ name: 'Should Not Exist' });
    assert.equal(write.status, 404);
    // Researchers cannot grant themselves access.
    const escalate = await researcher
      .put('/api/users/' + account.body.id + '/projects')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', login.body.csrf_token)
      .send({ project_ids: [open.id, closed.body.id] });
    assert.equal(escalate.status, 403);
    // Revoking the assignment closes access again.
    assert.equal(
      (await f.put('/users/' + account.body.id + '/projects', { project_ids: [] })).status,
      200,
    );
    assert.equal((await researcher.get('/api/projects/' + open.id)).status, 404);
  } finally {
    f.dispose();
  }
});
test('a contact is kept only when the website evidence itself published it', async () => {
  const uncited = (config: unknown, system: string, input: unknown) =>
    generated(config as never, system, input).then((result) => ({
      ...(result as Qualification),
      outreach: {
        contact_name: 'Invented Person',
        contact_role: 'Chief Executive',
        // Cites the user-supplied lead record, not the company website.
        contact_source_ids: ['E1'],
        why_qualified: 'Reasoning.',
        call_script: 'Script.',
      },
    }));
  const f = fixture(uncited as Generate);
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Uncited Contact Ltd',
      website: 'https://example.com',
    });
    const qualified = await f.post(
      '/projects/' + project.id + '/leads/' + created.body.id + '/qualify',
      {},
    );
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.equal(qualified.body.result.outreach.contact_name, '');
    assert.equal(qualified.body.result.outreach.contact_role, '');
    assert.ok(
      qualified.body.result.gaps.some((gap: string) => gap.includes('without website evidence')),
    );
    const lead = (await f.agent.get('/api/projects/' + project.id + '/leads/' + created.body.id))
      .body;
    assert.equal(lead.contact_name, '');
    assert.ok(
      !(await f.agent.get('/api/projects/' + project.id + '/leads/export')).text.includes(
        'Invented Person',
      ),
    );
  } finally {
    f.dispose();
  }
});
test('a website-cited contact is stored, exported, and erasable', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Cited Contact Ltd',
      website: 'https://example.com',
    });
    const base = '/projects/' + project.id + '/leads/' + created.body.id;
    assert.equal((await f.post(base + '/qualify', {})).status, 200);
    const lead = (await f.agent.get('/api' + base)).body;
    assert.equal(lead.contact_name, 'Dana Prakash');
    assert.equal(lead.contact_role, 'Head of Engineering');
    // Score 100 against the approved rubric puts the lead in the call-ready band.
    assert.equal(lead.next_step, 'CALL_READY');
    assert.equal(lead.runs[0].result.outreach.call_script.length > 0, true);
    const listed = await f.agent.get('/api/projects/' + project.id + '/leads?status=CALL_READY');
    assert.equal(listed.body.total, 1);
    assert.equal(listed.body.leads[0].contact_name, 'Dana Prakash');
    assert.equal(
      (await f.agent.get('/api/projects/' + project.id + '/leads?status=SEND_EMAIL')).body.total,
      0,
    );
    const exported = await f.agent.get('/api/projects/' + project.id + '/leads/export');
    assert.ok(exported.text.includes('Dana Prakash'));
    assert.ok(exported.text.includes('CALL_READY'));
    const erased = await f.agent
      .delete('/api' + base + '/contact')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', f.csrf);
    assert.equal(erased.status, 200);
    assert.equal(erased.body.contact_name, '');
    // Erasure clears the lead column; the original run keeps its immutable record.
    assert.equal((await f.agent.get('/api' + base)).body.contact_name, '');
  } finally {
    f.dispose();
  }
});
test('lead feedback becomes project training without rewriting the original result', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Wrongly Qualified Ltd',
      website: 'https://example.com',
    });
    const base = '/projects/' + project.id + '/leads/' + created.body.id;
    const run = await f.post(base + '/qualify', {});
    assert.equal(run.status, 200);
    assert.equal(
      (await f.post(base + '/feedback', { run_id: run.body.run_id, verdict: 'INCORRECT' })).status,
      400,
    );
    const feedback = await f.post(base + '/feedback', {
      run_id: run.body.run_id,
      verdict: 'INCORRECT',
      expected_decision: 'NOT_A_TARGET',
      notes: 'This company only resells finished pumps and has no specification authority.',
    });
    assert.equal(feedback.status, 201, JSON.stringify(feedback.body));
    assert.equal(feedback.body.project.pending_feedback_count, 1);
    // The stored analysis and the lead decision are untouched by a correction.
    const lead = (await f.agent.get('/api' + base)).body;
    assert.equal(lead.status, 'QUALIFIED');
    assert.equal(lead.runs[0].result.decision, 'QUALIFIED');
    assert.equal(lead.feedback[0].expected_decision, 'NOT_A_TARGET');
    // Feedback is new project knowledge, so it invalidates the published training.
    assert.equal(lead.stale, true);
    assert.equal(lead.next_step, 'NONE');
    const current = (await f.agent.get('/api/projects/' + project.id)).body.project;
    assert.notEqual(current.revision, current.trained_revision);
    const published = await f.post('/projects/' + project.id + '/training/publish', {
      revision: current.revision,
    });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.pending_feedback_count, 0);
    const version = await f.agent.get(
      '/api/projects/' + project.id + '/training/versions/' + published.body.active_version,
    );
    assert.equal(version.body.snapshot.feedback.length, 1);
    assert.equal(version.body.snapshot.feedback[0].lead_name, 'Wrongly Qualified Ltd');
    assert.match(version.body.snapshot.feedback[0].notes, /no specification authority/);
    // Feedback from one project never reaches another.
    assert.equal((await f.agent.get('/api/projects/1/feedback')).body.length, 0);
    const foreign = await f.post('/projects/1/leads/' + created.body.id + '/feedback', {
      run_id: null,
      verdict: 'CORRECT',
      notes: 'Attempting to attach feedback across project boundaries.',
    });
    assert.equal(foreign.status, 404);
  } finally {
    f.dispose();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { citationSupports, pageNamesCompany, sameSite } from '../server/enrich';
import { type Generate } from '../server/ai';
import type { WebsitePage } from '../server/network';
import type {
  Project,
  TrainingSnapshot,
  Qualification,
  Evidence,
  Lead,
  ResearchOutcome,
} from '../shared/types';

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
function fixture(
  // A null model means the app is built with no model at all, which is how an unconfigured
  // provider is driven; research tests also need exact page text, so the site is injectable.
  call: Generate | null = generated,
  mail?: (config: unknown, message: SentMail) => Promise<void>,
  fetchPage?: (url: string) => Promise<WebsitePage>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-test-'));
  const { app, db } = createApp({
    dataDir: dir,
    generate: call ?? undefined,
    sendMail: mail as never,
    fetchWebsite:
      fetchPage ||
      (async (url) => ({
        url,
        content:
          'Example company designs and manufactures industrial pumps. Its engineering team specifies third-party bearings, and it does not manufacture bearings. ' +
          url,
        truncated: false,
        links: [new URL('/about', url).href, new URL('/products', url).href],
      })),
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
test('import reports unusable rows, deduplicates within project, and export neutralizes formulas', async () => {
  const f = fixture();
  try {
    await f.setup();
    const upload = (csv: string) =>
      f.agent
        .post('/api/projects/1/leads/import')
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', f.csrf)
        .attach('file', Buffer.from(csv), 'leads.csv');
    // A row without a company name is reported, not fatal: the valid lead still lands.
    const mixed = await upload('name,website\nValid Lead,https://example.com\n,broken');
    assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
    assert.equal(mixed.body.created, 1);
    assert.equal(mixed.body.invalid, 1);
    assert.equal(mixed.body.problems[0].row, 3);
    assert.equal((await f.agent.get('/api/projects/1/leads')).body.total, 1);
    assert.equal(
      (
        await f.agent
          .post('/api/projects/1/leads/delete')
          .set('X-Requested-With', 'Innovista')
          .set('X-CSRF-Token', f.csrf)
          .send({ ids: [mixed.body.created && 1] })
      ).status,
      200,
    );
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
/**
 * Exact page text per address. A research test has to be able to say what a site does NOT
 * say, so an address with no entry here fails to load instead of quietly returning something
 * plausible — which is also how an unreachable website is driven.
 */
function pageSet(pages: Record<string, string>) {
  return async (url: string): Promise<WebsitePage> => {
    const content = pages[url];
    if (content === undefined) throw new Error('This website could not be reached.');
    return { url, content, truncated: false, links: [] };
  };
}
interface ResearchReply {
  domains?: string[];
  fields?: Array<{ field: string; value: string; evidence: string }>;
  notes?: string[];
}
/**
 * A model that answers only the two research prompts. Rubric and qualification prompts fall
 * through to the ordinary stub, so a research test can set its lead up the way the product
 * does — qualified and reviewed, and therefore able to go stale.
 */
function researchModel(reply: (company: string) => ResearchReply): Generate {
  return async (config, system, input) => {
    const answer = reply(String((input as { company?: string }).company ?? ''));
    if (system.includes('candidate official website domains'))
      return { domains: answer.domains || [] };
    if (system.includes('extract company facts'))
      return { fields: answer.fields || [], notes: answer.notes || [] };
    return generated(config, system, input);
  };
}
const pumpSite =
  'Rotterdam Pump Works designs and manufactures industrial pumps. Its engineering team specifies third-party bearings, and it does not manufacture bearings. ' +
  'Rotterdam Pump Works is a specialist in chemical process pumps for the chemical industry. It has worked from Rotterdam since 1962.';
const pumpHome = 'https://rotterdam-pumps.example.com';
/** A qualified, reviewed lead, so that research can be seen to unsettle it — or not. */
async function reviewedPumpLead(f: ReturnType<typeof fixture>) {
  const project = await readyProject(f);
  const created = await f.post('/projects/' + project.id + '/leads', {
    name: 'Rotterdam Pump Works',
    website: pumpHome,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const base = '/projects/' + project.id + '/leads/' + created.body.id;
  const run = await f.post(base + '/qualify', {});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const reviewed = await f.post(base + '/review', {
    run_id: run.body.run_id,
    decision: 'QUALIFIED',
    notes: 'Confirmed against the captured website evidence.',
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const lead = reviewed.body as Lead;
  assert.equal(lead.reviewed, true);
  assert.equal(lead.stale, false);
  assert.equal(lead.industry, '');
  return { project, base, lead };
}
test('a cited research value is written, and applying it makes the previous qualification stale', async () => {
  const f = fixture(
    researchModel(() => ({
      fields: [
        {
          field: 'industry',
          value: 'Chemical process pumps',
          // Quoted from the fetched page, punctuation and all.
          evidence:
            'Rotterdam Pump Works is a specialist in chemical process pumps for the chemical industry.',
        },
      ],
    })),
    undefined,
    pageSet({ 'https://example.org': pumpSite, [pumpHome]: pumpSite }),
  );
  try {
    await f.setup();
    const { project, base, lead } = await reviewedPumpLead(f);
    const research = await f.post(base + '/research', {});
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    assert.deepEqual(outcome.applied, ['industry']);
    assert.deepEqual(outcome.refused, []);
    assert.equal(outcome.discovered, false);
    assert.equal(outcome.website, pumpHome);
    assert.equal(outcome.proposals.length, 1);
    assert.equal(outcome.proposals[0].field, 'industry');
    assert.equal(outcome.proposals[0].source_url, pumpHome);
    const after = (await f.agent.get('/api' + base)).body as Lead;
    assert.equal(after.industry, 'Chemical process pumps');
    // Applying is an ordinary recorded edit: the revision moves, the review is cleared and the
    // earlier verdict is stale until the lead is analyzed again.
    assert.equal(after.revision, lead.revision + 1);
    assert.equal(after.reviewed, false);
    assert.equal(after.stale, true);
    assert.equal(after.next_step, 'NONE');
    assert.ok(
      (await f.agent.get('/api/projects/' + project.id + '/activity')).text.includes(
        'Filled industry',
      ),
    );
  } finally {
    f.dispose();
  }
});
test('an uncited research value is refused and the lead does not move at all', async () => {
  const f = fixture(
    researchModel(() => ({
      fields: [
        {
          field: 'industry',
          // Plausible, well shaped, and cited to a sentence that is nowhere in the page.
          value: 'Aerospace fasteners',
          evidence: 'Rotterdam Pump Works is a leading supplier of aerospace fasteners in Europe.',
        },
        {
          field: 'city',
          // On the page, but too short to be a citation of anything.
          value: 'Rotterdam',
          evidence: 'Rotterdam',
        },
      ],
    })),
    undefined,
    pageSet({ 'https://example.org': pumpSite, [pumpHome]: pumpSite }),
  );
  try {
    await f.setup();
    const { base, lead } = await reviewedPumpLead(f);
    const research = await f.post(base + '/research', {});
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    assert.deepEqual(outcome.applied, []);
    assert.deepEqual(outcome.proposals, []);
    assert.equal(outcome.refused.length, 2);
    assert.deepEqual(
      outcome.refused.map((entry) => entry.field),
      ['industry', 'city'],
    );
    assert.equal(outcome.refused[0].value, 'Aerospace fasteners');
    assert.match(outcome.refused[0].reason, /No supporting sentence from the page was provided/);
    assert.match(outcome.refused[1].reason, /No supporting sentence from the page was provided/);
    const after = (await f.agent.get('/api' + base)).body as Lead;
    // The anti-fabrication guarantee: the invented fact reached the record nowhere at all.
    assert.equal(after.industry, '');
    assert.equal(after.city, '');
    assert.ok(!JSON.stringify(after).includes('Aerospace fasteners'));
    assert.equal(after.revision, lead.revision);
    assert.equal(after.reviewed, true);
    assert.equal(after.stale, false);
  } finally {
    f.dispose();
  }
});
test('a proposed website is recorded only once its own page names the company', async () => {
  const site =
    'Meridian Vacuum Systems builds vacuum pump skids in Lyon. Meridian Vacuum Systems has served the process industry since 1974.';
  const f = fixture(
    researchModel(() => ({ domains: ['meridianvacuum.example.com'] })),
    undefined,
    pageSet({ 'https://meridianvacuum.example.com': site }),
  );
  try {
    await f.setup();
    const project = await f.post('/projects', { name: 'Vacuum Research' });
    assert.equal(project.status, 201);
    const created = await f.post('/projects/' + project.body.id + '/leads', {
      name: 'Meridian Vacuum Systems',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.website, '');
    const base = '/projects/' + project.body.id + '/leads/' + created.body.id;
    const research = await f.post(base + '/research', {});
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    assert.equal(outcome.discovered, true);
    // Every candidate that was actually fetched is reported, so a repeat run is not a mystery.
    assert.deepEqual(outcome.tried, ['meridianvacuum.example.com']);
    assert.equal(outcome.website, 'https://meridianvacuum.example.com');
    assert.deepEqual(outcome.applied, ['website']);
    const after = (await f.agent.get('/api' + base)).body as Lead;
    assert.equal(after.website, 'https://meridianvacuum.example.com');
    assert.equal(after.revision, created.body.revision + 1);
  } finally {
    f.dispose();
  }
});
test('an unverifiable website is left blank, and the notes say which way it failed', async () => {
  const f = fixture(
    researchModel((company) => ({
      // Only the first company gets a candidate; the second is the model correctly declining.
      domains: company.startsWith('Parked') ? ['parked-holding.example.com'] : [],
    })),
    undefined,
    pageSet({
      'https://parked-holding.example.com':
        'This domain may be for sale. Inquire with the registrar for pricing and availability.',
    }),
  );
  try {
    await f.setup();
    const project = await f.post('/projects', { name: 'Discovery Research' });
    assert.equal(project.status, 201);
    const parked = await f.post('/projects/' + project.body.id + '/leads', {
      name: 'Parked Pumps International',
    });
    assert.equal(parked.status, 201, JSON.stringify(parked.body));
    const parkedBase = '/projects/' + project.body.id + '/leads/' + parked.body.id;
    const reachable = await f.post(parkedBase + '/research', {});
    assert.equal(reachable.status, 200, JSON.stringify(reachable.body));
    const first = reachable.body as ResearchOutcome;
    assert.equal(first.discovered, false);
    assert.equal(first.website, '');
    assert.deepEqual(first.applied, []);
    assert.deepEqual(first.proposals, []);
    assert.deepEqual(first.tried, ['parked-holding.example.com']);
    assert.ok(
      first.notes.some(
        (note) =>
          note.includes('parked-holding.example.com') &&
          /parked, for-sale or placeholder|does not name this company/.test(note),
      ),
      JSON.stringify(first.notes),
    );
    assert.equal(((await f.agent.get('/api' + parkedBase)).body as Lead).website, '');
    // A model with no basis for a candidate proposes none, and that is reported as a result.
    const silent = await f.post('/projects/' + project.body.id + '/leads', {
      name: 'Silent Valve Works',
    });
    assert.equal(silent.status, 201, JSON.stringify(silent.body));
    const silentBase = '/projects/' + project.body.id + '/leads/' + silent.body.id;
    const none = await f.post(silentBase + '/research', {});
    assert.equal(none.status, 200, JSON.stringify(none.body));
    const second = none.body as ResearchOutcome;
    assert.deepEqual(second.tried, []);
    assert.deepEqual(second.applied, []);
    assert.equal(second.discovered, false);
    assert.ok(
      second.notes.some((note) => note.includes('No candidate website could be proposed')),
      JSON.stringify(second.notes),
    );
    const afterSilent = (await f.agent.get('/api' + silentBase)).body as Lead;
    assert.equal(afterSilent.website, '');
    assert.equal(afterSilent.revision, silent.body.revision);
  } finally {
    f.dispose();
  }
});
test('a discovered website another lead in the project already holds is refused', async () => {
  const shared = 'https://sharedsite.example.com';
  const f = fixture(
    researchModel(() => ({ domains: ['sharedsite.example.com'] })),
    undefined,
    pageSet({ [shared]: 'Sharedsite Pumps manufactures process pumps for water utilities.' }),
  );
  try {
    await f.setup();
    const project = await f.post('/projects', { name: 'Duplicate Research' });
    assert.equal(project.status, 201);
    const holder = await f.post('/projects/' + project.body.id + '/leads', {
      name: 'Original Holder Works',
      website: shared,
    });
    assert.equal(holder.status, 201, JSON.stringify(holder.body));
    const created = await f.post('/projects/' + project.body.id + '/leads', {
      name: 'Sharedsite Pumps',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const base = '/projects/' + project.body.id + '/leads/' + created.body.id;
    const research = await f.post(base + '/research', {});
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    // The page verified, so it is reported as discovered — and still not written.
    assert.equal(outcome.discovered, true);
    assert.deepEqual(outcome.applied, []);
    const refusal = outcome.refused.find((entry) => entry.field === 'website');
    assert.ok(refusal, JSON.stringify(outcome));
    assert.equal(refusal.value, shared);
    assert.match(refusal.reason, /already belongs to .* in this project/);
    // Everything read from that page is refused, not just the address: a lead sharing another
    // lead's website is most likely a duplicate of it.
    assert.equal(outcome.refused.length, outcome.proposals.length, JSON.stringify(outcome.refused));
    const after = (await f.agent.get('/api' + base)).body as Lead;
    assert.equal(after.website, '');
    assert.equal(after.revision, created.body.revision);
    // The lead that does hold the website is untouched.
    assert.equal(
      (
        (await f.agent.get('/api/projects/' + project.body.id + '/leads/' + holder.body.id))
          .body as Lead
      ).website,
      shared,
    );
  } finally {
    f.dispose();
  }
});
test('a cited value that is not shaped like the field it claims is refused', async () => {
  const site =
    'Kestrel Filtration Systems builds filtration skids in Porto. Ask us on the contact page for the right department. ' +
    'We have grown to several hundred people across three sites.';
  const home = 'https://kestrel-filtration.example.com';
  const f = fixture(
    researchModel(() => ({
      fields: [
        {
          field: 'contact_email',
          value: 'ask us on the contact page',
          evidence: 'Ask us on the contact page for the right department.',
        },
        {
          field: 'employee_count',
          value: 'several hundred',
          evidence: 'We have grown to several hundred people across three sites.',
        },
        {
          field: 'industry',
          value: 'Filtration skids and housings for industrial process water treatment '.repeat(3),
          evidence: 'Kestrel Filtration Systems builds filtration skids in Porto.',
        },
      ],
    })),
    undefined,
    pageSet({ [home]: site }),
  );
  try {
    await f.setup();
    const project = await f.post('/projects', { name: 'Filtration Research' });
    assert.equal(project.status, 201);
    const created = await f.post('/projects/' + project.body.id + '/leads', {
      name: 'Kestrel Filtration Systems',
      website: home,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const base = '/projects/' + project.body.id + '/leads/' + created.body.id;
    const research = await f.post(base + '/research', {});
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    // Every quote here really is on the page: the shape is the only thing rejecting them.
    assert.deepEqual(outcome.applied, []);
    assert.deepEqual(outcome.proposals, []);
    assert.equal(outcome.refused.length, 3);
    const reason = (field: string) =>
      outcome.refused.find((entry) => entry.field === field)?.reason ?? '';
    assert.match(reason('contact_email'), /not shaped like a contact email/);
    assert.match(reason('employee_count'), /not shaped like a employee count/);
    assert.match(reason('industry'), /longer than the field allows/);
    const after = (await f.agent.get('/api' + base)).body as Lead;
    assert.equal(after.contact_email, '');
    assert.equal(after.employee_count, '');
    assert.equal(after.industry, '');
    assert.equal(after.revision, created.body.revision);
  } finally {
    f.dispose();
  }
});
test('research fills gaps only: a value a person entered is never asked about or overwritten', async () => {
  const site =
    'Baltic Sealing Works manufactures mechanical seals. Baltic Sealing Works operates from Gdansk, Poland. Our industry is aerospace tooling.';
  const home = 'https://baltic-sealing.example.com';
  let requested: string[] = [];
  const f = fixture(
    async (config, system, input) => {
      if (system.includes('extract company facts')) {
        requested = (input as { requested_fields: string[] }).requested_fields;
        return {
          fields: [
            {
              field: 'city',
              value: 'Gdansk',
              evidence: 'Baltic Sealing Works operates from Gdansk, Poland.',
            },
            // Offered for a field the record already holds, and cited from the page.
            {
              field: 'industry',
              value: 'Aerospace tooling',
              evidence: 'Our industry is aerospace tooling.',
            },
          ],
          notes: [],
        };
      }
      return generated(config, system, input);
    },
    undefined,
    pageSet({ [home]: site }),
  );
  try {
    await f.setup();
    const project = await f.post('/projects', { name: 'Sealing Research' });
    assert.equal(project.status, 201);
    const created = await f.post('/projects/' + project.body.id + '/leads', {
      name: 'Baltic Sealing Works',
      website: home,
      industry: 'Mechanical seals',
      country: 'Poland',
      contact_email: 'known.contact@example.com',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const base = '/projects/' + project.body.id + '/leads/' + created.body.id;
    const research = await f.post(base + '/research', {});
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    // Only the gaps were even put to the model.
    assert.ok(requested.includes('city'), JSON.stringify(requested));
    assert.ok(!requested.includes('industry'));
    assert.ok(!requested.includes('country'));
    assert.ok(!requested.includes('contact_email'));
    assert.ok(!requested.includes('website'));
    assert.deepEqual(outcome.applied, ['city']);
    assert.ok(!outcome.proposals.some((proposal) => proposal.field === 'industry'));
    assert.ok(!outcome.refused.some((entry) => entry.field === 'industry'));
    const after = (await f.agent.get('/api' + base)).body as Lead;
    assert.equal(after.city, 'Gdansk');
    assert.equal(after.industry, 'Mechanical seals');
    assert.equal(after.country, 'Poland');
    assert.equal(after.contact_email, 'known.contact@example.com');
  } finally {
    f.dispose();
  }
});
test('research answers 409 until an AI provider is configured', async () => {
  const f = fixture(null, undefined, pageSet({}));
  try {
    await f.setup();
    const project = await f.post('/projects', { name: 'Unconfigured Research' });
    assert.equal(project.status, 201);
    const created = await f.post('/projects/' + project.body.id + '/leads', {
      name: 'Anywhere Pumps',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const research = await f.post(
      '/projects/' + project.body.id + '/leads/' + created.body.id + '/research',
      {},
    );
    assert.equal(research.status, 409, JSON.stringify(research.body));
    assert.match(research.body.error, /Configure an AI provider/);
  } finally {
    f.dispose();
  }
});
test('research stays behind the project access boundary', async () => {
  const home = 'https://boundary-pumps.example.com';
  const f = fixture(
    researchModel(() => ({})),
    undefined,
    pageSet({ [home]: 'Boundary Pumps manufactures industrial pumps.' }),
  );
  try {
    await f.setup();
    const project = await f.post('/projects', { name: 'Closed Research' });
    assert.equal(project.status, 201);
    const created = await f.post('/projects/' + project.body.id + '/leads', {
      name: 'Boundary Pumps',
      website: home,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const account = await f.post('/users', {
      name: 'Outside Researcher',
      username: 'outside-researcher',
      password: 'A-long-researcher-password-2026',
      role: 'researcher',
    });
    assert.equal(account.status, 201);
    const outsider = request.agent(f.app);
    const login = await outsider
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'outside-researcher', password: 'A-long-researcher-password-2026' });
    assert.equal(login.status, 200);
    const blocked = await outsider
      .post('/api/projects/' + project.body.id + '/leads/' + created.body.id + '/research')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', login.body.csrf_token)
      .send({});
    // 404, not 403: membership must not be probeable by ID.
    assert.equal(blocked.status, 404);
    const after = (
      await f.agent.get('/api/projects/' + project.body.id + '/leads/' + created.body.id)
    ).body as Lead;
    assert.equal(after.revision, created.body.revision);
  } finally {
    f.dispose();
  }
});
test('nothing is written when the saved website cannot be read, and the outcome says so', async () => {
  const f = fixture(
    researchModel(() => ({
      // Never reached: with no page there is nothing to cite against.
      fields: [{ field: 'city', value: 'Bilbao', evidence: 'Offices in Bilbao, Spain.' }],
    })),
    undefined,
    pageSet({}),
  );
  try {
    await f.setup();
    const project = await f.post('/projects', { name: 'Unreachable Research' });
    assert.equal(project.status, 201);
    const created = await f.post('/projects/' + project.body.id + '/leads', {
      name: 'Offline Valves',
      website: 'https://offline-valves.example.com',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const base = '/projects/' + project.body.id + '/leads/' + created.body.id;
    const research = await f.post(base + '/research', {});
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    assert.deepEqual(outcome.applied, []);
    assert.deepEqual(outcome.proposals, []);
    assert.deepEqual(outcome.refused, []);
    assert.deepEqual(outcome.tried, []);
    assert.equal(outcome.discovered, false);
    assert.equal(outcome.notes.length, 1);
    assert.match(outcome.notes[0], /The saved website could not be read/);
    assert.match(outcome.notes[0], /This website could not be reached/);
    const after = (await f.agent.get('/api' + base)).body as Lead;
    assert.equal(after.city, '');
    assert.equal(after.revision, created.body.revision);
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
test('leads can be deleted individually and in bulk, taking their research with them', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = '/projects/' + project.id;
    const keep = await f.post(base + '/leads', { name: 'Keep Ltd', website: 'https://keep.com' });
    const one = await f.post(base + '/leads', { name: 'Solo Ltd', website: 'https://solo.com' });
    const a = await f.post(base + '/leads', { name: 'Bulk A Ltd', website: 'https://bulka.com' });
    const b = await f.post(base + '/leads', { name: 'Bulk B Ltd', website: 'https://bulkb.com' });
    // Give one lead a full research trail so deletion has dependent rows to clear.
    const run = await f.post(base + '/leads/' + one.body.id + '/qualify', {});
    assert.equal(run.status, 200);
    assert.equal(
      (
        await f.post(base + '/leads/' + one.body.id + '/review', {
          run_id: run.body.run_id,
          decision: 'QUALIFIED',
          notes: 'Confirmed against the captured website evidence.',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.post(base + '/leads/' + one.body.id + '/feedback', {
          run_id: run.body.run_id,
          verdict: 'CORRECT',
          notes: 'The reasoning matched what we expected for this company.',
        })
      ).status,
      201,
    );
    const single = await f.agent
      .delete('/api' + base + '/leads/' + one.body.id)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', f.csrf);
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal((await f.agent.get('/api' + base + '/leads/' + one.body.id)).status, 404);
    // The research trail goes with it; the training version does not.
    assert.equal(
      (
        f.db
          .prepare('SELECT COUNT(*) n FROM qualification_runs WHERE lead_id=?')
          .get(one.body.id) as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        f.db.prepare('SELECT COUNT(*) n FROM lead_feedback WHERE lead_id=?').get(one.body.id) as {
          n: number;
        }
      ).n,
      0,
    );
    assert.equal(
      (
        f.db
          .prepare('SELECT COUNT(*) n FROM training_versions WHERE project_id=?')
          .get(project.id) as { n: number }
      ).n,
      1,
    );
    const bulk = await f.post(base + '/leads/delete', { ids: [a.body.id, b.body.id] });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.equal(bulk.body.deleted, 2);
    const left = await f.agent.get('/api' + base + '/leads');
    assert.equal(left.body.total, 1);
    assert.equal(left.body.leads[0].id, keep.body.id);
    // A lead in another project can never be deleted through this one.
    const foreign = await f.post('/projects/1/leads/delete', { ids: [keep.body.id] });
    assert.equal(foreign.status, 404);
    assert.equal((await f.agent.get('/api' + base + '/leads')).body.total, 1);
  } finally {
    f.dispose();
  }
});
test('export follows the active filter and import can update existing leads', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = '/projects/' + project.id;
    const csv = (rows: string) => Buffer.from('name,website,country,industry\n' + rows);
    const upload = (body: Buffer, mode?: string) => {
      const request = f.agent
        .post('/api' + base + '/leads/import')
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', f.csrf);
      if (mode) request.field('on_duplicate', mode);
      return request.attach('file', body, 'leads.csv');
    };
    const first = await upload(csv('Acme Pumps Ltd,https://acme-pumps.com,DE,\n'));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual([first.body.created, first.body.updated, first.body.skipped], [1, 0, 0]);
    // Re-importing the same file changes nothing and is reported, not silently dropped.
    const again = await upload(csv('Acme Pumps Ltd,https://acme-pumps.com,DE,\n'));
    assert.deepEqual([again.body.created, again.body.updated, again.body.skipped], [0, 0, 1]);
    assert.deepEqual(again.body.duplicates, ['Acme Pumps Ltd']);
    // With update mode the same row fills in the missing industry instead of being skipped.
    const merged = await upload(
      csv('Acme Pumps Ltd,https://acme-pumps.com,DE,Pump manufacturing\n'),
      'update',
    );
    assert.deepEqual([merged.body.created, merged.body.updated, merged.body.skipped], [0, 1, 0]);
    const listed = await f.agent.get('/api' + base + '/leads?search=Acme');
    assert.equal(listed.body.leads[0].industry, 'Pump manufacturing');
    assert.equal(listed.body.leads[0].country, 'DE');
    // Qualify one lead so the status filters have something to separate.
    const target = listed.body.leads[0];
    assert.equal((await f.post(base + '/leads/' + target.id + '/qualify', {})).status, 200);
    await f.post(base + '/leads', { name: 'Untouched Ltd', website: 'https://untouched-co.com' });
    const all = await f.agent.get('/api' + base + '/leads/export');
    assert.ok(all.text.includes('Acme Pumps Ltd'));
    assert.ok(all.text.includes('Untouched Ltd'));
    const qualified = await f.agent.get('/api' + base + '/leads/export?status=QUALIFIED');
    assert.ok(qualified.text.includes('Acme Pumps Ltd'));
    assert.ok(!qualified.text.includes('Untouched Ltd'));
    assert.match(qualified.headers['content-disposition'], /qualified-leads\.csv/);
    const unreviewed = await f.agent.get('/api' + base + '/leads/export?status=UNREVIEWED');
    assert.ok(unreviewed.text.includes('Untouched Ltd'));
    assert.ok(!unreviewed.text.includes('Acme Pumps Ltd'));
    // A search term narrows the export the same way it narrows the table.
    const searched = await f.agent.get('/api' + base + '/leads/export?search=Untouched');
    assert.ok(searched.text.includes('Untouched Ltd'));
    assert.ok(!searched.text.includes('Acme Pumps Ltd'));
  } finally {
    f.dispose();
  }
});
test('qualified leads are assigned for calling and reach the review queue with call notes', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = '/projects/' + project.id;
    const caller = await f.post('/users', {
      name: 'Calling Researcher',
      username: 'calling-researcher',
      password: 'A-long-caller-password-2026',
      role: 'researcher',
    });
    assert.equal(caller.status, 201);
    const created = await f.post(base + '/leads', {
      name: 'Assignable Pumps Ltd',
      website: 'https://assignable.com',
      city: 'Stuttgart',
      country: 'DE',
      employee_count: '150',
      contact_name: 'Manual Contact',
      contact_role: 'Purchasing',
      contact_email: 'purchasing@assignable.com',
      contact_phone: '+49 711 900900',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // The richer lead record round-trips.
    assert.equal(created.body.city, 'Stuttgart');
    assert.equal(created.body.employee_count, '150');
    assert.equal(created.body.contact_email, 'purchasing@assignable.com');
    assert.equal(created.body.contact_phone, '+49 711 900900');
    const leadBase = base + '/leads/' + created.body.id;
    assert.equal((await f.post(leadBase + '/qualify', {})).status, 200);
    // Assignment is refused until the researcher can actually reach the project.
    const premature = await f.put(leadBase + '/assignment', { account_id: caller.body.id });
    assert.equal(premature.status, 400);
    assert.match(premature.body.error, /not assigned to this project/);
    assert.equal(
      (await f.put('/users/' + caller.body.id + '/projects', { project_ids: [project.id] })).status,
      200,
    );
    const assigned = await f.put(leadBase + '/assignment', { account_id: caller.body.id });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.assigned_to, caller.body.id);
    // Assigned leads show up in the review queue, which is where calling happens.
    const queue = await f.agent.get('/api' + base + '/leads?status=REVIEW_QUEUE');
    assert.ok(queue.body.leads.some((l: { id: number }) => l.id === created.body.id));
    const assignedOnly = await f.agent.get('/api' + base + '/leads?status=ASSIGNED');
    assert.equal(assignedOnly.body.total, 1);
    assert.equal(assignedOnly.body.leads[0].assigned_to_name, 'Calling Researcher');
    // The caller sees it under "assigned to me"; the administrator does not.
    const callerAgent = request.agent(f.app);
    const login = await callerAgent
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'calling-researcher', password: 'A-long-caller-password-2026' });
    assert.equal(login.status, 200);
    assert.equal((await callerAgent.get('/api' + base + '/leads?assigned_to=me')).body.total, 1);
    assert.equal((await f.agent.get('/api' + base + '/leads?assigned_to=me')).body.total, 0);
    // Logging a call records the outcome without touching the decision.
    const short = await f.post(leadBase + '/calls', { outcome: 'CONNECTED', notes: 'no' });
    assert.equal(short.status, 400);
    const call = await callerAgent
      .post('/api' + leadBase + '/calls')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', login.body.csrf_token)
      .send({
        outcome: 'CALLBACK',
        notes: 'Spoke to reception; call the engineer back on Monday.',
      });
    assert.equal(call.status, 201, JSON.stringify(call.body));
    const detail = (await f.agent.get('/api' + leadBase)).body;
    assert.equal(detail.status, 'QUALIFIED');
    assert.equal(detail.calls.length, 1);
    assert.equal(detail.calls[0].outcome, 'CALLBACK');
    assert.equal(detail.calls[0].created_by, 'Calling Researcher');
    assert.equal(detail.assigned_to_name, 'Calling Researcher');
    assert.equal(detail.runs[0].result.decision, 'QUALIFIED');
    // Calls and the assignee reach the export.
    const exported = await f.agent.get('/api' + base + '/leads/export?status=ASSIGNED');
    assert.ok(exported.text.includes('Calling Researcher'));
    assert.ok(exported.text.includes('CALLBACK'));
    assert.ok(exported.text.includes('Stuttgart'));
    // Unassigning returns the lead to the pool.
    assert.equal((await f.put(leadBase + '/assignment', { account_id: null })).status, 200);
    assert.equal((await f.agent.get('/api' + base + '/leads?status=ASSIGNED')).body.total, 0);
    assert.equal((await f.agent.get('/api' + base + '/leads?status=UNASSIGNED')).body.total, 1);
  } finally {
    f.dispose();
  }
});
test('imports read CSV, TSV, JSON and XLSX, and report unusable rows instead of failing', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = '/projects/' + project.id;
    const upload = (name: string, body: Buffer, mode?: string) => {
      const request = f.agent
        .post('/api' + base + '/leads/import')
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', f.csrf);
      if (mode) request.field('on_duplicate', mode);
      return request.attach('file', body, name);
    };
    // A people export: common headings, and rows with no employer at all.
    const csv = await upload(
      'contacts.csv',
      Buffer.from(
        'Full name,Job title,Emails,Phone numbers,Company Name,Company Website,Company Size,Locality\n' +
          'Ada Lovelace,Head of Engineering,ada@alpha.com,+441234567890,Alpha Pumps Ltd,alpha-pumps.com,150,Bristol\n' +
          'Nobody Here,Consultant,nobody@example.com,,,,,\n' +
          'Grace Hopper,CTO,grace@beta.com,,Beta Industrial,beta-industrial.com,900,Boston\n',
      ),
    );
    assert.equal(csv.status, 200, JSON.stringify(csv.body));
    // One row has no company, so it is reported — the other two still import.
    assert.equal(csv.body.created, 2);
    assert.equal(csv.body.invalid, 1);
    assert.equal(csv.body.problems[0].row, 3);
    assert.match(csv.body.problems[0].reason, /No company name/);
    // Export headings map onto the lead record, including the contact.
    const listed = await f.agent.get('/api' + base + '/leads?search=Alpha');
    const lead = listed.body.leads[0];
    assert.equal(lead.contact_name, 'Ada Lovelace');
    assert.equal(lead.contact_role, 'Head of Engineering');
    assert.equal(lead.contact_email, 'ada@alpha.com');
    assert.equal(lead.employee_count, '150');
    assert.equal(lead.city, 'Bristol');
    assert.equal(lead.website, 'https://alpha-pumps.com');
    // Tab-separated.
    const tsv = await upload(
      'more.tsv',
      Buffer.from('name\tcountry\tcity\nGamma Systems\tDE\tBerlin\n'),
    );
    assert.equal(tsv.status, 200, JSON.stringify(tsv.body));
    assert.equal(tsv.body.created, 1);
    // JSON, both as a bare array and wrapped.
    const jsonFile = await upload(
      'leads.json',
      Buffer.from(
        JSON.stringify({
          leads: [
            { company_name: 'Delta Works', company_website: 'delta-works.com', city: 'Rotterdam' },
          ],
        }),
      ),
    );
    assert.equal(jsonFile.status, 200, JSON.stringify(jsonFile.body));
    assert.equal(jsonFile.body.created, 1);
    // Excel, read straight from the workbook archive.
    const sheet =
      '<?xml version="1.0"?><worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Company Name</t></is></c><c r="B1" t="inlineStr"><is><t>Company Website</t></is></c><c r="C1" t="inlineStr"><is><t>Company Size</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Epsilon Engineering</t></is></c><c r="B2" t="inlineStr"><is><t>epsilon-eng.com</t></is></c><c r="C2"><v>240</v></c></row>' +
      '</sheetData></worksheet>';
    const workbook = zipArchive({
      '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
      'xl/worksheets/sheet1.xml': sheet,
    });
    const xlsx = await upload('leads.xlsx', workbook);
    assert.equal(xlsx.status, 200, JSON.stringify(xlsx.body));
    assert.equal(xlsx.body.created, 1);
    const excel = await f.agent.get('/api' + base + '/leads?search=Epsilon');
    assert.equal(excel.body.leads[0].website, 'https://epsilon-eng.com');
    assert.equal(excel.body.leads[0].employee_count, '240');
    // Unsupported formats say what is supported.
    const bad = await upload('notes.pdf', Buffer.from('%PDF-1.4'));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /CSV, TSV, plain text, JSON and Excel/);
    // A file where nothing has a company name explains why, rather than showing a validator message.
    const empty = await upload(
      'people.csv',
      Buffer.from('Full name,Emails\nSomeone,someone@example.com\n'),
    );
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /needs a Company Name/);
    assert.ok(!/expected string to have/.test(empty.body.error));
  } finally {
    f.dispose();
  }
});
/** Minimal stored-entry ZIP writer, so the XLSX fixture needs no extra dependency. */
function zipArchive(files: Record<string, string>) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buffer: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const entries: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    const entry = Buffer.concat([local, filename, data]);
    entries.push(entry);
    centrals.push(Buffer.concat([central, filename]));
    offset += entry.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, directory, end]);
}
test('a large import completes in one transaction and reports every row', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = '/projects/' + project.id;
    const rows = 1200;
    const lines = ['name,website,country,city,industry,employee_count'];
    for (let i = 1; i <= rows; i++)
      lines.push(
        'Scale Company ' + i + ',https://scale-' + i + '.com,DE,Berlin,Manufacturing,' + (i % 900),
      );
    // A handful of unusable rows mixed in must not stop the rest.
    lines.push(',https://no-name.com,DE,Berlin,Manufacturing,10');
    lines.push('Bad Website Ltd,http://localhost:9000,DE,Berlin,Manufacturing,10');
    const started = Date.now();
    const response = await f.agent
      .post('/api' + base + '/leads/import')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', f.csrf)
      .attach('file', Buffer.from(lines.join('\n') + '\n'), 'scale.csv');
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300));
    // Only the row with no company name is unusable. The private address costs that row
    // its website, not its place in the project.
    assert.equal(response.body.created, rows + 1);
    assert.equal(response.body.invalid, 1);
    assert.equal(response.body.warned, 1);
    assert.equal(response.body.total, rows + 2);
    assert.match(response.body.problems[0].reason, /No company name/);
    assert.match(response.body.warnings[0].reason, /Imported without a website/);
    assert.equal(
      (
        f.db.prepare('SELECT COUNT(*) n FROM leads WHERE project_id=?').get(project.id) as {
          n: number;
        }
      ).n,
      rows + 1,
    );
    assert.ok(elapsed < 30000, 'import of ' + rows + ' rows took ' + elapsed + 'ms');
    // Re-importing the same file updates in place rather than duplicating.
    const again = await f.agent
      .post('/api' + base + '/leads/import')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', f.csrf)
      .field('on_duplicate', 'update')
      .attach('file', Buffer.from(lines.join('\n') + '\n'), 'scale.csv');
    assert.equal(again.status, 200);
    assert.equal(again.body.created, 0);
    assert.equal(
      (
        f.db.prepare('SELECT COUNT(*) n FROM leads WHERE project_id=?').get(project.id) as {
          n: number;
        }
      ).n,
      rows + 1,
    );
  } finally {
    f.dispose();
  }
});
test('an unusable website is dropped with a warning instead of losing the company', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = '/projects/' + project.id;
    const response = await f.agent
      .post('/api' + base + '/leads/import')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', f.csrf)
      .attach(
        'file',
        Buffer.from(
          'Company Name,Company Website,Company Size\n' +
            'Good Co,goodco.com,50\n' +
            'Broken Site Ltd,not a url at all,20\n' +
            'NA Website Inc,N/A,10\n' +
            'Private Host Co,http://localhost:3000,5\n' +
            'No Web Co,,90\n',
        ),
        'broken.csv',
      );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    // Every company lands; only the websites are discarded.
    assert.equal(response.body.created, 5);
    assert.equal(response.body.invalid, 0);
    assert.equal(response.body.warned, 3);
    const rows = (await f.agent.get('/api' + base + '/leads?page_size=10')).body.leads as Array<{
      name: string;
      website: string;
    }>;
    assert.equal(rows.length, 5);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.website]));
    assert.equal(byName['Good Co'], 'https://goodco.com');
    // A malformed value, a hostname with no dot, and a private address are all refused.
    assert.equal(byName['Broken Site Ltd'], '');
    assert.equal(byName['NA Website Inc'], '');
    assert.equal(byName['Private Host Co'], '');
    assert.equal(byName['No Web Co'], '');
    // The warnings name the row and say what to do.
    const warned = response.body.warnings as Array<{ row: number; name: string; reason: string }>;
    assert.deepEqual(warned.map((w) => w.name).sort(), [
      'Broken Site Ltd',
      'NA Website Inc',
      'Private Host Co',
    ]);
    assert.match(warned[0].reason, /Imported without a website/);
    assert.match(warned[0].reason, /Add the real website/);
  } finally {
    f.dispose();
  }
});

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo: string;
}
test('email sending is gated, header-safe, escaped and logged whether it succeeds or fails', async () => {
  const sent: SentMail[] = [];
  let refuse = false;
  const f = fixture(generated, async (_config, message) => {
    if (refuse) throw new Error('relay refused');
    sent.push(message);
  });
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = '/projects/' + project.id;
    const created = await f.post(base + '/leads', {
      name: 'Mailable Pumps Ltd',
      website: 'https://mailable.com',
      contact_name: 'Dana Prakash',
      contact_email: 'dana@mailable.com',
    });
    const leadBase = base + '/leads/' + created.body.id;
    // The mailbox belongs to this project, so it is where this project's mail is configured.
    const mailbox = base + '/mailbox/email';
    // Nothing can be sent before a mailbox exists.
    const early = await f.post(leadBase + '/email', {
      to: 'dana@mailable.com',
      subject: 'Hello there',
      body: 'This body is comfortably longer than the minimum length.',
    });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /This project has no mailbox yet/);
    // A private or loopback mail host is refused, like any other outbound target.
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', 'mail.internal']) {
      const bad = await f.put(mailbox, {
        host,
        port: 587,
        from_email: 'research@innovista.example',
        password: 'mailbox-password',
      });
      assert.equal(bad.status, 400, host + ' should be refused');
    }
    // Port 25 is relay, not submission.
    assert.equal(
      (
        await f.put(mailbox, {
          host: '8.8.8.8',
          port: 25,
          from_email: 'research@innovista.example',
          password: 'mailbox-password',
        })
      ).status,
      400,
    );
    const saved = await f.put(mailbox, {
      host: '8.8.8.8',
      port: 587,
      username: 'research@innovista.example',
      password: 'mailbox-password',
      from_name: 'Innovista Research',
      from_email: 'research@innovista.example',
      signature: 'Innovista Research AI',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    // The password never comes back out.
    assert.equal(saved.body.has_password, true);
    assert.equal(saved.body.configured, true);
    assert.equal(saved.body.project_id, project.id);
    assert.ok(!JSON.stringify(saved.body).includes('mailbox-password'));
    assert.ok(!(await f.agent.get('/api' + mailbox)).text.includes('mailbox-password'));
    // A researcher cannot read or change the mailbox.
    const account = await f.post('/users', {
      name: 'Plain Researcher',
      username: 'plain-researcher',
      password: 'A-long-researcher-password-2026',
      role: 'researcher',
    });
    await f.put('/users/' + account.body.id + '/projects', { project_ids: [project.id] });
    const researcher = request.agent(f.app);
    const login = await researcher
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'plain-researcher', password: 'A-long-researcher-password-2026' });
    assert.equal(login.status, 200);
    assert.equal((await researcher.get('/api' + mailbox)).status, 403);
    // The draft is built from the qualification.
    assert.equal((await f.post(leadBase + '/qualify', {})).status, 200);
    const draft = await f.agent.get('/api' + leadBase + '/email/draft');
    assert.equal(draft.status, 200);
    assert.equal(draft.body.to, 'dana@mailable.com');
    assert.match(draft.body.body, /Dana/);
    assert.match(draft.body.subject, /Mailable Pumps Ltd/);
    // Header injection via the subject or the recipient is refused or stripped.
    const injected = await f.post(leadBase + '/email', {
      to: 'dana@mailable.com\nBcc: attacker@evil.example',
      subject: 'Hello there',
      body: 'This body is comfortably longer than the minimum length.',
    });
    assert.equal(injected.status, 400);
    const ok = await f.post(leadBase + '/email', {
      to: 'dana@mailable.com',
      subject: 'Quick question\r\nBcc: attacker@evil.example',
      body: 'Hi Dana,\n\nWe build <b>ceramic</b> bearings & wanted to ask about your pumps.',
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(sent.length, 1);
    // The CRLF is collapsed, so no extra header survives.
    assert.ok(!sent[0].subject.includes('\n'));
    assert.ok(!sent[0].subject.includes('\r'));
    assert.match(sent[0].subject, /^Quick question Bcc: attacker@evil.example$/);
    // Body content is HTML-escaped, and the identity plus opt-out are present.
    assert.ok(sent[0].html.includes('&lt;b&gt;ceramic&lt;/b&gt;'));
    assert.ok(!sent[0].html.includes('<b>ceramic</b>'));
    assert.ok(sent[0].html.includes('&amp;'));
    assert.match(sent[0].html, /research@innovista.example/);
    assert.match(sent[0].html, /unsubscribe/i);
    assert.equal(sent[0].replyTo, 'research@innovista.example');
    // It is logged on the lead.
    const after = (await f.agent.get('/api' + leadBase)).body;
    assert.equal(after.emails.length, 1);
    assert.equal(after.emails[0].status, 'SENT');
    assert.equal(after.emails[0].to_email, 'dana@mailable.com');
    // A refused message is recorded as FAILED rather than vanishing.
    refuse = true;
    const failed = await f.post(leadBase + '/email', {
      to: 'dana@mailable.com',
      subject: 'Second attempt',
      body: 'This body is comfortably longer than the minimum length.',
    });
    assert.equal(failed.status, 502);
    // The raw relay error is never returned.
    assert.ok(!failed.text.includes('relay refused'));
    const history = (await f.agent.get('/api' + leadBase)).body.emails;
    assert.equal(history.length, 2);
    assert.equal(history[0].status, 'FAILED');
    // Deleting the lead takes its email history with it.
    await f.agent
      .delete('/api' + leadBase)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', f.csrf);
    assert.equal(
      (
        f.db
          .prepare('SELECT COUNT(*) n FROM email_messages WHERE lead_id=?')
          .get(created.body.id) as { n: number }
      ).n,
      0,
    );
  } finally {
    f.dispose();
  }
});
test('the block editor renders email-safe HTML, merges the subject, and names a bad block', async () => {
  const sent: SentMail[] = [];
  const f = fixture(generated, async (_config, message) => {
    sent.push(message);
  });
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = '/projects/' + project.id;
    const created = await f.post(base + '/leads', {
      name: 'Mailable Pumps Ltd',
      website: 'https://mailable.com',
      contact_name: 'Dana Prakash',
      contact_email: 'dana@mailable.com',
      city: 'Bristol',
      industry: 'pump manufacturing',
    });
    const leadBase = base + '/leads/' + created.body.id;
    assert.equal(
      (
        await f.put(base + '/mailbox/email', {
          host: '8.8.8.8',
          port: 587,
          password: 'mailbox-password',
          from_name: 'Innovista Research',
          from_email: 'research@innovista.example',
          signature: 'Innovista Research AI',
        })
      ).status,
      200,
    );
    // An incomplete block is reported by position and type, not by a validator path.
    const broken = await f.post(leadBase + '/email/preview', {
      subject: 'Test',
      preview_text: '',
      blocks: [
        { type: 'text', text: 'A body long enough to be valid.', align: 'left' },
        { type: 'button', label: 'Book a call', url: 'https://', align: 'left' },
      ],
    });
    assert.equal(broken.status, 200, JSON.stringify(broken.body));
    assert.equal(broken.body.block_problems.length, 1);
    assert.equal(broken.body.block_problems[0].index, 1);
    const missingSubject = await f.post(leadBase + '/email/preview', {
      subject: 'Hello {{unknown_field}}',
      blocks: [{ type: 'text', text: 'A valid message with no missing fields.', align: 'left' }],
    });
    assert.equal(missingSubject.status, 200);
    assert.ok(missingSubject.body.missing_merge_fields.includes('unknown_field'));
    assert.match(broken.body.block_problems[0].message, /Block 2 \(button\) needs a complete/);
    // The valid block still renders, so the preview keeps working while one block is wrong.
    assert.ok(broken.body.html.includes('A body long enough'));
    // Sending with that block is refused, and says which block.
    const refused = await f.post(leadBase + '/email', {
      to: 'dana@mailable.com',
      subject: 'Test subject',
      blocks: [{ type: 'button', label: 'Book', url: 'https://', align: 'left' }],
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Block 1 \(button\) needs a complete/);
    assert.ok(!/\d+\.url/.test(refused.body.error));
    // A good send: merge fields resolve in the subject as well as the body.
    const ok = await f.post(leadBase + '/email', {
      to: 'dana@mailable.com',
      subject: '{{company}} — a question about bearings',
      preview_text: 'For {{contact_first_name}} at {{company}}',
      blocks: [
        { type: 'heading', text: 'Hello {{contact_first_name}}', level: 'h1', align: 'left' },
        { type: 'text', text: 'A note about {{company}} in {{industry}}.', align: 'left' },
        { type: 'button', label: 'Book a call', url: 'https://example.com/book', align: 'center' },
      ],
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(sent.length, 1);
    const message = sent[0];
    // The subject is the most visible place an unresolved field would surface.
    assert.equal(message.subject, 'Mailable Pumps Ltd — a question about bearings');
    assert.ok(!message.subject.includes('{{'));
    assert.ok(!message.html.includes('{{'));
    // Email-safe markup: tables, inline styles, no stylesheet, no modern layout.
    assert.match(message.html, /<table role="presentation"/);
    assert.ok(!/display:\s*flex/.test(message.html));
    assert.ok(!/display:\s*grid/.test(message.html));
    assert.ok(!/<style/i.test(message.html));
    assert.ok(!/class=/.test(message.html));
    // The hidden preheader is what the inbox shows after the subject.
    assert.match(message.html, /mso-hide:all/);
    assert.ok(message.html.includes('For Dana at Mailable Pumps Ltd'));
    // A plain-text alternative is always produced, with the button as a labelled link.
    // Headings are upper-cased in the plain-text alternative, so match case-insensitively.
    assert.match(message.text, /hello dana/i);
    assert.match(message.text, /Book a call: https:\/\/example\.com\/book/);
    // Starter templates all satisfy the block contract.
    const library = await f.agent.get('/api/email/templates');
    assert.equal(library.status, 200);
    assert.ok(library.body.templates.length >= 5);
    for (const template of library.body.templates) {
      const check = await f.post(leadBase + '/email/preview', {
        subject: template.subject,
        preview_text: template.preview_text,
        blocks: template.blocks,
      });
      assert.equal(check.status, 200, template.id);
      assert.deepEqual(check.body.block_problems, [], template.id + ' should have no problems');
    }
  } finally {
    f.dispose();
  }
});

/**
 * The leads status filter must stay an owned dropdown. A native <select> has now shipped twice
 * and both times users reported it as "not clickable": the OS popup cannot be aligned or padded
 * and its hit area does not match the control. This asserts the control, not an implementation
 * detail -- if the filter is deliberately redesigned, update this test in the same commit.
 */
test('the leads status filter is an owned dropdown, not a native select', () => {
  const source = fs.readFileSync(new URL('../src/Leads.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('className="table-toolbar"');
  const end = source.indexOf('className="selection-bar"');
  assert.ok(start > 0 && end > start, 'could not locate the leads table toolbar');
  const toolbar = source.slice(start, end);
  assert.match(toolbar, /className="filter-dropdown"/, 'the owned filter menu is missing');
  assert.ok(
    !toolbar.includes('<select'),
    'the status filter is a native <select> again; it reads as unclickable to users',
  );
  assert.match(toolbar, /role="listbox"/, 'the filter menu lost its listbox role');
});

test('a real page sentence does not authorize an invented value', async () => {
  // The whole page text is in the model's prompt, so quoting the page is free. These two values
  // are cited to sentences that genuinely appear on the site and are still fabrications: the
  // page contains no email address and no telephone number at all.
  const f = fixture(
    researchModel(() => ({
      fields: [
        {
          field: 'contact_email',
          value: 'procurement@rotterdam-pumps.example.com',
          evidence: 'It has worked from Rotterdam since 1962.',
        },
        {
          field: 'contact_phone',
          value: '+31 10 555 0142',
          evidence:
            'Rotterdam Pump Works is a specialist in chemical process pumps for the chemical industry.',
        },
        {
          field: 'employee_count',
          value: '1962',
          evidence: 'It has worked from Rotterdam since 1962.',
        },
      ],
    })),
    undefined,
    pageSet({ 'https://example.org': pumpSite, [pumpHome]: pumpSite }),
  );
  try {
    await f.setup();
    const { base, lead } = await reviewedPumpLead(f);
    const research = await f.post(base + '/research', {});
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    assert.deepEqual(outcome.applied, []);
    assert.deepEqual(outcome.proposals, []);
    assert.equal(outcome.refused.length, 3, JSON.stringify(outcome.refused));
    for (const refusal of outcome.refused)
      assert.match(refusal.reason, /does not contain this value|not shaped like/);
    const after = (await f.agent.get('/api' + base)).body as Lead;
    assert.equal(after.contact_email, '');
    assert.equal(after.contact_phone, '');
    assert.equal(after.employee_count, '');
    // Nothing moved, so the earlier verdict still stands.
    assert.equal(after.revision, lead.revision);
    assert.equal(after.reviewed, true);
    assert.equal(after.stale, false);
    assert.equal(
      (f.db.prepare('SELECT count(*) AS n FROM lead_research_citations').get() as { n: number }).n,
      0,
    );
  } finally {
    f.dispose();
  }
});

test('an applied value keeps its citation, and erasing the contact erases the provenance too', async () => {
  const site =
    'Harborline Filtration builds filtration skids in Porto. ' +
    'Write to sales@harborline.example.com or call +31 10 4455 66 for the engineering desk. ' +
    'The company employs 80 people across two sites.';
  const home = 'https://harborline.example.com';
  const f = fixture(
    researchModel(() => ({
      fields: [
        {
          field: 'contact_email',
          value: 'sales@harborline.example.com',
          evidence:
            'Write to sales@harborline.example.com or call +31 10 4455 66 for the engineering desk.',
        },
        {
          field: 'employee_count',
          value: '80',
          evidence: 'The company employs 80 people across two sites.',
        },
      ],
    })),
    undefined,
    pageSet({ 'https://example.org': site, [home]: site }),
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Harborline Filtration',
      website: home,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const base = '/projects/' + project.id + '/leads/' + created.body.id;
    const outcome = (await f.post(base + '/research', {})).body as ResearchOutcome;
    assert.deepEqual((outcome.applied ?? []).sort(), ['contact_email', 'employee_count']);
    const stored = f.db
      .prepare('SELECT field,value,evidence,source_url FROM lead_research_citations ORDER BY field')
      .all() as Array<{ field: string; value: string; evidence: string; source_url: string }>;
    assert.equal(stored.length, 2, JSON.stringify(stored));
    assert.equal(stored[0].field, 'contact_email');
    assert.equal(stored[0].source_url, home);
    assert.match(stored[0].evidence, /sales@harborline\.example\.com/);
    // Removing the contact removes the quote that contains the personal detail.
    const erased = await f.agent
      .delete('/api' + base + '/contact')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', f.csrf);
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    const after = (await f.agent.get('/api' + base)).body as Lead;
    assert.equal(after.contact_email, '');
    assert.equal(after.contact_phone, '');
    const left = f.db
      .prepare("SELECT field FROM lead_research_citations WHERE field LIKE 'contact_%'")
      .all() as Array<{ field: string }>;
    assert.deepEqual(left, []);
    // The headcount is not personal data, so its provenance stays.
    assert.equal(
      (
        f.db
          .prepare("SELECT count(*) AS n FROM lead_research_citations WHERE field='employee_count'")
          .get() as { n: number }
      ).n,
      1,
    );
  } finally {
    f.dispose();
  }
});

test('research never overwrites a value typed while the pass was running', async () => {
  const site =
    'Tideway Compressors assembles compressors in Ghent. Its market is marine compression equipment.';
  const home = 'https://tideway.example.com';
  let base = '';
  let leadId = 0;
  const f = fixture(
    // The model call stands in for the slow part of the pass. Someone fills the field in while
    // it is in flight, which is exactly the race the write-back has to lose gracefully.
    async (config, system, input) => {
      if (system.includes('extract company facts')) {
        f.db.prepare("UPDATE leads SET industry='Typed by a colleague' WHERE id=?").run(leadId);
        return {
          fields: [
            {
              field: 'industry',
              value: 'Marine compression equipment',
              evidence: 'Its market is marine compression equipment.',
            },
          ],
          notes: [],
        };
      }
      if (system.includes('candidate official website domains')) return { domains: [] };
      return generated(config, system, input);
    },
    undefined,
    pageSet({ 'https://example.org': site, [home]: site }),
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Tideway Compressors',
      website: home,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    leadId = created.body.id;
    base = '/projects/' + project.id + '/leads/' + leadId;
    const outcome = (await f.post(base + '/research', {})).body as ResearchOutcome;
    assert.deepEqual(outcome.applied, []);
    const refusal = outcome.refused.find((entry) => entry.field === 'industry');
    assert.ok(refusal, JSON.stringify(outcome));
    assert.match(refusal.reason, /filled in while the research was running/);
    const after = (await f.agent.get('/api' + base)).body as Lead;
    assert.equal(after.industry, 'Typed by a colleague');
  } finally {
    f.dispose();
  }
});

test('a later qualification run does not erase a researched contact', async () => {
  const site =
    'Kestrel Filtration Systems builds filtration skids. ' +
    'Our head of engineering is Pieter de Vries, who specifies bearings for every skid.';
  const home = 'https://kestrel-filtration.example.com';
  const f = fixture(
    async (config, system, input) => {
      if (system.includes('candidate official website domains')) return { domains: [] };
      if (system.includes('extract company facts'))
        return {
          fields: [
            {
              field: 'contact_name',
              value: 'Pieter de Vries',
              evidence:
                'Our head of engineering is Pieter de Vries, who specifies bearings for every skid.',
            },
          ],
          notes: [],
        };
      // A qualification that finds no contact of its own must leave the record's contact alone.
      const result = (await generated(config, system, input)) as {
        outreach: { contact_name: string; contact_role: string };
      };
      return { ...result, outreach: { ...result.outreach, contact_name: '', contact_role: '' } };
    },
    undefined,
    pageSet({ 'https://example.org': site, [home]: site }),
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Kestrel Filtration Systems',
      website: home,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const base = '/projects/' + project.id + '/leads/' + created.body.id;
    const outcome = (await f.post(base + '/research', {})).body as ResearchOutcome;
    assert.deepEqual(outcome.applied, ['contact_name']);
    assert.equal(((await f.agent.get('/api' + base)).body as Lead).contact_name, 'Pieter de Vries');
    const run = await f.post(base + '/qualify', {});
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(((await f.agent.get('/api' + base)).body as Lead).contact_name, 'Pieter de Vries');
  } finally {
    f.dispose();
  }
});

test('website verification needs whole words and a page that is not a placeholder', () => {
  // Substring matching let "maintenance" inside "maintenance-free" identify a company, and half
  // of a two-word name is one word, so "General Maintenance" matched any page saying "general".
  assert.equal(
    pageNamesCompany('Ali Saeed General Maintenance Est.', 'We supply maintenance-free bearings.'),
    false,
  );
  assert.equal(
    pageNamesCompany('Ali Saeed General Maintenance Est.', 'General enquiries are welcome.'),
    false,
  );
  assert.equal(
    pageNamesCompany(
      'Ali Saeed General Maintenance Est.',
      'Ali Saeed Maintenance keeps plant running in Dubai.',
    ),
    true,
  );
  // A redirect away from the guessed domain is not this company proving itself.
  assert.equal(
    sameSite('acmebuilders.com', 'https://www.hugedomains.com/domain_profile.cfm'),
    false,
  );
  assert.equal(sameSite('acmebuilders.com', 'https://www.acmebuilders.com/en/home'), true);
});

test('a citation has to contain the value it is offered for', () => {
  assert.equal(
    citationSupports('contact_email', 'sales@x.example.com', 'Write to sales@x.example.com today.'),
    true,
  );
  assert.equal(
    citationSupports('contact_email', 'sales@x.example.com', 'Contact us today.'),
    false,
  );
  // Phones are compared digit by digit, so formatting differences do not matter.
  assert.equal(citationSupports('contact_phone', '+31 10 4455 66', 'Call +31 (10) 4455-66.'), true);
  assert.equal(
    citationSupports('contact_phone', '+31 10 555 0142', 'Call our office today.'),
    false,
  );
  // A year is not a headcount, however genuine the sentence.
  assert.equal(citationSupports('employee_count', '1962', 'It has worked here since 1962.'), false);
  assert.equal(citationSupports('employee_count', '80', 'The company employs 80 people.'), true);
  // Summaries need most of their words, not the whole phrase.
  assert.equal(
    citationSupports(
      'industry',
      'Chemical process pumps',
      'A specialist in chemical process pumps.',
    ),
    true,
  );
  assert.equal(
    citationSupports('industry', 'Aerospace fasteners', 'A specialist in chemical process pumps.'),
    false,
  );
});

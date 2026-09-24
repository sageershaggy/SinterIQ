import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../server/app';
import type { CriteriaTemplate, Project, Source } from '../shared/types';
import type { SourceUpload } from '../shared/research';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;

const folder = fileURLToPath(new URL('../docs/qualification-criteria/', import.meta.url));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-criteria-'));
  const { app, db } = createApp({
    dataDir: dir,
    generate: async () => ({}),
    fetchWebsite: async (url) => ({ url, content: '', truncated: false, links: [] }),
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
    get: (url: string) => agent.get('/api' + url),
    post: (url: string, body: object = {}) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    async setup() {
      const response = await send('post', '/auth/setup', {
        name: 'Test Administrator',
        username: 'test-admin',
        password: 'A-long-test-password-2026',
      });
      assert.equal(response.status, 201, response.text);
      csrf = response.body.csrf_token;
    },
    async researcher() {
      const created = await send('post', '/users', {
        name: 'Criteria Researcher',
        username: 'criteria-researcher',
        password: 'Disposable-researcher-2026',
        role: 'researcher',
      });
      assert.equal(created.status, 201, created.text);
      const other = request.agent(app);
      const login = await other
        .post('/api/auth/login')
        .set('X-Requested-With', 'Innovista')
        .send({ username: 'criteria-researcher', password: 'Disposable-researcher-2026' });
      assert.equal(login.status, 200, login.text);
      return {
        id: created.body.id as number,
        post: (url: string, body: object = {}) =>
          other
            .post('/api' + url)
            .set('X-Requested-With', 'Innovista')
            .set('X-CSRF-Token', login.body.csrf_token)
            .send(body),
      };
    },
    dispose() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the Training library offers the criteria documents in docs/qualification-criteria', async () => {
  const f = fixture();
  try {
    assert.equal((await f.get('/criteria-templates')).status, 401);
    await f.setup();
    const listed = await f.get('/criteria-templates');
    assert.equal(listed.status, 200, listed.text);
    const templates = listed.body as CriteriaTemplate[];
    // The owner's four categories first, the blank template last, and never the guide.
    assert.deepEqual(
      templates.map((template) => template.id),
      [
        'ai-app-development',
        'marketing-assistant',
        'event-participants',
        'funded-companies',
        'criteria-template',
      ],
    );
    const onDisk = fs
      .readdirSync(folder)
      .filter((name) => name.endsWith('.md') && name !== 'README.md')
      .map((name) => name.slice(0, -3))
      .sort();
    assert.deepEqual(templates.map((template) => template.id).sort(), onDisk);
    const ai = templates[0];
    assert.equal(ai.title, 'AI engineers for app development');
    assert.match(ai.summary, /^We are looking for companies that build software applications/);
    assert.equal(templates.at(-1)!.title, 'Blank template');
  } finally {
    f.dispose();
  }
});

test('adding a criteria document puts its text in the library as a logged training document', async () => {
  const f = fixture();
  try {
    await f.setup();
    const created = await f.post('/projects', { name: 'Event Leads' });
    assert.equal(created.status, 201, created.text);
    const id = created.body.id as number;
    let project = (await f.get('/projects/' + id)).body.project as Project;

    // Only a template by its id, from its folder; a path or an unknown id finds nothing.
    for (const bad of ['../sintertechnik-training', 'README', 'nothing-here', 'readme'])
      assert.equal(
        (await f.post(`/projects/${id}/sources/template`, { template: bad, revision: project.revision }))
          .status,
        404,
        bad,
      );
    // A stale revision is refused like any other library change.
    assert.equal(
      (
        await f.post(`/projects/${id}/sources/template`, {
          template: 'event-participants',
          revision: project.revision + 5,
        })
      ).status,
      409,
    );

    const added = await f.post(`/projects/${id}/sources/template`, {
      template: 'event-participants',
      revision: project.revision,
    });
    assert.equal(added.status, 201, added.text);
    const text = fs.readFileSync(path.join(folder, 'event-participants.md'), 'utf8');
    const detail = (await f.get('/projects/' + id)).body as { project: Project; sources: Source[] };
    const source = detail.sources.find((item) => item.id === added.body.id)!;
    assert.equal(source.kind, 'document');
    assert.equal(source.title, 'Qualification criteria · Event participants');
    assert.equal(source.filename, 'event-participants.md');
    assert.equal(source.content, text);
    // A library change moves the draft on, so the published training is out of date until
    // someone publishes again.
    assert.ok(detail.project.revision > project.revision);
    project = detail.project;

    // Listed in the upload log as read, so the library shows it arrived.
    const uploads = (await f.get(`/projects/${id}/training/uploads`)).body as SourceUpload[];
    const logged = uploads.find((item) => item.source_id === source.id);
    assert.ok(logged, JSON.stringify(uploads));
    assert.equal(logged.status, 'READ');
    assert.equal(logged.filename, 'event-participants.md');
  } finally {
    f.dispose();
  }
});

test('a researcher cannot add a criteria document to a project they cannot reach', async () => {
  const f = fixture();
  try {
    await f.setup();
    const created = await f.post('/projects', { name: 'Private Project' });
    const id = created.body.id as number;
    const project = (await f.get('/projects/' + id)).body.project as Project;
    const researcher = await f.researcher();
    const refused = await researcher.post(`/projects/${id}/sources/template`, {
      template: 'funded-companies',
      revision: project.revision,
    });
    assert.equal(refused.status, 404);
    assert.equal((await f.get('/projects/' + id)).body.sources.length, 0);
    // Once assigned, the same request works: the route follows project membership.
    assert.equal(
      (await f.put(`/users/${researcher.id}/projects`, { project_ids: [id] })).status,
      200,
    );
    const allowed = await researcher.post(`/projects/${id}/sources/template`, {
      template: 'funded-companies',
      revision: project.revision,
    });
    assert.equal(allowed.status, 201, allowed.text);
  } finally {
    f.dispose();
  }
});

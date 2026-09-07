import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';

test('health checks the actual database and returns an unavailable status without exposing internals', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-health-'));
  const { app, db } = createApp({ dataDir: directory });
  try {
    const ready = await request(app).get('/api/health');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.database, 'connected');
    db.close();
    const unavailable = await request(app).get('/api/health');
    assert.equal(unavailable.status, 503);
    assert.deepEqual(unavailable.body, {
      ok: false,
      application: 'Innovista Research AI',
      database: 'unavailable',
    });
    assert.ok(!unavailable.text.includes(directory));
  } finally {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('projects, training sources and edited leads persist through closing and reopening the application database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-persistence-'));
  let instance = createApp({ dataDir: directory });
  try {
    const user = {
      username: 'persistence-admin',
      name: 'Persistence Test',
      password: 'Unique-disposable-password-2026',
    };
    const first = request.agent(instance.app);
    const setup = await first
      .post('/api/auth/setup')
      .set('X-Requested-With', 'Innovista')
      .send(user);
    assert.equal(setup.status, 201);
    const post = (route: string, body: object) =>
      first
        .post('/api' + route)
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', setup.body.csrf_token)
        .send(body);
    const project = await post('/projects', {
      name: 'Persistent Research',
      description: 'Saved research objective',
    });
    assert.equal(project.status, 201);
    const base = '/projects/' + project.body.id;
    const training = await post(base + '/sources', {
      revision: project.body.revision,
      title: 'Persisted training',
      content:
        'Keep this training document and its company-specific research requirements through every restart.',
    });
    assert.equal(training.status, 201);
    const lead = await post(base + '/leads', {
      name: 'Persistent Lead',
      notes: 'Original context',
    });
    assert.equal(lead.status, 201);
    const saved = await first
      .put('/api' + base + '/leads/' + lead.body.id)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', setup.body.csrf_token)
      .send({
        name: 'Persistent Lead',
        notes: 'Updated application research',
        revision: lead.body.revision,
      });
    assert.equal(saved.status, 200);
    instance.db.close();
    instance = createApp({ dataDir: directory });
    const second = request.agent(instance.app);
    const login = await second
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: user.username, password: user.password });
    assert.equal(login.status, 200);
    const restored = await second.get('/api' + base);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.project.description, 'Saved research objective');
    assert.equal(restored.body.project.lead_count, 1);
    assert.equal(restored.body.sources.length, 1);
    assert.equal(restored.body.sources[0].title, 'Persisted training');
    const restoredLead = await second.get('/api' + base + '/leads/' + lead.body.id);
    assert.equal(restoredLead.status, 200);
    assert.equal(restoredLead.body.notes, 'Updated application research');
    assert.equal(restoredLead.body.revision, saved.body.revision);
    assert.equal((await second.get('/api/projects')).body.length, 2);
    assert.equal(instance.db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(instance.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(instance.db.pragma('busy_timeout', { simple: true }), 5000);
    assert.deepEqual(instance.db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    assert.deepEqual(instance.db.pragma('foreign_key_check'), []);
  } finally {
    if (instance.db.open) instance.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

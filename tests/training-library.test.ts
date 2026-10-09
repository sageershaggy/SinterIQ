import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import type { Generate } from '../server/ai';
import { HttpError } from '../server/validation';
import type { Project, TrainingSnapshot } from '../shared/types';
import { refusedAsCopy } from '../shared/research';
import type { SourceDuplicate, SourceUpload } from '../shared/research';

/*
 * The training library's guards against the same document twice: a copy already in the library
 * or still being read is refused without a second read, existing copies are found and removed
 * keeping the oldest, an upload says "read" only once it was, and Train AI runs once per project.
 */

const rubric = {
  summary: 'Pump manufacturers with engineering teams.',
  criteria: ['Manufactures pumps'],
  exclusions: [],
  questions: [],
  categories: [],
};
const text = (label: string) =>
  label + ': qualification training text that is long enough to pass the readable-content check.';

/** A gate a stub waits on, and a promise that resolves once the stub has started waiting. */
function gate() {
  let open!: () => void;
  let started!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const waiting = new Promise<void>((resolve) => (started = resolve));
  return { open, started, opened, waiting };
}

function fixture(options: {
  extract?: (file: Express.Multer.File) => Promise<string>;
  generate?: Generate;
  fetchWebsite?: (url: string) => Promise<{ url: string; content: string; links: string[]; truncated: boolean }>;
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-library-'));
  const reads: string[] = [];
  const { app, db } = createApp({
    dataDir: dir,
    generate: options.generate ?? (async () => rubric),
    fetchWebsite:
      options.fetchWebsite ??
      (async (url) => ({ url, content: 'Example company makes industrial pumps.', links: [], truncated: false })),
    extractDocument: async (file) => {
      reads.push(file.originalname);
      return options.extract ? options.extract(file) : file.buffer.toString('utf8');
    },
  });
  const agent = request.agent(app);
  let csrf = '';
  const send = (method: 'post' | 'put' | 'delete', url: string) =>
    agent[method]('/api' + url).set('X-Requested-With', 'Innovista').set('X-CSRF-Token', csrf);
  return {
    app,
    db,
    reads,
    get: (url: string) => agent.get('/api' + url),
    // .then sends the request now: a supertest request held without it is never made.
    post: (url: string, body: object = {}) =>
      send('post', url)
        .send(body)
        .then((response) => response),
    del: (url: string, body: object) =>
      send('delete', url)
        .send(body)
        .then((response) => response),
    upload: (projectId: number, revision: number, name: string, content: string | Buffer) =>
      send('post', '/projects/' + projectId + '/sources/upload')
        .field('revision', String(revision))
        .attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), name)
        .then((response) => response),
    project: async (id: number) => (await agent.get('/api/projects/' + id)).body.project as Project,
    async setup() {
      const response = await send('post', '/auth/setup').send({
        name: 'Test Administrator',
        username: 'test-admin',
        password: 'A-long-test-password-2026',
      });
      assert.equal(response.status, 201, response.text);
      csrf = response.body.csrf_token;
    },
    async newProject(name: string) {
      const response = await send('post', '/projects').send({ name, website: 'https://example.org' });
      assert.equal(response.status, 201, response.text);
      return response.body as Project;
    },
    dispose() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
const uploadsOf = async (f: Fixture, id: number) =>
  (await f.get('/projects/' + id + '/training/uploads')).body as SourceUpload[];

test('a document already in the library is refused by name and logged, without being read again', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await f.newProject('Master Training');
    const master = text('Master Training V3');
    const first = await f.upload(project.id, project.revision, 'Master_Training_V3.docx', master);
    assert.equal(first.status, 201, first.text);
    assert.equal(f.reads.length, 1);

    // The very same file again, under another name: refused before it is read.
    let current = await f.project(project.id);
    const again = await f.upload(project.id, current.revision, 'Master_Training_V3 (1).docx', master);
    assert.equal(again.status, 409);
    assert.match(
      again.body.error,
      /^Already in the library as Master_Training_V3\.docx \(added \d{1,2} \w{3} \d{4}\)\.$/,
    );
    assert.equal(f.reads.length, 1, 'the same file is not read a second time');

    // The same text in a re-saved file (different bytes, different spacing) is read, then refused.
    const resaved = await f.upload(
      project.id,
      current.revision,
      'Master_Training_V3 (2).docx',
      master.replace(/ /g, '  ') + '\r\n',
    );
    assert.equal(resaved.status, 409);
    assert.match(resaved.body.error, /^Already in the library as Master_Training_V3\.docx/);
    assert.equal(f.reads.length, 2);
    // Notes with that text are the same content too.
    current = await f.project(project.id);
    const note = await f.post('/projects/' + project.id + '/sources', {
      title: 'Pasted copy',
      content: master,
      revision: current.revision,
    });
    assert.equal(note.status, 409);
    assert.match(note.body.error, /^Already in the library as Master_Training_V3\.docx/);

    // One source in the library; both refusals are in the log, pointing at the copy that was read.
    const detail = (await f.get('/projects/' + project.id)).body as { sources: Array<{ id: number }> };
    assert.equal(detail.sources.length, 1);
    const log = await uploadsOf(f, project.id);
    assert.deepEqual(
      log.map((item) => [item.filename, item.status, item.duplicate_of, item.in_library?.id]),
      [
        // The stored file name keeps letters, digits, spaces, dots, dashes and underscores.
        ['Master_Training_V3 _2_.docx', 'FAILED', first.body.id, first.body.id],
        ['Master_Training_V3 _1_.docx', 'FAILED', first.body.id, first.body.id],
        ['Master_Training_V3.docx', 'READ', null, first.body.id],
      ],
    );
    assert.equal(log[1].in_library?.title, 'Master_Training_V3.docx');
  } finally {
    f.dispose();
  }
});

test('a copy sent while the first is still being read is refused, and the log shows the read in progress', async () => {
  const reading = gate();
  const f = fixture({
    extract: async (file) => {
      reading.started();
      await reading.opened;
      return file.buffer.toString('utf8');
    },
  });
  try {
    await f.setup();
    const project = await f.newProject('Concurrent uploads');
    const master = text('Master Training V3');
    const first = f.upload(project.id, project.revision, 'Master.docx', master);
    await reading.waiting;
    // While it is read, the upload log says so — and does not call it read.
    const during = await uploadsOf(f, project.id);
    assert.equal(during.length, 1);
    assert.equal(during[0].status, 'READING');
    assert.equal(during[0].filename, 'Master.docx');
    assert.equal(during[0].in_library, null);
    assert.ok(during[0].id < 0, 'an attempt in progress is not a logged row');
    // The same document sent again, by anyone, does not start a second read.
    const second = await f.upload(project.id, project.revision, 'Master copy.docx', master);
    assert.equal(second.status, 409);
    assert.match(second.body.error, /^This document is already being read/);
    assert.equal(f.reads.length, 1);
    reading.open();
    const done = await first;
    assert.equal(done.status, 201, done.text);
    const after = await uploadsOf(f, project.id);
    assert.deepEqual(
      after.map((item) => [item.filename, item.status, item.in_library?.id ?? null]),
      [
        ['Master.docx', 'READ', done.body.id],
        // The refused copy's file is in the library now, so it is not a missing document.
        ['Master copy.docx', 'FAILED', done.body.id],
      ],
    );
  } finally {
    f.dispose();
  }
});

test('a read that fails is logged as failed, never as read, and its content is not in the library', async () => {
  const f = fixture({
    extract: async (file) => {
      if (file.originalname.startsWith('scan'))
        throw new HttpError(400, 'At least 40 characters of readable text are required.');
      return file.buffer.toString('utf8');
    },
  });
  try {
    await f.setup();
    const project = await f.newProject('Failed read');
    const failed = await f.upload(project.id, project.revision, 'scan.pdf', 'image bytes');
    assert.equal(failed.status, 400);
    const log = await uploadsOf(f, project.id);
    assert.equal(log.length, 1);
    assert.equal(log[0].status, 'FAILED');
    assert.equal(log[0].in_library, null);
    assert.equal(log[0].characters, 0);
    assert.match(log[0].reason, /readable text/);
    const detail = (await f.get('/projects/' + project.id)).body as { sources: unknown[] };
    assert.equal(detail.sources.length, 0);
  } finally {
    f.dispose();
  }
});

test('existing duplicates are flagged and removed in one step, keeping the oldest copy', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await f.newProject('Library with copies');
    const master = text('Master Training V3');
    const first = await f.upload(project.id, project.revision, 'Master.docx', master);
    assert.equal(first.status, 201, first.text);
    let current = await f.project(project.id);
    const other = await f.upload(project.id, current.revision, 'Decision makers.docx', text('Decision makers'));
    assert.equal(other.status, 201, other.text);
    // Copies stored before uploads were checked for duplicates: one with the same file, one with
    // the same text spaced differently, and a newer edition that only shares the title.
    const insert = f.db.prepare(
      `INSERT INTO sources (project_id,kind,title,url,content,filename,mime,sha256,created_at,file_sha256)
      VALUES (?,'document',?,'',?,?,'application/octet-stream',?,?,?)`,
    );
    const stored = f.db
      .prepare('SELECT file_sha256,sha256 FROM sources WHERE id=?')
      .get(first.body.id) as { file_sha256: string; sha256: string };
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    const sameFile = Number(
      insert.run(project.id, 'Master.docx', master, 'Master.docx', stored.sha256, later(1), stored.file_sha256)
        .lastInsertRowid,
    );
    const sameText = Number(
      insert.run(project.id, 'Master (2).docx', master + '\n\n', 'Master (2).docx', 'x', later(2), '')
        .lastInsertRowid,
    );
    const edition = Number(
      insert.run(project.id, 'master.docx', text('Master Training V4'), 'master.docx', 'y', later(3), '')
        .lastInsertRowid,
    );
    const found = (await f.get('/projects/' + project.id + '/training/duplicates'))
      .body as SourceDuplicate[];
    assert.deepEqual(
      found.map((item) => [item.id, item.kind, item.duplicate_of.id]),
      [
        [sameFile, 'content', first.body.id],
        [sameText, 'content', first.body.id],
        [edition, 'name', first.body.id],
      ],
    );
    current = await f.project(project.id);
    const remove = (body: object) =>
      f.post('/projects/' + project.id + '/training/duplicates/remove', body);
    // The list confirmed must be exactly the duplicates there are now.
    const partial = await remove({ revision: current.revision, ids: [sameFile] });
    assert.equal(partial.status, 409);
    assert.match(partial.body.error, /duplicates changed/);
    const stale = await remove({ revision: current.revision - 1, ids: [sameFile, sameText] });
    assert.equal(stale.status, 409);
    const removed = await remove({ revision: current.revision, ids: [sameText, sameFile] });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.removed, 2);
    assert.equal(removed.body.project.revision, current.revision + 1);
    const left = (await f.get('/projects/' + project.id)).body as { sources: Array<{ id: number }> };
    assert.deepEqual(
      left.sources.map((source) => source.id).sort((a, b) => a - b),
      [first.body.id, other.body.id, edition].sort((a, b) => a - b),
    );
    const after = (await f.get('/projects/' + project.id + '/training/duplicates'))
      .body as SourceDuplicate[];
    assert.deepEqual(
      after.map((item) => item.kind),
      ['name'],
    );
    const event = f.db
      .prepare("SELECT detail FROM audit_events WHERE action='source.duplicates_removed'")
      .get() as { detail: string };
    assert.match(event.detail, /^2 duplicate sources removed; the oldest copy of each was kept/);
  } finally {
    f.dispose();
  }
});

test('Train AI runs once per project: a second request is refused and takes no analysis slot', async () => {
  const analysis = gate();
  const capture = gate();
  let captures = 0;
  const f = fixture({
    generate: async (_config, system) => {
      if (system.includes('proposed qualification rubric')) {
        analysis.started();
        await analysis.opened;
      }
      return rubric;
    },
    fetchWebsite: async (url) => {
      if (++captures === 2) capture.started();
      await capture.opened;
      return { url, content: 'Example company makes industrial pumps.', links: [], truncated: false };
    },
  });
  try {
    await f.setup();
    const project = await f.newProject('Train once');
    const note = await f.post('/projects/' + project.id + '/sources', {
      title: 'Brief',
      content: text('Brief'),
      revision: project.revision,
    });
    assert.equal(note.status, 201, note.text);
    const current = await f.project(project.id);
    const train = () =>
      f.post('/projects/' + project.id + '/training/analyze', { revision: current.revision });
    const running = train();
    await analysis.waiting;
    const second = await train();
    assert.equal(second.status, 409);
    assert.match(second.body.error, /^Training analysis is already running for this project/);
    // Of the three remote slots, Train AI holds one: two website captures still get the others,
    // and a third finds the pool full — the refused request took nothing.
    const projects = [await f.newProject('A'), await f.newProject('B'), await f.newProject('C')];
    const capturing = projects
      .slice(0, 2)
      .map((p) =>
        f.post('/projects/' + p.id + '/sources/website', { url: 'https://example.org', revision: p.revision }),
      );
    await capture.waiting;
    const full = await f.post('/projects/' + projects[2].id + '/sources/website', {
      url: 'https://example.org',
      revision: projects[2].revision,
    });
    assert.equal(full.status, 429);
    analysis.open();
    capture.open();
    assert.equal((await running).status, 200);
    for (const response of await Promise.all(capturing)) assert.equal(response.status, 201, response.text);
    // Once it has finished, Train AI can run again.
    assert.equal((await train()).status, 200);
  } finally {
    analysis.open();
    capture.open();
    f.dispose();
  }
});

test('a removed source is gone from the library and from the next Train AI', async () => {
  const seen: TrainingSnapshot[] = [];
  const f = fixture({
    generate: async (_config, system, input) => {
      if (system.includes('proposed qualification rubric')) seen.push(input as TrainingSnapshot);
      return rubric;
    },
  });
  try {
    await f.setup();
    const project = await f.newProject('Old source');
    const master = await f.upload(project.id, project.revision, 'Master.docx', text('Master'));
    assert.equal(master.status, 201, master.text);
    let current = await f.project(project.id);
    const old = await f.upload(
      project.id,
      current.revision,
      '08_Decision_Maker_Research.docx',
      text('Decision maker research'),
    );
    assert.equal(old.status, 201, old.text);
    current = await f.project(project.id);
    // Removing needs the revision the person saw when they confirmed.
    const stale = await f.del('/projects/' + project.id + '/sources/' + old.body.id, {
      revision: current.revision - 1,
    });
    assert.equal(stale.status, 409);
    const removed = await f.del('/projects/' + project.id + '/sources/' + old.body.id, {
      revision: current.revision,
    });
    assert.equal(removed.status, 200, removed.text);
    current = await f.project(project.id);
    const trained = await f.post('/projects/' + project.id + '/training/analyze', {
      revision: current.revision,
    });
    assert.equal(trained.status, 200, trained.text);
    assert.deepEqual(
      seen.at(-1)!.sources.map((source) => source.title),
      ['Master.docx'],
    );
  } finally {
    f.dispose();
  }
});

test('a copy whose original was removed is still a copy, not a document that was not read', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await f.newProject('Decision makers');
    const research = text('Decision maker research');
    const original = await f.upload(
      project.id,
      project.revision,
      '08_Decision_Maker_Research.docx',
      research,
    );
    assert.equal(original.status, 201, original.text);

    // The same content again, under the name the person actually kept: read, recognised, refused.
    let current = await f.project(project.id);
    const copy = await f.upload(
      project.id,
      current.revision,
      '08_Decision_Maker_Research _1_.docx',
      research,
    );
    assert.equal(copy.status, 409);
    assert.match(copy.body.error, /^Already in the library as 08_Decision_Maker_Research\.docx/);

    // Removing the source it duplicated clears duplicate_of (ON DELETE SET NULL), so nothing in
    // the row points at the library any more. Before, that made the Training page report the
    // upload under "One upload was not read" — a document it had in fact read to the last word.
    current = await f.project(project.id);
    const removed = await f.del('/projects/' + project.id + '/sources/' + original.body.id, {
      revision: current.revision,
    });
    assert.equal(removed.status, 200, removed.text);

    const log = await uploadsOf(f, project.id);
    const refused = log.find((item) => item.filename === '08_Decision_Maker_Research _1_.docx')!;
    assert.equal(refused.status, 'FAILED');
    assert.equal(refused.duplicate_of, null, 'the source it duplicated is gone');
    assert.equal(refused.in_library, null, 'and so nothing holds its content now');
    // The refusal's own wording still says why it was turned away, and that is enough to know
    // it was read: the library could not have recognised the content otherwise.
    assert.ok(refusedAsCopy(refused), 'a refused copy is never reported as unread');
    assert.ok(!refusedAsCopy(log.find((item) => item.status === 'READ')!));
  } finally {
    f.dispose();
  }
});

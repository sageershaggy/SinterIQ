import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { parseReceived, readInbox, type ReadInbox, type ReceivedMail } from '../server/imap';
import type { Send } from '../server/email';
import { ImapFlow, type FetchMessageObject } from 'imapflow';

const settings = {
  revision: 0,
  host: '8.8.8.8',
  username: 'support@example.com',
  password: 'fixture-only-incoming-password',
  folder: 'INBOX',
  enabled: true,
};
const response = (
  uid: number,
  reference = '',
  extra: Partial<ReceivedMail> = {},
): ReceivedMail => ({
  uid,
  message_id: `<fixture-${uid}@example.net>`,
  references: reference ? [reference] : [],
  from_email: 'contact@example.net',
  from_name: 'Customer',
  to_email: 'support@example.com',
  subject: 'Re: Support',
  body: 'Thank you. We would like to discuss our requirements.',
  received_at: new Date().toISOString(),
  attachment_count: 0,
  notice: '',
  ...extra,
});
async function fixture(reader?: ReadInbox, deliver?: Send) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-mailbox-'));
  let batch: Awaited<ReturnType<ReadInbox>> = { uid_validity: '1', last_uid: 0, messages: [] };
  const messages: Parameters<Send>[1][] = [];
  const instance = createApp({
    dataDir: directory,
    origin: 'https://mail.example.com',
    readInbox:
      reader ||
      (async (config) => {
        assert.equal(config.password, settings.password);
        return batch;
      }),
    sendMail:
      deliver ||
      (async (_config, message) => {
        message.beforeSend?.();
        messages.push(message);
      }),
  });
  const agent = request.agent(instance.app);
  let csrf = '';
  const req = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const call = agent[method]('/api' + url)
      .set('Host', 'mail.example.com')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf);
    return body === undefined ? call : call.send(body);
  };
  const setup = await req('post', '/auth/setup', {
    name: 'Mailbox QA',
    username: 'mailbox-qa',
    password: 'Disposable-mailbox-QA-2026',
  });
  assert.equal(setup.status, 201, setup.text);
  csrf = setup.body.csrf_token;
  const project = (await req('post', '/projects', { name: 'Support project' })).body;
  const lead = (
    await req('post', `/projects/${project.id}/leads`, {
      name: 'Example customer',
      contact_email: 'contact@example.net',
    })
  ).body;
  const base = `/projects/${project.id}/leads/${lead.id}`;
  const smtp = await req('put', '/settings/email', {
    host: '8.8.8.8',
    port: 587,
    username: 'support@example.com',
    password: 'fixture-only-smtp-password',
    from_name: 'Support Team',
    from_email: 'support@example.com',
  });
  assert.equal(smtp.status, 200, smtp.text);
  return {
    ...instance,
    req,
    agent,
    project,
    lead,
    base,
    messages,
    setBatch(value: typeof batch) {
      batch = value;
    },
    async connect() {
      const r = await req('put', '/settings/incoming', settings);
      assert.equal(r.status, 200, r.text);
    },
    async send() {
      const r = await req('post', base + '/email', {
        to: lead.contact_email,
        subject: 'Support for your team',
        body: 'Hello, how can we help with your requirements?',
      });
      assert.equal(r.status, 201, r.text);
    },
    dispose() {
      instance.db.close();
      const resolved = path.resolve(directory),
        parent = path.resolve(os.tmpdir());
      assert.equal(path.dirname(resolved), parent);
      assert.ok(path.basename(resolved).startsWith('innovista-mailbox-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

test('incoming credentials are encrypted, disabled by default, revision protected and never forwarded to a changed host', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.req('get', '/settings/incoming')).body.enabled, false);
    assert.equal((await f.req('post', '/mailbox/sync')).status, 409);
    await f.connect();
    const current = await f.req('get', '/settings/incoming');
    assert.equal(current.body.has_password, true);
    assert.equal(current.body.password, undefined);
    assert.ok(!current.text.includes(settings.password));
    const stored = f.db.prepare("SELECT value FROM settings WHERE key='imap_config'").get() as {
      value: string;
    };
    assert.ok(!stored.value.includes(settings.password));
    assert.equal((await f.req('put', '/settings/incoming', settings)).status, 409);
    assert.equal(
      (
        await f.req('put', '/settings/incoming', {
          ...settings,
          revision: 1,
          host: '1.1.1.1',
          password: '',
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.req('put', '/settings/incoming', { ...settings, revision: 1, host: '127.0.0.1' }))
        .status,
      400,
    );
    assert.equal(
      (
        await f.req('put', '/settings/incoming', {
          ...settings,
          revision: 1,
          enabled: false,
          clear_password: true,
        })
      ).status,
      200,
    );
    assert.equal((await f.req('get', '/settings/incoming')).body.has_password, false);
    const noCsrf = await f.agent
      .put('/api/settings/incoming')
      .set('Host', 'mail.example.com')
      .set('X-Requested-With', 'Innovista')
      .send({ ...settings, revision: 2 });
    assert.equal(noCsrf.status, 403);
  } finally {
    f.dispose();
  }
});

test('matched replies are idempotent, stop applicable follow-ups and preserve qualification and terminal outcomes', async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.send();
    const outgoing = f.messages[0];
    assert.match(outgoing.messageId!, /^<[^\s]+@example.com>$/);
    const now = new Date(Date.now() - 1000).toISOString();
    f.db
      .prepare(
        "INSERT INTO funnels(id,project_id,name,steps_json,created_at,created_by) VALUES(1,?,'QA','[]',?,'QA')",
      )
      .run(f.project.id, now);
    f.db
      .prepare(
        `INSERT INTO funnel_enrollments(project_id,funnel_id,lead_id,recipient,lead_revision,training_version,account_id,created_by,next_send_at,created_at,updated_at)
      VALUES(?,1,?,?,1,1,1,'QA',?,?,?)`,
      )
      .run(f.project.id, f.lead.id, f.lead.contact_email, Date.now(), now, now);
    const mail = response(1, outgoing.messageId);
    f.setBatch({ uid_validity: '1', last_uid: 1, messages: [mail] });
    assert.equal((await f.req('post', '/mailbox/sync')).body.received, 1);
    const linked = (await f.req('get', f.base + '/incoming')).body;
    assert.equal(linked.length, 1);
    assert.equal(linked[0].subject, mail.subject);
    assert.equal((await f.req('get', f.base)).body.status, 'UNREVIEWED');
    assert.equal((await f.req('get', f.base)).body.outreach_status, 'REPLIED');
    assert.equal(
      (
        f.db
          .prepare('SELECT status FROM funnel_enrollments WHERE project_id=? AND lead_id=?')
          .get(f.project.id, f.lead.id) as { status: string }
      ).status,
      'REPLIED',
    );
    assert.equal((await f.req('post', '/mailbox/sync')).body.received, 0);
    f.setBatch({ uid_validity: '2', last_uid: 99, messages: [{ ...mail, uid: 99 }] });
    assert.equal((await f.req('post', '/mailbox/sync')).body.received, 0);
    assert.equal(
      (
        f.db
          .prepare('SELECT count(*) n FROM outreach_events WHERE project_id=? AND lead_id=?')
          .get(f.project.id, f.lead.id) as { n: number }
      ).n,
      1,
    );
    await f.req('post', f.base + '/outreach-events', {
      outcome: 'CONVERTED',
      notes: 'Confirmed by team.',
    });
    f.setBatch({ uid_validity: '2', last_uid: 100, messages: [response(100, outgoing.messageId)] });
    await f.req('post', '/mailbox/sync');
    assert.equal((await f.req('get', f.base)).body.outreach_status, 'CONVERTED');
    await f.req('post', f.base + '/outreach-events', {
      outcome: 'UNSUBSCRIBED',
      notes: 'Requested by recipient.',
    });
    f.setBatch({ uid_validity: '2', last_uid: 101, messages: [response(101, outgoing.messageId)] });
    await f.req('post', '/mailbox/sync');
    assert.equal((await f.req('get', f.base)).body.outreach_status, 'UNSUBSCRIBED');
  } finally {
    f.dispose();
  }
});

test('unmatched and ambiguous messages stay private; project membership governs replies and threaded sending', async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.send();
    f.setBatch({
      uid_validity: '1',
      last_uid: 3,
      messages: [
        response(1, f.messages[0].messageId),
        response(2, f.messages[0].messageId, { from_email: 'someone-else@example.net' }),
        response(3),
      ],
    });
    const synced = await f.req('post', '/mailbox/sync');
    assert.equal(synced.status, 200, synced.text);
    const inbox = await f.req('get', '/mailbox?folder=inbox');
    assert.equal(inbox.status, 200, inbox.text);
    assert.equal(inbox.body.total, 3);
    assert.equal(inbox.body.items.filter((r: { lead_id: number }) => r.lead_id).length, 1);
    const linked = (await f.req('get', f.base + '/incoming')).body[0];
    const created = await f.req('post', '/users', {
      name: 'Mail Researcher',
      username: 'mail-researcher',
      password: 'Disposable-researcher-mail-2026',
      role: 'researcher',
    });
    assert.equal(created.status, 201, created.text);
    const researcher = request.agent(f.app);
    const login = await researcher
      .post('/api/auth/login')
      .set('Host', 'mail.example.com')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'mail-researcher', password: 'Disposable-researcher-mail-2026' });
    const get = (url: string) => researcher.get('/api' + url).set('Host', 'mail.example.com');
    assert.equal((await get('/mailbox')).status, 403);
    assert.equal((await get('/settings/incoming')).status, 403);
    assert.equal((await get(f.base + '/incoming')).status, 404);
    await f.req('put', `/users/${created.body.id}/projects`, { project_ids: [f.project.id] });
    assert.equal((await get(f.base + '/incoming')).body.length, 1);
    const reply = {
      to: f.lead.contact_email,
      subject: 'Re: Support',
      body: 'Thank you, let us discuss the next steps.',
      reply_to_message_id: linked.id,
    };
    assert.equal(
      (await f.req('post', f.base + '/email', { ...reply, to: 'different@example.net' })).status,
      400,
    );
    assert.equal(
      (
        await f.req('post', f.base + '/email', {
          ...reply,
          reply_to_message_id: inbox.body.items[0].id,
        })
      ).status,
      404,
    );
    const sent = await f.req('post', f.base + '/email', reply);
    assert.equal(sent.status, 201, sent.text);
    assert.equal(f.messages[1].inReplyTo, '<fixture-1@example.net>');
    const draft = {
      revision: 0,
      to: 'private@example.net',
      subject: 'Researcher private draft',
      preview_text: '',
      blocks: [],
    };
    const saved = await researcher
      .put('/api' + f.base + '/email/draft')
      .set('Host', 'mail.example.com')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', login.body.csrf_token)
      .send(draft);
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await f.req('get', '/mailbox?folder=drafts')).body.total, 0);
    const unlinked = inbox.body.items.find((r: { lead_id: number | null }) => r.lead_id === null);
    assert.equal(
      (
        await f.req('post', `/mailbox/incoming/${unlinked.id}/link`, {
          project_id: f.project.id,
          lead_id: f.lead.id,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.req('post', `/mailbox/incoming/${unlinked.id}/link`, {
          project_id: f.project.id,
          lead_id: f.lead.id,
        })
      ).status,
      409,
    );
    assert.equal((await get(f.base + '/incoming')).body.length, 2);
    await f.req('put', `/users/${created.body.id}/projects`, { project_ids: [] });
    assert.equal((await get(f.base + '/incoming')).status, 404);
  } finally {
    f.dispose();
  }
});

test('sync is single-flight and discards results after settings or administrator access changes', async () => {
  let release!: () => void, started!: () => void;
  const arrived = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    started();
    await wait;
    return { uid_validity: '1', last_uid: 1, messages: [response(1)] };
  });
  try {
    await f.connect();
    const first = f.mailbox.sync();
    const second = f.mailbox.sync();
    const settled = Promise.allSettled([first, second]);
    await arrived;
    assert.equal(calls, 1);
    assert.equal(
      (await f.req('put', '/settings/incoming', { ...settings, revision: 1, enabled: false }))
        .status,
      200,
    );
    release();
    assert.deepEqual(
      (await settled).map((result) => result.status),
      ['rejected', 'rejected'],
    );
    assert.equal((await f.req('get', '/mailbox')).body.total, 0);
    assert.equal((await f.req('get', '/settings/incoming')).body.enabled, false);
    await f.req('put', '/settings/incoming', { ...settings, revision: 2 });
    f.db.prepare("UPDATE accounts SET role='researcher' WHERE id=1").run();
    await assert.rejects(f.mailbox.sync(), /administrator must enable/i);
    assert.equal(calls, 1);
  } finally {
    release();
    f.dispose();
  }
});

test('outbox reports uncertain acceptance without retry, and incoming transport errors never leak credentials', async () => {
  let attempts = 0;
  const f = await fixture(
    async () => {
      throw new Error('SECRET fixture-only-incoming-password');
    },
    async () => {
      attempts++;
      throw new Error('SMTP acceptance uncertain');
    },
  );
  try {
    await f.connect();
    const failed = await f.req('post', f.base + '/email', {
      to: f.lead.contact_email,
      subject: 'Support for your team',
      body: 'Hello, how can we help with your requirements?',
    });
    assert.equal(failed.status, 502);
    const outbox = await f.req('get', '/mailbox?folder=outbox');
    assert.equal(outbox.status, 200, outbox.text);
    assert.equal(outbox.body.items[0].status, 'UNKNOWN');
    assert.equal((await f.req('get', '/mailbox?folder=sent')).body.total, 0);
    assert.equal(attempts, 1);
    const result = await f.req('post', '/mailbox/sync');
    assert.equal(result.status, 502);
    assert.ok(!result.text.includes('SECRET'));
    assert.ok(!result.text.includes(settings.password));
    assert.ok(!(await f.req('get', '/settings/incoming')).text.includes(settings.password));
  } finally {
    f.dispose();
  }
});

test('MIME previews bound large messages and render HTML as inert text', async () => {
  const mime = Buffer.from(
    'From: Customer <contact@example.net>\r\nTo: support@example.com\r\nMessage-ID: <mime@example.net>\r\nIn-Reply-To: <outgoing@example.com>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello support</p><script>alert(1)</script><img src="https://tracking.example.org/pixel">',
  );
  const message = {
    seq: 1,
    uid: 1,
    size: mime.length,
    source: mime,
    internalDate: new Date(),
    envelope: {
      from: [{ address: 'contact@example.net', name: 'Customer' }],
      to: [{ address: 'support@example.com' }],
      subject: 'Hello',
    },
  } as FetchMessageObject;
  const parsed = await parseReceived(message);
  assert.ok(parsed.body.includes('Hello support'));
  assert.ok(!parsed.body.includes('<script>'));
  assert.ok(!parsed.body.includes('<img'));
  assert.deepEqual(parsed.references, ['<outgoing@example.com>']);
  const large = await parseReceived({ ...message, size: 10_000_000 });
  assert.equal(large.body, '');
  assert.match(large.notice, /larger than the preview limit/);
  const malformedDate = await parseReceived({ ...message, internalDate: new Date('invalid') });
  assert.match(malformedDate.notice, /date is unavailable/);
  assert.equal(malformedDate.body, parsed.body);
  await assert.rejects(
    readInbox({ host: '127.0.0.1', username: 'never', password: 'never', folder: 'INBOX' }, null),
    /public host/,
  );
});

test('IMAP uses TLS and read-only access, imports a bounded recent window and progresses across UID gaps', async (t) => {
  let nextUid = 501,
    validity = 1n;
  const ranges: string[] = [],
    downloaded: string[] = [];
  t.mock.method(ImapFlow.prototype, 'connect', async function (this: ImapFlow) {
    const options = (this as unknown as { options: Record<string, unknown> }).options;
    assert.equal(options.host, '8.8.8.8');
    assert.equal(options.port, 993);
    assert.equal(options.secure, true);
    assert.equal(options.logger, false);
    assert.equal(options.maxLiteralSize, 576_000);
    assert.deepEqual(options.tls, {
      servername: '8.8.8.8',
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    this.mailbox = {
      path: 'INBOX',
      delimiter: '/',
      flags: new Set(),
      uidValidity: validity,
      uidNext: nextUid,
      exists: 200,
    };
  });
  t.mock.method(ImapFlow.prototype, 'getMailboxLock', async (_folder: string, options: object) => {
    assert.deepEqual(options, { readOnly: true });
    return { release() {} };
  });
  t.mock.method(ImapFlow.prototype, 'fetchAll', async (range: string) => {
    ranges.push(range);
    if (range === '181:200')
      return Array.from({ length: 20 }, (_, i) => ({ uid: 481 + i, size: 50 }));
    if (range === '501:1500')
      return Array.from({ length: 30 }, (_, i) => ({ uid: 510 + i, size: 50 }));
    return [];
  });
  t.mock.method(
    ImapFlow.prototype,
    'fetchOne',
    async (uid: string, query: object, options: object) => {
      downloaded.push(uid);
      assert.deepEqual(query, { source: { start: 0, maxLength: 512_000 } });
      assert.deepEqual(options, { uid: true });
      return { source: Buffer.from('Subject: Test\r\n\r\nHello support.') };
    },
  );
  t.mock.method(ImapFlow.prototype, 'close', () => {});
  const config = { host: '8.8.8.8', username: 'fixture', password: 'fixture', folder: 'INBOX' };
  const initial = await readInbox(config, null);
  assert.equal(initial.messages.length, 20);
  assert.equal(initial.last_uid, 500);
  assert.equal(ranges[0], '181:200');
  nextUid = 5001;
  const next = await readInbox(config, { uid_validity: '1', last_uid: 500 });
  assert.equal(next.messages.length, 20);
  assert.equal(next.last_uid, 529);
  assert.equal(downloaded.length, 40);
  const gap = await readInbox(config, { uid_validity: '1', last_uid: 600 });
  assert.equal(gap.last_uid, 1600);
  assert.equal(gap.messages.length, 0);
  const count = ranges.length;
  await readInbox(config, { uid_validity: '1', last_uid: 5000 });
  assert.equal(ranges.length, count); // Never request n:* when no newer UID exists.
  validity = 2n;
  const reset = await readInbox(config, { uid_validity: '1', last_uid: 5000 });
  assert.equal(reset.uid_validity, '2');
  assert.equal(ranges.at(-1), '181:200');
});

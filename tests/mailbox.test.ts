import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp, getProject } from '../server/app';
import { hash, openDatabase } from '../server/database';
import { getEmailConfig, type Send, type SmtpConfig } from '../server/email';
import { createMailbox } from '../server/mailbox';
import { adoptWorkspaceMailbox } from '../server/mailbox-schema';
import {
  parseReceived,
  readInbox,
  type InboxCursor,
  type ReadInbox,
  type ReceivedMail,
} from '../server/imap';
import type { Lead, Project } from '../shared/types';
import { ImapFlow, type FetchMessageObject } from 'imapflow';

const settings = {
  revision: 0,
  host: '8.8.8.8',
  username: 'support@example.com',
  password: 'fixture-only-incoming-password',
  folder: 'INBOX',
  enabled: true,
};
/** A second mailbox on a second account: a project that receives its own mail, not a copy of A's. */
const otherSettings = {
  ...settings,
  username: 'sales@example.com',
  password: 'fixture-only-second-incoming-password',
};
const smtpSettings = {
  host: '8.8.8.8',
  port: 587,
  username: 'support@example.com',
  password: 'fixture-only-smtp-password',
  from_name: 'Support Team',
  from_email: 'support@example.com',
};
const otherSmtpSettings = {
  ...smtpSettings,
  host: '9.9.9.9',
  username: 'sales@example.com',
  password: 'fixture-only-second-smtp-password',
  from_name: 'Sales Team',
  from_email: 'sales@example.net',
};
/** Which plaintext password each fixture account expects, so a poll proves what it decrypted. */
const passwords: Record<string, string> = {
  [settings.username]: settings.password,
  [otherSettings.username]: otherSettings.password,
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
type Batch = Awaited<ReturnType<ReadInbox>>;
const empty: Batch = { uid_validity: '1', last_uid: 0, messages: [] };
async function fixture(reader?: ReadInbox, deliver?: Send) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-mailbox-'));
  // Keyed by account: two projects can poll one inbox, and each poll must be answered on its own.
  const batches = new Map<string, Batch>();
  const polls: Array<{ username: string; cursor: InboxCursor | null }> = [];
  const messages: Parameters<Send>[1][] = [];
  const senders: SmtpConfig[] = [];
  const instance = createApp({
    dataDir: directory,
    origin: 'https://mail.example.com',
    readInbox:
      reader ||
      (async (config, cursor) => {
        assert.equal(config.password, passwords[config.username]);
        polls.push({ username: config.username, cursor });
        return batches.get(config.username) || empty;
      }),
    sendMail:
      deliver ||
      (async (config, message) => {
        message.beforeSend?.();
        senders.push(config);
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
  /** A project, its one lead and the URLs of its own mailbox. */
  async function addProject(name: string, company: string, email: string) {
    const created = await req('post', '/projects', { name });
    assert.equal(created.status, 201, created.text);
    const project = created.body as Project;
    const added = await req('post', `/projects/${project.id}/leads`, {
      name: company,
      contact_email: email,
    });
    assert.equal(added.status, 201, added.text);
    const lead = added.body as Lead;
    return {
      project,
      lead,
      mail: `/projects/${project.id}/mailbox`,
      base: `/projects/${project.id}/leads/${lead.id}`,
    };
  }
  const first = await addProject('Support project', 'Example customer', 'contact@example.net');
  async function smtp(projectId: number, values: object = smtpSettings) {
    const saved = await req('put', `/projects/${projectId}/mailbox/email`, values);
    assert.equal(saved.status, 200, saved.text);
    return saved;
  }
  await smtp(first.project.id);
  return {
    ...instance,
    req,
    agent,
    project: first.project,
    lead: first.lead,
    base: first.base,
    mail: first.mail,
    messages,
    senders,
    polls,
    addProject,
    smtp,
    setBatch(value: Batch, username = settings.username) {
      batches.set(username, value);
    },
    async connect(projectId = first.project.id, body: object = settings) {
      const r = await req('put', `/projects/${projectId}/mailbox/settings`, body);
      assert.equal(r.status, 200, r.text);
    },
    sync(projectId = first.project.id) {
      return req('post', `/projects/${projectId}/mailbox/sync`);
    },
    list(projectId = first.project.id, folder = 'inbox') {
      return req('get', `/projects/${projectId}/mailbox?folder=${folder}`);
    },
    async send(target = first, subject = 'Support for your team') {
      const r = await req('post', target.base + '/email', {
        to: target.lead.contact_email,
        subject,
        body: 'Hello, how can we help with your requirements?',
      });
      assert.equal(r.status, 201, r.text);
    },
    dispose() {
      instance.db.close();
      disposeDirectory(directory, 'innovista-mailbox-');
    },
  };
}
/** Never remove anything that is not the fixture's own temporary directory. */
function disposeDirectory(directory: string, prefix: string) {
  const resolved = path.resolve(directory),
    parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), parent);
  assert.ok(path.basename(resolved).startsWith(prefix));
  fs.rmSync(resolved, { recursive: true, force: true });
}
/** Two projects, each sending and receiving through a mailbox of its own. */
async function secondProject(f: Awaited<ReturnType<typeof fixture>>) {
  const second = await f.addProject('Sales project', 'Other customer', 'buyer@example.org');
  await f.smtp(second.project.id, otherSmtpSettings);
  return second;
}

test('incoming credentials are encrypted, disabled by default, revision protected and never forwarded to a changed host', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.req('get', f.mail + '/settings')).body.enabled, false);
    assert.equal((await f.sync()).status, 409);
    await f.connect();
    const current = await f.req('get', f.mail + '/settings');
    assert.equal(current.body.has_password, true);
    assert.equal(current.body.password, undefined);
    assert.equal(current.body.project_id, f.project.id);
    assert.deepEqual(current.body.shared_with, []);
    assert.ok(!current.text.includes(settings.password));
    // The mailbox lives on the project now; the old workspace singleton is not written at all.
    const stored = f.db
      .prepare('SELECT imap_password FROM project_mailboxes WHERE project_id=?')
      .get(f.project.id) as { imap_password: string };
    assert.ok(stored.imap_password.startsWith('enc:v1:'));
    assert.ok(!stored.imap_password.includes(settings.password));
    assert.equal(
      f.db.prepare("SELECT value FROM settings WHERE key='imap_config'").get(),
      undefined,
    );
    assert.equal((await f.req('put', f.mail + '/settings', settings)).status, 409);
    assert.equal(
      (
        await f.req('put', f.mail + '/settings', {
          ...settings,
          revision: 1,
          host: '1.1.1.1',
          password: '',
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.req('put', f.mail + '/settings', { ...settings, revision: 1, host: '127.0.0.1' }))
        .status,
      400,
    );
    assert.equal(
      (
        await f.req('put', f.mail + '/settings', {
          ...settings,
          revision: 1,
          enabled: false,
          clear_password: true,
        })
      ).status,
      200,
    );
    assert.equal((await f.req('get', f.mail + '/settings')).body.has_password, false);
    const noCsrf = await f.agent
      .put('/api' + f.mail + '/settings')
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
    assert.equal((await f.sync()).body.received, 1);
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
    assert.equal((await f.sync()).body.received, 0);
    f.setBatch({ uid_validity: '2', last_uid: 99, messages: [{ ...mail, uid: 99 }] });
    assert.equal((await f.sync()).body.received, 0);
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
    await f.sync();
    assert.equal((await f.req('get', f.base)).body.outreach_status, 'CONVERTED');
    await f.req('post', f.base + '/outreach-events', {
      outcome: 'UNSUBSCRIBED',
      notes: 'Requested by recipient.',
    });
    f.setBatch({ uid_validity: '2', last_uid: 101, messages: [response(101, outgoing.messageId)] });
    await f.sync();
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
    const synced = await f.sync();
    assert.equal(synced.status, 200, synced.text);
    const inbox = await f.list();
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
    assert.equal((await get(f.mail)).status, 403);
    assert.equal((await get(f.mail + '/settings')).status, 403);
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
    assert.equal((await f.list(f.project.id, 'drafts')).body.total, 0);
    const unlinked = inbox.body.items.find((r: { lead_id: number | null }) => r.lead_id === null);
    // The receiving project is in the URL, so a project in the body has nothing left to say.
    assert.equal(
      (
        await f.req('post', `${f.mail}/incoming/${unlinked.id}/link`, {
          project_id: f.project.id,
          lead_id: f.lead.id,
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.req('post', `${f.mail}/incoming/${unlinked.id}/link`, { lead_id: f.lead.id }))
        .status,
      200,
    );
    assert.equal(
      (await f.req('post', `${f.mail}/incoming/${unlinked.id}/link`, { lead_id: f.lead.id }))
        .status,
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
    const first = f.mailbox.sync(f.project.id);
    const second = f.mailbox.sync(f.project.id);
    const settled = Promise.allSettled([first, second]);
    await arrived;
    assert.equal(calls, 1);
    assert.equal(
      (await f.req('put', f.mail + '/settings', { ...settings, revision: 1, enabled: false }))
        .status,
      200,
    );
    release();
    assert.deepEqual(
      (await settled).map((result) => result.status),
      ['rejected', 'rejected'],
    );
    assert.equal((await f.list()).body.total, 0);
    assert.equal((await f.req('get', f.mail + '/settings')).body.enabled, false);
    await f.req('put', f.mail + '/settings', { ...settings, revision: 2 });
    f.db.prepare("UPDATE accounts SET role='researcher' WHERE id=1").run();
    await assert.rejects(f.mailbox.sync(f.project.id), /administrator must enable/i);
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
    const outbox = await f.list(f.project.id, 'outbox');
    assert.equal(outbox.status, 200, outbox.text);
    assert.equal(outbox.body.items[0].status, 'UNKNOWN');
    assert.equal((await f.list(f.project.id, 'sent')).body.total, 0);
    assert.equal(attempts, 1);
    const result = await f.sync();
    assert.equal(result.status, 502);
    assert.ok(!result.text.includes('SECRET'));
    assert.ok(!result.text.includes(settings.password));
    assert.ok(!(await f.req('get', f.mail + '/settings')).text.includes(settings.password));
  } finally {
    f.dispose();
  }
});

test('a second project mailbox is saved beside the first one, never over it', async () => {
  const f = await fixture();
  try {
    const secret = () =>
      (
        f.db
          .prepare('SELECT smtp_password FROM project_mailboxes WHERE project_id=?')
          .get(f.project.id) as { smtp_password: string }
      ).smtp_password;
    const before = secret();
    assert.ok(before.startsWith('enc:v1:'));
    const second = await secondProject(f);
    const kept = (await f.req('get', f.mail + '/email')).body;
    assert.equal(kept.project_id, f.project.id);
    assert.equal(kept.host, smtpSettings.host);
    assert.equal(kept.username, smtpSettings.username);
    assert.equal(kept.from_email, smtpSettings.from_email);
    assert.equal(kept.has_password, true);
    // The stored ciphertext is untouched, so the first project's password still decrypts.
    assert.equal(secret(), before);
    const saved = (await f.req('get', second.mail + '/email')).body;
    assert.equal(saved.project_id, second.project.id);
    assert.equal(saved.host, otherSmtpSettings.host);
    assert.equal(saved.username, otherSmtpSettings.username);
    assert.equal(saved.from_email, otherSmtpSettings.from_email);
    // Clearing one project's password leaves the other project able to send.
    assert.equal(
      (
        await f.req('put', second.mail + '/email', {
          ...otherSmtpSettings,
          password: '',
          clear_password: true,
        })
      ).body.configured,
      false,
    );
    assert.equal((await f.req('get', f.mail + '/email')).body.configured, true);
    assert.equal(secret(), before);
  } finally {
    f.dispose();
  }
});

test('a lead email goes out as the address of the project that sent it', async () => {
  const f = await fixture();
  try {
    const second = await secondProject(f);
    await f.send();
    await f.send(second, 'A question for your team');
    assert.equal(f.senders.length, 2);
    assert.equal(f.senders[0].project_id, f.project.id);
    assert.equal(f.senders[0].from_email, smtpSettings.from_email);
    assert.equal(f.senders[1].project_id, second.project.id);
    assert.equal(f.senders[1].from_email, otherSmtpSettings.from_email);
    assert.equal(f.senders[1].host, otherSmtpSettings.host);
    // The unpredictable Message-ID is built from the sending address, and replies match on it.
    assert.match(f.messages[0].messageId!, /@example\.com>$/);
    assert.match(f.messages[1].messageId!, /@example\.net>$/);
    assert.equal(f.senders[0].password, smtpSettings.password);
    assert.equal(f.senders[1].password, otherSmtpSettings.password);
  } finally {
    f.dispose();
  }
});

test('the sending half refuses a new host or account while keeping the stored password', async () => {
  const f = await fixture();
  try {
    // The stored password was issued for the host it was saved with. Pointing the host
    // elsewhere and keeping it would hand that credential to whatever was just typed in.
    const movedHost = await f.req('put', f.mail + '/email', {
      ...smtpSettings,
      host: '9.9.9.9',
      password: '',
    });
    assert.equal(movedHost.status, 400, movedHost.text);
    assert.match(movedHost.body.error, /Enter a new password when changing the host or account\./);
    const movedAccount = await f.req('put', f.mail + '/email', {
      ...smtpSettings,
      username: 'moved@example.com',
      password: '',
    });
    assert.equal(movedAccount.status, 400, movedAccount.text);
    assert.match(
      movedAccount.body.error,
      /Enter a new password when changing the host or account\./,
    );
    // Neither refusal moved the mailbox.
    const kept = (await f.req('get', f.mail + '/email')).body;
    assert.equal(kept.host, smtpSettings.host);
    assert.equal(kept.username, smtpSettings.username);
    assert.equal(kept.has_password, true);
    // A new password is all that was missing, and the next send uses it.
    const repointed = await f.req('put', f.mail + '/email', {
      ...smtpSettings,
      host: '9.9.9.9',
      username: 'moved@example.com',
      password: 'fixture-only-repointed-smtp-password',
    });
    assert.equal(repointed.status, 200, repointed.text);
    assert.equal(repointed.body.host, '9.9.9.9');
    assert.equal(repointed.body.username, 'moved@example.com');
    assert.equal(repointed.body.password, undefined);
    await f.send();
    assert.equal(f.senders[0].host, '9.9.9.9');
    assert.equal(f.senders[0].username, 'moved@example.com');
    assert.equal(f.senders[0].password, 'fixture-only-repointed-smtp-password');
  } finally {
    f.dispose();
  }
});

test('email history records the address the message actually went out from', async () => {
  const f = await fixture();
  try {
    const second = await secondProject(f);
    await f.send();
    await f.send(second, 'A question for your team');
    // from_email is stored on the row, so history still names the sender after a mailbox moves.
    assert.deepEqual(
      f.db
        .prepare('SELECT project_id,to_email,from_email,status FROM email_messages ORDER BY id')
        .all(),
      [
        {
          project_id: f.project.id,
          to_email: f.lead.contact_email,
          from_email: smtpSettings.from_email,
          status: 'SENT',
        },
        {
          project_id: second.project.id,
          to_email: second.lead.contact_email,
          from_email: otherSmtpSettings.from_email,
          status: 'SENT',
        },
      ],
    );
    // Repointing the second project's mailbox afterwards leaves the recorded sender alone.
    assert.equal(
      (
        await f.req('put', second.mail + '/email', {
          ...otherSmtpSettings,
          from_email: 'new-sales@example.net',
          password: 'fixture-only-third-smtp-password',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        f.db
          .prepare('SELECT from_email FROM email_messages WHERE project_id=?')
          .get(second.project.id) as { from_email: string }
      ).from_email,
      otherSmtpSettings.from_email,
    );
  } finally {
    f.dispose();
  }
});

test('a reply only links inside the project whose mailbox received it', async () => {
  const f = await fixture();
  try {
    const second = await secondProject(f);
    await f.connect();
    // The second project sends; the reply arrives in the FIRST project's inbox.
    await f.send(second, 'Introducing our engineering team');
    const sentBySecond = f.messages[0].messageId!;
    f.setBatch({
      uid_validity: '1',
      last_uid: 1,
      messages: [
        response(1, sentBySecond, {
          from_email: second.lead.contact_email,
          to_email: settings.username,
        }),
      ],
    });
    assert.equal((await f.sync()).body.received, 1);
    const inbox = (await f.list()).body;
    assert.equal(inbox.total, 1);
    assert.equal(inbox.items[0].lead_id, null);
    assert.equal((await f.req('get', second.base + '/incoming')).body.length, 0);
    assert.notEqual((await f.req('get', second.base)).body.outreach_status, 'REPLIED');
    assert.equal(
      (
        f.db
          .prepare('SELECT count(*) n FROM outreach_events WHERE project_id=?')
          .get(second.project.id) as { n: number }
      ).n,
      0,
    );
    // Nor can an administrator link it across the boundary by hand.
    assert.equal(
      (
        await f.req('post', `${f.mail}/incoming/${inbox.items[0].id}/link`, {
          lead_id: second.lead.id,
        })
      ).status,
      404,
    );
    // The first project's own sent mail does claim its reply.
    await f.send();
    f.setBatch({
      uid_validity: '1',
      last_uid: 2,
      messages: [response(2, f.messages[1].messageId)],
    });
    assert.equal((await f.sync()).body.received, 1);
    const own = (await f.req('get', f.base + '/incoming')).body;
    assert.equal(own.length, 1);
    assert.equal((await f.req('get', f.base)).body.outreach_status, 'REPLIED');
    assert.equal((await f.req('get', second.base + '/incoming')).body.length, 0);
  } finally {
    f.dispose();
  }
});

test('linking is confined to the mailbox named in the path, administrator or not', async () => {
  const f = await fixture();
  try {
    const second = await secondProject(f);
    await f.connect();
    await f.connect(second.project.id, otherSettings);
    // One unmatched message in each project's own inbox.
    f.setBatch({ uid_validity: '1', last_uid: 1, messages: [response(1)] });
    f.setBatch(
      {
        uid_validity: '1',
        last_uid: 2,
        messages: [
          response(2, '', {
            from_email: second.lead.contact_email,
            to_email: otherSettings.username,
          }),
        ],
      },
      otherSettings.username,
    );
    assert.equal((await f.sync()).body.received, 1);
    assert.equal((await f.sync(second.project.id)).body.received, 1);
    const mine = (await f.list()).body.items[0];
    const theirs = (await f.list(second.project.id)).body.items[0];
    assert.notEqual(mine.id, theirs.id);
    assert.equal(mine.lead_id, null);
    assert.equal(theirs.lead_id, null);
    // An administrator bypasses membership, so the mailbox scope is the only thing left to
    // refuse this: the message has to belong to the mailbox in the path, and the lead to that
    // same project. Naming a lead the route can reach does not make the message reachable.
    for (const [mailbox, id, leadId, why] of [
      [second.mail, mine.id, second.lead.id, "this mailbox's own lead cannot claim A's message"],
      [f.mail, theirs.id, f.lead.id, "this mailbox's own lead cannot claim B's message"],
      [second.mail, mine.id, f.lead.id, "nor can A's lead be named through B's route"],
      [f.mail, theirs.id, second.lead.id, "nor can B's lead be named through A's route"],
    ] as const)
      assert.equal(
        (await f.req('post', `${mailbox}/incoming/${id}/link`, { lead_id: leadId })).status,
        404,
        why,
      );
    // Nothing was linked and no reply was recorded for anybody.
    assert.equal(
      (
        f.db
          .prepare('SELECT count(*) n FROM incoming_messages WHERE project_id IS NOT NULL')
          .get() as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (f.db.prepare('SELECT count(*) n FROM outreach_events').get() as { n: number }).n,
      0,
    );
    // Each message still links through the route of the mailbox that received it.
    assert.equal(
      (await f.req('post', `${f.mail}/incoming/${mine.id}/link`, { lead_id: f.lead.id })).status,
      200,
    );
    assert.equal(
      (
        await f.req('post', `${second.mail}/incoming/${theirs.id}/link`, {
          lead_id: second.lead.id,
        })
      ).status,
      200,
    );
    assert.equal((await f.req('get', f.base + '/incoming')).body.length, 1);
    assert.equal((await f.req('get', second.base + '/incoming')).body.length, 1);
  } finally {
    f.dispose();
  }
});

test('every mail folder is narrowed to the project that owns the mailbox', async () => {
  const f = await fixture();
  try {
    const second = await secondProject(f);
    await f.connect();
    await f.connect(second.project.id, otherSettings);
    const stamp = new Date(Date.now() - 1000).toISOString();
    const enroll = (target: { project: Project; lead: Lead }, funnelId: number) => {
      f.db
        .prepare(
          "INSERT INTO funnels(id,project_id,name,steps_json,created_at,created_by) VALUES(?,?,'QA','[]',?,'QA')",
        )
        .run(funnelId, target.project.id, stamp);
      f.db
        .prepare(
          `INSERT INTO funnel_enrollments(project_id,funnel_id,lead_id,recipient,lead_revision,training_version,account_id,created_by,next_send_at,created_at,updated_at)
        VALUES(?,?,?,?,1,1,1,'QA',?,?,?)`,
        )
        .run(
          target.project.id,
          funnelId,
          target.lead.id,
          target.lead.contact_email,
          Date.now(),
          stamp,
          stamp,
        );
    };
    for (const target of [f, second]) {
      await f.send(target, 'Support for ' + target.lead.name);
      const draft = await f.req('put', target.base + '/email/draft', {
        revision: 0,
        to: target.lead.contact_email,
        subject: 'Draft for ' + target.lead.name,
        preview_text: '',
        blocks: [],
      });
      assert.equal(draft.status, 200, draft.text);
    }
    f.setBatch({
      uid_validity: '1',
      last_uid: 1,
      messages: [response(1, f.messages[0].messageId)],
    });
    f.setBatch(
      {
        uid_validity: '1',
        last_uid: 5,
        messages: [
          response(5, f.messages[1].messageId, {
            from_email: second.lead.contact_email,
            to_email: otherSettings.username,
          }),
        ],
      },
      otherSettings.username,
    );
    assert.equal((await f.sync()).body.received, 1);
    assert.equal((await f.sync(second.project.id)).body.received, 1);
    // Queued after the replies, so the replies leave these follow-ups alone.
    for (const [index, target] of [f, second].entries()) enroll(target, index + 1);
    for (const target of [f, second]) {
      const page = await f.list(target.project.id);
      assert.equal(page.status, 200, page.text);
      assert.deepEqual(page.body.counts, { inbox: 1, outbox: 1, sent: 1, drafts: 1 });
      for (const folder of ['inbox', 'outbox', 'sent', 'drafts'] as const) {
        const body = (await f.list(target.project.id, folder)).body;
        assert.equal(body.total, 1, folder + ' for ' + target.project.name);
        assert.equal(body.items.length, 1);
        assert.equal(body.items[0].company, target.lead.name);
        assert.equal(body.items[0].project_id, target.project.id);
      }
      assert.equal(
        (await f.list(target.project.id, 'inbox')).body.items[0].address,
        target.lead.contact_email,
      );
    }
  } finally {
    f.dispose();
  }
});

test('the outbox is project-scoped, including a message that never reached the mailbox', async () => {
  const f = await fixture(undefined, async (_config, message) => {
    message.beforeSend?.();
    throw new Error('SECRET relay refused the message');
  });
  try {
    const second = await secondProject(f);
    // A refused send is recorded rather than discarded, which is the only way a non-SENT row
    // exists at all — and therefore the only way the outbox branch has anything to scope.
    for (const target of [f, second]) {
      const refused = await f.req('post', target.base + '/email', {
        to: target.lead.contact_email,
        subject: 'Undeliverable introduction',
        body: 'Hello, how can we help with your requirements?',
      });
      assert.equal(refused.status, 502, refused.text);
      assert.ok(!refused.text.includes('SECRET'));
    }
    for (const target of [f, second]) {
      const outbox = await f.list(target.project.id, 'outbox');
      assert.equal(outbox.status, 200, outbox.text);
      assert.equal(outbox.body.total, 1);
      assert.equal(outbox.body.items.length, 1);
      assert.equal(outbox.body.items[0].status, 'UNKNOWN');
      assert.equal(outbox.body.items[0].kind, 'outgoing');
      assert.equal(outbox.body.items[0].project_id, target.project.id);
      assert.equal(outbox.body.items[0].address, target.lead.contact_email);
      assert.equal(outbox.body.items[0].company, target.lead.name);
      // Nothing was accepted, so Sent stays empty and the count comes from the outbox alone.
      assert.equal((await f.list(target.project.id, 'sent')).body.total, 0);
      assert.deepEqual((await f.list(target.project.id)).body.counts, {
        inbox: 0,
        outbox: 1,
        sent: 0,
        drafts: 0,
      });
    }
  } finally {
    f.dispose();
  }
});

test('marking an incoming message read belongs to its own mailbox and is stamped once', async () => {
  const f = await fixture();
  try {
    const second = await secondProject(f);
    await f.connect();
    await f.connect(second.project.id, otherSettings);
    f.setBatch({ uid_validity: '1', last_uid: 1, messages: [response(1)] });
    f.setBatch(
      {
        uid_validity: '1',
        last_uid: 2,
        messages: [
          response(2, '', {
            from_email: second.lead.contact_email,
            to_email: otherSettings.username,
          }),
        ],
      },
      otherSettings.username,
    );
    assert.equal((await f.sync()).body.received, 1);
    assert.equal((await f.sync(second.project.id)).body.received, 1);
    const mine = (await f.list()).body.items[0];
    const theirs = (await f.list(second.project.id)).body.items[0];
    const readAt = (id: number) =>
      (
        f.db.prepare('SELECT read_at FROM incoming_messages WHERE id=?').get(id) as {
          read_at: string | null;
        }
      ).read_at;
    assert.equal(mine.status, 'UNREAD');
    // The other project's route cannot reach into this mailbox to read its mail.
    const crossed = await f.req('post', `${second.mail}/incoming/${mine.id}/read`, {});
    assert.equal(crossed.status, 404, crossed.text);
    assert.equal(crossed.body.error, 'Message not found.');
    assert.equal(readAt(mine.id), null);
    const marked = await f.req('post', `${f.mail}/incoming/${mine.id}/read`, {});
    assert.equal(marked.status, 200, marked.text);
    assert.deepEqual(marked.body, { ok: true });
    assert.ok(readAt(mine.id));
    assert.equal((await f.list()).body.items[0].status, 'READ');
    // Reading it again keeps the first timestamp: read_at records when it was first read.
    const stamped = '2026-01-01T00:00:00.000Z';
    f.db.prepare('UPDATE incoming_messages SET read_at=? WHERE id=?').run(stamped, mine.id);
    assert.equal((await f.req('post', `${f.mail}/incoming/${mine.id}/read`, {})).status, 200);
    assert.equal(readAt(mine.id), stamped);
    // The other project's message was never touched.
    assert.equal(readAt(theirs.id), null);
    assert.equal((await f.list(second.project.id)).body.items[0].status, 'UNREAD');
  } finally {
    f.dispose();
  }
});

test('two projects on one inbox keep separate cursors and separate copies', async () => {
  const f = await fixture();
  try {
    const second = await f.addProject('Sales project', 'Other customer', 'buyer@example.org');
    const cursor = (projectId: number) =>
      f.db
        .prepare('SELECT uid_validity,last_uid FROM project_mailbox_cursors WHERE project_id=?')
        .get(projectId);
    await f.connect();
    f.setBatch({ uid_validity: '7', last_uid: 40, messages: [response(40)] });
    assert.equal((await f.sync()).body.received, 1);
    assert.deepEqual(cursor(f.project.id), { uid_validity: '7', last_uid: 40 });
    // Pointing a second project at the same account is allowed, and it is named as a warning.
    await f.connect(second.project.id);
    assert.deepEqual((await f.req('get', second.mail + '/settings')).body.shared_with, [
      f.project.name,
    ]);
    assert.deepEqual((await f.req('get', f.mail + '/settings')).body.shared_with, [
      second.project.name,
    ]);
    // It starts from nothing and takes its own copy of the message the first project already has.
    f.setBatch({ uid_validity: '7', last_uid: 41, messages: [response(40), response(41)] });
    assert.equal((await f.sync(second.project.id)).body.received, 2);
    assert.equal(f.polls.at(-1)?.cursor, null);
    assert.deepEqual(cursor(second.project.id), { uid_validity: '7', last_uid: 41 });
    assert.deepEqual(cursor(f.project.id), { uid_validity: '7', last_uid: 40 });
    assert.equal((await f.list()).body.total, 1);
    assert.equal((await f.list(second.project.id)).body.total, 2);
    // The first project resumes from its own place: not rewound, and not carried to UID 41.
    f.setBatch({ uid_validity: '7', last_uid: 42, messages: [] });
    assert.equal((await f.sync()).body.received, 0);
    assert.deepEqual(f.polls.at(-1)?.cursor, { uid_validity: '7', last_uid: 40 });
    assert.deepEqual(cursor(f.project.id), { uid_validity: '7', last_uid: 42 });
    assert.deepEqual(cursor(second.project.id), { uid_validity: '7', last_uid: 41 });
  } finally {
    f.dispose();
  }
});

test('repointing an inbox drops its resume point instead of reusing another account UID', async () => {
  const polls: Array<{
    username: string;
    folder: string;
    password: string;
    cursor: InboxCursor | null;
  }> = [];
  let uid = 77;
  const f = await fixture(async (config, cursor) => {
    polls.push({
      username: config.username,
      folder: config.folder,
      password: config.password,
      cursor,
    });
    return { uid_validity: '9', last_uid: uid, messages: [response(uid)] };
  });
  try {
    const cursor = () =>
      f.db
        .prepare('SELECT uid_validity,last_uid FROM project_mailbox_cursors WHERE project_id=?')
        .get(f.project.id);
    await f.connect();
    assert.equal((await f.sync()).body.received, 1);
    assert.deepEqual(cursor(), { uid_validity: '9', last_uid: 77 });
    // A UID cursor belongs to one account and folder. Resuming a different inbox at UID 77
    // would silently skip everything below it, so a new host starts from nothing.
    const moved = await f.req('put', f.mail + '/settings', {
      ...settings,
      revision: 1,
      host: '1.1.1.1',
      password: 'fixture-only-repointed-incoming-password',
    });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(cursor(), undefined);
    uid = 12;
    assert.equal((await f.sync()).body.received, 1);
    assert.deepEqual(polls.at(-1), {
      username: settings.username,
      folder: settings.folder,
      password: 'fixture-only-repointed-incoming-password',
      cursor: null,
    });
    assert.deepEqual(cursor(), { uid_validity: '9', last_uid: 12 });
    // The same applies to the folder, where UID 12 means something else entirely. Keeping the
    // stored password is allowed here: the account it was issued for has not changed.
    const refoldered = await f.req('put', f.mail + '/settings', {
      ...settings,
      revision: 2,
      host: '1.1.1.1',
      folder: 'Archive',
      password: '',
    });
    assert.equal(refoldered.status, 200, refoldered.text);
    assert.equal(cursor(), undefined);
    uid = 4;
    assert.equal((await f.sync()).body.received, 1);
    assert.deepEqual(polls.at(-1), {
      username: settings.username,
      folder: 'Archive',
      password: 'fixture-only-repointed-incoming-password',
      cursor: null,
    });
    // Saving the same inbox again is not a repoint, so the resume point survives it.
    assert.deepEqual(cursor(), { uid_validity: '9', last_uid: 4 });
    const unchanged = await f.req('put', f.mail + '/settings', {
      ...settings,
      revision: 3,
      host: '1.1.1.1',
      folder: 'Archive',
      password: '',
    });
    assert.equal(unchanged.status, 200, unchanged.text);
    assert.deepEqual(cursor(), { uid_validity: '9', last_uid: 4 });
    uid = 5;
    assert.equal((await f.sync()).body.received, 1);
    assert.deepEqual(polls.at(-1)?.cursor, { uid_validity: '9', last_uid: 4 });
  } finally {
    f.dispose();
  }
});

test('one failing provider is reported instead of pausing every other project mailbox', async () => {
  const f = await fixture(async (config) => {
    if (config.username === otherSettings.username) throw new Error('SECRET provider outage');
    return { uid_validity: '1', last_uid: 9, messages: [response(9)] };
  });
  try {
    const second = await f.addProject('Sales project', 'Other customer', 'buyer@example.org');
    await f.connect();
    await f.connect(second.project.id, otherSettings);
    const result = await f.mailbox.syncAll();
    assert.equal(result.received, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], new RegExp('^project ' + second.project.id + ':'));
    assert.ok(!result.failures[0].includes('SECRET'));
    assert.ok(!result.failures[0].includes(otherSettings.password));
    // The healthy project still received its mail, and the failure is visible where it happened.
    assert.equal((await f.list()).body.total, 1);
    assert.equal((await f.list(second.project.id)).body.total, 0);
    assert.equal((await f.req('get', f.mail + '/settings')).body.last_error, '');
    assert.match(
      (await f.req('get', second.mail + '/settings')).body.last_error,
      /Incoming connection failed/,
    );
  } finally {
    f.dispose();
  }
});

test('mailbox administration is administrator-only while a member still reads their lead replies', async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.send();
    f.setBatch({
      uid_validity: '1',
      last_uid: 2,
      messages: [response(1, f.messages[0].messageId), response(2)],
    });
    assert.equal((await f.sync()).body.received, 2);
    const unlinked = (await f.list()).body.items.find(
      (row: { lead_id: number | null }) => row.lead_id === null,
    );
    const created = await f.req('post', '/users', {
      name: 'Member Researcher',
      username: 'member-researcher',
      password: 'Disposable-member-mail-2026',
      role: 'researcher',
    });
    assert.equal(created.status, 201, created.text);
    await f.req('put', `/users/${created.body.id}/projects`, { project_ids: [f.project.id] });
    const member = request.agent(f.app);
    const login = await member
      .post('/api/auth/login')
      .set('Host', 'mail.example.com')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'member-researcher', password: 'Disposable-member-mail-2026' });
    assert.equal(login.status, 200, login.text);
    const call = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
      const request_ = member[method]('/api' + url)
        .set('Host', 'mail.example.com')
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', login.body.csrf_token);
      return body === undefined ? request_ : request_.send(body);
    };
    // Full mailbox access stays administrator-only, even for a member of this project.
    for (const [method, url, body] of [
      ['get', f.mail, undefined],
      ['get', f.mail + '/email', undefined],
      ['put', f.mail + '/email', smtpSettings],
      ['post', f.mail + '/email/test', {}],
      ['get', f.mail + '/settings', undefined],
      ['put', f.mail + '/settings', { ...settings, revision: 1 }],
      ['post', f.mail + '/sync', {}],
      ['post', `${f.mail}/incoming/${unlinked.id}/read`, {}],
      ['post', `${f.mail}/incoming/${unlinked.id}/link`, { lead_id: f.lead.id }],
    ] as const)
      assert.equal((await call(method, url, body)).status, 403, method + ' ' + url);
    // The reply history on a lead they can reach is theirs to read.
    const own = await call('get', f.base + '/incoming');
    assert.equal(own.status, 200, own.text);
    assert.equal(own.body.length, 1);
    assert.equal(own.body[0].lead_id, f.lead.id);
    // Nothing they were refused changed the mailbox.
    assert.equal((await f.req('get', f.mail + '/settings')).body.revision, 1);
    assert.equal(
      (
        f.db.prepare('SELECT read_at FROM incoming_messages WHERE id=?').get(unlinked.id) as {
          read_at: string | null;
        }
      ).read_at,
      null,
    );
  } finally {
    f.dispose();
  }
});

test('adopting the workspace mailbox copies sending everywhere, polls the first project only and runs once', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-adopt-'));
  const { db, secrets } = openDatabase(directory);
  try {
    const stamp = '2026-01-01T00:00:00.000Z';
    const project = (name: string) =>
      Number(
        db
          .prepare('INSERT INTO projects (name,created_at,updated_at) VALUES (?,?,?)')
          .run(name, stamp, stamp).lastInsertRowid,
      );
    // Opening a database runs the adoption and writes its guard, so the state a real upgrade
    // starts from — legacy workspace rows, no project mailboxes — is rebuilt deliberately.
    const owner = (db.prepare('SELECT min(id) id FROM projects').get() as { id: number }).id;
    const later = project('Second project');
    db.prepare("DELETE FROM meta WHERE key='project_mailboxes_v1'").run();
    db.prepare('DELETE FROM project_mailboxes').run();
    db.prepare('DELETE FROM project_mailbox_cursors').run();
    const smtpSecret = secrets.encrypt('fixture-only-legacy-smtp');
    const imapSecret = secrets.encrypt('fixture-only-legacy-imap');
    const legacy = {
      host: 'imap.example.com',
      username: 'workspace@example.com',
      password: imapSecret,
      folder: 'Archive',
      enabled: true,
      enabled_by: 1,
      last_sync: stamp,
    };
    const setting = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
    for (const [key, value] of [
      ['smtp_host', 'mail.example.com'],
      ['smtp_port', '465'],
      ['smtp_secure', '1'],
      ['smtp_username', 'workspace@example.com'],
      ['smtp_password', smtpSecret],
      ['smtp_from_name', 'Workspace Team'],
      ['smtp_from_email', 'workspace@example.com'],
      ['smtp_reply_to', 'replies@example.com'],
      ['smtp_copy_to', 'owner@example.com'],
      ['smtp_signature', 'Workspace signature'],
      ['imap_config', JSON.stringify(legacy)],
    ] as const)
      setting.run(key, value);
    db.prepare(
      'INSERT OR REPLACE INTO mailbox_cursors(account_key,uid_validity,last_uid) VALUES(?,?,?)',
    ).run(hash(JSON.stringify([legacy.host, legacy.username, legacy.folder])), '12', 4242);
    db.prepare(
      `INSERT INTO incoming_messages
      (account_key,uid_validity,uid,internet_message_id,references_json,from_email,from_name,
       to_email,subject,body,received_at,created_at)
      VALUES('legacy-key','12',4200,'<legacy@example.net>','[]','contact@example.net','Customer',
       'workspace@example.com','Re: Support','Received before the split',?,?)`,
    ).run(stamp, stamp);

    adoptWorkspaceMailbox(db);

    // Sending is copied to every project, ciphertext included, so no project stops sending.
    for (const id of [owner, later]) {
      const config = getEmailConfig(db, secrets, id);
      assert.equal(config.project_id, id);
      assert.equal(config.host, 'mail.example.com');
      assert.equal(config.port, 465);
      assert.equal(config.secure, true);
      assert.equal(config.from_email, 'workspace@example.com');
      assert.equal(config.copy_to, 'owner@example.com');
      assert.equal(config.signature, 'Workspace signature');
      assert.equal(config.configured, true);
      assert.equal(config.password, 'fixture-only-legacy-smtp');
    }
    // Polling is enabled for the first project only: a second poller would ingest its own copy
    // of every message and show one project's replies to another project's members.
    assert.deepEqual(
      db
        .prepare(
          `SELECT project_id,imap_host,imap_username,imap_password,imap_folder,imap_enabled,
            imap_enabled_by,last_sync,revision FROM project_mailboxes ORDER BY project_id`,
        )
        .all(),
      [
        {
          project_id: owner,
          imap_host: legacy.host,
          imap_username: legacy.username,
          imap_password: imapSecret,
          imap_folder: legacy.folder,
          imap_enabled: 1,
          imap_enabled_by: 1,
          last_sync: stamp,
          revision: 0,
        },
        {
          project_id: later,
          imap_host: legacy.host,
          imap_username: legacy.username,
          imap_password: imapSecret,
          imap_folder: legacy.folder,
          imap_enabled: 0,
          imap_enabled_by: 0,
          last_sync: '',
          revision: 0,
        },
      ],
    );
    // The resume point comes along, so adoption does not re-download the whole inbox.
    assert.deepEqual(
      db.prepare('SELECT project_id,uid_validity,last_uid FROM project_mailbox_cursors').all(),
      [{ project_id: owner, uid_validity: '12', last_uid: 4242 }],
    );
    // Mail already received belongs to the project that keeps polling for it.
    assert.equal(
      (
        db.prepare('SELECT mailbox_project_id FROM incoming_messages').get() as {
          mailbox_project_id: number;
        }
      ).mailbox_project_id,
      owner,
    );
    // The legacy rows are left in place, unread, so the previous build still finds them.
    assert.equal(
      (
        db
          .prepare("SELECT count(*) n FROM settings WHERE key LIKE 'smtp_%' OR key='imap_config'")
          .get() as { n: number }
      ).n,
      11,
    );
    // The guard makes a second pass a no-op, for both new projects and repointed mailboxes.
    const third = project('Third project');
    db.prepare(
      "UPDATE project_mailboxes SET smtp_host='repointed.example.com' WHERE project_id=?",
    ).run(owner);
    adoptWorkspaceMailbox(db);
    assert.equal(getEmailConfig(db, secrets, third).configured, false);
    assert.equal(
      (db.prepare('SELECT count(*) n FROM project_mailboxes').get() as { n: number }).n,
      2,
    );
    assert.equal(getEmailConfig(db, secrets, owner).host, 'repointed.example.com');
  } finally {
    db.close();
    disposeDirectory(directory, 'innovista-adopt-');
  }
});

test('mail received before the split is not ingested again when UID validity rolls', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-presplit-'));
  const { db, secrets } = openDatabase(directory);
  try {
    const stamp = '2026-01-01T00:00:00.000Z',
      received = '2026-01-02T00:00:00.000Z';
    // The state a real upgrade starts from: one workspace mailbox, the project that has been
    // polling it, the reply it already ingested and the outcome that reply recorded.
    const project = (db.prepare('SELECT min(id) id FROM projects').get() as { id: number }).id;
    db.prepare(
      `INSERT INTO accounts (id,username,name,password_hash,role,active,created_at)
      VALUES (1,'presplit-admin','Pre-split Administrator','unusable-fixture-placeholder','admin',1,?)`,
    ).run(stamp);
    const lead = Number(
      db
        .prepare(
          `INSERT INTO leads (project_id,name,name_key,contact_email,created_at,updated_at)
        VALUES (?,'Example customer','example customer','contact@example.net',?,?)`,
        )
        .run(project, stamp, stamp).lastInsertRowid,
    );
    const sent = '<pre-split-outgoing@example.com>';
    db.prepare(
      `INSERT INTO email_messages
      (project_id,lead_id,to_email,subject,body,status,created_by,created_at,internet_message_id,from_email)
      VALUES (?,?,'contact@example.net','Support for your team','Hello.','SENT','Pre-split QA',?,?,'workspace@example.com')`,
    ).run(project, lead, stamp, sent);
    const legacy = {
      host: 'imap.example.com',
      username: 'workspace@example.com',
      folder: 'Archive',
      password: secrets.encrypt('fixture-only-legacy-imap'),
    };
    // The old key shape: the project was not part of the mailbox identity yet.
    const legacyKey = hash(JSON.stringify([legacy.host, legacy.username, legacy.folder]));
    const reply = {
      uid: 4200,
      message_id: '<pre-split-reply@example.net>',
      references: [sent],
      from_email: 'contact@example.net',
      from_name: 'Customer',
      to_email: legacy.username,
      subject: 'Re: Support for your team',
      body: 'Received before the split.',
      received_at: received,
      attachment_count: 0,
      notice: '',
    };
    db.prepare(
      `INSERT INTO incoming_messages
      (account_key,uid_validity,uid,internet_message_id,references_json,from_email,from_name,to_email,
       subject,body,received_at,attachment_count,notice,project_id,lead_id,linked_at,created_at)
      VALUES (?,'12',?,?,?,?,?,?,?,?,?,0,'',?,?,?,?)`,
    ).run(
      legacyKey,
      reply.uid,
      reply.message_id,
      JSON.stringify(reply.references),
      reply.from_email,
      reply.from_name,
      reply.to_email,
      reply.subject,
      reply.body,
      reply.received_at,
      project,
      lead,
      received,
      received,
    );
    db.prepare(
      `INSERT INTO outreach_events (project_id,lead_id,outcome,notes,created_by,created_at)
      VALUES (?,?,'REPLIED','Incoming reply received before the split.','Mailbox',?)`,
    ).run(project, lead, received);
    db.prepare("UPDATE leads SET outreach_status='REPLIED' WHERE id=?").run(lead);
    const setting = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
    for (const [key, value] of [
      ['smtp_host', 'mail.example.com'],
      ['smtp_port', '587'],
      ['smtp_username', legacy.username],
      ['smtp_password', secrets.encrypt('fixture-only-legacy-smtp')],
      ['smtp_from_name', 'Workspace Team'],
      ['smtp_from_email', legacy.username],
      ['smtp_copy_to', 'owner@example.com'],
      [
        'imap_config',
        JSON.stringify({ ...legacy, enabled: true, enabled_by: 1, last_sync: received }),
      ],
    ] as const)
      setting.run(key, value);
    db.prepare(
      'INSERT OR REPLACE INTO mailbox_cursors(account_key,uid_validity,last_uid) VALUES(?,?,?)',
    ).run(legacyKey, '12', reply.uid);
    // Opening the database already ran adoption against an empty workspace, so undo its work
    // and let it run once more against the install just described.
    db.prepare("DELETE FROM meta WHERE key='project_mailboxes_v1'").run();
    db.prepare('DELETE FROM project_mailboxes').run();
    db.prepare('DELETE FROM project_mailbox_cursors').run();

    adoptWorkspaceMailbox(db);

    // Adoption hands this project the inbox, its resume point and the mail already received.
    assert.deepEqual(
      db.prepare('SELECT project_id,uid_validity,last_uid FROM project_mailbox_cursors').all(),
      [{ project_id: project, uid_validity: '12', last_uid: reply.uid }],
    );
    assert.equal(
      (
        db.prepare('SELECT mailbox_project_id,account_key FROM incoming_messages').get() as {
          mailbox_project_id: number;
          account_key: string;
        }
      ).mailbox_project_id,
      project,
    );
    // The provider rolls UID validity during maintenance: every UID is new again and the
    // window is redelivered. Sync now keys on hash([project,host,username,folder]), so a probe
    // keyed on the account key would recognise nothing that arrived before the split.
    const polls: Array<InboxCursor | null> = [];
    let batch = { uid_validity: '13', last_uid: 1, messages: [{ ...reply, uid: 1 }] };
    const mailbox = createMailbox({
      db,
      secrets,
      getProject,
      readInbox: async (config, cursor) => {
        assert.equal(config.host, legacy.host);
        assert.equal(config.folder, legacy.folder);
        assert.equal(config.password, 'fixture-only-legacy-imap');
        polls.push(cursor);
        return batch;
      },
    });
    const counts = () => ({
      messages: (db.prepare('SELECT count(*) n FROM incoming_messages').get() as { n: number }).n,
      replies: (
        db.prepare("SELECT count(*) n FROM outreach_events WHERE outcome='REPLIED'").get() as {
          n: number;
        }
      ).n,
    });
    const resynced = await mailbox.sync(project);
    assert.deepEqual(
      counts(),
      { messages: 1, replies: 1 },
      'the redelivered pre-split message was ingested and recorded a second time',
    );
    assert.equal(resynced.received, 0);
    assert.deepEqual(polls, [{ uid_validity: '12', last_uid: reply.uid }]);
    // A message that really is new still arrives under the rolled validity.
    batch = {
      uid_validity: '13',
      last_uid: 2,
      messages: [
        { ...reply, uid: 1 },
        { ...reply, uid: 2, message_id: '<after-the-split@example.net>', references: [] },
      ],
    };
    assert.equal((await mailbox.sync(project)).received, 1);
    assert.deepEqual(counts(), { messages: 2, replies: 1 });
  } finally {
    db.close();
    disposeDirectory(directory, 'innovista-presplit-');
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

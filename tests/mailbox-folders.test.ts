import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import type { InboxCursor, ReadInbox, ReceivedMail } from '../server/imap';
import type { MailFolder, MailRow } from '../shared/mailbox';
import type { Lead, Project } from '../shared/types';

/**
 * The mailbox folder endpoint was made index-friendly: each folder counts its own table, an
 * empty search reuses that count as the page total, and Inbox and Sent are ordered by id.
 * These tests hold the endpoint to the behaviour of the query it replaced — the pre-change
 * SQL is kept here as the reference answer — and to the ordering, scoping, paging and search
 * a reader of the mailbox sees.
 */
const folders: MailFolder[] = ['inbox', 'outbox', 'sent', 'drafts'];
/** Enough rows to need a second page, so paging is proved rather than assumed. */
const seeded = 33;
const smtpSettings = {
  host: '8.8.8.8',
  port: 587,
  username: 'support@example.com',
  password: 'fixture-only-smtp-password',
  from_name: 'Support Team',
  from_email: 'support@example.com',
};
const imapSettings = {
  revision: 0,
  host: '8.8.8.8',
  username: 'support@example.com',
  password: 'fixture-only-incoming-password',
  folder: 'INBOX',
  enabled: true,
};
type Batch = Awaited<ReturnType<ReadInbox>>;
const empty: Batch = { uid_validity: '1', last_uid: 0, messages: [] };
/** Past, ascending: real ingest appends in UID order and a send is stamped as it is stored. */
const stamp = (minute: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + minute * 60000).toISOString();

/** Never remove anything that is not the fixture's own temporary directory. */
function disposeDirectory(directory: string) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('innovista-folders-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-folders-'));
  const batches = new Map<number, Batch>();
  const sent: Array<{ messageId?: string }> = [];
  const instance = createApp({
    dataDir: directory,
    origin: 'https://mail.example.com',
    readInbox: async (config, _cursor: InboxCursor | null) =>
      batches.get(Number(config.username.replace(/\D/g, ''))) || empty,
    sendMail: async (_config, message) => {
      message.beforeSend?.();
      sent.push(message);
      // A refused send is recorded rather than discarded, which is what puts a row in the outbox.
      if (message.subject.includes('Undeliverable')) throw new Error('SECRET relay refused this');
    },
  });
  const agent = request.agent(instance.app);
  let csrf = '';
  const req = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const call = agent[method]('/api' + url)
      .set('Host', 'mail.example.com')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf);
    return body === undefined ? call : call.send(body);
  };
  const setup = await req('post', '/auth/setup', {
    name: 'Folder QA',
    username: 'folder-qa',
    password: 'Disposable-folders-QA-2026',
  });
  assert.equal(setup.status, 201, setup.text);
  csrf = setup.body.csrf_token;
  const accountId = setup.body.account?.id || 1;

  /** A project with its own mailbox, its own leads and its own history in all four folders. */
  async function addProject(index: number) {
    const created = await req('post', '/projects', { name: 'Project ' + index });
    assert.equal(created.status, 201, created.text);
    const project = created.body as Project;
    const leads: Lead[] = [];
    for (const suffix of ['alpha', 'beta']) {
      const added = await req('post', `/projects/${project.id}/leads`, {
        name: `Company ${suffix} ${index}`,
        contact_email: `${suffix}-${index}@example.net`,
      });
      assert.equal(added.status, 201, added.text);
      leads.push(added.body as Lead);
    }
    const mailbox = `/projects/${project.id}/mailbox`;
    const account = `mailbox-${index}@example.com`;
    const email = await req('put', mailbox + '/email', {
      ...smtpSettings,
      username: account,
      from_email: account,
    });
    assert.equal(email.status, 200, email.text);
    const settings = await req('put', mailbox + '/settings', {
      ...imapSettings,
      username: account,
    });
    assert.equal(settings.status, 200, settings.text);
    return { project, leads, mailbox, index };
  }
  return {
    ...instance,
    req,
    sent,
    accountId,
    addProject,
    setBatch(index: number, messages: ReceivedMail[]) {
      batches.set(index, { uid_validity: '1', last_uid: messages.length, messages });
    },
    list(projectId: number, folder: MailFolder = 'inbox', page = 1, query = '') {
      return req(
        'get',
        `/projects/${projectId}/mailbox?folder=${folder}&page=${page}&q=${encodeURIComponent(query)}`,
      );
    },
    dispose() {
      instance.db.close();
      disposeDirectory(directory);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Target = Awaited<ReturnType<Fixture['addProject']>>;

const incoming = (index: number, uid: number, extra: Partial<ReceivedMail> = {}): ReceivedMail => ({
  uid,
  message_id: `<incoming-${index}-${uid}@example.net>`,
  references: [],
  from_email: `sender${uid}@example.net`,
  from_name: 'Customer',
  to_email: `mailbox-${index}@example.com`,
  subject: `Enquiry ${uid} for project ${index}`,
  body: 'We would like to discuss our requirements.',
  received_at: stamp(uid),
  attachment_count: 0,
  notice: '',
  ...extra,
});

/**
 * Fills every folder of one project: an inbox from a poll, a Sent and an Outbox history long
 * enough to page, a queued funnel step and a draft per lead.
 */
async function seedProject(f: Fixture, target: Target) {
  const outgoing = f.db.prepare(
    `INSERT INTO email_messages(project_id,lead_id,to_email,subject,body,status,error,created_by,created_at,from_email,internet_message_id)
     VALUES(?,?,?,?,'Body',?,?,'Folder QA',?,?,'')`,
  );
  f.db.transaction(() => {
    for (let i = 1; i <= seeded; i++) {
      const lead = target.leads[i % target.leads.length];
      // A recipient of its own per message: three emails per address is the standing limit,
      // and this history is meant to be long, not to exhaust it.
      outgoing.run(
        target.project.id,
        lead.id,
        `sent${i}-${target.index}@example.net`,
        `Introduction ${i} for project ${target.index}`,
        'SENT',
        '',
        stamp(i),
        `mailbox-${target.index}@example.com`,
      );
    }
    for (let i = 1; i <= 3; i++)
      outgoing.run(
        target.project.id,
        target.leads[0].id,
        `refused${i}-${target.index}@example.net`,
        `Undeliverable ${i} for project ${target.index}`,
        'FAILED',
        'The mailbox refused this message.',
        stamp(seeded + i),
        `mailbox-${target.index}@example.com`,
      );
    // A queued sequence step: the outbox row whose timestamp is in the future, not the past.
    f.db
      .prepare(
        "INSERT INTO funnels(id,project_id,name,steps_json,status,revision,created_at,created_by) VALUES(?,?,'QA','[]','ACTIVE',1,?,'Folder QA')",
      )
      .run(target.index, target.project.id, stamp(0));
    f.db
      .prepare(
        `INSERT INTO funnel_enrollments(project_id,funnel_id,lead_id,recipient,lead_revision,training_version,account_id,created_by,status,next_send_at,created_at,updated_at)
         VALUES(?,?,?,?,1,1,?,'Folder QA','QUEUED',?,?,?)`,
      )
      .run(
        target.project.id,
        target.index,
        target.leads[1].id,
        `queued-${target.index}@example.net`,
        f.accountId,
        Date.UTC(2026, 11, 1),
        stamp(1),
        stamp(1),
      );
  })();
  // One real send and one real refusal, so the pipeline's own rows — and the delivery row the
  // outbox joins for its status — are in the history alongside the seeded ones.
  const delivered = await f.req(
    'post',
    `/projects/${target.project.id}/leads/${target.leads[0].id}/email`,
    {
      to: target.leads[0].contact_email,
      subject: `Live introduction for project ${target.index}`,
      body: 'Hello, how can we help with your requirements?',
    },
  );
  assert.equal(delivered.status, 201, delivered.text);
  const refused = await f.req(
    'post',
    `/projects/${target.project.id}/leads/${target.leads[1].id}/email`,
    {
      to: target.leads[1].contact_email,
      subject: `Undeliverable live message for project ${target.index}`,
      body: 'Hello, how can we help with your requirements?',
    },
  );
  assert.equal(refused.status, 502, refused.text);
  assert.ok(!refused.text.includes('SECRET'));
  for (const lead of target.leads) {
    const draft = await f.req(
      'put',
      `/projects/${target.project.id}/leads/${lead.id}/email/draft`,
      {
        revision: 0,
        to: lead.contact_email,
        subject: `Draft for ${lead.name}`,
        preview_text: '',
        blocks: [],
      },
    );
    assert.equal(draft.status, 200, draft.text);
  }
  const messages: ReceivedMail[] = [];
  for (let uid = 1; uid < seeded; uid++) messages.push(incoming(target.index, uid));
  // A reply to the live message, so one inbox row is linked to a lead and carries its company.
  // It answers a message that was just sent, which is why it is the newest of the batch.
  const reference = f.sent.find((message) => message.messageId)?.messageId || '';
  messages.push(
    incoming(target.index, seeded, {
      references: [reference],
      subject: 'Re: Support',
      from_email: target.leads[0].contact_email,
      received_at: new Date().toISOString(),
    }),
  );
  f.setBatch(target.index, messages);
  const synced = await f.req('post', `/projects/${target.project.id}/mailbox/sync`);
  assert.equal(synced.status, 200, synced.text);
  assert.equal(synced.body.received, seeded);
}

/**
 * The endpoint's query before it was made index-friendly, kept verbatim as the reference
 * answer: one count(*) per folder around the whole folder query, and every page sorted by
 * timestamp then id.
 */
function legacy(db: Fixture['db'], projectId: number, accountId: number) {
  const sql: Record<MailFolder, string> = {
    inbox: `SELECT i.id,'incoming' AS kind,i.project_id,i.lead_id,l.name AS company,i.from_email AS address,
      i.subject,i.body,CASE WHEN i.read_at IS NULL THEN 'UNREAD' ELSE 'READ' END AS status,
      i.received_at AS timestamp,i.notice FROM incoming_messages i LEFT JOIN leads l ON l.project_id=i.project_id AND l.id=i.lead_id
      WHERE i.mailbox_project_id=${projectId}`,
    sent: `SELECT m.id,'outgoing' AS kind,m.project_id,m.lead_id,l.name AS company,m.to_email AS address,
      m.subject,m.body,m.status,m.created_at AS timestamp,m.error AS notice FROM email_messages m
      JOIN leads l ON l.project_id=m.project_id AND l.id=m.lead_id WHERE m.status='SENT' AND m.project_id=${projectId}`,
    outbox: `SELECT m.id,'outgoing' AS kind,m.project_id,m.lead_id,l.name AS company,m.to_email AS address,
      m.subject,m.body,COALESCE(d.status,m.status) AS status,m.created_at AS timestamp,m.error AS notice
      FROM email_messages m JOIN leads l ON l.project_id=m.project_id AND l.id=m.lead_id
      LEFT JOIN email_deliveries d ON d.project_id=m.project_id AND d.lead_id=m.lead_id AND d.message_id=m.id WHERE m.status!='SENT' AND m.project_id=${projectId}
      UNION ALL SELECT e.id,'queue',e.project_id,e.lead_id,l.name,e.recipient,f.name,'',
      CASE WHEN f.status='ACTIVE' THEN e.status ELSE f.status END,
      strftime('%Y-%m-%dT%H:%M:%fZ',e.next_send_at/1000.0,'unixepoch'),e.reason
      FROM funnel_enrollments e JOIN funnels f ON f.project_id=e.project_id AND f.id=e.funnel_id
      JOIN leads l ON l.project_id=e.project_id AND l.id=e.lead_id WHERE e.status='QUEUED' AND e.project_id=${projectId}`,
    drafts: `SELECT d.lead_id AS id,'draft' AS kind,d.project_id,d.lead_id,l.name AS company,
      json_extract(d.document_json,'$.to') AS address,json_extract(d.document_json,'$.subject') AS subject,
      '' AS body,'DRAFT' AS status,d.updated_at AS timestamp,'' AS notice FROM email_drafts d
      JOIN leads l ON l.project_id=d.project_id AND l.id=d.lead_id
      WHERE d.account_id=${accountId} AND d.project_id=${projectId}`,
  };
  const filter = (folder: MailFolder) =>
    ` FROM (${sql[folder]}) WHERE instr(lower(coalesce(subject,'')||' '||coalesce(company,'')||' '||address),?)>0`;
  return {
    counts: () =>
      Object.fromEntries(
        Object.entries(sql).map(([key, value]) => [
          key,
          (db.prepare('SELECT count(*) AS n FROM (' + value + ')').get() as { n: number }).n,
        ]),
      ) as Record<MailFolder, number>,
    page: (folder: MailFolder, page = 1, query = '') =>
      db
        .prepare('SELECT *' + filter(folder) + ' ORDER BY timestamp DESC,id DESC LIMIT 30 OFFSET ?')
        .all(query.toLowerCase(), (page - 1) * 30) as MailRow[],
    total: (folder: MailFolder, query = '') =>
      (
        db.prepare('SELECT count(*) AS n' + filter(folder)).get(query.toLowerCase()) as {
          n: number;
        }
      ).n,
  };
}

test('every folder page, count and total matches the query it replaced, for each project', async () => {
  const f = await fixture();
  try {
    const first = await f.addProject(1);
    const second = await f.addProject(2);
    for (const target of [first, second]) await seedProject(f, target);
    for (const target of [first, second]) {
      const reference = legacy(f.db, target.project.id, f.accountId);
      const expectedCounts = reference.counts();
      // Enough history that a page is a page: Sent and Inbox both spill past the first 30.
      assert.equal(expectedCounts.inbox, seeded);
      assert.equal(expectedCounts.sent, seeded + 1);
      assert.equal(expectedCounts.outbox, 5);
      assert.equal(expectedCounts.drafts, 2);
      for (const folder of folders)
        for (const page of [1, 2]) {
          const answer = await f.list(target.project.id, folder, page);
          assert.equal(answer.status, 200, answer.text);
          assert.deepEqual(answer.body.counts, expectedCounts, folder + ' counts');
          assert.equal(answer.body.total, reference.total(folder), folder + ' total');
          assert.deepEqual(
            answer.body.items,
            reference.page(folder, page),
            `${folder} page ${page} of ${target.project.name}`,
          );
        }
    }
  } finally {
    f.dispose();
  }
});

test('a folder page is newest first, and the second page continues it without repeating a row', async () => {
  const f = await fixture();
  try {
    const target = await f.addProject(1);
    await seedProject(f, target);
    for (const folder of folders) {
      const first = await f.list(target.project.id, folder, 1);
      const second = await f.list(target.project.id, folder, 2);
      const rows: MailRow[] = [...first.body.items, ...second.body.items];
      assert.equal(rows.length, first.body.total);
      assert.equal(new Set(rows.map((row) => `${row.kind}:${row.id}`)).size, rows.length, folder);
      for (const [index, row] of rows.entries())
        if (index)
          assert.ok(rows[index - 1].timestamp >= row.timestamp, folder + ' is newest first');
    }
    // The newest row of each growing folder is the last one recorded, on page one, at the top.
    const inbox = await f.list(target.project.id, 'inbox');
    assert.equal(inbox.body.items[0].subject, 'Re: Support');
    assert.equal(inbox.body.items[1].subject, `Enquiry ${seeded - 1} for project 1`);
    const sent = await f.list(target.project.id, 'sent');
    assert.equal(sent.body.items[0].subject, 'Live introduction for project 1');
    assert.equal(sent.body.items[1].subject, `Introduction ${seeded} for project 1`);
    // The queued step is dated in the future, so it heads the outbox ahead of refused sends.
    const outbox = await f.list(target.project.id, 'outbox');
    assert.equal(outbox.body.items[0].kind, 'queue');
    assert.equal(outbox.body.items[0].status, 'QUEUED');
    assert.equal(outbox.body.items[1].status, 'UNKNOWN');
  } finally {
    f.dispose();
  }
});

test('a folder shows only its own project, and a count never borrows another mailbox', async () => {
  const f = await fixture();
  try {
    const first = await f.addProject(1);
    const second = await f.addProject(2);
    for (const target of [first, second]) await seedProject(f, target);
    for (const target of [first, second])
      for (const folder of folders) {
        const answer = await f.list(target.project.id, folder);
        assert.equal(answer.status, 200, answer.text);
        const rows: MailRow[] = answer.body.items;
        assert.ok(rows.length > 0, folder);
        for (const row of rows) {
          if (row.project_id !== null)
            assert.equal(row.project_id, target.project.id, folder + ' row project');
          if (row.company !== null)
            assert.ok(row.company.endsWith(' ' + target.index), folder + ' row company');
          assert.ok(
            !row.subject.includes('project ' + (target.index === 1 ? 2 : 1)),
            folder + ' row subject',
          );
        }
      }
    // Identical histories on both sides, so a count that leaked would read double, not zero.
    const counts = await Promise.all(
      [first, second].map(async (target) => (await f.list(target.project.id)).body.counts),
    );
    assert.deepEqual(counts[0], counts[1]);
    assert.deepEqual(counts[0], { inbox: seeded, sent: seeded + 1, outbox: 5, drafts: 2 });
  } finally {
    f.dispose();
  }
});

test('searching a folder still filters by subject, company and address, and leaves the badges alone', async () => {
  const f = await fixture();
  try {
    const first = await f.addProject(1);
    const second = await f.addProject(2);
    for (const target of [first, second]) await seedProject(f, target);
    const reference = legacy(f.db, first.project.id, f.accountId);
    const unfiltered = (await f.list(first.project.id)).body.counts;
    const searches: Array<[MailFolder, string]> = [
      ['inbox', 'Enquiry 17'],
      ['inbox', 'sender4@example.net'],
      ['inbox', 'ALPHA'],
      ['sent', 'Company beta 1'],
      ['sent', 'introduction 2'],
      ['outbox', 'undeliverable'],
      ['drafts', 'Draft for Company alpha 1'],
      ['inbox', 'nothing matches this'],
    ];
    for (const [folder, query] of searches) {
      const answer = await f.list(first.project.id, folder, 1, query);
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.body.total, reference.total(folder, query), folder + ' ' + query);
      assert.deepEqual(answer.body.items, reference.page(folder, 1, query), folder + ' ' + query);
      assert.ok(answer.body.total < unfiltered[folder], 'a search narrows ' + folder);
      // The badges count the folder, not the search, so they keep standing still while typing.
      assert.deepEqual(answer.body.counts, unfiltered);
    }
    assert.equal(
      (await f.list(first.project.id, 'inbox', 1, 'nothing matches this')).body.total,
      0,
    );
    // A search is case-insensitive and reaches the linked company of an incoming reply.
    const linked = await f.list(first.project.id, 'inbox', 1, 'company ALPHA 1');
    assert.equal(linked.body.total, 1);
    assert.equal(linked.body.items[0].subject, 'Re: Support');
    // And it stays inside its own project: project 2's mail never answers project 1's search.
    assert.equal((await f.list(first.project.id, 'inbox', 1, 'for project 2')).body.total, 0);
    // Every enquiry of project 2 answers, and only project 2's — the reply is titled 'Re: Support'.
    assert.equal(
      (await f.list(second.project.id, 'inbox', 1, 'for project 2')).body.total,
      seeded - 1,
    );
  } finally {
    f.dispose();
  }
});

/**
 * Inbox and Sent are now ordered by id. That is the same order as the timestamp for mail that
 * arrives and is sent in the ordinary way, which the reference comparison above proves — but
 * not for a message the provider hands over with no usable date, which is stored at the epoch.
 * Such a message used to sink to the bottom of the inbox forever; it now sits where it
 * actually arrived, next to the poll that brought it in. This pins that deliberate choice.
 */
test('a received message with no usable date is listed where it arrived, not in 1970', async () => {
  const f = await fixture();
  try {
    const target = await f.addProject(1);
    f.setBatch(target.index, [
      incoming(1, 1),
      incoming(1, 2),
      incoming(1, 3, {
        received_at: new Date(0).toISOString(),
        subject: 'Undated arrival',
        notice: 'The original received date is unavailable. ',
      }),
    ]);
    const synced = await f.req('post', `/projects/${target.project.id}/mailbox/sync`);
    assert.equal(synced.status, 200, synced.text);
    const inbox = await f.list(target.project.id);
    assert.deepEqual(
      inbox.body.items.map((row: MailRow) => row.subject),
      ['Undated arrival', 'Enquiry 2 for project 1', 'Enquiry 1 for project 1'],
    );
    assert.equal(inbox.body.total, 3);
    assert.equal(inbox.body.counts.inbox, 3);
  } finally {
    f.dispose();
  }
});

test('a failing mailbox logs its discriminator and nothing else, and a settled conflict logs nothing', async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => void logged.push(values);
  const f = await fixture();
  try {
    const target = await f.addProject(1);
    f.setBatch(target.index, []);
    // A transport failure carries the host, the account and the password in its message.
    const failure = Object.assign(
      new Error(
        `connect ETIMEDOUT 8.8.8.8:993 for mailbox-1@example.com password ${imapSettings.password}`,
      ),
      { code: 'ETIMEDOUT' },
    );
    const failing = await fixtureWithReader(failure);
    try {
      const other = await failing.addProject(1);
      const answer = await failing.req('post', `/projects/${other.project.id}/mailbox/sync`);
      assert.equal(answer.status, 502, answer.text);
      assert.ok(!answer.text.includes(imapSettings.password));
      assert.ok(!answer.text.includes('ETIMEDOUT'));
      const reported = logged.filter((values) => String(values[0]).startsWith('[mail]'));
      assert.equal(reported.length, 1);
      assert.equal(
        reported[0][0],
        '[mail] Incoming sync failed for project ' + other.project.id + ':',
      );
      assert.equal(reported[0][1], 'ETIMEDOUT');
      const printed = logged.map((values) => values.join(' ')).join('\n');
      for (const secret of [
        imapSettings.password,
        smtpSettings.password,
        'mailbox-1@example.com',
        '8.8.8.8',
        'requirements',
      ])
        assert.ok(!printed.includes(secret), 'never logged: ' + secret);
      const stored = failing.db
        .prepare('SELECT last_error FROM project_mailboxes WHERE project_id=?')
        .get(other.project.id) as { last_error: string };
      assert.ok(stored.last_error.startsWith('Incoming connection failed.'));
      assert.ok(!stored.last_error.includes('ETIMEDOUT'));
    } finally {
      failing.dispose();
    }
    // A conflict the administrator can act on is already reported in the response and the
    // mailbox's own last_error, so it must not add noise to the server log.
    logged.length = 0;
    f.db
      .prepare('UPDATE project_mailboxes SET imap_enabled_by=? WHERE project_id=?')
      .run(9999, target.project.id);
    const conflict = await f.req('post', `/projects/${target.project.id}/mailbox/sync`);
    assert.equal(conflict.status, 409, conflict.text);
    assert.deepEqual(
      logged.filter((values) => String(values[0]).startsWith('[mail]')),
      [],
    );
  } finally {
    console.error = original;
    f.dispose();
  }
});

/** A second workspace whose poll always throws, for the failure-logging test. */
async function fixtureWithReader(error: Error) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-folders-'));
  const instance = createApp({
    dataDir: directory,
    origin: 'https://mail.example.com',
    readInbox: async () => {
      throw error;
    },
    sendMail: async () => {},
  });
  const agent = request.agent(instance.app);
  let csrf = '';
  const req = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const call = agent[method]('/api' + url)
      .set('Host', 'mail.example.com')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf);
    return body === undefined ? call : call.send(body);
  };
  const setup = await req('post', '/auth/setup', {
    name: 'Folder QA',
    username: 'folder-qa',
    password: 'Disposable-folders-QA-2026',
  });
  assert.equal(setup.status, 201, setup.text);
  csrf = setup.body.csrf_token;
  return {
    ...instance,
    req,
    async addProject(index: number) {
      const created = await req('post', '/projects', { name: 'Project ' + index });
      assert.equal(created.status, 201, created.text);
      const project = created.body as Project;
      const settings = await req('put', `/projects/${project.id}/mailbox/settings`, {
        ...imapSettings,
        username: `mailbox-${index}@example.com`,
      });
      assert.equal(settings.status, 200, settings.text);
      return { project };
    },
    dispose() {
      instance.db.close();
      disposeDirectory(directory);
    },
  };
}

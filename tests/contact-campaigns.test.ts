import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../server/app';
import { RecipientRejected, type Send } from '../server/email';
import type { ReceivedMail } from '../server/imap';
import type { Lead, Project, TrainingSnapshot } from '../shared/types';
import type { Funnel, FunnelStep } from '../shared/funnels';
import type { ContactCampaigns, ContactEnrolled } from '../shared/email';

/**
 * Campaigns for the people research found on a company's own website (lead_contacts): a
 * contact joins a campaign as its own recipient, under every rule the primary contact is held
 * to, and never becomes the primary contact by accident.
 */
delete process.env.INNOVISTA_SETUP_TOKEN;
const day = 86_400_000;
/** Every step names the person, so a message addressed with the wrong details shows at once. */
const personal: FunnelStep[] = [
  {
    delay_days: 0,
    subject: 'For {{contact_name}} at {{company}}',
    body: 'Hello {{contact_first_name}}, as {{contact_role}} you may want to see this. Regards, {{sender_name}}.',
  },
  {
    delay_days: 3,
    subject: 'Following up, {{contact_first_name}}',
    body: 'Following up on my note to you as {{contact_role}}. Would a short call help?',
  },
  {
    delay_days: 7,
    subject: 'A last note',
    body: 'This is my final follow-up. Reply whenever it suits you.',
  },
];
interface EnrollmentRow {
  id: number;
  funnel_id: number;
  lead_id: number;
  contact_id: number | null;
  recipient: string;
  status: string;
  stop_cause: string;
  reason: string;
  next_step: number;
  next_send_at: number;
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-contact-campaigns-'));
  const messages: Parameters<Send>[1][] = [];
  /** Addresses the receiving server refuses permanently. */
  const rejected = new Set<string>();
  /** Runs as a message is handed to the transport, before its last check. */
  let beforeDeliver: (() => void) | null = null;
  let inbox: ReceivedMail[] = [];
  let uid = 0;
  const options: Parameters<typeof createApp>[0] = {
    dataDir: dir,
    origin: 'https://research.example.com',
    sendMail: async (_config, message) => {
      beforeDeliver?.();
      message.beforeSend?.();
      if (rejected.has(message.to)) throw new RecipientRejected(message.to, 550);
      messages.push(message);
    },
    readInbox: async () => {
      const batch = inbox;
      inbox = [];
      return { uid_validity: '1', last_uid: uid, messages: batch };
    },
    generate: async (_config, _system, input) => {
      const snapshot = (input as { approved_training: TrainingSnapshot }).approved_training;
      if (!snapshot) return {};
      return {
        decision: 'QUALIFIED',
        score: 90,
        confidence: 95,
        summary: 'The company manufactures pumps and buys third-party bearings.',
        criteria: snapshot.rubric.criteria.map((criterion) => ({
          criterion,
          outcome: 'MATCH',
          evidence: 'The official website states it manufactures industrial pumps.',
          source_ids: ['E2'],
        })),
        exclusions: snapshot.rubric.exclusions.map((criterion) => ({
          criterion,
          outcome: 'NO_MATCH',
          evidence: 'The official website states it buys third-party bearings.',
          source_ids: ['E2'],
        })),
        gaps: [],
        next_steps: ['Ask about pump requirements.'],
      };
    },
    fetchWebsite: async (url) => ({
      url,
      content:
        'The company manufactures industrial pumps with its own engineers. It buys third-party bearings and does not manufacture bearings.',
      truncated: false,
    }),
  };
  let instance = createApp(options);
  let agent = request.agent(instance.app);
  let csrf = '';
  const host = 'research.example.com';
  const req = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const call = agent[method]('/api' + url)
      .set('Host', host)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf);
    return body === undefined ? call : call.send(body);
  };
  const setup = await req('post', '/auth/setup', {
    name: 'QA Administrator',
    username: 'qa-admin',
    password: 'Disposable-contact-test-2026',
  });
  assert.equal(setup.status, 201, setup.text);
  csrf = setup.body.csrf_token;
  const created = (await req('post', '/projects', { name: 'QA Pumps', website: 'https://example.org' }))
    .body as Project;
  const source = await req('post', `/projects/${created.id}/sources`, {
    revision: created.revision,
    title: 'Training brief',
    content:
      'Find industrial pump manufacturers and their purchasing managers. Exclude companies manufacturing bearings.',
  });
  assert.equal(source.status, 201, source.text);
  const afterNote = (await req('get', `/projects/${created.id}`)).body.project as Project;
  const website = await req('post', `/projects/${created.id}/sources/website`, {
    revision: afterNote.revision,
    url: 'https://example.org',
  });
  assert.equal(website.status, 201, website.text);
  const current = (await req('get', `/projects/${created.id}`)).body.project as Project;
  const rubric = await req('put', `/projects/${created.id}/training/rubric`, {
    revision: current.revision,
    rubric: {
      summary: 'Find industrial pump manufacturers and their purchasing managers.',
      criteria: ['Manufactures industrial pumps'],
      exclusions: ['Manufactures bearings'],
      questions: [],
    },
  });
  assert.equal(rubric.status, 200, rubric.text);
  const published = await req('post', `/projects/${created.id}/training/publish`, {
    revision: rubric.body.revision,
  });
  assert.equal(published.status, 200, published.text);
  const project = published.body as Project;
  const base = `/projects/${project.id}`;
  const mailbox = await req('put', `${base}/mailbox/email`, {
    host: '8.8.8.8',
    port: 587,
    username: 'research@example.com',
    password: 'fake-mail-password',
    from_email: 'research@example.com',
    from_name: 'Research Team',
    copy_to: 'owner@example.com',
  });
  assert.equal(mailbox.status, 200, mailbox.text);
  let leads = 0;
  return {
    req,
    messages,
    rejected,
    base,
    host,
    project,
    get db() {
      return instance.db;
    },
    get app() {
      return instance.app;
    },
    get worker() {
      return instance.funnels;
    },
    set beforeDeliver(hook: (() => void) | null) {
      beforeDeliver = hook;
    },
    /** A qualified lead whose primary contact is someone other than the people below. */
    async lead(email: string, extra: Partial<Lead> = {}, target = base) {
      const added = await req('post', `${target}/leads`, {
        name: 'Pump Company ' + ++leads,
        website: `https://pumps${leads}.example`,
        contact_email: email,
        contact_name: 'Pat Primary',
        contact_role: 'Owner',
        ...extra,
      });
      assert.equal(added.status, 201, added.text);
      if (target === base) {
        const qualified = await req('post', `${target}/leads/${added.body.id}/qualify`, {});
        assert.equal(qualified.status, 200, qualified.text);
      }
      return (await req('get', `${target}/leads/${added.body.id}`)).body as Lead;
    },
    /** A person as research stores one: quoted from the company's own site. */
    contact(lead: Lead, name: string, role: string, email = '') {
      return Number(
        instance.db
          .prepare(
            `INSERT INTO lead_contacts
            (project_id,lead_id,name,name_key,role,role_category,email,phone,source_url,evidence,created_at,created_by)
            VALUES (?,?,?,?,?,'purchasing',?,'',?,?,?,'QA')`,
          )
          .run(
            lead.project_id,
            lead.id,
            name,
            name.toLowerCase(),
            role,
            email,
            lead.website + '/team',
            'Contact ' + name + ', ' + role + (email ? ', at ' + email : '') + '.',
            new Date().toISOString(),
          ).lastInsertRowid,
      );
    },
    async funnel(steps = personal, stop_on_reply = true) {
      const result = await req('post', `${base}/funnels`, {
        name: 'Purchasing introduction',
        audience: 'Purchasing teams',
        stop_on_reply,
        steps,
      });
      assert.equal(result.status, 201, result.text);
      return result.body as Funnel;
    },
    async activate(funnel: Funnel) {
      const latest = ((await req('get', `${base}/funnels`)).body.funnels as Funnel[]).find(
        (f) => f.id === funnel.id,
      )!;
      const result = await req('patch', `${base}/funnels/${funnel.id}`, {
        status: 'ACTIVE',
        revision: latest.revision,
      });
      assert.equal(result.status, 200, result.text);
    },
    add(funnel: Funnel, lead: Lead, contactId: number) {
      return req('post', `${base}/funnels/${funnel.id}/enrollments`, {
        lead_ids: [lead.id],
        contact_id: contactId,
      });
    },
    options(lead: Lead, contactId: number) {
      return req('get', `${base}/leads/${lead.id}/contacts/${contactId}/campaigns`);
    },
    rows(leadId: number) {
      return instance.db
        .prepare('SELECT * FROM funnel_enrollments WHERE lead_id=? ORDER BY id')
        .all(leadId) as EnrollmentRow[];
    },
    row(leadId: number, contactId: number) {
      return instance.db
        .prepare('SELECT * FROM funnel_enrollments WHERE lead_id=? AND contact_id=?')
        .get(leadId, contactId) as EnrollmentRow;
    },
    async incoming() {
      const result = await req('put', `${base}/mailbox/settings`, {
        revision: 0,
        host: '8.8.8.8',
        username: 'inbox@example.com',
        folder: 'INBOX',
        password: 'fake-incoming-password',
        enabled: true,
      });
      assert.equal(result.status, 200, result.text);
    },
    /** A reply as the project's own inbox receives it, quoting the message it answers. */
    reply(from: string, messageId: string) {
      uid++;
      inbox.push({
        uid,
        message_id: `<reply-${uid}@pumps.example>`,
        references: [messageId],
        from_email: from,
        from_name: '',
        to_email: 'research@example.com',
        subject: 'Re: your note',
        body: 'Thanks, we would like to talk.',
        received_at: new Date().toISOString(),
        attachment_count: 0,
        notice: '',
      });
      return req('post', `${base}/mailbox/sync`);
    },
    /** Reopens the same data directory, as a restart or an upgrade does. */
    async restart(between?: (file: string) => void) {
      instance.db.close();
      between?.(path.join(dir, 'innovista.db'));
      instance = createApp(options);
      agent = request.agent(instance.app);
      const login = await req('post', '/auth/login', {
        username: 'qa-admin',
        password: 'Disposable-contact-test-2026',
      });
      assert.equal(login.status, 200, login.text);
      csrf = login.body.csrf_token;
    },
    dispose() {
      instance.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a researched contact joins a running campaign and is mailed with their own merge fields', async () => {
  const f = await fixture();
  try {
    const lead = await f.lead('pat@pumps.example', {
      contact_name: 'Pat Primary',
      contact_role: 'Owner',
    });
    const rana = f.contact(lead, 'Rana Buyer', 'Purchasing Manager', 'Rana@Pumps.example');
    const funnel = await f.funnel();
    // Only a running campaign is offered, so the schedule the person is shown is real.
    const draft = (await f.options(lead, rana)).body as ContactCampaigns;
    assert.equal(draft.contact.name, 'Rana Buyer');
    assert.match(draft.campaigns[0].blocked, /not running/);
    assert.equal((await f.add(funnel, lead, rana)).status, 409);
    await f.activate(funnel);
    const offered = (await f.options(lead, rana)).body as ContactCampaigns;
    assert.equal(offered.campaigns[0].blocked, '');
    const added = await f.add(funnel, lead, rana);
    assert.equal(added.status, 201, added.text);
    const joined = added.body as ContactEnrolled;
    assert.equal(joined.funnel_name, funnel.name);
    assert.equal(joined.schedule.length, 3);
    assert.ok(Date.parse(joined.schedule[1]) - Date.parse(joined.schedule[0]) >= 3 * day - 1000);
    const [row] = f.rows(lead.id);
    assert.equal(row.contact_id, rana);
    assert.equal(row.recipient, 'rana@pumps.example');
    // The lead page lists the sequence with the person it belongs to.
    const page = (await f.req('get', `${f.base}/leads/${lead.id}`)).body as Lead;
    assert.equal(page.campaigns?.[0].contact_id, rana);
    // Counted, not named, in the audit trail.
    const audit = f.db
      .prepare("SELECT detail FROM audit_events WHERE action='funnel.enrolled'")
      .all() as Array<{ detail: string }>;
    assert.equal(audit.length, 1);
    assert.doesNotMatch(audit[0].detail, /Rana/);

    await f.worker.tick(Date.now() + 100);
    assert.equal(f.messages.length, 1);
    const [first] = f.messages;
    assert.equal(first.to, 'rana@pumps.example');
    assert.equal(first.subject, 'For Rana Buyer at ' + lead.name);
    assert.match(first.text, /Hello Rana, as Purchasing Manager you may want/);
    assert.doesNotMatch(first.subject + first.text, /Pat|Owner/);
    // Logged on the company, to the person it went to.
    assert.deepEqual(f.db.prepare('SELECT lead_id,to_email FROM email_messages').get(), {
      lead_id: lead.id,
      to_email: 'rana@pumps.example',
    });
    // The follow-up is merged for the same person.
    await f.worker.tick(f.row(lead.id, rana).next_send_at);
    assert.equal(f.messages.length, 2);
    assert.equal(f.messages[1].to, 'rana@pumps.example');
    assert.equal(f.messages[1].subject, 'Following up, Rana');
    assert.match(f.messages[1].text, /to you as Purchasing Manager/);

    // A person whose role was never published cannot be merged: the primary contact's role is
    // never used in its place.
    const sam = f.contact(lead, 'Sam Unnamed', '', 'sam@pumps.example');
    const missing = await f.add(funnel, lead, sam);
    assert.equal(missing.status, 409);
    assert.match(missing.body.error, /contact_role/);
    assert.equal(f.row(lead.id, sam), undefined);
  } finally {
    f.dispose();
  }
});

test('a contact from another lead or project, or without an email address, is refused', async () => {
  const f = await fixture();
  try {
    const lead = await f.lead('a@pumps.example');
    const other = await f.lead('b@pumps.example');
    const theirs = f.contact(other, 'Olga Other', 'Buyer', 'olga@pumps.example');
    const silent = f.contact(lead, 'Nia Noemail', 'Marketing Assistant');
    const funnel = await f.funnel();
    await f.activate(funnel);
    // Another lead's person, under this lead.
    assert.equal((await f.add(funnel, lead, theirs)).status, 404);
    assert.equal((await f.options(lead, theirs)).status, 404);
    // Another project's lead and person.
    const elsewhere = (await f.req('post', '/projects', { name: 'Other project' })).body as Project;
    const foreign = await f.lead('c@pumps.example', {}, `/projects/${elsewhere.id}`);
    const stranger = f.contact(foreign, 'Stan Stranger', 'Buyer', 'stan@pumps.example');
    assert.equal((await f.add(funnel, foreign, stranger)).status, 404);
    assert.equal(
      (
        await f.req('get', `${f.base}/leads/${foreign.id}/contacts/${stranger}/campaigns`)
      ).status,
      404,
    );
    assert.equal(
      (
        await f.req('post', `/projects/${elsewhere.id}/funnels/${funnel.id}/enrollments`, {
          lead_ids: [foreign.id],
          contact_id: stranger,
        })
      ).status,
      404,
    );
    // Research found no address for this person, and none is ever guessed.
    const unreachable = await f.add(funnel, lead, silent);
    assert.equal(unreachable.status, 409);
    assert.match(unreachable.body.error, /no published email address/);
    assert.match(((await f.options(lead, silent)).body as ContactCampaigns).campaigns[0].blocked, /no published email/);
    // One person at a time.
    assert.equal(
      (
        await f.req('post', `${f.base}/funnels/${funnel.id}/enrollments`, {
          lead_ids: [lead.id, other.id],
          contact_id: silent,
        })
      ).status,
      400,
    );
    assert.deepEqual(f.db.prepare('SELECT count(*) n FROM funnel_enrollments').get(), { n: 0 });
  } finally {
    f.dispose();
  }
});

test('suppression, bounces and the three-email limit apply to each contact’s own address', async () => {
  const f = await fixture();
  try {
    const lead = await f.lead('primary@pumps.example');
    const ann = f.contact(lead, 'Ann Buyer', 'Buyer', 'ann@pumps.example');
    const ben = f.contact(lead, 'Ben Buyer', 'Purchasing Assistant', 'ben@pumps.example');
    const cy = f.contact(lead, 'Cy Buyer', 'Procurement Lead', 'cy@pumps.example');
    const gone = f.contact(lead, 'Gil Gone', 'Buyer', 'gone@pumps.example');
    const funnel = await f.funnel();
    await f.activate(funnel);
    // Ann opted out earlier, anywhere in the workspace: her address stays closed.
    f.db
      .prepare('INSERT INTO email_suppressions VALUES (?,?,?)')
      .run('ann@pumps.example', 'Recipient requested unsubscribe.', new Date().toISOString());
    const optedOut = await f.add(funnel, lead, ann);
    assert.equal(optedOut.status, 409);
    assert.match(optedOut.body.error, /opted out/);
    // Ben has already had three emails, from any project.
    for (let i = 0; i < 3; i++)
      f.db
        .prepare(
          "INSERT INTO email_deliveries (delivery_key,project_id,lead_id,recipient,status,started_at) VALUES (?,?,?,?,'SENT',?)",
        )
        .run('qa:' + i, lead.project_id, lead.id, 'ben@pumps.example', Date.now());
    const limited = await f.add(funnel, lead, ben);
    assert.equal(limited.status, 409);
    assert.match(limited.body.error, /three-email limit/);
    // The limits belong to those addresses, not to the company.
    assert.equal((await f.add(funnel, lead, cy)).status, 201);
    assert.equal((await f.add(funnel, lead, gone)).status, 201);
    const primary = await f.req('post', `${f.base}/funnels/${funnel.id}/enrollments`, {
      lead_ids: [lead.id],
    });
    assert.equal(primary.body.enrolled, 1, primary.text);

    // Gil's address bounces. That is one dead address: the company's other sequences go on.
    f.rejected.add('gone@pumps.example');
    const time = Date.now() + 100;
    for (let i = 0; i < 3; i++) await f.worker.tick(time + i * 60_000);
    assert.deepEqual(f.messages.map((m) => m.to).sort(), ['cy@pumps.example', 'primary@pumps.example']);
    assert.equal(f.row(lead.id, gone).status, 'STOPPED');
    assert.equal(f.row(lead.id, gone).stop_cause, 'BOUNCED');
    assert.equal(f.row(lead.id, cy).status, 'QUEUED');
    const primaryRow = () => f.rows(lead.id).find((row) => row.contact_id === null)!;
    assert.equal(primaryRow().status, 'QUEUED');
    // The lead's own address did not bounce, so the lead is not marked bounced.
    const afterBounce = (await f.req('get', `${f.base}/leads/${lead.id}`)).body as Lead;
    assert.notEqual(afterBounce.outreach_status, 'BOUNCED');

    // Cy opts out from the link in the message. That is an answer from the company: Cy's
    // address is suppressed, and the primary contact's sequence stops without Pat's address
    // being treated as opted out.
    const link = new URL(f.messages.find((m) => m.to === 'cy@pumps.example')!.unsubscribeUrl!);
    assert.equal((await request(f.app).post(link.pathname).set('Host', f.host)).status, 200);
    assert.equal(f.row(lead.id, cy).status, 'UNSUBSCRIBED');
    assert.equal(primaryRow().status, 'STOPPED');
    assert.equal(primaryRow().stop_cause, 'OPTED_OUT');
    assert.equal(
      f.db.prepare("SELECT 1 FROM email_suppressions WHERE recipient='primary@pumps.example'").get(),
      undefined,
    );
    const sent = f.messages.length;
    await f.worker.tick(time + 30 * day);
    await f.worker.tick(time + 30 * day + 60_000);
    assert.equal(f.messages.length, sent);
  } finally {
    f.dispose();
  }
});

test('erasing a contact stops their sequence, and delivery never falls back to the primary contact', async () => {
  const f = await fixture();
  try {
    const lead = await f.lead('primary@pumps.example', {
      contact_name: 'Pat Primary',
      contact_role: 'Owner',
    });
    const ann = f.contact(lead, 'Ann Buyer', 'Buyer', 'ann@pumps.example');
    const ben = f.contact(lead, 'Ben Buyer', 'Purchasing Assistant', 'ben@pumps.example');
    const cy = f.contact(lead, 'Cy Buyer', 'Procurement Lead', 'cy@pumps.example');
    const dee = f.contact(lead, 'Dee Buyer', 'Purchaser', 'dee@pumps.example');
    const eve = f.contact(lead, 'Eve Buyer', 'Buyer', 'eve@pumps.example');
    const funnel = await f.funnel();
    await f.activate(funnel);
    const leadUrl = `${f.base}/leads/${lead.id}`;

    // Erased before anything was sent: stopped in the same request, and the enrollment no
    // longer holds the address, because nothing in the email log does either.
    assert.equal((await f.add(funnel, lead, ann)).status, 201);
    assert.equal((await f.req('delete', `${leadUrl}/contacts/${ann}`)).status, 200);
    assert.equal(f.row(lead.id, ann).status, 'STOPPED');
    assert.equal(f.row(lead.id, ann).stop_cause, 'CONTACT_ERASED');
    assert.match(f.row(lead.id, ann).recipient, /^erased contact \d+$/);
    assert.deepEqual(
      f.db.prepare("SELECT count(*) n FROM funnel_enrollments WHERE recipient LIKE 'ann@%'").get(),
      { n: 0 },
    );

    // Erased after message 1 went out: the sequence stops; the address stays, as it does in
    // the email log of what was sent.
    assert.equal((await f.add(funnel, lead, ben)).status, 201);
    await f.worker.tick(Date.now() + 100);
    assert.equal(f.messages.at(-1)?.to, 'ben@pumps.example');
    assert.equal((await f.req('delete', `${leadUrl}/contacts/${ben}`)).status, 200);
    assert.equal(f.row(lead.id, ben).status, 'STOPPED');
    assert.equal(f.row(lead.id, ben).recipient, 'ben@pumps.example');

    // The person disappears without their sequence being stopped (the backstop): delivery
    // checks the contact row itself, stops, and mails nobody in their place.
    assert.equal((await f.add(funnel, lead, cy)).status, 201);
    f.db.prepare('DELETE FROM lead_contacts WHERE id=?').run(cy);
    await f.worker.tick(Date.now() + 2 * 60_000);
    assert.equal(f.row(lead.id, cy).status, 'STOPPED');
    assert.equal(f.row(lead.id, cy).stop_cause, 'CONTACT_ERASED');
    assert.match(f.row(lead.id, cy).reason, /never sent to anyone else/);

    // Erased at the very moment the message is handed over: the last check stops it too.
    assert.equal((await f.add(funnel, lead, dee)).status, 201);
    f.beforeDeliver = () => f.db.prepare('DELETE FROM lead_contacts WHERE id=?').run(dee);
    await f.worker.tick(Date.now() + 4 * 60_000);
    f.beforeDeliver = null;
    assert.equal(f.row(lead.id, dee).status, 'STOPPED');
    assert.equal(f.row(lead.id, dee).stop_cause, 'CONTACT_ERASED');

    // Erasing everyone stops what was queued for each of them.
    assert.equal((await f.add(funnel, lead, eve)).status, 201);
    assert.equal((await f.req('delete', `${leadUrl}/contacts`)).status, 200);
    assert.equal(f.row(lead.id, eve).status, 'STOPPED');
    assert.equal(f.row(lead.id, eve).stop_cause, 'CONTACT_ERASED');

    for (let i = 0; i < 4; i++) await f.worker.tick(Date.now() + 30 * day + i * 60_000);
    assert.deepEqual(
      f.messages.map((m) => m.to),
      ['ben@pumps.example'],
      'only the message that went before erasure was ever sent',
    );
    assert.ok(!f.messages.some((m) => /Pat|Owner/.test(m.subject + m.text)));
    const audit = f.db.prepare('SELECT detail FROM audit_events').all() as Array<{ detail: string }>;
    assert.ok(!audit.some((row) => /Ann|Ben|Cy |Dee|Eve/.test(row.detail)));
  } finally {
    f.dispose();
  }
});

test('two contacts of one lead, and its primary contact, can be in the same campaign', async () => {
  const f = await fixture();
  try {
    const lead = await f.lead('primary@pumps.example', {
      contact_name: 'Pat Primary',
      contact_role: 'Owner',
    });
    const ann = f.contact(lead, 'Ann Buyer', 'Buyer', 'ann@pumps.example');
    const ben = f.contact(lead, 'Ben Buyer', 'Purchasing Assistant', 'ben@pumps.example');
    // Published on the site with the primary contact's own address: the same recipient.
    const twin = f.contact(lead, 'Pat Twin', 'Owner', 'Primary@pumps.example');
    const funnel = await f.funnel();
    await f.activate(funnel);
    assert.equal((await f.add(funnel, lead, ann)).status, 201);
    assert.equal((await f.add(funnel, lead, ben)).status, 201);
    const primary = await f.req('post', `${f.base}/funnels/${funnel.id}/enrollments`, {
      lead_ids: [lead.id],
    });
    assert.equal(primary.body.enrolled, 1, primary.text);
    const rows = f.rows(lead.id);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.funnel_id === funnel.id));
    assert.deepEqual(rows.map((row) => row.recipient).sort(), [
      'ann@pumps.example',
      'ben@pumps.example',
      'primary@pumps.example',
    ]);
    // Once per person per campaign, whichever way they are reached.
    const again = await f.add(funnel, lead, ann);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already been in this campaign/);
    assert.match((await f.add(funnel, lead, twin)).body.error, /already been in this campaign/);
    const repeat = await f.req('post', `${f.base}/funnels/${funnel.id}/enrollments`, {
      lead_ids: [lead.id],
    });
    assert.equal(repeat.body.skipped, 1);
    // The database holds the same line.
    assert.throws(() =>
      f.db
        .prepare(
          `INSERT INTO funnel_enrollments (project_id,funnel_id,lead_id,recipient,lead_revision,training_version,account_id,created_by,next_send_at,created_at,updated_at)
          VALUES (?,?,?,'ann@pumps.example',1,1,1,'QA',0,'','')`,
        )
        .run(lead.project_id, funnel.id, lead.id),
    );
    const time = Date.now() + 100;
    for (let i = 0; i < 3; i++) await f.worker.tick(time + i * 60_000);
    assert.deepEqual(
      f.messages.map((m) => [m.to, m.subject]).sort(),
      [
        ['ann@pumps.example', 'For Ann Buyer at ' + lead.name],
        ['ben@pumps.example', 'For Ben Buyer at ' + lead.name],
        ['primary@pumps.example', 'For Pat Primary at ' + lead.name],
      ],
    );
  } finally {
    f.dispose();
  }
});

test('a reply from one person stops the company’s other sequences when stop-on-reply is on', async () => {
  const f = await fixture();
  try {
    await f.incoming();
    const lead = await f.lead('primary@pumps.example');
    const ann = f.contact(lead, 'Ann Buyer', 'Buyer', 'ann@pumps.example');
    const ben = f.contact(lead, 'Ben Buyer', 'Purchasing Assistant', 'ben@pumps.example');
    const cy = f.contact(lead, 'Cy Buyer', 'Procurement Lead', 'cy@pumps.example');
    const stopping = await f.funnel(personal, true);
    const continuing = await f.funnel(personal, false);
    await f.activate(stopping);
    await f.activate(continuing);
    assert.equal((await f.add(stopping, lead, ann)).status, 201);
    assert.equal((await f.add(stopping, lead, ben)).status, 201);
    assert.equal((await f.add(continuing, lead, cy)).status, 201);
    const time = Date.now() + 100;
    for (let i = 0; i < 3; i++) await f.worker.tick(time + i * 60_000);
    assert.equal(f.messages.length, 3);
    const toAnn = f.messages.find((m) => m.to === 'ann@pumps.example')!;
    const synced = await f.reply('ann@pumps.example', toAnn.messageId!);
    assert.equal(synced.status, 200, synced.text);
    assert.equal(synced.body.received, 1);
    assert.equal(f.row(lead.id, ann).status, 'REPLIED');
    // Ben never replied, but someone at his company did.
    assert.equal(f.row(lead.id, ben).status, 'STOPPED');
    assert.equal(f.row(lead.id, ben).stop_cause, 'REPLIED');
    assert.match(f.row(lead.id, ben).reason, /Someone at this company replied/);
    // A campaign whose author turned stop-on-reply off keeps going, as it would for the lead.
    assert.equal(f.row(lead.id, cy).status, 'QUEUED');
    // Nor can anyone else at the company be started on a campaign after the reply.
    const late = f.contact(lead, 'Dee Buyer', 'Purchaser', 'dee@pumps.example');
    assert.match((await f.add(stopping, lead, late)).body.error, /response or stop recorded/);

    const before = f.messages.length;
    for (let i = 0; i < 3; i++) await f.worker.tick(time + 30 * day + i * 60_000);
    const later = f.messages.slice(before).map((m) => m.to);
    assert.ok(later.length >= 1);
    assert.ok(later.every((to) => to === 'cy@pumps.example'));
  } finally {
    f.dispose();
  }
});

test('the enrollment key migration keeps every row and its id, and runs once', async () => {
  const f = await fixture();
  try {
    const leads = [await f.lead('a@pumps.example'), await f.lead('b@pumps.example')];
    const extra = await f.lead('c@pumps.example');
    const funnel = await f.funnel();
    for (const lead of [...leads, extra]) {
      const result = await f.req('post', `${f.base}/funnels/${funnel.id}/enrollments`, {
        lead_ids: [lead.id],
      });
      assert.equal(result.body.enrolled, 1, result.text);
    }
    f.db
      .prepare("UPDATE funnel_enrollments SET status='COMPLETED',next_step=3,schedule_json='[1,2]' WHERE lead_id=?")
      .run(leads[0].id);
    // The newest enrollment is removed, as deleting a lead does: its id must never be reused.
    const highest = (f.db.prepare('SELECT max(id) id FROM funnel_enrollments').get() as { id: number })
      .id;
    f.db.prepare('DELETE FROM funnel_enrollments WHERE id=?').run(highest);
    const snapshot = () =>
      f.db
        .prepare(
          'SELECT id,project_id,funnel_id,lead_id,recipient,status,next_step,next_send_at,schedule_json,stop_cause,created_at FROM funnel_enrollments ORDER BY id',
        )
        .all();
    const before = snapshot();
    assert.equal(before.length, 2);

    // Put the table back the way an installation from before this change has it.
    await f.restart((file) => {
      const raw = new Database(file);
      raw.pragma('foreign_keys = OFF');
      raw.transaction(() => {
        raw.exec('ALTER TABLE funnel_enrollments RENAME TO funnel_enrollments_current');
        raw.exec(`CREATE TABLE funnel_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
      funnel_id INTEGER NOT NULL REFERENCES funnels(id), lead_id INTEGER NOT NULL REFERENCES leads(id),
      recipient TEXT NOT NULL, lead_revision INTEGER NOT NULL, training_version INTEGER NOT NULL,
      account_id INTEGER NOT NULL REFERENCES accounts(id), created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK(status IN ('QUEUED','SENDING','COMPLETED','STOPPED','REPLIED','INTERESTED','CONVERTED','UNSUBSCRIBED','BLOCKED')),
      next_step INTEGER NOT NULL DEFAULT 0, next_send_at INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(funnel_id,lead_id)
    )`);
        raw.exec("ALTER TABLE funnel_enrollments ADD COLUMN schedule_json TEXT NOT NULL DEFAULT ''");
        raw.exec("ALTER TABLE funnel_enrollments ADD COLUMN stop_cause TEXT NOT NULL DEFAULT ''");
        raw.exec(`INSERT INTO funnel_enrollments
          (id,project_id,funnel_id,lead_id,recipient,lead_revision,training_version,account_id,created_by,status,next_step,next_send_at,reason,created_at,updated_at,schedule_json,stop_cause)
          SELECT id,project_id,funnel_id,lead_id,recipient,lead_revision,training_version,account_id,created_by,status,next_step,next_send_at,reason,created_at,updated_at,schedule_json,stop_cause
          FROM funnel_enrollments_current`);
        raw.exec('DROP TABLE funnel_enrollments_current');
        raw.exec(`CREATE INDEX enrollments_due ON funnel_enrollments(status,next_send_at);
          CREATE INDEX enrollments_project ON funnel_enrollments(project_id,funnel_id);
          CREATE UNIQUE INDEX one_active_funnel_per_recipient
            ON funnel_enrollments(recipient) WHERE status IN ('QUEUED','SENDING');
          CREATE INDEX enrollments_project_status ON funnel_enrollments(project_id,status);`);
        raw.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='funnel_enrollments'").run(highest);
      })();
      assert.match(
        (raw.prepare("SELECT sql FROM sqlite_master WHERE name='funnel_enrollments'").get() as {
          sql: string;
        }).sql,
        /UNIQUE\(funnel_id,lead_id\)/,
      );
      raw.close();
    });

    const table = () =>
      f.db
        .prepare("SELECT sql,rootpage FROM sqlite_master WHERE type='table' AND name='funnel_enrollments'")
        .get() as { sql: string; rootpage: number };
    const migrated = table();
    assert.match(migrated.sql, /UNIQUE\(funnel_id,lead_id,recipient\)/);
    assert.doesNotMatch(migrated.sql, /UNIQUE\(funnel_id,lead_id\)/);
    assert.deepEqual(snapshot(), before);
    assert.ok(
      (f.db.prepare('SELECT contact_id FROM funnel_enrollments').all() as Array<{
        contact_id: number | null;
      }>).every((row) => row.contact_id === null),
    );
    const indexes = (
      f.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='funnel_enrollments' AND sql IS NOT NULL")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const name of [
      'enrollments_due',
      'enrollments_project',
      'one_active_funnel_per_recipient',
      'enrollments_project_status',
      'enrollments_contact',
    ])
      assert.ok(indexes.includes(name), name);
    assert.deepEqual(f.db.pragma('foreign_key_check(funnel_enrollments)'), []);
    assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);

    // The next enrollment gets a new id, never the removed one's.
    const person = f.contact(leads[1], 'Ann Buyer', 'Buyer', 'ann@pumps.example');
    await f.activate(funnel);
    assert.equal((await f.add(funnel, leads[1], person)).status, 201);
    assert.ok(f.row(leads[1].id, person).id > highest);

    // Opening the database again changes nothing: the rebuild has already happened.
    await f.restart();
    const again = table();
    assert.equal(again.rootpage, migrated.rootpage);
    assert.equal(again.sql, migrated.sql);
    assert.equal(
      (f.db.prepare('SELECT count(*) n FROM funnel_enrollments').get() as { n: number }).n,
      3,
    );
  } finally {
    f.dispose();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { RecipientRejected, sendMail, type Send, type SmtpConfig } from '../server/email';
import { scheduleNextSend } from '../server/funnels';
import { emailTemplates } from '../server/email-templates';
import type { ReadInbox, ReceivedMail } from '../server/imap';
import { recordBounce } from '../server/bounces';
import { hash } from '../server/database';
import { withOpenPixel } from '../server/funnel-opens';
import nodemailer from 'nodemailer';
import type { Lead, Project, TrainingSnapshot } from '../shared/types';
import type { Enrollment, Funnel, FunnelCounts, FunnelStep } from '../shared/funnels';
import { emptyCounts, funnelCompleted } from '../shared/funnels';
import {
  activeFunnelFilterCount,
  emptyFunnelFilters,
  filterFunnels,
  funnelAudiences,
} from '../shared/funnel-filters';

delete process.env.INNOVISTA_SETUP_TOKEN;
const day = 86_400_000;
const steps: FunnelStep[] = [
  {
    delay_days: 0,
    subject: 'Hello {{company}}',
    body: 'Hello, could our services help {{company}}? Best regards, {{sender_name}}.',
  },
  {
    delay_days: 3,
    subject: 'Following up',
    body: 'Following up on our introduction. Would a conversation be useful?',
  },
  {
    delay_days: 7,
    subject: 'Final introduction',
    body: 'This is our final follow-up. Please reply if a conversation would be useful.',
  },
];

async function fixture(
  origin = 'https://research.example.com',
  transport?: Send,
  reader?: ReadInbox,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-funnels-'));
  const messages: Parameters<Send>[1][] = [];
  /** The mailbox each message actually left through, recorded alongside the message itself. */
  const senders: SmtpConfig[] = [];
  const options: Parameters<typeof createApp>[0] = {
    dataDir: dir,
    origin,
    readInbox: reader,
    sendMail:
      transport ||
      (async (config, message) => {
        message.beforeSend?.();
        senders.push(config);
        messages.push(message);
      }),
    generate: async (_config, _system, input) => {
      const snapshot = (input as { approved_training: TrainingSnapshot }).approved_training;
      // The research pass that runs before qualification: nothing to find here.
      if (!snapshot) return {};
      return {
        decision: 'QUALIFIED',
        score: 100,
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
        'The company manufactures industrial pumps with its own engineers. It buys third-party bearings and does not manufacture bearings. Published contact: contact@pumps.example.',
      truncated: false,
    }),
  };
  let instance = createApp(options);
  let agent = request.agent(instance.app);
  let csrf = '';
  const host = origin ? new URL(origin).host : '127.0.0.1';
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
    password: 'Disposable-funnel-test-2026',
  });
  assert.equal(setup.status, 201, setup.text);
  csrf = setup.body.csrf_token;
  /** A project trained and published far enough to enroll leads, since a mailbox is per project. */
  async function prepare(name: string) {
    const p = (await req('post', '/projects', { name, website: 'https://example.org' }))
      .body as Project;
    const source = await req('post', `/projects/${p.id}/sources`, {
      revision: p.revision,
      title: 'Training brief',
      content:
        'Find industrial pump manufacturers with engineering teams. Exclude companies manufacturing bearings.',
    });
    assert.equal(source.status, 201, source.text);
    const afterNote = (await req('get', `/projects/${p.id}`)).body.project as Project;
    const website = await req('post', `/projects/${p.id}/sources/website`, {
      revision: afterNote.revision,
      url: 'https://example.org',
    });
    assert.equal(website.status, 201, website.text);
    const current = (await req('get', `/projects/${p.id}`)).body.project as Project;
    const rubric = await req('put', `/projects/${p.id}/training/rubric`, {
      revision: current.revision,
      rubric: {
        summary: 'Find industrial pump manufacturers with their own engineering teams.',
        criteria: ['Manufactures industrial pumps'],
        exclusions: ['Manufactures bearings'],
        questions: [],
      },
    });
    assert.equal(rubric.status, 200, rubric.text);
    const published = await req('post', `/projects/${p.id}/training/publish`, {
      revision: rubric.body.revision,
    });
    assert.equal(published.status, 200, published.text);
    return published.body as Project;
  }
  const project = await prepare('QA Pump Research');
  const base = `/projects/${project.id}`;
  let leadCounter = 0;
  return {
    req,
    messages,
    senders,
    base,
    host,
    get db() {
      return instance.db;
    },
    get app() {
      return instance.app;
    },
    get worker() {
      return instance.funnels;
    },
    get csrf() {
      return csrf;
    },
    project,
    prepare,
    /** Each project sends from its own mailbox, so this is saved per project. */
    async mailbox(copy = 'owner@example.com', target = project, values: object = {}) {
      const result = await req('put', `/projects/${target.id}/mailbox/email`, {
        host: '8.8.8.8',
        port: 587,
        username: 'research@example.com',
        password: 'fake-mail-password',
        from_email: 'research@example.com',
        from_name: 'Research Team',
        signature: 'Research Team signature',
        copy_to: copy,
        ...values,
      });
      assert.equal(result.status, 200, result.text);
    },
    /** The receiving half: a project only stops delivering when its OWN inbox is failing. */
    async incoming(target = project, username = 'inbox@example.com') {
      const result = await req('put', `/projects/${target.id}/mailbox/settings`, {
        revision: 0,
        host: '8.8.8.8',
        username,
        folder: 'INBOX',
        password: 'fake-incoming-password',
        enabled: true,
      });
      assert.equal(result.status, 200, result.text);
    },
    poll(target = project) {
      return req('post', `/projects/${target.id}/mailbox/sync`);
    },
    lastError(target = project) {
      return req('get', `/projects/${target.id}/mailbox/settings`);
    },
    async lead(email = 'contact@pumps.example', target = project) {
      const leads = `/projects/${target.id}/leads`;
      const created = await req('post', leads, {
        name: 'Pump Company ' + ++leadCounter,
        website: `https://pumps${leadCounter}.example`,
        contact_email: email,
      });
      assert.equal(created.status, 201, created.text);
      const qualified = await req('post', `${leads}/${created.body.id}/qualify`, {});
      assert.equal(qualified.status, 200, qualified.text);
      return (await req('get', `${leads}/${created.body.id}`)).body as Lead;
    },
    async funnel(messages = steps, target = project) {
      const result = await req('post', `/projects/${target.id}/funnels`, {
        name: 'Engineering introduction',
        audience: 'Pump manufacturers',
        steps: messages,
      });
      assert.equal(result.status, 201, result.text);
      return result.body as Funnel;
    },
    // A funnel already names its project, so these follow it instead of the default one.
    async enroll(funnel: Funnel, ...leads: Lead[]) {
      return req('post', `/projects/${funnel.project_id}/funnels/${funnel.id}/enrollments`, {
        lead_ids: leads.map((l) => l.id),
      });
    },
    async status(funnel: Funnel, status: 'ACTIVE' | 'PAUSED') {
      const funnels = `/projects/${funnel.project_id}/funnels`;
      const latest = ((await req('get', funnels)).body.funnels as Funnel[]).find(
        (f) => f.id === funnel.id,
      )!;
      return req('patch', `${funnels}/${funnel.id}`, { status, revision: latest.revision });
    },
    async queue(funnel: Funnel) {
      const response = await req(
        'get',
        `/projects/${funnel.project_id}/funnels/${funnel.id}/enrollments`,
      );
      assert.equal(response.status, 200, response.text);
      return response.body.enrollments as Enrollment[];
    },
    async restart() {
      instance.db.close();
      instance = createApp(options);
      agent = request.agent(instance.app);
      const login = await req('post', '/auth/login', {
        username: 'qa-admin',
        password: 'Disposable-funnel-test-2026',
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

test('lead drafts and project templates persist before qualification without overwriting concurrent edits', async () => {
  const f = await fixture();
  try {
    const lead = (await f.req('post', f.base + '/leads', { name: 'Unreviewed company' })).body;
    const url = f.base + '/leads/' + lead.id + '/email/draft';
    const draft = {
      revision: 0,
      to: '',
      subject: '',
      preview_text: '',
      blocks: [{ type: 'button', label: '', url: 'https://', align: 'left' }],
    };
    const saved = await f.req('put', url, draft);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.revision, 1);
    const stale = await f.req('put', url, { ...draft, subject: 'Stale tab' });
    assert.equal(stale.status, 409, stale.text);
    await f.restart();
    const restored = await f.req('get', url);
    assert.equal(restored.body.saved.revision, 1);
    assert.deepEqual(restored.body.saved.document.blocks, draft.blocks);
    assert.equal(restored.body.mailbox.host, undefined);
    assert.equal(restored.body.mailbox.username, undefined);
    assert.equal((await f.req('get', f.base + '/leads/' + lead.id)).body.status, 'UNREVIEWED');
    const template = {
      name: 'Project introduction',
      category: 'outreach',
      subject: 'Hello {{company}}',
      blocks: [
        {
          type: 'text',
          text: 'Hello {{company}}, could we arrange an introduction?',
          align: 'left',
        },
      ],
    };
    assert.equal((await f.req('post', f.base + '/email/templates', template)).status, 201);
    const library = await f.req('get', f.base + '/email/templates');
    assert.equal(library.body.templates[0].name, template.name);
    assert.equal(library.body.templates[0].custom, true);
    const other = (await f.req('post', '/projects', { name: 'Other project' })).body;
    assert.ok(
      !(await f.req('get', `/projects/${other.id}/email/templates`)).body.templates.some(
        (t: { name: string }) => t.name === template.name,
      ),
    );
    assert.equal(
      (await f.req('get', `/projects/${other.id}/leads/${lead.id}/email/draft`)).status,
      404,
    );
    assert.equal(
      (await f.req('put', `/projects/${other.id}/leads/${lead.id}/email/draft`, draft)).status,
      404,
    );
    await f.req('delete', f.base + '/leads/' + lead.id);
    assert.equal(
      (
        f.db.prepare('SELECT COUNT(*) count FROM email_drafts WHERE lead_id=?').get(lead.id) as {
          count: number;
        }
      ).count,
      0,
    );
    assert.equal(
      (
        f.db.prepare('SELECT COUNT(*) count FROM notifications WHERE lead_id=?').get(lead.id) as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    f.dispose();
  }
});

test('notifications and drafts respect per-user ownership, project access, revocation and CSRF', async () => {
  const f = await fixture();
  try {
    const lead = await f.lead();
    const user = (
      await f.req('post', '/users', {
        name: 'Draft Researcher',
        username: 'draft-researcher',
        password: 'Disposable-researcher-2026',
        role: 'researcher',
      })
    ).body;
    const researcher = request.agent(f.app);
    const login = await researcher
      .post('/api/auth/login')
      .set('Host', f.host)
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'draft-researcher', password: 'Disposable-researcher-2026' });
    assert.equal(login.status, 200, login.text);
    const req = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
      const call = researcher[method]('/api' + url)
        .set('Host', f.host)
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', login.body.csrf_token);
      return body ? call.send(body) : call;
    };
    const draftUrl = f.base + '/leads/' + lead.id + '/email/draft';
    const draft = {
      revision: 0,
      to: 'private@example.com',
      subject: 'Private draft',
      preview_text: '',
      blocks: [{ type: 'text', text: 'Private draft content', align: 'left' }],
    };
    assert.equal((await req('get', draftUrl)).status, 404);
    assert.equal((await req('put', draftUrl, draft)).status, 404);
    assert.equal((await req('get', f.base + '/email/templates')).status, 404);
    assert.equal((await req('post', f.base + '/email/templates', {})).status, 404);
    assert.equal((await req('get', '/notifications')).body.unread, 0);
    await f.req('put', `/users/${user.id}/projects`, { project_ids: [f.project.id] });
    assert.equal((await f.req('put', draftUrl, draft)).status, 200);
    assert.equal((await req('get', draftUrl)).body.saved.document, null);
    const noCsrf = await researcher
      .put('/api' + draftUrl)
      .set('Host', f.host)
      .set('X-Requested-With', 'Innovista')
      .send(draft);
    assert.equal(noCsrf.status, 403);
    assert.equal(
      (await req('put', draftUrl, { ...draft, subject: 'Researcher draft' })).status,
      200,
    );
    assert.equal((await f.req('get', draftUrl)).body.saved.document.subject, 'Private draft');
    await f.req('put', f.base + '/leads/' + lead.id + '/assignment', { account_id: user.id });
    const notifications = (await req('get', '/notifications')).body;
    assert.equal(notifications.unread, 1);
    assert.equal(notifications.items[0].kind, 'assignment');
    assert.equal(notifications.items[0].lead_id, lead.id);
    assert.equal(
      (await f.req('post', '/notifications/' + notifications.items[0].id + '/read', {})).status,
      404,
    );
    assert.equal(
      (await req('post', '/notifications/' + notifications.items[0].id + '/read', {})).status,
      200,
    );
    assert.equal((await req('get', '/notifications')).body.unread, 0);
    await f.req('put', `/users/${user.id}/projects`, { project_ids: [] });
    assert.equal((await req('get', '/notifications')).body.items.length, 0);
    assert.equal(
      (await req('post', '/notifications/' + notifications.items[0].id + '/read', {})).status,
      404,
    );
    assert.equal((await req('get', draftUrl)).status, 404);
  } finally {
    f.dispose();
  }
});

test('company workspace includes campaign status and notification links for sent mail and replies', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel();
    assert.equal((await f.enroll(funnel, lead)).status, 201);
    const url = f.base + '/leads/' + lead.id;
    const detail = (await f.req('get', url)).body;
    assert.equal(detail.campaigns.length, 1);
    assert.equal(detail.campaigns[0].funnel_name, funnel.name);
    assert.equal(detail.campaigns[0].step_count, 3);
    assert.equal(detail.campaigns[0].funnel_status, 'DRAFT');
    const sent = await f.req('post', url + '/email', {
      to: lead.contact_email,
      subject: 'Hello company',
      body: 'Could our products help with your engineering requirements?',
    });
    assert.equal(sent.status, 201, sent.text);
    const response = await f.req('post', url + '/outreach-events', {
      outcome: 'REPLIED',
      notes: 'Please send us your catalogue.',
    });
    assert.equal(response.status, 201, response.text);
    const latest = (await f.req('get', url)).body;
    assert.equal(latest.outreach_status, 'REPLIED');
    assert.equal(latest.campaigns[0].status, 'REPLIED');
    assert.equal(latest.status, 'QUALIFIED');
    const updates = (await f.req('get', '/notifications')).body;
    assert.ok(
      updates.items.some(
        (item: { kind: string; lead_id: number }) =>
          item.kind === 'email' && item.lead_id === lead.id,
      ),
    );
    assert.ok(updates.items.some((item: { kind: string }) => item.kind === 'outcome'));
    await f.req('post', '/notifications/read', { through_id: updates.items[0].id });
    assert.equal((await f.req('get', '/notifications')).body.unread, 0);
  } finally {
    f.dispose();
  }
});

test('funnels require deliberate activation, preserve delays over restart and stop after three emails', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel();
    assert.equal((await f.enroll(funnel, lead)).status, 201);
    const time = (await f.queue(funnel))[0].next_send_at + 1;
    await f.worker.tick(time);
    assert.equal(f.messages.length, 0);
    assert.equal((await f.status(funnel, 'ACTIVE')).status, 200);
    await f.worker.tick(time);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].bcc, 'owner@example.com');
    assert.match(f.messages[0].subject, /Pump Company 1/);
    assert.match(f.messages[0].text, /Research Team signature/);
    assert.match(
      f.messages[0].text,
      /Unsubscribe: https:\/\/research.example.com\/unsubscribe\/[a-f0-9]{64}/,
    );
    const due = (await f.queue(funnel))[0].next_send_at;
    assert.ok(due >= time + 3 * day);
    await f.restart();
    await f.worker.tick(due - 1);
    assert.equal(f.messages.length, 1);
    await f.worker.tick(due);
    assert.equal(f.messages.length, 2);
    const last = (await f.queue(funnel))[0].next_send_at;
    assert.ok(last >= due + 7 * day);
    await f.worker.tick(last);
    await f.worker.tick(last + 60_000);
    assert.equal(f.messages.length, 3);
    assert.equal((await f.queue(funnel))[0].status, 'COMPLETED');
    const fourth = await f.req('post', `${f.base}/leads/${lead.id}/email`, {
      to: lead.contact_email,
      subject: 'One more',
      body: 'This must be refused after three accepted deliveries.',
    });
    assert.equal(fourth.status, 409);
    assert.match(fourth.body.error, /three-email limit/);
  } finally {
    f.dispose();
  }
});

test('activation validates setup, funnel edits use revisions, and enrollment is atomic and idempotent', async () => {
  const f = await fixture();
  try {
    const lead = await f.lead();
    const funnel = await f.funnel();
    assert.equal((await f.status(funnel, 'ACTIVE')).status, 409);
    await f.mailbox('');
    assert.equal((await f.status(funnel, 'ACTIVE')).status, 409);
    await f.mailbox();
    const invalid = await f.req('post', f.base + '/funnels', {
      name: 'Too many',
      steps: [...steps, steps[0]],
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (
        await f.req('post', f.base + '/funnels', {
          name: 'Too fast',
          steps: [steps[0], { ...steps[1], delay_days: 0 }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.req('put', `${f.base}/funnels/${funnel.id}`, {
          name: funnel.name,
          steps,
          revision: 99,
        })
      ).status,
      409,
    );
    const other = await f.lead('other@pumps.example');
    assert.equal((await f.enroll(funnel, lead)).status, 201);
    assert.equal((await f.enroll(funnel, lead)).body.skipped, 1);
    const conflicting = await f.funnel();
    assert.equal((await f.enroll(conflicting, other, lead)).status, 409);
    assert.equal((await f.queue(conflicting)).length, 0);
    assert.equal(
      (
        await f.req('put', `${f.base}/funnels/${funnel.id}`, {
          name: 'Changed',
          steps,
          revision: funnel.revision,
        })
      ).status,
      409,
    );
    const missing = await f.funnel([
      { ...steps[0], body: 'Hello {{contact_role}}, can we arrange an introduction?' },
    ]);
    assert.equal((await f.enroll(missing, other)).status, 409);
    assert.equal((await f.queue(missing)).length, 0);
  } finally {
    f.dispose();
  }
});

test('public unsubscribe is deliberate, idempotent and survives lead deletion and reimport', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel();
    await f.enroll(funnel, lead);
    await f.status(funnel, 'ACTIVE');
    await f.worker.tick(Date.now() + 10);
    const url = new URL(f.messages[0].unsubscribeUrl!).pathname;
    assert.equal((await request(f.app).get(url).set('Host', f.host)).status, 200);
    assert.equal((await f.queue(funnel))[0].status, 'QUEUED');
    for (let i = 0; i < 2; i++)
      assert.equal((await request(f.app).post(url).set('Host', f.host)).status, 200);
    assert.equal((await f.queue(funnel))[0].status, 'UNSUBSCRIBED');
    await f.worker.tick(Date.now() + 10 * day);
    assert.equal(f.messages.length, 1);
    assert.equal((await f.req('delete', `${f.base}/leads/${lead.id}`)).status, 200);
    const imported = await f.lead(lead.contact_email);
    const result = await f.req('post', `${f.base}/leads/${imported.id}/email`, {
      to: lead.contact_email,
      subject: 'New import',
      body: 'A reimport cannot undo the recipient opt-out request.',
    });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /opted out/);
    assert.equal(
      (
        await request(f.app)
          .post('/unsubscribe/' + '0'.repeat(64))
          .set('Host', f.host)
      ).status,
      404,
    );
  } finally {
    f.dispose();
  }
});

test('pausing, paced delivery and stale qualifications prevent catch-up bursts and outdated outreach', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const a = await f.lead('a@pumps.example');
    const b = await f.lead('b@pumps.example');
    const funnel = await f.funnel();
    await f.enroll(funnel, a, b);
    await f.status(funnel, 'ACTIVE');
    await f.status(funnel, 'PAUSED');
    const time = Date.now() + 20 * day;
    await f.worker.tick(time);
    assert.equal(f.messages.length, 0);
    await f.status(funnel, 'ACTIVE');
    await Promise.all([f.worker.tick(time), f.worker.tick(time)]);
    assert.equal(f.messages.length, 1);
    await f.worker.tick(time + 1);
    assert.equal(f.messages.length, 1);
    // A second process shares the database and must honor the reserved delivery slot.
    await f.restart();
    await f.worker.tick(time + 100);
    assert.equal(f.messages.length, 1);
    await f.worker.tick(time + 60_000);
    assert.equal(f.messages.length, 2);
    assert.equal(
      (
        await f.req('put', `${f.base}/leads/${a.id}`, {
          name: 'Changed pump requirement',
          website: a.website,
          revision: a.revision,
        })
      ).status,
      200,
    );
    await f.worker.tick(time + 3 * day + 1000);
    const row = (await f.queue(funnel)).find((r) => r.lead_id === a.id)!;
    assert.equal(row.status, 'BLOCKED');
    assert.equal(f.messages.length, 2);
  } finally {
    f.dispose();
  }
});

test('delivery is paced per project, so one queue never starves behind another', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const other = await f.prepare('QA Valve Research');
    // A mailbox of its own, not a copy of the first project's: the worker has to resolve the
    // sender from the project that enrolled the lead.
    await f.mailbox('owner@example.com', other, {
      host: '9.9.9.9',
      username: 'valves@example.net',
      password: 'fake-valve-mail-password',
      from_email: 'valves@example.net',
      from_name: 'Valve Team',
    });
    const first = await f.lead('first@pumps.example');
    const second = await f.lead('second@pumps.example');
    const elsewhere = await f.lead('buyer@valves.example', other);
    const here = await f.funnel([steps[0]]);
    const there = await f.funnel([steps[0]], other);
    await f.enroll(here, first, second);
    await f.enroll(there, elsewhere);
    await f.status(here, 'ACTIVE');
    await f.status(there, 'ACTIVE');
    const time = Date.now() + 20 * day;
    await f.worker.tick(time);
    await f.worker.tick(time);
    // Each project reserves its own minute, so both projects deliver inside the same one.
    assert.deepEqual(f.messages.map((m) => m.to).sort(), [
      'buyer@valves.example',
      'first@pumps.example',
    ]);
    // Each message left through the mailbox of the project that enrolled its lead.
    const sender = (to: string) => f.senders[f.messages.findIndex((m) => m.to === to)];
    assert.equal(sender('first@pumps.example').project_id, f.project.id);
    assert.equal(sender('first@pumps.example').from_email, 'research@example.com');
    assert.equal(sender('first@pumps.example').host, '8.8.8.8');
    assert.equal(sender('buyer@valves.example').project_id, other.id);
    assert.equal(sender('buyer@valves.example').from_email, 'valves@example.net');
    assert.equal(sender('buyer@valves.example').host, '9.9.9.9');
    assert.equal(sender('buyer@valves.example').password, 'fake-valve-mail-password');
    // The second message for this project still waits for this project's next minute.
    await f.worker.tick(time + 1);
    assert.equal(f.messages.length, 2);
    await f.worker.tick(time + 60_000);
    assert.equal(f.messages.length, 3);
    assert.equal(f.messages[2].to, 'second@pumps.example');
    assert.equal(f.senders[2].project_id, f.project.id);
    assert.equal(f.senders[2].from_email, 'research@example.com');
  } finally {
    f.dispose();
  }
});

test('a project whose own inbox is failing delivers nothing until the failure clears', async () => {
  // Only the first project's provider is broken. Its replies are not being ingested, so the
  // "they already replied" stop cannot fire and its sequence must not keep mailing.
  const broken = new Set(['pumps-inbox@example.com']);
  const f = await fixture(undefined, undefined, async (config) => {
    if (broken.has(config.username)) throw new Error('fixture-only provider outage');
    return { uid_validity: '1', last_uid: 0, messages: [] };
  });
  try {
    await f.mailbox();
    const other = await f.prepare('QA Valve Research');
    await f.mailbox('owner@example.com', other, {
      host: '9.9.9.9',
      username: 'valves@example.net',
      password: 'fake-valve-mail-password',
      from_email: 'valves@example.net',
      from_name: 'Valve Team',
    });
    const here = await f.lead('failing@pumps.example');
    const elsewhere = await f.lead('buyer@valves.example', other);
    const stalled = await f.funnel([steps[0]]);
    const healthy = await f.funnel([steps[0]], other);
    await f.enroll(stalled, here);
    await f.enroll(healthy, elsewhere);
    await f.status(stalled, 'ACTIVE');
    await f.status(healthy, 'ACTIVE');
    await f.incoming(f.project, 'pumps-inbox@example.com');
    await f.incoming(other, 'valves-inbox@example.com');
    assert.equal((await f.poll(f.project)).status, 502);
    assert.equal((await f.poll(other)).status, 200);
    assert.match((await f.lastError(f.project)).body.last_error, /Incoming connection failed/);
    assert.equal((await f.lastError(other)).body.last_error, '');
    const time = Date.now() + 20 * day;
    await f.worker.tick(time);
    await f.worker.tick(time);
    // The healthy project keeps delivering; the failing one is left where it was.
    assert.deepEqual(
      f.messages.map((m) => m.to),
      ['buyer@valves.example'],
    );
    assert.equal((await f.queue(stalled))[0].status, 'QUEUED');
    assert.equal((await f.queue(healthy))[0].status, 'COMPLETED');
    // A successful poll clears the failure, and the queue resumes from where it stopped.
    broken.clear();
    assert.equal((await f.poll(f.project)).status, 200);
    assert.equal((await f.lastError(f.project)).body.last_error, '');
    await f.worker.tick(time);
    assert.deepEqual(
      f.messages.map((m) => m.to),
      ['buyer@valves.example', 'failing@pumps.example'],
    );
    assert.equal(f.senders[1].project_id, f.project.id);
  } finally {
    f.dispose();
  }
});

test('a project with a deep due queue never starves another project out of its slot', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const other = await f.prepare('QA Valve Research');
    await f.mailbox('owner@example.com', other, {
      host: '9.9.9.9',
      username: 'valves@example.net',
      password: 'fake-valve-mail-password',
      from_email: 'valves@example.net',
      from_name: 'Valve Team',
    });
    const deep = await f.lead('deep@pumps.example');
    const elsewhere = await f.lead('buyer@valves.example', other);
    const here = await f.funnel([steps[0]]);
    const there = await f.funnel([steps[0]], other);
    await f.enroll(here, deep);
    // A due queue deeper than any single scan window: the first fifty jobs by age all belong
    // to this one project, so fairness has to come from picking the project first.
    const stamp = new Date(Date.now() - 1000).toISOString();
    const backlogFunnel = f.db.prepare(
      "INSERT INTO funnels (project_id,name,audience,steps_json,status,created_at,created_by) VALUES (?,?,'','[]','ACTIVE',?,'QA')",
    );
    const backlogEnrollment = f.db.prepare(
      `INSERT INTO funnel_enrollments
      (project_id,funnel_id,lead_id,recipient,lead_revision,training_version,account_id,created_by,next_send_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,'QA',?,?,?)`,
    );
    for (let index = 0; index < 55; index++)
      backlogEnrollment.run(
        f.project.id,
        Number(backlogFunnel.run(f.project.id, 'Deep queue ' + index, stamp).lastInsertRowid),
        deep.id,
        `deep-${index}@pumps.example`,
        deep.revision,
        Number(f.project.active_version),
        Date.now(),
        stamp,
        stamp,
      );
    await f.enroll(there, elsewhere);
    await f.status(here, 'ACTIVE');
    await f.status(there, 'ACTIVE');
    // Every one of this project's jobs is older than the other project's single message.
    const due = Date.now() - 60_000;
    f.db
      .prepare('UPDATE funnel_enrollments SET next_send_at=? WHERE project_id=?')
      .run(due, f.project.id);
    f.db
      .prepare('UPDATE funnel_enrollments SET next_send_at=? WHERE project_id=?')
      .run(due + 1000, other.id);
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT count(*) n FROM funnel_enrollments WHERE project_id=? AND status='QUEUED'",
          )
          .get(f.project.id) as { n: number }
      ).n,
      56,
    );
    const time = Date.now() + 20 * day;
    await f.worker.tick(time);
    await f.worker.tick(time);
    // The other project delivered inside the same minute instead of queueing behind 55 jobs.
    assert.deepEqual(
      f.messages.map((m) => m.to),
      ['deep@pumps.example', 'buyer@valves.example'],
    );
    assert.equal(f.senders[1].project_id, other.id);
    assert.equal(f.senders[1].from_email, 'valves@example.net');
  } finally {
    f.dispose();
  }
});

test('SMTP uncertainty is logged, consumes a slot and is never retried automatically', async () => {
  let attempts = 0;
  const f = await fixture(undefined, async (_config, message) => {
    message.beforeSend?.();
    attempts++;
    throw new Error('secret raw relay failure');
  });
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel();
    await f.enroll(funnel, lead);
    await f.status(funnel, 'ACTIVE');
    await f.worker.tick(Date.now() + 100);
    await f.worker.tick(Date.now() + day);
    assert.equal(attempts, 1);
    assert.equal((await f.queue(funnel))[0].status, 'BLOCKED');
    const detail = (await f.req('get', `${f.base}/leads/${lead.id}`)).body as Lead;
    assert.equal(detail.emails?.length, 1);
    assert.match(detail.emails![0].error, /could not be confirmed/);
    assert.ok(!JSON.stringify(detail).includes('secret raw'));
    assert.equal(
      (f.db.prepare('SELECT status FROM email_deliveries').get() as { status: string }).status,
      'UNKNOWN',
    );
  } finally {
    f.dispose();
  }
});

test('responses stop in-flight reservations, remain in history and never rewrite qualification', async () => {
  let entered!: () => void;
  let release!: () => void;
  let sent = 0;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(undefined, async (_config, message) => {
    entered();
    await proceed;
    message.beforeSend?.();
    sent++;
  });
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel();
    await f.enroll(funnel, lead);
    await f.status(funnel, 'ACTIVE');
    const ticking = f.worker.tick(Date.now() + 100);
    await ready;
    assert.equal((await f.req('delete', `${f.base}/leads/${lead.id}`)).status, 409);
    const recorded = await f.req('post', `${f.base}/leads/${lead.id}/outreach-events`, {
      outcome: 'CONVERTED',
      notes: 'Customer confirmed that they want to proceed.',
    });
    assert.equal(recorded.status, 201);
    release();
    await ticking;
    assert.equal(sent, 0);
    assert.equal((await f.queue(funnel))[0].status, 'CONVERTED');
    const after = (await f.req('get', `${f.base}/leads/${lead.id}`)).body as Lead;
    assert.equal(after.outreach_status, 'CONVERTED');
    assert.equal(after.outreach_events?.length, 1);
    assert.equal(after.status, lead.status);
    assert.equal(after.score, lead.score);
    assert.deepEqual(after.runs, lead.runs);
    assert.equal(
      (f.db.prepare('SELECT status FROM email_deliveries').get() as { status: string }).status,
      'BLOCKED',
    );
  } finally {
    release();
    f.dispose();
  }
});

test('new routes enforce project access, role, CSRF and revocation of the enrolling account', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel();
    const user = (
      await f.req('post', '/users', {
        name: 'Researcher',
        username: 'qa-researcher',
        password: 'Disposable-researcher-2026',
        role: 'researcher',
      })
    ).body;
    const researcher = request.agent(f.app);
    const login = await researcher
      .post('/api/auth/login')
      .set('Host', f.host)
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'qa-researcher', password: 'Disposable-researcher-2026' });
    assert.equal(login.status, 200);
    const base = '/api' + f.base;
    for (const suffix of ['/funnels', `/funnels/${funnel.id}/enrollments`]) {
      assert.equal((await researcher.get(base + suffix).set('Host', f.host)).status, 404);
      assert.equal(
        (
          await researcher
            .post(base + suffix)
            .set('Host', f.host)
            .set('X-Requested-With', 'Innovista')
            .set('X-CSRF-Token', login.body.csrf_token)
            .send({})
        ).status,
        404,
      );
    }
    await f.req('put', `/users/${user.id}/projects`, { project_ids: [f.project.id] });
    assert.equal(
      (
        await researcher
          .post(base + '/funnels')
          .set('Host', f.host)
          .set('X-Requested-With', 'Innovista')
          .set('X-CSRF-Token', login.body.csrf_token)
          .send({ name: 'Forbidden', steps })
      ).status,
      403,
    );
    assert.equal(
      (
        await researcher
          .post(base + `/funnels/${funnel.id}/enrollments`)
          .set('Host', f.host)
          .set('X-Requested-With', 'Innovista')
          .send({ lead_ids: [lead.id] })
      ).status,
      403,
    );
    assert.equal(
      (
        await researcher
          .post(base + `/funnels/${funnel.id}/enrollments`)
          .set('Host', f.host)
          .set('X-Requested-With', 'Innovista')
          .set('X-CSRF-Token', login.body.csrf_token)
          .send({ lead_ids: [lead.id] })
      ).status,
      201,
    );
    await f.status(funnel, 'ACTIVE');
    await f.req('put', `/users/${user.id}/projects`, { project_ids: [] });
    await f.worker.tick(Date.now() + 100);
    assert.equal(f.messages.length, 0);
    assert.equal((await f.queue(funnel))[0].status, 'BLOCKED');
  } finally {
    f.dispose();
  }
});

test('recipient limits survive deleting history and new enrollments never reuse delivery keys', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const funnel = await f.funnel([steps[0]]);
    const first = await f.lead();
    await f.enroll(funnel, first);
    await f.status(funnel, 'ACTIVE');
    const time = Date.now() + 100;
    await f.worker.tick(time);
    const enrollmentId = (await f.queue(funnel))[0].id;
    await f.req('delete', `${f.base}/leads/${first.id}`);
    const second = await f.lead(first.contact_email);
    await f.enroll(funnel, second);
    assert.ok((await f.queue(funnel))[0].id > enrollmentId);
    await f.worker.tick(time + 60_000);
    assert.equal(f.messages.length, 2);
    const body = {
      to: first.contact_email,
      subject: 'Third and final',
      body: 'We would like to close our introduction with {{company}}.',
    };
    assert.equal((await f.req('post', `${f.base}/leads/${second.id}/email`, body)).status, 201);
    assert.ok(!f.messages[2].text.includes('{{company}}'));
    assert.equal((await f.req('post', `${f.base}/leads/${second.id}/email`, body)).status, 409);
  } finally {
    f.dispose();
  }
});

test('a replied lead can later convert while its separate outcome history remains append-only', async () => {
  const f = await fixture();
  try {
    const lead = await f.lead();
    const funnel = await f.funnel();
    await f.enroll(funnel, lead);
    for (const outcome of ['REPLIED', 'INTERESTED', 'CONVERTED'])
      assert.equal(
        (
          await f.req('post', `${f.base}/leads/${lead.id}/outreach-events`, {
            outcome,
            notes: 'Recorded customer response for this test.',
          })
        ).status,
        201,
      );
    const after = (await f.req('get', `${f.base}/leads/${lead.id}`)).body as Lead;
    assert.equal(after.outreach_status, 'CONVERTED');
    assert.equal(after.outreach_events?.length, 3);
    assert.deepEqual(after.runs, lead.runs);
    assert.equal((await f.queue(funnel))[0].status, 'CONVERTED');
    const list = (await f.req('get', f.base + '/funnels')).body.funnels as Funnel[];
    assert.equal(list[0].converted_count, 1);
  } finally {
    f.dispose();
  }
});

test('local drafts cannot activate and changed training blocks already queued mail', async () => {
  const local = await fixture('');
  try {
    await local.mailbox();
    const funnel = await local.funnel();
    assert.equal((await local.status(funnel, 'ACTIVE')).status, 409);
  } finally {
    local.dispose();
  }
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel();
    await f.enroll(funnel, lead);
    await f.status(funnel, 'ACTIVE');
    const source = await f.req('post', f.base + '/sources', {
      revision: f.project.revision,
      title: 'New requirements',
      content: 'New engineering requirements need to be folded into approved training.',
    });
    assert.equal(source.status, 201);
    await f.worker.tick(Date.now() + 100);
    assert.equal(f.messages.length, 0);
    assert.equal((await f.queue(funnel))[0].status, 'BLOCKED');
  } finally {
    f.dispose();
  }
});

test('SMTP verifies primary and copy acceptance, pins the host and passes unsubscribe headers', async (t) => {
  let accepted = ['owner@example.com'];
  let closed = 0;
  let transportOptions: Record<string, unknown> = {},
    payload: Record<string, unknown> = {};
  t.mock.method(nodemailer, 'createTransport', (options: Record<string, unknown>) => {
    transportOptions = options;
    return {
      sendMail: async (message: Record<string, unknown>) => {
        payload = message;
        return { accepted };
      },
      close: () => {
        closed++;
      },
    };
  });
  const config: SmtpConfig = {
    project_id: 1,
    host: '8.8.8.8',
    port: 587,
    secure: false,
    username: 'research@example.com',
    password: 'test-only',
    from_email: 'research@example.com',
    from_name: 'QA Research',
    reply_to: '',
    copy_to: 'owner@example.com',
    signature: '',
    configured: true,
    has_password: true,
  };
  const message = {
    to: 'contact@pumps.example',
    bcc: 'owner@example.com',
    subject: 'QA message',
    text: 'Test message',
    html: '<p>Test message</p>',
    replyTo: 'research@example.com',
    unsubscribeUrl: 'https://research.example.com/unsubscribe/test',
  };
  await assert.rejects(sendMail(config, message), /mail server rejected/);
  accepted = [message.to];
  await assert.rejects(sendMail(config, message), /mail server rejected/);
  accepted = [message.to, message.bcc];
  await sendMail(config, message);
  assert.equal(closed, 3);
  assert.equal(transportOptions.host, '8.8.8.8');
  assert.deepEqual(transportOptions.tls, { servername: '8.8.8.8', rejectUnauthorized: true });
  assert.equal(payload.bcc, message.bcc);
  assert.equal(
    (payload.headers as Record<string, string>)['List-Unsubscribe-Post'],
    'List-Unsubscribe=One-Click',
  );
});

test('interrupted deliveries recover into visible history and are never automatically repeated', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel();
    await f.enroll(funnel, lead);
    await f.status(funnel, 'ACTIVE');
    const enrollment = (await f.queue(funnel))[0];
    const started = Date.now() - 11 * 60_000,
      stamp = new Date(started).toISOString();
    const id = Number(
      f.db
        .prepare(
          `INSERT INTO email_messages (project_id,lead_id,to_email,subject,body,status,error,created_by,created_at)
      VALUES (?,?,?,?,?,'FAILED',?,?,?)`,
        )
        .run(
          f.project.id,
          lead.id,
          lead.contact_email,
          'Interrupted introduction',
          'Stored pending message text.',
          'Delivery pending.',
          'QA Administrator',
          stamp,
        ).lastInsertRowid,
    );
    f.db
      .prepare(
        `INSERT INTO email_deliveries (delivery_key,project_id,lead_id,recipient,status,message_id,started_at)
      VALUES (?,?,?,?,'SENDING',?,?)`,
      )
      .run(
        'funnel:' + enrollment.id + ':0',
        f.project.id,
        lead.id,
        lead.contact_email,
        id,
        started,
      );
    f.db
      .prepare(
        "UPDATE funnel_enrollments SET status='SENDING',updated_at=? WHERE id=? AND project_id=?",
      )
      .run(stamp, enrollment.id, f.project.id);
    await f.restart();
    await f.worker.tick();
    await f.worker.tick(Date.now() + day);
    assert.equal(f.messages.length, 0);
    assert.equal((await f.queue(funnel))[0].status, 'BLOCKED');
    const after = (await f.req('get', `${f.base}/leads/${lead.id}`)).body as Lead;
    assert.equal(after.emails?.length, 1);
    assert.match(after.emails![0].error, /Delivery interrupted/);
    assert.equal(
      (f.db.prepare('SELECT status FROM email_deliveries').get() as { status: string }).status,
      'UNKNOWN',
    );
  } finally {
    f.dispose();
  }
});

test('a designed funnel message is delivered as email-safe HTML, and every step must say something', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    // A step that is neither written nor designed is refused rather than sent empty.
    const silent = await f.req('post', `/projects/${f.project.id}/funnels`, {
      name: 'Neither written nor designed',
      audience: 'Pump manufacturers',
      steps: [{ delay_days: 0, subject: 'A question for {{company}}', body: '' }],
    });
    assert.equal(silent.status, 400, silent.text);
    assert.match(silent.text, /Write the message, or design it with blocks/);

    const designed = await f.funnel([
      {
        delay_days: 0,
        subject: 'Bearings for {{company}}',
        body: '',
        blocks: [
          { type: 'heading', text: 'A question about {{company}}', level: 'h1', align: 'left' },
          {
            type: 'text',
            text: 'We supply bearings for duty where steel struggles.',
            align: 'left',
          },
          {
            type: 'button',
            label: 'Book a call',
            url: 'https://research.example.com/book',
            align: 'left',
          },
        ],
      },
    ]);
    // The preview is the same render the worker will send, so it is worth asserting on.
    const preview = await f.req(
      'post',
      `/projects/${f.project.id}/funnels/${designed.id}/preview`,
      { lead_id: lead.id, step: 0 },
    );
    assert.equal(preview.status, 200, preview.text);
    assert.match(preview.body.html, /<table/);
    assert.ok(
      !/display:\s*(flex|grid)|<style|class=/i.test(preview.body.html),
      'a designed message must not depend on flex, grid, a stylesheet or classes',
    );
    assert.match(preview.body.subject, /Pump Company/);
    assert.doesNotMatch(preview.body.body, /\{\{/);

    assert.equal((await f.status(designed, 'ACTIVE')).status, 200);
    assert.equal((await f.enroll(designed, lead)).status, 201);
    await f.worker.tick(Date.now() + 10);
    const sent = f.messages.at(-1)!;
    assert.match(String(sent.html), /<table/);
    assert.doesNotMatch(String(sent.html), /\{\{/);
    // The plain-text alternative is derived from the blocks, never left empty.
    assert.match(String(sent.text), /steel struggles/);

    // A designed step is held to the same merge-field rule as a written one.
    const unresolved = await f.funnel([
      {
        delay_days: 0,
        subject: 'A note for {{company}}',
        body: '',
        blocks: [{ type: 'text', text: 'Hello {{contact_first_name}},', align: 'left' }],
      },
    ]);
    const refused = await f.enroll(unresolved, lead);
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.text, /contact_first_name/);
  } finally {
    f.dispose();
  }
});

test('a plain-text funnel step keeps its stored shape and its simple HTML', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    const written = await f.funnel();
    // Saving a plain step must not invent a blocks array: existing funnels keep their shape.
    const stored = (
      f.db.prepare('SELECT steps_json FROM funnels WHERE id=?').get(written.id) as {
        steps_json: string;
      }
    ).steps_json;
    assert.ok(!stored.includes('blocks'), stored);
    assert.equal((await f.status(written, 'ACTIVE')).status, 200);
    assert.equal((await f.enroll(written, lead)).status, 201);
    await f.worker.tick(Date.now() + 10);
    const sent = f.messages.at(-1)!;
    assert.match(String(sent.text), /could our services help Pump Company/);
    assert.match(String(sent.html), /<p/);
  } finally {
    f.dispose();
  }
});

test('a campaign message names a bad block the way the composer does', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const bad = await f.req('post', `/projects/${f.project.id}/funnels`, {
      name: 'Designed with a placeholder link',
      audience: 'Pump manufacturers',
      steps: [
        {
          delay_days: 0,
          subject: 'A note for {{company}}',
          body: '',
          blocks: [
            { type: 'text', text: 'A short note about bearings.', align: 'left' },
            { type: 'button', label: 'Book a call', url: 'https://', align: 'left' },
          ],
        },
      ],
    });
    assert.equal(bad.status, 400, bad.text);
    // Not "steps.0.blocks.1.url": the message has to name a block the author can see, and the
    // placeholder link a fresh Button carries is the most likely way to hit this.
    assert.match(bad.text, /Message 1/);
    assert.match(bad.text, /Block 2 \(button\)/);
    assert.doesNotMatch(bad.text, /steps\.0/);
  } finally {
    f.dispose();
  }
});

test('funnel step To is checked at enrollment and used as the delivery recipient', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead('contact@pumps.example');
    f.db
      .prepare('INSERT INTO email_suppressions VALUES (?,?,?)')
      .run('alt@pumps.example', 'Prior opt-out', new Date().toISOString());
    const blocked = await f.funnel([
      { ...steps[0], to: 'alt@pumps.example' },
    ]);
    assert.equal((await f.enroll(blocked, lead)).status, 409);

    const funnel = await f.funnel([
      { ...steps[0], to: 'ops@pumps.example' },
    ]);
    assert.equal((await f.enroll(funnel, lead)).status, 201);
    await f.status(funnel, 'ACTIVE');
    await f.worker.tick(Date.now() + 10);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].to, 'ops@pumps.example');
    assert.equal((await f.queue(funnel))[0].status, 'COMPLETED');
  } finally {
    f.dispose();
  }
});

test('follow-up email templates ship with the library and scheduleNextSend honors send_time', () => {
  // Named for where they sit in a sequence: the 2nd, the 3rd and the last email.
  const names = emailTemplates.map((t) => t.name);
  assert.ok(names.includes('2nd email · first follow-up'));
  assert.ok(names.includes('3rd email · second follow-up'));
  assert.ok(names.includes('Last email · final follow-up'));

  const noon = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
  assert.equal(scheduleNextSend(noon, 0, ''), noon);
  assert.equal(scheduleNextSend(noon, 1, ''), noon + day);
  const morning = scheduleNextSend(noon, 1, '09:00');
  const due = new Date(morning);
  assert.equal(due.getHours(), 9);
  assert.equal(due.getMinutes(), 0);
  assert.ok(morning > noon);
  // Same-day preferred time already past → due immediately.
  assert.equal(scheduleNextSend(noon, 0, '08:00'), noon);
});

test('funnel steps accept a preferred send time and use it for the first due slot', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel([
      { ...steps[0], delay_days: 1, send_time: '14:30' },
    ]);
    assert.equal((await f.enroll(funnel, lead)).status, 201);
    const row = (await f.queue(funnel))[0];
    const due = new Date(row.next_send_at);
    assert.equal(due.getHours(), 14);
    assert.equal(due.getMinutes(), 30);
    assert.equal(funnel.steps[0].send_time || '14:30', '14:30');
  } finally {
    f.dispose();
  }
});

/** A funnel as the list reports it, with its counts and progress. */
async function listed(f: Awaited<ReturnType<typeof fixture>>, funnel: Funnel) {
  const response = await f.req('get', `/projects/${funnel.project_id}/funnels`);
  assert.equal(response.status, 200, response.text);
  return (response.body.funnels as Funnel[]).find((item) => item.id === funnel.id)!;
}
/** The open token in a sent message's image address. */
const openToken = (html: unknown) => /\/e\/o\/([a-f0-9]{64})\.gif/.exec(String(html))?.[1];

test('funnel counts follow each sequence once through sent, opened, replied, follow-up and bounced', async () => {
  const sent: Parameters<Send>[1][] = [];
  const f = await fixture(undefined, async (_config, message) => {
    message.beforeSend?.();
    // A permanent refusal at send time is a bounce.
    if (message.to === 'gone@pumps.example') throw new RecipientRejected(message.to, 550);
    sent.push(message);
  });
  try {
    await f.mailbox();
    const opener = await f.lead('opener@pumps.example');
    const replier = await f.lead('replier@pumps.example');
    const gone = await f.lead('gone@pumps.example');
    const quiet = await f.lead('quiet@pumps.example');
    const funnel = await f.funnel();
    assert.deepEqual((await listed(f, funnel)).counts, emptyCounts);
    assert.equal((await f.enroll(funnel, opener, replier, gone, quiet)).status, 201);
    assert.equal((await f.status(funnel, 'ACTIVE')).status, 200);
    const start = Date.now() + 100;
    // One message a minute: the first message to each of the four, one of them refused.
    for (let i = 0; i < 4; i++) await f.worker.tick(start + i * 60_000);
    assert.deepEqual(
      sent.map((message) => message.to),
      ['opener@pumps.example', 'replier@pumps.example', 'quiet@pumps.example'],
    );
    // Opened twice is still one sequence opened.
    const token = openToken(sent[0].html)!;
    for (let i = 0; i < 2; i++) {
      const image = await request(f.app)
        .get('/e/o/' + token + '.gif')
        .set('Host', f.host);
      assert.equal(image.status, 200);
    }
    const replied = await f.req('post', `${f.base}/leads/${replier.id}/outreach-events`, {
      outcome: 'REPLIED',
      notes: 'They asked for a call next week.',
    });
    assert.equal(replied.status, 201, replied.text);
    // The opener's follow-up is due first.
    const due = (await f.queue(funnel)).find((row) => row.lead_id === opener.id)!.next_send_at;
    await f.worker.tick(Math.max(due, start + 4 * 60_000));
    assert.equal(sent.length, 4);
    assert.equal(sent[3].to, 'opener@pumps.example');
    assert.equal(sent[3].subject, 'Following up');
    // In the funnel, nothing sent yet.
    const late = await f.lead('late@pumps.example');
    assert.equal((await f.enroll(funnel, late)).status, 201);
    const report = await listed(f, funnel);
    assert.deepEqual(report.counts, {
      enrolled: 5,
      sent: 3,
      opened: 1,
      replied: 1,
      followed_up: 1,
      bounced: 1,
      open_rate: 1 / 3,
      reply_rate: 1 / 3,
    } satisfies FunnelCounts);
    // Where each sequence is now stays alongside.
    assert.equal(report.progress!.total, 5);
    assert.equal(report.progress!.bounced, 1);
    assert.equal(report.progress!.replied, 1);
    assert.deepEqual(report.progress!.waiting, [1, 1, 1]);
  } finally {
    f.dispose();
  }
});

test('a reply still counts on a funnel that keeps going, and so does a bounce reported after the last message', async () => {
  const inbox = { uid_validity: '1', last_uid: 0, messages: [] as ReceivedMail[] };
  const f = await fixture(undefined, undefined, async () => inbox);
  try {
    await f.mailbox();
    await f.incoming();
    const created = await f.req('post', `${f.base}/funnels`, {
      name: 'Keeps going',
      audience: 'Pump manufacturers',
      stop_on_reply: false,
      steps,
    });
    assert.equal(created.status, 201, created.text);
    const keeps = created.body as Funnel;
    const once = await f.funnel([steps[0]]);
    const talker = await f.lead('talker@pumps.example');
    const done = await f.lead('done@pumps.example');
    assert.equal((await f.enroll(keeps, talker)).status, 201);
    assert.equal((await f.enroll(once, done)).status, 201);
    await f.status(keeps, 'ACTIVE');
    await f.status(once, 'ACTIVE');
    const start = Date.now() + 100;
    await f.worker.tick(start);
    await f.worker.tick(start + 60_000);
    assert.equal(f.messages.length, 2);
    inbox.last_uid = 1;
    inbox.messages = [
      {
        uid: 1,
        message_id: '<reply-1@pumps.example>',
        references: [
          f.messages.find((message) => message.to === 'talker@pumps.example')!.messageId!,
        ],
        from_email: 'talker@pumps.example',
        from_name: 'Customer',
        to_email: 'research@example.com',
        subject: 'Re: Hello',
        body: 'Thanks, tell me more.',
        received_at: new Date(Date.now() + 1000).toISOString(),
        attachment_count: 0,
        notice: '',
      },
    ];
    const polled = await f.poll();
    assert.equal(polled.status, 200, polled.text);
    assert.equal(polled.body.received, 1);
    // The sequence keeps going, so its status says nothing; the matched reply does.
    assert.equal((await f.queue(keeps))[0].status, 'QUEUED');
    const keeping = await listed(f, keeps);
    assert.equal(keeping.counts!.replied, 1);
    assert.equal(keeping.counts!.reply_rate, 1);
    assert.deepEqual(keeping.progress!.waiting, [0, 1, 0]);
    // A one-message sequence is finished; a delivery report arriving afterwards has nothing
    // left to stop, and the funnel still counts the bounce.
    assert.equal((await f.queue(once))[0].status, 'COMPLETED');
    recordBounce(f.db, {
      recipient: 'done@pumps.example',
      projectId: f.project.id,
      leadId: done.id,
      source: 'DSN',
      status: '5.1.1',
    });
    assert.equal((await f.queue(once))[0].status, 'COMPLETED');
    const finished = await listed(f, once);
    assert.equal(finished.counts!.bounced, 1);
    assert.equal(finished.counts!.sent, 1);
    assert.ok(funnelCompleted(finished));
    assert.ok(!funnelCompleted(keeping));
  } finally {
    f.dispose();
  }
});

test('the open image answers every request alike, needs no session and counts only its own message', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel();
    await f.enroll(funnel, lead);
    await f.status(funnel, 'ACTIVE');
    await f.worker.tick(Date.now() + 100);
    const other = await f.prepare('Valve Research');
    await f.mailbox('owner@example.com', other);
    const buyer = await f.lead('buyer@valves.example', other);
    const otherFunnel = await f.funnel(steps, other);
    await f.enroll(otherFunnel, buyer);
    await f.status(otherFunnel, 'ACTIVE');
    await f.worker.tick(Date.now() + 200);
    assert.equal(f.messages.length, 2);
    const token = openToken(f.messages[0].html)!;
    const otherToken = openToken(f.messages[1].html)!;
    assert.ok(token && otherToken && token !== otherToken);
    // Only the token's hash is kept, and nothing about whoever loads the image.
    const columns = (
      f.db.prepare('SELECT name FROM pragma_table_info(?)').all('funnel_message_opens') as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    assert.deepEqual(columns, [
      'token_hash',
      'project_id',
      'lead_id',
      'enrollment_id',
      'step',
      'created_at',
      'first_opened_at',
      'open_count',
    ]);
    const row = (value: string) =>
      f.db
        .prepare(
          'SELECT project_id,first_opened_at,open_count FROM funnel_message_opens WHERE token_hash=?',
        )
        .get(hash(value)) as
        { project_id: number; first_opened_at: string | null; open_count: number } | undefined;
    assert.equal(row(token)!.project_id, f.project.id);
    assert.equal(row(otherToken)!.project_id, other.id);
    assert.equal(row(token)!.open_count, 0);
    // No cookie, no CSRF header: the recipient's mail app is the caller.
    const image = (path: string) => request(f.app).get(path).set('Host', f.host);
    const first = await image('/e/o/' + token + '.gif');
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-type'], 'image/gif');
    assert.match(first.headers['cache-control'], /no-store/);
    assert.equal(first.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(first.headers['set-cookie'], undefined);
    assert.ok(Buffer.isBuffer(first.body) && first.body.subarray(0, 6).toString() === 'GIF89a');
    const opened = row(token)!;
    assert.ok(opened.first_opened_at);
    assert.equal(opened.open_count, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await image('/e/o/' + token + '.gif');
    // The first open stays the first; the loads are counted.
    assert.deepEqual(row(token), { ...opened, open_count: 2 });
    assert.equal(row(otherToken)!.open_count, 0);
    // Unknown, malformed, the stored hash used as a token, or a HEAD: the same answer, and
    // nothing recorded.
    const all = () =>
      JSON.stringify(f.db.prepare('SELECT * FROM funnel_message_opens ORDER BY token_hash').all());
    const before = all();
    for (const path of [
      '/e/o/' + 'a'.repeat(64) + '.gif',
      '/e/o/' + token.toUpperCase() + '.gif',
      '/e/o/' + token,
      '/e/o/' + hash(token) + '.gif',
      '/e/o/x.gif',
    ]) {
      const answer = await image(path);
      assert.equal(answer.status, first.status, path);
      assert.equal(answer.headers['content-type'], first.headers['content-type'], path);
      assert.equal(answer.headers['cache-control'], first.headers['cache-control'], path);
      assert.deepEqual(answer.body, first.body, path);
    }
    const head = await request(f.app)
      .head('/e/o/' + token + '.gif')
      .set('Host', f.host);
    assert.equal(head.status, 200);
    assert.equal(all(), before);
    // The other project's token counts the other project's message, and only that.
    await image('/e/o/' + otherToken + '.gif');
    assert.equal(row(otherToken)!.open_count, 1);
    assert.equal(row(token)!.open_count, 2);
    assert.equal((await listed(f, funnel)).counts!.opened, 1);
    assert.equal((await listed(f, otherFunnel)).counts!.opened, 1);
    // Deleting the lead deletes what was recorded about it.
    assert.equal((await f.req('delete', `${f.base}/leads/${lead.id}`)).status, 200);
    assert.equal(row(token), undefined);
    assert.ok(row(otherToken));
  } finally {
    f.dispose();
  }
});

test('the open image is rate-limited per address and still answers the same way', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead();
    const funnel = await f.funnel();
    await f.enroll(funnel, lead);
    await f.status(funnel, 'ACTIVE');
    await f.worker.tick(Date.now() + 100);
    const token = openToken(f.messages[0].html)!;
    for (let i = 0; i < 125; i++) {
      const answer = await request(f.app)
        .get('/e/o/' + token + '.gif')
        .set('Host', f.host);
      assert.equal(answer.status, 200);
      assert.equal(answer.headers['content-type'], 'image/gif');
    }
    const { open_count } = f.db
      .prepare('SELECT open_count FROM funnel_message_opens WHERE token_hash=?')
      .get(hash(token)) as { open_count: number };
    assert.equal(open_count, 120);
  } finally {
    f.dispose();
  }
});

test('"Count opens" puts one image in the HTML part of funnel messages only, and can be switched', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const counted = await f.funnel();
    assert.equal(counted.track_opens, true);
    const created = await f.req('post', `${f.base}/funnels`, {
      name: 'Quiet introduction',
      audience: 'Pump manufacturers',
      track_opens: false,
      steps,
    });
    assert.equal(created.status, 201, created.text);
    const uncounted = created.body as Funnel;
    assert.equal(uncounted.track_opens, false);
    const a = await f.lead('a@pumps.example');
    const b = await f.lead('b@pumps.example');
    await f.enroll(counted, a);
    await f.enroll(uncounted, b);
    await f.status(counted, 'ACTIVE');
    await f.status(uncounted, 'ACTIVE');
    const start = Date.now() + 100;
    await f.worker.tick(start);
    await f.worker.tick(start + 60_000);
    const toA = f.messages.find((message) => message.to === 'a@pumps.example')!;
    const toB = f.messages.find((message) => message.to === 'b@pumps.example')!;
    const html = String(toA.html);
    assert.equal(html.match(/\/e\/o\//g)?.length, 1);
    assert.match(
      html,
      /<img src="https:\/\/research\.example\.com\/e\/o\/[a-f0-9]{64}\.gif" width="1" height="1" alt=""/,
    );
    assert.ok(html.indexOf('/e/o/') < html.lastIndexOf('</body>'));
    assert.doesNotMatch(String(toA.text), /\/e\/o\/|<img/);
    assert.doesNotMatch(String(toB.html), /\/e\/o\//);
    const tokens = () =>
      (f.db.prepare('SELECT COUNT(*) n FROM funnel_message_opens').get() as { n: number }).n;
    assert.equal(tokens(), 1);
    // The switch works on a running funnel and changes only the messages still to come.
    const latest = await listed(f, uncounted);
    const switched = await f.req('patch', `${f.base}/funnels/${uncounted.id}`, {
      track_opens: true,
      revision: latest.revision,
    });
    assert.equal(switched.status, 200, switched.text);
    assert.equal(switched.body.track_opens, true);
    assert.equal(switched.body.status, 'ACTIVE');
    const nothing = await f.req('patch', `${f.base}/funnels/${uncounted.id}`, {
      revision: switched.body.revision,
    });
    assert.equal(nothing.status, 400);
    const due = (await f.queue(uncounted))[0].next_send_at;
    await f.worker.tick(due);
    await f.worker.tick(due + 60_000);
    const followUp = f.messages.filter((message) => message.to === 'b@pumps.example')[1];
    assert.equal(followUp.subject, 'Following up');
    assert.match(String(followUp.html), /\/e\/o\/[a-f0-9]{64}\.gif/);
    assert.doesNotMatch(String(followUp.text), /\/e\/o\//);
    // Individual mail never carries the image.
    const c = await f.lead('c@pumps.example');
    const single = await f.req('post', `${f.base}/leads/${c.id}/email`, {
      to: 'c@pumps.example',
      subject: 'A direct note',
      body: 'A direct note to ask whether a short call would help.',
    });
    assert.equal(single.status, 201, single.text);
    assert.equal(f.messages.at(-1)!.to, 'c@pumps.example');
    assert.doesNotMatch(String(f.messages.at(-1)!.html), /\/e\/o\//);
    // A message without an HTML part has nowhere to put one.
    assert.equal(withOpenPixel('', 'https://research.example.com/e/o/x.gif'), '');
  } finally {
    f.dispose();
  }
});

test('a funnel records when it last changed: edits, start and pause, the open switch and new leads', async () => {
  const f = await fixture();
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));
  try {
    await f.mailbox();
    const funnel = await f.funnel();
    assert.equal(funnel.updated_at, funnel.created_at);
    await later();
    const edited = await f.req('put', `${f.base}/funnels/${funnel.id}`, {
      name: 'Renamed introduction',
      audience: 'Pump manufacturers',
      steps,
      revision: funnel.revision,
    });
    assert.equal(edited.status, 200, edited.text);
    assert.ok(edited.body.updated_at > funnel.updated_at);
    await later();
    const started = await f.status(funnel, 'ACTIVE');
    assert.ok(started.body.updated_at > edited.body.updated_at);
    await later();
    const paused = await f.status(funnel, 'PAUSED');
    assert.ok(paused.body.updated_at > started.body.updated_at);
    await later();
    const switched = await f.req('patch', `${f.base}/funnels/${funnel.id}`, {
      track_opens: false,
      revision: paused.body.revision,
    });
    assert.equal(switched.status, 200, switched.text);
    assert.ok(switched.body.updated_at > paused.body.updated_at);
    await later();
    const lead = await f.lead();
    assert.equal((await f.enroll(funnel, lead)).status, 201);
    const enrolled = await listed(f, funnel);
    assert.ok(enrolled.updated_at > switched.body.updated_at);
    // A message going out is progress, not a change to the funnel.
    await f.status(funnel, 'ACTIVE');
    const running = await listed(f, funnel);
    await f.worker.tick(Date.now() + 100);
    assert.equal(f.messages.length, 1);
    assert.equal((await listed(f, funnel)).updated_at, running.updated_at);
    // An older database gains both columns: updated_at from created_at, and opens counted.
    f.db.exec('ALTER TABLE funnels DROP COLUMN updated_at');
    f.db.exec('ALTER TABLE funnels DROP COLUMN track_opens');
    await f.restart();
    const upgraded = await listed(f, funnel);
    assert.equal(upgraded.updated_at, upgraded.created_at);
    assert.equal(upgraded.track_opens, true);
  } finally {
    f.dispose();
  }
});

test('the funnel list searches, filters and sorts by what the server counted', () => {
  const noon = (n: number) => new Date(2026, 0, n, 12).toISOString();
  const make = (
    id: number,
    values: Partial<Omit<Funnel, 'counts'>> & { counts?: Partial<FunnelCounts> },
  ): Funnel => ({
    id,
    project_id: 1,
    name: 'Funnel ' + id,
    audience: '',
    steps: [{ delay_days: 0, subject: 'Hello', body: '' }],
    status: 'DRAFT',
    revision: 1,
    created_at: noon(id),
    updated_at: noon(id),
    enrolled_count: 0,
    queued_count: 0,
    converted_count: 0,
    stop_on_reply: true,
    track_opens: true,
    fit_band: 'ANY',
    ...values,
    counts: { ...emptyCounts, ...values.counts },
  });
  const funnels = [
    make(1, {
      name: 'UAE engineering introduction',
      audience: 'Pump manufacturers',
      fit_band: 'HIGH',
      updated_at: noon(20),
    }),
    make(2, {
      name: 'Valve follow-up',
      audience: 'Valve makers',
      fit_band: 'EMAIL',
      steps: [
        { delay_days: 0, subject: 'Hello', body: '' },
        { delay_days: 3, subject: 'Following up', body: '' },
        { delay_days: 7, subject: 'Closing the loop', body: '' },
      ],
      status: 'ACTIVE',
      enrolled_count: 10,
      queued_count: 4,
      counts: { enrolled: 10, sent: 8, opened: 4, replied: 2, open_rate: 0.5, reply_rate: 0.25 },
    }),
    make(3, {
      name: 'Trade fair',
      steps: [{ delay_days: 0, subject: 'Meeting at Hannover Messe', body: '' }],
      status: 'ACTIVE',
      enrolled_count: 5,
      queued_count: 0,
      counts: {
        enrolled: 5,
        sent: 5,
        opened: 1,
        replied: 2,
        bounced: 1,
        open_rate: 0.2,
        reply_rate: 0.4,
      },
    }),
    make(4, {
      name: 'Paused one',
      audience: 'Pump manufacturers',
      status: 'PAUSED',
      enrolled_count: 3,
      queued_count: 3,
      counts: { enrolled: 3 },
    }),
  ];
  const ids = (patch: Partial<typeof emptyFunnelFilters>) =>
    filterFunnels(funnels, { ...emptyFunnelFilters, ...patch }).map((funnel) => funnel.id);
  assert.deepEqual(ids({}), [4, 3, 2, 1]);
  // Search covers the name, the audience and every message subject; every word must match.
  assert.deepEqual(ids({ search: 'hannover' }), [3]);
  assert.deepEqual(ids({ search: 'uae intro' }), [1]);
  assert.deepEqual(ids({ search: 'VALVE MAKERS' }), [2]);
  // Completed is a funnel that ran its course; it can still be Active.
  assert.deepEqual(funnels.map(funnelCompleted), [false, false, true, false]);
  assert.deepEqual(ids({ status: 'ACTIVE' }), [3, 2]);
  assert.deepEqual(ids({ status: 'COMPLETED' }), [3]);
  assert.deepEqual(ids({ status: 'PAUSED' }), [4]);
  assert.deepEqual(ids({ status: 'DRAFT' }), [1]);
  // Type: one email, or a sequence with follow-ups.
  assert.deepEqual(ids({ type: 'SEQUENCE' }), [2]);
  assert.deepEqual(ids({ type: 'SINGLE' }), [4, 3, 1]);
  // Campaign: the fit-score band the composer files the funnel under.
  assert.deepEqual(ids({ campaign: 'HIGH' }), [1]);
  assert.deepEqual(ids({ campaign: 'EMAIL' }), [2]);
  assert.deepEqual(ids({ campaign: 'ANY' }), [4, 3]);
  assert.deepEqual(ids({ search: 'high-quality' }), [1]);
  assert.deepEqual(ids({ type: 'SINGLE', campaign: 'ANY', status: 'PAUSED' }), [4]);
  // Performance bands read the server's rates; nothing sent has no rate and matches neither.
  assert.deepEqual(ids({ performance: 'REPLY_RATE_HIGH' }), [3, 2]);
  assert.deepEqual(ids({ performance: 'OPEN_RATE_HIGH' }), [2]);
  assert.deepEqual(ids({ performance: 'NO_REPLIES' }), []);
  assert.deepEqual(
    filterFunnels(
      [make(5, { counts: { enrolled: 3, sent: 3, open_rate: 0, reply_rate: 0 } })],
      { ...emptyFunnelFilters, performance: 'NO_REPLIES' },
    ).map((funnel) => funnel.id),
    [5],
  );
  assert.deepEqual(funnelAudiences(funnels), ['', 'Pump manufacturers', 'Valve makers']);
  assert.deepEqual(ids({ audience: '' }), [3]);
  assert.deepEqual(ids({ audience: 'Pump manufacturers' }), [4, 1]);
  assert.deepEqual(ids({ performance: 'REPLIES' }), [3, 2]);
  assert.deepEqual(ids({ performance: 'OPENS' }), [3, 2]);
  assert.deepEqual(ids({ performance: 'BOUNCES' }), [3]);
  assert.deepEqual(ids({ performance: 'NOT_SENT' }), [4, 1]);
  assert.deepEqual(ids({ created_from: '2026-01-02', created_to: '2026-01-03' }), [3, 2]);
  assert.deepEqual(ids({ created_from: '2026-01-03', created_to: '2026-01-02' }), [3, 2]);
  assert.deepEqual(ids({ sort: 'OLDEST' }), [1, 2, 3, 4]);
  assert.deepEqual(ids({ sort: 'UPDATED' }), [1, 4, 3, 2]);
  // Nothing sent means no rate: those go last, newest first.
  assert.deepEqual(ids({ sort: 'REPLY_RATE' }), [3, 2, 4, 1]);
  assert.deepEqual(ids({ sort: 'OPEN_RATE' }), [2, 3, 4, 1]);
  assert.deepEqual(ids({ sort: 'ENROLLED' }), [2, 3, 4, 1]);
  assert.equal(
    activeFunnelFilterCount({
      ...emptyFunnelFilters,
      search: 'valve',
      status: 'ACTIVE',
      created_from: '2026-01-01',
      created_to: '2026-01-31',
      sort: 'OLDEST',
    }),
    2,
  );
  assert.equal(
    activeFunnelFilterCount({
      ...emptyFunnelFilters,
      type: 'SEQUENCE',
      campaign: 'HIGH',
      performance: 'OPEN_RATE_HIGH',
    }),
    3,
  );
});

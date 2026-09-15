import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { sendMail, type Send, type SmtpConfig } from '../server/email';
import nodemailer from 'nodemailer';
import type { Lead, Project, TrainingSnapshot } from '../shared/types';
import type { Enrollment, Funnel, FunnelStep } from '../shared/funnels';

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

async function fixture(origin = 'https://research.example.com', transport?: Send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-funnels-'));
  const messages: Parameters<Send>[1][] = [];
  const options: Parameters<typeof createApp>[0] = {
    dataDir: dir,
    origin,
    sendMail:
      transport ||
      (async (_config, message) => {
        message.beforeSend?.();
        messages.push(message);
      }),
    generate: async (_config, _system, input) => {
      const snapshot = (input as { approved_training: TrainingSnapshot }).approved_training;
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
  const p = (
    await req('post', '/projects', { name: 'QA Pump Research', website: 'https://example.org' })
  ).body as Project;
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
  const base = `/projects/${p.id}`;
  let leadCounter = 0;
  return {
    req,
    messages,
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
    project: published.body as Project,
    async mailbox(copy = 'owner@example.com') {
      const result = await req('put', '/settings/email', {
        host: '8.8.8.8',
        port: 587,
        username: 'research@example.com',
        password: 'fake-mail-password',
        from_email: 'research@example.com',
        from_name: 'Research Team',
        signature: 'Research Team signature',
        copy_to: copy,
      });
      assert.equal(result.status, 200, result.text);
    },
    async lead(email = 'contact@pumps.example') {
      const created = await req('post', base + '/leads', {
        name: 'Pump Company ' + ++leadCounter,
        website: `https://pumps${leadCounter}.example`,
        contact_email: email,
      });
      assert.equal(created.status, 201, created.text);
      const qualified = await req('post', base + '/leads/' + created.body.id + '/qualify', {});
      assert.equal(qualified.status, 200, qualified.text);
      return (await req('get', base + '/leads/' + created.body.id)).body as Lead;
    },
    async funnel(messages = steps) {
      const result = await req('post', base + '/funnels', {
        name: 'Engineering introduction',
        audience: 'Pump manufacturers',
        steps: messages,
      });
      assert.equal(result.status, 201, result.text);
      return result.body as Funnel;
    },
    async enroll(funnel: Funnel, ...leads: Lead[]) {
      return req('post', `${base}/funnels/${funnel.id}/enrollments`, {
        lead_ids: leads.map((l) => l.id),
      });
    },
    async status(funnel: Funnel, status: 'ACTIVE' | 'PAUSED') {
      const latest = ((await req('get', base + '/funnels')).body.funnels as Funnel[]).find(
        (f) => f.id === funnel.id,
      )!;
      return req('patch', `${base}/funnels/${funnel.id}`, { status, revision: latest.revision });
    },
    async queue(funnel: Funnel) {
      const response = await req('get', `${base}/funnels/${funnel.id}/enrollments`);
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

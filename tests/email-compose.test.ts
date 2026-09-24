import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import nodemailer from 'nodemailer';
import type { FetchMessageObject } from 'imapflow';
import { createApp } from '../server/app';
import { RecipientRejected, sendMail, type Send, type SmtpConfig } from '../server/email';
import { parseReceived, type ReceivedMail } from '../server/imap';
import { detectBounce } from '../server/bounces';
import { emailTemplates } from '../server/email-templates';
import { blocksToHtml, htmlToText, sanitizeEmailHtml } from '../shared/email-html';
import { suggestCampaign } from '../shared/funnels';
import type { Lead, Project, TrainingSnapshot } from '../shared/types';
import type { Enrollment, Funnel, FunnelStep } from '../shared/funnels';

delete process.env.INNOVISTA_SETUP_TOKEN;
const day = 86_400_000;
const criteria = [
  'Manufactures industrial pumps',
  'Has its own engineering team',
  'Buys third-party bearings',
  'Operates in Europe',
];
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
const png = (width = 1200, height = 600) => {
  const data = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
};
const pdf = (size = 200) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size, 32)]);

async function fixture(deliver?: Send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-compose-'));
  const messages: Parameters<Send>[1][] = [];
  /** How many of the four rules a qualification matches: 4 → 100, 3 → 75, 1 → 25. */
  const state = {
    matches: criteria.length,
    suggestion: null as unknown,
    batch: { uid_validity: '1', last_uid: 0, messages: [] as ReceivedMail[] },
  };
  const instance = createApp({
    dataDir: dir,
    origin: 'https://research.example.com',
    readInbox: async () => state.batch,
    sendMail:
      deliver ||
      (async (_config, message) => {
        message.beforeSend?.();
        messages.push(message);
      }),
    generate: async (_config, system, input) => {
      if (/edit short business outreach emails/.test(system)) return state.suggestion;
      const snapshot = (input as { approved_training: TrainingSnapshot }).approved_training;
      return {
        decision: 'QUALIFIED',
        score: 100,
        confidence: 95,
        summary: 'The company manufactures pumps and buys third-party bearings.',
        criteria: snapshot.rubric.criteria.map((criterion, index) => ({
          criterion,
          outcome: index < state.matches ? 'MATCH' : 'NO_MATCH',
          evidence: 'The official website describes this.',
          source_ids: ['E2'],
        })),
        exclusions: snapshot.rubric.exclusions.map((criterion) => ({
          criterion,
          outcome: 'NO_MATCH',
          evidence: 'The official website states it buys third-party bearings.',
          source_ids: ['E2'],
        })),
        gaps: [],
        next_steps: [],
      };
    },
    fetchWebsite: async (url) => ({
      url,
      content:
        'The company manufactures industrial pumps with its own engineers in Europe. It buys third-party bearings.',
      truncated: false,
    }),
  });
  const agent = request.agent(instance.app);
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
    name: 'Compose Administrator',
    username: 'compose-admin',
    password: 'Disposable-compose-test-2026',
  });
  assert.equal(setup.status, 201, setup.text);
  csrf = setup.body.csrf_token;
  const created = (
    await req('post', '/projects', { name: 'Compose QA', website: 'https://example.org' })
  ).body as Project;
  assert.equal(
    (
      await req('post', `/projects/${created.id}/sources`, {
        revision: created.revision,
        title: 'Brief',
        content: 'Find industrial pump manufacturers with engineering teams in Europe.',
      })
    ).status,
    201,
  );
  const afterNote = (await req('get', `/projects/${created.id}`)).body.project as Project;
  assert.equal(
    (
      await req('post', `/projects/${created.id}/sources/website`, {
        revision: afterNote.revision,
        url: 'https://example.org',
      })
    ).status,
    201,
  );
  const current = (await req('get', `/projects/${created.id}`)).body.project as Project;
  const rubric = await req('put', `/projects/${created.id}/training/rubric`, {
    revision: current.revision,
    rubric: {
      summary: 'Find industrial pump manufacturers with their own engineering teams.',
      criteria,
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
  let counter = 0;
  return {
    req,
    state,
    messages,
    base,
    project,
    get db() {
      return instance.db;
    },
    worker: instance.funnels,
    async mailbox() {
      const saved = await req('put', `${base}/mailbox/email`, {
        host: '8.8.8.8',
        port: 587,
        username: 'research@example.com',
        password: 'fake-mail-password',
        from_email: 'research@example.com',
        from_name: 'Research Team',
        copy_to: 'owner@example.com',
      });
      assert.equal(saved.status, 200, saved.text);
    },
    async incoming() {
      const saved = await req('put', `${base}/mailbox/settings`, {
        revision: 0,
        host: '8.8.8.8',
        username: 'inbox@example.com',
        folder: 'INBOX',
        password: 'fake-incoming-password',
        enabled: true,
      });
      assert.equal(saved.status, 200, saved.text);
    },
    /** A lead, qualified with the current number of matching rules unless told not to be. */
    async lead(email = 'contact@pumps.example', qualify = true, name?: string) {
      const added = await req('post', `${base}/leads`, {
        name: name || 'Pump Company ' + ++counter,
        website: `https://pumps${++counter}.example`,
        contact_email: email,
        contact_name: 'Dana Prakash',
      });
      assert.equal(added.status, 201, added.text);
      if (qualify)
        assert.equal((await req('post', `${base}/leads/${added.body.id}/qualify`, {})).status, 200);
      return (await req('get', `${base}/leads/${added.body.id}`)).body as Lead;
    },
    async funnel(body: Partial<Funnel> & { steps?: FunnelStep[] } = {}) {
      const result = await req('post', `${base}/funnels`, {
        name: 'Engineering introduction',
        audience: 'Pump manufacturers',
        steps,
        ...body,
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
    async queue(funnel: Funnel) {
      return (await req('get', `${base}/funnels/${funnel.id}/enrollments`)).body
        .enrollments as Enrollment[];
    },
    upload(
      filename: string,
      data: Buffer,
      kind: 'attachment' | 'image' = 'attachment',
      target = base,
    ) {
      return agent
        .post('/api' + target + '/email/files')
        .set('Host', host)
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', csrf)
        .field('kind', kind)
        .attach('file', data, filename);
    },
    dispose() {
      instance.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the email dialect keeps only allowlisted tags, safe links and this project’s images', () => {
  const dirty =
    '<div onclick="steal()">Hello <b>there</b><script>alert(1)</script></div>' +
    '<h1 style="color:red;text-align:center">Big</h1>' +
    '<p><a href="javascript:alert(1)">bad</a> <a href="https://example.com/a?b=1&amp;c=2" target="_blank">good</a></p>' +
    '<img src="data:image/png;base64,AAAA"><img src="/api/projects/9/email/files/4" alt="elsewhere">' +
    '<img src="/api/projects/2/email/files/5" alt="ours" width="900" onerror="x()">' +
    '<style>p{color:red}</style><iframe src="https://evil.example"></iframe><table><tr><td>cell</td></tr></table>';
  const clean = sanitizeEmailHtml(dirty, { projectId: 2 });
  for (const banned of [
    '<script',
    'onclick',
    'onerror',
    'javascript:',
    'data:',
    '<style',
    'iframe',
    'target=',
    'color:red',
    'files/4',
  ])
    assert.ok(!clean.includes(banned), banned + ' survived: ' + clean);
  assert.ok(clean.includes('<p>Hello <b>there</b></p>'), clean);
  assert.ok(clean.includes('<h2 style="text-align:center">Big</h2>'), clean);
  assert.ok(clean.includes('<a href="https://example.com/a?b=1&amp;c=2">good</a>'), clean);
  assert.ok(
    clean.includes('<img src="/api/projects/2/email/files/5" alt="ours" width="560">'),
    clean,
  );
  assert.ok(clean.includes('cell'));
  // Nesting is repaired the way a browser would, and running it twice changes nothing.
  assert.equal(
    sanitizeEmailHtml('<p>one<p>two<ul><li>a<li>b</ul>'),
    '<p>one</p><p>two</p><ul><li>a</li><li>b</li></ul>',
  );
  assert.equal(sanitizeEmailHtml(clean, { projectId: 2 }), clean);
  assert.equal(
    htmlToText('<h2>Title</h2><ol><li>First</li><li>Second</li></ol>'),
    'TITLE\n\n1. First\n2. Second',
  );
  // Every block template still opens, as rich text.
  for (const template of emailTemplates) {
    const html = blocksToHtml(template.blocks);
    assert.ok(html.length > 20, template.id);
    assert.equal(sanitizeEmailHtml(html), html, template.id);
  }
});

test('attachments are allowlisted by type and size, kept per project and sent as real attachments', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead('dana@pumps.example', false);
    const brief = await f.upload('brief.pdf', pdf());
    assert.equal(brief.status, 201, brief.text);
    assert.equal(brief.body.content_type, 'application/pdf');
    assert.equal(brief.body.data, undefined);
    assert.equal((await f.upload('tool.exe', Buffer.from('MZ....'))).status, 400);
    const renamed = await f.upload('invoice.pdf', Buffer.from('MZ not a pdf'));
    assert.equal(renamed.status, 400);
    assert.match(renamed.body.error, /does not match/);
    const huge = await f.upload('huge.pdf', pdf(10 * 1024 * 1024));
    assert.equal(huge.status, 413, huge.text);
    const image = await f.upload('diagram.png', png(1200, 600), 'image');
    assert.equal(image.status, 201, image.text);
    assert.equal(image.body.width, 1200);
    assert.equal((await f.upload('notes.txt', Buffer.from('plain words'), 'image')).status, 400);
    assert.equal((await f.upload('notes.txt', Buffer.from('plain words'))).status, 201);
    // Another project cannot read or send this project's file.
    const other = (await f.req('post', '/projects', { name: 'Other project' })).body as Project;
    assert.equal(
      (await f.req('get', `/projects/${other.id}/email/files/${brief.body.id}`)).status,
      404,
    );
    const download = await f.req('get', `${f.base}/email/files/${brief.body.id}`);
    assert.equal(download.status, 200);
    assert.match(
      String(download.headers['content-disposition']),
      /attachment; filename="brief.pdf"/,
    );

    const sent = await f.req('post', `${f.base}/leads/${lead.id}/email`, {
      to: lead.contact_email,
      subject: 'The brief you asked for',
      html: '<p>Here is the brief for {{company}}.</p>',
      attachment_ids: [brief.body.id],
    });
    assert.equal(sent.status, 201, sent.text);
    const message = f.messages[0];
    assert.equal(message.attachments?.length, 1);
    assert.equal(message.attachments![0].filename, 'brief.pdf');
    assert.equal(message.attachments![0].contentType, 'application/pdf');
    assert.ok(message.attachments![0].content.equals(pdf()));
    const history = (await f.req('get', `${f.base}/leads/${lead.id}/email/files`)).body;
    assert.equal(history[sent.body.id][0].filename, 'brief.pdf');

    // Twenty megabytes per message, however the files are split.
    const parts = [];
    for (let i = 0; i < 3; i++)
      parts.push((await f.upload(`part${i}.pdf`, pdf(7 * 1024 * 1024))).body.id);
    const tooBig = await f.req('post', `${f.base}/leads/${lead.id}/email`, {
      to: lead.contact_email,
      subject: 'Everything at once',
      html: '<p>All the files.</p>',
      attachment_ids: parts,
    });
    assert.equal(tooBig.status, 413, tooBig.text);
    // A file id from another project is refused as unavailable, never read across projects.
    const otherFile = await f.upload('other.pdf', pdf(), 'attachment', `/projects/${other.id}`);
    assert.equal(otherFile.status, 201, otherFile.text);
    const crossed = await f.req('post', `${f.base}/leads/${lead.id}/email`, {
      to: lead.contact_email,
      subject: 'Someone else’s file',
      html: '<p>Attached.</p>',
      attachment_ids: [otherFile.body.id],
    });
    assert.equal(crossed.status, 400);
    assert.equal(f.messages.length, 1);
  } finally {
    f.dispose();
  }
});

test('a rich-text email is sanitized, merged as text and rendered Outlook-safe, with inline images', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead('dana@pumps.example', false, 'Pumps <b>&</b> Co');
    const image = (await f.upload('diagram.png', png(1200, 600), 'image')).body;
    const src = `/api/projects/${f.project.id}/email/files/${image.id}`;
    const html =
      '<h2>Hello {{contact_first_name}}</h2><p onclick="x()">A note for {{company}}.<script>alert(1)</script>' +
      ' <a href="javascript:alert(1)">bad link</a> <a href="https://example.com/book">Book a call</a></p>' +
      `<p><img src="${src}" alt="Pump diagram"></p><ul><li>Point one</li></ul>`;
    const preview = await f.req('post', `${f.base}/leads/${lead.id}/email/preview`, {
      subject: 'For {{company}}',
      html,
    });
    assert.equal(preview.status, 200, preview.text);
    assert.match(preview.body.html, /data:image\/png;base64,/);
    assert.deepEqual(preview.body.missing_merge_fields, []);
    const sent = await f.req('post', `${f.base}/leads/${lead.id}/email`, {
      to: lead.contact_email,
      subject: 'For {{company}}',
      html,
    });
    assert.equal(sent.status, 201, sent.text);
    const message = f.messages[0];
    assert.equal(message.subject, 'For Pumps <b>&</b> Co');
    assert.match(message.html, /<table role="presentation"/);
    for (const banned of ['<script', 'onclick', 'javascript:', '<style', 'class=', '{{'])
      assert.ok(!message.html.includes(banned), banned);
    // A lead field is text: its markup is escaped, never interpreted.
    assert.ok(message.html.includes('Pumps &lt;b&gt;&amp;&lt;/b&gt; Co'));
    assert.match(message.html, /<p style="[^"]*font-size:15px/);
    assert.match(message.html, new RegExp(`src="cid:file-${image.id}@innovista"`));
    assert.match(message.html, /width="560"/);
    const inline = message.attachments!.find((file) => file.cid);
    assert.equal(inline?.cid, `file-${image.id}@innovista`);
    assert.match(message.text, /HELLO DANA/);
    assert.match(message.text, /Book a call \(https:\/\/example.com\/book\)/);
    assert.match(message.text, /- Point one/);
    // A merge field that cannot be filled blocks the send.
    const missing = await f.req('post', `${f.base}/leads/${lead.id}/email`, {
      to: lead.contact_email,
      subject: 'Hello',
      html: '<p>Hello {{contact_role}}</p>',
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /contact_role/);
  } finally {
    f.dispose();
  }
});

test('a permanent SMTP rejection bounces the address, stops its sequence and suppresses it', async () => {
  let attempts = 0;
  const delivered: Parameters<Send>[1][] = [];
  const f = await fixture(async (_config, message) => {
    message.beforeSend?.();
    attempts++;
    if (message.to === 'gone@pumps.example') throw new RecipientRejected(message.to, 550);
    delivered.push(message);
  });
  try {
    await f.mailbox();
    const lead = await f.lead('gone@pumps.example');
    const funnel = await f.funnel();
    assert.equal(
      (await f.req('post', `${f.base}/funnels/${funnel.id}/enrollments`, { lead_ids: [lead.id] }))
        .status,
      201,
    );
    await f.activate(funnel);
    await f.worker.tick(Date.now() + 100);
    const [enrollment] = await f.queue(funnel);
    assert.equal(enrollment.status, 'STOPPED');
    assert.equal(enrollment.stop_cause, 'BOUNCED');
    assert.match(enrollment.reason, /bounced/);
    const after = (await f.req('get', `${f.base}/leads/${lead.id}`)).body as Lead;
    assert.equal(after.outreach_status, 'BOUNCED');
    assert.match(after.emails![0].error, /rejected this address permanently/);
    assert.ok(after.outreach_events?.some((event) => event.outcome === 'BOUNCED'));
    assert.equal(after.status, lead.status);
    assert.ok(
      f.db.prepare("SELECT 1 FROM email_suppressions WHERE recipient='gone@pumps.example'").get(),
    );
    // Nothing more is attempted: not the follow-ups, not a hand-written email.
    await f.worker.tick(Date.now() + 30 * day);
    const direct = await f.req('post', `${f.base}/leads/${lead.id}/email`, {
      to: lead.contact_email,
      subject: 'Trying again',
      body: 'This must be refused because the address bounced.',
    });
    assert.equal(direct.status, 409);
    assert.match(direct.body.error, /bounced/);
    assert.equal(attempts, 1);
    const progress = ((await f.req('get', `${f.base}/funnels`)).body.funnels as Funnel[])[0]
      .progress!;
    assert.equal(progress.bounced, 1);
  } finally {
    f.dispose();
  }
});

test('the transport reports a 5xx RCPT refusal as a rejected recipient, never with the server text', async (t) => {
  let result: unknown = {};
  let failure: unknown = null;
  t.mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async () => {
      if (failure) throw failure;
      return result;
    },
    close: () => {},
  }));
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
    to: 'gone@pumps.example',
    bcc: 'owner@example.com',
    subject: 'QA',
    text: 'Test',
    html: '<p>Test</p>',
    replyTo: 'research@example.com',
  };
  const refusal = {
    code: 'EENVELOPE',
    command: 'RCPT TO',
    responseCode: 550,
    recipient: 'gone@pumps.example',
    response: '550 5.1.1 secret-detail no such user',
  };
  // The copy address took it, the recipient did not.
  result = {
    accepted: ['owner@example.com'],
    rejected: ['gone@pumps.example'],
    rejectedErrors: [refusal],
  };
  await assert.rejects(sendMail(config, message), (error: unknown) => {
    assert.ok(error instanceof RecipientRejected);
    assert.equal(error.responseCode, 550);
    assert.ok(!error.message.includes('secret-detail'));
    return true;
  });
  // Every recipient refused: nodemailer throws instead.
  failure = Object.assign(new Error("Can't send mail - all recipients were rejected"), {
    code: 'EENVELOPE',
    command: 'RCPT TO',
    responseCode: 550,
    rejectedErrors: [refusal],
  });
  await assert.rejects(sendMail(config, message), RecipientRejected);
  // A temporary refusal is not a bounce: it stays an unconfirmed delivery.
  failure = Object.assign(new Error('try later'), {
    code: 'EENVELOPE',
    command: 'RCPT TO',
    responseCode: 451,
    rejectedErrors: [{ ...refusal, responseCode: 451 }],
  });
  await assert.rejects(sendMail(config, message), (error: unknown) => {
    assert.ok(!(error instanceof RecipientRejected));
    assert.match(String((error as Error).message), /mail server rejected/);
    return true;
  });
});

/** A delivery-status notification as Gmail sends it, about one of our messages. */
function dsn(recipient: string, originalId: string, action = 'failed', status = '5.1.1') {
  return Buffer.from(
    [
      'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
      'To: research@example.com',
      'Subject: Delivery Status Notification (Failure)',
      'Message-ID: <dsn-' + Math.random().toString(36).slice(2) + '@mx.example>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status;',
      '\tboundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      "Your message wasn't delivered to " + recipient + ' because the address could not be found.',
      '',
      '--b1',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; googlemail.com',
      '',
      'Final-Recipient: rfc822; ' + recipient,
      'Action: ' + action,
      'Status: ' + status,
      'Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist.',
      '',
      '--b1',
      'Content-Type: message/rfc822',
      '',
      'Message-ID: ' + originalId,
      'From: Research Team <research@example.com>',
      'To: missing@pumps.example',
      'Subject: Hello',
      '',
      'Hello.',
      '--b1--',
      '',
    ].join('\r\n'),
  );
}
async function received(source: Buffer, uid: number) {
  return parseReceived({
    seq: uid,
    uid,
    size: source.length,
    source,
    internalDate: new Date(),
    envelope: {
      from: [{ address: 'mailer-daemon@googlemail.com', name: 'Mail Delivery Subsystem' }],
      to: [{ address: 'research@example.com' }],
      subject: 'Delivery Status Notification (Failure)',
    },
  } as FetchMessageObject);
}

test('a bounce report arriving in the project inbox stops the sequence, suppresses and marks the lead', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    await f.incoming();
    const lead = await f.lead('missing@pumps.example');
    const funnel = await f.funnel();
    await f.req('post', `${f.base}/funnels/${funnel.id}/enrollments`, { lead_ids: [lead.id] });
    await f.activate(funnel);
    await f.worker.tick(Date.now() + 100);
    assert.equal(f.messages.length, 1);
    const original = f.messages[0].messageId!;

    // A delay is not a bounce.
    const delayed = detectBounce(
      dsn('missing@pumps.example', original, 'delayed', '4.4.7').toString('latin1'),
      {
        from_email: 'mailer-daemon@googlemail.com',
        subject: 'Delivery delayed',
      },
    );
    assert.equal(delayed?.permanent, false);
    // A plain-text daemon report counts only when it says so and names the address.
    const plain = detectBounce(
      'Subject: failure notice\r\n\r\nSorry, we were unable to deliver your message to the following address.\r\n\r\n<missing@pumps.example>: 550 5.1.1 user unknown\r\n\r\n--- Below this line is a copy of the message.\r\n\r\nReceived: by mx\r\nMessage-ID: ' +
        original +
        '\r\nTo: missing@pumps.example\r\n',
      { from_email: 'MAILER-DAEMON@mx.example', subject: 'failure notice' },
    );
    assert.equal(plain?.permanent, true);
    assert.deepEqual(plain?.mentioned, ['missing@pumps.example']);
    assert.deepEqual(plain?.original_message_ids, [original]);
    // An ordinary message is not a report at all.
    assert.equal(
      detectBounce('Subject: Hi\r\n\r\nThanks!', {
        from_email: 'dana@pumps.example',
        subject: 'Hi',
      }),
      undefined,
    );
    // A report about the copy address quotes our message but must not touch the lead.
    const copy = await received(dsn('owner@example.com', original), 1);
    assert.equal(copy.bounce?.permanent, true);
    assert.deepEqual(copy.bounce?.recipients, ['owner@example.com']);
    f.state.batch = { uid_validity: '1', last_uid: 1, messages: [copy] };
    assert.equal((await f.req('post', `${f.base}/mailbox/sync`)).status, 200);
    assert.equal((await f.queue(funnel))[0].status, 'QUEUED');
    assert.ok(
      !f.db
        .prepare("SELECT 1 FROM email_suppressions WHERE recipient='missing@pumps.example'")
        .get(),
    );

    const report = await received(dsn('missing@pumps.example', original), 2);
    assert.equal(report.bounce?.permanent, true);
    assert.deepEqual(report.bounce?.original_message_ids, [original]);
    f.state.batch = { uid_validity: '1', last_uid: 2, messages: [report] };
    const sync = await f.req('post', `${f.base}/mailbox/sync`);
    assert.equal(sync.body.received, 1);
    const [enrollment] = await f.queue(funnel);
    assert.equal(enrollment.status, 'STOPPED');
    assert.equal(enrollment.stop_cause, 'BOUNCED');
    const after = (await f.req('get', `${f.base}/leads/${lead.id}`)).body as Lead;
    assert.equal(after.outreach_status, 'BOUNCED');
    assert.equal(after.status, lead.status);
    assert.ok(
      f.db
        .prepare("SELECT 1 FROM email_suppressions WHERE recipient='missing@pumps.example'")
        .get(),
    );
    // The report is filed with the lead it was about, not treated as a reply.
    const incoming = (await f.req('get', `${f.base}/leads/${lead.id}/incoming`)).body;
    assert.equal(incoming.length, 1);
    assert.match(incoming[0].notice, /Delivery failure report/);
    assert.ok(!after.outreach_events?.some((event) => event.outcome === 'REPLIED'));
    await f.worker.tick(Date.now() + 30 * day);
    assert.equal(f.messages.length, 1);
    const draft = (await f.req('get', `${f.base}/leads/${lead.id}/email/draft`)).body;
    assert.equal(draft.bounced.recipient, 'missing@pumps.example');
  } finally {
    f.dispose();
  }
});

test('stop-on-reply is a per-funnel option: on by default, and off keeps the sequence going', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    await f.incoming();
    const stops = await f.funnel({ name: 'Stops on reply' });
    const continues = await f.funnel({ name: 'Keeps going', stop_on_reply: false });
    assert.equal(stops.stop_on_reply, true);
    assert.equal(continues.stop_on_reply, false);
    const first = await f.lead('first@pumps.example');
    const second = await f.lead('second@pumps.example');
    await f.req('post', `${f.base}/funnels/${stops.id}/enrollments`, { lead_ids: [first.id] });
    await f.req('post', `${f.base}/funnels/${continues.id}/enrollments`, { lead_ids: [second.id] });
    await f.activate(stops);
    await f.activate(continues);
    const start = Date.now() + 100;
    await f.worker.tick(start);
    await f.worker.tick(start + 60_000);
    assert.equal(f.messages.length, 2);
    const reply = (to: string, uid: number): ReceivedMail => ({
      uid,
      message_id: `<reply-${uid}@pumps.example>`,
      references: [f.messages.find((m) => m.to === to)!.messageId!],
      from_email: to,
      from_name: 'Customer',
      to_email: 'research@example.com',
      subject: 'Re: Hello',
      body: 'Thanks, tell me more.',
      received_at: new Date(Date.now() + 1000).toISOString(),
      attachment_count: 0,
      notice: '',
    });
    f.state.batch = {
      uid_validity: '1',
      last_uid: 2,
      messages: [reply('first@pumps.example', 1), reply('second@pumps.example', 2)],
    };
    assert.equal((await f.req('post', `${f.base}/mailbox/sync`)).body.received, 2);
    assert.equal((await f.queue(stops))[0].status, 'REPLIED');
    const [going] = await f.queue(continues);
    assert.equal(going.status, 'QUEUED');
    assert.equal(
      ((await f.req('get', `${f.base}/leads/${second.id}`)).body as Lead).outreach_status,
      'REPLIED',
    );
    await f.worker.tick(going.next_send_at + 120_000);
    assert.equal(f.messages.length, 3);
    assert.equal(f.messages[2].to, 'second@pumps.example');
    assert.equal(f.messages[2].subject, 'Following up');
    // A response recorded by hand always stops it.
    await f.req('post', `${f.base}/leads/${second.id}/outreach-events`, {
      outcome: 'REPLIED',
      notes: 'They asked us to wait.',
    });
    assert.equal((await f.queue(continues))[0].status, 'REPLIED');
  } finally {
    f.dispose();
  }
});

test('the composer offers every campaign plus a one-off email and pre-selects by fit score', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const high = await f.funnel({ name: 'High-quality campaign', fit_band: 'HIGH' });
    const email = await f.funnel({ name: 'Email campaign', fit_band: 'EMAIL' });
    await f.funnel({ name: 'Any score' });
    const best = await f.lead('best@pumps.example');
    assert.equal(best.score, 100);
    const offer = (await f.req('get', `${f.base}/leads/${best.id}/email/draft`)).body;
    assert.equal(offer.campaigns.length, 3);
    assert.equal(offer.suggested.funnel_id, high.id);
    assert.match(offer.campaigns[0].steps[0].html, /<p>/);
    assert.equal(offer.mailbox.from_email, 'research@example.com');
    f.state.matches = 3;
    const good = await f.lead('good@pumps.example');
    assert.equal(good.score, 75);
    assert.equal(
      (await f.req('get', `${f.base}/leads/${good.id}/email/draft`)).body.suggested.funnel_id,
      email.id,
    );
    f.state.matches = 1;
    const weak = await f.lead('weak@pumps.example');
    const weakOffer = (await f.req('get', `${f.base}/leads/${weak.id}/email/draft`)).body;
    assert.equal(weakOffer.suggested.funnel_id, null);
    assert.match(weakOffer.suggested.reason, /below 50/);
    // Not qualified: every campaign says why it cannot start, so one-off is the only choice.
    assert.ok(weakOffer.campaigns.every((campaign: { blocked: string }) => campaign.blocked));
    // The rule itself.
    const campaigns = [
      { id: 1, fit_band: 'HIGH' as const, status: 'DRAFT' as const },
      { id: 2, fit_band: 'HIGH' as const, status: 'ACTIVE' as const },
      { id: 3, fit_band: 'EMAIL' as const, status: 'ACTIVE' as const, blocked: 'Not qualified.' },
    ];
    assert.equal(suggestCampaign({ score: 91 }, campaigns).funnel_id, 2);
    assert.equal(suggestCampaign({ score: 64 }, campaigns).funnel_id, null);
    assert.match(suggestCampaign({ score: 64 }, campaigns).reason, /Not qualified/);
    assert.equal(suggestCampaign({ score: 91, stale: true }, campaigns).funnel_id, null);
    assert.equal(suggestCampaign({ score: null }, campaigns).funnel_id, null);
  } finally {
    f.dispose();
  }
});

test('sending the first email starts the chosen campaign with its follow-ups at the chosen times', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const funnel = await f.funnel({ name: 'High-quality campaign', fit_band: 'HIGH' });
    await f.activate(funnel);
    const lead = await f.lead('dana@pumps.example');
    const url = `${f.base}/leads/${lead.id}/email`;
    await f.req('put', url + '/draft', {
      revision: 0,
      to: lead.contact_email,
      subject: 'Hi',
      preview_text: '',
      html: '<p>Hi</p>',
    });
    const followups = [
      new Date(Date.now() + 2 * day).toISOString(),
      new Date(Date.now() + 5 * day).toISOString(),
    ];
    const message = {
      to: lead.contact_email,
      subject: 'A question for {{company}}',
      html: '<p>Hello {{contact_first_name}}, a question about your pumps.</p>',
      funnel_id: funnel.id,
      followups,
      clear_draft: true,
    };
    // Checked before anything is sent: another address, or follow-ups too close together.
    const elsewhere = await f.req('post', url, { ...message, to: 'someone@else.example' });
    assert.equal(elsewhere.status, 400);
    const crowded = await f.req('post', url, {
      ...message,
      followups: [new Date(Date.now() + 3_600_000).toISOString(), followups[1]],
    });
    assert.equal(crowded.status, 400);
    assert.match(crowded.body.error, /12 hours/);
    assert.equal(f.messages.length, 0);

    const sent = await f.req('post', url, message);
    assert.equal(sent.status, 201, sent.text);
    assert.equal(sent.body.campaign.funnel_id, funnel.id);
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0].subject, /Pump Company/);
    const [enrollment] = await f.queue(funnel);
    assert.equal(enrollment.status, 'QUEUED');
    assert.equal(enrollment.next_step, 1);
    assert.equal(enrollment.next_send_at, Date.parse(followups[0]));
    assert.equal((await f.req('get', url + '/draft')).body.saved.document, null);
    // The follow-ups leave at the times chosen, not at the funnel's own delays.
    await f.worker.tick(Date.parse(followups[0]) - 1000);
    assert.equal(f.messages.length, 1);
    await f.worker.tick(Date.parse(followups[0]));
    assert.equal(f.messages.length, 2);
    assert.equal(f.messages[1].subject, 'Following up');
    assert.equal((await f.queue(funnel))[0].next_send_at, Date.parse(followups[1]));
    // The same campaign cannot be started twice, and nothing is sent when it is refused.
    const again = await f.req('post', url, { ...message, followups: undefined });
    assert.equal(again.status, 409);
    assert.equal(f.messages.length, 2);
    // A lead that cannot follow on is refused before its first message.
    const unqualified = await f.lead('new@pumps.example', false);
    const refused = await f.req('post', `${f.base}/leads/${unqualified.id}/email`, {
      ...message,
      to: unqualified.contact_email,
    });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /current, qualified result/);
    assert.equal(f.messages.length, 2);
  } finally {
    f.dispose();
  }
});

test('archiving hides a lead, stops its sequences and is reversible; archiving below 50 needs confirming', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead('closed@pumps.example');
    const funnel = await f.funnel();
    await f.req('post', `${f.base}/funnels/${funnel.id}/enrollments`, { lead_ids: [lead.id] });
    assert.equal(
      (await f.req('post', `${f.base}/leads/${lead.id}/archive`, { reason: 'OTHER', note: '' }))
        .status,
      400,
    );
    const archived = await f.req('post', `${f.base}/leads/${lead.id}/archive`, {
      reason: 'COMPANY_CLOSED',
    });
    assert.equal(archived.status, 200, archived.text);
    assert.equal(archived.body.archived_reason, 'Company closed');
    const list = (await f.req('get', `${f.base}/leads`)).body;
    assert.ok(!list.leads.some((row: Lead) => row.id === lead.id));
    const shelf = (await f.req('get', `${f.base}/leads?archived=only`)).body;
    assert.deepEqual(
      shelf.leads.map((row: Lead) => row.id),
      [lead.id],
    );
    assert.equal((await f.req('get', `${f.base}/archive`)).body.total, 1);
    const [enrollment] = await f.queue(funnel);
    assert.equal(enrollment.status, 'STOPPED');
    assert.equal(enrollment.stop_cause, 'ARCHIVED');
    // Nothing is deleted: the record is still there, and cannot be emailed while archived.
    const detail = (await f.req('get', `${f.base}/leads/${lead.id}`)).body as Lead;
    assert.equal(detail.archived_reason, 'Company closed');
    assert.equal(detail.status, lead.status);
    const blocked = await f.req('post', `${f.base}/leads/${lead.id}/email`, {
      to: lead.contact_email,
      subject: 'Hello there',
      body: 'This is long enough to be sent if the lead were not archived.',
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /archived/);
    const other = (await f.req('post', '/projects', { name: 'Other project' })).body as Project;
    assert.equal(
      (await f.req('post', `/projects/${other.id}/leads/${lead.id}/restore`, {})).status,
      404,
    );
    assert.equal((await f.req('post', `${f.base}/leads/${lead.id}/restore`, {})).status, 200);
    assert.ok(
      (await f.req('get', `${f.base}/leads`)).body.leads.some((row: Lead) => row.id === lead.id),
    );

    f.state.matches = 1;
    await f.lead('low1@pumps.example');
    await f.lead('low2@pumps.example');
    const preview = (await f.req('get', `${f.base}/archive/below-50`)).body;
    assert.equal(preview.count, 2);
    assert.ok(preview.leads.every((row: { score: number }) => row.score < 50));
    assert.equal(
      (await f.req('post', `${f.base}/archive/below-50`, { confirm: true, expected: 1 })).status,
      409,
    );
    assert.equal((await f.req('post', `${f.base}/archive/below-50`, { expected: 2 })).status, 400);
    const bulk = await f.req('post', `${f.base}/archive/below-50`, { confirm: true, expected: 2 });
    assert.equal(bulk.body.archived, 2);
    assert.equal((await f.req('get', `${f.base}/leads`)).body.total, 1);
    const shelved = (await f.req('get', `${f.base}/archive`)).body.leads;
    assert.ok(
      shelved.every((row: { archived_reason: string }) => row.archived_reason === 'Score below 50'),
    );
  } finally {
    f.dispose();
  }
});

test('opening the email tab saves a draft at once: rich text, campaign and files, listed under My drafts', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead('dana@pumps.example', false);
    const file = (await f.upload('brief.pdf', pdf())).body;
    const url = `${f.base}/leads/${lead.id}/email/draft`;
    const saved = await f.req('put', url, {
      revision: 0,
      to: lead.contact_email,
      subject: 'Draft subject',
      preview_text: '',
      html: '<p onclick="x()">Hi</p><script>alert(1)</script>',
      funnel_id: null,
      attachment_ids: [file.id],
      followups: [],
    });
    assert.equal(saved.status, 200, saved.text);
    const opened = (await f.req('get', url)).body;
    assert.equal(opened.saved.document.html, '<p>Hi</p>');
    assert.deepEqual(
      opened.files.map((meta: { id: number }) => meta.id),
      [file.id],
    );
    const drafts = (await f.req('get', `${f.base}/mailbox?folder=drafts`)).body;
    assert.equal(drafts.items[0].subject, 'Draft subject');
    // A draft from the block editor opens as rich text.
    await f.req('put', url, {
      revision: 1,
      to: lead.contact_email,
      subject: 'Old',
      preview_text: '',
      blocks: [{ type: 'text', text: 'Written with blocks.', align: 'left' }],
    });
    assert.equal((await f.req('get', url)).body.saved.document.html, '<p>Written with blocks.</p>');
    assert.equal((await f.req('delete', url)).body.document, null);
  } finally {
    f.dispose();
  }
});

test('Improve with AI returns a sanitized suggestion and never sends or saves anything', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const lead = await f.lead('dana@pumps.example', false);
    const image = (await f.upload('diagram.png', png(), 'image')).body;
    const src = `/api/projects/${f.project.id}/email/files/${image.id}`;
    const url = `${f.base}/leads/${lead.id}/email/improve`;
    f.state.suggestion = {
      subject: 'A clearer\r\nsubject',
      html: '<p>Improved note for {{company}}.</p><script>alert(1)</script><img src="https://tracker.example/p.png" onerror="x()">',
      notes: 'Shorter and clearer.',
    };
    const improved = await f.req('post', url, {
      subject: 'Hello',
      html: `<p>hello this is my note for {{company}}</p><p><img src="${src}" alt="Diagram"></p>`,
    });
    assert.equal(improved.status, 200, improved.text);
    assert.equal(improved.body.subject, 'A clearer subject');
    assert.ok(!improved.body.html.includes('<script'));
    assert.ok(!improved.body.html.includes('onerror'));
    assert.ok(improved.body.html.includes('{{company}}'));
    // The author's image survives even though the suggestion dropped it.
    assert.ok(improved.body.html.includes(src));
    assert.equal(f.messages.length, 0);
    assert.equal(
      (await f.req('get', `${f.base}/leads/${lead.id}/email/draft`)).body.saved.document,
      null,
    );
    f.state.suggestion = { nonsense: true };
    assert.equal((await f.req('post', url, { html: '<p>Some text</p>' })).status, 502);
    assert.equal((await f.req('post', url, { html: '<p> </p>' })).status, 400);
  } finally {
    f.dispose();
  }
});

test('a saved template keeps its image, and a campaign built from it sends the image inline', async () => {
  const f = await fixture();
  try {
    await f.mailbox();
    const image = (await f.upload('diagram.png', png(300, 200), 'image')).body;
    const brief = (await f.upload('brief.pdf', pdf())).body;
    const src = `/api/projects/${f.project.id}/email/files/${image.id}`;
    const template = await f.req('post', `${f.base}/email/templates`, {
      name: 'With diagram',
      category: 'outreach',
      subject: 'A diagram for {{company}}',
      html: `<p>Hello {{company}}</p><p><img src="${src}" alt="Diagram"></p><script>x</script>`,
    });
    assert.equal(template.status, 201, template.text);
    const library = (await f.req('get', `${f.base}/email/templates`)).body.templates;
    assert.equal(library[0].name, 'With diagram');
    assert.ok(library[0].html.includes(src));
    assert.ok(!library[0].html.includes('<script'));
    assert.ok(library.some((t: { name: string }) => t.name === 'Last email · final follow-up'));
    const missing = await f.req('post', `${f.base}/funnels`, {
      name: 'Broken',
      steps: [
        {
          delay_days: 0,
          subject: 'Hi',
          body: '',
          html: `<p>Hi</p><p><img src="${src}9" alt=""></p>`,
        },
      ],
    });
    assert.equal(missing.status, 400);
    const funnel = await f.funnel({
      name: 'Diagram campaign',
      steps: [
        {
          delay_days: 0,
          subject: library[0].subject,
          body: '',
          html: library[0].html,
          attachment_ids: [brief.id],
        },
      ],
    });
    const lead = await f.lead('dana@pumps.example');
    await f.req('post', `${f.base}/funnels/${funnel.id}/enrollments`, { lead_ids: [lead.id] });
    await f.activate(funnel);
    await f.worker.tick(Date.now() + 100);
    const sent = f.messages[0];
    assert.match(sent.html, new RegExp(`cid:file-${image.id}@innovista`));
    assert.deepEqual(
      sent.attachments!.map((file) => [file.filename, Boolean(file.cid)]),
      [
        ['diagram.png', true],
        ['brief.pdf', false],
      ],
    );
    assert.match(sent.text, /Hello Pump Company/);
  } finally {
    f.dispose();
  }
});

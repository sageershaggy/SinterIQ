// Disposable UI test server. Uses mocked AI and website content; never loads .env or the user's database.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import type { TrainingSnapshot } from '../shared/types';
import type { ReceivedMail } from '../server/imap';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-browser-'));
const simulatedInbox: ReceivedMail[] = [];
const simulatedSent: string[] = [];
const { app, db } = createApp({
  dataDir: directory,
  sendMail: async (_config, message) => {
    message.beforeSend?.();
    simulatedSent.push(message.messageId || '');
  },
  readInbox: async () => ({
    uid_validity: 'qa-1',
    last_uid: simulatedInbox.length,
    messages: simulatedInbox,
  }),
  generate: async (_config, system, input) => {
    if (system.includes('proposed qualification rubric'))
      return {
        summary: 'QA fixture: find manufacturers of industrial pumps with design authority.',
        criteria: ['Manufactures industrial pumps', 'Has engineering authority'],
        exclusions: ['Manufactures bearings as its primary product'],
        questions: [],
      };
    const { approved_training } = input as {
      approved_training: TrainingSnapshot;
    };
    return {
      decision: 'QUALIFIED',
      score: 100,
      confidence: 89,
      summary:
        'UI test fixture: this example company manufactures industrial pumps and has its own engineering team. Its published product description supports a potential bearing application.',
      criteria: approved_training.rubric.criteria.map((criterion) => ({
        criterion,
        outcome: 'MATCH',
        evidence:
          'The test source states that the company manufactures pumps and specifies third-party components.',
        source_ids: ['E2'],
      })),
      exclusions: approved_training.rubric.exclusions.map((criterion) => ({
        criterion,
        outcome: 'NO_MATCH',
        evidence: 'The test source says bearings are purchased from suppliers.',
        source_ids: ['E2'],
      })),
      gaps: [],
      next_steps: ['Confirm application requirements with the company.'],
    };
  },
  fetchWebsite: async (url) => ({
    url,
    content:
      'QA source fixture. This business manufactures industrial pumps and has an in-house engineering team. It buys bearings from suppliers instead of producing bearings. Products operate in corrosive chemical environments. ' +
      url +
      ' Published business contact: contact@' +
      new URL(url).hostname,
    truncated: false,
  }),
});
app.use(express.static(path.resolve('dist')));
const server = app.listen(3100, '127.0.0.1', async () => {
  const root = 'http://127.0.0.1:3100/api';
  const setup = await fetch(root + '/auth/setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Innovista',
    },
    body: JSON.stringify({
      name: 'Interface QA',
      username: 'interface-qa',
      password: 'Browser-QA-only-2026',
    }),
  });
  const session = (await setup.json()) as { csrf_token: string };
  const headers = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'Innovista',
    'X-CSRF-Token': session.csrf_token,
    Cookie: setup.headers.get('set-cookie')!.split(';')[0],
  };
  const api = async (url: string, body?: object, method = 'POST') => {
    const response = await fetch(root + url, {
      method: body ? method : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok)
      throw new Error('QA fixture setup failed: ' + url + ' (' + response.status + ')');
    return response.json();
  };
  const project = await api('/projects', {
    name: 'Meeting updates · QA',
    website: 'https://example.org',
    description: 'Disposable preview with simulated research and mail delivery.',
  });
  const base = '/projects/' + project.id;
  await api(base + '/sources', {
    revision: project.revision,
    title: 'QA training brief',
    content:
      'Find industrial pump manufacturers with engineering authority. Exclude bearing manufacturers.',
  });
  let current = (await api(base)).project;
  await api(base + '/sources/website', { revision: current.revision, url: 'https://example.org' });
  current = (await api(base)).project;
  const rubric = await api(
    base + '/training/rubric',
    {
      revision: current.revision,
      rubric: {
        summary: 'Find industrial pump manufacturers with engineering authority.',
        criteria: ['Manufactures industrial pumps', 'Has engineering authority'],
        exclusions: ['Manufactures bearings as its primary product'],
        questions: [],
      },
    },
    'PUT',
  );
  await api(base + '/training/publish', { revision: rubric.revision });
  for (const [name, industry, country, website] of [
    ['Example Pumps — QA fixture', 'Industrial pumps', 'Germany', 'https://example.com'],
    [
      'Example Process Systems — QA fixture',
      'Chemical equipment',
      'Netherlands',
      'https://example.org',
    ],
    ['Example Precision — QA fixture', 'Engineering', 'Germany', 'https://example.net'],
  ]) {
    const lead = await api(base + '/leads', {
      name,
      industry,
      country,
      website,
      contact_email: 'contact@' + new URL(website).hostname,
    });
    await api(base + '/leads/' + lead.id + '/qualify', {});
  }
  const unreviewed = await api(base + '/leads', {
    name: 'New company — not researched yet',
    country: 'UAE',
    contact_email: 'hello@example.org',
  });
  const starter = (await api('/projects')).find((p: { is_starter: boolean }) => p.is_starter);
  await api('/projects/' + starter.id + '/leads', {
    name: 'Draft training — QA example',
    country: 'Germany',
  });
  const funnel = await api(base + '/funnels', {
    name: 'Engineering introduction',
    audience: 'Qualified engineering contacts',
    steps: [
      {
        delay_days: 0,
        subject: 'A question for {{company}}',
        body: 'Hello, could our engineering services help {{company}}? Best regards, {{sender_name}}.',
      },
      {
        delay_days: 3,
        subject: 'Following up with {{company}}',
        body: 'Following up on my introduction. Would a short conversation be useful?',
      },
      {
        delay_days: 7,
        subject: 'Closing the loop',
        body: 'This is my final follow-up. Please reply if a conversation would be useful.',
      },
    ],
  });
  const sample = {
    subject: 'A short introduction for {{company}}',
    preview_text: 'A question about working together.',
    blocks: [
      {
        type: 'text',
        text: 'Hello,\n\nI was reading about {{company}} and wanted to understand your current requirements. Would a short introduction be useful?\n\nBest regards',
        align: 'left',
      },
    ],
  };
  await api(base + '/email/templates', {
    name: 'Project introduction',
    category: 'outreach',
    description: 'A reusable introduction for this project',
    ...sample,
  });
  await api(
    base + '/leads/' + unreviewed.id + '/email/draft',
    { revision: 0, to: unreviewed.contact_email, ...sample },
    'PUT',
  );
  const qualified = await api(base + '/leads?status=QUALIFIED');
  await api(base + '/funnels/' + funnel.id + '/enrollments', { lead_ids: [qualified.leads[0].id] });
  await api(
    '/settings/email',
    {
      host: '8.8.8.8',
      port: 587,
      username: 'support@example.com',
      password: 'simulated-mail-only',
      from_name: 'QA Support Team',
      from_email: 'support@example.com',
      copy_to: 'owner@example.com',
    },
    'PUT',
  );
  await api(base + '/leads/1/email', {
    to: 'contact@example.com',
    subject: 'Support for Example Pumps',
    body: 'Hello, how can we help your team with its engineering requirements?',
  });
  simulatedInbox.push({
    uid: 1,
    message_id: '<qa-reply@example.com>',
    references: [simulatedSent[0]],
    from_email: 'contact@example.com',
    from_name: 'Example Pumps team',
    to_email: 'support@example.com',
    subject: 'Re: Support for Example Pumps',
    body: 'Hello,\n\nThanks for getting in touch. Could you share the specifications and arrange a short discussion next week?\n\nBest regards,\nExample Pumps team\n\nThis message is a simulated QA fixture.',
    received_at: new Date().toISOString(),
    attachment_count: 0,
    notice: '',
  });
  simulatedInbox.push({
    ...simulatedInbox[0],
    uid: 2,
    message_id: '<qa-new@example.org>',
    references: [],
    from_email: 'new@example.org',
    from_name: 'New enquiry',
    subject: 'A question for your support team',
    body: 'Hello, we have a question about an upcoming project. Please connect us with the right team.\n\nSimulated QA fixture.',
  });
  await api(
    '/settings/incoming',
    {
      revision: 0,
      host: '8.8.8.8',
      username: 'support@example.com',
      password: 'simulated-incoming-only',
      folder: 'INBOX',
      enabled: true,
    },
    'PUT',
  );
  await api('/mailbox/sync', {});
  console.log('Disposable UI test server ready at http://127.0.0.1:3100');
});
function shutdown() {
  server.close(() => {
    db.close();
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('innovista-browser-')
    )
      throw new Error('Unexpected fixture path');
    fs.rmSync(resolved, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Disposable UI test server. Uses mocked AI and website content; never loads .env or the user's database.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import type { TrainingSnapshot } from '../shared/types';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-browser-'));
const { app, db } = createApp({
  dataDir: directory,
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
      url,
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
    await fetch(root + '/projects/1/leads', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, industry, country, website }),
    });
  }
  console.log('Disposable UI test server ready at http://127.0.0.1:3100');
});
function shutdown() {
  server.close(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

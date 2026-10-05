import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import type { Generate } from '../server/ai';
import type { createDecision, DecisionQuestions } from '../server/decisions';
import { companyState, ruleQuestions } from '../server/quick-decision';
import { judgedRule, quickVerdict, type QuickDecision } from '../shared/quick-decision';
import type { JevSettings, Lead, Project } from '../shared/types';

const jevKey = 'sk-or-v1-' + 'a'.repeat(64);
const rubric = {
  summary: 'Pump manufacturers with their own engineering teams.',
  criteria: ['Manufactures pumps', 'Has an in-house engineering team'],
  exclusions: ['Makes bearings'],
  questions: [],
};

/** Every call the app makes to Jev, and what each answers. */
type Call = { apiKey: string; model?: string; state: unknown; questions: DecisionQuestions };
function fixture(answer: (call: Call) => Record<string, unknown> = () => ({})) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-jev-'));
  const calls: Call[] = [];
  const chat: string[] = [];
  const decide = (async (options: Call) => {
    calls.push(options);
    return { answers: answer(options), model: options.model || 'typesafe/jev-1.13', latency_ms: 4 };
  }) as unknown as typeof createDecision;
  const generate: Generate = async (_config, system) => {
    chat.push(system);
    if (system.includes('proposed qualification rubric')) return rubric;
    return { verdicts: [] };
  };
  const { app, db } = createApp({
    dataDir: dir,
    generate,
    createDecision: decide,
    fetchWebsite: async (url) => ({
      url,
      content: 'We design and manufacture industrial pumps with our own engineers.',
      truncated: false,
      links: [],
    }),
  });
  const agent = request.agent(app);
  let csrf = '';
  const send = (method: 'post' | 'put', url: string, body: object = {}) =>
    agent[method]('/api' + url)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf)
      .send(body);
  return {
    app,
    db,
    calls,
    chat,
    get: (url: string) => agent.get('/api' + url),
    post: (url: string, body: object = {}) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    async setup() {
      const response = await send('post', '/auth/setup', {
        name: 'Test Administrator',
        username: 'test-admin',
        password: 'A-long-test-password-2026',
      });
      assert.equal(response.status, 201, response.text);
      csrf = response.body.csrf_token;
    },
    dispose() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

async function publishedProject(f: Fixture) {
  const created = await f.post('/projects', { name: 'Pump Research', website: 'https://example.org' });
  assert.equal(created.status, 201, created.text);
  const id = created.body.id as number;
  let project: Project = (await f.get('/projects/' + id)).body.project;
  const note = await f.post('/projects/' + id + '/sources', {
    revision: project.revision,
    title: 'Brief',
    content: 'Target pump manufacturers with their own engineering teams.',
  });
  assert.equal(note.status, 201, note.text);
  project = (await f.get('/projects/' + id)).body.project;
  const site = await f.post('/projects/' + id + '/sources/website', {
    revision: project.revision,
    url: 'https://example.org',
  });
  assert.equal(site.status, 201, site.text);
  project = (await f.get('/projects/' + id)).body.project;
  const saved = await f.put('/projects/' + id + '/training/rubric', {
    revision: project.revision,
    rubric,
  });
  assert.equal(saved.status, 200, saved.text);
  const published = await f.post('/projects/' + id + '/training/publish', {
    revision: saved.body.revision,
  });
  assert.equal(published.status, 200, published.text);
  return published.body as Project;
}

/** Jev's answer when every criterion is met and the exclusion does not apply. */
const allMet = () => ({
  c1: { type: 'choice', choice: 'meets', probabilities: { meets: 0.92, does_not_meet: 0.03, unknown: 0.05 } },
  c2: { type: 'choice', choice: 'meets', probabilities: { meets: 0.81, does_not_meet: 0.04, unknown: 0.15 } },
  x1: { type: 'choice', choice: 'does_not_apply', probabilities: { applies: 0.02, does_not_apply: 0.9, unknown: 0.08 } },
  overall: { type: 'score', score: 4 },
});

test('a rule call is only made when Jev is sure enough, and the verdict follows the score rule', () => {
  const sure = judgedRule('R', { choice: 'meets', probabilities: { meets: 0.8, unknown: 0.2 } }, { yes: 'meets', no: 'does_not_meet' });
  assert.equal(sure.call, 'MEETS');
  const unsure = judgedRule('R', { choice: 'meets', probabilities: { meets: 0.55, unknown: 0.45 } }, { yes: 'meets', no: 'does_not_meet' });
  assert.equal(unsure.call, 'UNKNOWN');
  // An exclusion needs more certainty than a criterion before it decides anything.
  const exclusion = judgedRule('X', { choice: 'applies', probabilities: { applies: 0.65 } }, { yes: 'applies', no: 'does_not_apply' });
  assert.equal(exclusion.call, 'UNKNOWN');

  const met = (call: 'MEETS' | 'DOES_NOT_MEET' | 'UNKNOWN') => ({
    rule: 'r',
    call,
    probabilities: { meets: 0, does_not_meet: 0, unknown: 0 },
  });
  assert.deepEqual(quickVerdict([met('MEETS'), met('UNKNOWN')], []).verdict, 'LIKELY_QUALIFIED');
  assert.equal(quickVerdict([met('MEETS'), met('UNKNOWN')], []).score, 50);
  assert.equal(quickVerdict([met('UNKNOWN'), met('UNKNOWN'), met('DOES_NOT_MEET')], []).verdict, 'UNSURE');
  assert.equal(quickVerdict([met('DOES_NOT_MEET'), met('DOES_NOT_MEET')], []).verdict, 'LIKELY_NOT');
  const excluded = quickVerdict([met('MEETS'), met('MEETS')], [{ ...met('MEETS'), rule: 'Makes bearings' }]);
  assert.deepEqual([excluded.verdict, excluded.score, excluded.excluded_by], ['LIKELY_NOT', 0, 'Makes bearings']);
});

test('the questions cover every rule, and the state leaves the contact’s personal details out', () => {
  const questions = ruleQuestions(rubric);
  assert.deepEqual(Object.keys(questions), ['c1', 'c2', 'x1', 'overall']);
  assert.match(questions.c1.instructions, /Manufactures pumps/);
  assert.match(questions.x1.instructions, /Makes bearings/);
  const state = companyState({
    lead: {
      name: 'Rotor Pumps GmbH',
      website: 'https://rotor.example',
      industry: 'Pumps',
      city: 'Bremen',
      country: 'Germany',
      employee_count: '120',
      contact_role: 'Head of purchasing',
      notes: 'Met at the fair.',
      contact_email: 'anna.schmidt@rotor.example',
    },
    listData: { Event: 'Hannover Messe' },
    facts: [],
    website: null,
  });
  assert.match(state, /Contact email domain: rotor\.example/);
  assert.match(state, /Head of purchasing/);
  assert.match(state, /Event: Hannover Messe/);
  assert.equal(state.includes('anna'), false);
  const freeMail = companyState({
    lead: { name: 'X', website: '', industry: '', city: '', country: '', employee_count: '', contact_role: '', notes: '', contact_email: 'someone@gmail.com' },
    listData: {},
    facts: [],
    website: null,
  });
  assert.equal(freeMail.includes('gmail'), false);
});

test('the Jev key is saved encrypted, never returned, checked and administrator-only', async () => {
  const f = fixture(() => ({ ok: { type: 'noul', noul: 0.97 } }));
  try {
    await f.setup();
    assert.equal(((await f.get('/settings/jev')).body as JevSettings).has_key, false);
    // Not an OpenRouter key: refused, so a password pasted by mistake is never stored.
    assert.equal((await f.put('/settings/jev', { api_key: 'my-site-password' })).status, 400);
    const saved = await f.put('/settings/jev', { api_key: '  ' + jevKey + '\n' });
    assert.equal(saved.status, 200, saved.text);
    const settings = saved.body as JevSettings;
    assert.deepEqual([settings.has_key, settings.source, settings.key_preview], [true, 'saved', '••••' + jevKey.slice(-4)]);
    assert.equal(JSON.stringify(saved.body).includes(jevKey), false);
    const stored = f.db.prepare("SELECT value FROM settings WHERE key='jev_api_key'").get() as { value: string };
    assert.ok(stored.value.startsWith('enc:v1:'));
    assert.equal(stored.value.includes(jevKey), false);

    const checked = await f.post('/settings/jev/test');
    assert.equal(checked.status, 200, checked.text);
    assert.equal(checked.body.status.ok, true);
    assert.equal(f.calls.at(-1)!.apiKey, jevKey);
    assert.equal(((await f.get('/settings/jev')).body as JevSettings).status!.ok, true);

    const account = await f.post('/users', {
      name: 'Plain Researcher',
      username: 'plain-researcher',
      password: 'Disposable-researcher-2026',
      role: 'researcher',
    });
    assert.equal(account.status, 201, account.text);
    const other = request.agent(f.app);
    const login = await other
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'plain-researcher', password: 'Disposable-researcher-2026' });
    assert.equal(login.status, 200, login.text);
    assert.equal((await other.get('/api/settings/jev')).status, 403);

    const cleared = await f.put('/settings/jev', { clear_api_key: true });
    assert.equal(cleared.body.has_key, false);
  } finally {
    f.dispose();
  }
});

test('a fast decision judges every rule in one Jev call and never changes the qualification', async () => {
  const f = fixture(allMet);
  try {
    await f.setup();
    const project = await publishedProject(f);
    const created = await f.post('/projects/' + project.id + '/leads', {
      name: 'Rotor Pumps GmbH',
      website: 'https://rotor.example',
      contact_name: 'Anna Schmidt',
      contact_email: 'anna.schmidt@rotor.example',
    });
    assert.equal(created.status, 201, created.text);
    const base = '/projects/' + project.id + '/leads/' + created.body.id;

    // No key yet: refused with what to do, and Jev is not called.
    const noKey = await f.post(base + '/quick-decision');
    assert.equal(noKey.status, 409);
    assert.match(noKey.body.error, /Jev key/);
    assert.equal(f.calls.length, 0);

    await f.put('/settings/jev', { api_key: jevKey });
    const before = (await f.get(base)).body as Lead;
    const decided = await f.post(base + '/quick-decision');
    assert.equal(decided.status, 200, decided.text);
    const decision = decided.body as QuickDecision;
    assert.deepEqual([decision.verdict, decision.score, decision.overall?.label], ['LIKELY_QUALIFIED', 100, 'Clearly a fit']);
    assert.equal(decision.website_read, true);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(Object.keys(f.calls[0].questions), ['c1', 'c2', 'x1', 'overall']);
    const state = String(f.calls[0].state);
    assert.match(state, /manufacture industrial pumps/);
    assert.equal(state.includes('Anna'), false);
    assert.equal(state.includes('anna.schmidt'), false);

    const after = (await f.get(base)).body as Lead;
    assert.deepEqual(
      [after.status, after.score, after.revision, after.latest_run_id],
      [before.status, before.score, before.revision, before.latest_run_id],
    );
    assert.equal(after.quick_decision!.verdict, 'LIKELY_QUALIFIED');
    assert.equal(after.quick_decision!.stale, false);

    // The list carries it, and the Fast decision filter finds it.
    const list = (q: string) => f.get('/projects/' + project.id + '/leads?' + q);
    assert.equal(((await list('')).body.leads as Lead[])[0].quick!.verdict, 'LIKELY_QUALIFIED');
    assert.equal((await list('quick=LIKELY_QUALIFIED')).body.total, 1);
    assert.equal((await list('quick=NONE')).body.total, 0);

    // Editing the lead makes the decision out of date: shown as stale, filtered as none.
    const edited = await f.put(base, {
      revision: after.revision,
      name: 'Rotor Pumps GmbH',
      website: 'https://rotor.example',
      industry: 'Pumps',
      contact_name: 'Anna Schmidt',
      contact_email: 'anna.schmidt@rotor.example',
    });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(((await f.get(base)).body as Lead).quick_decision!.stale, true);
    assert.equal((await list('quick=LIKELY_QUALIFIED')).body.total, 0);
    assert.equal((await list('quick=NONE')).body.total, 1);
  } finally {
    f.dispose();
  }
});

test('a batch decides each lead, reports a missing one, and needs published training', async () => {
  const f = fixture(allMet);
  try {
    await f.setup();
    await f.put('/settings/jev', { api_key: jevKey });
    const draft = await f.post('/projects', { name: 'Unpublished' });
    const unpublished = await f.post('/projects/' + draft.body.id + '/quick-decisions', { lead_ids: [1] });
    assert.equal(unpublished.status, 409);

    const project = await publishedProject(f);
    const ids: number[] = [];
    for (const name of ['Alpha Pumps', 'Beta Pumps'])
      ids.push((await f.post('/projects/' + project.id + '/leads', { name })).body.id);
    const batch = await f.post('/projects/' + project.id + '/quick-decisions', {
      lead_ids: [...ids, 999999],
    });
    assert.equal(batch.status, 200, batch.text);
    const results = batch.body.results as Array<{ lead_id: number; decision?: QuickDecision; error?: string }>;
    assert.deepEqual(results.map((item) => item.lead_id), [...ids, 999999]);
    assert.equal(results[0].decision!.verdict, 'LIKELY_QUALIFIED');
    assert.equal(results[1].decision!.verdict, 'LIKELY_QUALIFIED');
    assert.match(results[2].error!, /not found/i);
    assert.equal((await f.post('/projects/' + project.id + '/quick-decisions', { lead_ids: Array.from({ length: 26 }, (_, i) => i + 1) })).status, 400);
  } finally {
    f.dispose();
  }
});

test('with a Jev key the import quick screen runs on Jev, not the chat model', async () => {
  const f = fixture((call) =>
    String(call.state).includes('Bearing')
      ? { ...allMet(), x1: { type: 'choice', choice: 'applies', probabilities: { applies: 0.9 } } }
      : String(call.state).includes('Pump')
        ? allMet()
        : { c1: { type: 'choice', choice: 'unknown', probabilities: { unknown: 0.9 } } },
  );
  try {
    await f.setup();
    const project = await publishedProject(f);
    await f.put('/settings/jev', { api_key: jevKey });
    const row = (name: string, industry = '') => ({
      name,
      website: '',
      country: '',
      city: '',
      industry,
      employee_count: '',
      contact_name: '',
      contact_role: '',
      contact_email: '',
      contact_phone: '',
      notes: '',
    });
    const chatBefore = f.chat.length;
    const screened = await f.post('/projects/' + project.id + '/leads/import/screen', {
      rows: [row('Rotor Pump Works', 'Pump manufacturing'), row('Kugel Bearing AG', 'Bearings'), row('Mystery Ltd')],
    });
    assert.equal(screened.status, 200, screened.text);
    const verdicts = screened.body.verdicts as Array<{ verdict: string; reason: string; rule: string }>;
    assert.deepEqual(verdicts.map((item) => item.verdict), ['PASS', 'REJECT', 'UNCLEAR']);
    assert.equal(verdicts[1].rule, 'Makes bearings');
    assert.match(verdicts[1].reason, /Jev/);
    assert.equal(f.chat.length, chatBefore);
  } finally {
    f.dispose();
  }
});

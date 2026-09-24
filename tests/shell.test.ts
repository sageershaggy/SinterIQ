import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { openDatabase } from '../server/database';
import { getEmailConfig, publicEmailSettings, saveEmailConfig } from '../server/email';
import type { Generate } from '../server/ai';
import type { WebsitePage } from '../server/network';
import { sendingGaps } from '../shared/mailbox-status';
import type { NotificationFeed, NotificationItem } from '../shared/notifications';
import type {
  QualificationEntry,
  ResearchLogPage,
  ResearchPassEntry,
  ReviewEntry,
} from '../shared/research-log';
import type { Project, TrainingSnapshot } from '../shared/types';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;

const rubric = {
  summary: 'Find pump manufacturers with engineering teams.',
  criteria: ['Manufactures pumps', 'Employs engineers'],
  exclusions: ['Manufactures bearings'],
  questions: [],
};
const pumpHome = 'https://rotterdam-pumps.example.com';
const pumpSite =
  'Rotterdam Pump Works designs and manufactures industrial pumps. ' +
  'Rotterdam Pump Works is a specialist in chemical process pumps for the chemical industry. ' +
  'Write to sales@rotterdam-pumps.example.com for the engineering desk.';
const pages: Record<string, string> = {
  'https://example.org': 'Example Org researches pump manufacturers for its clients.',
  [pumpHome]: pumpSite,
};

/**
 * Deterministic stand-ins for the model: analysis proposes the rubric, research proposes no
 * domains and extracts two cited facts, and qualification answers with `state.decision`.
 */
function fixture() {
  const state = { decision: 'QUALIFIED' as 'QUALIFIED' | 'NEEDS_REVIEW' };
  const generate: Generate = async (_config, system, input) => {
    if (system.includes('proposed qualification rubric')) return rubric;
    if (system.includes('candidate official website domains')) return { domains: [] };
    if (system.includes('extract company facts'))
      return {
        fields: [
          {
            field: 'industry',
            value: 'Chemical process pumps',
            evidence:
              'Rotterdam Pump Works is a specialist in chemical process pumps for the chemical industry.',
          },
          {
            field: 'contact_email',
            value: 'sales@rotterdam-pumps.example.com',
            evidence: 'Write to sales@rotterdam-pumps.example.com for the engineering desk.',
          },
        ],
        notes: ['The page also names a managing director.'],
      };
    const snapshot = (input as { approved_training: TrainingSnapshot }).approved_training;
    return {
      decision: state.decision,
      score: state.decision === 'QUALIFIED' ? 91 : 62,
      confidence: 80,
      summary: 'The company manufactures chemical process pumps with its own engineering desk.',
      // The server's own decision is conservative: an unknown rule holds a lead in review.
      criteria: snapshot.rubric.criteria.map((criterion, index) => ({
        criterion,
        outcome: index === 0 || state.decision === 'QUALIFIED' ? 'MATCH' : 'UNKNOWN',
        evidence: 'The website describes its pump manufacturing.',
        source_ids: ['E2'],
      })),
      exclusions: snapshot.rubric.exclusions.map((criterion) => ({
        criterion,
        outcome: 'NO_MATCH',
        evidence: 'The website does not mention making bearings.',
        source_ids: ['E2'],
      })),
      gaps: state.decision === 'QUALIFIED' ? [] : ['Headcount of the engineering team'],
      next_steps: ['Confirm the pump lines.'],
      outreach: {
        contact_name: '',
        contact_role: '',
        contact_source_ids: [],
        why_qualified: 'Builds pumps in house.',
        call_script: 'Ask about their pump lines.',
      },
    };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-shell-'));
  const { app, db } = createApp({
    dataDir: dir,
    generate,
    fetchWebsite: async (url): Promise<WebsitePage> => {
      const content = pages[url];
      if (content === undefined) throw new Error('This website could not be reached.');
      return { url, content, truncated: false, links: [] };
    },
  });
  const agent = request.agent(app);
  let csrf = '';
  const send = (method: 'post' | 'put' | 'delete', url: string, body: object = {}) =>
    agent[method]('/api' + url)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf)
      .send(body);
  return {
    app,
    db,
    state,
    get: (url: string) => agent.get('/api' + url),
    post: (url: string, body: object = {}) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    del: (url: string) => send('delete', url),
    upload: (url: string, name: string, content: string) =>
      agent
        .post('/api' + url)
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', csrf)
        .attach('file', Buffer.from(content), name),
    async setup() {
      const response = await send('post', '/auth/setup', {
        name: 'Test Administrator',
        username: 'test-admin',
        password: 'A-long-test-password-2026',
      });
      assert.equal(response.status, 201, response.text);
      csrf = response.body.csrf_token;
    },
    /** A second account that signs in on its own agent. */
    async researcher() {
      const created = await send('post', '/users', {
        name: 'Shell Researcher',
        username: 'shell-researcher',
        password: 'Disposable-researcher-2026',
        role: 'researcher',
      });
      assert.equal(created.status, 201, created.text);
      const other = request.agent(app);
      const login = await other
        .post('/api/auth/login')
        .set('X-Requested-With', 'Innovista')
        .send({ username: 'shell-researcher', password: 'Disposable-researcher-2026' });
      assert.equal(login.status, 200, login.text);
      return {
        id: created.body.id as number,
        get: (url: string) => other.get('/api' + url),
        post: (url: string, body: object = {}) =>
          other
            .post('/api' + url)
            .set('X-Requested-With', 'Innovista')
            .set('X-CSRF-Token', login.body.csrf_token)
            .send(body),
      };
    },
    dispose() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

async function readyProject(f: Fixture) {
  const created = await f.post('/projects', {
    name: 'Pump Research',
    description: 'Research pump manufacturers',
    website: 'https://example.org',
  });
  assert.equal(created.status, 201, created.text);
  const id = created.body.id as number;
  let project = created.body as Project;
  assert.equal(
    (
      await f.post(`/projects/${id}/sources`, {
        revision: project.revision,
        title: 'Training brief',
        content: 'Target pump manufacturers with their own engineering teams. Exclude bearings.',
      })
    ).status,
    201,
  );
  project = (await f.get(`/projects/${id}`)).body.project;
  assert.equal(
    (
      await f.post(`/projects/${id}/sources/website`, {
        revision: project.revision,
        url: 'https://example.org',
      })
    ).status,
    201,
  );
  project = (await f.get(`/projects/${id}`)).body.project;
  const saved = await f.put(`/projects/${id}/training/rubric`, {
    revision: project.revision,
    rubric,
  });
  assert.equal(saved.status, 200, saved.text);
  const published = await f.post(`/projects/${id}/training/publish`, {
    revision: saved.body.revision,
  });
  assert.equal(published.status, 200, published.text);
  return published.body as Project;
}
async function feed(get: (url: string) => request.Test) {
  const response = await get('/notifications');
  assert.equal(response.status, 200, response.text);
  return response.body as NotificationFeed;
}
const find = (items: NotificationItem[], kind: string) => items.find((item) => item.kind === kind);

test('identical notifications collapse into one row, and reading the row reads the group', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const lead = await f.post(`/projects/${project.id}/leads`, {
      name: 'Alternative Decor Works',
      website: pumpHome,
    });
    assert.equal(lead.status, 201, lead.text);
    const base = `/projects/${project.id}/leads/${lead.body.id}`;
    f.state.decision = 'NEEDS_REVIEW';
    for (let run = 0; run < 4; run++) assert.equal((await f.post(base + '/qualify')).status, 200);

    let updates = await feed(f.get);
    const review = updates.items.filter((item) => item.title.endsWith(': needs review'));
    assert.equal(review.length, 1, JSON.stringify(updates.items));
    assert.equal(review[0].title, 'Alternative Decor Works: needs review');
    assert.equal(review[0].count, 4);
    assert.equal(review[0].unread, 4);
    assert.equal(review[0].scope, 'lead');
    assert.equal(review[0].lead_id, lead.body.id);
    assert.equal(review[0].read_at, null);
    // Four notifications, one row, one unread in the badge (plus the lead's other rows).
    const unreadBefore = updates.unread;
    assert.equal(unreadBefore, updates.items.filter((item) => item.unread > 0).length);

    assert.equal((await f.post(`/notifications/${review[0].id}/read`)).status, 200);
    updates = await feed(f.get);
    const read = updates.items.find((item) => item.title === review[0].title)!;
    assert.equal(read.count, 4);
    assert.equal(read.unread, 0);
    assert.ok(read.read_at);
    assert.equal(updates.unread, unreadBefore - 1);

    // A fifth identical notification joins the same row, unread again.
    assert.equal((await f.post(base + '/qualify')).status, 200);
    updates = await feed(f.get);
    const again = updates.items.filter((item) => item.title === review[0].title);
    assert.equal(again.length, 1);
    assert.equal(again[0].count, 5);
    assert.equal(again[0].unread, 1);
    // Different outcomes are different rows.
    f.state.decision = 'QUALIFIED';
    assert.equal((await f.post(base + '/qualify')).status, 200);
    updates = await feed(f.get);
    assert.ok(updates.items.some((item) => item.title === 'Alternative Decor Works: qualified'));
    assert.equal(updates.items.filter((item) => item.title === review[0].title).length, 1);
  } finally {
    f.dispose();
  }
});

test('training, imports and research completion reach the updates feed', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    let updates = await feed(f.get);
    const published = find(updates.items, 'training_published');
    assert.ok(published, JSON.stringify(updates.items));
    assert.equal(published.scope, 'project');
    assert.equal(published.project_id, project.id);
    assert.equal(published.lead_id, null);
    assert.equal(published.title, 'Training v1 published');
    assert.equal(published.project_name, 'Pump Research');

    const current = (await f.get(`/projects/${project.id}`)).body.project as Project;
    const analyzed = await f.post(`/projects/${project.id}/training/analyze`, {
      revision: current.revision,
    });
    assert.equal(analyzed.status, 200, analyzed.text);
    updates = await feed(f.get);
    assert.equal(
      find(updates.items, 'training_draft')?.title,
      'New training draft ready for review',
    );

    const imported = await f.upload(
      `/projects/${project.id}/leads/import`,
      'leads.csv',
      'Company Name,Website\nNorthwind Pumps,https://northwind.example.com\nSouthwind Pumps,\n',
    );
    assert.equal(imported.status, 200, imported.text);
    updates = await feed(f.get);
    assert.equal(find(updates.items, 'leads_imported')?.title, 'Leads imported: 2 new, 0 updated');
    // An import that changed nothing is not news.
    const again = await f.upload(
      `/projects/${project.id}/leads/import`,
      'leads.csv',
      'Company Name\nNorthwind Pumps\n',
    );
    assert.equal(again.status, 200, again.text);
    updates = await feed(f.get);
    assert.equal(updates.items.filter((item) => item.kind === 'leads_imported').length, 1);
    assert.equal(find(updates.items, 'leads_imported')?.count, 1);

    const lead = await f.post(`/projects/${project.id}/leads`, {
      name: 'Rotterdam Pump Works',
      website: pumpHome,
    });
    const researched = await f.post(`/projects/${project.id}/leads/${lead.body.id}/research`);
    assert.equal(researched.status, 200, researched.text);
    updates = await feed(f.get);
    const research = find(updates.items, 'research');
    assert.equal(research?.scope, 'lead');
    assert.equal(research?.lead_id, lead.body.id);
    assert.equal(
      research?.title,
      'Rotterdam Pump Works: research completed — filled industry, contact email',
    );

    // A project row is read by its own route; lead ids do not reach it.
    assert.equal((await f.post(`/notifications/project/${published.id}/read`)).status, 200);
    updates = await feed(f.get);
    assert.equal(find(updates.items, 'training_published')?.unread, 0);
    assert.equal((await f.post('/notifications/project/999999/read')).status, 404);
    assert.equal((await f.post('/notifications/read', {})).status, 400);

    // Mark all: each kind up to the newest row the panel showed.
    const newestLead = Math.max(
      ...updates.items.filter((item) => item.scope === 'lead').map((item) => item.id),
    );
    const newestProject = Math.max(
      ...updates.items.filter((item) => item.scope === 'project').map((item) => item.id),
    );
    assert.equal(
      (
        await f.post('/notifications/read', {
          through_id: newestLead,
          through_project_id: newestProject,
        })
      ).status,
      200,
    );
    assert.equal((await feed(f.get)).unread, 0);
  } finally {
    f.dispose();
  }
});

test('a lead cursor alone still marks the project updates shown up to that moment', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const lead = await f.post(`/projects/${project.id}/leads`, { name: 'Harbor Pumps' });
    assert.equal(lead.status, 201, lead.text);
    let updates = await feed(f.get);
    assert.ok(find(updates.items, 'training_published')!.unread > 0);
    const newestLead = updates.items.find((item) => item.scope === 'lead')!;
    assert.equal((await f.post('/notifications/read', { through_id: newestLead.id })).status, 200);
    updates = await feed(f.get);
    assert.equal(updates.unread, 0);
    // Something newer than the cursor stays unread.
    const current = (await f.get(`/projects/${project.id}`)).body.project as Project;
    await f.post(`/projects/${project.id}/training/analyze`, { revision: current.revision });
    await f.post('/notifications/read', { through_id: newestLead.id });
    assert.equal((await feed(f.get)).unread, 1);
  } finally {
    f.dispose();
  }
});

test('project updates follow project access for researchers', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const researcher = await f.researcher();
    const current = () => f.get(`/projects/${project.id}`).then((r) => r.body.project as Project);
    // Not a member when the draft was announced: never a recipient.
    await f.post(`/projects/${project.id}/training/analyze`, {
      revision: (await current()).revision,
    });
    assert.equal((await feed(researcher.get)).items.length, 0);
    assert.equal(
      (await f.put(`/users/${researcher.id}/projects`, { project_ids: [project.id] })).status,
      200,
    );
    await f.post(`/projects/${project.id}/training/analyze`, {
      revision: (await current()).revision,
    });
    const seen = await feed(researcher.get);
    const draft = find(seen.items, 'training_draft');
    assert.ok(draft, JSON.stringify(seen.items));
    assert.equal(draft.count, 1);
    assert.equal(seen.unread, 1);
    // Someone else's notification cannot be marked from another account.
    const adminDraft = find((await feed(f.get)).items, 'training_draft')!;
    assert.equal(
      (await researcher.post(`/notifications/project/${adminDraft.id}/read`)).status,
      404,
    );
    // Losing the project loses its updates, and their read route with them.
    await f.put(`/users/${researcher.id}/projects`, { project_ids: [] });
    assert.equal((await feed(researcher.get)).items.length, 0);
    assert.equal((await researcher.post(`/notifications/project/${draft.id}/read`)).status, 404);
  } finally {
    f.dispose();
  }
});

test('the research log shows each pass, run and review per lead with what was found', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const log = `/projects/${project.id}/research-log`;
    const pump = await f.post(`/projects/${project.id}/leads`, {
      name: 'Rotterdam Pump Works',
      website: pumpHome,
    });
    const pumpBase = `/projects/${project.id}/leads/${pump.body.id}`;
    assert.equal((await f.post(pumpBase + '/research')).status, 200);
    f.state.decision = 'NEEDS_REVIEW';
    const run = await f.post(pumpBase + '/qualify');
    assert.equal(run.status, 200, run.text);
    const reviewed = await f.post(pumpBase + '/review', {
      run_id: run.body.run_id,
      decision: 'QUALIFIED',
      notes: 'Confirmed against the captured website evidence.',
    });
    assert.equal(reviewed.status, 200, reviewed.text);
    // No website and no candidate domain: the pass found nothing, and still says what it did.
    const quiet = await f.post(`/projects/${project.id}/leads`, { name: 'Quiet Pumps Ltd' });
    assert.equal(
      (await f.post(`/projects/${project.id}/leads/${quiet.body.id}/research`)).status,
      200,
    );

    let page = (await f.get(log)).body as ResearchLogPage;
    assert.deepEqual(
      page.entries.map((entry) => entry.kind + ':' + entry.lead_name),
      [
        'research:Quiet Pumps Ltd',
        'review:Rotterdam Pump Works',
        'qualification:Rotterdam Pump Works',
        'research:Rotterdam Pump Works',
      ],
    );
    assert.equal(page.next_before, null);
    const nothing = page.entries[0] as ResearchPassEntry;
    assert.deepEqual(nothing.found, []);
    assert.equal(nothing.created_by, 'Test Administrator');
    assert.ok(
      nothing.notes.some((note) => note.includes('No candidate website')),
      nothing.notes.join(),
    );
    const review = page.entries[1] as ReviewEntry;
    assert.equal(review.decision, 'QUALIFIED');
    assert.equal(review.notes, 'Confirmed against the captured website evidence.');
    const analysis = page.entries[2] as QualificationEntry;
    assert.equal(analysis.run_id, run.body.run_id);
    assert.equal(analysis.training_version, 1);
    assert.equal(analysis.decision, 'NEEDS_REVIEW');
    assert.equal(analysis.score, run.body.result.score);
    assert.equal(analysis.criteria_total, 2);
    assert.equal(analysis.criteria_met, 1);
    assert.equal(analysis.criteria_unknown, 1);
    assert.equal(analysis.exclusions_hit, 0);
    assert.deepEqual(analysis.gaps, ['Headcount of the engineering team']);
    assert.deepEqual(analysis.pages, [pumpHome]);
    const pass = page.entries[3] as ResearchPassEntry;
    assert.equal(pass.website, pumpHome);
    assert.equal(pass.refused_count, 0);
    assert.deepEqual(
      pass.found.map((item) => [item.field, item.value, item.source_url]),
      [
        ['industry', 'Chemical process pumps', pumpHome],
        ['contact_email', 'sales@rotterdam-pumps.example.com', pumpHome],
      ],
    );
    assert.match(pass.found[0].evidence, /specialist in chemical process pumps/);
    // Model-relayed notes can repeat personal details from the page; they are not kept.
    assert.ok(!pass.notes.some((note) => note.includes('managing director')));

    // Per lead, per kind, and in pages.
    const one = (await f.get(`${log}?lead_id=${pump.body.id}`)).body as ResearchLogPage;
    assert.deepEqual(one.lead, { id: pump.body.id, name: 'Rotterdam Pump Works' });
    assert.equal(one.entries.length, 3);
    assert.ok(one.entries.every((entry) => entry.lead_id === pump.body.id));
    const passes = (await f.get(`${log}?kind=research`)).body as ResearchLogPage;
    assert.deepEqual(
      passes.entries.map((entry) => entry.kind),
      ['research', 'research'],
    );
    const first = (await f.get(`${log}?limit=3`)).body as ResearchLogPage;
    assert.equal(first.entries.length, 3);
    assert.ok(first.next_before);
    const second = (await f.get(`${log}?limit=3&before=${encodeURIComponent(first.next_before!)}`))
      .body as ResearchLogPage;
    assert.deepEqual(
      second.entries.map((entry) => entry.id),
      [page.entries[3].id],
    );
    assert.equal(second.next_before, null);

    // Erasing the contact erases what the log can say about it.
    assert.equal((await f.del(pumpBase + '/contact')).status, 200);
    page = (await f.get(`${log}?lead_id=${pump.body.id}&kind=research`)).body as ResearchLogPage;
    const erased = page.entries[0] as ResearchPassEntry;
    assert.deepEqual(
      erased.found.map((item) => item.field),
      ['industry'],
    );
    assert.deepEqual(erased.erased, ['contact_email']);
    assert.ok(!JSON.stringify(page).includes('sales@rotterdam-pumps'));

    // Scoped like every other project read.
    assert.equal((await f.get(`/projects/1/research-log?lead_id=${pump.body.id}`)).status, 404);
    assert.equal((await f.get(`${log}?kind=everything`)).status, 400);
    const researcher = await f.researcher();
    assert.equal((await researcher.get(log)).status, 404);
    await f.put(`/users/${researcher.id}/projects`, { project_ids: [project.id] });
    assert.equal((await researcher.get(log)).status, 200);

    // Deleting a lead takes its research record with it.
    assert.equal((await f.del(pumpBase)).status, 200);
    page = (await f.get(log)).body as ResearchLogPage;
    assert.deepEqual(
      page.entries.map((entry) => entry.lead_name),
      ['Quiet Pumps Ltd'],
    );
  } finally {
    f.dispose();
  }
});

test('citations written before passes were recorded are gathered back into passes', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const lead = await f.post(`/projects/${project.id}/leads`, { name: 'Legacy Pumps' });
    const insert = f.db.prepare(
      `INSERT INTO lead_research_citations
        (project_id,lead_id,field,value,evidence,source_url,created_at,created_by)
      VALUES (?,?,?,?,?,?,?,?)`,
    );
    const cite = (field: string, value: string, at: string) =>
      insert.run(
        project.id,
        lead.body.id,
        field,
        value,
        `Legacy Pumps is based in ${value}.`,
        'https://legacy.example.com',
        at,
        'Earlier Researcher',
      );
    // One pass of two fields, and a second pass a day later.
    cite('country', 'Netherlands', '2020-03-01T10:00:00.000Z');
    cite('city', 'Delft', '2020-03-01T10:00:00.400Z');
    cite('industry', 'Pumps', '2020-03-02T10:00:00.000Z');
    const page = (await f.get(`/projects/${project.id}/research-log?kind=research`))
      .body as ResearchLogPage;
    assert.equal(page.entries.length, 2, JSON.stringify(page.entries));
    const [later, earlier] = page.entries as ResearchPassEntry[];
    assert.deepEqual(
      later.found.map((item) => item.field),
      ['industry'],
    );
    assert.deepEqual(
      earlier.found.map((item) => item.field),
      ['country', 'city'],
    );
    assert.equal(earlier.created_by, 'Earlier Researcher');
    assert.equal(earlier.website, 'https://legacy.example.com');
  } finally {
    f.dispose();
  }
});

test('the mailbox status names exactly what the server still needs before it can send', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-mailbox-status-'));
  const { db, secrets } = openDatabase(dir);
  try {
    const projectId = (
      db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get() as {
        id: number;
      }
    ).id;
    for (const host of ['', 'smtp.example.com'])
      for (const from of ['', 'research@example.com'])
        for (const password of ['', 'app-password']) {
          saveEmailConfig(db, projectId, {
            host,
            port: 587,
            secure: false,
            username: 'research',
            from_name: 'Research',
            from_email: from,
            reply_to: '',
            copy_to: '',
            signature: '',
            password: password ? secrets.encrypt(password) : null,
          });
          const settings = publicEmailSettings(getEmailConfig(db, secrets, projectId));
          const gaps = sendingGaps(settings);
          assert.equal(settings.configured, gaps.length === 0, JSON.stringify({ settings, gaps }));
          assert.equal(gaps.includes('SMTP host missing'), !host);
          assert.equal(gaps.includes('Sender address missing'), !from);
          assert.equal(gaps.includes('Password missing'), !password);
        }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

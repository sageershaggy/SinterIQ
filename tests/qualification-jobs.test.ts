import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { HttpError } from '../server/validation';
import type { Generate } from '../server/ai';
import type { Lead, Project, TrainingSnapshot } from '../shared/types';
import type { QualificationJobState } from '../shared/qualification-jobs';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;

const adminPassword = 'Disposable-jobs-admin-2026';
const researcherPassword = 'Disposable-jobs-researcher-2026';
const rubric = {
  summary: 'Find pump manufacturers with engineering teams. Bearing makers are competitors.',
  criteria: ['Manufactures pumps', 'Employs engineers'],
  exclusions: ['Manufactures bearings'],
  questions: [],
};

type Agent = ReturnType<typeof request.agent>;
interface Session {
  agent: Agent;
  csrf: string;
}
const send = (
  who: Session,
  method: 'get' | 'post' | 'put' | 'delete',
  url: string,
  body?: object,
) => {
  const pending = who.agent[method]('/api' + url)
    .set('X-Requested-With', 'Innovista')
    .set('X-CSRF-Token', who.csrf);
  return body === undefined ? pending : pending.send(body);
};

/**
 * A deterministic model. Research finds nothing; a lead named "…Bearings…" meets the exclusion,
 * "Broken…" gets an unusable answer, and everyone else meets every rule. It records which leads
 * it judged, in order, and how many judgements ever overlapped. `hold` pauses one lead's
 * judgement until the test releases it; `fail` makes a lead's judgement throw.
 */
function model() {
  const ai = {
    calls: [] as string[],
    research: 0,
    active: 0,
    peak: 0,
    fail: undefined as ((name: string) => Error | undefined) | undefined,
    holds: new Map<string, { enter: () => void; released: Promise<void> }>(),
    hold(name: string) {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => (enter = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      ai.holds.set(name, { enter, released });
      return { entered, release };
    },
    generate: (async (_config, system, input) => {
      if (system.includes('candidate official website domains')) {
        ai.research++;
        return { domains: [] };
      }
      if (system.includes('extract company facts')) {
        ai.research++;
        return { fields: [], notes: [] };
      }
      const { approved_training: snapshot, lead } = input as {
        approved_training: TrainingSnapshot;
        lead: { name: string };
      };
      ai.active++;
      ai.peak = Math.max(ai.peak, ai.active);
      try {
        ai.calls.push(lead.name);
        const held = ai.holds.get(lead.name);
        if (held) {
          ai.holds.delete(lead.name);
          held.enter();
          await held.released;
        }
        const failure = ai.fail?.(lead.name);
        if (failure) throw failure;
        if (lead.name.startsWith('Broken')) return {};
        const bearing = /bearings/i.test(lead.name);
        return {
          decision: bearing ? 'NOT_A_TARGET' : 'QUALIFIED',
          score: bearing ? 0 : 95,
          confidence: 92,
          summary: bearing
            ? 'The company manufactures bearings, so it is a competitor.'
            : 'The company manufactures pumps with its own engineering team.',
          criteria: snapshot.rubric.criteria.map((criterion) => ({
            criterion,
            outcome: 'MATCH',
            evidence: 'The website describes pump manufacturing and an engineering team.',
            source_ids: ['E2'],
          })),
          exclusions: snapshot.rubric.exclusions.map((criterion) => ({
            criterion,
            outcome: bearing ? 'MATCH' : 'NO_MATCH',
            evidence: bearing
              ? 'The website says the company manufactures bearings.'
              : 'The website says it buys third-party bearings.',
            source_ids: ['E2'],
          })),
          gaps: [],
          next_steps: ['Confirm the pump applications.'],
          outreach: {
            contact_name: '',
            contact_role: '',
            contact_source_ids: [],
            why_qualified: bearing ? '' : 'Builds pumps in house.',
            call_script: bearing ? '' : 'Ask which pump lines use third-party bearings.',
          },
        };
      } finally {
        ai.active--;
      }
    }) as Generate,
  };
  return ai;
}

async function fixture(options: { provider?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-jobs-'));
  const ai = model();
  const config = (runJobs: boolean): Parameters<typeof createApp>[0] => ({
    dataDir: dir,
    // The runner is stepped by hand here, except where a test is about the background loop.
    runJobs,
    generate: options.provider === false ? undefined : ai.generate,
    fetchWebsite: async (url) => ({
      url,
      content:
        'The company designs and manufactures industrial pumps with its own engineering team. ' +
        url,
      truncated: false,
      links: [],
    }),
  });
  let instance = createApp(config(false));
  const admin: Session = { agent: request.agent(instance.app), csrf: '' };
  const setup = await send(admin, 'post', '/auth/setup', {
    name: 'Jobs Admin',
    username: 'jobs-admin',
    password: adminPassword,
  });
  assert.equal(setup.status, 201, setup.text);
  admin.csrf = setup.body.csrf_token;
  const login = async (username: string, password: string) => {
    const agent = request.agent(instance.app);
    const response = await agent
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username, password });
    assert.equal(response.status, 200, response.text);
    return { agent, csrf: response.body.csrf_token as string };
  };
  let leadCount = 0;
  const f = {
    ai,
    admin,
    get db() {
      return instance.db;
    },
    get jobs() {
      return instance.qualificationJobs;
    },
    /** A project whose training is published, so its leads can be qualified. */
    async project(name = 'Pump Research') {
      const created = await send(admin, 'post', '/projects', {
        name,
        description: 'Research pump manufacturers',
        website: 'https://example.org',
      });
      assert.equal(created.status, 201, created.text);
      const id = created.body.id as number;
      const current = async () =>
        (await send(admin, 'get', '/projects/' + id)).body.project as Project;
      let added = await send(admin, 'post', '/projects/' + id + '/sources', {
        revision: (await current()).revision,
        title: 'Training brief',
        content:
          'Target pump manufacturers with their own engineering teams. Exclude bearing manufacturers.',
      });
      assert.equal(added.status, 201, added.text);
      added = await send(admin, 'post', '/projects/' + id + '/sources/website', {
        revision: (await current()).revision,
        url: 'https://example.org',
      });
      assert.equal(added.status, 201, added.text);
      const saved = await send(admin, 'put', '/projects/' + id + '/training/rubric', {
        revision: (await current()).revision,
        rubric,
      });
      assert.equal(saved.status, 200, saved.text);
      const published = await send(admin, 'post', '/projects/' + id + '/training/publish', {
        revision: saved.body.revision,
      });
      assert.equal(published.status, 200, published.text);
      return published.body as Project;
    },
    async lead(project: Project, name: string) {
      const created = await send(admin, 'post', '/projects/' + project.id + '/leads', {
        name,
        website: 'https://company' + ++leadCount + '.example',
      });
      assert.equal(created.status, 201, created.text);
      return created.body as Lead;
    },
    async qualify(project: Project, lead: Lead) {
      const result = await send(
        admin,
        'post',
        '/projects/' + project.id + '/leads/' + lead.id + '/qualify',
        {},
      );
      assert.equal(result.status, 200, result.text);
    },
    async researcher(username: string, projectIds: number[]) {
      const created = await send(admin, 'post', '/users', {
        name: 'Researcher ' + username,
        username,
        password: researcherPassword,
        role: 'researcher',
      });
      assert.equal(created.status, 201, created.text);
      const granted = await send(admin, 'put', '/users/' + created.body.id + '/projects', {
        project_ids: projectIds,
      });
      assert.equal(granted.status, 200, granted.text);
      return { id: created.body.id as number, ...(await login(username, researcherPassword)) };
    },
    start(project: Project, body: object, who: Session = admin) {
      return send(who, 'post', '/projects/' + project.id + '/qualification-jobs', body);
    },
    stop(project: Project, jobId: number, who: Session = admin) {
      return send(
        who,
        'post',
        '/projects/' + project.id + '/qualification-jobs/' + jobId + '/stop',
        {},
      );
    },
    async state(project: Project, who: Session = admin) {
      const response = await send(
        who,
        'get',
        '/projects/' + project.id + '/qualification-jobs/current',
      );
      assert.equal(response.status, 200, response.text);
      return response.body as QualificationJobState;
    },
    items(jobId: number) {
      return instance.db
        .prepare(
          'SELECT i.lead_id,l.name,i.status,i.decision,i.error FROM qualification_job_items i JOIN leads l ON l.id=i.lead_id WHERE i.job_id=? ORDER BY i.id',
        )
        .all(jobId) as Array<{
        lead_id: number;
        name: string;
        status: string;
        decision: string | null;
        error: string;
      }>;
    },
    status(lead: Lead) {
      return instance.db
        .prepare('SELECT status FROM leads WHERE id=? AND project_id=?')
        .get(lead.id, lead.project_id) as { status: string };
    },
    updates(project: Project) {
      return (
        instance.db
          .prepare(
            "SELECT DISTINCT title FROM project_notifications WHERE project_id=? AND kind='qualification_job' ORDER BY id",
          )
          .all(project.id) as Array<{ title: string }>
      ).map((row) => row.title);
    },
    /** The server stops and starts again on the same data directory. */
    async restart(runJobs = false) {
      instance.db.close();
      instance = createApp(config(runJobs));
      Object.assign(admin, await login('jobs-admin', adminPassword));
    },
    dispose() {
      if (instance.db.open) instance.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return f;
}
const names = (items: Array<{ name: string }>) => items.map((item) => item.name);

test('project-wide requalification is for administrators; members may queue their own leads, capped, and only in reach', async () => {
  const f = await fixture();
  try {
    const project = await f.project();
    const other = await f.project('Other Research');
    const a = await f.lead(project, 'Alpha Pumps');
    const b = await f.lead(project, 'Beta Pumps');
    const foreign = await f.lead(other, 'Foreign Pumps');
    const member = await f.researcher('member', [project.id]);
    const colleague = await f.researcher('colleague', [project.id]);

    for (const scope of ['stale', 'raw', 'stale_and_raw', 'all']) {
      const refused = await f.start(project, { scope }, member);
      assert.equal(refused.status, 403, scope + ': ' + refused.text);
    }
    const state = await f.state(project, member);
    assert.equal(state.can_start_project_wide, false);
    assert.equal(state.job, null);
    assert.equal(state.counts.raw, 2);

    // A list is required for 'ids' and refused anywhere else; it is capped at 500.
    assert.equal((await f.start(project, { scope: 'ids' }, member)).status, 400);
    assert.equal((await f.start(project, { scope: 'raw', lead_ids: [a.id] })).status, 400);
    const tooMany = Array.from({ length: 501 }, (_, i) => i + 1);
    assert.equal((await f.start(project, { scope: 'ids', lead_ids: tooMany }, member)).status, 400);
    // Another project's lead is not this project's to queue.
    assert.equal(
      (await f.start(project, { scope: 'ids', lead_ids: [foreign.id] }, member)).status,
      404,
    );
    // A project the member cannot reach answers as if it did not exist.
    assert.equal((await f.start(other, { scope: 'ids', lead_ids: [foreign.id] }, member)).status, 404);
    assert.equal(
      (await send(member, 'get', '/projects/' + other.id + '/qualification-jobs/current')).status,
      404,
    );

    const started = await f.start(
      project,
      { scope: 'ids', lead_ids: [a.id, b.id, foreign.id, a.id] },
      member,
    );
    assert.equal(started.status, 201, started.text);
    const job = (started.body as QualificationJobState).job!;
    assert.equal(job.status, 'RUNNING');
    assert.equal(job.total, 2);
    assert.equal(job.created_by, 'Researcher member');
    assert.equal(job.can_stop, true);
    assert.deepEqual(names(f.items(job.id)).sort(), ['Alpha Pumps', 'Beta Pumps']);
    // Everyone on the project sees it; only its starter or an administrator stops it.
    assert.equal((await f.state(project, colleague)).job?.can_stop, false);
    assert.equal((await f.stop(project, job.id, colleague)).status, 403);
    assert.equal((await f.stop(other, job.id)).status, 404);

    // The job spends on its starter's behalf, so it ends with their access.
    assert.equal(await f.jobs.runNext(project.id), 'next');
    const revoked = await send(f.admin, 'put', '/users/' + member.id + '/projects', {
      project_ids: [],
    });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(await f.jobs.runNext(project.id), 'finished');
    const ended = (await f.state(project)).job!;
    assert.equal(ended.status, 'STOPPED');
    assert.equal(ended.done, 1);
    assert.match(ended.stop_reason, /no longer has access/);
  } finally {
    f.dispose();
  }
});

test('scopes pick their leads, never archived ones; one job runs per project and only on current training with a provider', async () => {
  const f = await fixture();
  try {
    const project = await f.project();
    const raw = await f.lead(project, 'Raw Pumps');
    const archivedRaw = await f.lead(project, 'Archived Raw Pumps');
    const current = await f.lead(project, 'Current Pumps');
    const stale = await f.lead(project, 'Stale Pumps');
    const archivedStale = await f.lead(project, 'Archived Stale Pumps');
    for (const lead of [current, stale, archivedStale]) await f.qualify(project, lead);
    // An edit after the analysis makes it stale; archiving takes a lead out of every job.
    for (const lead of [stale, archivedStale])
      f.db.prepare('UPDATE leads SET revision=revision+1 WHERE id=?').run(lead.id);
    for (const lead of [archivedRaw, archivedStale]) {
      const archived = await send(
        f.admin,
        'post',
        '/projects/' + project.id + '/leads/' + lead.id + '/archive',
        { reason: 'COMPANY_CLOSED' },
      );
      assert.equal(archived.status, 200, archived.text);
    }
    const state = await f.state(project);
    assert.deepEqual(state.counts, { requalify: 1, raw: 1, total: 3 });
    assert.equal(state.ready, true);
    assert.equal(state.can_start_project_wide, true);

    const expected: Record<string, string[]> = {
      stale: ['Stale Pumps'],
      raw: ['Raw Pumps'],
      stale_and_raw: ['Raw Pumps', 'Stale Pumps'],
      all: ['Current Pumps', 'Raw Pumps', 'Stale Pumps'],
    };
    for (const [scope, leads] of Object.entries(expected)) {
      const started = await f.start(project, { scope });
      assert.equal(started.status, 201, scope + ': ' + started.text);
      const job = (started.body as QualificationJobState).job!;
      assert.deepEqual(names(f.items(job.id)).sort(), leads, scope);
      // One running job per project.
      const second = await f.start(project, { scope: 'all' });
      assert.equal(second.status, 409);
      assert.match(second.body.error, /already running/);
      // Nothing in progress, so Stop is immediate.
      const stopped = await f.stop(project, job.id);
      assert.equal(stopped.status, 200, stopped.text);
      assert.equal((stopped.body as QualificationJobState).job?.status, 'STOPPED');
      assert.equal((await f.stop(project, job.id)).status, 409);
    }
    assert.equal(
      (await f.start(project, { scope: 'ids', lead_ids: [archivedRaw.id] })).status,
      404,
      'an archived lead is never queued',
    );

    // Unpublished changes to the training: nothing may run until it is published again.
    const latest = (await send(f.admin, 'get', '/projects/' + project.id)).body.project as Project;
    const saved = await send(f.admin, 'put', '/projects/' + project.id + '/training/rubric', {
      revision: latest.revision,
      rubric,
    });
    assert.equal(saved.status, 200, saved.text);
    const unpublished = await f.start(project, { scope: 'all' });
    assert.equal(unpublished.status, 409);
    assert.match(unpublished.body.error, /Publish the current project training/);
    assert.equal((await f.state(project)).ready, false);
  } finally {
    f.dispose();
  }
  const bare = await fixture({ provider: false });
  try {
    const project = await bare.project();
    await bare.lead(project, 'Raw Pumps');
    const refused = await bare.start(project, { scope: 'raw' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Configure an AI provider/);
  } finally {
    bare.dispose();
  }
});

test('a job qualifies one lead at a time through the ordinary path, skips leads already current and reports what it found', async () => {
  const f = await fixture();
  try {
    const project = await f.project();
    const leads = [
      await f.lead(project, 'Alpha Pumps'),
      await f.lead(project, 'Northern Bearings'),
      await f.lead(project, 'Gamma Pumps'),
      await f.lead(project, 'Delta Pumps'),
    ];
    const started = await f.start(project, { scope: 'raw' });
    assert.equal(started.status, 201, started.text);
    const job = (started.body as QualificationJobState).job!;
    assert.equal(job.total, 4);
    assert.equal(job.training_version, 1);
    // Someone qualifies one of them by hand before the job reaches it.
    await f.qualify(project, leads[3]);
    f.ai.calls.length = 0;

    assert.equal(await f.jobs.runNext(project.id), 'next');
    assert.equal(f.ai.calls.length, 1, 'one lead per step');
    let progress = (await f.state(project)).job!;
    assert.equal(progress.done, 1);
    assert.equal(progress.current_lead, null);

    assert.equal(await f.jobs.drain(project.id), 'finished');
    assert.equal(f.ai.peak, 1, 'never two judgements at once');
    assert.deepEqual(f.ai.calls.sort(), ['Alpha Pumps', 'Gamma Pumps', 'Northern Bearings']);
    progress = (await f.state(project)).job!;
    assert.equal(progress.status, 'DONE');
    assert.equal(progress.done, 3);
    assert.equal(progress.skipped, 1);
    assert.equal(progress.failed, 0);
    assert.equal(progress.total, 4);
    assert.ok(progress.finished_at);
    assert.equal(progress.can_stop, false);
    const skipped = f.items(job.id).find((item) => item.status === 'SKIPPED')!;
    assert.equal(skipped.name, 'Delta Pumps');
    assert.match(skipped.error, /Already qualified on training v1/);

    // The job's outcomes are the decisions the leads now carry, and its runs are ordinary runs.
    const tally = { QUALIFIED: 0, NOT_A_TARGET: 0, NEEDS_REVIEW: 0 };
    for (const lead of leads.slice(0, 3))
      tally[f.status(lead).status as keyof typeof tally]++;
    assert.deepEqual(progress.outcomes, tally);
    assert.equal(f.status(leads[1]).status, 'NOT_A_TARGET');
    const runs = f.db
      .prepare(
        'SELECT COUNT(*) n FROM qualification_runs WHERE project_id=? AND created_by=? AND training_version=1',
      )
      .get(project.id, 'Jobs Admin') as { n: number };
    assert.equal(runs.n, 4);
    assert.equal((await f.state(project)).counts.raw, 0);

    assert.deepEqual(f.updates(project), [
      'Qualification finished on training v1: ' +
        tally.QUALIFIED +
        ' qualified, ' +
        tally.NOT_A_TARGET +
        ' not a target, ' +
        tally.NEEDS_REVIEW +
        ' need review (4 leads, 1 skipped)',
    ]);
    const audit = f.db
      .prepare("SELECT action FROM audit_events WHERE project_id=? AND action LIKE 'qualification_job.%' ORDER BY id")
      .all(project.id) as Array<{ action: string }>;
    assert.deepEqual(
      audit.map((row) => row.action),
      ['qualification_job.started', 'qualification_job.finished'],
    );
    assert.equal(await f.jobs.runNext(project.id), 'idle');
  } finally {
    f.dispose();
  }
});

test('requalifying every lead redoes current results once, skipping only leads qualified since it started', async () => {
  const f = await fixture();
  try {
    const project = await f.project();
    const first = await f.lead(project, 'First Pumps');
    const second = await f.lead(project, 'Second Pumps');
    await f.qualify(project, first);
    await f.qualify(project, second);
    const started = await f.start(project, { scope: 'all' });
    assert.equal(started.status, 201, started.text);
    const job = (started.body as QualificationJobState).job!;
    // Qualified by hand after the job started: already on the rules this job is applying.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.qualify(project, second);
    f.ai.calls.length = 0;
    assert.equal(await f.jobs.drain(project.id), 'finished');
    assert.deepEqual(f.ai.calls, ['First Pumps']);
    const items = f.items(job.id);
    assert.deepEqual(
      items.map((item) => [item.name, item.status]),
      [
        ['First Pumps', 'DONE'],
        ['Second Pumps', 'SKIPPED'],
      ],
    );
  } finally {
    f.dispose();
  }
});

test('stop takes effect once the lead in progress is finished', async () => {
  const f = await fixture();
  try {
    const project = await f.project();
    for (const name of ['Alpha Pumps', 'Beta Pumps', 'Gamma Pumps']) await f.lead(project, name);
    const job = ((await f.start(project, { scope: 'raw' })).body as QualificationJobState).job!;
    const first = f.items(job.id)[0].name;
    const held = f.ai.hold(first);
    const step = f.jobs.runNext(project.id);
    await held.entered;
    const progress = (await f.state(project)).job!;
    assert.equal(progress.current_lead?.name, first);

    const stopping = await f.stop(project, job.id);
    assert.equal(stopping.status, 200, stopping.text);
    const asked = (stopping.body as QualificationJobState).job!;
    assert.equal(asked.status, 'RUNNING');
    assert.equal(asked.stopping, true);

    held.release();
    assert.equal(await step, 'finished');
    const stopped = (await f.state(project)).job!;
    assert.equal(stopped.status, 'STOPPED');
    assert.equal(stopped.done, 1, 'the lead in progress was finished and kept');
    assert.equal(stopped.total, 3);
    assert.equal(stopped.stop_reason, 'Stopped by Jobs Admin.');
    assert.deepEqual(
      f.items(job.id).map((item) => item.status),
      ['DONE', 'PENDING', 'PENDING'],
    );
    assert.equal(await f.jobs.runNext(project.id), 'idle');
    assert.deepEqual(f.ai.calls, [first]);
    assert.match(
      f.updates(project)[0],
      /^Qualification stopped on training v1 after 1 of 3 leads: .*\. Stopped by Jobs Admin\.$/,
    );
  } finally {
    f.dispose();
  }
});

test('a training change stops the job, including in the middle of a lead', async () => {
  const f = await fixture();
  try {
    const project = await f.project();
    for (const name of ['Alpha Pumps', 'Beta Pumps', 'Gamma Pumps']) await f.lead(project, name);
    const job = ((await f.start(project, { scope: 'raw' })).body as QualificationJobState).job!;
    assert.equal(await f.jobs.runNext(project.id), 'next');
    // The rules are edited while the second lead is being judged.
    const held = f.ai.hold(f.items(job.id)[1].name);
    const step = f.jobs.runNext(project.id);
    await held.entered;
    const latest = (await send(f.admin, 'get', '/projects/' + project.id)).body.project as Project;
    const saved = await send(f.admin, 'put', '/projects/' + project.id + '/training/rubric', {
      revision: latest.revision,
      rubric,
    });
    assert.equal(saved.status, 200, saved.text);
    held.release();
    assert.equal(await step, 'finished');
    const stopped = (await f.state(project)).job!;
    assert.equal(stopped.status, 'STOPPED');
    assert.equal(stopped.stop_reason, 'Training changed — start again on the new version.');
    assert.equal(stopped.done, 1);
    assert.equal(stopped.failed, 0, 'the interrupted lead is not counted as a failure');
    assert.deepEqual(
      f.items(job.id).map((item) => item.status),
      ['DONE', 'PENDING', 'PENDING'],
    );
  } finally {
    f.dispose();
  }
});

test('a running job carries on after the server restarts', async () => {
  const f = await fixture();
  try {
    const project = await f.project();
    for (const name of ['Alpha Pumps', 'Beta Pumps', 'Gamma Pumps', 'Delta Pumps'])
      await f.lead(project, name);
    const job = ((await f.start(project, { scope: 'raw' })).body as QualificationJobState).job!;
    assert.equal(await f.jobs.runNext(project.id), 'next');

    await f.restart();
    let progress = (await f.state(project)).job!;
    assert.equal(progress.id, job.id);
    assert.equal(progress.status, 'RUNNING');
    assert.equal(progress.done, 1);
    assert.equal(await f.jobs.runNext(project.id), 'next');

    // With the background runner on, starting the app is enough to pick the job up again.
    await f.restart(true);
    await f.jobs.idle();
    progress = (await f.state(project)).job!;
    assert.equal(progress.status, 'DONE');
    assert.equal(progress.done, 4);
    assert.equal(new Set(f.ai.calls).size, 4, 'no lead was judged twice');
    assert.equal(f.ai.calls.length, 4);
  } finally {
    f.dispose();
  }
});

test('failures are recorded per lead; three provider failures in a row stop the job without repeating the provider', async () => {
  const f = await fixture();
  try {
    const project = await f.project();
    for (const name of ['Alpha Pumps', 'Broken Pumps', 'Gamma Pumps']) await f.lead(project, name);
    let job = ((await f.start(project, { scope: 'raw' })).body as QualificationJobState).job!;
    // An unusable answer fails that lead only.
    assert.equal(await f.jobs.drain(project.id), 'finished');
    let progress = (await f.state(project)).job!;
    assert.equal(progress.status, 'DONE');
    assert.equal(progress.done, 2);
    assert.equal(progress.failed, 1);
    assert.deepEqual(
      progress.failures.map((failure) => failure.lead_name),
      ['Broken Pumps'],
    );
    assert.match(progress.failures[0].error, /incomplete answer/);

    for (const name of ['Delta Pumps', 'Epsilon Pumps', 'Zeta Pumps', 'Eta Pumps', 'Theta Pumps'])
      await f.lead(project, name);
    f.ai.fail = () =>
      new HttpError(
        502,
        'AI provider authentication failed (HTTP 401: key sk-live-SECRET-1234 was revoked). Check your API key in Settings.',
      );
    job = ((await f.start(project, { scope: 'raw' })).body as QualificationJobState).job!;
    assert.equal(job.total, 6, 'the broken lead is still unanalysed');
    assert.equal(await f.jobs.drain(project.id), 'finished');
    const response = await send(
      f.admin,
      'get',
      '/projects/' + project.id + '/qualification-jobs/current',
    );
    progress = (response.body as QualificationJobState).job!;
    assert.equal(progress.status, 'STOPPED');
    assert.equal(progress.failed, 3);
    assert.equal(progress.done, 0);
    assert.equal(progress.total, 6);
    assert.equal(
      progress.stop_reason,
      'Stopped after 3 failures in a row: The AI provider refused the API key. Fix it in Settings, then start again.',
    );
    assert.equal(progress.failures[0].error, 'The AI provider refused the API key.');
    assert.ok(!response.text.includes('SECRET'), 'the provider’s own words never reach the panel');
    assert.ok(!f.updates(project).join(' ').includes('SECRET'));
    assert.equal(f.items(job.id).filter((item) => item.status === 'PENDING').length, 3);
  } finally {
    f.dispose();
  }
});

test('a lead already being analysed makes the job wait, not fail', async () => {
  const f = await fixture();
  try {
    const project = await f.project();
    const lead = await f.lead(project, 'Busy Pumps');
    const job = ((await f.start(project, { scope: 'raw' })).body as QualificationJobState).job!;
    // A person runs the same lead by hand; the job meets the busy slot.
    const held = f.ai.hold('Busy Pumps');
    const manual = send(
      f.admin,
      'post',
      '/projects/' + project.id + '/leads/' + lead.id + '/qualify',
      {},
    ).then((response) => response);
    await held.entered;
    assert.equal(await f.jobs.runNext(project.id), 'wait');
    assert.deepEqual(
      f.items(job.id).map((item) => item.status),
      ['PENDING'],
    );
    assert.equal((await f.state(project)).job!.failed, 0);
    held.release();
    assert.equal((await manual).status, 200);
    // By its turn the lead is current, so the job has nothing left to spend.
    assert.equal(await f.jobs.drain(project.id), 'finished');
    const done = (await f.state(project)).job!;
    assert.equal(done.status, 'DONE');
    assert.equal(done.skipped, 1);
  } finally {
    f.dispose();
  }
});

test('deleting a project ends its job cleanly, even with a lead in progress', async () => {
  const f = await fixture();
  try {
    const project = await f.project('Doomed Research');
    for (const name of ['Alpha Pumps', 'Beta Pumps']) await f.lead(project, name);
    const job = ((await f.start(project, { scope: 'raw' })).body as QualificationJobState).job!;
    const held = f.ai.hold(f.items(job.id)[0].name);
    const step = f.jobs.runNext(project.id);
    await held.entered;
    const deleted = await send(f.admin, 'delete', '/projects/' + project.id, {
      confirm_name: 'Doomed Research',
    });
    assert.equal(deleted.status, 200, deleted.text);
    assert.ok(deleted.body.removed.qualification_jobs >= 1);
    held.release();
    assert.equal(await step, 'finished');
    for (const table of ['qualification_jobs', 'qualification_job_items'])
      assert.equal(
        (
          f.db
            .prepare('SELECT COUNT(*) n FROM ' + table + ' WHERE project_id=?')
            .get(project.id) as { n: number }
        ).n,
        0,
      );
    assert.equal(await f.jobs.runNext(project.id), 'idle');
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.dispose();
  }
});

test('a research pass says when the lead is ready for qualification, and qualifying next reuses it', async () => {
  const f = await fixture();
  try {
    const project = await f.project();
    const lead = await f.lead(project, 'Raw Pumps');
    const research = () =>
      send(f.admin, 'post', '/projects/' + project.id + '/leads/' + lead.id + '/research', {});
    const titles = () =>
      (
        f.db
          .prepare("SELECT title FROM notifications WHERE lead_id=? AND kind='research' ORDER BY id")
          .all(lead.id) as Array<{ title: string }>
      ).map((row) => row.title);
    assert.equal((await research()).status, 200);
    assert.deepEqual(
      [...new Set(titles())],
      ['Raw Pumps: research completed — nothing new found · ready for qualification'],
    );
    // The qualification that follows uses that pass instead of paying for another.
    const passes = f.ai.research;
    await f.qualify(project, lead);
    assert.equal(f.ai.research, passes);
    // A lead whose qualification is current is not "ready" for another one.
    assert.equal((await research()).status, 200);
    assert.equal(titles().at(-1), 'Raw Pumps: research completed — nothing new found');
  } finally {
    f.dispose();
  }
});

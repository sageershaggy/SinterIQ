import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { openDatabase } from '../server/database';
import { researchMayReplace } from '../server/field-history';
import { earlierTeamEdit, installFieldHistorySchema } from '../server/field-history-schema';
import type { Generate } from '../server/ai';
import type { Evidence, Lead, Project, Qualification, ResearchOutcome, Run } from '../shared/types';
import type { ResearchProfile } from '../shared/research';
import type { ImportPreview } from '../shared/lead-import';
import { fieldProvenance, type FieldChange } from '../shared/field-history';
import type { QualificationJobState } from '../shared/qualification-jobs';

/*
 * Phase 3, D1–D4: researched values become the lead's current values, the imported value they
 * replaced stays in the lead's history, and nothing a rerun or a re-import does loses a lead or
 * its qualification.
 */

const rubric = {
  summary: 'Find community organisations that run services.',
  criteria: ['Runs community services'],
  exclusions: ['Is a government agency'],
  questions: [],
};
const home = 'https://camba-industrial.example.org';
const headOffice = 'Our head office is in Frankfurt am Main, Germany.';
const pageText =
  'CAMBA Industrial runs housing, legal and youth services. ' +
  headOffice +
  ' CAMBA Industrial employs 1,800 people across the region.';
const trainingSite = 'Example Research finds community organisations.';

/** A row as the team's list has it: New York, United States. Every researchable field filled. */
const importedRow = {
  name: 'CAMBA Industrial',
  website: home,
  city: 'New York',
  country: 'United States',
  industry: 'Nonprofit',
  employee_count: '200',
  contact_name: 'Pat Lee',
  contact_role: 'Director',
  contact_email: 'pat@camba-industrial.example.org',
  contact_phone: '+1 718 555 0100',
};

interface Mode {
  /** How the next qualification answers: normally, unreadably, or with a provider error. */
  qualify: 'ok' | 'invalid' | 'throw';
  /** Runs inside the research pass, between reading the page and writing what it proved. */
  during?: () => Promise<void>;
  /** What the research pass extracts from the page. */
  extract?: unknown;
  /** The company website answers nothing (a passing network failure). */
  siteDown?: boolean;
}

/** A qualification that meets the one criterion and reports the website's location. */
function answer(input: unknown) {
  const typed = input as { lead: { city: string; country: string }; evidence: Evidence[] };
  const page = typed.evidence.find((item) => item.kind === 'website')?.id ?? 'E1';
  return {
    decision: 'QUALIFIED',
    score: 100,
    confidence: 80,
    summary:
      'The record says ' +
      typed.lead.city +
      '; the company’s website gives Frankfurt am Main, Germany.',
    criteria: [
      {
        criterion: rubric.criteria[0],
        outcome: 'MATCH',
        evidence: 'Runs housing and youth services.',
        source_ids: [page],
      },
    ],
    exclusions: [
      {
        criterion: rubric.exclusions[0],
        outcome: 'NO_MATCH',
        evidence: 'A nonprofit.',
        source_ids: [page],
      },
    ],
    gaps: [],
    next_steps: [],
    conflicts: [
      {
        field: 'city',
        record_value: typed.lead.city,
        found_value: 'Frankfurt am Main',
        quote: headOffice,
        source_ids: [page],
      },
      {
        field: 'country',
        record_value: typed.lead.country,
        found_value: 'Germany',
        quote: headOffice,
        source_ids: [page],
      },
    ],
  };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-integrity-'));
  const mode: Mode = { qualify: 'ok' };
  const generate: Generate = async (_config, system, input) => {
    if (system.includes('proposed qualification rubric')) return rubric;
    if (system.includes('candidate official website domains')) return { domains: [] };
    if (system.includes('extract company facts')) {
      const during = mode.during;
      mode.during = undefined;
      await during?.();
      return mode.extract ?? { fields: [], notes: [] };
    }
    if (mode.qualify === 'throw') throw new Error('Provider unavailable (stub).');
    if (mode.qualify === 'invalid') return { decision: 'QUALIFIED' };
    return answer(input);
  };
  const { app, db, qualificationJobs } = createApp({
    dataDir: dir,
    generate,
    runJobs: false,
    fetchWebsite: async (url) => {
      if (mode.siteDown && !url.startsWith('https://example.org'))
        throw new Error('This website could not be reached.');
      return {
        url,
        content: url.startsWith('https://example.org') ? trainingSite : pageText,
        truncated: false,
        links: [],
      };
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
    db,
    dir,
    mode,
    jobs: qualificationJobs,
    post: (url: string, body: object = {}) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    del: (url: string) => send('delete', url),
    get: (url: string) => agent.get('/api' + url),
    upload: (url: string, csv: string) =>
      agent
        .post('/api' + url)
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', csrf)
        .attach('file', Buffer.from(csv), 'leads.csv'),
    async setup() {
      const response = await send('post', '/auth/setup', {
        name: 'Integrity Administrator',
        username: 'integrity-admin',
        password: 'A-long-integrity-password-2026',
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      csrf = response.body.csrf_token;
    },
    dispose() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
type Detail = Lead & { runs: Run[] };

async function readyProject(f: Fixture) {
  const created = await f.post('/projects', {
    name: 'Community Research',
    website: 'https://example.org',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id as number;
  let project: Project = (await f.get('/projects/' + id)).body.project;
  await f.post('/projects/' + id + '/sources', {
    revision: project.revision,
    title: 'Brief',
    content: 'Target community organisations that run services.',
  });
  project = (await f.get('/projects/' + id)).body.project;
  await f.post('/projects/' + id + '/sources/website', {
    revision: project.revision,
    url: 'https://example.org',
  });
  project = (await f.get('/projects/' + id)).body.project;
  const saved = await f.put('/projects/' + id + '/training/rubric', {
    revision: project.revision,
    rubric,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const published = await f.post('/projects/' + id + '/training/publish', {
    revision: saved.body.revision,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return published.body as Project;
}
async function importRows(
  f: Fixture,
  project: Project,
  rows: object[],
  onDuplicate: 'skip' | 'update' = 'skip',
) {
  const response = await f.post('/projects/' + project.id + '/leads/import/rows', {
    leads: rows,
    on_duplicate: onDuplicate,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as {
    created: number;
    updated: number;
    skipped: number;
    created_ids: number[];
  };
}
async function importOne(f: Fixture, project: Project, row: object = importedRow) {
  const { created_ids } = await importRows(f, project, [row]);
  assert.equal(created_ids.length, 1);
  return '/projects/' + project.id + '/leads/' + created_ids[0];
}
const detail = async (f: Fixture, base: string) => (await f.get(base)).body as Detail;
const history = async (f: Fixture, base: string) =>
  ((await f.get(base + '/research-profile')).body as ResearchProfile).history as FieldChange[];
/** The lead's qualification as the list and the lead page show it. */
const standing = (lead: Lead) => ({
  status: lead.status,
  score: lead.score,
  latest_run_id: lead.latest_run_id,
  stale: lead.stale,
});

test('research wins over an imported value: applied when the run is saved, kept in the history, and the run stays current', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = await importOne(f, project);
    const imported = await detail(f, base);
    assert.equal(imported.revision, 1);

    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const result = qualified.body.result as Qualification;
    assert.deepEqual(
      result.conflicts?.map((item) => [
        item.field,
        item.record_value,
        item.found_value,
        item.applied,
      ]),
      [
        ['city', 'New York', 'Frankfurt am Main', true],
        ['country', 'United States', 'Germany', true],
      ],
    );

    // The researched value is the current value, and the run that found it is current too.
    const after = await detail(f, base);
    assert.equal(after.city, 'Frankfurt am Main');
    assert.equal(after.country, 'Germany');
    assert.equal(after.revision, 2, 'one recorded edit for both fields');
    assert.equal(after.qualified_revision, 2);
    assert.equal(after.stale, false);
    assert.equal(after.status, 'QUALIFIED');
    assert.equal(after.score, 100);
    assert.equal(after.next_step, 'CALL_READY');
    // The stored run says what it applied, and judged the record it was given.
    assert.equal(after.runs.length, 1);
    assert.ok(after.runs[0].result.conflicts?.every((item) => item.applied));
    assert.equal(after.runs[0].lead_revision, 1);

    // Each value keeps its sentence and page, like any researched value.
    const profile = (await f.get(base + '/research-profile')).body as ResearchProfile;
    const city = profile.citations.find((item) => item.field === 'city');
    assert.equal(city?.value, 'Frankfurt am Main');
    assert.equal(city?.evidence, headOffice);
    assert.equal(city?.source_url, home);

    // The original imported value is not lost: it is in the history, with who set what.
    const rows = profile.history!;
    const cityRows = rows.filter((row) => row.field === 'city').reverse();
    assert.deepEqual(
      cityRows.map((row) => [row.origin, row.previous_value, row.new_value]),
      [
        ['import', '', 'New York'],
        ['research', 'New York', 'Frankfurt am Main'],
      ],
    );
    assert.equal(cityRows[1].evidence, headOffice);
    assert.equal(cityRows[1].source_url, home);
    assert.deepEqual(fieldProvenance(rows, 'city', after.city).original, {
      value: 'New York',
      origin: 'import',
    });
    assert.deepEqual(fieldProvenance(rows, 'country', after.country).original, {
      value: 'United States',
      origin: 'import',
    });
    const events = f.db
      .prepare("SELECT detail FROM audit_events WHERE action='lead.research_applied' ORDER BY id")
      .all() as Array<{ detail: string }>;
    assert.equal(events.length, 2);
    assert.match(events[0].detail, /City changed from "New York" to "Frankfurt am Main"/);

    // Running it again changes nothing: the website and the record agree now.
    const again = await f.post(base + '/qualify');
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual((again.body.result as Qualification).conflicts, []);
    const settled = await detail(f, base);
    assert.equal(settled.revision, 2);
    assert.equal(settled.stale, false);
    assert.equal((await history(f, base)).length, rows.length);

    // Deleting the lead deletes its history with it.
    const lead = settled.id;
    assert.equal((await f.del(base)).status, 200);
    assert.equal(
      (
        f.db.prepare('SELECT COUNT(*) n FROM lead_field_history WHERE lead_id=?').get(lead) as {
          n: number;
        }
      ).n,
      0,
    );
  } finally {
    f.dispose();
  }
});

test('a value a person typed is never replaced: the conflict stays visible for “Use website value”', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = await importOne(f, project);
    const lead = await detail(f, base);
    // Someone corrects the city by hand after the import; the country stays as imported.
    const edited = await f.put(base, { ...importedRow, revision: lead.revision, city: 'Queens' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const conflicts = (qualified.body.result as Qualification).conflicts!;
    assert.equal(conflicts.find((item) => item.field === 'city')?.applied, undefined);
    assert.equal(conflicts.find((item) => item.field === 'country')?.applied, true);

    const after = await detail(f, base);
    assert.equal(after.city, 'Queens', 'the typed value stays');
    assert.equal(after.country, 'Germany', 'the imported one is replaced');
    assert.equal(after.stale, false);
    const typed = (await history(f, base)).filter((row) => row.field === 'city');
    assert.deepEqual(
      typed.map((row) => row.origin),
      ['person', 'import'],
    );

    // The person can still choose the website's value; that is an ordinary recorded edit.
    const applied = await f.post(base + '/conflicts/apply', {
      run_id: after.latest_run_id,
      field: 'city',
      revision: after.revision,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const rows = await history(f, base);
    assert.deepEqual(fieldProvenance(rows, 'city', 'Frankfurt am Main').original, {
      value: 'Queens',
      origin: 'person',
    });

    // A lead typed into the form is the team's too: research does not overwrite it.
    const typedLead = await f.post('/projects/' + project.id + '/leads', {
      ...importedRow,
      name: 'Typed Organisation',
      website: 'https://typed.example.org',
    });
    assert.equal(typedLead.status, 201, JSON.stringify(typedLead.body));
    const typedBase = '/projects/' + project.id + '/leads/' + typedLead.body.id;
    assert.equal((await f.post(typedBase + '/qualify')).status, 200);
    const kept = await detail(f, typedBase);
    assert.equal(kept.city, 'New York');
    assert.equal(kept.country, 'United States');
    assert.equal(kept.runs[0].result.conflicts?.length, 2);
    assert.ok(kept.runs[0].result.conflicts?.every((item) => !item.applied));
  } finally {
    f.dispose();
  }
});

test('re-importing the same rows creates nothing and keeps the status, score and researched values', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const other = {
      name: 'Delta Pumps',
      website: 'https://delta-pumps.example.com',
      industry: 'Pumps',
    };
    await importRows(f, project, [importedRow, other]);
    const leads = () =>
      f.db
        .prepare('SELECT id,name FROM leads WHERE project_id=? ORDER BY id')
        .all(project.id) as Array<{
        id: number;
        name: string;
      }>;
    const [camba] = leads();
    const base = '/projects/' + project.id + '/leads/' + camba.id;
    assert.equal((await f.post(base + '/qualify')).status, 200);
    const qualified = await detail(f, base);
    assert.equal(qualified.country, 'Germany');

    // The same file again, skipping duplicates: nothing new, nothing changed.
    const skipped = await importRows(f, project, [importedRow, other]);
    assert.deepEqual([skipped.created, skipped.updated, skipped.skipped], [0, 0, 2]);
    // And updating them: the list's "United States" must not put back what research replaced.
    const updated = await importRows(f, project, [importedRow, other], 'update');
    assert.deepEqual([updated.created, updated.updated, updated.skipped], [0, 0, 2]);
    assert.equal(leads().length, 2);
    const after = await detail(f, base);
    assert.deepEqual(standing(after), standing(qualified));
    assert.equal(after.revision, qualified.revision);
    assert.equal(after.country, 'Germany');
    assert.equal(after.city, 'Frankfurt am Main');
    assert.equal(after.runs.length, 1);

    // The default list still shows it, with its rating.
    const listed = (await f.get('/projects/' + project.id + '/leads')).body.leads as Lead[];
    const row = listed.find((item) => item.id === camba.id)!;
    assert.deepEqual(standing(row), standing(qualified));

    // An imported value is still the list's to update, and the change is recorded as an import.
    const changed = await importRows(
      f,
      project,
      [{ ...other, industry: 'Industrial pumps' }],
      'update',
    );
    assert.equal(changed.updated, 1);
    const delta = '/projects/' + project.id + '/leads/' + leads()[1].id;
    assert.equal((await detail(f, delta)).industry, 'Industrial pumps');
    assert.deepEqual(
      (await history(f, delta))
        .filter((item) => item.field === 'industry')
        .map((item) => [item.origin, item.previous_value, item.new_value]),
      [
        ['import', 'Pumps', 'Industrial pumps'],
        ['import', '', 'Pumps'],
      ],
    );

    // The preview says where a duplicate stands, which the import keeps.
    const preview = await f.upload(
      '/projects/' + project.id + '/leads/import/preview',
      'name,website,country\nCAMBA Industrial,' + home + ',United States\n',
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual((preview.body as ImportPreview).rows[0].duplicate, {
      id: camba.id,
      name: 'CAMBA Industrial',
      status: 'QUALIFIED',
      score: 100,
      stale: false,
      archived: false,
    });
  } finally {
    f.dispose();
  }
});

test('a failed or stopped rerun keeps the previous status, score and run', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = await importOne(f, project);
    assert.equal((await f.post(base + '/qualify')).status, 200);
    const before = await detail(f, base);
    assert.equal(before.status, 'QUALIFIED');

    // The provider answers with something unusable, or not at all.
    f.mode.qualify = 'invalid';
    const invalid = await f.post(base + '/qualify');
    assert.equal(invalid.status, 502, JSON.stringify(invalid.body));
    f.mode.qualify = 'throw';
    const failed = await f.post(base + '/qualify');
    assert.ok(failed.status >= 500, JSON.stringify(failed.body));
    let after = await detail(f, base);
    assert.deepEqual(standing(after), standing(before));
    assert.equal(after.revision, before.revision);
    assert.equal(after.qualified_revision, before.qualified_revision);
    assert.equal(after.runs.length, 1);

    // A job that fails on the lead leaves it as it was too. Editing it first no longer makes it
    // out of date — a settled lead keeps its verdict when its details are corrected — and the job
    // runs it anyway, because a job given lead ids was asked for those leads by name.
    const edited = await f.put(base, {
      ...importedRow,
      city: after.city,
      country: after.country,
      notes: 'Met at the expo.',
      revision: after.revision,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const outdated = await detail(f, base);
    assert.equal(outdated.stale, false);
    assert.equal(outdated.notes, 'Met at the expo.');
    const started = await f.post('/projects/' + project.id + '/qualification-jobs', {
      scope: 'ids',
      lead_ids: [outdated.id],
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    await f.jobs.drain(project.id);
    const job = (
      (await f.get('/projects/' + project.id + '/qualification-jobs/current'))
        .body as QualificationJobState
    ).job!;
    assert.equal(job.failed, 1);
    after = await detail(f, base);
    // Still rated: the earlier decision, score and run survive a failed attempt untouched. The
    // job did reach the lead — it counted a failure rather than a skip — and failing taught it
    // nothing, so the lead is exactly where it was.
    assert.deepEqual(standing(after), standing(before));
    assert.equal(after.runs.length, 1);

    // Stopped before it reached the lead: nothing at all happens to it.
    f.mode.qualify = 'ok';
    const second = await f.post('/projects/' + project.id + '/qualification-jobs', {
      scope: 'ids',
      lead_ids: [outdated.id],
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const stopped = await f.post(
      '/projects/' +
        project.id +
        '/qualification-jobs/' +
        (second.body as QualificationJobState).job!.id +
        '/stop',
    );
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    await f.jobs.drain(project.id);
    assert.deepEqual(standing(await detail(f, base)), standing(after));
  } finally {
    f.dispose();
  }
});

test('values typed on the lead form before the history existed are adopted as typed, once', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const typed = await f.post('/projects/' + project.id + '/leads', {
      ...importedRow,
      name: 'Typed Organisation',
      website: 'https://typed.example.org',
    });
    assert.equal(typed.status, 201, JSON.stringify(typed.body));
    const edited = await importOne(f, project, {
      ...importedRow,
      name: 'Edited Organisation',
      website: 'https://edited.example.org',
    });
    const editedLead = await detail(f, edited);
    assert.equal(
      (
        await f.put(edited, {
          ...importedRow,
          name: 'Edited Organisation',
          website: 'https://edited.example.org',
          notes: 'Called once.',
          revision: editedLead.revision,
        })
      ).status,
      200,
    );
    const imported = await importOne(f, project);
    const importedId = Number(imported.split('/').pop());
    // The database as it was before this change: no history, and nothing adopted yet.
    f.db.exec("DELETE FROM lead_field_history; DELETE FROM meta WHERE key='lead_field_history_v1'");
    const { db } = openDatabase(f.dir);
    try {
      const rows = (id: number) =>
        db
          .prepare(
            'SELECT field,origin,previous_value,new_value,changed_by FROM lead_field_history WHERE lead_id=? ORDER BY id',
          )
          .all(id) as Array<Record<string, string>>;
      assert.deepEqual(
        rows(typed.body.id).map((row) => [row.field, row.origin, row.new_value, row.changed_by]),
        [
          ['website', 'person', 'https://typed.example.org', earlierTeamEdit],
          ['country', 'person', 'United States', earlierTeamEdit],
          ['city', 'person', 'New York', earlierTeamEdit],
          ['industry', 'person', 'Nonprofit', earlierTeamEdit],
          ['employee_count', 'person', '200', earlierTeamEdit],
        ],
      );
      // An edit on the form does not say which fields it changed, so all are the team's.
      assert.equal(rows(editedLead.id).length, 5);
      assert.equal(researchMayReplace(db, project.id, editedLead.id, 'city', 'New York'), false);
      // A lead only ever imported stays the original record, which research may replace.
      assert.deepEqual(rows(importedId), []);
      assert.equal(researchMayReplace(db, project.id, importedId, 'city', 'New York'), true);
      // Once only.
      installFieldHistorySchema(db);
      assert.equal(
        (db.prepare('SELECT COUNT(*) n FROM lead_field_history').get() as { n: number }).n,
        10,
      );
    } finally {
      db.close();
    }
  } finally {
    f.dispose();
  }
});

test('the original value is read back from the history, however research reached the record', () => {
  const change = (
    id: number,
    field: FieldChange['field'],
    origin: FieldChange['origin'],
    previous_value: string,
    new_value: string,
  ): FieldChange => ({
    id,
    field,
    origin,
    previous_value,
    new_value,
    evidence: '',
    source_url: '',
    changed_at: '2026-10-0' + id + 'T00:00:00.000Z',
    changed_by: 'Someone',
  });
  // Imported, then replaced twice by research: the imported value is the original.
  const twice = [
    change(1, 'city', 'import', '', 'New York'),
    change(2, 'city', 'research', 'New York', 'Brooklyn'),
    change(3, 'city', 'research', 'Brooklyn', 'Frankfurt am Main'),
  ];
  assert.deepEqual(fieldProvenance(twice, 'city', 'Frankfurt am Main').original, {
    value: 'New York',
    origin: 'import',
  });
  assert.equal(fieldProvenance(twice, 'city', 'Frankfurt am Main').change?.id, 3);
  // A record older than the history: research's own row remembers what it replaced.
  assert.deepEqual(
    fieldProvenance([change(1, 'city', 'research', 'Arverne', 'Brooklyn')], 'city', 'brooklyn')
      .original,
    { value: 'Arverne', origin: null },
  );
  // Research that filled a blank replaced nothing; an imported value has no original.
  assert.equal(
    fieldProvenance([change(1, 'city', 'research', '', 'Brooklyn')], 'city', 'Brooklyn').original,
    null,
  );
  assert.deepEqual(fieldProvenance([change(1, 'city', 'import', '', 'Queens')], 'city', 'Queens'), {
    origin: 'import',
    original: null,
    change: change(1, 'city', 'import', '', 'Queens'),
  });
  // A value the history did not write is not described by it.
  assert.deepEqual(fieldProvenance(twice, 'city', 'Hamburg'), {
    origin: null,
    original: null,
    change: null,
  });
});

test('default views keep an earlier qualified lead, and a researched value from before the history still outranks a re-import', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = await importOne(f, project);
    assert.equal((await f.post(base + '/qualify')).status, 200);
    const qualified = await detail(f, base);
    // Yesterday's result; today the training changes and is published again.
    f.db
      .prepare("UPDATE leads SET updated_at='2026-10-06T09:00:00.000Z' WHERE id=?")
      .run(qualified.id);
    const current: Project = (await f.get('/projects/' + project.id)).body.project;
    const saved = await f.put('/projects/' + project.id + '/training/rubric', {
      revision: current.revision,
      rubric: { ...rubric, criteria: [...rubric.criteria, 'Publishes its service locations'] },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const republished = await f.post('/projects/' + project.id + '/training/publish', {
      revision: saved.body.revision,
    });
    assert.equal(republished.status, 200, JSON.stringify(republished.body));
    // New leads arrive after it, so it is no longer the most recently updated.
    await importRows(
      f,
      project,
      Array.from({ length: 5 }, (_, index) => ({ name: 'New Organisation ' + (index + 1) })),
    );
    for (const query of ['', '?status=QUALIFIED', '?sort=score_desc']) {
      const page = (await f.get('/projects/' + project.id + '/leads' + query)).body as {
        leads: Lead[];
      };
      const row = page.leads.find((item) => item.id === qualified.id);
      assert.ok(row, 'listed in ' + (query || 'the default view'));
      assert.deepEqual(standing(row), { ...standing(qualified), stale: true });
    }

    // A lead researched before the history existed: its citation alone marks the value as
    // research, so the list's older value is not put back.
    f.db.prepare('DELETE FROM lead_field_history WHERE lead_id=?').run(qualified.id);
    const updated = await importRows(f, project, [importedRow], 'update');
    assert.equal(updated.updated, 0);
    assert.equal((await detail(f, base)).country, 'Germany');
  } finally {
    f.dispose();
  }
});

test('research write-back replaces an imported value, never a typed one, and a qualified lead keeps its rating', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    // Qualified first, with the country blank so research has something to find later.
    const base = await importOne(f, project, {
      ...importedRow,
      country: '',
      city: 'Frankfurt am Main',
    });
    f.mode.extract = { fields: [], notes: [] };
    assert.equal((await f.post(base + '/qualify')).status, 200);
    const qualified = await detail(f, base);
    assert.equal(qualified.status, 'QUALIFIED');
    assert.equal(qualified.stale, false);

    // While the research pass reads the page, the same list is imported again with an update
    // that fills the blank country with the list's value. Research proves Germany, and wins.
    const proposal = {
      fields: [{ field: 'country', value: 'Germany', evidence: headOffice, page_url: home }],
      notes: [],
    };
    f.mode.extract = proposal;
    f.mode.during = async () => {
      await importRows(f, project, [{ ...importedRow, city: 'Frankfurt am Main' }], 'update');
    };
    const researched = await f.post(base + '/research');
    assert.equal(researched.status, 200, JSON.stringify(researched.body));
    assert.deepEqual((researched.body as ResearchOutcome).applied, ['country']);
    const after = await detail(f, base);
    assert.equal(after.country, 'Germany');
    assert.deepEqual(
      (await history(f, base))
        .filter((row) => row.field === 'country')
        .map((row) => [row.origin, row.previous_value, row.new_value]),
      [
        ['research', 'United States', 'Germany'],
        ['import', '', 'United States'],
      ],
    );
    // The record changed under the earlier run, so it is out of date — but its decision and
    // score stay on the lead page and in the default list instead of being blanked.
    assert.equal(after.stale, true);
    assert.equal(after.status, 'QUALIFIED');
    assert.equal(after.score, qualified.score);
    assert.equal(after.latest_run_id, qualified.latest_run_id);
    const listed = (await f.get('/projects/' + project.id + '/leads')).body.leads as Lead[];
    assert.deepEqual(standing(listed.find((item) => item.id === after.id)!), standing(after));

    // A person types a country while the next pass runs: research leaves it alone.
    const typed = await importOne(f, project, {
      ...importedRow,
      name: 'Typed Country Org',
      website: 'https://typed-country.example.org',
      country: '',
    });
    f.mode.extract = proposal;
    f.mode.during = async () => {
      const current = await detail(f, typed);
      const saved = await f.put(typed, {
        ...importedRow,
        name: 'Typed Country Org',
        website: 'https://typed-country.example.org',
        country: 'Austria',
        revision: current.revision,
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
    };
    const refused = await f.post(typed + '/research');
    assert.equal(refused.status, 200, JSON.stringify(refused.body));
    const outcome = refused.body as ResearchOutcome;
    assert.deepEqual(outcome.applied, []);
    assert.match(
      outcome.refused.find((item) => item.field === 'country')?.reason || '',
      /A person entered this value/,
    );
    assert.equal((await detail(f, typed)).country, 'Austria');
  } finally {
    f.dispose();
  }
});

test('a rerun that cannot reach the website keeps the verdict instead of downgrading it', async () => {
  const f = fixture();
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = await importOne(f, project);
    assert.equal((await f.post(base + '/qualify')).status, 200);
    const before = await detail(f, base);
    assert.equal(before.status, 'QUALIFIED');

    f.mode.siteDown = true;
    const rerun = await f.post(base + '/qualify');
    assert.equal(rerun.status, 503, JSON.stringify(rerun.body));
    assert.match(rerun.body.error, /previous result was kept/);
    const after = await detail(f, base);
    assert.deepEqual(standing(after), standing(before));
    assert.equal(after.runs.length, 1);
  } finally {
    f.dispose();
  }
});

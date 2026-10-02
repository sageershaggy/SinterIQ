import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { emailDomainCandidate, isSharedMailDomain } from '../server/enrich';
import { specificBlocker, validateQualification, type Generate } from '../server/ai';
import type { WebsitePage } from '../server/network';
import type {
  Evidence,
  Lead,
  Project,
  Qualification,
  ResearchOutcome,
  Run,
  TrainingSnapshot,
} from '../shared/types';
import {
  classifyRole,
  fitBandFor,
  rolesSought,
  type LeadContact,
  type ResearchProfile,
  type SourceUpload,
  type TrainingGraph,
} from '../shared/research';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;

const rubric = {
  summary:
    'Find pump manufacturers with engineering teams. Reach the purchasing manager or a marketing assistant.',
  criteria: ['Manufactures pumps', 'Employs engineers'],
  exclusions: ['Manufactures bearings'],
  questions: [],
};
const trainingSite =
  'Example Research helps industrial suppliers find pump manufacturers across Europe and the Gulf.';

interface Calls {
  discover: unknown[];
  extract: unknown[];
  qualify: unknown[];
  systems: string[];
}
interface Model {
  discover?: (input: Record<string, unknown>) => unknown;
  extract?: (input: Record<string, unknown>) => unknown;
  /** Answers the nth qualification call (0-based). */
  qualify?: (input: { approved_training: TrainingSnapshot }, attempt: number) => unknown;
}
/** A complete qualification of every approved rule, citing the first website evidence supplied. */
function complete(input: {
  approved_training: TrainingSnapshot;
  evidence?: Array<{ id: string; kind: string }>;
}) {
  const snapshot = input.approved_training;
  const cite = input.evidence?.find((item) => item.kind === 'website')?.id ?? 'E1';
  return {
    decision: 'QUALIFIED',
    score: 90,
    confidence: 90,
    summary: 'Manufactures pumps with an engineering team.',
    criteria: snapshot.rubric.criteria.map((criterion) => ({
      criterion,
      outcome: 'MATCH',
      evidence: 'The website describes pump manufacturing and an engineering team.',
      source_ids: [cite],
    })),
    exclusions: snapshot.rubric.exclusions.map((criterion) => ({
      criterion,
      outcome: 'NO_MATCH',
      evidence: 'The website says it buys third-party bearings.',
      source_ids: [cite],
    })),
    gaps: [],
    next_steps: [],
  };
}
function fixture(model: Model, pages: Record<string, string | WebsitePage>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-research-'));
  const calls: Calls = { discover: [], extract: [], qualify: [], systems: [] };
  const generate: Generate = async (_config, system, input) => {
    calls.systems.push(system);
    if (system.includes('proposed qualification rubric')) return rubric;
    if (system.includes('candidate official website domains')) {
      calls.discover.push(input);
      return model.discover?.(input as Record<string, unknown>) ?? { domains: [] };
    }
    if (system.includes('extract company facts')) {
      calls.extract.push(input);
      return model.extract?.(input as Record<string, unknown>) ?? { fields: [], notes: [] };
    }
    calls.qualify.push(input);
    const typed = input as { approved_training: TrainingSnapshot };
    return model.qualify
      ? model.qualify(typed, calls.qualify.length - 1)
      : complete(typed);
  };
  const fetched: string[] = [];
  const { app, db } = createApp({
    dataDir: dir,
    generate,
    fetchWebsite: async (url) => {
      fetched.push(url);
      const page = pages[url];
      if (page === undefined) throw new Error('This website could not be reached.');
      return typeof page === 'string' ? { url, content: page, truncated: false, links: [] } : page;
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
    agent,
    calls,
    fetched,
    post: (url: string, body: object = {}) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    del: (url: string) => send('delete', url),
    get: (url: string) => agent.get('/api' + url),
    get csrf() {
      return csrf;
    },
    async setup() {
      const response = await send('post', '/auth/setup', {
        name: 'Research Administrator',
        username: 'research-admin',
        password: 'A-long-research-password-2026',
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
async function readyProject(f: Fixture, name = 'Pump Research') {
  let project = (await f.post('/projects', { name, website: 'https://example.org' }))
    .body as Project;
  assert.ok(project.id);
  let added = await f.post('/projects/' + project.id + '/sources', {
    revision: project.revision,
    title: 'Training brief',
    content:
      'Target pump manufacturers with their own engineering teams. Exclude bearing manufacturers.',
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  project = (await f.get('/projects/' + project.id)).body.project;
  added = await f.post('/projects/' + project.id + '/sources/website', {
    revision: project.revision,
    url: 'https://example.org',
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  project = (await f.get('/projects/' + project.id)).body.project;
  const saved = await f.put('/projects/' + project.id + '/training/rubric', {
    revision: project.revision,
    rubric,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const published = await f.post('/projects/' + project.id + '/training/publish', {
    revision: saved.body.revision,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return published.body as Project;
}
async function addLead(f: Fixture, projectId: number, lead: Partial<Lead> & { name: string }) {
  const created = await f.post('/projects/' + projectId + '/leads', lead);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return {
    lead: created.body as Lead,
    base: '/projects/' + projectId + '/leads/' + created.body.id,
  };
}

// --- The email address as a website clue -------------------------------------------------

test('an email domain is a website candidate, but a free-mail or provider domain never is', () => {
  assert.deepEqual(emailDomainCandidate('sales@acme-whitewater.example.com'), {
    domain: 'acme-whitewater.example.com',
    shared: false,
  });
  for (const address of [
    'dmaww@emirates.net.ae',
    'someone@gmail.com',
    'someone@googlemail.com',
    'someone@outlook.com',
    'someone@hotmail.co.uk',
    'someone@live.com',
    'someone@yahoo.fr',
    'someone@icloud.com',
    'someone@aol.com',
    'someone@proton.me',
  ])
    assert.equal(emailDomainCandidate(address)?.shared, true, address);
  assert.equal(isSharedMailDomain('acme.com'), false);
  assert.equal(emailDomainCandidate('not an address'), null);
  assert.equal(emailDomainCandidate(''), null);
});

test('research tries the business email domain first and verifies it like any candidate', async () => {
  const home = 'https://acme-whitewater.example.com';
  const f = fixture(
    {},
    {
      'https://example.org': trainingSite,
      [home]: 'Acme Whitewater Rides designs and builds water rides for theme parks in Dubai.',
    },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base, lead } = await addLead(f, project.id, {
      name: 'Acme Whitewater Rides',
      contact_email: 'dmaww@acme-whitewater.example.com',
    });
    const research = await f.post(base + '/research');
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    assert.deepEqual(outcome.tried, ['acme-whitewater.example.com']);
    assert.equal(outcome.discovered, true);
    assert.deepEqual(outcome.applied, ['website']);
    // The record's own clue verified, so the model was never asked to guess.
    assert.equal(f.calls.discover.length, 0);
    const after = (await f.get(base)).body as Lead;
    assert.equal(after.website, home);
    assert.equal(after.revision, lead.revision + 1);
  } finally {
    f.dispose();
  }
});

test('a free-mail or provider email domain is never fetched as the company website', async () => {
  // Contrived on purpose: each provider page names the company, so only the exclusion stops it
  // from "verifying" as this company's website.
  const f = fixture(
    { discover: () => ({ domains: ['gmail.com'] }) },
    {
      'https://example.org': trainingSite,
      'https://emirates.net.ae': 'Amusement Whitewater LLC is a customer of this internet provider.',
      'https://gmail.com': 'Amusement Whitewater LLC signs in to mail here.',
    },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base, lead } = await addLead(f, project.id, {
      name: 'Amusement Whitewater (L.L.C)',
      city: 'Dubai',
      contact_email: 'dmaww@emirates.net.ae',
    });
    const outcome = (await f.post(base + '/research')).body as ResearchOutcome;
    assert.deepEqual(outcome.tried, []);
    assert.equal(outcome.discovered, false);
    assert.ok(!f.fetched.includes('https://emirates.net.ae'));
    assert.ok(!f.fetched.includes('https://gmail.com'));
    assert.ok(
      outcome.notes.some((note) => /emirates\.net\.ae, a shared email provider/.test(note)),
      JSON.stringify(outcome.notes),
    );
    assert.ok(outcome.notes.some((note) => /gmail\.com is a shared email provider/.test(note)));
    // The shared domain is not offered to the model as a clue either.
    assert.equal((f.calls.discover[0] as { email_domain: string }).email_domain, '');
    const after = (await f.get(base)).body as Lead;
    assert.equal(after.website, '');
    assert.equal(after.revision, lead.revision);
  } finally {
    f.dispose();
  }
});

// --- Research before judging -------------------------------------------------------------

test('qualification researches a record with blank fields before judging it', async () => {
  const home = 'https://kestrel-pumps.example.com';
  const site =
    'Kestrel Pump Works manufactures centrifugal pumps in Rotterdam. Our engineering team specifies third-party bearings. Kestrel Pump Works employs 120 people.';
  const f = fixture(
    {
      extract: () => ({
        fields: [
          {
            field: 'employee_count',
            value: '120',
            evidence: 'Kestrel Pump Works employs 120 people.',
            page_url: home,
          },
        ],
        facts: [
          {
            rule: 'Employs engineers',
            quote: 'Our engineering team specifies third-party bearings.',
            page_url: home,
          },
        ],
        notes: [],
      }),
    },
    { 'https://example.org': trainingSite, [home]: site },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base, lead } = await addLead(f, project.id, {
      name: 'Kestrel Pump Works',
      contact_email: 'info@kestrel-pumps.example.com',
    });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const result = qualified.body.result as Qualification;
    // The website was found from the email domain and written before the evaluation ran.
    const after = (await f.get(base)).body as Lead & { runs: Run[] };
    assert.equal(after.website, home);
    assert.equal(after.employee_count, '120');
    assert.equal(after.revision, lead.revision + 1);
    assert.equal(after.qualified_revision, after.revision);
    assert.equal(after.stale, false);
    assert.ok(result.research?.ran);
    assert.deepEqual(result.research?.filled.sort(), ['employee_count', 'website']);
    // The evaluation read the site, and was told research had run.
    const input = f.calls.qualify[0] as {
      research_before_evaluation: { ran: boolean };
      lead: { field_origin: Record<string, string> };
      evidence: Array<{ kind: string; title: string; content: string }>;
    };
    assert.equal(input.research_before_evaluation.ran, true);
    assert.equal(input.lead.field_origin.website, 'research');
    assert.equal(input.lead.field_origin.contact_email, 'record');
    assert.ok(input.evidence.some((item) => item.kind === 'website' && item.content.includes('centrifugal')));
    const found = input.evidence.find((item) => item.title.startsWith('Details found by research'));
    assert.ok(found, JSON.stringify(input.evidence.map((item) => item.title)));
    assert.equal(found.kind, 'website');
    assert.match(found.content, /employs 120 people/);
    assert.match(found.content, /Our engineering team specifies third-party bearings/);
    // The record-only item no longer carries what research found.
    const record = input.evidence.find((item) => item.kind === 'lead_record');
    assert.ok(record && !record.content.includes('120'));
    assert.equal(after.runs[0].result.research?.ran, true);

    // The same revision is not researched twice: a second evaluation reuses the pass.
    const extractions = f.calls.extract.length;
    const again = await f.post(base + '/qualify');
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(f.calls.extract.length, extractions);
    assert.equal((again.body.result as Qualification).research?.ran, false);
  } finally {
    f.dispose();
  }
});

test('when research verifies nothing, the result says what was checked', async () => {
  const f = fixture(
    { discover: () => ({ domains: ['amusement-whitewater.example.com'] }) },
    {
      'https://example.org': trainingSite,
      'https://amusement-whitewater.example.com': 'This domain may be for sale. Contact the broker.',
    },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base } = await addLead(f, project.id, {
      name: 'Amusement Whitewater (L.L.C)',
      city: 'Dubai',
      contact_email: 'dmaww@emirates.net.ae',
    });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const result = qualified.body.result as Qualification;
    assert.equal(f.calls.discover.length, 1);
    assert.equal(result.research?.website_found, false);
    assert.match(result.summary, /Research before this evaluation could not verify a company website/);
    assert.match(result.summary, /amusement-whitewater\.example\.com/);
    const checked = result.gaps.find((gap) => gap.startsWith('Research checked:'));
    assert.ok(checked, JSON.stringify(result.gaps));
    assert.match(checked, /shared email provider/);
    assert.match(checked, /parked, for-sale or placeholder/);
    // Researched properly and nothing found: missing information lowers the score, it is not a
    // reason for review. The record alone proves no rule, so nothing is met and nothing blocks.
    assert.equal(result.decision, 'NOT_A_TARGET');
    assert.equal(result.score, 0);
    assert.deepEqual(result.blockers, []);
    assert.ok(
      result.gaps.some((gap) => gap.startsWith('No retrieved source for: Manufactures pumps')),
      JSON.stringify(result.gaps),
    );
  } finally {
    f.dispose();
  }
});

// --- Every rule, with one automatic retry ----------------------------------------------

test('a rule left out is asked for again once, by name, instead of failing', async () => {
  const home = 'https://complete-pumps.example.com';
  const f = fixture(
    {
      qualify: (input, attempt) => {
        const result = complete(input);
        if (attempt === 0) result.criteria.pop();
        return result;
      },
    },
    { 'https://example.org': trainingSite, [home]: 'Complete Pumps manufactures pumps.' },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base } = await addLead(f, project.id, {
      name: 'Complete Pumps',
      website: home,
      industry: 'Pumps',
      country: 'Netherlands',
      city: 'Delft',
      employee_count: '80',
      contact_name: 'Front desk',
      contact_role: 'Reception',
      contact_email: 'desk@complete-pumps.example.com',
      contact_phone: '+31 15 555 0101',
    });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.equal(f.calls.qualify.length, 2);
    assert.deepEqual((f.calls.qualify[1] as { missing_rules: string[] }).missing_rules, [
      'Employs engineers',
    ]);
    assert.match(f.calls.systems.at(-1)!, /did not evaluate every approved rule/);
    const result = qualified.body.result as Qualification;
    assert.deepEqual(
      result.criteria.map((item) => item.criterion),
      rubric.criteria,
    );
    // Every field was filled, so no research ran at all.
    assert.equal(f.calls.extract.length, 0);
    assert.equal(result.research, undefined);
  } finally {
    f.dispose();
  }
});

test('the retry happens once: a model that still leaves rules out saves nothing', async () => {
  const home = 'https://partial-pumps.example.com';
  const f = fixture(
    {
      qualify: (input) => {
        const result = complete(input);
        result.exclusions = [];
        return result;
      },
    },
    { 'https://example.org': trainingSite, [home]: 'Partial Pumps manufactures pumps.' },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base } = await addLead(f, project.id, { name: 'Partial Pumps', website: home });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 502, JSON.stringify(qualified.body));
    assert.match(qualified.body.error, /even after a retry/);
    assert.equal(f.calls.qualify.length, 2);
    const after = (await f.get(base)).body as Lead & { runs: Run[] };
    assert.equal(after.runs.length, 0);
    assert.equal(after.status, 'UNREVIEWED');
  } finally {
    f.dispose();
  }
});

test('an invented evidence id is asked for again once, with the valid ids named', async () => {
  const home = 'https://cited-pumps.example.com';
  const f = fixture(
    {
      qualify: (input, attempt) => {
        const result = complete(input);
        // The first answer cites an id that was never supplied — the shape seen in production
        // on leads carrying little evidence, where the model invents a source rather than
        // returning UNKNOWN with none.
        if (attempt === 0)
          result.criteria = result.criteria.map((item) => ({ ...item, source_ids: ['E9'] }));
        return result;
      },
    },
    { 'https://example.org': trainingSite, [home]: 'Cited Pumps manufactures pumps.' },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base } = await addLead(f, project.id, { name: 'Cited Pumps', website: home });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.equal(f.calls.qualify.length, 2);
    const retry = f.calls.qualify[1] as {
      invalid_source_ids: string[];
      valid_source_ids: string[];
      missing_rules?: string[];
    };
    assert.deepEqual(retry.invalid_source_ids, ['E9']);
    assert.ok(retry.valid_source_ids.length > 0);
    assert.ok(!retry.valid_source_ids.includes('E9'));
    // Only the fault that occurred is named; a complete answer must not be told rules are missing.
    assert.equal(retry.missing_rules, undefined);
    assert.match(f.calls.systems.at(-1)!, /cited evidence ids that were never supplied/);
    assert.doesNotMatch(f.calls.systems.at(-1)!, /did not evaluate every approved rule/);
  } finally {
    f.dispose();
  }
});

test('the citation retry happens once: an id still invented loses its claim, not the run', async () => {
  const home = 'https://invented-pumps.example.com';
  const f = fixture(
    {
      qualify: (input) => {
        const result = complete(input);
        result.criteria[0].source_ids = ['E9'];
        return result;
      },
    },
    { 'https://example.org': trainingSite, [home]: 'Invented Pumps manufactures pumps.' },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base } = await addLead(f, project.id, { name: 'Invented Pumps', website: home });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.equal(f.calls.qualify.length, 2);
    const result = qualified.body.result as Qualification;
    // The claim that cited only the invented id is unverified, with the reason on show.
    assert.equal(result.criteria[0].outcome, 'UNKNOWN');
    assert.deepEqual(result.criteria[0].source_ids, []);
    assert.ok(
      result.gaps.includes(
        'The AI cited a source that was not supplied for: Manufactures pumps; it was not counted.',
      ),
      JSON.stringify(result.gaps),
    );
    // The rest of the answer stands: one of two criteria met.
    assert.equal(result.criteria[1].outcome, 'MATCH');
    assert.equal(result.score, 50);
    const after = (await f.get(base)).body as Lead & { runs: Run[] };
    assert.equal(after.runs.length, 1);
    assert.equal(after.status, result.decision);
  } finally {
    f.dispose();
  }
});

test('a supplied id written another way is read back without a retry', async () => {
  const home = 'https://written-pumps.example.com';
  const f = fixture(
    {
      qualify: (input) => {
        const result = complete(input);
        // The page's own URL, a bracketed id and a "Source" prefix all name supplied evidence.
        result.criteria[0].source_ids = [home + '/'];
        result.criteria[1].source_ids = ['[E2]'];
        result.exclusions[0].source_ids = ['Source e2'];
        return result;
      },
    },
    { 'https://example.org': trainingSite, [home]: 'Written Pumps manufactures pumps.' },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base } = await addLead(f, project.id, { name: 'Written Pumps', website: home });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.equal(f.calls.qualify.length, 1, 'no repair call for a citation written differently');
    const result = qualified.body.result as Qualification;
    assert.deepEqual(
      [...result.criteria, ...result.exclusions].map((item) => item.source_ids),
      [['E2'], ['E2'], ['E2']],
    );
    assert.equal(result.decision, 'QUALIFIED');
    // The first call already lists the ids that may be cited, and names the project.
    const input = f.calls.qualify[0] as { evidence_index: Array<{ id: string; kind: string }> };
    assert.deepEqual(
      input.evidence_index.map((item) => item.id + ':' + item.kind),
      ['E1:lead_record', 'E2:website'],
    );
    assert.match(f.calls.systems.at(-1)!, /"Pump Research"/);
  } finally {
    f.dispose();
  }
});

test('a website on record that cannot be read holds the lead in review, with the score shown', async () => {
  const home = 'https://unreachable-pumps.example.com';
  const f = fixture({}, { 'https://example.org': trainingSite });
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base } = await addLead(f, project.id, {
      name: 'Unreachable Pumps',
      website: home,
      industry: 'Pumps',
    });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const result = qualified.body.result as Qualification;
    assert.equal(result.decision, 'NEEDS_REVIEW');
    assert.deepEqual(result.blockers, [
      'The website on record (' +
        home +
        ') could not be read, so the company could not be researched.',
    ]);
    // Nobody could read a page, so nothing is met — but that is the blocker, not the verdict.
    assert.equal(result.score, 0);
    assert.ok(result.next_steps.some((step) => step.includes(home)));
  } finally {
    f.dispose();
  }
});

test('both faults at once are repaired in a single retry, not two', async () => {
  const home = 'https://both-pumps.example.com';
  const f = fixture(
    {
      qualify: (input, attempt) => {
        const result = complete(input);
        if (attempt === 0) {
          result.criteria = result.criteria.map((item) => ({ ...item, source_ids: ['E9'] }));
          result.criteria.pop();
        }
        return result;
      },
    },
    { 'https://example.org': trainingSite, [home]: 'Both Pumps manufactures pumps.' },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base } = await addLead(f, project.id, { name: 'Both Pumps', website: home });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.equal(f.calls.qualify.length, 2);
    const retry = f.calls.qualify[1] as { invalid_source_ids: string[]; missing_rules: string[] };
    assert.ok(retry.invalid_source_ids.length > 0);
    assert.ok(retry.missing_rules.length > 0);
    assert.match(f.calls.systems.at(-1)!, /did not evaluate every approved rule and cited evidence/);
  } finally {
    f.dispose();
  }
});

test('the same rules in another order or with numbering are still every rule', async () => {
  const home = 'https://ordered-pumps.example.com';
  const f = fixture(
    {
      qualify: (input) => {
        const result = complete(input);
        result.criteria = result.criteria
          .reverse()
          .map((item, index) => ({ ...item, criterion: index + 1 + '. ' + item.criterion.toUpperCase() }));
        return result;
      },
    },
    { 'https://example.org': trainingSite, [home]: 'Ordered Pumps manufactures pumps.' },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base } = await addLead(f, project.id, { name: 'Ordered Pumps', website: home });
    const qualified = await f.post(base + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.equal(f.calls.qualify.length, 1);
    assert.deepEqual(
      (qualified.body.result as Qualification).criteria.map((item) => item.criterion),
      rubric.criteria,
    );
  } finally {
    f.dispose();
  }
});

// --- The final status ---------------------------------------------------------------------

/** Five criteria, so each one met is 20 points, and two exclusions. */
const fiveRules: TrainingSnapshot = {
  project: { name: 'Status Research', description: '', website: '' },
  rubric: {
    summary: 'Find pump manufacturers.',
    criteria: [
      'Manufactures pumps',
      'Employs engineers',
      'Exports to Europe',
      'Runs a test bench',
      'Sells to the chemical industry',
    ],
    exclusions: [
      'Manufactures bearings',
      'Government or non-commercial organization with no approved commercial opportunity',
    ],
    questions: [],
  },
  sources: [],
};
const recordItem: Evidence = {
  id: 'E1',
  kind: 'lead_record',
  title: 'User-provided lead record (unverified)',
  url: '',
  content: '{"name":"Status Pumps"}',
  captured_at: '2026-10-01T00:00:00.000Z',
};
const pageItem: Evidence = {
  id: 'E2',
  kind: 'website',
  title: 'status-pumps.example.com/',
  url: 'https://status-pumps.example.com/',
  content: 'Status Pumps manufactures pumps.',
  captured_at: '2026-10-01T00:00:00.000Z',
};
/** A model answer meeting the first `met` criteria from the page and clearing both exclusions. */
function answer(met: number, extra: Record<string, unknown> = {}) {
  return {
    decision: 'NEEDS_REVIEW',
    score: 35,
    confidence: 40,
    summary: 'A pump maker with little published detail.',
    criteria: fiveRules.rubric.criteria.map((criterion, index) => ({
      criterion,
      outcome: index < met ? 'MATCH' : 'UNKNOWN',
      evidence: index < met ? 'The home page says so.' : 'Not on the pages read.',
      source_ids: index < met ? ['E2'] : [],
    })),
    exclusions: fiveRules.rubric.exclusions.map((criterion) => ({
      criterion,
      outcome: 'NO_MATCH',
      evidence: 'The home page describes a private pump manufacturer.',
      source_ids: ['E2'],
    })),
    gaps: ['Industry unknown', 'Location unknown'],
    next_steps: [],
    outreach: {
      contact_name: '',
      contact_role: '',
      contact_source_ids: [],
      why_qualified: 'Builds pumps.',
      call_script: 'Ask about their pump lines.',
    },
    ...extra,
  };
}
const judge = (raw: unknown) =>
  validateQualification(raw, fiveRules, [recordItem, pageItem], { name: 'Status Pumps' });
const nonprofit = fiveRules.rubric.exclusions[1];

test('missing information lowers the score and never causes review: 20/100 is Not a target', () => {
  // Everything the old checks sent to review at once: low confidence, gaps, unverified rules, a
  // model suggesting review and a blocker that only says information is missing.
  const result = judge(
    answer(1, { blocker: 'Insufficient information: no website, industry or location found.' }),
  );
  assert.equal(result.score, 20);
  assert.equal(result.decision, 'NOT_A_TARGET');
  assert.deepEqual(result.blockers, []);
  // What is missing stays on show; it just does not decide the status.
  assert.ok(result.gaps.includes('Industry unknown'));
  assert.equal(result.confidence, 40);
  assert.equal(result.outreach.call_script, '');
});

test('from 50 a lead is Qualified, whatever the model suggested or how sure it was', () => {
  const result = judge(answer(3));
  assert.equal(result.score, 60);
  assert.equal(result.decision, 'QUALIFIED');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.outreach.call_script, 'Ask about their pump lines.');
  assert.equal(judge(answer(2)).decision, 'NOT_A_TARGET');
});

test('an exclusion met on a retrieved page is Not a target at 0, even with every criterion met', () => {
  const raw = answer(5);
  raw.exclusions[0] = {
    ...raw.exclusions[0],
    outcome: 'MATCH',
    evidence: 'The products page lists ball bearings.',
    source_ids: ['E2'],
  };
  const result = judge(raw);
  assert.equal(result.exclusions[0].outcome, 'MATCH');
  assert.equal(result.decision, 'NOT_A_TARGET');
  assert.equal(result.score, 0);
  assert.equal(result.outreach.why_qualified, '');
});

test('an exclusion only the lead record supports is unverified, and holds a 50+ lead in review', () => {
  const recordOnly = {
    criterion: nonprofit,
    outcome: 'MATCH',
    evidence: 'The record notes call it a nonprofit.',
    source_ids: ['E1'],
  };
  const raw = answer(3);
  raw.exclusions[1] = recordOnly;
  const result = judge(raw);
  assert.equal(result.exclusions[1].outcome, 'UNKNOWN');
  assert.ok(
    result.gaps.includes(
      'No retrieved source for: ' + nonprofit + ' (only the unverified lead record was cited)',
    ),
    JSON.stringify(result.gaps),
  );
  // Not excluded: the score stands, but a possible exclusion is unchecked.
  assert.equal(result.score, 60);
  assert.equal(result.decision, 'NEEDS_REVIEW');
  assert.deepEqual(result.blockers, ['Could not verify the exclusion: ' + nonprofit]);
  // Below 50 the same unverified exclusion changes nothing.
  const low = answer(2);
  low.exclusions[1] = recordOnly;
  const lowResult = judge(low);
  assert.equal(lowResult.decision, 'NOT_A_TARGET');
  assert.deepEqual(lowResult.blockers, []);
  // The same holds when the model itself could not settle the exclusion.
  const unsettled = answer(4);
  unsettled.exclusions[0] = { ...unsettled.exclusions[0], outcome: 'UNKNOWN', source_ids: [] };
  assert.deepEqual(judge(unsettled).blockers, [
    'Could not verify the exclusion: Manufactures bearings',
  ]);
});

test('a specific verification blocker is kept and a generic one is ignored', () => {
  const generic = judge(
    answer(3, {
      blocker: 'Limited public information about Status Pumps; no LinkedIn profile found.',
    }),
  );
  assert.equal(generic.decision, 'QUALIFIED');
  assert.deepEqual(generic.blockers, []);
  const specific =
    'The website describes Status Dental, a clinic, not the pump maker in the record.';
  const kept = judge(answer(3, { blocker: specific }));
  assert.equal(kept.decision, 'NEEDS_REVIEW');
  assert.deepEqual(kept.blockers, [specific]);
  assert.equal(kept.score, 60);
  for (const phrase of [
    'Insufficient information',
    'Missing data.',
    'Not enough evidence to verify the company.',
    'No website',
    'None',
    'N/A',
    'No website found for NY Ortho',
    'Only one page could be read.',
  ])
    assert.equal(specificBlocker(phrase, 'nyortho'), '', phrase);
  for (const phrase of [
    'Several companies share the name and the evidence does not settle which one this is.',
    'The domain is parked and for sale.',
    'The company closed in 2021, according to its own site.',
    'The evidence contradicts itself on who the company is.',
  ])
    assert.equal(specificBlocker(phrase, 'Status Pumps'), phrase);
});

test('an opportunity is kept only with a retrieved source', () => {
  const summary = 'Their seals wear fast in chemical service, which the offering addresses.';
  const kept = judge(
    answer(3, { opportunity: { summary, source_ids: ['https://status-pumps.example.com'] } }),
  );
  assert.deepEqual(kept.opportunity, { summary, source_ids: ['E2'] });
  const cleared = judge(answer(3, { opportunity: { summary, source_ids: ['E1'] } }));
  assert.deepEqual(cleared.opportunity, { summary: '', source_ids: [] });
  assert.ok(
    cleared.gaps.includes(
      'An opportunity was proposed without a retrieved source and was not kept.',
    ),
  );
  // An answer without the newer fields still validates, with neither filled.
  const older = judge(answer(3));
  assert.deepEqual(older.opportunity, { summary: '', source_ids: [] });
  assert.equal(older.decision, 'QUALIFIED');
});

// --- The team's own lead list as a source ------------------------------------------------

const listItem: Evidence = {
  id: 'E3',
  kind: 'provided_list',
  title: 'Your lead list (provided data)',
  url: '',
  content: 'Event: Hannover Messe 2026\nShowing: live pump test bench',
  captured_at: '2026-10-01T00:00:00.000Z',
};
const judgeWithList = (raw: unknown, evidence = [recordItem, pageItem, listItem]) =>
  validateQualification(raw, fiveRules, evidence, {
    name: 'Status Pumps',
    record: { city: 'Berlin' },
  });

test('a rule met from the team’s own lead list counts and scores; the record alone still does not', () => {
  const raw = answer(2);
  raw.criteria[3] = {
    ...raw.criteria[3],
    outcome: 'MATCH',
    evidence: 'The lead list says it shows a live pump test bench at Hannover Messe 2026.',
    // By its title, the list is still the list.
    source_ids: ['Your lead list (provided data)'],
  };
  raw.criteria[4] = {
    ...raw.criteria[4],
    outcome: 'MATCH',
    evidence: 'The record notes say so.',
    source_ids: ['E1'],
  };
  const result = judgeWithList(raw);
  assert.deepEqual(
    result.criteria.map((item) => [item.outcome, item.source_ids]),
    [
      ['MATCH', ['E2']],
      ['MATCH', ['E2']],
      ['UNKNOWN', []],
      ['MATCH', ['E3']],
      ['UNKNOWN', ['E1']],
    ],
  );
  assert.ok(
    result.gaps.includes(
      'No retrieved source for: Sells to the chemical industry (only the unverified lead record was cited)',
    ),
    JSON.stringify(result.gaps),
  );
  assert.equal(result.score, 60);
  assert.equal(result.decision, 'QUALIFIED');

  // An exclusion the list shows is met like one a page shows: Not a target at 0.
  const excluded = answer(5);
  excluded.exclusions[0] = {
    ...excluded.exclusions[0],
    outcome: 'MATCH',
    evidence: 'The lead list files it under ball bearings.',
    source_ids: ['E3'],
  };
  const out = judgeWithList(excluded);
  assert.equal(out.exclusions[0].outcome, 'MATCH');
  assert.equal(out.decision, 'NOT_A_TARGET');
  assert.equal(out.score, 0);

  // With no website read at all the list still counts for what it states, and the gap says so.
  const listOnly = answer(0);
  listOnly.criteria[3] = { ...listOnly.criteria[3], outcome: 'MATCH', source_ids: ['E2'] };
  const thin = judgeWithList(listOnly, [recordItem, { ...listItem, id: 'E2' }]);
  assert.equal(thin.criteria[3].outcome, 'MATCH');
  assert.equal(thin.score, 20);
  assert.ok(
    thin.gaps.includes(
      'No public website evidence was available, so only your lead list could show a rule as met.',
    ),
    JSON.stringify(thin.gaps),
  );
});

test('the lead list can show the opportunity, but never a contact or a conflicting detail', () => {
  const summary = 'They exhibit at Hannover Messe, where the offering is launched.';
  const result = judgeWithList(
    answer(3, {
      opportunity: { summary, source_ids: ['E3'] },
      outreach: {
        contact_name: 'Jana Weber',
        contact_role: 'Head of Purchasing',
        contact_source_ids: ['E3'],
        why_qualified: 'Builds pumps.',
        call_script: 'Ask about the fair.',
      },
      conflicts: [
        {
          field: 'city',
          record_value: 'Berlin',
          found_value: 'Hannover',
          quote: 'Event: Hannover Messe 2026',
          source_ids: ['E3'],
        },
      ],
    }),
  );
  assert.deepEqual(result.opportunity, { summary, source_ids: ['E3'] });
  // A contact is kept only from the company's own site, and a conflict only from its pages.
  assert.equal(result.outreach.contact_name, '');
  assert.deepEqual(result.outreach.contact_source_ids, []);
  assert.ok(
    result.gaps.includes('A contact name was proposed without website evidence and was discarded.'),
  );
  assert.deepEqual(result.conflicts, []);
});

test('the lead list’s own columns reach qualification as a source of their own', async () => {
  const home = 'https://fair-pumps.example.com';
  const unread = 'https://unread-fair-pumps.example.com';
  const f = fixture(
    {
      qualify: (input) => {
        const result = complete(input);
        const evidence = (input as unknown as { evidence: Evidence[] }).evidence;
        const list = evidence.find((item) => item.kind === 'provided_list');
        if (list)
          result.criteria[1] = {
            ...result.criteria[1],
            evidence: 'The lead list names its engineering stand at Hannover Messe.',
            source_ids: [list.id],
          };
        return result;
      },
    },
    { 'https://example.org': trainingSite, [home]: 'Fair Pumps manufactures pumps.' },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const base = '/projects/' + project.id + '/leads';
    const imported = await f.post(base + '/import/rows', {
      leads: [
        {
          name: 'Fair Pumps',
          website: home,
          list_data: { Event: 'Hannover Messe 2026', Stand: 'Engineering hall 3' },
        },
        {
          name: 'Unread Fair Pumps',
          website: unread,
          industry: 'Pumps',
          list_data: { Event: 'Hannover Messe 2026' },
        },
      ],
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const [fairId, unreadId] = imported.body.created_ids as number[];

    const qualified = await f.post(base + '/' + fairId + '/qualify');
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    const input = f.calls.qualify[0] as {
      evidence: Evidence[];
      evidence_index: Array<{ id: string; kind: string }>;
    };
    assert.deepEqual(
      input.evidence_index.map((item) => item.id + ':' + item.kind),
      ['E1:lead_record', 'E2:provided_list', 'E3:website'],
    );
    // The record item stays what it was; the list is its own item, labelled as the team's data.
    assert.ok(!input.evidence[0].content.includes('Hannover'));
    assert.deepEqual(
      { ...input.evidence[1], captured_at: '' },
      {
        id: 'E2',
        kind: 'provided_list',
        title: 'Your lead list (provided data)',
        url: '',
        content: 'Event: Hannover Messe 2026\nStand: Engineering hall 3',
        captured_at: '',
      },
    );
    assert.match(f.calls.systems.at(-1)!, /Kind provided_list is data the team imported/);
    const result = qualified.body.result as Qualification;
    assert.deepEqual(
      result.criteria.map((item) => [item.outcome, item.source_ids]),
      [
        ['MATCH', ['E3']],
        ['MATCH', ['E2']],
      ],
    );
    assert.equal(result.score, 100);
    assert.equal(result.decision, 'QUALIFIED');

    // An unreadable website is still a blocker: the list says nothing about the site.
    const blocked = await f.post(base + '/' + unreadId + '/qualify');
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    const held = blocked.body.result as Qualification;
    assert.equal(held.criteria[1].outcome, 'MATCH');
    assert.equal(held.score, 50);
    assert.equal(held.decision, 'NEEDS_REVIEW');
    assert.deepEqual(held.blockers, [
      'The website on record (' + unread + ') could not be read, so the company could not be researched.',
    ]);
  } finally {
    f.dispose();
  }
});

// --- People on the company's own website -------------------------------------------------

test('a contact is kept only with a sentence from the company site that names them', async () => {
  const home = 'https://harbor-valves.example.com';
  const team = home + '/team';
  const homeText =
    'Harbor Valves manufactures process valves and pumps in Hamburg. Visit our team page to meet the people behind the valves.';
  const teamText =
    'Our purchasing manager Maria Keller (m.keller@harbor-valves.example.com, +49 40 1234 5678) handles all supplier enquiries. ' +
    'Jonas Brandt leads the engineering office in Hamburg. ' +
    'Sabine Ott runs the office as Office Manager.';
  const f = fixture(
    {
      extract: () => ({
        fields: [],
        contacts: [
          {
            name: 'Maria Keller',
            role: 'Purchasing Manager',
            email: 'm.keller@harbor-valves.example.com',
            phone: '+49 40 1234 5678',
            evidence:
              'Our purchasing manager Maria Keller (m.keller@harbor-valves.example.com, +49 40 1234 5678) handles all supplier enquiries.',
            page_url: team,
          },
          // Invented: cited to a real sentence that does not name them.
          {
            name: 'Peter Invented',
            role: 'Head of Engineering',
            email: 'p.invented@harbor-valves.example.com',
            phone: '',
            evidence: 'Jonas Brandt leads the engineering office in Hamburg.',
            page_url: team,
          },
          // Real person, but the email was built from a name pattern: not in the sentence.
          {
            name: 'Jonas Brandt',
            role: 'Engineering office lead',
            email: 'j.brandt@harbor-valves.example.com',
            phone: null,
            evidence: 'Jonas Brandt leads the engineering office in Hamburg.',
            page_url: team,
          },
          // A sentence that is nowhere on the pages.
          {
            name: 'Karl Ghost',
            role: 'Marketing Assistant',
            email: '',
            phone: '',
            evidence: 'Karl Ghost is our marketing assistant for the Gulf region.',
            page_url: team,
          },
          {
            name: 'Sabine Ott',
            role: 'Office Manager',
            email: '',
            phone: '',
            evidence: 'Sabine Ott runs the office as Office Manager.',
          },
        ],
        notes: [],
      }),
    },
    {
      'https://example.org': trainingSite,
      [home]: { url: home, content: homeText, truncated: false, links: [], contact_links: [team] },
      [team]: teamText,
    },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const { base, lead } = await addLead(f, project.id, {
      name: 'Harbor Valves',
      website: home,
      contact_name: 'Front Desk',
    });
    const research = await f.post(base + '/research');
    assert.equal(research.status, 200, JSON.stringify(research.body));
    const outcome = research.body as ResearchOutcome;
    assert.deepEqual(outcome.pages, [home, team]);
    assert.equal(outcome.contacts_added, 3);
    assert.ok(outcome.notes.some((note) => /2 people offered by the model were not kept/.test(note)));
    const contacts = (await f.get(base + '/contacts')).body as LeadContact[];
    const names = contacts.map((contact) => contact.name).sort();
    assert.deepEqual(names, ['Jonas Brandt', 'Maria Keller', 'Sabine Ott']);
    const maria = contacts.find((contact) => contact.name === 'Maria Keller')!;
    assert.equal(maria.role_category, 'purchasing');
    assert.equal(maria.email, 'm.keller@harbor-valves.example.com');
    assert.equal(maria.phone, '+49 40 1234 5678');
    assert.equal(maria.source_url, team);
    assert.match(maria.evidence, /Maria Keller/);
    assert.equal(maria.relevant, true);
    const jonas = contacts.find((contact) => contact.name === 'Jonas Brandt')!;
    assert.equal(jonas.email, '', 'an address the sentence does not print is dropped');
    assert.equal(jonas.role_category, 'engineering');
    const sabine = contacts.find((contact) => contact.name === 'Sabine Ott')!;
    assert.equal(sabine.relevant, false);
    // Relevant people first: the roles the training asks for lead the list.
    assert.equal(contacts[contacts.length - 1].name, 'Sabine Ott');
    // The record's own primary contact is untouched.
    const after = (await f.get(base)).body as Lead;
    assert.equal(after.contact_name, 'Front Desk');
    assert.equal(after.revision, lead.revision, 'finding people does not make the record stale');
    // Neither the research log nor the audit trail copies anyone's details.
    const log = f.db.prepare('SELECT summary_json FROM lead_research_runs').all() as Array<{
      summary_json: string;
    }>;
    assert.equal(log.length, 1);
    for (const secret of ['Maria', 'Keller', 'keller@', 'Invented', 'Ghost', '1234 5678'])
      assert.ok(!log[0].summary_json.includes(secret), secret);
    const trail = (await f.get('/projects/' + project.id + '/activity')).text;
    assert.ok(trail.includes('3 people found on the website of Harbor Valves'));
    assert.ok(!trail.includes('Keller'));
    // A second pass finds the same people and adds nobody twice.
    const again = (await f.post(base + '/research')).body as ResearchOutcome;
    assert.equal(again.contacts_added, 0);
    assert.equal(((await f.get(base + '/contacts')).body as LeadContact[]).length, 3);
    // The profile the lead page reads.
    const profile = (await f.get(base + '/research-profile')).body as ResearchProfile;
    assert.equal(profile.contacts.length, 3);
    assert.equal(profile.runs.length, 2);
    assert.deepEqual(profile.roles_sought.categories.sort(), [
      'engineering',
      'marketing',
      'purchasing',
    ]);
  } finally {
    f.dispose();
  }
});

test('contacts are erasable one by one or all at once, stay in their project, and go with the lead', async () => {
  const home = 'https://erasable.example.com';
  const text =
    'Erasable Pumps builds pumps. Contact our buyer Lena Voss at lena.voss@erasable.example.com for supplier questions. Tom Hale heads marketing at Erasable Pumps.';
  const f = fixture(
    {
      extract: () => ({
        contacts: [
          {
            name: 'Lena Voss',
            role: 'Buyer',
            email: 'lena.voss@erasable.example.com',
            evidence:
              'Contact our buyer Lena Voss at lena.voss@erasable.example.com for supplier questions.',
          },
          {
            name: 'Tom Hale',
            role: 'Head of marketing',
            evidence: 'Tom Hale heads marketing at Erasable Pumps.',
          },
        ],
      }),
    },
    { 'https://example.org': trainingSite, [home]: text },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const other = await readyProject(f, 'Other Research');
    const { base, lead } = await addLead(f, project.id, { name: 'Erasable Pumps', website: home });
    assert.equal((await f.post(base + '/research')).status, 200);
    const contacts = (await f.get(base + '/contacts')).body as LeadContact[];
    assert.equal(contacts.length, 2);
    // Another project cannot reach them, by lead or by contact id.
    const foreign = '/projects/' + other.id + '/leads/' + lead.id;
    assert.equal((await f.get(foreign + '/contacts')).status, 404);
    assert.equal((await f.del(foreign + '/contacts/' + contacts[0].id)).status, 404);
    // One at a time: the row, and with it the quote that names the person.
    const erased = await f.del(base + '/contacts/' + contacts[0].id);
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    assert.equal((erased.body as LeadContact[]).length, 1);
    assert.equal((await f.del(base + '/contacts/' + contacts[0].id)).status, 404);
    const quotes = f.db.prepare('SELECT evidence FROM lead_contacts').all() as Array<{
      evidence: string;
    }>;
    assert.ok(!JSON.stringify(quotes).includes(contacts[0].name));
    // All at once.
    assert.equal((await f.del(base + '/contacts')).status, 200);
    assert.deepEqual((await f.get(base + '/contacts')).body, []);
    // Deleting the lead takes its people and its research log with it.
    assert.equal((await f.post(base + '/research')).status, 200);
    const count = (table: string) =>
      (f.db.prepare('SELECT count(*) n FROM ' + table + ' WHERE lead_id=?').get(lead.id) as {
        n: number;
      }).n;
    assert.equal(count('lead_contacts'), 2);
    assert.ok(count('lead_research_runs') > 0);
    assert.equal((await f.del(base)).status, 200);
    assert.equal(count('lead_contacts'), 0);
    assert.equal(count('lead_research_runs'), 0);
  } finally {
    f.dispose();
  }
});

// --- Training library -----------------------------------------------------------------------

test('every document upload is logged, read or refused, so the library can show what happened', async () => {
  const f = fixture({}, { 'https://example.org': trainingSite });
  try {
    await f.setup();
    const project = (await f.post('/projects', { name: 'Upload Research' })).body as Project;
    const upload = (name: string, content: Buffer, revision: number) =>
      f.agent
        .post('/api/projects/' + project.id + '/sources/upload')
        .set('X-Requested-With', 'Innovista')
        .set('X-CSRF-Token', f.csrf)
        .field('revision', String(revision))
        .attach('file', content, name);
    const good = await upload(
      'criteria.md',
      Buffer.from('# Criteria\nCompanies that received significant investment in the last year.'),
      project.revision,
    );
    assert.equal(good.status, 201, JSON.stringify(good.body));
    const current = (await f.get('/projects/' + project.id)).body.project as Project;
    const bad = await upload('scan.txt', Buffer.from([0x41, 0x00, 0x42, 0x43]), current.revision);
    assert.equal(bad.status, 400);
    const log = (await f.get('/projects/' + project.id + '/training/uploads'))
      .body as SourceUpload[];
    assert.equal(log.length, 2);
    const [failed, read] = log;
    assert.equal(read.status, 'READ');
    assert.equal(read.filename, 'criteria.md');
    assert.equal(read.source_id, good.body.id);
    assert.ok(read.characters > 40);
    assert.equal(read.words, 11);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.filename, 'scan.txt');
    assert.equal(failed.source_id, null);
    assert.match(failed.reason, /UTF-8|binary/);
    // Removing the source keeps the history of the upload.
    const latest = (await f.get('/projects/' + project.id)).body.project as Project;
    const removed = await f.agent
      .delete('/api/projects/' + project.id + '/sources/' + good.body.id)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', f.csrf)
      .send({ revision: latest.revision });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const kept = (await f.get('/projects/' + project.id + '/training/uploads'))
      .body as SourceUpload[];
    assert.equal(kept.length, 2);
    assert.equal(kept[1].source_id, null);
  } finally {
    f.dispose();
  }
});

test('the training graph counts how each published rule played out across qualified leads', async () => {
  const home = 'https://graph-pumps.example.com';
  const f = fixture(
    {
      qualify: (input, attempt) => {
        const result = complete(input);
        if (attempt === 1) result.criteria[1].outcome = 'UNKNOWN';
        return result;
      },
    },
    {
      'https://example.org': trainingSite,
      [home]: 'Graph Pumps manufactures pumps.',
      'https://second-pumps.example.com': 'Second Pumps manufactures pumps.',
    },
  );
  try {
    await f.setup();
    const project = await readyProject(f);
    const empty = (await f.get('/projects/' + project.id + '/training/graph')).body as TrainingGraph;
    assert.equal(empty.leads_evaluated, 0);
    assert.equal(empty.rules.length, 3);
    const full = {
      industry: 'Pumps',
      country: 'Netherlands',
      city: 'Delft',
      employee_count: '80',
      contact_name: 'Desk',
      contact_role: 'Reception',
      contact_email: 'desk@graph-pumps.example.com',
      contact_phone: '+31 15 555 0101',
    };
    const first = await addLead(f, project.id, { name: 'Graph Pumps', website: home, ...full });
    const second = await addLead(f, project.id, {
      name: 'Second Pumps',
      website: 'https://second-pumps.example.com',
      ...full,
      contact_email: 'desk@second-pumps.example.com',
    });
    assert.equal((await f.post(first.base + '/qualify')).status, 200);
    assert.equal((await f.post(second.base + '/qualify')).status, 200);
    const graph = (await f.get('/projects/' + project.id + '/training/graph')).body as TrainingGraph;
    assert.equal(graph.version, project.active_version);
    assert.equal(graph.leads_evaluated, 2);
    const rule = (text: string) => graph.rules.find((item) => item.text === text)!;
    assert.deepEqual(
      { meets: rule('Manufactures pumps').meets, unable: rule('Manufactures pumps').unable },
      { meets: 2, unable: 0 },
    );
    assert.deepEqual(
      { meets: rule('Employs engineers').meets, unable: rule('Employs engineers').unable },
      { meets: 1, unable: 1 },
    );
    assert.equal(rule('Manufactures bearings').kind, 'exclusion');
    assert.equal(rule('Manufactures bearings').does_not_meet, 2);
    assert.equal(graph.decisions.QUALIFIED + graph.decisions.NEEDS_REVIEW, 2);
  } finally {
    f.dispose();
  }
});

// --- Shared vocabulary --------------------------------------------------------------------

test('roles are read from the title a page gives, and the training says which roles matter', () => {
  assert.equal(classifyRole('Purchasing Assistant'), 'purchasing');
  assert.equal(classifyRole('Einkauf'), 'purchasing');
  assert.equal(classifyRole('Marketing Director'), 'marketing');
  assert.equal(classifyRole('Head of Engineering'), 'engineering');
  assert.equal(classifyRole('Managing Director'), 'management');
  assert.equal(classifyRole('Receptionist'), 'other');
  assert.equal(classifyRole(''), 'other');
  const sought = rolesSought([
    'We sell to purchasers. Ask for the purchasing assistant or a marketing assistant.',
  ]);
  assert.deepEqual(sought.categories.sort(), ['marketing', 'purchasing']);
  assert.ok(sought.phrases.includes('marketing assistant'));
  assert.deepEqual(rolesSought(['Companies that received significant investment.']).categories, []);
});

test('fit bands follow the owner’s thresholds', () => {
  assert.equal(fitBandFor(100)?.label, 'Call-ready');
  assert.equal(fitBandFor(80)?.label, 'Call-ready');
  assert.equal(fitBandFor(79)?.label, 'Send an email');
  assert.equal(fitBandFor(70)?.label, 'Send an email');
  assert.equal(fitBandFor(69)?.label, 'Review with the client');
  assert.equal(fitBandFor(50)?.label, 'Review with the client');
  assert.equal(fitBandFor(49)?.label, 'Not a fit');
  assert.equal(fitBandFor(0)?.label, 'Not a fit');
  assert.equal(fitBandFor(null), null);
});

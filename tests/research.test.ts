import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import { emailDomainCandidate, isSharedMailDomain } from '../server/enrich';
import type { Generate } from '../server/ai';
import type { WebsitePage } from '../server/network';
import type {
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
    assert.equal(result.decision, 'NEEDS_REVIEW');
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

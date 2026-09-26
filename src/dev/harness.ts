/**
 * UI harness: the real app, fed fixture data through a stubbed fetch.
 *
 * Why it exists: every screen sits behind a sign-in, so a layout change could only be checked by
 * someone logged in to a real workspace. This lets a screen be opened and looked at directly,
 * with data shaped like the team's (a project of imported leads with blank fields, several
 * training versions, a lead with an email but no name).
 *
 * Only GETs return data; writes answer {} (or a canned email fixture) so buttons can be clicked
 * without anything persisting.
 * Development only — see harness.html. Nothing here is imported by the production entry.
 */
import { harnessAssignees, leadFacets, leadsPage } from './lead-fixtures';
import { callStage } from '../../shared/calls';
import type { CallOutcome } from '../../shared/types';
import { shellRoutes } from './shell-fixtures';
import { contactEnrollments, emailRoutes, emailWrites } from './emailFixtures';
import { settingsRoutes, settingsWrites } from './settingsFixtures';

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
/** A local calendar day, `offset` days from today, as YYYY-MM-DD (call next-action dates). */
const day = (offset: number) => {
  const d = new Date(now + offset * 86_400_000);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
};

const rubric = {
  summary:
    'COMPANY\nInnovista Digital Solutions FZ-LLC — a digital marketing and AI solutions agency based in Ras Al Khaimah, UAE, serving clients across the UAE/GCC and internationally on a remote delivery model.\nWebsite: innovistadigi.com · Email: contact@innovistadigi.com · Phone: +971-501201731',
  criteria: [
    'Business type is an SMB, startup, or growing e-commerce/service business — a real commercial entity, not an individual or hobbyist.',
    'Company size is roughly 2–200 employees, where marketing and technology decisions are made quickly and without long procurement cycles.',
    'Has a clear need matching an Innovista service: a new or redesigned website, e-commerce build, UI/UX work, SEO or digital marketing, AI workflow automation, custom AI development, or AI-based admin support.',
    'Shows an evidenced website or digital gap: outdated or slow site, no mobile responsiveness, weak search visibility, or manual processes an AI workflow could replace.',
  ],
  exclusions: [
    'The company cannot be verified as a genuine business through its website, LinkedIn company profile, or another reliable public business source.',
    'The company is permanently closed, dormant, inactive, or no longer operating.',
    'The record is a duplicate of an existing database entry — match on company name, website domain, email address, phone number, and LinkedIn company profile where available.',
    'The prospect is already an existing Innovista client, an active sales opportunity, or a contact already approached for the same campaign, unless the record represents a genuinely new opportunity.',
  ],
  questions: [],
};

const project = {
  id: 2,
  name: 'Innovista Research',
  description: '',
  website: 'https://innovistadigi.com',
  revision: 10,
  trained_revision: 10,
  active_version: 10,
  rubric,
  lead_count: 198,
  qualified_count: 0,
  review_count: 198,
  source_count: 3,
  member_count: 2,
  pending_feedback_count: 0,
  is_starter: false,
  preserved_lead_count: 0,
  preserved_contact_count: 0,
  preserved_activity_count: 0,
  created_at: '2026-09-12T08:00:00.000Z',
  updated_at: ago(30),
};

// Real sentences, repeated to the lengths the team's library has, so the graph view's links
// between sources and rules are the ones a real library would draw.
const fill = (text: string, length: number) => text.repeat(Math.ceil(length / text.length)).slice(0, length);
const siteText =
  'Innovista Digital Solutions builds websites, e-commerce stores and UI/UX for startups and growing SMB service businesses. We run SEO and digital marketing, and design AI workflow automation and custom AI development that replace manual processes. ';
const notesText =
  'A lead is qualified when it is a genuine business with a working website, roughly 2 to 200 employees, and a visible digital gap such as an outdated website or weak search visibility. Exclude companies that are permanently closed or dormant, duplicates of an existing record, and existing clients already approached in the same campaign. ';
const templatesText =
  'Subject: A faster website for your business. Hello, we noticed your website could load faster on mobile and rank better in search. Innovista helps growing businesses with redesigned websites, e-commerce and AI automation. ';
const sources = [
  {
    id: 1,
    project_id: 2,
    title: 'innovistadigi.com',
    kind: 'website',
    url: 'https://innovistadigi.com',
    content: fill(siteText, 8503),
    filename: '',
    sha256: 'a',
    created_at: '2026-09-12T08:05:00.000Z',
  },
  {
    id: 2,
    project_id: 2,
    title: 'A lead is qualified when they meet most of these:',
    kind: 'note',
    url: '',
    content: fill(notesText, 551),
    filename: '',
    sha256: 'b',
    created_at: '2026-09-12T08:10:00.000Z',
  },
  {
    id: 3,
    project_id: 2,
    title: 'Email_Templates.csv',
    kind: 'document',
    url: '',
    content: fill(templatesText, 9151),
    filename: 'Email_Templates.csv',
    sha256: 'c',
    created_at: '2026-09-17T08:00:00.000Z',
  },
];

const versions = Array.from({ length: 10 }, (_, index) => ({
  version: 10 - index,
  created_at: index === 0 ? ago(60) : ago(60 * 24 * (index < 8 ? 1 : 6)),
  created_by: 'Workspace Administrator',
}));

// Shaped like the real log: runs of the same action, which is what the overview has to group.
const activity = [
  ['training.published', 'Version 10 approved for qualification.', 45],
  ['training.rubric_saved', 'Draft qualification rules updated.', 52],
  ['training.rubric_saved', 'Draft qualification rules updated.', 58],
  ['training.rubric_saved', 'Draft qualification rules updated.', 63],
  ['training.published', 'Version 9 approved for qualification.', 60 * 26],
  ['leads.imported', '198 leads imported from Hawaii_91226_1.csv.', 60 * 27],
  ['source.added', 'Email_Templates.csv added to the source library.', 60 * 24 * 6],
].map(([action, detail, minutes], index) => ({
  id: index + 1,
  action,
  detail,
  actor: 'Workspace Administrator',
  created_at: ago(minutes as number),
}));

const lead = {
  id: 7,
  project_id: 2,
  name: 'The Chopin Law Firm LLC',
  website: '',
  country: '',
  industry: '',
  notes: '',
  revision: 1,
  status: 'UNREVIEWED',
  score: null,
  confidence: null,
  latest_run_id: null,
  training_version: null,
  qualified_revision: null,
  contact_name: '',
  contact_role: 'Attorney',
  contact_email: 'Justin@chopinlawfirm.com',
  contact_phone: '',
  city: '',
  employee_count: '',
  assigned_to: null,
  assigned_at: null,
  assigned_to_name: null,
  call_count: 0,
  next_step: 'NONE',
  stale: false,
  reviewed: false,
  created_at: ago(60 * 27),
  updated_at: ago(60 * 27),
  runs: [],
  reviews: [],
  feedback: [],
  calls: [
    {
      id: 2,
      project_id: 2,
      lead_id: 7,
      outcome: 'CALLBACK',
      notes: 'Reception asked us to call Justin back after the hearing.',
      next_action_at: day(2),
      created_by: 'Workspace Administrator',
      created_at: ago(90),
    },
    {
      id: 1,
      project_id: 2,
      lead_id: 7,
      outcome: 'NO_ANSWER',
      notes: '',
      next_action_at: null,
      created_by: 'Workspace Administrator',
      created_at: ago(60 * 26),
    },
  ],
  // Manual CRM layer (src/LeadStatus.tsx, src/LeadComments.tsx).
  pipeline_status: 'CONTACTED',
  pipeline_changes: [
    {
      id: 1,
      from_status: 'NEW',
      to_status: 'CONTACTED',
      created_by: 'Workspace Administrator',
      created_at: ago(95),
    },
  ],
  comments: [
    {
      id: 1,
      lead_id: 7,
      author: 'Workspace Administrator',
      body: 'Small firm, but they asked about a new website twice. Worth a proper call.',
      created_at: ago(80),
      updated_at: null,
      can_edit: true,
      can_delete: true,
    },
  ],
  emails: [],
  campaigns: [],
  outreach_events: [],
  outreach_status: 'NOT_CONTACTED',
};

// The Calls page: one row per call stage, with an overdue, a due-today and a later next action.
const caller = (
  lead_id: number,
  name: string,
  contact: [string, string, string, string],
  place: [string, string],
  person: [number, string],
  call: null | [string, string | null, number, number],
) => ({
  lead_id,
  name,
  contact_name: contact[0],
  contact_role: contact[1],
  contact_phone: contact[2],
  contact_email: contact[3],
  city: place[0],
  country: place[1],
  assigned_to: person[0],
  assigned_to_name: person[1],
  assigned_at: ago(60 * 30),
  call_status: call?.[0] ?? null,
  call_stage: callStage((call?.[0] ?? null) as CallOutcome | null),
  last_call_at: call ? ago(call[2]) : null,
  last_call_by: call ? person[1] : null,
  last_call_notes: '',
  call_count: call?.[3] ?? 0,
  next_action: !call
    ? 'Make the first call'
    : (
        {
          CALLBACK: 'Call back',
          FOLLOW_UP: 'Follow up',
          NO_ANSWER: 'Try again',
          INTERESTED: 'Book a meeting',
          NOT_INTERESTED: 'No further calls',
          CONNECTED: 'Record the outcome',
        } as Record<string, string>
      )[call[0]],
  next_action_at: call?.[1] ?? null,
});
const callQueue = {
  assignee: 'all',
  truncated: false,
  people: [
    { id: 1, name: 'Workspace Administrator' },
    { id: 3, name: 'Qudsiya Researcher' },
  ],
  rows: [
    caller(
      11,
      'Harbour Dental Clinic',
      ['Mariam Haddad', 'Practice manager', '+971 4 555 0101', 'mariam@harbourdental.ae'],
      ['Dubai', 'AE'],
      [3, 'Qudsiya Researcher'],
      ['CALLBACK', day(-1), 60 * 28, 2],
    ),
    caller(
      7,
      'The Chopin Law Firm LLC',
      ['', 'Attorney', '', 'Justin@chopinlawfirm.com'],
      ['', ''],
      [1, 'Workspace Administrator'],
      ['FOLLOW_UP', day(0), 90, 2],
    ),
    caller(
      12,
      'Amusement Whitewater (L.L.C)',
      ['', '', '+971 4 339 1234', 'dmaww@emirates.net.ae'],
      ['Dubai', 'AE'],
      [3, 'Qudsiya Researcher'],
      ['CALLBACK', day(3), 60 * 5, 1],
    ),
    caller(
      13,
      'Kaimana Surf Supply',
      ['Leilani Kahale', 'Owner', '+1 808 555 0199', 'leilani@kaimanasurf.com'],
      ['Honolulu', 'US'],
      [1, 'Workspace Administrator'],
      null,
    ),
    caller(
      14,
      'Pacific Rim Logistics',
      [
        'Daniel Cho',
        'Operations director',
        '+1 808 555 0142',
        'daniel.cho@pacificrimlogistics.com',
      ],
      ['Kapolei', 'US'],
      [3, 'Qudsiya Researcher'],
      ['INTERESTED', null, 60 * 50, 3],
    ),
    caller(
      15,
      'North Shore Bakehouse',
      ['', 'Owner', '+1 808 555 0170', ''],
      ['Haleiwa', 'US'],
      [1, 'Workspace Administrator'],
      ['NOT_INTERESTED', null, 60 * 72, 1],
    ),
  ],
};

// A lead that research and qualification have both been through: the lead page's full state.
const site = 'https://amusement-whitewater.example.com';
const researched = {
  ...lead,
  id: 8,
  name: 'Amusement Whitewater (L.L.C)',
  website: site,
  country: 'United Arab Emirates',
  city: 'Dubai',
  industry: 'Water ride design and installation',
  contact_role: '',
  contact_email: 'dmaww@emirates.net.ae',
  notes: 'Imported from the GCC events list. Met at the leisure expo.',
  revision: 3,
  status: 'QUALIFIED',
  score: 75,
  confidence: 82,
  latest_run_id: 31,
  training_version: 10,
  qualified_revision: 3,
  next_step: 'SEND_EMAIL',
  outreach_status: 'NOT_CONTACTED',
  // A researched person already in a campaign (People at this company, emailFixtures.ts).
  campaigns: contactEnrollments,
  runs: [
    {
      id: 31,
      lead_id: 8,
      project_id: 2,
      training_version: 10,
      lead_revision: 3,
      provider: 'openai_compatible',
      model: 'gpt-4.1-mini',
      created_at: ago(40),
      created_by: 'Workspace Administrator',
      evidence: [],
      result: {
        decision: 'QUALIFIED',
        score: 75,
        confidence: 82,
        summary:
          'A Dubai company that designs and installs water rides, with an outdated website and manual enquiry handling that an Innovista website and automation project could address.',
        criteria: rubric.criteria.map((criterion, index) => ({
          criterion,
          outcome: index === 1 ? 'UNKNOWN' : 'MATCH',
          evidence:
            index === 1
              ? 'The website does not state a headcount, and research could not confirm one.'
              : 'The company website describes this directly.',
          source_ids: index === 1 ? [] : ['E2'],
        })),
        exclusions: rubric.exclusions.map((criterion) => ({
          criterion,
          outcome: 'NO_MATCH',
          evidence: 'The website shows an operating company with current projects.',
          source_ids: ['E2'],
        })),
        gaps: ['Company size is not published on the website.'],
        next_steps: ['Confirm the team size on the first call.'],
        outreach: {
          contact_name: '',
          contact_role: '',
          contact_source_ids: [],
          why_qualified: 'Operating SMB with a clear website and automation need.',
          call_script: 'Ask how enquiries from the website reach the sales team today.',
        },
        research: {
          ran: true,
          origin: 'qualification',
          website: site,
          website_found: true,
          filled: ['website', 'industry', 'city'],
          contacts_added: 3,
          checked: ['Candidate websites checked: amusement-whitewater.example.com.'],
        },
      },
    },
  ],
};
const researchProfile = {
  citations: [
    {
      field: 'website',
      value: site,
      evidence: '',
      source_url: site,
      created_at: ago(41),
      created_by: 'Workspace Administrator',
    },
    {
      field: 'industry',
      value: researched.industry,
      evidence:
        'Amusement Whitewater designs and installs water rides and splash parks for resorts across the Gulf.',
      source_url: site,
      created_at: ago(41),
      created_by: 'Workspace Administrator',
    },
    {
      field: 'city',
      value: 'Dubai',
      evidence: 'Our design studio and workshop are in Al Quoz, Dubai.',
      source_url: site + '/contact',
      created_at: ago(41),
      created_by: 'Workspace Administrator',
    },
  ],
  contacts: [
    ['Rashid Al Mansoori', 'Procurement Manager', 'purchasing', 'procurement@amusement-whitewater.example.com', '+971 4 555 0142', true],
    ['Leila Haddad', 'Marketing Assistant', 'marketing', '', '', true],
    ['Omar Nasser', 'Site operations', 'other', '', '', false],
    ['Sara Khan', 'Marketing Manager', 'marketing', 'sara.k@amusement-whitewater.example.com', '', true],
  ].map(([name, role, role_category, email, phone, relevant], index) => ({
    id: index + 1,
    project_id: 2,
    lead_id: 8,
    name,
    role,
    role_category,
    email,
    phone,
    relevant,
    source_url: site + '/contact',
    evidence:
      'For supplier enquiries contact ' + name + ', ' + role + (email ? ', at ' + email : '') + '.',
    created_at: ago(41),
    created_by: 'Workspace Administrator',
  })),
  runs: [
    {
      id: 5,
      origin: 'qualification',
      lead_revision: 2,
      result_revision: 3,
      created_at: ago(41),
      created_by: 'Workspace Administrator',
      website: site,
      discovered: true,
      tried: ['amusement-whitewater.example.com'],
      pages: [site, site + '/contact', site + '/about'],
      applied: ['website', 'industry', 'city'],
      refused: [],
      notes: [
        'The contact email uses emirates.net.ae, a shared email provider, so it says nothing about the company’s own website.',
      ],
      contacts_added: 3,
      facts: [],
    },
  ],
  roles_sought: { categories: ['purchasing', 'marketing'], phrases: ['marketing assistant'] },
};
const emptyProfile = {
  citations: [],
  contacts: [],
  runs: [],
  roles_sought: { categories: [], phrases: [] },
};
const uploads = [
  {
    id: 2,
    project_id: 2,
    source_id: null,
    filename: 'Funded companies - scanned.pdf',
    size: 2_400_000,
    status: 'FAILED',
    characters: 0,
    words: 0,
    reason:
      'At least 40 characters of readable text are required. Scanned PDFs need OCR before upload.',
    created_at: ago(90),
    created_by: 'Workspace Administrator',
  },
  {
    id: 1,
    project_id: 2,
    source_id: 3,
    filename: 'Email_Templates.csv',
    size: 11_400,
    status: 'READ',
    characters: 9151,
    words: 1402,
    reason: '',
    created_at: '2026-09-17T08:00:00.000Z',
    created_by: 'Workspace Administrator',
  },
];
const graph = {
  version: 10,
  leads_evaluated: 23,
  decisions: { QUALIFIED: 6, NEEDS_REVIEW: 14, NOT_A_TARGET: 3 },
  rules: [
    ...rubric.criteria.map((text, index) => ({
      kind: 'criterion',
      text,
      meets: [18, 7, 11, 5][index],
      does_not_meet: [2, 3, 4, 6][index],
      unable: [3, 13, 8, 12][index],
    })),
    ...rubric.exclusions.map((text, index) => ({
      kind: 'exclusion',
      text,
      meets: [2, 1, 0, 0][index],
      does_not_meet: [17, 20, 21, 22][index],
      unable: [4, 2, 2, 1][index],
    })),
  ],
};
// Train AI in the harness proposes a small, visible change against published v10.
const proposal = {
  rubric: {
    ...rubric,
    criteria: [
      ...rubric.criteria.slice(0, 3),
      'Has received significant investment or funding in the last two years, or is actively hiring AI engineers for app development.',
    ],
    questions: [],
  },
  revision: 10,
};

const routes: Array<[RegExp, (route: string) => unknown]> = [
  ...shellRoutes,
  ...settingsRoutes,
  [
    /^\/auth\/me$/,
    () => ({
      user: { id: 1, username: 'admin', name: 'Workspace Administrator', role: 'admin' },
      csrf_token: 'harness',
      setup_required: false,
    }),
  ],
  [/^\/projects$/, () => [project]],
  [/^\/projects\/2$/, () => ({ ...project, sources, versions })],
  [/^\/projects\/2\/activity$/, () => activity],
  [/^\/projects\/2\/leads\/7$/, () => lead],
  [/^\/projects\/2\/leads\/8$/, () => researched],
  [/^\/projects\/2\/leads\/7\/research-profile$/, () => emptyProfile],
  [/^\/projects\/2\/leads\/8\/research-profile$/, () => researchProfile],
  [/^\/projects\/2\/leads\/8\/contacts$/, () => researchProfile.contacts],
  [/^\/projects\/2\/training\/uploads$/, () => uploads],
  [/^\/projects\/2\/training\/graph$/, () => graph],
  [
    /^\/projects\/2\/training\/versions\/10$/,
    () => ({
      version: 10,
      created_at: ago(60),
      created_by: 'Workspace Administrator',
      snapshot: { project, rubric, sources },
    }),
  ],
  [/^\/projects\/2\/leads(\?.*)?$/, (route) => leadsPage(route, lead)],
  [/^\/projects\/2\/lead-facets$/, () => leadFacets],
  [/^\/notifications/, () => ({ items: [], unread: 0 })],
  // The Training library's "Add criteria document" choices (server/criteria-templates.ts).
  [
    /^\/criteria-templates$/,
    () => [
      {
        id: 'ai-app-development',
        title: 'AI engineers for app development',
        summary:
          'We are looking for companies that build software applications with AI in them, or are about to, and therefore employ or need AI engineers.',
      },
      {
        id: 'marketing-assistant',
        title: 'Marketing assistant',
        summary:
          'We are looking for small and mid-sized companies with an active marketing function that is thinly staffed.',
      },
      {
        id: 'event-participants',
        title: 'Event participants',
        summary:
          'We are looking for companies taking part in a named event whose business matches what the client offers.',
      },
      {
        id: 'funded-companies',
        title: 'Companies that have received significant investment',
        summary:
          'We are looking for companies that have recently raised significant investment, because new funding comes with plans to hire, build and buy.',
      },
      {
        id: 'criteria-template',
        title: 'Blank template',
        summary: 'Every section with prompts, for a category that has no document yet.',
      },
    ],
  ],
  // Lists the covered screens load alongside their main data. A missing one fails the
  // whole screen load, which is exactly what the 404 default is there to make visible.
  [/^\/projects\/2\/training\/analyses$/, () => []],
  [/^\/projects\/2\/assignees$/, () => harnessAssignees],
  [/^\/projects\/2\/calls(\?.*)?$/, () => callQueue],
  // The email composer, campaign picker, archive tools and funnels page (see emailFixtures.ts).
  ...emailRoutes(lead),
];

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, location.origin).pathname + new URL(url, location.origin).search;
  if (!path.startsWith('/api/')) return realFetch(input, init);
  const route = path.slice('/api'.length);
  const method = (init?.method || 'GET').toUpperCase();
  const match = routes.find(([pattern]) => pattern.test(route));
  const headers = { 'Content-Type': 'application/json' };
  if (method === 'POST' && /^\/projects\/2\/training\/analyze$/.test(route))
    return new Response(JSON.stringify(proposal), { status: 200, headers });
  if (method !== 'GET') {
    const write = [...settingsWrites, ...emailWrites].find(([verb, pattern]) => verb === method && pattern.test(route));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify(write ? write[2](body) : {}), { status: 200, headers });
  }
  // A missing fixture answers like a missing route, so the screen shows its own error instead
  // of receiving the wrong shape and taking the whole app down.
  if (!match)
    return new Response(JSON.stringify({ error: 'No harness fixture for ' + route }), {
      status: 404,
      headers,
    });
  return new Response(JSON.stringify(match[1](route)), { status: 200, headers });
};

// The app reads the route from the hash; default to the project overview.
if (!location.hash) location.hash = '#projects/2/overview';
await import('../main');

export {};

/**
 * UI harness: the real app, fed fixture data through a stubbed fetch.
 *
 * Why it exists: every screen sits behind a sign-in, so a layout change could only be checked by
 * someone logged in to a real workspace. This lets a screen be opened and looked at directly,
 * with data shaped like the team's (a project of imported leads with blank fields, several
 * training versions, a lead with an email but no name).
 *
 * Only GETs return data; writes answer {} so buttons can be clicked without anything persisting.
 * Development only — see harness.html. Nothing here is imported by the production entry.
 */
import { shellRoutes } from './shell-fixtures';

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

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

const sources = [
  {
    id: 1,
    project_id: 2,
    title: 'innovistadigi.com',
    kind: 'website',
    url: 'https://innovistadigi.com',
    content: 'x'.repeat(8503),
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
    content: 'x'.repeat(551),
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
    content: 'x'.repeat(9151),
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
  calls: [],
  emails: [],
  campaigns: [],
  outreach_events: [],
  outreach_status: 'NOT_CONTACTED',
};

const routes: Array<[RegExp, () => unknown]> = [
  ...shellRoutes,
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
  [/^\/projects\/2\/leads(\?.*)?$/, () => ({ leads: [lead], total: 198 })],
  [/^\/notifications/, () => ({ items: [], unread: 0 })],
  // Lists the covered screens load alongside their main data. A missing one fails the
  // whole screen load, which is exactly what the 404 default is there to make visible.
  [/^\/projects\/2\/training\/analyses$/, () => []],
  [/^\/projects\/2\/assignees$/, () => []],
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
  if (method !== 'GET') return new Response('{}', { status: 200, headers });
  // A missing fixture answers like a missing route, so the screen shows its own error instead
  // of receiving the wrong shape and taking the whole app down.
  if (!match)
    return new Response(JSON.stringify({ error: 'No harness fixture for ' + route }), {
      status: 404,
      headers,
    });
  return new Response(JSON.stringify(match[1]()), { status: 200, headers });
};

// The app reads the route from the hash; default to the project overview.
if (!location.hash) location.hash = '#projects/2/overview';
await import('../main');

export {};

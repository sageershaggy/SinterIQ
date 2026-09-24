/**
 * Harness fixtures for the app shell: the grouped updates feed, the research log and the project
 * mailbox status. Shaped like the team's data — a lead analyzed four times with the same result,
 * a mailbox saved with credentials but no SMTP host. Development only; see harness.ts.
 */
import type { NotificationFeed } from '../../shared/notifications';
import type { ResearchLogPage } from '../../shared/research-log';
import type { IncomingSettings, MailPage } from '../../shared/mailbox';
import type { EmailSettings } from '../../shared/types';

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const notifications: NotificationFeed = {
  unread: 4,
  items: [
    {
      id: 41,
      scope: 'project',
      project_id: 2,
      project_name: 'Innovista Research',
      lead_id: null,
      kind: 'training_draft',
      title: 'New training draft ready for review',
      created_at: ago(8),
      first_at: ago(8),
      count: 1,
      unread: 1,
      read_at: null,
    },
    {
      id: 318,
      scope: 'lead',
      project_id: 2,
      project_name: 'Innovista Research',
      lead_id: 7,
      kind: 'research',
      title: 'The Chopin Law Firm LLC: research completed — filled industry, city',
      created_at: ago(20),
      first_at: ago(20),
      count: 1,
      unread: 1,
      read_at: null,
    },
    {
      id: 40,
      scope: 'project',
      project_id: 2,
      project_name: 'Innovista Research',
      lead_id: null,
      kind: 'training_published',
      title: 'Training v10 published',
      created_at: ago(45),
      first_at: ago(45),
      count: 1,
      unread: 1,
      read_at: null,
    },
    {
      id: 312,
      scope: 'lead',
      project_id: 1,
      project_name: 'Sintertechnik',
      lead_id: 7,
      kind: 'qualification',
      title: 'Alternative Decor Works: needs review',
      created_at: ago(60 * 20),
      first_at: ago(60 * 26),
      count: 4,
      unread: 4,
      read_at: null,
    },
    {
      id: 39,
      scope: 'project',
      project_id: 2,
      project_name: 'Innovista Research',
      lead_id: null,
      kind: 'leads_imported',
      title: 'Leads imported: 198 new, 0 updated',
      created_at: ago(60 * 27),
      first_at: ago(60 * 27),
      count: 1,
      unread: 0,
      read_at: ago(60 * 26),
    },
    {
      id: 290,
      scope: 'lead',
      project_id: 1,
      project_name: 'Sintertechnik',
      lead_id: 7,
      kind: 'qualification',
      title: 'Amusement Whitewater (L.L.C.): needs review',
      created_at: ago(60 * 48),
      first_at: ago(60 * 72),
      count: 2,
      unread: 0,
      read_at: ago(60 * 40),
    },
  ],
};

const researchLog: ResearchLogPage = {
  lead: null,
  next_before: ago(60 * 30),
  entries: [
    {
      kind: 'research',
      id: 'research-12',
      lead_id: 7,
      lead_name: 'The Chopin Law Firm LLC',
      created_at: ago(20),
      created_by: 'Workspace Administrator',
      website: 'https://chopinlawfirm.com/',
      discovered: true,
      tried: ['chopinlawfirm.com'],
      found: [
        {
          field: 'website',
          value: 'https://chopinlawfirm.com/',
          evidence: '',
          source_url: 'https://chopinlawfirm.com/',
        },
        {
          field: 'industry',
          value: 'Personal injury law',
          evidence:
            'The Chopin Law Firm represents victims of personal injury across Louisiana and Mississippi.',
          source_url: 'https://chopinlawfirm.com/about',
        },
        {
          field: 'city',
          value: 'New Orleans',
          evidence: 'Our offices are at 650 Poydras Street in New Orleans.',
          source_url: 'https://chopinlawfirm.com/contact',
        },
      ],
      erased: [],
      refused_count: 1,
      notes: [],
    },
    {
      kind: 'qualification',
      id: 'qualification-88',
      run_id: 88,
      lead_id: 7,
      lead_name: 'The Chopin Law Firm LLC',
      created_at: ago(35),
      created_by: 'Workspace Administrator',
      training_version: 10,
      decision: 'NEEDS_REVIEW',
      score: 50,
      confidence: 64,
      summary:
        'A law firm with a dated website and no online intake; it matches the digital-gap criterion but its size could not be verified from the page.',
      criteria_total: 4,
      criteria_met: 2,
      criteria_unknown: 2,
      exclusions_hit: 0,
      gaps: ['Employee count', 'Whether they already work with an agency'],
      pages: ['https://chopinlawfirm.com/', 'https://chopinlawfirm.com/about'],
    },
    {
      kind: 'research',
      id: 'research-11',
      lead_id: 9,
      lead_name: 'Maui Surf Rentals',
      created_at: ago(55),
      created_by: 'Qudsiya',
      website: '',
      discovered: false,
      tried: ['mauisurfrentals.com', 'mauisurf.com'],
      found: [],
      erased: [],
      refused_count: 0,
      notes: [
        'mauisurfrentals.com is a parked, for-sale or placeholder page rather than a company website.',
        'mauisurf.com was reachable but its page does not name this company.',
      ],
    },
    {
      kind: 'review',
      id: 'review-5',
      run_id: 80,
      lead_id: 4,
      lead_name: 'Aloha Dental Group',
      created_at: ago(60 * 26),
      created_by: 'Workspace Administrator',
      decision: 'QUALIFIED',
      notes: 'Owner confirmed they are rebuilding the booking site this quarter.',
    },
  ],
};

const incoming: IncomingSettings = {
  project_id: 2,
  shared_with: [],
  host: 'imap.gmail.com',
  username: 'zengineering8@gmail.com',
  folder: 'INBOX',
  enabled: false,
  has_password: true,
  revision: 1,
  last_sync: '',
  last_error: '',
};
// As in the owner's screenshot: credentials saved, SMTP host left empty.
const sending: EmailSettings = {
  project_id: 2,
  host: '',
  port: 587,
  secure: false,
  username: 'Zengineering',
  from_name: 'Innovista',
  from_email: 'zengineering8@gmail.com',
  reply_to: '',
  copy_to: 'zengineering8@gmail.com',
  signature: '',
  configured: false,
  has_password: true,
};
const mailPage: MailPage = {
  items: [],
  total: 0,
  counts: { inbox: 0, outbox: 0, sent: 0, drafts: 0 },
  incoming,
  outgoing_configured: false,
};

export const shellRoutes: Array<[RegExp, () => unknown]> = [
  [/^\/notifications$/, () => notifications],
  [/^\/projects\/2\/research-log(\?.*)?$/, () => researchLog],
  [/^\/projects\/2\/mailbox(\?.*)?$/, () => mailPage],
  [/^\/projects\/2\/mailbox\/email$/, () => sending],
  [/^\/projects\/2\/mailbox\/settings$/, () => incoming],
];

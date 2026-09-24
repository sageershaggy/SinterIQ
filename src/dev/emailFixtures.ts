/**
 * Harness fixtures for the email composer, the campaign picker, archiving and the funnels page.
 * Lead 8 is a qualified, high-scoring company, so the composer pre-selects the high-quality
 * campaign; lead 7 (unscored) shows every campaign blocked and a one-off email suggested.
 * Development only, imported by harness.ts.
 */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const html = (text: string) =>
  text
    .split('\n\n')
    .map((part) => '<p>' + part + '</p>')
    .join('');
const campaigns = [
  {
    id: 1,
    name: 'High-quality campaign',
    audience: 'Fit 80+ · decision makers',
    status: 'ACTIVE',
    fit_band: 'HIGH',
    stop_on_reply: true,
    steps: [
      {
        subject: 'A question for {{company}}',
        html:
          '<h2>Hello {{contact_first_name}},</h2>' +
          html(
            'I was reading about {{company}} and wanted to ask whether our engineering services could help your team.\n\nWould a short call next week be useful?\n\nBest regards,<br>{{sender_name}}',
          ),
        delay_days: 0,
        send_time: '09:00',
        attachment_ids: [],
      },
      {
        subject: 'Following up with {{company}}',
        html: html('Hello,\n\nFollowing up on my note. Is there a requirement we could discuss?'),
        delay_days: 3,
        send_time: '09:00',
        attachment_ids: [],
      },
      {
        subject: 'Last note for {{company}}',
        html: html('Hello,\n\nThis is my final follow-up. Reply whenever it suits you.'),
        delay_days: 7,
        send_time: '10:30',
        attachment_ids: [],
      },
    ],
  },
  {
    id: 2,
    name: 'Email campaign',
    audience: 'Fit 50–79',
    status: 'DRAFT',
    fit_band: 'EMAIL',
    stop_on_reply: true,
    steps: [
      {
        subject: 'An introduction for {{company}}',
        html: html('Hello,\n\nA short introduction in case it is relevant to {{company}}.'),
        delay_days: 0,
        send_time: '09:00',
        attachment_ids: [],
      },
      {
        subject: 'Closing the loop',
        html: html('Hello,\n\nClosing the loop on my introduction.'),
        delay_days: 5,
        send_time: '09:00',
        attachment_ids: [],
      },
    ],
  },
  {
    id: 3,
    name: 'Event follow-up',
    audience: 'Visitors from the trade fair',
    status: 'PAUSED',
    fit_band: 'ANY',
    stop_on_reply: false,
    steps: [
      {
        subject: 'Good to meet you at the fair',
        html: html('Hello {{contact_first_name}},\n\nIt was good to meet you at the fair.'),
        delay_days: 0,
        send_time: '',
        attachment_ids: [],
      },
    ],
  },
];
export const qualifiedLead = {
  id: 8,
  project_id: 2,
  name: 'Vanst Law LLP',
  website: 'https://vanstlaw.example',
  country: 'United States',
  industry: 'Legal services',
  notes: '',
  revision: 1,
  status: 'QUALIFIED',
  score: 86,
  confidence: 90,
  latest_run_id: 11,
  training_version: 10,
  qualified_revision: 1,
  contact_name: 'Jordan Vanst',
  contact_role: 'Managing partner',
  contact_email: 'jsv@vanstlaw.example',
  contact_phone: '',
  city: 'Honolulu',
  employee_count: '24',
  assigned_to: null,
  assigned_at: null,
  assigned_to_name: null,
  call_count: 0,
  next_step: 'CALL_READY',
  stale: false,
  reviewed: true,
  created_at: ago(60 * 26),
  updated_at: ago(60 * 2),
  runs: [],
  reviews: [],
  feedback: [],
  calls: [],
  emails: [
    {
      id: 41,
      project_id: 2,
      lead_id: 8,
      to_email: 'jsv@vanstlaw.example',
      subject: 'The brief you asked for',
      body: 'Hello Jordan,\n\nHere is the brief we discussed.',
      status: 'SENT',
      error: '',
      created_by: 'Workspace Administrator',
      created_at: ago(60 * 5),
    },
  ],
  campaigns: [],
  outreach_events: [],
  outreach_status: 'CONTACTED',
  archived_at: null,
  archived_reason: '',
};
const templates = [
  {
    id: 'support',
    name: 'Support email',
    category: 'transactional',
    description: 'A simple starting point for helping a company.',
    subject: 'Support for {{company}}',
    preview_text: 'How can we help your team?',
    blocks: [],
    html: '<h3>How can we help?</h3><p>Hello,</p><p>I am getting in touch with the team at {{company}}.</p>',
  },
  ...[
    ['follow-up-1', '2nd email · first follow-up', 'The second email in a sequence.'],
    ['follow-up-2', '3rd email · second follow-up', 'The third email: closes the loop.'],
    ['follow-up-3', 'Last email · final follow-up', 'The last email in a sequence.'],
  ].map(([id, name, description]) => ({
    id,
    name,
    category: 'follow_up',
    description,
    subject: 'Following up with {{company}}',
    preview_text: '',
    blocks: [],
    html: '<p>Hello {{contact_first_name}},</p><p>' + description + '</p>',
  })),
];
const offer = (
  lead: { name: string; score: number | null; contact_email: string },
  qualified: boolean,
) => ({
  subject: lead.name + ' — a quick question',
  body: '',
  to: lead.contact_email,
  saved: { revision: 0, document: null, updated_at: null },
  mailbox: {
    configured: true,
    from_email: 'research@innovistadigi.com',
    from_name: 'Innovista Research',
  },
  campaigns: campaigns.map((campaign) => ({
    ...campaign,
    blocked: qualified
      ? ''
      : lead.name + ' needs a current, qualified result before enrollment or sending.',
  })),
  suggested: qualified
    ? { funnel_id: 1, reason: 'Suggested for fit ' + lead.score + ' (the 80–100 campaign).' }
    : {
        funnel_id: null,
        reason: 'This lead has no fit score yet, so a one-off email is suggested.',
      },
  bounced: null,
  files: [],
});
const progress = (
  waiting: number[],
  replied: number,
  bounced: number,
  stopped: number,
  completed: number,
) => ({
  waiting,
  replied,
  bounced,
  stopped,
  blocked: 0,
  completed,
  total: waiting.reduce((a, b) => a + b, 0) + replied + bounced + stopped + completed,
});
const funnels = campaigns.map((campaign, index) => ({
  id: campaign.id,
  project_id: 2,
  name: campaign.name,
  audience: campaign.audience,
  status: campaign.status,
  revision: 1,
  created_at: ago(60 * 24 * (3 - index)),
  enrolled_count: [14, 0, 5][index],
  queued_count: [8, 0, 2][index],
  converted_count: [1, 0, 0][index],
  stop_on_reply: campaign.stop_on_reply,
  fit_band: campaign.fit_band,
  steps: campaign.steps.map((step) => ({
    delay_days: step.delay_days,
    send_time: step.send_time,
    to: '{{contact_email}}',
    subject: step.subject,
    body: '',
    html: step.html,
  })),
  progress: [
    progress([3, 3, 2], 3, 1, 1, 1),
    progress([0, 0, 0], 0, 0, 0, 0),
    progress([2, 0, 0], 1, 0, 2, 0),
  ][index],
}));

export function emailRoutes(lead: { name: string; score: number | null; contact_email: string }) {
  return [
    [/^\/projects\/2\/leads\/8$/, () => qualifiedLead],
    [
      /^\/projects\/2\/email\/templates$/,
      () => ({
        templates,
        categories: [],
        merge_fields: [
          'company',
          'contact_name',
          'contact_first_name',
          'contact_role',
          'sender_name',
        ],
      }),
    ],
    [/^\/projects\/2\/leads\/7\/email\/draft$/, () => offer(lead, false)],
    [/^\/projects\/2\/leads\/8\/email\/draft$/, () => offer(qualifiedLead, true)],
    [/^\/projects\/2\/leads\/\d+\/incoming/, () => []],
    [
      /^\/projects\/2\/leads\/8\/email\/files$/,
      () => ({
        41: [{ id: 5, filename: 'Vanst brief.pdf', size: 184_320, disposition: 'attachment' }],
      }),
    ],
    [/^\/projects\/2\/leads\/\d+\/email\/files$/, () => ({})],
    [/^\/projects\/2\/email\/files\?ids=/, () => []],
    [/^\/projects\/2\/funnels$/, () => ({ funnels, delivery_ready: true })],
    [/^\/projects\/2\/funnels\/\d+\/enrollments/, () => ({ enrollments: [], total: 0 })],
    [
      /^\/projects\/2\/archive\/below-50$/,
      () => ({
        count: 2,
        leads: [
          { id: 31, name: 'Kona Surf Rentals', score: 25 },
          { id: 32, name: 'Maui Print Shop', score: 40 },
        ],
      }),
    ],
    [
      /^\/projects\/2\/archive$/,
      () => ({
        total: 1,
        leads: [
          {
            id: 30,
            name: 'Closed Bakery LLC',
            score: 50,
            archived_at: ago(60 * 30),
            archived_reason: 'Company closed',
            archived_by: 'Workspace Administrator',
          },
        ],
      }),
    ],
  ] as Array<[RegExp, () => unknown]>;
}

/** Writes the email screens make, answered the way the server would. */
let revision = 0;
export const emailWrites: Array<[string, RegExp, (body: unknown) => unknown]> = [
  [
    'PUT',
    /\/email\/draft$/,
    () => ({ revision: ++revision, document: null, updated_at: new Date().toISOString() }),
  ],
  [
    'POST',
    /\/email\/preview$/,
    (body) => {
      const input = body as { html?: string; subject?: string };
      const merged = String(input.html || '')
        .replace(/\{\{company\}\}/g, 'Vanst Law LLP')
        .replace(/\{\{contact_first_name\}\}/g, 'Jordan')
        .replace(/\{\{sender_name\}\}/g, 'Innovista Research');
      return {
        html:
          '<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f6f7f3;font-family:Segoe UI,Arial,sans-serif;"><table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px"><tr><td style="padding:28px 32px;font-size:15px;line-height:1.65;color:#25352e">' +
          merged +
          '<div style="margin-top:20px;font-size:11px;color:#8a9184">Innovista Research &lt;research@innovistadigi.com&gt;<br>Reply with “unsubscribe” and we will not contact you again.</div></td></tr></table></body></html>',
        text: '',
        warnings: [],
        missing_merge_fields: [],
        block_problems: [],
      };
    },
  ],
  [
    'POST',
    /\/email\/improve$/,
    () => ({
      subject: 'A short question for {{company}}',
      html: '<p>Hello {{contact_first_name}},</p><p>I noticed {{company}} is growing its engineering team. Would a 20-minute call next week help you decide whether we are a fit?</p><p>Best regards,<br>{{sender_name}}</p>',
      notes: 'Shorter opening and one clear question.',
    }),
  ],
];

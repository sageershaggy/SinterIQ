/**
 * Harness fixtures for the lead list: a page of leads in every qualification state, the
 * project-wide counts, the Filters panel's options and a team to assign to. Development only.
 */
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

export const harnessAssignees = [
  { id: 1, username: 'admin', name: 'Workspace Administrator', role: 'admin' },
  { id: 4, username: 'dana', name: 'Dana Prakash', role: 'researcher' },
];

/** Six rows built on the harness's own lead, so the detail page still opens from the first. */
function rows(base: Record<string, unknown>) {
  const run = (status: string, score: number, extra: Record<string, unknown> = {}) => ({
    status,
    score,
    confidence: 80,
    latest_run_id: 40,
    training_version: 10,
    qualified_revision: 1,
    ...extra,
  });
  return [
    base,
    {
      ...base,
      id: 8,
      name: 'Alpha Pumps GmbH',
      website: 'https://alpha-pumps.example.com',
      industry: 'Pump manufacturing',
      country: 'Germany',
      city: 'Berlin',
      contact_name: 'Dana Weber',
      contact_role: 'Head of Engineering',
      ...run('QUALIFIED', 92),
      reviewed: true,
      assigned_to: 4,
      assigned_to_name: 'Dana Prakash',
      call_count: 2,
      outreach_status: 'CONTACTED',
      next_step: 'CALL_READY',
    },
    {
      ...base,
      id: 9,
      name: 'Beta Legal Partners',
      website: 'https://beta-legal.example.com',
      industry: 'Law firm',
      country: 'United Arab Emirates',
      city: 'Dubai',
      ...run('NEEDS_REVIEW', 64),
      next_step: 'REVIEW_WITH_CLIENT',
    },
    {
      ...base,
      id: 10,
      name: 'Gamma Maintenance Est.',
      industry: 'Building maintenance',
      country: 'United Arab Emirates',
      ...run('NOT_A_TARGET', 31),
    },
    {
      ...base,
      id: 11,
      name: 'Alternative Decor Works',
      industry: 'Interior design',
      country: 'Oman',
      ...run('QUALIFIED', 83, { training_version: 9 }),
      stale: true,
    },
    {
      ...base,
      id: 12,
      name: 'Amusement Whitewater (L.L.C)',
      industry: 'Leisure',
      country: 'United Arab Emirates',
      city: 'Abu Dhabi',
    },
  ];
}

/** GET /projects/2/leads — honours page, so the pager can be walked. */
export function leadsPage(route: string, base: Record<string, unknown>) {
  const query = new URLSearchParams(route.split('?')[1] || '');
  const pageSize = Number(query.get('page_size') || 30);
  const total = 198;
  const pages = Math.ceil(total / pageSize);
  const page = Math.min(Math.max(1, Number(query.get('page') || 1)), pages);
  return {
    leads: rows(base),
    total,
    page,
    pages,
    page_size: pageSize,
    summary: { total, raw: 150, qualified: 21, needs_review: 12, not_qualified: 9, requalify: 6 },
  };
}

/** GET /projects/2/lead-facets */
export const leadFacets = {
  industry: [
    { value: '', count: 120 },
    { value: 'Building maintenance', count: 31 },
    { value: 'Interior design', count: 9 },
    { value: 'Law firm', count: 14 },
    { value: 'Leisure', count: 4 },
    { value: 'Pump manufacturing', count: 11 },
    { value: 'Real estate', count: 5 },
    { value: 'Restaurants', count: 2 },
    { value: 'Retail', count: 2 },
  ],
  country: [
    { value: '', count: 88 },
    { value: 'Germany', count: 12 },
    { value: 'Oman', count: 7 },
    { value: 'United Arab Emirates', count: 91 },
  ],
  city: [
    { value: '', count: 140 },
    { value: 'Abu Dhabi', count: 20 },
    { value: 'Berlin', count: 5 },
    { value: 'Dubai', count: 33 },
  ],
  assignee: [
    { value: 'none', label: 'Unassigned', count: 190 },
    { value: '4', label: 'Dana Prakash', count: 8 },
  ],
};

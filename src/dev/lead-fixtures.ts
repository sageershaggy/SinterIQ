/**
 * Harness fixtures for the lead list: a page of leads in every qualification state, the
 * project-wide counts, the filter bar's options and a team to assign to. Development only.
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
    {
      ...base,
      id: 13,
      name: 'Kaimana Surf Supply',
      website: 'https://kaimana-surf.example.com',
      industry: 'Retail',
      country: 'United States',
      city: 'Honolulu',
      contact_name: 'Leilani Kahale',
      contact_role: 'Owner',
      ...run('QUALIFIED', 100),
      reviewed: true,
      // Assigned to the harness's own account, so Assigned to: Me finds it.
      assigned_to: 1,
      assigned_to_name: 'Workspace Administrator',
      outreach_status: 'UNSUBSCRIBED',
      next_step: 'CALL_READY',
    },
    {
      ...base,
      id: 14,
      name: 'Pacific Rim Logistics',
      website: 'https://pacificrim.example.com',
      industry: 'Logistics',
      country: 'United States',
      city: 'Kapolei',
      ...run('QUALIFIED', 74),
      outreach_status: 'REPLIED',
      next_step: 'SEND_EMAIL',
    },
  ];
}

/**
 * A rough echo of the server's facets over the fixture rows, so choosing something in the
 * filter bar visibly changes the table. The real rules live in server/lead-filters.ts.
 */
function narrowed(rows: Array<Record<string, unknown>>, query: URLSearchParams) {
  const state = (row: Record<string, unknown>) =>
    !row.latest_run_id
      ? 'RAW'
      : row.stale
        ? 'REQUALIFY'
        : row.status === 'QUALIFIED'
          ? 'QUALIFIED'
          : row.status === 'NOT_A_TARGET'
            ? 'NOT_QUALIFIED'
            : 'NEEDS_REVIEW';
  const tests: Record<string, (row: Record<string, unknown>, value: string) => boolean> = {
    qualification: (row, value) => state(row) === value,
    next_step: (row, value) => row.next_step === value,
    assignee: (row, value) =>
      value === 'me'
        ? row.assigned_to === 1
        : value === 'any'
          ? row.assigned_to !== null
          : value === 'none'
            ? row.assigned_to === null
            : String(row.assigned_to) === value,
    research: (row, value) =>
      value === 'NO_WEBSITE'
        ? !row.website
        : value === 'MISSING_DETAILS'
          ? !row.website || !row.industry || (!row.city && !row.country)
          : value === 'RESEARCHED'
            ? Boolean(row.latest_run_id)
            : !row.latest_run_id,
    industry: (row, value) => String(row.industry).toLowerCase() === value.toLowerCase(),
    country: (row, value) => String(row.country).toLowerCase() === value.toLowerCase(),
  };
  return rows.filter((row) =>
    Object.entries(tests).every(([key, test]) => {
      const values = query.getAll(key);
      return !values.length || values.some((value) => test(row, value));
    }),
  );
}

/** GET /projects/2/leads — honours page, so the pager can be walked. */
export function leadsPage(route: string, base: Record<string, unknown>) {
  const query = new URLSearchParams(route.split('?')[1] || '');
  const pageSize = Number(query.get('page_size') || 30);
  const leads = narrowed(rows(base), query);
  // Unfiltered, the list stands in for a 198-lead project so the pager can be walked.
  const total = leads.length === rows(base).length ? 198 : leads.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(query.get('page') || 1)), pages);
  return {
    leads,
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
    { value: 'none', label: 'Unassigned', count: 189 },
    { value: '4', label: 'Dana Prakash', count: 8 },
    { value: '1', label: 'Workspace Administrator', count: 1 },
  ],
};

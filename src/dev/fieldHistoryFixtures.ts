/**
 * Field-history fixtures for the dev harness (src/dev/harness.ts): where each company detail
 * came from (shared/field-history.ts), for the Company card.
 *
 * - Lead 8 keeps its company size as a person typed it, so the website's other headcount stays a
 *   visible conflict with "Use website value".
 * - Lead 9 is the owner's example: imported as New York, United States, with 20 employees;
 *   qualification found Frankfurt am Main, Germany and 45 on the company's own website, and those
 *   are its current values now, verified by research, with the imported ones kept in the history.
 *
 * Open #projects/2/leads/9 in harness.html to see it.
 */
import type { FieldChange } from '../../shared/field-history';

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const admin = 'Workspace Administrator';

let nextId = 1;
const change = (
  field: FieldChange['field'],
  origin: FieldChange['origin'],
  previous_value: string,
  new_value: string,
  minutes: number,
  source: { evidence?: string; source_url?: string; by?: string } = {},
): FieldChange => ({
  id: nextId++,
  field,
  origin,
  previous_value,
  new_value,
  evidence: source.evidence ?? '',
  source_url: source.source_url ?? '',
  changed_at: ago(minutes),
  changed_by: source.by ?? admin,
});

/** Lead 8: imported, then researched into its blanks; the headcount typed by a person. */
export function lead8History(site: string): FieldChange[] {
  return [
    change('country', 'import', '', 'United Arab Emirates', 60 * 27),
    change('employee_count', 'import', '', '12', 60 * 27),
    change('employee_count', 'person', '12', '20', 60 * 3),
    change('website', 'research', '', site, 41, { source_url: site }),
    change('industry', 'research', '', 'Water ride design and installation', 41, {
      evidence:
        'Amusement Whitewater designs and installs water rides and splash parks for resorts across the Gulf.',
      source_url: site,
    }),
    change('city', 'research', '', 'Dubai', 41, {
      evidence: 'Our design studio and workshop are in Al Quoz, Dubai.',
      source_url: site + '/contact',
    }),
  ].reverse();
}

type Routes = Array<[RegExp, (route: string) => unknown]>;

/** Lead 9, built on the harness's researched lead so it carries the same full lead page. */
export function fieldHistoryRoutes<
  L extends { runs: Array<{ result: Record<string, unknown> } & Record<string, unknown>> },
  P extends Record<string, unknown>,
>(researched: L, profile: P): Routes {
  const site = 'https://rheinmain-splash.example.de';
  const headOffice = 'Our head office and workshop are in Frankfurt am Main, Germany.';
  const people =
    'Rhein-Main Splash Systems employs 45 people in design, fabrication and installation.';
  const run = researched.runs[0];
  const evidence = [
    {
      id: 'E1',
      kind: 'lead_record',
      title: 'User-provided lead record (unverified)',
      url: '',
      content: '{"name":"Rhein-Main Splash Systems GmbH"}',
      captured_at: ago(40),
    },
    {
      id: 'E2',
      kind: 'website',
      title: 'rheinmain-splash.example.de/',
      url: site + '/',
      content:
        'Rhein-Main Splash Systems designs and builds water rides and splash pads. ' +
        headOffice +
        ' ' +
        people,
      captured_at: ago(40),
    },
  ];
  const lead = {
    ...researched,
    id: 9,
    name: 'Rhein-Main Splash Systems GmbH',
    website: site,
    city: 'Frankfurt am Main',
    country: 'Germany',
    industry: 'Water rides and splash pads',
    employee_count: '45',
    contact_email: 'info@rheinmain-splash.example.de',
    list_data: {},
    notes: '',
    campaigns: [],
    revision: 4,
    qualified_revision: 4,
    runs: [
      {
        ...run,
        id: 41,
        lead_id: 9,
        lead_revision: 3,
        evidence,
        result: {
          ...run.result,
          summary:
            'A Frankfurt water-ride builder with a dated website and manual quote handling. The imported record said New York; the company’s own website gives Frankfurt am Main, Germany.',
          conflicts: [
            {
              field: 'city',
              record_value: 'New York',
              found_value: 'Frankfurt am Main',
              quote: headOffice,
              source_ids: ['E2'],
              applied: true,
            },
            {
              field: 'country',
              record_value: 'United States',
              found_value: 'Germany',
              quote: headOffice,
              source_ids: ['E2'],
              applied: true,
            },
            {
              field: 'employee_count',
              record_value: '20',
              found_value: '45',
              quote: people,
              source_ids: ['E2'],
              applied: true,
            },
          ],
          gaps: [],
          research: {
            ran: true,
            origin: 'qualification',
            website: site,
            website_found: true,
            filled: ['website'],
            contacts_added: 0,
            checked: ['Candidate websites checked: rheinmain-splash.example.de.'],
          },
        },
      },
    ],
    latest_run_id: 41,
  };
  const cite = (field: string, value: string, evidenceText: string) => ({
    field,
    value,
    evidence: evidenceText,
    source_url: site + '/',
    created_at: ago(40),
    created_by: admin,
  });
  const history = [
    change('city', 'import', '', 'New York', 60 * 30),
    change('country', 'import', '', 'United States', 60 * 30),
    change('industry', 'import', '', 'Water rides and splash pads', 60 * 30),
    change('employee_count', 'import', '', '20', 60 * 30),
    change('website', 'research', '', site, 42, { source_url: site }),
    ...(
      [
        ['city', 'New York', 'Frankfurt am Main', headOffice],
        ['country', 'United States', 'Germany', headOffice],
        ['employee_count', '20', '45', people],
      ] as const
    ).map(([field, from, to, quote]) =>
      change(field, 'research', from, to, 40, { evidence: quote, source_url: site + '/' }),
    ),
  ].reverse();
  const leadProfile = {
    ...profile,
    citations: [
      { ...cite('website', site, ''), source_url: site },
      cite('city', 'Frankfurt am Main', headOffice),
      cite('country', 'Germany', headOffice),
      cite('employee_count', '45', people),
    ],
    contacts: [],
    runs: [],
    history,
  };
  return [
    [/^\/projects\/2\/leads\/9$/, () => lead],
    [/^\/projects\/2\/leads\/9\/research-profile$/, () => leadProfile],
    [/^\/projects\/2\/leads\/9\/contacts$/, () => []],
  ];
}

/**
 * The import dialog's three writes (server/lead-import.ts), so preview, quick screen and the
 * chosen-row import can be clicked through in the harness. Screening answers from each row's
 * industry after a short pause, which is enough to watch progress and try Stop.
 */
import type {
  ImportLead,
  ImportPreview,
  ImportRowsResult,
  ScreenVerdict,
} from '../../shared/lead-import';

const industries = [
  'Web design agency',
  'Staffing and recruitment',
  '',
  'E-commerce retail',
  'Restaurant',
  'Software consultancy',
  'Government department',
];
const blank: ImportLead = {
  name: '',
  website: '',
  country: 'United Arab Emirates',
  city: 'Dubai',
  industry: '',
  employee_count: '',
  contact_name: '',
  contact_role: '',
  contact_email: '',
  contact_phone: '',
  notes: '',
};
const rows = Array.from({ length: 120 }, (_, i) => {
  const industry = industries[i % industries.length];
  // The file's other columns, kept with each lead as list data (the LinkedIn one is not).
  const listData: Record<string, string> = { Event: 'GCC Leisure Expo 2026' };
  if (i % 2) listData.Stand = 'Hall ' + ((i % 4) + 1);
  const lead = {
    ...blank,
    name: 'Harness Company ' + (i + 1) + (industry ? ' ' + industry.split(' ')[0] : ''),
    website: i % 5 === 2 ? '' : 'https://company-' + (i + 1) + '.example',
    industry,
    employee_count: i % 3 ? String(10 + i) : '',
    list_data: listData,
  };
  return {
    row: i + 2,
    lead,
    cells: [
      lead.name,
      lead.website,
      lead.industry,
      lead.employee_count,
      lead.list_data.Event,
      lead.list_data.Stand ?? '',
      i % 4 ? '' : '=HYPERLINK("x")',
    ],
    // Where the existing lead stands, which the import keeps (one qualified, one not yet).
    duplicate:
      i === 7
        ? { id: 907, name: lead.name + ' LLC', status: 'QUALIFIED' as const, score: 80 }
        : i === 30
          ? { id: 930, name: lead.name + ' LLC', status: 'UNREVIEWED' as const, score: null }
          : null,
    // The same leads added to the file again: counted once, with the row they repeat.
    repeat_of: i === 60 || i === 61 ? i - 58 : null,
  };
});
const preview: ImportPreview = {
  total: 123,
  columns: [
    'company_name',
    'company_website',
    'industry',
    'company_size',
    'event',
    'stand',
    'linkedin',
  ],
  rows,
  problems: [
    {
      row: 124,
      name: '(no company)',
      reason: 'No company name. This row has no Company Name / Name column value.',
    },
  ],
  warnings: [
    {
      row: 9,
      name: rows[7].lead.name,
      reason:
        'Imported without a website: "localhost:3000" is not a usable public address. Add the real website, then qualify the lead.',
    },
  ],
  screening: { available: true, reason: '' },
};
function verdict(lead: ImportLead, index: number): ScreenVerdict {
  const industry = lead.industry.toLowerCase();
  if (industry.includes('staffing'))
    return {
      index,
      verdict: 'REJECT',
      reason: 'Matches exclusion: staffing agency.',
      rule: 'Staffing or recruitment agencies',
    };
  if (industry.includes('government'))
    return {
      index,
      verdict: 'UNCLEAR',
      reason: 'A government department; the row does not say whether it buys digital services.',
      rule: '',
    };
  if (!industry)
    return {
      index,
      verdict: 'UNCLEAR',
      reason: 'The row has no industry or notes to judge by.',
      rule: '',
    };
  if (industry.includes('restaurant'))
    return {
      index,
      verdict: 'REJECT',
      reason: 'A single restaurant, below the size the training targets.',
      rule: 'Company size is roughly 2–200 employees, where marketing and technology decisions are made quickly and without long procurement cycles.',
    };
  return {
    index,
    verdict: 'PASS',
    reason: 'Industry is ' + lead.industry.toLowerCase() + ', a target sector.',
    rule: '',
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function importWrite(method: string, route: string, init?: RequestInit) {
  if (method !== 'POST' || !/^\/projects\/2\/leads\/import\//.test(route)) return null;
  if (route.endsWith('/preview')) return json(preview);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  if (route.endsWith('/screen')) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    // Every third row was screened before against this training and keeps its verdict.
    return json({
      verdicts: (body.rows as ImportLead[]).map((lead, index) => ({
        ...verdict(lead, index),
        ...(index % 3 === 0 ? { reused: true } : {}),
      })),
    });
  }
  if (route.endsWith('/rows')) {
    const leads = body.leads as ImportLead[];
    const duplicates = leads.filter(
      (lead) => rows.find((r) => r.lead.name === lead.name)?.duplicate,
    );
    const result: ImportRowsResult = {
      total: leads.length,
      created: leads.length - duplicates.length,
      updated: 0,
      skipped: duplicates.length,
      duplicates: duplicates.map((lead) => lead.name),
      created_ids: leads.slice(duplicates.length).map((_, i) => 5000 + i),
      warned: 0,
      warnings: [],
    };
    return json(result);
  }
  return null;
}

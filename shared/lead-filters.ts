/**
 * The lead-list facets and sort orders: one vocabulary for the server's query schema, the
 * Filters panel, the active-filter chips and the export link, so the list and the CSV export
 * can never be asked different questions.
 *
 * Every facet is multi-select and ORs within itself; different facets AND together, and all of
 * them AND with the status view chosen in the "All leads" dropdown and with the search box.
 */
import type { CallOutcome } from './types';
import { callOutcomeStage, type CallStage } from './calls';
import { pipelineStatusLabels, pipelineStatuses, type PipelineStatus } from './crm';

/**
 * Where a lead stands in qualification. A partition: every lead is in exactly one state, and it
 * is the same state the table's badge shows (a superseded result reads "Requalification needed"
 * whatever its old decision was).
 */
export const qualificationStates = [
  'RAW',
  'QUALIFIED',
  'NEEDS_REVIEW',
  'NOT_QUALIFIED',
  'REQUALIFY',
] as const;
export type QualificationState = (typeof qualificationStates)[number];
export const qualificationLabels: Record<QualificationState, string> = {
  RAW: 'Raw leads',
  QUALIFIED: 'Qualified',
  NEEDS_REVIEW: 'Needs review',
  NOT_QUALIFIED: 'Not qualified',
  REQUALIFY: 'Requalification needed',
};
export const qualificationHints: Record<QualificationState, string> = {
  RAW: 'No AI research run yet',
  QUALIFIED: 'Qualified on the current training',
  NEEDS_REVIEW: 'Open questions for a person to settle',
  NOT_QUALIFIED: 'Not a target on the current training',
  REQUALIFY: 'Training or the lead changed since the last run',
};

/** The owner's fit-score ranges. A lead with no score is in none of them. */
export const fitScoreBands = [
  { value: '80_100', label: '80–100', min: 80, max: 100 },
  { value: '60_79', label: '60–79', min: 60, max: 79 },
  { value: '50_59', label: '50–59', min: 50, max: 59 },
  { value: 'BELOW_50', label: 'Below 50', min: 0, max: 49 },
] as const;
export type FitScoreBand = (typeof fitScoreBands)[number]['value'];
export const fitScoreValues = fitScoreBands.map((band) => band.value) as [
  FitScoreBand,
  ...FitScoreBand[],
];

/**
 * A lead's calling state, derived from its assignment and its most recent logged call only.
 * Also a partition: exactly one per lead.
 */
export const callStatuses = ['ASSIGNED', 'PENDING', 'COMPLETED', 'FOLLOW_UP', 'NONE'] as const;
export type CallStatus = (typeof callStatuses)[number];
export const callStatusLabels: Record<CallStatus, string> = {
  ASSIGNED: 'Call assigned',
  PENDING: 'Call pending',
  COMPLETED: 'Call completed',
  FOLLOW_UP: 'Call follow-up required',
  NONE: 'No call yet',
};
export const callStatusHints: Record<CallStatus, string> = {
  ASSIGNED: 'Assigned for calling, no call logged yet',
  PENDING: 'Called, but nobody answered yet',
  COMPLETED: 'The last call reached an outcome',
  FOLLOW_UP: 'The last call needs another: call back, follow-up or wrong contact',
  NONE: 'Not assigned and never called',
};
/**
 * Which call status the most recent logged outcome puts a lead in. Read from the mapping the
 * Calls page uses (callOutcomeStage in shared/calls.ts), so the two screens always agree.
 */
const stageStatus: Record<
  Exclude<CallStage, 'NO_CALL_YET'>,
  Exclude<CallStatus, 'ASSIGNED' | 'NONE'>
> = {
  PENDING: 'PENDING',
  FOLLOW_UP_REQUIRED: 'FOLLOW_UP',
  COMPLETED: 'COMPLETED',
};
export const callOutcomeStatus = Object.fromEntries(
  Object.entries(callOutcomeStage).map(([outcome, stage]) => [outcome, stageStatus[stage]]),
) as Record<CallOutcome, Exclude<CallStatus, 'ASSIGNED' | 'NONE'>>;

/** Lead status: the manual CRM status people set on the lead page (shared/crm.ts). */
export const leadStatuses = pipelineStatuses;
export type LeadStatusValue = PipelineStatus;
export const leadStatusLabels = pipelineStatusLabels;

/** Email status: the outreach status the mail and funnel code maintains. */
export const emailStatuses = [
  'NOT_CONTACTED',
  'CONTACTED',
  'REPLIED',
  'INTERESTED',
  'CONVERTED',
  'STOPPED',
  'UNSUBSCRIBED',
] as const;
export type EmailStatusValue = (typeof emailStatuses)[number];
export const emailStatusLabels: Record<EmailStatusValue, string> = {
  NOT_CONTACTED: 'Not contacted',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  INTERESTED: 'Interested',
  CONVERTED: 'Converted',
  STOPPED: 'Stopped',
  UNSUBSCRIBED: 'Unsubscribed',
};

/** Not a partition: a researched lead can still be missing details. */
export const researchStatuses = ['RESEARCHED', 'NOT_RESEARCHED', 'MISSING_DETAILS'] as const;
export type ResearchStatus = (typeof researchStatuses)[number];
export const researchStatusLabels: Record<ResearchStatus, string> = {
  RESEARCHED: 'Researched',
  NOT_RESEARCHED: 'Not researched',
  MISSING_DETAILS: 'Missing details',
};
export const researchStatusHints: Record<ResearchStatus, string> = {
  RESEARCHED: 'Analysed by AI or filled in from its website',
  NOT_RESEARCHED: 'No AI analysis and no website research yet',
  MISSING_DETAILS: 'Website, industry or location still blank',
};

export const dateAddedPresets = ['TODAY', '7D', '30D', 'CUSTOM'] as const;
export type DateAdded = (typeof dateAddedPresets)[number];
export const dateAddedLabels: Record<DateAdded, string> = {
  TODAY: 'Today',
  '7D': 'Last 7 days',
  '30D': 'Last 30 days',
  CUSTOM: 'Custom range',
};

export const leadSorts = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'added_desc', label: 'Date added — newest first' },
  { value: 'added_asc', label: 'Date added — oldest first' },
  { value: 'name_asc', label: 'Company name — A to Z' },
  { value: 'name_desc', label: 'Company name — Z to A' },
  { value: 'score_desc', label: 'Fit score — highest first' },
  { value: 'score_asc', label: 'Fit score — lowest first' },
  { value: 'industry_asc', label: 'Industry — A to Z' },
  { value: 'industry_desc', label: 'Industry — Z to A' },
] as const;
export type LeadSort = (typeof leadSorts)[number]['value'];
export const leadSortValues = leadSorts.map((sort) => sort.value) as [LeadSort, ...LeadSort[]];

/** "Unassigned" in the Assigned-to facet; any other value is an account id. */
export const UNASSIGNED = 'none';

/** The facet half of a lead query, as the browser holds it. */
export interface LeadFacets {
  qualification: QualificationState[];
  score: FitScoreBand[];
  call: CallStatus[];
  /** Exact values, compared case-insensitively. An empty string selects the blank ones. */
  industry: string[];
  country: string[];
  city: string[];
  /** Account ids as strings, or UNASSIGNED. */
  assignee: string[];
  lead_status: LeadStatusValue[];
  email_status: EmailStatusValue[];
  research: ResearchStatus[];
  added: DateAdded | '';
  /** YYYY-MM-DD, inclusive, in the viewer's time zone. Used when added is CUSTOM. */
  added_from: string;
  added_to: string;
  sort: LeadSort;
}
export const emptyFacets: LeadFacets = {
  qualification: [],
  score: [],
  call: [],
  industry: [],
  country: [],
  city: [],
  assignee: [],
  lead_status: [],
  email_status: [],
  research: [],
  added: '',
  added_from: '',
  added_to: '',
  sort: 'updated',
};
export const listFacets = [
  'qualification',
  'score',
  'call',
  'industry',
  'country',
  'city',
  'assignee',
  'lead_status',
  'email_status',
  'research',
] as const;
export type ListFacet = (typeof listFacets)[number];

/** How many filters are active, the sort order not counted. */
export function activeFacetCount(facets: LeadFacets) {
  return listFacets.reduce((total, key) => total + facets[key].length, 0) + (facets.added ? 1 : 0);
}

/**
 * Query-string pairs for the list and the export. Repeated keys carry the multi-select values.
 * `offsetMinutes` is the viewer's offset east of UTC, so "today" means the viewer's today.
 */
export function facetParams(
  facets: LeadFacets,
  offsetMinutes = -new Date().getTimezoneOffset(),
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const key of listFacets) for (const value of facets[key]) pairs.push([key, value]);
  // A custom range with no date picked yet does not filter anything yet.
  const pending = facets.added === 'CUSTOM' && !facets.added_from && !facets.added_to;
  if (facets.added && !pending) {
    pairs.push(['added', facets.added]);
    if (facets.added === 'CUSTOM') {
      if (facets.added_from) pairs.push(['added_from', facets.added_from]);
      if (facets.added_to) pairs.push(['added_to', facets.added_to]);
    }
    pairs.push(['tz', String(offsetMinutes)]);
  }
  if (facets.sort !== emptyFacets.sort) pairs.push(['sort', facets.sort]);
  return pairs;
}

/** Project-wide counts for the row above the table. Totals of the default "All leads" view. */
export interface LeadSummary {
  total: number;
  raw: number;
  qualified: number;
  needs_review: number;
  not_qualified: number;
  requalify: number;
}

/** Values offered by the Industry, Location and Assigned-to facets, with how many leads hold each. */
export interface LeadFacetOptions {
  industry: Array<{ value: string; count: number }>;
  country: Array<{ value: string; count: number }>;
  city: Array<{ value: string; count: number }>;
  assignee: Array<{ value: string; label: string; count: number }>;
}

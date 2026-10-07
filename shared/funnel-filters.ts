/**
 * The Email funnels list's search, filters and sort orders. A project has a handful of funnels,
 * not thousands of leads, so the list is narrowed in the browser over what the server already
 * sent; every count it filters or sorts by (sent, opened, replied, bounced and the rates) is
 * computed on the server (FunnelCounts).
 *
 * The filters map onto what a funnel actually records: its status (and whether it has run its
 * course), its type (one email, or a sequence with follow-ups), the audience it was written
 * for, the campaign it belongs to — the fit-score band the composer files it under (the
 * high-quality campaign for fit 80–100, the email campaign for 50–79, or any score) — when it
 * was created, and how it performed.
 */
import { emptyCounts, fitBandLabels, funnelCompleted, type FitBand, type Funnel } from './funnels';

/**
 * Status as the list shows it. Completed is not a stored status but a funnel that has run its
 * course (funnelCompleted): started, with leads, and nobody left waiting for a message. A
 * finished funnel that is still Active matches both: the filter picks what the row's badges say.
 */
export const funnelStatusFilters = ['ACTIVE', 'DRAFT', 'PAUSED', 'COMPLETED'] as const;
export type FunnelStatusFilter = (typeof funnelStatusFilters)[number];
export const funnelStatusLabels: Record<FunnelStatusFilter, string> = {
  ACTIVE: 'Active',
  DRAFT: 'Draft',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
};
/** What Completed means, where the filter offers it. */
export const funnelCompletedHint =
  'Completed: started, with leads, and nobody left waiting for a message.';

/** The funnel's type: a single email, or a sequence with one or two follow-ups. */
export const funnelTypes = ['SINGLE', 'SEQUENCE'] as const;
export type FunnelType = (typeof funnelTypes)[number];
export const funnelTypeLabels: Record<FunnelType, string> = {
  SINGLE: 'Single email',
  SEQUENCE: 'Sequence with follow-ups',
};
export const funnelTypeOf = (funnel: Pick<Funnel, 'steps'>): FunnelType =>
  funnel.steps.length > 1 ? 'SEQUENCE' : 'SINGLE';

/** The campaign a funnel belongs to: the fit-score band the composer files it under. */
export const funnelCampaigns: FitBand[] = ['HIGH', 'EMAIL', 'ANY'];
export const funnelCampaignLabels: Record<FitBand, string> = {
  HIGH: 'High-quality campaign (fit 80–100)',
  EMAIL: 'Email campaign (fit 50–79)',
  ANY: 'Any fit score',
};

/** Where a rate counts as strong: replies are rarer than opens. */
export const strongReplyRate = 0.1;
export const strongOpenRate = 0.3;
export const funnelPerformanceFilters = [
  'REPLY_RATE_HIGH',
  'OPEN_RATE_HIGH',
  'REPLIES',
  'NO_REPLIES',
  'OPENS',
  'BOUNCES',
  'NOT_SENT',
] as const;
export type FunnelPerformance = (typeof funnelPerformanceFilters)[number];
export const funnelPerformanceLabels: Record<FunnelPerformance, string> = {
  REPLY_RATE_HIGH: 'Reply rate ' + strongReplyRate * 100 + '% or more',
  OPEN_RATE_HIGH: 'Open rate ' + strongOpenRate * 100 + '% or more',
  REPLIES: 'Has replies',
  NO_REPLIES: 'Sent, no replies yet',
  OPENS: 'Has opens',
  BOUNCES: 'Has bounces',
  NOT_SENT: 'No messages sent yet',
};

export const funnelSorts = [
  { value: 'NEWEST', label: 'Newest' },
  { value: 'OLDEST', label: 'Oldest' },
  { value: 'UPDATED', label: 'Recently updated' },
  { value: 'REPLY_RATE', label: 'Highest reply rate' },
  { value: 'OPEN_RATE', label: 'Highest open rate' },
  { value: 'ENROLLED', label: 'Most enrolled' },
] as const;
export type FunnelSort = (typeof funnelSorts)[number]['value'];

export interface FunnelFilters {
  search: string;
  status: FunnelStatusFilter | '';
  type: FunnelType | '';
  campaign: FitBand | '';
  /** One audience exactly as written; '' picks the funnels without one, null is any. */
  audience: string | null;
  /** Created on or after / on or before, as local calendar days (YYYY-MM-DD). */
  created_from: string;
  created_to: string;
  performance: FunnelPerformance | '';
  sort: FunnelSort;
}
export const emptyFunnelFilters: FunnelFilters = {
  search: '',
  status: '',
  type: '',
  campaign: '',
  audience: null,
  created_from: '',
  created_to: '',
  performance: '',
  sort: 'NEWEST',
};

/** The filters in use, for the count on the Filters button. Search and sort are not counted. */
export function activeFunnelFilterCount(filters: FunnelFilters) {
  return (
    Number(Boolean(filters.status)) +
    Number(Boolean(filters.type)) +
    Number(Boolean(filters.campaign)) +
    Number(filters.audience !== null) +
    Number(Boolean(filters.created_from || filters.created_to)) +
    Number(Boolean(filters.performance))
  );
}

/** The distinct audiences, as written, for the Audience filter; '' when a funnel has none. */
export function funnelAudiences(funnels: Array<Pick<Funnel, 'audience'>>) {
  return [...new Set(funnels.map((funnel) => funnel.audience.trim()))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** The local calendar day of a stored timestamp, comparable with a date input's value. */
export function localDay(iso: string) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return (
    at.getFullYear() +
    '-' +
    String(at.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(at.getDate()).padStart(2, '0')
  );
}

function matches(funnel: Funnel, filters: FunnelFilters) {
  const counts = funnel.counts || emptyCounts;
  // Every word must appear somewhere: "uae intro" finds "UAE engineering introduction", and
  // "high-quality" finds the funnels of that campaign.
  const words = filters.search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const haystack = [
      funnel.name,
      funnel.audience,
      fitBandLabels[funnel.fit_band || 'ANY'],
      ...funnel.steps.map((step) => step.subject),
    ]
      .join('\n')
      .toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  if (filters.status === 'COMPLETED') {
    if (!funnelCompleted(funnel)) return false;
  } else if (filters.status && funnel.status !== filters.status) return false;
  if (filters.type && funnelTypeOf(funnel) !== filters.type) return false;
  if (filters.campaign && (funnel.fit_band || 'ANY') !== filters.campaign) return false;
  if (filters.audience !== null && funnel.audience.trim() !== filters.audience) return false;
  // A range picked back to front is read the right way round rather than matching nothing.
  const [from, to] =
    filters.created_from && filters.created_to && filters.created_from > filters.created_to
      ? [filters.created_to, filters.created_from]
      : [filters.created_from, filters.created_to];
  const created = localDay(funnel.created_at);
  if (from && created < from) return false;
  if (to && created > to) return false;
  switch (filters.performance) {
    case 'REPLY_RATE_HIGH':
      return (counts.reply_rate ?? -1) >= strongReplyRate;
    case 'OPEN_RATE_HIGH':
      return (counts.open_rate ?? -1) >= strongOpenRate;
    case 'NO_REPLIES':
      return counts.sent > 0 && counts.replied === 0;
    case 'REPLIES':
      return counts.replied > 0;
    case 'OPENS':
      return counts.opened > 0;
    case 'BOUNCES':
      return counts.bounced > 0;
    case 'NOT_SENT':
      return counts.sent === 0;
  }
  return true;
}

/** Highest first; a funnel with nothing sent has no rate and goes last. */
const byRate = (a: number | null, b: number | null) => (b ?? -1) - (a ?? -1);
const newest = (a: Funnel, b: Funnel) => b.created_at.localeCompare(a.created_at) || b.id - a.id;
const comparators: Record<FunnelSort, (a: Funnel, b: Funnel) => number> = {
  NEWEST: newest,
  OLDEST: (a, b) => -newest(a, b),
  UPDATED: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || newest(a, b),
  REPLY_RATE: (a, b) =>
    byRate((a.counts || emptyCounts).reply_rate, (b.counts || emptyCounts).reply_rate) ||
    (b.counts?.replied || 0) - (a.counts?.replied || 0) ||
    newest(a, b),
  OPEN_RATE: (a, b) =>
    byRate((a.counts || emptyCounts).open_rate, (b.counts || emptyCounts).open_rate) ||
    (b.counts?.opened || 0) - (a.counts?.opened || 0) ||
    newest(a, b),
  ENROLLED: (a, b) => (b.counts?.enrolled || 0) - (a.counts?.enrolled || 0) || newest(a, b),
};

/** The funnels that pass every filter, in the chosen order. */
export function filterFunnels(funnels: Funnel[], filters: FunnelFilters) {
  return funnels
    .filter((funnel) => matches(funnel, filters))
    .sort(comparators[filters.sort] || newest);
}

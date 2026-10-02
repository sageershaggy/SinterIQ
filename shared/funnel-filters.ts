/**
 * The Email funnels list's search, filters and sort orders. A project has a handful of funnels,
 * not thousands of leads, so the list is narrowed in the browser over what the server already
 * sent; every count it filters or sorts by (sent, opened, replied, bounced and the rates) is
 * computed on the server (FunnelCounts). A funnel is the campaign here, so searching its name
 * is how a campaign is found.
 */
import { emptyCounts, funnelCompleted, type FitBand, type Funnel } from './funnels';

/**
 * Status as the list shows it. Completed is not a stored status but a funnel that has run its
 * course (funnelCompleted), so a finished funnel that is still Active matches both: the filter
 * picks what the badges on the row say.
 */
export const funnelStatusFilters = ['ACTIVE', 'DRAFT', 'PAUSED', 'COMPLETED'] as const;
export type FunnelStatusFilter = (typeof funnelStatusFilters)[number];
export const funnelStatusLabels: Record<FunnelStatusFilter, string> = {
  ACTIVE: 'Active',
  DRAFT: 'Draft',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
};

/** The funnel's type is the fit-score band it was made for. */
export const funnelTypes: FitBand[] = ['HIGH', 'EMAIL', 'ANY'];
export const funnelTypeLabels: Record<FitBand, string> = {
  HIGH: 'High-quality (fit 80–100)',
  EMAIL: 'Email (fit 50–79)',
  ANY: 'Any fit score',
};

export const funnelPerformanceFilters = ['REPLIES', 'OPENS', 'BOUNCES', 'NOT_SENT'] as const;
export type FunnelPerformance = (typeof funnelPerformanceFilters)[number];
export const funnelPerformanceLabels: Record<FunnelPerformance, string> = {
  REPLIES: 'Has replies',
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
  type: FitBand | '';
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
  // Every word must appear somewhere: "uae intro" finds "UAE engineering introduction".
  const words = filters.search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const haystack = [funnel.name, funnel.audience, ...funnel.steps.map((step) => step.subject)]
      .join('\n')
      .toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  if (filters.status === 'COMPLETED') {
    if (!funnelCompleted(funnel)) return false;
  } else if (filters.status && funnel.status !== filters.status) return false;
  if (filters.type && (funnel.fit_band || 'ANY') !== filters.type) return false;
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

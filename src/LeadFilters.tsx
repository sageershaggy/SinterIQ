import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleDashed,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
  XCircle,
  BookOpen,
} from 'lucide-react';
import {
  ASSIGNED_TO_ANYONE,
  ASSIGNED_TO_ME,
  UNASSIGNED,
  activeFacetCount,
  callStatusHints,
  callStatusLabels,
  callStatuses,
  dateAddedLabels,
  dateAddedPresets,
  emailStatusLabels,
  emailStatuses,
  emptyFacets,
  fitScoreBands,
  leadSorts,
  leadStatusLabels,
  leadStatuses,
  listFacets,
  nextStepFilters,
  nextStepHints,
  nextStepLabels,
  qualificationHints,
  qualificationLabels,
  qualificationStates,
  researchStatusHints,
  researchStatusLabels,
  researchStatuses,
  type LeadFacetOptions,
  type LeadFacets,
  type LeadSummary,
  type ListFacet,
  type QualificationState,
} from '../shared/lead-filters';
import type { Lead } from '../shared/types';
import { api, date, label } from './api';
import { Badge } from './ui';
import './LeadFilters.css';

/**
 * The lead list's filter bar, its active-filter chips, the counts row above the table, the
 * pager and the merged fit-score/qualification cell. Filtering and sorting happen on the server
 * (server/lead-filters.ts); this file only holds the state and says it back to the person.
 */

const noOptions: LeadFacetOptions = { industry: [], country: [], city: [], assignee: [] };

/** Values for the Industry, Location and Assigned-to facets. Refetched when the list reloads. */
export function useLeadFacetOptions(base: string, version: number) {
  const [options, setOptions] = useState<LeadFacetOptions>(noOptions);
  useEffect(() => {
    let cancelled = false;
    api<LeadFacetOptions>(base + '/lead-facets')
      .then((data) => {
        if (!cancelled) setOptions(data);
      })
      // The bar still works without them: the fixed facets need no options.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [base, version]);
  return options;
}

type Option = { value: string; label: string; hint?: string; count?: number };
const blankLabel = 'Not set';
const assigneeWords: Option[] = [
  { value: ASSIGNED_TO_ME, label: 'Me', hint: 'Leads assigned to you for calling' },
  { value: ASSIGNED_TO_ANYONE, label: 'Anyone (assigned)', hint: 'Assigned to any person' },
];
const fixed = {
  qualification: qualificationStates.map((value) => ({
    value,
    label: qualificationLabels[value],
    hint: qualificationHints[value],
  })),
  score: fitScoreBands.map((band) => ({ value: band.value, label: band.label })),
  next_step: nextStepFilters.map((value) => ({
    value,
    label: nextStepLabels[value],
    hint: nextStepHints[value],
  })),
  call: callStatuses.map((value) => ({
    value,
    label: callStatusLabels[value],
    hint: callStatusHints[value],
  })),
  lead_status: leadStatuses.map((value) => ({ value, label: leadStatusLabels[value] })),
  email_status: emailStatuses.map((value) => ({ value, label: emailStatusLabels[value] })),
  research: researchStatuses.map((value) => ({
    value,
    label: researchStatusLabels[value],
    hint: researchStatusHints[value],
  })),
};
const facetTitles: Record<ListFacet, string> = {
  qualification: 'AI qualification',
  score: 'Fit score',
  next_step: 'Next step',
  call: 'Call status',
  industry: 'Industry',
  country: 'Country',
  city: 'City',
  assignee: 'Assigned to',
  lead_status: 'Lead status',
  email_status: 'Email status',
  research: 'Research status',
};
function valueLabel(facet: ListFacet, value: string, options: LeadFacetOptions) {
  if (facet === 'assignee')
    return (
      assigneeWords.find((option) => option.value === value)?.label ||
      options.assignee.find((option) => option.value === value)?.label ||
      (value === UNASSIGNED ? 'Unassigned' : 'Account #' + value)
    );
  if (facet === 'industry' || facet === 'country' || facet === 'city') return value || blankLabel;
  return (fixed[facet] as Option[]).find((option) => option.value === value)?.label || label(value);
}
function toggle<T extends string>(list: T[], value: T) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}
const shortDate = (value: string) => date(value + 'T12:00:00');
function addedLabel(facets: LeadFacets) {
  if (facets.added !== 'CUSTOM') return facets.added ? dateAddedLabels[facets.added] : '';
  if (facets.added_from && facets.added_to)
    return shortDate(facets.added_from) + ' – ' + shortDate(facets.added_to);
  if (facets.added_from) return 'from ' + shortDate(facets.added_from);
  if (facets.added_to) return 'until ' + shortDate(facets.added_to);
  return 'Custom range (pick a date)';
}

/** The Filters button in the toolbar. The bar it opens sits under the toolbar. */
export function LeadFiltersButton({
  open,
  count,
  controls,
  onToggle,
}: {
  open: boolean;
  /** Active filters, the sort order not counted. */
  count: number;
  /** The bar's element id. */
  controls: string;
  onToggle: () => void;
}) {
  return (
    <div className="lead-filters">
      <button
        type="button"
        className={'lead-filters-button' + (count ? ' is-active' : '')}
        aria-expanded={open}
        aria-controls={open ? controls : undefined}
        onClick={onToggle}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
        Filters
        {count > 0 && (
          <span className="lead-filters-count" aria-label={count + ' active'}>
            {count}
          </span>
        )}
        <ChevronDown
          size={15}
          aria-hidden="true"
          className={'filter-caret' + (open ? ' is-open' : '')}
        />
      </button>
    </div>
  );
}

/** "No filter" in a select; distinct from '', which picks the blank values. */
const ANY = '*';
/** Shown when a facet already holds several values (the server accepts several). */
const SEVERAL = '**';

/**
 * The compact filter bar: one labelled select per facet, three to a row, applied together.
 * It edits a draft; nothing reaches the list until Apply (or Clear all, which resets and
 * applies). One value per facet is offered here, though the server still accepts several.
 */
export function LeadFilterBar({
  id,
  facets,
  options,
  view,
  views,
  onApply,
  onClose,
}: {
  id: string;
  facets: LeadFacets;
  options: LeadFacetOptions;
  /** The Review queue chooses between its queue and every lead; the lead list has no views. */
  view?: string;
  views?: Array<{ value: string; label: string }>;
  onApply: (facets: LeadFacets, view: string | undefined) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(facets),
    [draftView, setDraftView] = useState(view);
  const first = useRef<HTMLSelectElement>(null);
  // A chip removed or a count tile clicked while the bar is open changes what is applied.
  useEffect(() => setDraft(facets), [facets]);
  useEffect(() => setDraftView(view), [view]);
  useEffect(() => first.current?.focus({ preventScroll: true }), []);
  const backToButton = () =>
    document.querySelector<HTMLElement>('[aria-controls="' + CSS.escape(id) + '"]')?.focus();
  const close = () => {
    onClose();
    backToButton();
  };
  function apply(event?: FormEvent) {
    event?.preventDefault();
    let next = draft;
    if (next.added !== 'CUSTOM') next = { ...next, added_from: '', added_to: '' };
    else if (!next.added_from && !next.added_to) next = { ...next, added: '' };
    else if (next.added_from && next.added_to && next.added_from > next.added_to)
      next = { ...next, added_from: next.added_to, added_to: next.added_from };
    onApply(next, draftView);
    close();
  }
  function clearAll() {
    setDraft(emptyFacets);
    setDraftView(views?.[0]?.value);
    onApply(emptyFacets, views?.[0]?.value);
  }
  const set = (patch: Partial<LeadFacets>) => setDraft((current) => ({ ...current, ...patch }));
  const dynamic = (facet: 'industry' | 'country' | 'city'): Option[] =>
    options[facet].map((option) => ({
      value: option.value,
      label: option.value || blankLabel,
      count: option.count,
    }));
  const people: Option[] = [
    ...assigneeWords,
    ...(options.assignee.some((option) => option.value === UNASSIGNED)
      ? []
      : [{ value: UNASSIGNED, label: 'Unassigned' }]),
    ...options.assignee,
  ];
  /** A label beside its control; the label names the control and nothing else. */
  const field = (key: string, title: string, control: (fieldId: string) => ReactNode) => (
    <div className="lead-filter-field" key={key}>
      <label htmlFor={id + '-' + key}>{title}</label>
      {control(id + '-' + key)}
    </div>
  );
  const select = (facet: ListFacet, anyLabel: string, choices: Option[]) => {
    const values = draft[facet] as string[];
    // A value no lead holds any more must still show as chosen, and stay removable.
    const missing: Option[] = values
      .filter((value) => !choices.some((choice) => choice.value === value))
      .map((value) => ({ value, label: valueLabel(facet, value, options) }));
    return field(facet, facetTitles[facet], (fieldId) => (
      <select
        id={fieldId}
        ref={facet === 'qualification' && !views ? first : undefined}
        value={values.length > 1 ? SEVERAL : (values[0] ?? ANY)}
        onChange={(event) => {
          const value = event.target.value;
          if (value !== SEVERAL) set({ [facet]: value === ANY ? [] : [value] });
        }}
      >
        <option value={ANY}>{anyLabel}</option>
        {values.length > 1 && (
          <option value={SEVERAL} disabled>
            {values.length} selected
          </option>
        )}
        {[...missing, ...choices].map((choice) => (
          <option key={choice.value || 'blank'} value={choice.value} title={choice.hint}>
            {choice.label}
            {choice.count !== undefined ? ' (' + choice.count.toLocaleString() + ')' : ''}
          </option>
        ))}
      </select>
    ));
  };
  return (
    <form
      className="lead-filter-bar"
      id={id}
      role="group"
      aria-label="Filter and sort leads"
      // A range picked back to front is swapped on Apply rather than refused.
      noValidate
      onSubmit={apply}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        close();
      }}
    >
      <div className="lead-filter-grid">
        {views &&
          field('view', 'Show', (fieldId) => (
            <select
              id={fieldId}
              ref={first}
              value={draftView}
              onChange={(event) => setDraftView(event.target.value)}
            >
              {views.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ))}
        {select('qualification', 'All', fixed.qualification)}
        {select('score', 'Any score', fixed.score)}
        {select('next_step', 'Any step', fixed.next_step)}
        {select('lead_status', 'All statuses', fixed.lead_status)}
        {select('email_status', 'All statuses', fixed.email_status)}
        {select('call', 'All call statuses', fixed.call)}
        {select('assignee', 'All', people)}
        {select('research', 'All', fixed.research)}
        {select('industry', 'All industries', dynamic('industry'))}
        {select('country', 'All countries', dynamic('country'))}
        {select('city', 'All cities', dynamic('city'))}
        {field('sort', 'Sort by', (fieldId) => (
          <select
            id={fieldId}
            value={draft.sort}
            onChange={(event) => set({ sort: event.target.value as LeadFacets['sort'] })}
          >
            {leadSorts.map((sort) => (
              <option key={sort.value} value={sort.value}>
                {sort.label}
              </option>
            ))}
          </select>
        ))}
        {field('added', 'Added', (fieldId) => (
          <select
            id={fieldId}
            value={draft.added || ANY}
            onChange={(event) => {
              const value = event.target.value as LeadFacets['added'] | typeof ANY;
              if (value === ANY) set({ added: '', added_from: '', added_to: '' });
              else if (value === 'CUSTOM') set({ added: 'CUSTOM' });
              else set({ added: value, added_from: '', added_to: '' });
            }}
          >
            <option value={ANY}>Any time</option>
            {dateAddedPresets.map((value) => (
              <option key={value} value={value}>
                {dateAddedLabels[value]}
              </option>
            ))}
          </select>
        ))}
        {field('added-from', 'Added from', (fieldId) => (
          <input
            id={fieldId}
            type="date"
            value={draft.added_from}
            max={draft.added_to || undefined}
            onChange={(event) => set({ added: 'CUSTOM', added_from: event.target.value })}
          />
        ))}
        {field('added-to', 'Added to', (fieldId) => (
          <input
            id={fieldId}
            type="date"
            value={draft.added_to}
            min={draft.added_from || undefined}
            onChange={(event) => set({ added: 'CUSTOM', added_to: event.target.value })}
          />
        ))}
      </div>
      <footer>
        <button type="button" className="button secondary small" onClick={clearAll}>
          Clear all
        </button>
        <button type="submit" className="button primary small">
          Apply
        </button>
      </footer>
    </form>
  );
}

export type Chip = { key: string; label: string; onRemove: () => void };
/** What the list is filtered by, each removable, with one way to drop the lot. */
export function LeadFilterChips({
  facets,
  options,
  onChange,
  extra,
  onClearAll,
}: {
  facets: LeadFacets;
  options: LeadFacetOptions;
  onChange: (facets: LeadFacets) => void;
  /** Filters the list page owns: the Review queue's view and the search term. */
  extra: Chip[];
  onClearAll: () => void;
}) {
  const chips: Chip[] = [...extra];
  for (const facet of listFacets)
    for (const value of facets[facet] as string[])
      chips.push({
        key: facet + ':' + value,
        label: facetTitles[facet] + ': ' + valueLabel(facet, value, options),
        onRemove: () => onChange({ ...facets, [facet]: toggle(facets[facet] as string[], value) }),
      });
  if (facets.added)
    chips.push({
      key: 'added',
      label: 'Added: ' + addedLabel(facets),
      onRemove: () => onChange({ ...facets, added: '', added_from: '', added_to: '' }),
    });
  if (facets.sort !== emptyFacets.sort)
    chips.push({
      key: 'sort',
      label:
        'Sort: ' + (leadSorts.find((sort) => sort.value === facets.sort)?.label || facets.sort),
      onRemove: () => onChange({ ...facets, sort: emptyFacets.sort }),
    });
  if (!chips.length) return null;
  return (
    <div className="lead-chips" role="group" aria-label="Active filters">
      {chips.map((chip) => (
        <span className="lead-chip" key={chip.key}>
          {chip.label}
          <button type="button" aria-label={'Remove ' + chip.label} onClick={chip.onRemove}>
            <X size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="text-button" onClick={onClearAll}>
        Clear all
      </button>
    </div>
  );
}

/**
 * The counts above the table: the whole project, whatever the list is filtered by. Each one is
 * also the quickest way to that set of leads.
 */
export function LeadCounts({
  summary,
  active,
  onPick,
  trainingVersion,
}: {
  summary: LeadSummary | null;
  /** 'total' when the list is unfiltered, a state when only that qualification is applied. */
  active: 'total' | QualificationState | null;
  onPick: (state: QualificationState | null) => void;
  trainingVersion: number | null;
}) {
  const value = (n: number | undefined) => (summary ? (n ?? 0).toLocaleString() : '–');
  const tiles: Array<{
    key: 'total' | QualificationState;
    label: string;
    detail: string;
    count: number | undefined;
    icon: ReactNode;
  }> = [
    {
      key: 'total',
      label: 'Total leads',
      detail: 'Everything in this project',
      count: summary?.total,
      icon: <Users size={16} />,
    },
    {
      key: 'RAW',
      label: 'Not reviewed',
      detail: 'No AI research run yet',
      count: summary?.raw,
      icon: <CircleDashed size={16} />,
    },
    {
      key: 'QUALIFIED',
      label: 'Qualified',
      detail: 'On the current training',
      count: summary?.qualified,
      icon: <CheckCircle2 size={16} />,
    },
    {
      key: 'NOT_QUALIFIED',
      label: 'Disqualified',
      detail: 'Not a target',
      count: summary?.not_qualified,
      icon: <XCircle size={16} />,
    },
  ];
  const others: Array<{ key: QualificationState; count: number; text: string }> = summary
    ? ([
        { key: 'NEEDS_REVIEW', count: summary.needs_review, text: 'need review' },
        { key: 'REQUALIFY', count: summary.requalify, text: 'need requalification' },
      ].filter((item) => item.count > 0) as Array<{
        key: QualificationState;
        count: number;
        text: string;
      }>)
    : [];
  return (
    <div className="lead-counts-row">
      <div className="lead-counts" role="group" aria-label="Lead counts">
        {tiles.map((tile) => (
          <button
            key={tile.key}
            type="button"
            className={'lead-count lead-count-' + tile.key.toLowerCase()}
            aria-pressed={active === tile.key}
            title={
              tile.key === 'total' ? 'Show all leads' : 'Show only ' + tile.label.toLowerCase()
            }
            onClick={() => onPick(tile.key === 'total' ? null : tile.key)}
          >
            <span className="lead-count-label">
              {tile.icon}
              {tile.label}
            </span>
            <strong>{value(tile.count)}</strong>
            <small>{tile.detail}</small>
          </button>
        ))}
      </div>
      {(others.length > 0 || trainingVersion) && (
        <div className="lead-counts-meta">
          {others.map((item) => (
            <button
              key={item.key}
              type="button"
              className="text-button"
              aria-pressed={active === item.key}
              onClick={() => onPick(item.key)}
            >
              {item.count.toLocaleString()} {item.text}
            </button>
          ))}
          {trainingVersion && (
            <span className="training-version">
              <BookOpen size={14} />
              Training v{trainingVersion}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** « First  ‹ Previous  Page 2 of 41  Next ›  Last » — the words hide on a phone. */
export function Pager({
  page,
  pages,
  disabled,
  onPage,
}: {
  page: number;
  pages: number;
  disabled: boolean;
  onPage: (page: number) => void;
}) {
  const at = Math.min(page, pages);
  const step = (
    to: number,
    word: string,
    title: string,
    icon: ReactNode,
    after: boolean,
    off: boolean,
  ) => (
    <button
      type="button"
      className="lead-pager-step"
      disabled={disabled || off}
      onClick={() => onPage(to)}
      aria-label={title}
      title={title}
    >
      {!after && icon}
      <span className="lead-pager-word">{word}</span>
      {after && icon}
    </button>
  );
  return (
    <nav className="lead-pager" aria-label="Lead pages">
      {step(
        1,
        'First',
        'First page',
        <ChevronsLeft size={15} aria-hidden="true" />,
        false,
        at <= 1,
      )}
      {step(
        at - 1,
        'Previous',
        'Previous page',
        <ChevronLeft size={15} aria-hidden="true" />,
        false,
        at <= 1,
      )}
      <span className="lead-pager-where" aria-live="polite">
        Page <strong>{at.toLocaleString()}</strong> of {pages.toLocaleString()}
      </span>
      {step(
        at + 1,
        'Next',
        'Next page',
        <ChevronRight size={15} aria-hidden="true" />,
        true,
        at >= pages,
      )}
      {step(
        pages,
        'Last',
        'Last page',
        <ChevronsRight size={15} aria-hidden="true" />,
        true,
        at >= pages,
      )}
    </nav>
  );
}

/**
 * Fit score and qualification are one judgement, so they share one column. Every cell has the
 * same three lines — the score and its bar, one badge, a muted meta line — so rows line up
 * whether or not the lead has been scored.
 */
export function FitQualification({ lead }: { lead: Lead }) {
  const scored = lead.score !== null;
  const meta = [
    lead.training_version ? 'Training v' + lead.training_version : 'No AI run yet',
    lead.reviewed ? 'reviewed' : '',
    lead.outreach_status && lead.outreach_status !== 'NOT_CONTACTED'
      ? 'email ' + label(lead.outreach_status).toLowerCase()
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="fit-cell">
      <span
        className={'fit-cell-score' + (scored ? '' : ' is-empty') + (lead.stale ? ' is-stale' : '')}
        title={
          !scored ? 'No fit score yet' : lead.stale ? 'Fit score from an earlier run' : 'Fit score'
        }
      >
        {scored ? (
          <strong>
            {lead.score}
            <small>/100</small>
          </strong>
        ) : (
          <strong>
            <span aria-hidden="true">—</span>
            <span className="visually-hidden">No fit score yet</span>
          </strong>
        )}
        <span className="score-track" aria-hidden="true">
          <i style={{ width: (lead.score ?? 0) + '%' }} />
        </span>
      </span>
      <Badge value={lead.stale ? 'stale' : lead.status}>
        {lead.stale ? 'Requalification needed' : label(lead.status)}
      </Badge>
      <small className="fit-meta" title={meta}>
        {lead.reviewed && <ShieldCheck size={11} aria-hidden="true" />}
        <span>{meta}</span>
      </small>
    </div>
  );
}

/** Which count tile the current view is, if any. */
export function countView(facets: LeadFacets, plain: boolean): 'total' | QualificationState | null {
  if (!plain) return null;
  const count = activeFacetCount(facets);
  if (!count) return 'total';
  return count === 1 && facets.qualification.length === 1 ? facets.qualification[0] : null;
}

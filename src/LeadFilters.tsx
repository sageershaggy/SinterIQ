import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
 * The lead list's Filters panel, its active-filter chips, the counts row above the table, the
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
      // The panel still works without them: the fixed facets need no options.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [base, version]);
  return options;
}

type Option = { value: string; label: string; hint?: string; count?: number };
const blankLabel = 'Not set';
const fixed = {
  qualification: qualificationStates.map((value) => ({
    value,
    label: qualificationLabels[value],
    hint: qualificationHints[value],
  })),
  score: fitScoreBands.map((band) => ({ value: band.value, label: band.label })),
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
  qualification: 'Qualification',
  score: 'Fit score',
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
    return options.assignee.find((option) => option.value === value)?.label || 'Account #' + value;
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

/**
 * The Filters button and its panel. Every change applies at once; the panel only closes when
 * asked to, so several facets can be set in one go.
 */
export function LeadFilters({
  facets,
  options,
  total,
  onChange,
}: {
  facets: LeadFacets;
  options: LeadFacetOptions;
  total: number;
  onChange: (facets: LeadFacets) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const count = activeFacetCount(facets);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  function show() {
    // Open the sections already in use; with none, start at Qualification.
    const used = [
      ...(
        [
          'qualification',
          'score',
          'call',
          'industry',
          'assignee',
          'lead_status',
          'email_status',
          'research',
        ] as const
      ).filter((facet) => facets[facet].length),
      ...(facets.country.length || facets.city.length ? ['location'] : []),
      ...(facets.added ? ['added'] : []),
    ];
    setExpanded(used.length ? used : ['qualification']);
    setOpen(true);
  }
  const set = (patch: Partial<LeadFacets>) => onChange({ ...facets, ...patch });
  const list = (facet: ListFacet, choices: Option[]) => (
    <CheckList
      choices={choices}
      selected={facets[facet]}
      onToggle={(value) => set({ [facet]: toggle(facets[facet] as string[], value) })}
    />
  );
  const dynamic = (facet: 'industry' | 'country' | 'city' | 'assignee'): Option[] =>
    facet === 'assignee'
      ? options.assignee
      : options[facet].map((option) => ({
          value: option.value,
          label: option.value || blankLabel,
          count: option.count,
        }));
  const section = (id: string, title: string, selected: number, body: ReactNode) => (
    <FacetSection
      key={id}
      title={title}
      selected={selected}
      open={expanded.includes(id)}
      onToggle={() => setExpanded((ids) => toggle(ids, id))}
    >
      {body}
    </FacetSection>
  );
  return (
    <div className="lead-filters" ref={ref}>
      <button
        ref={button}
        type="button"
        className={'lead-filters-button' + (count ? ' is-active' : '')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
        Filters
        {count > 0 && (
          <span className="lead-filters-count" aria-label={count + ' active'}>
            {count}
          </span>
        )}
        <ChevronDown size={15} className={'filter-caret' + (open ? ' is-open' : '')} />
      </button>
      {open && (
        <div
          className="lead-filters-panel"
          id={panelId}
          role="dialog"
          aria-label="Filter and sort leads"
        >
          <header>
            <div>
              <strong>Filter and sort</strong>
              <small aria-live="polite">
                {total.toLocaleString()} lead{total === 1 ? '' : 's'} match
              </small>
            </div>
            {(count > 0 || facets.sort !== emptyFacets.sort) && (
              <button type="button" className="text-button" onClick={() => onChange(emptyFacets)}>
                Clear all
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Close filters"
              onClick={() => setOpen(false)}
            >
              <X size={17} />
            </button>
          </header>
          <label className="lead-sort">
            <span>Sort by</span>
            <select
              value={facets.sort}
              onChange={(event) => set({ sort: event.target.value as LeadFacets['sort'] })}
            >
              {leadSorts.map((sort) => (
                <option key={sort.value} value={sort.value}>
                  {sort.label}
                </option>
              ))}
            </select>
          </label>
          <div className="lead-facets">
            {section(
              'qualification',
              'Qualification',
              facets.qualification.length,
              list('qualification', fixed.qualification),
            )}
            {section('score', 'Fit score', facets.score.length, list('score', fixed.score))}
            {section('call', 'Call status', facets.call.length, list('call', fixed.call))}
            {section(
              'industry',
              'Industry',
              facets.industry.length,
              <SearchableList
                noun="industries"
                choices={dynamic('industry')}
                selected={facets.industry}
                onToggle={(value) => set({ industry: toggle(facets.industry, value) })}
              />,
            )}
            {section(
              'location',
              'Location',
              facets.country.length + facets.city.length,
              <div className="lead-facet-columns">
                <div>
                  <span className="lead-facet-subtitle">Country</span>
                  <SearchableList
                    noun="countries"
                    choices={dynamic('country')}
                    selected={facets.country}
                    onToggle={(value) => set({ country: toggle(facets.country, value) })}
                  />
                </div>
                <div>
                  <span className="lead-facet-subtitle">City</span>
                  <SearchableList
                    noun="cities"
                    choices={dynamic('city')}
                    selected={facets.city}
                    onToggle={(value) => set({ city: toggle(facets.city, value) })}
                  />
                </div>
              </div>,
            )}
            {section(
              'assignee',
              'Assigned to',
              facets.assignee.length,
              <SearchableList
                noun="people"
                choices={dynamic('assignee')}
                selected={facets.assignee}
                onToggle={(value) => set({ assignee: toggle(facets.assignee, value) })}
              />,
            )}
            {section(
              'lead_status',
              'Lead status',
              facets.lead_status.length,
              list('lead_status', fixed.lead_status),
            )}
            {section(
              'email_status',
              'Email status',
              facets.email_status.length,
              list('email_status', fixed.email_status),
            )}
            {section(
              'research',
              'Research status',
              facets.research.length,
              list('research', fixed.research),
            )}
            {section(
              'added',
              'Date added',
              facets.added ? 1 : 0,
              <DateAdded facets={facets} onChange={set} />,
            )}
          </div>
          <footer>
            <button type="button" className="button primary small" onClick={() => setOpen(false)}>
              Show {total.toLocaleString()} lead{total === 1 ? '' : 's'}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function FacetSection({
  title,
  selected,
  open,
  onToggle,
  children,
}: {
  title: string;
  selected: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={'lead-facet' + (open ? ' is-open' : '')}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span>{title}</span>
        {selected > 0 && <span className="lead-facet-selected">{selected} selected</span>}
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="lead-facet-body" id={id}>
          {children}
        </div>
      )}
    </section>
  );
}

function CheckList({
  choices,
  selected,
  onToggle,
}: {
  choices: Option[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="lead-checks">
      {choices.map((choice) => (
        <label key={choice.value} className="lead-check" title={choice.hint}>
          <input
            type="checkbox"
            checked={selected.includes(choice.value)}
            onChange={() => onToggle(choice.value)}
          />
          <span>
            {choice.label}
            {choice.hint && <small>{choice.hint}</small>}
          </span>
          {choice.count !== undefined && <em>{choice.count.toLocaleString()}</em>}
        </label>
      ))}
    </div>
  );
}

/** A long list of project values gets its own search box; a selected value always stays visible. */
function SearchableList({
  noun,
  choices,
  selected,
  onToggle,
}: {
  noun: string;
  choices: Option[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [term, setTerm] = useState('');
  const needle = term.trim().toLowerCase();
  const shown = needle
    ? choices.filter(
        (choice) => selected.includes(choice.value) || choice.label.toLowerCase().includes(needle),
      )
    : choices;
  // A value chosen earlier that no lead holds any more must still be removable here.
  const missing = selected
    .filter((value) => !choices.some((choice) => choice.value === value))
    .map((value) => ({ value, label: value || blankLabel, count: 0 }));
  if (!choices.length && !missing.length) return <p className="lead-facet-empty">No {noun} yet.</p>;
  return (
    <>
      {choices.length > 8 && (
        <input
          className="lead-facet-search"
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={'Find ' + noun + '…'}
          aria-label={'Find ' + noun}
        />
      )}
      <div className="lead-facet-scroll">
        <CheckList choices={[...missing, ...shown]} selected={selected} onToggle={onToggle} />
        {needle && !shown.length && <p className="lead-facet-empty">No {noun} match.</p>}
      </div>
    </>
  );
}

function DateAdded({
  facets,
  onChange,
}: {
  facets: LeadFacets;
  onChange: (patch: Partial<LeadFacets>) => void;
}) {
  const name = useId();
  return (
    <div className="lead-dates">
      <div className="lead-checks">
        {(['', ...dateAddedPresets] as const).map((value) => (
          <label key={value || 'any'} className="lead-check">
            <input
              type="radio"
              name={name}
              checked={facets.added === value}
              onChange={() => onChange({ added: value })}
            />
            <span>{value ? dateAddedLabels[value] : 'Any time'}</span>
          </label>
        ))}
      </div>
      {facets.added === 'CUSTOM' && (
        <div className="lead-date-range">
          <label>
            From
            <input
              type="date"
              value={facets.added_from}
              max={facets.added_to || undefined}
              onChange={(event) => onChange({ added_from: event.target.value })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={facets.added_to}
              min={facets.added_from || undefined}
              onChange={(event) => onChange({ added_to: event.target.value })}
            />
          </label>
        </div>
      )}
    </div>
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
  /** Filters the list page owns: the status view and the search term. */
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

/** First, previous, where you are, next, last. */
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
  const step = (to: number, title: string, icon: ReactNode, off: boolean) => (
    <button
      type="button"
      className="icon-button"
      disabled={disabled || off}
      onClick={() => onPage(to)}
      aria-label={title}
      title={title}
    >
      {icon}
    </button>
  );
  return (
    <nav className="lead-pager" aria-label="Lead pages">
      {step(1, 'First page', <ChevronsLeft size={17} />, at <= 1)}
      {step(at - 1, 'Previous page', <ChevronLeft size={17} />, at <= 1)}
      <span aria-live="polite">
        Page <strong>{at.toLocaleString()}</strong> of {pages.toLocaleString()}
      </span>
      {step(at + 1, 'Next page', <ChevronRight size={17} />, at >= pages)}
      {step(pages, 'Last page', <ChevronsRight size={17} />, at >= pages)}
    </nav>
  );
}

/** Fit score and qualification are one judgement, so they share one column. */
export function FitQualification({ lead }: { lead: Lead }) {
  return (
    <div className="fit-cell">
      <div className="fit-line">
        {lead.score === null ? (
          <span className="fit-none" title="No fit score yet">
            —
          </span>
        ) : (
          <span
            className={'fit-score' + (lead.stale ? ' is-stale' : '')}
            title={lead.stale ? 'Fit score from an earlier run' : 'Fit score'}
          >
            <strong>
              {lead.score}
              <small>/100</small>
            </strong>
            <span className="score-track">
              <i style={{ width: lead.score + '%' }} />
            </span>
          </span>
        )}
        <Badge value={lead.stale ? 'stale' : lead.status}>
          {lead.stale ? 'Requalification needed' : label(lead.status)}
        </Badge>
      </div>
      <small className="table-subtext">
        {lead.reviewed && (
          <>
            <ShieldCheck size={12} /> Human reviewed ·{' '}
          </>
        )}
        {lead.training_version ? 'Training v' + lead.training_version : 'No run'}
        {lead.outreach_status && lead.outreach_status !== 'NOT_CONTACTED' && (
          <> · Outreach: {label(lead.outreach_status)}</>
        )}
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

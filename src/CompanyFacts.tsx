import type { ReactNode } from 'react';
import { BadgeCheck } from 'lucide-react';
import type { Lead } from '../shared/types';
import type { FieldCitation } from '../shared/research';
import {
  fieldProvenance,
  type FieldChange,
  type FieldProvenance,
  type TrackedField,
} from '../shared/field-history';
import { date } from './api';
import { ExternalLink } from './ui';
import './CompanyFacts.css';

const fieldWords: Record<TrackedField, string> = {
  website: 'website',
  country: 'country',
  city: 'city',
  industry: 'industry',
  employee_count: 'company size',
};
const valueOf = (lead: Lead, field: TrackedField) => String(lead[field] ?? '').trim();
const capitalize = (text: string) => text.replace(/^./, (c) => c.toUpperCase());

/** Where an unresearched value came from, in a few words. */
function originLabel(provenance: FieldProvenance) {
  const change = provenance.change;
  if (provenance.origin === 'import') return 'Imported';
  if (provenance.origin === 'person' && change)
    return (change.previous_value ? 'Edited by ' : 'Entered by ') + change.changed_by;
  return 'In the lead record';
}

/**
 * One company detail on the Company card.
 *
 * The current value comes first and stands alone. A value research read on the company's own
 * website carries "Verified by research", and the sentence it came from sits under a separate
 * "Source evidence" disclosure with its page: evidence is never mixed into the value. When
 * research replaced an imported value, that value is kept (lead_field_history) and shown only
 * inside "Original imported value", never beside the current one. A row that shows two fields
 * (Location is city and country) is verified when every part of it is.
 */
export function CompanyFact({
  lead,
  fields,
  citations,
  history,
  empty,
  children,
  conflicts,
}: {
  lead: Lead;
  fields: TrackedField[];
  /** The research citations behind the values the record holds now. */
  citations: FieldCitation[];
  /** The lead's recorded changes (ResearchProfile.history). */
  history: FieldChange[];
  empty: string;
  /** The current value, as the row displays it. */
  children: ReactNode;
  /** A conflict the website raised over a value a person typed, with "Use website value". */
  conflicts?: ReactNode;
}) {
  const present = fields.filter((field) => valueOf(lead, field));
  if (!present.length)
    return (
      <dd>
        <span className="fact-missing">{empty}</span>
      </dd>
    );
  const cited = citations.filter((item) => present.includes(item.field as TrackedField));
  const verified = present.filter((field) => cited.some((item) => item.field === field));
  const provenance = new Map(
    fields.map((field) => [field, fieldProvenance(history, field, valueOf(lead, field))]),
  );
  const replaced = present.filter((field) => provenance.get(field)?.original);
  // The row as it read before research: each replaced part's earlier value, a part research
  // filled from blank left out, and every other part as it is now.
  const original = fields
    .map((field) => {
      const item = provenance.get(field)!;
      if (item.original) return item.original.value;
      return cited.some((entry) => entry.field === field) ? '' : valueOf(lead, field);
    })
    .filter(Boolean)
    .join(', ');
  const imported = replaced.every((field) => provenance.get(field)?.original?.origin === 'import');
  const when = replaced
    .map((field) => provenance.get(field)?.change?.changed_at || '')
    .sort()
    .pop();
  const unverified = present.find((field) => !verified.includes(field));
  // One quote can carry two parts of a row (a city and a country in one sentence): shown once.
  const sources = cited.filter(
    (item, index) =>
      cited.findIndex(
        (other) => other.evidence === item.evidence && other.source_url === item.source_url,
      ) === index,
  );
  return (
    <dd className="company-fact">
      <span className="company-fact-value">{children}</span>
      <span className="company-fact-meta">
        {verified.length > 0 && (
          <span className="fact-verified">
            <BadgeCheck size={13} aria-hidden="true" />
            {verified.length === present.length
              ? 'Verified by research'
              : capitalize(verified.map((field) => fieldWords[field]).join(' and ')) +
                ' verified by research'}
          </span>
        )}
        {unverified && (
          <span className="fact-origin">
            {verified.length
              ? // Beside "City verified by research", say which part this is about.
                capitalize(fieldWords[unverified]) +
                ' ' +
                originLabel(provenance.get(unverified)!).replace(/^./, (c) => c.toLowerCase())
              : originLabel(provenance.get(unverified)!)}
          </span>
        )}
      </span>
      {sources.length > 0 && (
        <details className="fact-disclosure">
          <summary>Source evidence</summary>
          <div>
            {sources.map((item) => (
              <div className="fact-source" key={item.field + item.source_url}>
                {item.evidence ? (
                  <blockquote>“{item.evidence}”</blockquote>
                ) : (
                  <p>
                    Verified as the company’s own site: it answered on this domain and names the
                    company.
                  </p>
                )}
                <p>
                  Source: official website · <ExternalLink url={item.source_url} />
                </p>
              </div>
            ))}
          </div>
        </details>
      )}
      {replaced.length > 0 && original && (
        <details className="fact-disclosure fact-original">
          <summary>{imported ? 'Original imported value' : 'Previous value'}</summary>
          <div>
            <p>
              <strong>{original}</strong>
            </p>
            <p className="fact-original-note">
              Replaced by what the company’s website states
              {when ? ' on ' + date(when) : ''}. Kept in this lead’s history.
            </p>
          </div>
        </details>
      )}
      {conflicts}
    </dd>
  );
}

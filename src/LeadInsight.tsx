import { useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Search,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import type { CriterionResult, Lead, Project } from '../shared/types';
import {
  fitBandFor,
  fitBands,
  roleCategoryLabels,
  ruleOutcomeLabels,
  type LeadContact,
  type ResearchProfile,
} from '../shared/research';
import { label } from './api';
import { Badge, ExternalLink, Spinner } from './ui';
import './LeadInsight.css';

/** One sentence for a title attribute wherever a fit score appears without room for more. */
const bandRange = (band: (typeof fitBands)[number]) =>
  band.min === 0 ? 'Below ' + (band.max + 1) : band.min + '–' + band.max;
export const fitBandsText =
  'Fit score bands: ' +
  fitBands.map((band) => bandRange(band) + ' ' + band.label.toLowerCase()).join(' · ') +
  '.';

/** The owner's words for a rule outcome. An exclusion that is met is what disqualifies. */
export function ruleOutcomeLabel(outcome: CriterionResult['outcome'], kind: 'criterion' | 'exclusion') {
  if (kind === 'exclusion' && outcome === 'MATCH') return 'Meets (excluded)';
  return ruleOutcomeLabels[outcome];
}

/** What each band means, with the current one marked. */
export function FitBands({ score, inline }: { score: number | null; inline?: boolean }) {
  const current = fitBandFor(score);
  return (
    <ul className={'fit-bands' + (inline ? ' is-inline' : '')} aria-label="What the fit score means">
      {fitBands.map((band) => (
        <li
          key={band.label}
          className={current?.label === band.label ? 'is-current' : ''}
          aria-current={current?.label === band.label ? 'true' : undefined}
        >
          <strong>{bandRange(band)}</strong>
          <span>{band.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The fit score, large, with its band and the decision next to it. A result from older training
 * or an older version of the record is shown as out of date rather than as a live score.
 */
export function FitScore({ lead }: { lead: Lead }) {
  const [open, setOpen] = useState(false);
  const band = lead.stale ? null : fitBandFor(lead.score);
  const scored = lead.score !== null;
  return (
    <section className={'fit-score' + (lead.stale ? ' is-stale' : '')} aria-label="Fit score">
      <small>FIT SCORE</small>
      <div className="fit-score-value">
        {scored ? (
          <>
            <strong>{lead.score}</strong>
            <span>/100</span>
          </>
        ) : (
          <strong className="fit-score-empty">—</strong>
        )}
      </div>
      <p className="fit-score-band">
        {!scored
          ? 'Not scored yet'
          : lead.stale
            ? 'Out of date · qualify again'
            : band?.label}
      </p>
      {scored && (
        <Badge value={lead.stale ? 'stale' : lead.status}>
          {lead.stale ? 'Requalification needed' : label(lead.status)}
        </Badge>
      )}
      <button
        type="button"
        className="text-button fit-score-help"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        What does the score mean?
      </button>
      {open && (
        <div className="fit-score-legend">
          <FitBands score={lead.stale ? null : lead.score} />
          <p>
            The score is the share of the project’s positive criteria this company meets. A
            supported exclusion sets it to 0.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * The lead page header: who the company is, the three things someone does next, and the fit
 * score. The status control and anything else another screen adds goes in `children`.
 */
export function LeadHeader({
  project,
  lead,
  missing,
  ready,
  busy,
  researching,
  onEdit,
  onResearch,
  onQualify,
  onEmail,
  children,
}: {
  project: Project;
  lead: Lead | null;
  /** Blank fields a research pass would try to fill. */
  missing: number;
  ready: boolean;
  busy: boolean;
  researching: boolean;
  onEdit: () => void;
  onResearch: () => void;
  onQualify: () => void;
  onEmail: () => void;
  children?: ReactNode;
}) {
  const location = lead ? [lead.city, lead.country].filter(Boolean).join(', ') : '';
  const canResearch = !!lead && (missing > 0 || !!lead.website);
  return (
    <header className="lead-header">
      <div className="lead-header-main">
        <span className="eyebrow">COMPANY · {project.name.toUpperCase()}</span>
        <h1>{lead?.name || 'Loading company…'}</h1>
        {lead && (
          <div className="lead-header-meta">
            <ExternalLink url={lead.website} />
            <span>
              <MapPin size={13} />
              {location || 'Location unknown'}
            </span>
            <span>{lead.industry || 'Industry unknown'}</span>
            {lead.employee_count && <span>{lead.employee_count} employees</span>}
          </div>
        )}
        {lead && (
          <div className="lead-header-badges">
            {lead.score === null && (
              <Badge value={lead.status}>{label(lead.status)}</Badge>
            )}
            {lead.reviewed && <Badge value="ready">Human reviewed</Badge>}
            {/* The lead status and the calling assignment (its chip names who calls). */}
            {children}
          </div>
        )}
        <div className="lead-header-actions">
          <button
            type="button"
            className="button primary"
            onClick={onEmail}
            disabled={!lead}
            aria-label={'Create email for ' + (lead?.name || 'company')}
          >
            <Mail size={16} />
            Create email
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!lead || busy || researching}
            onClick={onQualify}
            title={
              ready
                ? 'Researches any blank details first, then checks every approved rule.'
                : 'Publish the project training before qualifying.'
            }
          >
            {busy ? (
              <Spinner text="Qualifying…" />
            ) : (
              <>
                <Sparkles size={16} />
                {!ready
                  ? 'Open training'
                  : lead?.latest_run_id
                    ? 'Run AI qualification again'
                    : 'Run AI qualification'}
              </>
            )}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!canResearch || busy || researching}
            onClick={onResearch}
            title="Reads the company’s own website and fills only what a page proves."
          >
            {researching ? (
              <Spinner text="Reading pages…" />
            ) : (
              <>
                <Search size={16} />
                Research missing details
                {missing > 0 && <span className="lead-header-count">{missing}</span>}
              </>
            )}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!lead || busy || researching}
            onClick={onEdit}
          >
            <Pencil size={15} />
            Edit
          </button>
        </div>
      </div>
      {lead && <FitScore lead={lead} />}
    </header>
  );
}

/**
 * The people the company's own website names. Each can be erased, and each shows the sentence
 * it came from; the roles the training asks for come first.
 */
export function ContactsCard({
  lead,
  profile,
  busy,
  onErase,
  onEraseAll,
}: {
  lead: Lead;
  profile: ResearchProfile | null;
  busy: boolean;
  onErase: (contact: LeadContact) => void;
  onEraseAll: () => void;
}) {
  const contacts = profile?.contacts || [];
  const sought = profile?.roles_sought;
  const soughtText = sought
    ? [
        ...sought.phrases,
        ...sought.categories
          .filter((category) => !sought.phrases.some((phrase) => phrase.includes(category.slice(0, 6))))
          .map((category) => roleCategoryLabels[category].toLowerCase()),
      ]
    : [];
  return (
    <section className="company-card contacts-card" aria-labelledby="lead-contacts-title">
      <div className="section-title">
        <div>
          <h3 id="lead-contacts-title">People at this company</h3>
          <p className="muted">
            {soughtText.length
              ? 'The training asks for: ' + soughtText.join(', ') + '.'
              : 'Found on the company’s own website, each with the sentence that names them.'}
          </p>
        </div>
        <Users size={18} />
      </div>
      {(lead.contact_name || lead.contact_email || lead.contact_phone) && (
        <div className="contact-row is-primary">
          <div className="contact-main">
            <strong>{lead.contact_name || 'Primary contact'}</strong>
            <small>{lead.contact_role || 'Role not recorded'}</small>
            <span className="contact-tag">On the record</span>
          </div>
          <div className="contact-channels">
            {lead.contact_email && (
              <a href={'mailto:' + lead.contact_email}>
                <Mail size={13} />
                {lead.contact_email}
              </a>
            )}
            {lead.contact_phone && (
              <a href={'tel:' + lead.contact_phone.replace(/[^\d+]/g, '')}>
                <Phone size={13} />
                {lead.contact_phone}
              </a>
            )}
          </div>
        </div>
      )}
      {!profile ? (
        <Spinner text="Loading people…" />
      ) : contacts.length ? (
        <ul className="contact-list">
          {contacts.map((contact) => (
            <li className="contact-row" key={contact.id}>
              <div className="contact-main">
                <strong>{contact.name}</strong>
                <small>{contact.role || 'Role not published'}</small>
                <span className={'contact-tag role-' + contact.role_category}>
                  {roleCategoryLabels[contact.role_category]}
                </span>
                {contact.relevant && (
                  <span className="contact-tag is-relevant">Matches a role the training asks for</span>
                )}
              </div>
              <div className="contact-channels">
                {contact.email && (
                  <a href={'mailto:' + contact.email}>
                    <Mail size={13} />
                    {contact.email}
                  </a>
                )}
                {contact.phone && (
                  <a href={'tel:' + contact.phone.replace(/[^\d+]/g, '')}>
                    <Phone size={13} />
                    {contact.phone}
                  </a>
                )}
              </div>
              <details className="contact-source">
                <summary>Where this came from</summary>
                <blockquote>“{contact.evidence}”</blockquote>
                <ExternalLink url={contact.source_url}>
                  {safePath(contact.source_url)}
                </ExternalLink>
              </details>
              <button
                type="button"
                className="icon-button"
                disabled={busy}
                onClick={() => onErase(contact)}
                title="Erase this person from the lead"
                aria-label={'Erase ' + contact.name + ' from this lead'}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted contacts-empty">
          {lead.website
            ? 'No one has been found on the company website yet. Research reads the contact, team and about pages.'
            : 'Research looks for people once a website is verified for this company.'}
        </p>
      )}
      {contacts.length > 1 && (
        <button type="button" className="text-button contacts-erase-all" disabled={busy} onClick={onEraseAll}>
          Erase all {contacts.length} researched contacts
        </button>
      )}
    </section>
  );
}
function safePath(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return url;
  }
}

export interface LogEvent {
  key: string;
  when: string;
  title: string;
  detail: string;
  who?: string;
  icon: ReactNode;
  onOpen?: () => void;
}
/** "12 min ago" reads faster than a date when most of the work happened today. */
function relativeTime(value: string) {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' h ago';
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return days + ' days ago';
  return new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
/** The lead's activity as one line per event, the same shape as the project overview's log. */
export function ActivityLog({ events }: { events: LogEvent[] }) {
  return (
    <div className="activity-list is-compact lead-activity">
      {events.map((event) => (
        <div className="activity-item" key={event.key}>
          <span className="activity-icon">{event.icon}</span>
          <div className="activity-text">
            <strong>
              {event.onOpen ? (
                <button type="button" className="lead-activity-open" onClick={event.onOpen}>
                  {event.title}
                  <ArrowUpRight size={12} />
                </button>
              ) : (
                event.title
              )}
            </strong>
            {event.detail && <p title={event.detail}>{event.detail}</p>}
          </div>
          <small className="activity-meta" title={new Date(event.when).toLocaleString()}>
            {event.who && <span>{event.who}</span>}
            <span>{relativeTime(event.when)}</span>
          </small>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import {
  Mail,
  MessageSquare,
  Phone,
  ScanLine,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';
import type {
  CriterionResult,
  Lead,
  ResearchOutcome,
  ResearchableField,
} from '../shared/types';
import type { FieldCitation, LeadContact, ResearchProfile } from '../shared/research';
import type { LeadTab } from './navigation';
import { api, date, label } from './api';
import { Alert, Badge, ExternalLink, Spinner } from './ui';
import { ActivityLog, ContactsCard, type LogEvent } from './LeadInsight';

/** What this record calls each field a research pass can fill. */
const researchableLabels: Record<ResearchableField, string> = {
  website: 'Website',
  industry: 'Industry',
  country: 'Country',
  city: 'City',
  employee_count: 'Company size',
  contact_name: 'Contact name',
  contact_role: 'Contact role',
  contact_email: 'Contact email',
  contact_phone: 'Contact phone',
};
/**
 * The blanks a research pass would try to fill. Deliberately the same test the server makes,
 * so the button is never offered for a field the pass would skip, nor hidden while one is open.
 */
export function missingDetails(lead: Lead): ResearchableField[] {
  return (Object.keys(researchableLabels) as ResearchableField[]).filter(
    (field) => !String(lead[field] ?? '').trim(),
  );
}
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'the website';
  }
};
/** A missing fact, shown quietly so the facts that do exist are what the eye lands on. */
const blank = (text: string) => <span className="fact-missing">{text}</span>;
export interface ResearchControls {
  missing: ResearchableField[];
  /** The last run's result, kept on screen after the lead itself is reloaded. */
  outcome: ResearchOutcome | null;
  running: boolean;
  /** Another action on this lead is in flight, so this one waits its turn. */
  busy: boolean;
  /** Whether the project's published training allows qualifying right now. */
  ready: boolean;
  onRun: () => void;
  onQualify: () => void;
}

/**
 * Where a detail came from: typed or imported into the record, or found by research on the
 * company's own website — in which case the sentence and the page are one click away.
 */
function Origin({ citations }: { citations: FieldCitation[] }) {
  if (!citations.length) return <span className="fact-origin">In the lead record</span>;
  return (
    <details className="fact-origin-details">
      <summary className="fact-origin is-research" title="Show the sentence this came from">
        Found by research
      </summary>
      <div>
        {citations.map((item) => (
          <div key={item.field}>
            {item.evidence ? (
              <blockquote>“{item.evidence}”</blockquote>
            ) : (
              <p>
                Verified as the company’s own site: it answered on this domain and names the
                company.
              </p>
            )}
            <ExternalLink url={item.source_url} />
          </div>
        ))}
      </div>
    </details>
  );
}
function Fact({
  lead,
  fields,
  citations,
  children,
  empty,
}: {
  lead: Lead;
  fields: ResearchableField[];
  citations: FieldCitation[];
  children: ReactNode;
  empty: string;
}) {
  const present = fields.some((field) => String(lead[field] ?? '').trim());
  if (!present) return <dd>{blank(empty)}</dd>;
  return (
    <dd>
      {children}
      <Origin citations={citations.filter((item) => fields.includes(item.field))} />
    </dd>
  );
}

/**
 * The gap-filling pass, reported in full. The refusals are half the point: they are how
 * someone sees that a value reached the record only because the page itself said so, and why a
 * run that changed nothing was a real answer rather than a reason to keep re-running the lead.
 */
function ResearchSection({ lead, research }: { lead: Lead; research: ResearchControls }) {
  const { missing, outcome, running, busy, ready } = research;
  const applied = outcome?.applied || [];
  const proposals = outcome?.proposals || [];
  const filled = proposals.filter((item) => applied.includes(item.field));
  // Only `applied` was written. A proposal can pass the citation check and still be turned
  // away — a website another lead in the project already holds, for one — so anything that did
  // not land is reported here as refused. Nothing unsaved may read as if it had been saved.
  const refused = [
    ...(outcome?.refused || []),
    ...proposals
      .filter(
        (item) =>
          !applied.includes(item.field) &&
          !(outcome?.refused || []).some((entry) => entry.field === item.field),
      )
      .map((item) => ({
        field: item.field,
        value: item.value,
        reason: 'It was not written to the record.',
      })),
  ];
  const notes = outcome?.notes || [];
  const found = outcome?.contacts_added || 0;
  return (
    <>
      {!!missing.length && (
        <section className="company-card">
          <div className="section-title">
            <div>
              <h3>Missing details</h3>
              <p className="muted">
                Qualification researches these on the company’s own website before it judges the
                lead. Research now to see what the website proves first.
              </p>
            </div>
            <button
              className="button secondary"
              disabled={running || busy}
              onClick={research.onRun}
            >
              {running ? (
                <Spinner text="Reading pages…" />
              ) : (
                <>
                  <Search size={16} />
                  Research now
                </>
              )}
            </button>
          </div>
          <ul className="missing-chips" aria-label="Blank fields">
            {missing.map((field) => (
              <li key={field}>{researchableLabels[field]}</li>
            ))}
          </ul>
          <p className="fine-print">
            A value is saved only if the page it came from really contains the sentence quoted
            for it; everything else is reported back instead of recorded.
            {!lead.website &&
              (lead.contact_email
                ? ' With no website on record, the domain of the contact email is checked first (never a free-mail or provider domain), then up to three candidate domains; one is kept only if its page names the company.'
                : ' With no website on record, up to three candidate domains are fetched and one is kept only if its page names the company.')}
            {running && ' Pages are fetched one at a time, so this can take a minute.'}
          </p>
        </section>
      )}
      {outcome && !running && (
        <section className="company-card">
          <div className="section-title">
            <div>
              <h3>What the last research did</h3>
              <p className="muted">
                {filled.length === 0
                  ? 'No detail was saved, so the record is unchanged.'
                  : filled.length === 1
                    ? 'One detail was saved, with the sentence it came from.'
                    : filled.length + ' details were saved, each with the sentence it came from.'}
                {found > 0 &&
                  ' ' +
                    (found === 1 ? 'One person' : found + ' people') +
                    ' added from the company website.'}
              </p>
            </div>
            {!!outcome.website && (
              <span className="muted">
                Read from: <ExternalLink url={outcome.website} />
                {outcome.discovered && !applied.includes('website') && ' · not saved'}
              </span>
            )}
          </div>
          {filled.map((item) => (
            <div className="human-review-history" key={item.field}>
              <div>
                <Badge value="match">{researchableLabels[item.field]}</Badge>
                <strong>{item.value}</strong>
                <ExternalLink url={item.source_url} />
              </div>
              {item.evidence ? (
                <p className="preserve-text">“{item.evidence}”</p>
              ) : (
                <p className="fine-print">
                  Kept because this page is on the domain that was checked and names the company.
                  This line is the check that ran, not a quotation from the page.
                </p>
              )}
            </div>
          ))}
          {!!outcome.facts?.length && (
            <div className="company-gaps">
              <strong>Sentences that bear on your qualification rules</strong>
              <ul>
                {outcome.facts.map((fact, index) => (
                  <li key={index}>
                    <em>{fact.rule}</em> — “{fact.quote}”
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!applied.length && lead.stale && (
            <div className="inline-notice">
              <Sparkles size={17} />
              <span>
                <strong>The record changed, so the earlier qualification is out of date.</strong>{' '}
                Check these values, then analyze this company again when you are happy with them.
              </span>
              <button
                className="button secondary"
                disabled={busy || running}
                onClick={research.onQualify}
              >
                {ready ? 'Run AI qualification' : 'Open training'}
              </button>
            </div>
          )}
          {!!refused.length && (
            <div className="gaps-box">
              <h3>Offered but not saved</h3>
              <ul>
                {refused.map((item, index) => (
                  <li key={item.field + index}>
                    <strong>{researchableLabels[item.field]}</strong> — “{item.value}” ·{' '}
                    {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(!!notes.length || !!outcome.tried.length) && (
            <div className="company-gaps">
              <strong>What was checked</strong>
              {!!notes.length && (
                <ul>
                  {notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              )}
              {!!outcome.tried.length && (
                <p className="fine-print">
                  Candidate domains fetched and checked: {outcome.tried.join(', ')}.
                  {outcome.discovered
                    ? ' The one whose page names this company is the website shown above.'
                    : ' None of them proved to be this company, so no website was saved.'}
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

export function CompanyOverview({
  base,
  lead,
  onTab,
  research,
  onChanged,
  notify,
}: {
  /** The lead's API path, for the research profile and contact erasure. */
  base: string;
  lead: Lead;
  onTab: (tab: LeadTab) => void;
  research: ResearchControls;
  onChanged?: () => void;
  notify?: (text: string) => void;
}) {
  const [profile, setProfile] = useState<ResearchProfile | null>(null),
    [error, setError] = useState(''),
    [erasing, setErasing] = useState(false);
  // Reloaded whenever the record or a research result changes, so provenance never lags.
  useEffect(() => {
    let cancelled = false;
    api<ResearchProfile>(base + '/research-profile')
      .then((data) => {
        if (!cancelled) {
          setProfile(data);
          setError('');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [base, lead.revision, lead.updated_at, research.outcome]);
  async function erase(path: string, message: string) {
    setErasing(true);
    setError('');
    try {
      const contacts = await api<LeadContact[]>(base + path, { method: 'DELETE' });
      setProfile((current) => (current ? { ...current, contacts } : current));
      notify?.(message);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setErasing(false);
    }
  }
  const citations = profile?.citations || [];
  const latest = lead.runs?.[0];
  const current = latest && !lead.stale ? latest : null;
  const tally = (items: CriterionResult[]) => ({
    meets: items.filter((item) => item.outcome === 'MATCH').length,
    not: items.filter((item) => item.outcome === 'NO_MATCH').length,
    unable: items.filter((item) => item.outcome === 'UNKNOWN').length,
  });
  const criteria = current ? tally(current.result.criteria) : null;
  const exclusions = current ? tally(current.result.exclusions) : null;
  const researchedFirst = latest?.result.research;
  const events: LogEvent[] = [
    ...(lead.runs || []).map((item) => ({
      key: 'run-' + item.id,
      when: item.created_at,
      title:
        'AI qualification · ' + label(item.result.decision) + ' · ' + item.result.score + '/100',
      detail: item.result.summary,
      who: item.created_by,
      icon: <ScanLine size={15} />,
      onOpen: () => onTab('reasoning'),
    })),
    ...(profile?.runs || []).map((item) => ({
      key: 'research-' + item.id,
      when: item.created_at,
      title:
        (item.origin === 'qualification' ? 'Research before qualification · ' : 'Research · ') +
        (item.applied.length
          ? 'filled ' + item.applied.map((field) => researchableLabels[field].toLowerCase()).join(', ')
          : 'nothing new confirmed') +
        (item.contacts_added
          ? ' · ' + item.contacts_added + (item.contacts_added === 1 ? ' person' : ' people') + ' found'
          : ''),
      detail: item.pages.length
        ? 'Read ' +
          item.pages.length +
          (item.pages.length === 1 ? ' page' : ' pages') +
          ' of ' +
          hostOf(item.website) +
          '.'
        : item.notes[0] || '',
      who: item.created_by,
      icon: <Search size={15} />,
    })),
    ...(lead.calls || []).map((item) => ({
      key: 'call-' + item.id,
      when: item.created_at,
      title: 'Call · ' + label(item.outcome),
      detail: item.notes,
      who: item.created_by,
      icon: <Phone size={15} />,
      onOpen: () => onTab('calls'),
    })),
    ...(lead.emails || []).map((item) => ({
      key: 'email-' + item.id,
      when: item.created_at,
      title: 'Email · ' + label(item.status),
      detail: item.subject,
      who: item.created_by,
      icon: <Mail size={15} />,
      onOpen: () => onTab('email'),
    })),
    ...(lead.outreach_events || []).map((item) => ({
      key: 'response-' + item.id,
      when: item.created_at,
      title: label(item.outcome),
      detail: item.notes,
      who: item.created_by,
      icon: <MessageSquare size={15} />,
      onOpen: () => onTab('email'),
    })),
  ]
    .sort((a, b) => b.when.localeCompare(a.when))
    .slice(0, 12);
  return (
    <div className="company-overview">
      {error && <Alert>{error}</Alert>}
      <div className="company-stats">
        <div>
          <small>RULES</small>
          {criteria && exclusions ? (
            <>
              <strong>
                {criteria.meets} of {current!.result.criteria.length} criteria met
              </strong>
              <span>
                {[
                  criteria.not && criteria.not + ' not met',
                  criteria.unable && criteria.unable + ' unable to verify',
                  exclusions.meets
                    ? exclusions.meets + (exclusions.meets === 1 ? ' exclusion' : ' exclusions') + ' met'
                    : 'no exclusion met',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </>
          ) : (
            <>
              <strong>{lead.stale ? 'Out of date' : 'Not evaluated'}</strong>
              <span>
                {lead.stale
                  ? 'The training or company details changed.'
                  : 'Every approved rule is checked when this lead is qualified.'}
              </span>
            </>
          )}
        </div>
        <div>
          <small>OUTREACH</small>
          <strong>{label(lead.outreach_status || 'NOT_CONTACTED')}</strong>
          <span>
            {lead.emails?.filter((e) => e.status === 'SENT').length || 0} emails sent ·{' '}
            {lead.calls?.length || 0} calls recorded
          </span>
        </div>
        <div>
          <small>CAMPAIGNS</small>
          <strong>
            {lead.campaigns?.filter((c) => c.status === 'QUEUED' || c.status === 'SENDING')
              .length || 0}{' '}
            in progress
          </strong>
          <button className="text-button" onClick={() => onTab('campaigns')}>
            View follow-ups
          </button>
        </div>
      </div>
      {(!!research.missing.length || !!research.outcome) && (
        <ResearchSection lead={lead} research={research} />
      )}
      <div className="company-overview-grid">
        <section className="company-card">
          <div className="section-title">
            <h3>Company</h3>
            <Users size={18} />
          </div>
          <dl className="company-facts">
            <dt>Website</dt>
            <Fact lead={lead} fields={['website']} citations={citations} empty="Not found yet">
              <ExternalLink url={lead.website} />
            </Fact>
            <dt>Industry</dt>
            <Fact lead={lead} fields={['industry']} citations={citations} empty="Not found yet">
              {lead.industry}
            </Fact>
            <dt>Location</dt>
            <Fact
              lead={lead}
              fields={['city', 'country']}
              citations={citations}
              empty="Not found yet"
            >
              {[lead.city, lead.country].filter(Boolean).join(', ')}
            </Fact>
            <dt>Company size</dt>
            <Fact
              lead={lead}
              fields={['employee_count']}
              citations={citations}
              empty="Not found yet"
            >
              {lead.employee_count}
            </Fact>
            <dt>Assigned to</dt>
            <dd>{lead.assigned_to_name || blank('Unassigned')}</dd>
          </dl>
          {lead.notes && (
            <details className="company-notes">
              <summary>Notes from the lead record</summary>
              <p>{lead.notes}</p>
            </details>
          )}
          <p className="fine-print">
            “In the lead record” was typed or imported; “Found by research” was read from the
            company’s own website and shows the sentence it came from.
          </p>
        </section>
        <section className="company-card">
          <div className="section-title">
            <h3>Research summary</h3>
            {latest && (
              <button className="text-button" onClick={() => onTab('reasoning')}>
                Rule by rule
              </button>
            )}
          </div>
          {latest ? (
            <>
              <p>{latest.result.summary}</p>
              <small className="muted">
                {lead.stale ? 'Previous result · ' : ''}Training v{latest.training_version} ·{' '}
                {date(latest.created_at)}
              </small>
              {researchedFirst && (
                <p className="research-before">
                  <Search size={14} />
                  <span>
                    {researchedFirst.ran
                      ? 'Researched before judging: ' +
                        (researchedFirst.filled.length
                          ? 'filled ' +
                            researchedFirst.filled
                              .map((field) => researchableLabels[field].toLowerCase())
                              .join(', ')
                          : 'no new detail could be confirmed') +
                        (researchedFirst.contacts_added
                          ? ', ' + researchedFirst.contacts_added + ' people found'
                          : '') +
                        '.'
                      : 'This version of the record had already been researched, so that research was used.'}
                    {!researchedFirst.website_found &&
                      ' No company website could be verified; what was checked is listed below.'}
                  </span>
                </p>
              )}
            </>
          ) : (
            // An empty card is where the next step belongs, not a sentence about it.
            <div className="summary-empty">
              <span className="summary-empty-icon">
                <Sparkles size={19} />
              </span>
              <strong>Not analyzed yet</strong>
              <p>
                AI qualification researches the blank details first, then checks every approved
                rule as meets, does not meet or unable to verify, and returns a fit score.
              </p>
              <button
                className="button primary"
                disabled={research.running || research.busy}
                onClick={research.onQualify}
              >
                <Sparkles size={15} />
                {research.ready ? 'Run AI qualification' : 'Open training'}
              </button>
            </div>
          )}
          {!!latest?.result.gaps.length && (
            <div className="company-gaps">
              <strong>Still to confirm</strong>
              <ul>
                {latest.result.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
      <ContactsCard
        lead={lead}
        profile={profile}
        busy={erasing}
        onErase={(contact) =>
          void erase('/contacts/' + contact.id, contact.name + ' was erased from this lead.')
        }
        onEraseAll={() => void erase('/contacts', 'Researched contacts erased from this lead.')}
      />
      <section className="company-card">
        <div className="section-title">
          <h3>Recent activity</h3>
          <span className="muted">Research, analysis and conversations</span>
        </div>
        {events.length ? (
          <ActivityLog events={events} />
        ) : (
          <p className="muted">
            New company added. Research, emails and responses will appear here as you work.
          </p>
        )}
      </section>
    </div>
  );
}

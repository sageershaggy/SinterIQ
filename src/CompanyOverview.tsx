import { ArrowUpRight, Mail, Phone, Search, Sparkles, Users } from 'lucide-react';
import type { Lead, ResearchOutcome, ResearchableField } from '../shared/types';
import type { LeadTab } from './navigation';
import { date, label } from './api';
import { Badge, ExternalLink, Spinner } from './ui';

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
  return (
    <>
      <section className="company-card">
        <div className="section-title">
          <div>
            <h3>Missing details</h3>
            <p className="muted">
              {missing.length
                ? 'Read this company’s own website and fill in what it can prove.'
                : 'Every detail this can research is already on the record.'}
            </p>
          </div>
          <button
            className="button primary"
            disabled={running || busy || !missing.length}
            onClick={research.onRun}
          >
            {running ? (
              <Spinner text="Reading pages…" />
            ) : (
              <>
                <Search size={16} />
                Research missing details
              </>
            )}
          </button>
        </div>
        {!!missing.length && (
          <p className="fine-print">
            Blank now: {missing.map((field) => researchableLabels[field]).join(', ')}. A value is
            saved only if the page it came from really contains the sentence quoted for it;
            everything else is reported back instead of recorded.
            {!lead.website &&
              ' This lead has no website, so up to three candidate domains are fetched and one is kept only if its page names the company. There is no web search behind this.'}
            {running && ' Pages are fetched one at a time, so this can take a minute.'}
          </p>
        )}
      </section>
      {outcome && !running && (
        <section className="company-card">
          <div className="section-title">
            <div>
              <h3>What the last run did</h3>
              <p className="muted">
                {filled.length === 0
                  ? 'Nothing was saved, so this record is unchanged.'
                  : filled.length === 1
                    ? 'One detail was saved, with the sentence it came from.'
                    : filled.length + ' details were saved, each with the sentence it came from.'}
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
              <strong>What the pass could and could not read</strong>
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
  lead,
  onTab,
  research,
}: {
  lead: Lead;
  onTab: (tab: LeadTab) => void;
  research: ResearchControls;
}) {
  const latest = lead.runs?.[0];
  const events = [
    ...(lead.runs || []).map((item) => ({
      key: 'run-' + item.id,
      when: item.created_at,
      title: 'AI qualification · ' + label(item.result.decision),
      detail: item.result.summary,
      tab: 'reasoning' as const,
    })),
    ...(lead.calls || []).map((item) => ({
      key: 'call-' + item.id,
      when: item.created_at,
      title: 'Call · ' + label(item.outcome),
      detail: item.notes,
      tab: 'calls' as const,
    })),
    ...(lead.emails || []).map((item) => ({
      key: 'email-' + item.id,
      when: item.created_at,
      title: 'Email · ' + label(item.status),
      detail: item.subject,
      tab: 'email' as const,
    })),
    ...(lead.outreach_events || []).map((item) => ({
      key: 'response-' + item.id,
      when: item.created_at,
      title: label(item.outcome),
      detail: item.notes,
      tab: 'email' as const,
    })),
  ]
    .sort((a, b) => b.when.localeCompare(a.when))
    .slice(0, 12);
  return (
    <div className="company-overview">
      <div className="company-stats">
        <div>
          <small>CURRENT FIT</small>
          <strong>
            {lead.stale
              ? 'Review needed'
              : lead.score === null
                ? 'Not researched'
                : lead.score + '/100'}
          </strong>
          <span>
            {lead.stale ? 'The training or company details changed.' : label(lead.status)}
          </span>
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
            View follow-ups <ArrowUpRight size={14} />
          </button>
        </div>
      </div>
      {(!!research.missing.length || !!research.outcome) && (
        <ResearchSection lead={lead} research={research} />
      )}
      <div className="company-overview-grid">
        <section className="company-card">
          <div className="section-title">
            <h3>Company & contact</h3>
            <Users size={18} />
          </div>
          <dl className="company-facts">
            <dt>Industry</dt>
            <dd>{lead.industry || 'Not provided'}</dd>
            <dt>Location</dt>
            <dd>{[lead.city, lead.country].filter(Boolean).join(', ') || 'Not provided'}</dd>
            <dt>Company size</dt>
            <dd>{lead.employee_count || 'Not provided'}</dd>
            <dt>Contact</dt>
            <dd>
              {lead.contact_name || 'No named contact'}
              {lead.contact_role && <small>{lead.contact_role}</small>}
            </dd>
            <dt>Email</dt>
            <dd>{lead.contact_email || 'No email captured'}</dd>
            <dt>Phone</dt>
            <dd>{lead.contact_phone || 'No phone captured'}</dd>
            <dt>Assigned to</dt>
            <dd>{lead.assigned_to_name || 'Unassigned'}</dd>
          </dl>
          <div className="company-actions">
            <button className="button secondary" onClick={() => onTab('email')}>
              <Mail size={15} />
              Create email
            </button>
            <button className="button secondary" onClick={() => onTab('calls')}>
              <Phone size={15} />
              Call history
            </button>
          </div>
        </section>
        <section className="company-card">
          <div className="section-title">
            <h3>Research summary</h3>
            <button className="text-button" onClick={() => onTab('reasoning')}>
              View evidence <ArrowUpRight size={14} />
            </button>
          </div>
          <p>
            {latest?.result.summary ||
              'Run AI qualification using the project’s published criteria to see the company’s fit and supporting evidence.'}
          </p>
          {latest && (
            <small className="muted">
              {lead.stale ? 'Previous result · ' : ''}Training v{latest.training_version} ·{' '}
              {date(latest.created_at)}
            </small>
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
      <section className="company-card">
        <div className="section-title">
          <h3>Recent activity</h3>
          <span className="muted">Research and conversations</span>
        </div>
        {!events.length && (
          <p className="muted">
            New company added. Research, emails and responses will appear here as you work.
          </p>
        )}
        <div className="company-timeline">
          {events.map((event) => (
            <button key={event.key} onClick={() => onTab(event.tab)}>
              <span className="timeline-dot" />
              <div>
                <strong>{event.title}</strong>
                <p>{event.detail}</p>
                <small>{date(event.when)}</small>
              </div>
              <ArrowUpRight size={16} />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

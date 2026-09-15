import { ArrowUpRight, Mail, Phone, Users } from 'lucide-react';
import type { Lead } from '../shared/types';
import type { LeadTab } from './navigation';
import { date, label } from './api';

export function CompanyOverview({ lead, onTab }: { lead: Lead; onTab: (tab: LeadTab) => void }) {
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

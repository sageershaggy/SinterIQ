import { CalendarClock, Mail, Phone } from 'lucide-react';
import type { CallLog, Lead } from '../shared/types';
import { callOutcomes } from '../shared/calls';
import { date } from './api';
import { CallStatusBadge, CallStatusForm, formatDay } from './CallStatus';
import './LeadCalls.css';

/**
 * A lead's Calls tab: who to call, a call-status form and the call history. Saving adds an entry
 * to the append-only call log; it never changes the qualification, the fit score or the decision.
 */
export function LeadCalls({
  projectId,
  lead,
  calls,
  onSaved,
}: {
  projectId: number;
  lead: Lead;
  calls: CallLog[];
  onSaved: () => void;
}) {
  return (
    <div className="lead-calls">
      <div className="call-contact">
        <div>
          <span className="eyebrow">WHO TO CALL</span>
          <strong>{lead.contact_name || 'No contact person recorded'}</strong>
          {lead.contact_role && <small>{lead.contact_role}</small>}
        </div>
        <div className="call-contact-channels">
          {lead.contact_phone ? (
            <a href={'tel:' + lead.contact_phone.replace(/[^+\d]/g, '')}>
              <Phone size={14} />
              {lead.contact_phone}
            </a>
          ) : (
            <span className="muted">No phone number</span>
          )}
          {lead.contact_email ? (
            <a href={'mailto:' + lead.contact_email}>
              <Mail size={14} />
              {lead.contact_email}
            </a>
          ) : (
            <span className="muted">No email address</span>
          )}
        </div>
      </div>
      <p className="lead-calls-note">
        {lead.assigned_to_name
          ? 'Assigned to ' + lead.assigned_to_name + '.'
          : 'This lead is not assigned to anyone yet.'}{' '}
        A call status is added to the history below; it never changes the qualification or the
        decision.
      </p>
      <CallStatusForm
        projectId={projectId}
        leadId={lead.id}
        options={callOutcomes}
        onSaved={() => onSaved()}
      />
      <h3 className="lead-calls-title">Call history</h3>
      {calls.length ? (
        <ol className="lead-call-history">
          {calls.map((call) => (
            <li key={call.id}>
              <div>
                <CallStatusBadge outcome={call.outcome} />
                {call.next_action_at && (
                  <span className="lead-call-next">
                    <CalendarClock size={13} />
                    {formatDay(call.next_action_at)}
                  </span>
                )}
                <small>
                  {call.created_by} · {date(call.created_at)}
                </small>
              </div>
              {call.notes && <p>{call.notes}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No calls logged yet.</p>
      )}
    </div>
  );
}

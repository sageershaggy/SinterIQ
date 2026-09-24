import { useState } from 'react';
import { CalendarClock, CircleCheck, GitBranch, X } from 'lucide-react';
import type { Lead } from '../shared/types';
import type { LeadContact } from '../shared/research';
import type { ContactCampaigns as Offer, ContactEnrolled } from '../shared/email';
import { api, json, label } from './api';
import { Spinner } from './ui';
import './ContactCampaigns.css';

type Enrollment = NonNullable<Lead['campaigns']>[number];
const when = (value: string | number) =>
  new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** Where one person's sequence stands, in a line. */
function progressText(enrollment: Enrollment) {
  const steps = enrollment.step_count || 0;
  switch (enrollment.status) {
    case 'QUEUED':
    case 'SENDING':
      return (
        'message ' +
        Math.min(enrollment.next_step + 1, steps || 1) +
        ' of ' +
        steps +
        (enrollment.funnel_status === 'ACTIVE'
          ? ' on ' + when(enrollment.next_send_at)
          : ' · waits until the campaign is started again')
      );
    case 'COMPLETED':
      return 'all ' + steps + ' messages sent';
    default:
      return label(enrollment.status).toLowerCase();
  }
}

/**
 * A researched contact's campaigns on the "People at this company" card: where each of their
 * sequences stands, and "Add to campaign" for anyone with a published address. Joining is the
 * server's decision (qualification, opt-outs, bounces, the three-email limit and the rest are
 * checked there); this only shows the campaigns with the reason any of them is unavailable.
 */
export function ContactCampaigns({
  base,
  lead,
  contact,
  disabled,
  onEnrolled,
}: {
  /** The lead's API path. */
  base: string;
  lead: Lead;
  contact: LeadContact;
  disabled?: boolean;
  onEnrolled?: (message: string) => void;
}) {
  const enrollments = (lead.campaigns || []).filter((item) => item.contact_id === contact.id);
  const running = enrollments.some((item) => item.status === 'QUEUED' || item.status === 'SENDING');
  const [open, setOpen] = useState(false),
    [offer, setOffer] = useState<Offer | null>(null),
    [selected, setSelected] = useState<number | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [joined, setJoined] = useState<ContactEnrolled | null>(null);
  const projectBase = base.split('/leads/')[0];
  async function show() {
    setOpen(true);
    setJoined(null);
    setError('');
    setOffer(null);
    try {
      const data = await api<Offer>(base + '/contacts/' + contact.id + '/campaigns');
      setOffer(data);
      setSelected(data.campaigns.find((campaign) => !campaign.blocked)?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function add() {
    if (selected === null) return;
    setSaving(true);
    setError('');
    try {
      const result = await api<ContactEnrolled>(
        projectBase + '/funnels/' + selected + '/enrollments',
        { method: 'POST', body: json({ lead_ids: [lead.id], contact_id: contact.id }) },
      );
      setJoined(result);
      onEnrolled?.(contact.name + ' was added to ' + result.funnel_name + '.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const chosen = offer?.campaigns.find((campaign) => campaign.id === selected);
  return (
    <div className="contact-campaigns">
      {!!enrollments.length && (
        <ul className="contact-campaign-status" aria-label={'Campaigns for ' + contact.name}>
          {enrollments.map((item) => (
            <li
              key={item.id}
              className={'is-' + item.status.toLowerCase()}
              title={item.reason || undefined}
            >
              <GitBranch size={12} aria-hidden="true" />
              <strong>{item.funnel_name}</strong>
              <span>{progressText(item)}</span>
            </li>
          ))}
        </ul>
      )}
      {!contact.email ? (
        <small className="contact-campaign-none">
          No email address is published for this person, so they cannot join a campaign.
        </small>
      ) : (
        // A person is in one running sequence at a time, so there is nothing to add them to yet.
        !open &&
        !running && (
          <button
            type="button"
            className="text-button contact-campaign-add"
            disabled={disabled}
            onClick={() => void show()}
          >
            <GitBranch size={13} />
            Add to campaign
          </button>
        )
      )}
      {open && (
        <div className="contact-campaign-panel" role="group" aria-label={'Add ' + contact.name + ' to a campaign'}>
          <div className="contact-campaign-panel-head">
            <strong>
              {joined ? 'Added to ' + joined.funnel_name : 'Add ' + contact.name + ' to a campaign'}
            </strong>
            <button
              type="button"
              className="icon-button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
          {joined ? (
            <div className="contact-campaign-joined" role="status">
              <CircleCheck size={16} />
              <div>
                <p>
                  {contact.name} is now in <strong>{joined.funnel_name}</strong>. Each message goes
                  to {contact.email} from this project’s mailbox, with their own name and role.
                </p>
                <ol>
                  {joined.schedule.map((time, index) => (
                    <li key={index}>
                      <CalendarClock size={12} aria-hidden="true" />
                      Message {index + 1} on {when(time)}
                    </li>
                  ))}
                </ol>
                {chosen?.stop_on_reply && (
                  <p className="muted">
                    It stops as soon as anyone at {lead.name} replies.
                  </p>
                )}
              </div>
            </div>
          ) : !offer ? (
            error ? null : <Spinner text="Loading campaigns…" />
          ) : !offer.campaigns.length ? (
            <p className="muted">
              This project has no campaigns yet. An administrator creates them under Email funnels.
            </p>
          ) : (
            <>
              <p className="muted">
                Messages go to {contact.email} with {contact.name}’s name and role in the merge
                fields, never the primary contact’s.
              </p>
              <div className="contact-campaign-options" role="radiogroup" aria-label="Campaign">
                {offer.campaigns.map((campaign) => (
                  <label
                    key={campaign.id}
                    className={
                      'contact-campaign-option' +
                      (selected === campaign.id ? ' is-selected' : '') +
                      (campaign.blocked ? ' is-blocked' : '')
                    }
                  >
                    <input
                      type="radio"
                      name={'contact-campaign-' + contact.id}
                      checked={selected === campaign.id}
                      disabled={!!campaign.blocked}
                      onChange={() => setSelected(campaign.id)}
                    />
                    <span>
                      <strong>{campaign.name}</strong>
                      <small>
                        {campaign.steps.length} message{campaign.steps.length === 1 ? '' : 's'} ·{' '}
                        {label(campaign.status)}
                        {campaign.steps[0] ? ' · first: ' + campaign.steps[0].subject : ''}
                      </small>
                      {campaign.blocked && (
                        <small className="contact-campaign-blocked">{campaign.blocked}</small>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              <div className="contact-campaign-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={selected === null || saving}
                  onClick={() => void add()}
                >
                  {saving ? <Spinner text="Adding…" /> : 'Add to campaign'}
                </button>
                <button type="button" className="button secondary" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {error && <p className="contact-campaign-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

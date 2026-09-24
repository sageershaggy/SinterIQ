export interface FunnelStep {
  delay_days: number;
  /**
   * Preferred local send time on the due day, as HH:mm. Empty means send as soon as the
   * delay elapses. Sequences stay relative to enrollment; this only picks the clock time.
   */
  send_time?: string;
  subject: string;
  to?: string;
  /** Plain text. Also the text alternative when the message is designed. */
  body: string;
  /**
   * A message designed with the old block editor. Still delivered as written; the rich-text
   * editor opens it as HTML.
   */
  blocks?: EmailBlock[];
  /** A message written in the rich-text editor, in the allowlisted email dialect. */
  html?: string;
  /** Uploaded files sent with this message. */
  attachment_ids?: number[];
}
import type { EmailBlock } from './types';

export type FunnelStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED';
/**
 * The fit scores a campaign is meant for. The composer pre-selects by band: 80 and above to the
 * high-quality campaign, 50–79 to the email campaign. Anyone can still pick another.
 */
export type FitBand = 'ANY' | 'HIGH' | 'EMAIL';
export const fitBandFloors = { high: 80, email: 50 } as const;
export const fitBandLabels: Record<FitBand, string> = {
  ANY: 'Any fit score',
  HIGH: 'Fit 80–100 · high-quality campaign',
  EMAIL: 'Fit 50–79 · email campaign',
};
export function bandForScore(score: number | null): 'HIGH' | 'EMAIL' | 'LOW' | null {
  if (score === null || score === undefined) return null;
  if (score >= fitBandFloors.high) return 'HIGH';
  if (score >= fitBandFloors.email) return 'EMAIL';
  return 'LOW';
}
/**
 * Picks the campaign the composer offers first. Only a campaign that declared the lead's band is
 * suggested — an active one before a draft, the newest first — so nothing lands in the wrong
 * sequence by accident; without one, a one-off email is the suggestion.
 */
export function suggestCampaign(
  lead: { score: number | null; stale?: boolean },
  campaigns: Array<{ id: number; fit_band: FitBand; status: FunnelStatus; blocked?: string }>,
): { funnel_id: number | null; reason: string } {
  const band = lead.stale ? null : bandForScore(lead.score);
  if (lead.stale)
    return {
      funnel_id: null,
      reason: 'The fit score is out of date. Requalify to get a suggestion.',
    };
  if (band === null)
    return {
      funnel_id: null,
      reason: 'This lead has no fit score yet, so a one-off email is suggested.',
    };
  if (band === 'LOW')
    return {
      funnel_id: null,
      reason: 'Fit ' + lead.score + ' is below 50, so a one-off email is suggested.',
    };
  const rank = (status: FunnelStatus) => (status === 'ACTIVE' ? 0 : status === 'DRAFT' ? 1 : 2);
  const matches = campaigns
    .filter((campaign) => campaign.fit_band === band)
    .sort((a, b) => rank(a.status) - rank(b.status) || b.id - a.id);
  const match = matches.find((campaign) => !campaign.blocked);
  const range = band === 'HIGH' ? '80–100' : '50–79';
  if (match)
    return {
      funnel_id: match.id,
      reason: 'Suggested for fit ' + lead.score + ' (the ' + range + ' campaign).',
    };
  // The right campaign exists but this lead cannot start it yet: say why, rather than
  // pre-selecting something that cannot be sent.
  if (matches.length)
    return {
      funnel_id: null,
      reason:
        'The ' +
        range +
        ' campaign is not available for this lead: ' +
        matches[0].blocked +
        ' A one-off email is suggested.',
    };
  return {
    funnel_id: null,
    reason:
      'No campaign is set up for fit ' +
      range +
      ' yet. Send a one-off email, or pick any campaign.',
  };
}
/** Where a funnel's leads are, for the progress strip on the funnels page. */
export interface FunnelProgress {
  /** Active sequences by the message they are waiting for: index 0 waits for message 1. */
  waiting: number[];
  replied: number;
  bounced: number;
  stopped: number;
  blocked: number;
  completed: number;
  total: number;
}
export interface Funnel {
  id: number;
  project_id: number;
  name: string;
  audience: string;
  steps: FunnelStep[];
  status: FunnelStatus;
  revision: number;
  created_at: string;
  enrolled_count: number;
  queued_count: number;
  converted_count: number;
  /** Whether a matched incoming reply stops this sequence's remaining messages. */
  stop_on_reply: boolean;
  fit_band: FitBand;
  progress?: FunnelProgress;
}
export type OutreachOutcome = 'REPLIED' | 'INTERESTED' | 'CONVERTED' | 'STOPPED' | 'UNSUBSCRIBED';
export interface Enrollment {
  id: number;
  funnel_id: number;
  lead_id: number;
  lead_name: string;
  recipient: string;
  status: string;
  next_step: number;
  next_send_at: number;
  reason: string;
  created_by: string;
  updated_at: string;
  stop_cause?: string;
  /** The researched contact (lead_contacts) this sequence mails; null for the primary contact. */
  contact_id?: number | null;
}

import type { FitBand } from './funnels';

/** An uploaded attachment or inline image. The bytes stay on the server. */
export interface EmailFile {
  id: number;
  project_id: number;
  kind: 'attachment' | 'image';
  filename: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: string;
}
/** A campaign as the composer offers it: its defaults, and whether this lead can join it. */
export interface CampaignOption {
  id: number;
  name: string;
  audience: string;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED';
  fit_band: FitBand;
  stop_on_reply: boolean;
  steps: Array<{
    subject: string;
    html: string;
    delay_days: number;
    send_time: string;
    attachment_ids: number[];
  }>;
  /** Empty when the lead can join; otherwise the reason it cannot, in plain words. */
  blocked: string;
}
/** "Add to campaign" for one person found on the company's website. */
export interface ContactCampaigns {
  contact: { id: number; name: string; email: string };
  /** Every campaign in the project; `blocked` says why this person cannot join one now. */
  campaigns: CampaignOption[];
}
/** A contact just added to a campaign: when each of its messages is due. */
export interface ContactEnrolled {
  enrolled: number;
  skipped: number;
  funnel_id: number;
  funnel_name: string;
  funnel_status: 'DRAFT' | 'ACTIVE' | 'PAUSED';
  /** One ISO time per message, message 1 first. */
  schedule: string[];
}
export interface CampaignSuggestion {
  funnel_id: number | null;
  reason: string;
}
/** What the composer saves as a private draft while someone writes. */
export interface EmailDraftDocument {
  to: string;
  subject: string;
  preview_text: string;
  html?: string;
  blocks?: unknown[];
  /** null is a one-off email; a number is the campaign this email starts. */
  funnel_id?: number | null;
  attachment_ids?: number[];
  /** Chosen follow-up times, ISO strings, one per later campaign message. */
  followups?: string[];
}
export interface BounceNotice {
  recipient: string;
  source: 'SMTP' | 'DSN';
  created_at: string;
}

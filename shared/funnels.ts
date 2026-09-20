export interface FunnelStep {
  delay_days: number;
  /**
   * Preferred local send time on the due day, as HH:mm. Empty means send as soon as the
   * delay elapses. Sequences stay relative to enrollment; this only picks the clock time.
   */
  send_time?: string;
  subject: string;
  to?: string;
  /** Plain text. Also the text alternative when the message is designed with blocks. */
  body: string;
  /**
   * A designed message. When present the server renders it to email-safe HTML and derives
   * the plain-text part from it; absent means this step is plain text, which is what every
   * funnel stored before designed messages existed.
   */
  blocks?: EmailBlock[];
}
import type { EmailBlock } from './types';

export type FunnelStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED';
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
}

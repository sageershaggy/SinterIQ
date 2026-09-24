/**
 * The manual CRM layer on a lead: a pipeline status people set by hand and comments they leave.
 * Neither is research. Changing either never touches the qualification, the fit score, the
 * decision or the lead revision, so a status or a comment can never make a result go stale.
 */
export const pipelineStatuses = [
  'NEW',
  'CONTACTED',
  'INTERESTED',
  'MEETING_BOOKED',
  'PROPOSAL_SENT',
  'WON',
  'LOST',
  'NOT_INTERESTED',
] as const;
export type PipelineStatus = (typeof pipelineStatuses)[number];
export const pipelineStatusLabels: Record<PipelineStatus, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  INTERESTED: 'Interested',
  MEETING_BOOKED: 'Meeting booked',
  PROPOSAL_SENT: 'Proposal sent',
  WON: 'Won',
  LOST: 'Lost',
  NOT_INTERESTED: 'Not interested',
};
/** A lead nobody has moved yet is New; there is no row for that. */
export const defaultPipelineStatus: PipelineStatus = 'NEW';

/** One recorded move of the pipeline status. Append-only. */
export interface PipelineChange {
  id: number;
  from_status: PipelineStatus;
  to_status: PipelineStatus;
  created_by: string;
  created_at: string;
}
export interface LeadComment {
  id: number;
  lead_id: number;
  author: string;
  body: string;
  created_at: string;
  /** Set when the author has edited it. */
  updated_at: string | null;
  /** Worked out by the server for the viewer: authors edit their own comments. */
  can_edit: boolean;
  /** Authors delete their own; administrators may delete any. */
  can_delete: boolean;
}
/** What the lead detail carries for the CRM layer. */
export interface LeadCrm {
  pipeline_status: PipelineStatus;
  pipeline_changes: PipelineChange[];
  comments: LeadComment[];
}

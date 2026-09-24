import type { CallOutcome } from './types';

/**
 * Every call status the call log can hold, in the order they are offered. Additive only: the
 * first six are the statuses the Calls page offers (Suggestions 2, line 27); WRONG_CONTACT and
 * MEETING_BOOKED came first and stay loggable so every existing entry keeps reading correctly.
 * server/crm-schema.ts widens the call_logs CHECK constraint from this list, so adding a value
 * here is the whole migration.
 */
export const callOutcomes = [
  'CONNECTED',
  'NO_ANSWER',
  'CALLBACK',
  'INTERESTED',
  'NOT_INTERESTED',
  'FOLLOW_UP',
  'MEETING_BOOKED',
  'WRONG_CONTACT',
] as const satisfies readonly CallOutcome[];

/** What the person on the phone reads. Record<CallOutcome> keeps this list complete. */
export const callOutcomeLabels: Record<CallOutcome, string> = {
  CONNECTED: 'Called – Connected',
  NO_ANSWER: 'Called – No answer',
  CALLBACK: 'Call back requested',
  INTERESTED: 'Interested',
  NOT_INTERESTED: 'Not interested',
  FOLLOW_UP: 'Follow-up required',
  MEETING_BOOKED: 'Meeting booked',
  WRONG_CONTACT: 'Wrong contact',
};

/** The statuses the Calls page offers for a manual update. */
export const manualCallOutcomes: CallOutcome[] = [
  'CONNECTED',
  'NO_ANSWER',
  'CALLBACK',
  'INTERESTED',
  'NOT_INTERESTED',
  'FOLLOW_UP',
];

/** Only these carry a date for the next action; any other status refuses one. */
export const datedCallOutcomes: CallOutcome[] = ['CALLBACK', 'FOLLOW_UP'];

/**
 * Where calling stands for a lead, derived from its latest call. This is the vocabulary a
 * "Call status" filter on the lead list can use (Suggestions 2, line 11):
 * - NO_CALL_YET: nothing logged;
 * - FOLLOW_UP_REQUIRED: the last call asks for another one (no answer, call back, follow-up);
 * - COMPLETED: the last call reached a result (connected, interested, not interested, meeting
 *   booked, wrong contact).
 * "Call assigned" and "Call pending" are about assignment rather than the log: assigned_to is
 * set, and pending is assigned with NO_CALL_YET.
 */
export type CallStage = 'NO_CALL_YET' | 'FOLLOW_UP_REQUIRED' | 'COMPLETED';
export const followUpCallOutcomes: CallOutcome[] = ['NO_ANSWER', 'CALLBACK', 'FOLLOW_UP'];
export function callStage(latest: CallOutcome | null): CallStage {
  if (!latest) return 'NO_CALL_YET';
  return followUpCallOutcomes.includes(latest) ? 'FOLLOW_UP_REQUIRED' : 'COMPLETED';
}

/** What the caller should do next, read from the latest call. */
export function nextCallAction(latest: CallOutcome | null): string {
  switch (latest) {
    case null:
      return 'Make the first call';
    case 'NO_ANSWER':
      return 'Try again';
    case 'CALLBACK':
      return 'Call back';
    case 'FOLLOW_UP':
      return 'Follow up';
    case 'CONNECTED':
      return 'Record the outcome';
    case 'INTERESTED':
      return 'Book a meeting';
    case 'MEETING_BOOKED':
      return 'Prepare for the meeting';
    case 'WRONG_CONTACT':
      return 'Find the right contact';
    case 'NOT_INTERESTED':
      return 'No further calls';
  }
}

/** One row of the Calls page: an assigned lead and where its calling stands. */
export interface CallQueueRow {
  lead_id: number;
  name: string;
  contact_name: string;
  contact_role: string;
  contact_phone: string;
  contact_email: string;
  city: string;
  country: string;
  assigned_to: number | null;
  assigned_to_name: string | null;
  assigned_at: string | null;
  /** The latest logged status, or null when nobody has called yet. */
  call_status: CallOutcome | null;
  call_stage: CallStage;
  last_call_at: string | null;
  last_call_by: string | null;
  last_call_notes: string;
  call_count: number;
  next_action: string;
  /** YYYY-MM-DD, carried by a call-back or follow-up. */
  next_action_at: string | null;
}
export interface CallQueue {
  rows: CallQueueRow[];
  /** Everyone who may hold a calling assignment in this project, for the person filter. */
  people: Array<{ id: number; name: string }>;
  /** The filter that was applied: 'me', 'all' or an account ID. */
  assignee: 'me' | 'all' | number;
  truncated: boolean;
}

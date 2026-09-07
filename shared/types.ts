export type Decision = 'QUALIFIED' | 'NOT_A_TARGET' | 'NEEDS_REVIEW';
/** Outreach readiness derived from the server-computed fit score. */
export type NextStep = 'CALL_READY' | 'SEND_EMAIL' | 'REVIEW_WITH_CLIENT' | 'NONE';
export const nextStepBands = { call: 80, email: 70, review: 50 } as const;
export function nextStepFor(decision: Decision | 'UNREVIEWED', score: number | null): NextStep {
  if (decision === 'NOT_A_TARGET' || decision === 'UNREVIEWED' || score === null) return 'NONE';
  // An unresolved decision is a review regardless of how well it scored.
  if (decision === 'NEEDS_REVIEW') return 'REVIEW_WITH_CLIENT';
  if (score >= nextStepBands.call) return 'CALL_READY';
  if (score >= nextStepBands.email) return 'SEND_EMAIL';
  if (score >= nextStepBands.review) return 'REVIEW_WITH_CLIENT';
  return 'NONE';
}
export interface User {
  id: number;
  username: string;
  name: string;
  role: 'admin' | 'researcher';
}
export interface Account extends User {
  active: boolean;
  project_ids: number[];
}
export interface Rubric {
  summary: string;
  criteria: string[];
  exclusions: string[];
  questions: string[];
}
export interface Project {
  id: number;
  name: string;
  description: string;
  website: string;
  revision: number;
  trained_revision: number | null;
  active_version: number | null;
  rubric: Rubric;
  lead_count: number;
  qualified_count: number;
  review_count: number;
  source_count: number;
  member_count: number;
  pending_feedback_count: number;
  is_starter: boolean;
  preserved_lead_count: number;
  preserved_contact_count: number;
  preserved_activity_count: number;
  created_at: string;
  updated_at: string;
}
export interface Source {
  id: number;
  project_id: number;
  title: string;
  kind: 'document' | 'website' | 'note';
  url: string;
  content: string;
  filename: string;
  sha256: string;
  created_at: string;
}
export interface TrainingSnapshot {
  project: { name: string; description: string; website: string };
  rubric: Rubric;
  sources: Source[];
  /** Reviewer corrections folded in when this version was published. */
  feedback?: Array<{
    lead_name: string;
    verdict: 'CORRECT' | 'INCORRECT';
    expected_decision: Decision | null;
    notes: string;
  }>;
}
export interface CriterionResult {
  criterion: string;
  outcome: 'MATCH' | 'NO_MATCH' | 'UNKNOWN';
  evidence: string;
  source_ids: string[];
}
/**
 * Business contact published on the company's own website, plus the approach the
 * researcher should take. Personal data here is deletable from the lead detail view.
 */
export interface Outreach {
  contact_name: string;
  contact_role: string;
  contact_source_ids: string[];
  why_qualified: string;
  call_script: string;
}
export interface Qualification {
  decision: Decision;
  score: number;
  confidence: number;
  summary: string;
  criteria: CriterionResult[];
  exclusions: CriterionResult[];
  gaps: string[];
  next_steps: string[];
  outreach: Outreach;
}
export interface Evidence {
  id: string;
  title: string;
  url: string;
  content: string;
  captured_at: string;
  kind: 'website' | 'lead_record';
}
export interface Run {
  id: number;
  lead_id: number;
  project_id: number;
  training_version: number;
  lead_revision: number;
  result: Qualification;
  evidence: Evidence[];
  provider: string;
  model: string;
  created_at: string;
  created_by: string;
}
export interface Review {
  id: number;
  run_id: number;
  decision: Decision;
  notes: string;
  created_by: string;
  created_at: string;
}
export interface Lead {
  id: number;
  project_id: number;
  name: string;
  website: string;
  country: string;
  industry: string;
  notes: string;
  revision: number;
  status: 'UNREVIEWED' | Decision;
  score: number | null;
  confidence: number | null;
  latest_run_id: number | null;
  training_version: number | null;
  qualified_revision: number | null;
  contact_name: string;
  contact_role: string;
  next_step: NextStep;
  stale: boolean;
  reviewed: boolean;
  created_at: string;
  updated_at: string;
  legacy_json?: string;
  preserved_records?: PreservedRecord[];
  runs?: Run[];
  reviews?: Review[];
  feedback?: LeadFeedback[];
}
/**
 * A researcher's verdict on an AI qualification. Published training versions fold
 * outstanding feedback into the snapshot so later runs learn from corrections.
 */
export interface LeadFeedback {
  id: number;
  project_id: number;
  lead_id: number;
  lead_name: string;
  run_id: number | null;
  verdict: 'CORRECT' | 'INCORRECT';
  expected_decision: Decision | null;
  notes: string;
  applied_version: number | null;
  created_by: string;
  created_at: string;
}
export interface PreservedRecord {
  id: number;
  project_id: number;
  lead_id: number | null;
  kind: 'contacts' | 'activities' | 'notes' | 'research_history';
  legacy_id: number;
  data: Record<string, unknown>;
  imported_at: string;
}
export interface Settings {
  provider: 'gemini' | 'openai_compatible';
  model: string;
  base_url: string;
  has_api_key: boolean;
  api_key_preview: string;
  source: string;
}

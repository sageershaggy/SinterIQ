export type Decision = 'QUALIFIED' | 'NOT_A_TARGET' | 'NEEDS_REVIEW';
/** Outreach readiness derived from the server-computed fit score. */
export type NextStep = 'CALL_READY' | 'SEND_EMAIL' | 'REVIEW_WITH_CLIENT' | 'NONE';
export const nextStepBands = { call: 80, email: 70, review: 50 } as const;
/**
 * The fit score from which a lead with no exclusion and no research blocker is Qualified; below
 * it the lead is Not a target. Missing information lowers the score, it never causes a review.
 */
export const qualifiedFloor = 50;
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
  /**
   * The services the project sells that a lead could be a fit for, each judged separately from
   * the fit score. Absent on rubrics saved before categories existed, which means none.
   */
  categories?: ServiceCategory[];
}
/** One offer a lead can be a fit for, such as "Website development", and what a good fit looks like. */
export interface ServiceCategory {
  name: string;
  description: string;
}
/** How well a lead fits one service: GOOD a clear evidenced need, POSSIBLE some signals, NONE neither. */
export type ServiceFitLevel = 'GOOD' | 'POSSIBLE' | 'NONE';
export interface ServiceFit {
  /** The category name exactly as the published training spells it. */
  category: string;
  fit: ServiceFitLevel;
  reason: string;
  source_ids: string[];
}
/** The categories a lead's current result rates GOOD or POSSIBLE, GOOD first (leads.service_fit). */
export type LeadServiceFit = Array<{ category: string; fit: Exclude<ServiceFitLevel, 'NONE'> }>;
/** Record details a qualification may find the company's own website stating differently. */
export const conflictFields = ['city', 'country', 'industry', 'employee_count'] as const;
export type ConflictField = (typeof conflictFields)[number];
/**
 * The company's own website states a different value for a detail than the lead record holds.
 * Reported with the sentence that states it. Research wins over imported data: when the record's
 * value was imported (or came with the original record), the website's value is written when the
 * run is saved (applied). A value a person typed is never replaced; it stays a visible conflict
 * until someone chooses "Use website value".
 */
export interface DetailConflict {
  field: ConflictField;
  /** The record's value when the run was made. */
  record_value: string;
  found_value: string;
  /** The sentence on the cited page that states found_value, checked against that page. */
  quote: string;
  /** The one website evidence item the quote was found in. */
  source_ids: string[];
  /** Written to the record when the run was saved (server/detail-conflicts.ts). */
  applied?: boolean;
}
/** A qualification criteria document a project can add to its library (server/criteria-templates.ts). */
export interface CriteriaTemplate {
  id: string;
  title: string;
  summary: string;
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
  /**
   * Why the lead needs review: a research or verification problem, one sentence each. Missing
   * information is never one. Runs saved before blockers existed do not have the field.
   */
  blockers?: string[];
  /**
   * What the project's offering could do for this company, kept only with a retrieved source or
   * the team's own list data.
   */
  opportunity?: { summary: string; source_ids: string[] };
  /**
   * One entry per service category in the published training, in its order. GOOD and POSSIBLE
   * need a retrieved source or the team's own list data. Runs saved before categories existed do
   * not have the field.
   */
  service_fit?: ServiceFit[];
  /** Details the company's own website states differently from the record, one per field. */
  conflicts?: DetailConflict[];
  /** The research pass that ran (or was reused) before this evaluation. */
  research?: import('./research').QualificationResearch;
  /** The company pages read as evidence for this run, with their category (server/crawl.ts). */
  pages_read?: import('./research').PageRead[];
}
export interface Evidence {
  id: string;
  title: string;
  url: string;
  content: string;
  captured_at: string;
  /**
   * website: fetched from the web. lead_record: the record as entered, which proves nothing.
   * provided_list: the columns the team imported with its lead list (an event, a funding round),
   * citable for exactly those facts but never checked on the web.
   */
  kind: 'website' | 'lead_record' | 'provided_list';
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
  contact_email: string;
  contact_phone: string;
  city: string;
  employee_count: string;
  /** Researcher responsible for calling this lead, set by assignment. */
  assigned_to: number | null;
  assigned_at: string | null;
  assigned_to_name?: string | null;
  call_count?: number;
  next_step: NextStep;
  stale: boolean;
  reviewed: boolean;
  /** The services the latest result rates GOOD or POSSIBLE; superseded with it when stale. */
  service_fit?: LeadServiceFit;
  /**
   * The imported list's other columns (shared/lead-import.ts ListData), label → value. Written
   * only by an import, never by the lead form; empty when the list had none.
   */
  list_data?: Record<string, string>;
  /** The latest fast decision (Jev), for the list badge and filter (shared/quick-decision.ts). */
  quick?: import('./quick-decision').QuickSummary | null;
  /** The latest fast decision in full, on the lead page. */
  quick_decision?: import('./quick-decision').QuickDecision | null;
  created_at: string;
  updated_at: string;
  legacy_json?: string;
  preserved_records?: PreservedRecord[];
  runs?: Run[];
  reviews?: Review[];
  feedback?: LeadFeedback[];
  calls?: CallLog[];
  /** Manual CRM layer (shared/crm.ts); never part of the qualification. */
  pipeline_status?: import('./crm').PipelineStatus;
  pipeline_changes?: import('./crm').PipelineChange[];
  comments?: import('./crm').LeadComment[];
  emails?: EmailMessage[];
  outreach_status?: string;
  campaigns?: Array<
    import('./funnels').Enrollment & {
      funnel_name: string;
      funnel_status: string;
      step_count: number;
    }
  >;
  outreach_events?: Array<{
    id: number;
    outcome: string;
    notes: string;
    created_at: string;
    created_by: string;
  }>;
  /** Archived leads are hidden from the default lists and can be restored; nothing is deleted. */
  archived_at?: string | null;
  archived_reason?: string;
  archived_by?: string;
}
export type CallOutcome =
  | 'CONNECTED'
  | 'NO_ANSWER'
  | 'CALLBACK'
  | 'NOT_INTERESTED'
  | 'WRONG_CONTACT'
  | 'MEETING_BOOKED'
  // Added for the Calls page; the order and labels live in shared/calls.ts.
  | 'INTERESTED'
  | 'FOLLOW_UP';
/** A logged call attempt against an assigned lead. Append-only. */
export interface CallLog {
  id: number;
  project_id: number;
  lead_id: number;
  outcome: CallOutcome;
  notes: string;
  /** YYYY-MM-DD for a call-back or follow-up; null otherwise and on older entries. */
  next_action_at?: string | null;
  created_by: string;
  created_at: string;
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
/**
 * The lead-list filters, in the order they are offered. One list, because the server enum, the
 * client options and the filter state drifted apart as bands and assignment were added.
 * NEEDS_RESEARCH and NO_WEBSITE describe a gap in the record rather than a qualification state.
 */
export const leadStatusFilters = [
  'ALL',
  'REVIEW_QUEUE',
  'UNREVIEWED',
  'QUALIFIED',
  'CALL_READY',
  'SEND_EMAIL',
  'REVIEW_WITH_CLIENT',
  'ASSIGNED',
  'UNASSIGNED',
  'NEEDS_REVIEW',
  'NOT_A_TARGET',
  'STALE',
  'NEEDS_RESEARCH',
  'NO_WEBSITE',
] as const;
export type LeadStatusFilter = (typeof leadStatusFilters)[number];

/** A field a research pass may fill in from the company's own website. */
export type ResearchableField =
  | 'website'
  | 'industry'
  | 'country'
  | 'city'
  | 'employee_count'
  | 'contact_name'
  | 'contact_role'
  | 'contact_email'
  | 'contact_phone';
export interface FieldProposal {
  field: ResearchableField;
  value: string;
  /** The sentence from the page that supports the value. Checked against the page itself. */
  evidence: string;
  source_url: string;
}
export interface ResearchOutcome {
  website: string;
  discovered: boolean;
  /** Candidate domains that were fetched and checked, so a repeat run is not a mystery. */
  tried: string[];
  proposals: FieldProposal[];
  /** Values the model offered that were not recorded, with the reason. */
  refused: Array<{ field: ResearchableField; value: string; reason: string }>;
  notes: string[];
  applied?: ResearchableField[];
  /** People the company's own pages name, each kept only with a sentence that names them. */
  contacts?: import('./research').ContactFinding[];
  contacts_added?: number;
  /** Sentences from the site that bear on the qualification rules. */
  facts?: import('./research').ResearchFact[];
  /** Sentences from the site that show an opportunity for the project's offering. */
  opportunities?: import('./research').ResearchFact[];
  /** The company pages that were read. */
  pages?: string[];
  /** The same pages with the category each was read as (server/crawl.ts). */
  pages_read?: import('./research').PageRead[];
  /** Web searches run for this pass, with the addresses they returned (server/web-search.ts). */
  searches?: import('./research').SearchRecord[];
  /** The record named a person, so research looked for their employer. */
  person_record?: boolean;
}
/** One project's mailbox. The password is never returned to the browser. */
export interface EmailSettings {
  /** A mailbox belongs to exactly one project. */
  project_id: number;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from_name: string;
  from_email: string;
  reply_to: string;
  copy_to?: string;
  signature: string;
  configured: boolean;
  has_password: boolean;
}
export type TemplateCategory = 'outreach' | 'follow_up' | 'meeting' | 'transactional';
/** The closed set of blocks the editor may produce and the renderer vouches for. */
export type EmailBlock =
  | { type: 'heading'; text: string; level: 'h1' | 'h2'; align: 'left' | 'center' }
  | { type: 'text'; text: string; align: 'left' | 'center' }
  | { type: 'button'; label: string; url: string; align: 'left' | 'center' }
  | { type: 'image'; url: string; alt: string; width: number }
  | { type: 'divider' }
  | { type: 'spacer'; size: 'small' | 'medium' | 'large' }
  | { type: 'quote'; text: string; cite: string };
export interface EmailTemplate {
  custom?: boolean;
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  subject: string;
  preview_text: string;
  blocks: EmailBlock[];
  /** The body as the rich-text editor opens it (converted from blocks when needed). */
  html?: string;
}
/** One outbound email, logged whether it was accepted or refused. */
export interface EmailMessage {
  id: number;
  project_id: number;
  lead_id: number;
  to_email: string;
  subject: string;
  body: string;
  status: 'SENT' | 'FAILED';
  error: string;
  created_by: string;
  created_at: string;
}
/** Settings → Fast decisions (server/jev.ts). The key itself is never sent to the browser. */
export interface JevSettings {
  has_key: boolean;
  key_preview: string;
  /** saved here, OPENROUTER_API_KEY on the server, a saved OpenRouter chat key, or none. */
  source: 'saved' | 'environment' | 'chat' | 'none';
  model: string;
  status: { ok: boolean; message: string; latency_ms: number | null; checked_at: string } | null;
}
export interface Settings {
  provider: 'gemini' | 'openai_compatible';
  /** Which provider (shared/ai-providers.ts). */
  preset: import('./ai-providers').ProviderPreset;
  /** The last connection check of exactly this configuration, if there was one. */
  status: import('./ai-providers').ConnectionStatus | null;
  model: string;
  base_url: string;
  has_api_key: boolean;
  api_key_preview: string;
  source: string;
}

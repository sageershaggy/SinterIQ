import type { Decision, ResearchableField } from './types';

/** Plain names for the fields a research pass may fill, as the lead form labels them. */
export const researchFieldLabels: Record<ResearchableField, string> = {
  website: 'Website',
  industry: 'Industry',
  country: 'Country',
  city: 'City',
  employee_count: 'Employees',
  contact_name: 'Contact name',
  contact_role: 'Contact role',
  contact_email: 'Contact email',
  contact_phone: 'Contact phone',
};
export const fieldLabel = (field: string) =>
  researchFieldLabels[field as ResearchableField] || field.replaceAll('_', ' ');

export const researchLogKinds = ['research', 'qualification', 'review'] as const;
export type ResearchLogKind = (typeof researchLogKinds)[number];

interface EntryBase {
  /** Unique across kinds, e.g. "research-12". */
  id: string;
  lead_id: number;
  lead_name: string;
  created_at: string;
  created_by: string;
}
/** A value a research pass wrote, with the sentence and page that support it. */
export interface ResearchFinding {
  field: string;
  value: string;
  /** Empty for a discovered website: that value is a check that was run, not a quotation. */
  evidence: string;
  source_url: string;
}
/** One website research pass on one lead, whether or not it changed anything. */
export interface ResearchPassEntry extends EntryBase {
  kind: 'research';
  website: string;
  discovered: boolean;
  /** Candidate domains that were fetched and checked. */
  tried: string[];
  found: ResearchFinding[];
  /** Fields the pass filled whose citation has since been erased with the contact. */
  erased: string[];
  /** Values the model offered that were not recorded. */
  refused_count: number;
  /** What the pass checked and why it stopped, in the system's own words. */
  notes: string[];
}
/** One qualification run against published training. */
export interface QualificationEntry extends EntryBase {
  kind: 'qualification';
  run_id: number;
  training_version: number;
  decision: Decision;
  score: number;
  confidence: number;
  summary: string;
  criteria_total: number;
  criteria_met: number;
  criteria_unknown: number;
  exclusions_hit: number;
  gaps: string[];
  /** Website pages read as evidence. */
  pages: string[];
}
/** A human decision on a run. */
export interface ReviewEntry extends EntryBase {
  kind: 'review';
  run_id: number;
  decision: Decision;
  notes: string;
}
export type ResearchLogEntry = ResearchPassEntry | QualificationEntry | ReviewEntry;
export interface ResearchLogPage {
  entries: ResearchLogEntry[];
  /** Pass back as `before` for the next, older page; null when there is nothing older. */
  next_before: string | null;
  /** The lead the log is narrowed to, if any. */
  lead: { id: number; name: string } | null;
}

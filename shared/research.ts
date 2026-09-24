import { nextStepBands, type ResearchableField } from './types';

/**
 * Shared vocabulary for lead research, contacts, qualification outcomes and training graphs.
 * Kept apart from shared/types.ts so the research work stays in one place.
 */

/** The functions a person on a company's website can be sorted into. */
export const roleCategories = [
  'purchasing',
  'marketing',
  'engineering',
  'management',
  'other',
] as const;
export type RoleCategory = (typeof roleCategories)[number];
export const roleCategoryLabels: Record<RoleCategory, string> = {
  purchasing: 'Purchasing',
  marketing: 'Marketing',
  engineering: 'Engineering',
  management: 'Management',
  other: 'Other',
};
const rolePatterns: Array<[Exclude<RoleCategory, 'other'>, RegExp]> = [
  // Function before seniority: a "Marketing Director" is found by what they do, not by rank.
  [
    'purchasing',
    /purchas|procure|buyer|sourcing|einkauf|beschaffung|supply chain|supplier (manager|relations)/i,
  ],
  [
    'marketing',
    /marketing|brand|communications?\b|public relations|\bpr\b|social media|content (manager|lead)|campaign/i,
  ],
  [
    'engineering',
    /engineer|r\s*&\s*d|research and development|technical|technology|\bcto\b|design|develop|konstruktion|entwicklung|technik/i,
  ],
  [
    'management',
    /\bceo\b|\bcoo\b|\bcfo\b|chief|managing director|\bmd\b|founder|owner|president|partner|general manager|gesch(ä|ae)ftsf(ü|ue)hrer|director|head of|principal|vice president|\bvp\b/i,
  ],
];
/**
 * The category of a role as the page wrote it. Deterministic on purpose: a model's opinion of
 * who someone is would be an inference about a person, and this only reads the title given.
 */
export function classifyRole(role: string): RoleCategory {
  const text = role.trim();
  if (!text) return 'other';
  for (const [category, pattern] of rolePatterns) if (pattern.test(text)) return category;
  return 'other';
}
/**
 * The contact roles a project's training asks for, read from its summary and criteria. They
 * steer the search for people and mark the contacts that matter; they never add anyone.
 */
export function rolesSought(texts: string[]): { categories: RoleCategory[]; phrases: string[] } {
  const joined = texts.join('\n');
  const categories = new Set<RoleCategory>();
  const sought: Array<[RoleCategory, RegExp]> = [
    ['purchasing', /purchas(er|ing)|procurement|buyers?\b|sourcing|einkauf/i],
    ['marketing', /marketing|brand manager|communications (manager|team)|social media manager/i],
    [
      'engineering',
      /engineers?\b|engineering (contact|lead|manager|team|authority)|r\s*&\s*d|technical (director|contact|manager)|developers?\b/i,
    ],
    ['management', /\bceo\b|managing director|founder|owner|decision[- ]makers?|general manager/i],
  ];
  for (const [category, pattern] of sought) if (pattern.test(joined)) categories.add(category);
  const phrases = new Set<string>();
  for (const match of joined.matchAll(
    /\b((?:purchasing|procurement|marketing|sales|engineering|technical|r&d|operations|project)\s+(?:assistants?|managers?|directors?|leads?|heads?|officers?|engineers?|coordinators?|specialists?))\b|\b(purchasers?|buyers?|marketing assistants?)\b/gi,
  ))
    phrases.add((match[1] || match[2]).toLowerCase());
  return { categories: [...categories], phrases: [...phrases].slice(0, 12) };
}

/** A person published on the company's own website, kept with the sentence that names them. */
export interface LeadContact {
  id: number;
  project_id: number;
  lead_id: number;
  name: string;
  role: string;
  role_category: RoleCategory;
  email: string;
  phone: string;
  source_url: string;
  evidence: string;
  created_at: string;
  created_by: string;
  /** Whether the role is one the project's training asks for. Computed when read. */
  relevant?: boolean;
}
/** A contact that passed the citation check during a research pass, before it is stored. */
export interface ContactFinding {
  name: string;
  role: string;
  role_category: RoleCategory;
  email: string;
  phone: string;
  source_url: string;
  evidence: string;
}
/** A sentence from the company's site that bears on one of the qualification rules. */
export interface ResearchFact {
  rule: string;
  quote: string;
  source_url: string;
}
/** A field value on the record that came from research, with the sentence behind it. */
export interface FieldCitation {
  field: ResearchableField;
  value: string;
  evidence: string;
  source_url: string;
  created_at: string;
  created_by: string;
}
/** One research pass as it is kept in the lead's research log. Contact details never go here. */
export interface ResearchRunSummary {
  id: number;
  origin: 'manual' | 'qualification';
  lead_revision: number;
  result_revision: number;
  created_at: string;
  created_by: string;
  website: string;
  discovered: boolean;
  tried: string[];
  pages: string[];
  applied: ResearchableField[];
  refused: Array<{ field: ResearchableField; reason: string }>;
  notes: string[];
  contacts_added: number;
  facts: ResearchFact[];
}
/** Everything the lead page shows about where a lead's details came from. */
export interface ResearchProfile {
  citations: FieldCitation[];
  contacts: LeadContact[];
  runs: ResearchRunSummary[];
  roles_sought: { categories: RoleCategory[]; phrases: string[] };
}
/** What the research pass that ran before a qualification did, stored with the run. */
export interface QualificationResearch {
  /** False when a pass had already run on this exact revision of the record, so it was reused. */
  ran: boolean;
  origin: 'manual' | 'qualification';
  website: string;
  website_found: boolean;
  filled: ResearchableField[];
  contacts_added: number;
  checked: string[];
}

/** The owner's outcome words for a rule evaluation. */
export const ruleOutcomeLabels = {
  MATCH: 'Meets',
  NO_MATCH: 'Does not meet',
  UNKNOWN: 'Unable to verify',
} as const;

/** The score bands the owner set. Shown wherever a fit score is. */
export const fitBands = [
  { min: nextStepBands.call, max: 100, label: 'Call-ready', hint: 'Strong fit: call them.' },
  {
    min: nextStepBands.email,
    max: nextStepBands.call - 1,
    label: 'Send an email',
    hint: 'Good fit: open with an email.',
  },
  {
    min: nextStepBands.review,
    max: nextStepBands.email - 1,
    label: 'Review with the client',
    hint: 'Partial fit: confirm with the client first.',
  },
  { min: 0, max: nextStepBands.review - 1, label: 'Not a fit', hint: 'Below 50: no outreach.' },
] as const;
export function fitBandFor(score: number | null) {
  if (score === null) return null;
  return fitBands.find((band) => score >= band.min) || fitBands[fitBands.length - 1];
}

/** A training document upload attempt, kept whether it was read or refused. */
export interface SourceUpload {
  id: number;
  project_id: number;
  source_id: number | null;
  filename: string;
  size: number;
  status: 'READ' | 'FAILED';
  characters: number;
  words: number;
  reason: string;
  created_at: string;
  created_by: string;
}

/** How a published training version played out across the leads qualified against it. */
export interface TrainingGraph {
  version: number | null;
  leads_evaluated: number;
  decisions: { QUALIFIED: number; NEEDS_REVIEW: number; NOT_A_TARGET: number };
  rules: Array<{
    kind: 'criterion' | 'exclusion';
    text: string;
    meets: number;
    does_not_meet: number;
    unable: number;
  }>;
}

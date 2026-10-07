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

/**
 * The kinds of company page research and qualification read besides the home page, in the
 * owner's priority order (server/crawl.ts chooses one page per kind before a second of any).
 */
export const crawlCategories = [
  'about',
  'services',
  'products',
  'industries',
  'careers',
  'news',
  'cases',
  'contact',
] as const;
export type CrawlCategory = (typeof crawlCategories)[number];
export const crawlCategoryLabels: Record<CrawlCategory | 'home' | 'other', string> = {
  home: 'Home page',
  about: 'About / company',
  services: 'Services / solutions',
  products: 'Products',
  industries: 'Industries / markets',
  careers: 'Careers / jobs',
  news: 'News / press / blog',
  cases: 'Case studies / references',
  contact: 'Contact / imprint / team',
  other: 'Other page',
};
/** A company page that was read, and the kind of page it was chosen as. */
export interface PageRead {
  url: string;
  category: CrawlCategory | 'home' | 'other';
}

/**
 * One web search a research pass ran (server/web-search.ts): what was asked, the addresses the
 * search itself returned — never anything the model wrote — and what came of checking them.
 * A social profile is listed by its site only: it cannot be read, so it proves nothing.
 */
export interface SearchRecord {
  query: string;
  /** website: the company's official site. person: the employer of a person named in the record. */
  purpose: 'website' | 'person';
  results: string[];
  /** The site that verified from these results, or '' when none did. */
  verified: string;
  /** Why the search itself failed, in the system's own words, when it did. */
  error?: string;
}

/** Settings → Fast decisions → "Use web search in research" (server/research-settings.ts). */
export interface ResearchSearchSettings {
  /** The administrator's choice; on unless turned off. */
  enabled: boolean;
  /** An OpenRouter key is available (the Jev key, OPENROUTER_API_KEY or an OpenRouter chat key). */
  has_key: boolean;
  /** Searches will run: enabled and a key. */
  active: boolean;
  model: string;
  max_results: number;
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
  /** Sentences that show an opportunity for the project's offering. Older runs lack them. */
  opportunities?: ResearchFact[];
  /** The web searches this pass ran. Older runs lack them. */
  searches?: SearchRecord[];
  /** The company pages read, with their category. Older runs lack them. */
  pages_read?: PageRead[];
  /** The record named a person, and research looked for their employer. */
  person_record?: boolean;
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
  /** The web searches the pass ran (none without an OpenRouter key or with search turned off). */
  searches?: SearchRecord[];
  /** Opportunity sentences research quoted from the company's own pages. */
  opportunities?: number;
  /** The record named a person rather than a company. */
  person_record?: boolean;
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

/**
 * A training document upload attempt, kept whether it was read or refused. READING is an attempt
 * still being read: it is not logged yet and not in the library, and it carries a negative id.
 */
export interface SourceUpload {
  id: number;
  project_id: number;
  source_id: number | null;
  filename: string;
  size: number;
  status: 'READ' | 'FAILED' | 'READING';
  characters: number;
  words: number;
  reason: string;
  created_at: string;
  created_by: string;
  /** SHA-256 of the uploaded file; '' for attempts logged before it was kept. */
  file_sha256?: string;
  /** The library source this attempt was refused as a copy of, while that source exists. */
  duplicate_of?: number | null;
  /**
   * The library source that holds this attempt's content now: the one it was read into, the one
   * it duplicated, or a later upload of the same file. Null when its content is not in the library.
   */
  in_library?: { id: number; title: string } | null;
}

/**
 * A library source that repeats an earlier one. 'content': the same file or the same text, which
 * "Remove duplicates" removes, keeping the oldest copy. 'name': the same title with different
 * content, pointed out only, since it may be a newer edition.
 */
export interface SourceDuplicate {
  id: number;
  title: string;
  created_at: string;
  kind: 'content' | 'name';
  duplicate_of: { id: number; title: string; created_at: string };
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

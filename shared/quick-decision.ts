import { qualifiedFloor } from './types';

/**
 * The fast decision: TypeSafe Jev (a small judgement model on OpenRouter's Decisions API) judges
 * every published rule against what is already known about a company, in one request that
 * answers in about a second. It is triage, not the qualification: it never sets a lead's
 * status, score or decision, and it cites nothing. The evidence-backed qualification stays the
 * record; the quick decision says where it is worth running first.
 */
export type RuleCall = 'MEETS' | 'DOES_NOT_MEET' | 'UNKNOWN';
export interface JudgedRule {
  rule: string;
  call: RuleCall;
  /** Jev's probability for each outcome, 0..1. */
  probabilities: { meets: number; does_not_meet: number; unknown: number };
}
export const quickVerdicts = ['LIKELY_QUALIFIED', 'UNSURE', 'LIKELY_NOT'] as const;
export type QuickVerdict = (typeof quickVerdicts)[number];
export const quickVerdictLabels: Record<QuickVerdict, string> = {
  LIKELY_QUALIFIED: 'Likely qualified',
  UNSURE: 'Unsure',
  LIKELY_NOT: 'Likely not a target',
};
export const quickVerdictHints: Record<QuickVerdict, string> = {
  LIKELY_QUALIFIED: 'Run the full AI qualification to confirm it with evidence',
  UNSURE: 'Too little is known: research it or run the full qualification',
  LIKELY_NOT: 'Low priority: check the reason before archiving',
};
/** The overall impression Jev gives on the project's target profile. */
export const overallFitLevels = [
  'Clearly not a fit',
  'Probably not a fit',
  'Not enough information',
  'Probably a fit',
  'Clearly a fit',
] as const;

export interface QuickDecision {
  verdict: QuickVerdict;
  /** Share of criteria Jev judged met, 0–100, the same formula as the fit score; 0 if excluded. */
  score: number;
  /** The exclusion that decided it, in the training's words, or ''. */
  excluded_by: string;
  /** Share of criteria nothing known could settle, 0..1. */
  unknown_share: number;
  overall: { level: number; label: string } | null;
  criteria: JudgedRule[];
  exclusions: JudgedRule[];
  /** Whether text from the company's own website was part of what Jev read. */
  website_read: boolean;
  model: string;
  latency_ms: number;
  lead_revision: number;
  training_version: number;
  created_at: string;
  created_by: string;
  /** The lead or the training changed since: the decision describes an older state. */
  stale: boolean;
}
/** What a lead row carries for the list: enough for the badge and the filter. */
export interface QuickSummary {
  verdict: QuickVerdict;
  score: number;
  stale: boolean;
}

/** A call is only made when Jev is this sure of it; otherwise the rule stays unknown. */
export const callThreshold = 0.6;
/** An exclusion only decides when Jev is this sure it applies. */
export const exclusionThreshold = 0.7;
/** At or above this share of unsettled criteria, a low score means "unsure", not "no". */
export const unsureShare = 0.5;

type ChoiceAnswer = { choice: string; probabilities?: Record<string, number> };

/** One rule's answer: the most likely outcome, kept only when Jev is sure enough of it. */
export function judgedRule(
  rule: string,
  answer: ChoiceAnswer | undefined,
  keys: { yes: string; no: string },
): JudgedRule {
  const p = answer?.probabilities || {};
  const probabilities = {
    meets: p[keys.yes] ?? (answer?.choice === keys.yes ? 1 : 0),
    does_not_meet: p[keys.no] ?? (answer?.choice === keys.no ? 1 : 0),
    unknown: p.unknown ?? (answer?.choice === 'unknown' ? 1 : 0),
  };
  const threshold = keys.yes === 'applies' ? exclusionThreshold : callThreshold;
  const call: RuleCall =
    answer?.choice === keys.yes && probabilities.meets >= threshold
      ? 'MEETS'
      : answer?.choice === keys.no && probabilities.does_not_meet >= callThreshold
        ? 'DOES_NOT_MEET'
        : 'UNKNOWN';
  return { rule, call, probabilities };
}

/**
 * The verdict from the rule calls, on the same rule the qualification uses: a met exclusion is
 * Not a target at 0; otherwise the share of criteria met decides from qualifiedFloor; and when
 * most criteria cannot be settled from what is known, a low score is "unsure" rather than "no".
 */
export function quickVerdict(criteria: JudgedRule[], exclusions: JudgedRule[]) {
  const excludedBy = exclusions.find((item) => item.call === 'MEETS')?.rule || '';
  const met = criteria.filter((item) => item.call === 'MEETS').length;
  const unknown = criteria.filter((item) => item.call === 'UNKNOWN').length;
  const unknown_share = criteria.length ? unknown / criteria.length : 1;
  const score = excludedBy || !criteria.length ? 0 : Math.round((met / criteria.length) * 100);
  const verdict: QuickVerdict = excludedBy
    ? 'LIKELY_NOT'
    : score >= qualifiedFloor
      ? 'LIKELY_QUALIFIED'
      : unknown_share >= unsureShare
        ? 'UNSURE'
        : 'LIKELY_NOT';
  return { verdict, score, excluded_by: excludedBy, unknown_share };
}

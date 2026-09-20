import { z } from 'zod';
import { HttpError } from './validation';
import { publicRequest } from './network';

const OPENROUTER_DECISIONS = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13';

const noulAnswer = z
  .object({
    type: z.literal('noul'),
    noul: z.number(),
  })
  .passthrough();
const choiceAnswer = z
  .object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();
const scoreAnswer = z
  .object({
    type: z.literal('score'),
    score: z.number(),
  })
  .passthrough();

const decisionsResponse = z
  .object({
    answers: z.record(z.string(), z.union([noulAnswer, choiceAnswer, scoreAnswer])),
  })
  .passthrough();

export type DecisionQuestions = Record<
  string,
  | {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    }
  | {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: 'score';
      instructions: string;
      criteria: string[];
    }
>;

export type DecisionAnswers = z.infer<typeof decisionsResponse>['answers'];

/**
 * TypeSafe Jev (and other System One models) answer narrow typed questions via OpenRouter's
 * Decisions API — not chat/completions. Qualification and research keep using the chat path.
 */
export async function createDecision(options: {
  apiKey: string;
  model?: string;
  state: string | Record<string, unknown> | unknown[];
  questions: DecisionQuestions;
}): Promise<{ answers: DecisionAnswers; model: string; latency_ms: number }> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new HttpError(400, 'Enter an OpenRouter API key to use Jev decisions.');
  const model = (options.model || DEFAULT_JEV_MODEL).trim() || DEFAULT_JEV_MODEL;
  const start = Date.now();
  const response = await publicRequest(OPENROUTER_DECISIONS, {
    method: 'POST',
    timeout: 30000,
    maxBytes: 200_000,
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://innovista-ai.local',
      'X-Title': 'Innovista Research AI',
    },
    body: JSON.stringify({
      model,
      state: options.state,
      questions: options.questions,
    }),
  });
  if (response.status < 200 || response.status >= 300) {
    let detail = '';
    try {
      const err = JSON.parse(response.text) as { error?: { message?: string } };
      if (err?.error?.message) detail = ': ' + err.error.message.slice(0, 200);
    } catch {
      // ignore
    }
    throw new HttpError(
      502,
      'OpenRouter decisions request failed (HTTP ' + response.status + detail + ').',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new HttpError(502, 'OpenRouter did not return valid JSON for the decision.');
  }
  const data = decisionsResponse.safeParse(parsed);
  if (!data.success)
    throw new HttpError(502, 'OpenRouter returned an unexpected decisions response.');
  return { answers: data.data.answers, model, latency_ms: Date.now() - start };
}

/** Small ping used by Settings to prove the Decisions API key and Jev model. */
export function healthDecisionQuestions(): DecisionQuestions {
  return {
    ok: {
      type: 'noul',
      instructions: 'Is this a successful health-check ping from Innovista Research AI?',
      criteria: {
        true: 'The message is an intentional health check',
        false: 'Anything else',
      },
    },
  };
}

export function isDecisionsModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  return id.startsWith('typesafe/') || id.includes('jev');
}

export function isOpenRouterBase(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./, '') === 'openrouter.ai';
  } catch {
    return false;
  }
}

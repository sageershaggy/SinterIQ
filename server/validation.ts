import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const text = (max: number) => z.string().trim().max(max);
export const requiredText = (max: number) => text(max).min(1);
export const webUrl = text(2000).refine((value) => {
  if (!value) return true;
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
}, 'Enter a complete http:// or https:// website URL without credentials.');
export const projectSchema = z
  .object({
    name: requiredText(120),
    description: text(4000).default(''),
    website: webUrl.default(''),
  })
  .strict();
export const rubricSchema = z
  .object({
    summary: requiredText(6000),
    criteria: z.array(requiredText(800)).min(1).max(20),
    exclusions: z.array(requiredText(800)).max(20),
    questions: z.array(requiredText(800)).max(20).default([]),
  })
  .strict();
export const emailAddress = text(200).refine(
  (value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value),
  'Enter a valid email address.',
);
export const phoneNumber = text(40).refine(
  (value) => !value || /^[+(]?\d[\d\s()./+-]{4,}$/.test(value),
  'Enter a valid phone number.',
);
export const leadSchema = z
  .object({
    name: requiredText(200),
    website: webUrl.default(''),
    country: text(120).default(''),
    city: text(120).default(''),
    industry: text(200).default(''),
    employee_count: text(60).default(''),
    contact_name: text(200).default(''),
    contact_role: text(200).default(''),
    contact_email: emailAddress.default(''),
    contact_phone: phoneNumber.default(''),
    notes: text(10000).default(''),
  })
  .strict();
export const callSchema = z
  .object({
    outcome: z.enum([
      'CONNECTED',
      'NO_ANSWER',
      'CALLBACK',
      'NOT_INTERESTED',
      'WRONG_CONTACT',
      'MEETING_BOOKED',
    ]),
    notes: requiredText(4000).min(5),
  })
  .strict();
export const emailSettingsSchema = z
  .object({
    host: text(253).default(''),
    port: z.coerce.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    username: text(200).default(''),
    password: text(400).default(''),
    clear_password: z.boolean().default(false),
    from_name: text(120).default(''),
    from_email: emailAddress.default(''),
    reply_to: emailAddress.default(''),
    signature: text(1000).default(''),
  })
  .strict();
export const emailSendSchema = z
  .object({
    to: requiredText(200),
    subject: requiredText(200).min(3),
    body: requiredText(20000).min(20),
  })
  .strict();
export const decisionSchema = z.enum(['QUALIFIED', 'NOT_A_TARGET', 'NEEDS_REVIEW']);
const criterionSchema = z
  .object({
    criterion: requiredText(800),
    outcome: z.enum(['MATCH', 'NO_MATCH', 'UNKNOWN']),
    evidence: requiredText(2000),
    source_ids: z.array(requiredText(100)).max(12),
  })
  .strict();
export const outreachSchema = z
  .object({
    contact_name: text(200).default(''),
    contact_role: text(200).default(''),
    contact_source_ids: z.array(requiredText(100)).max(12).default([]),
    why_qualified: text(4000).default(''),
    call_script: text(6000).default(''),
  })
  .strict();
export const qualificationSchema = z
  .object({
    decision: decisionSchema,
    score: z.number().int().min(0).max(100),
    confidence: z.number().int().min(0).max(100),
    summary: requiredText(6000),
    criteria: z.array(criterionSchema).min(1).max(20),
    exclusions: z.array(criterionSchema).max(20),
    gaps: z.array(requiredText(1000)).max(30),
    next_steps: z.array(requiredText(1000)).max(20),
    outreach: outreachSchema.default(() => ({
      contact_name: '',
      contact_role: '',
      contact_source_ids: [],
      why_qualified: '',
      call_script: '',
    })),
  })
  .strict();
export const feedbackSchema = z
  .object({
    run_id: z.number().int().positive().nullable().default(null),
    verdict: z.enum(['CORRECT', 'INCORRECT']),
    expected_decision: decisionSchema.nullable().default(null),
    notes: requiredText(4000).min(15),
  })
  .strict();
export const credentialsSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,60}$/),
  password: z.string().min(15).max(128),
  name: requiredText(120),
});
export function positiveId(value: unknown): number {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'Invalid record ID.');
  return parsed.data;
}
export function parseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new HttpError(
      502,
      'The AI returned an invalid response. No qualification was saved. Please retry.',
    );
  }
}

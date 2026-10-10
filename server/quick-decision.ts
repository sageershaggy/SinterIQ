import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { DB, Secrets } from './database';
import { createDecision, type DecisionAnswers, type DecisionQuestions } from './decisions';
import { getJevKey } from './jev';
import { isSharedMailDomain } from './enrich';
import { storedListData } from './import';
import type { fetchWebsite } from './network';
import { HttpError, positiveId } from './validation';
import {
  judgedRule,
  overallFitLevels,
  quickVerdict,
  type JudgedRule,
  type QuickDecision,
  type QuickSummary,
  type QuickVerdict,
} from '../shared/quick-decision';
import { notScreened, type ImportLead } from '../shared/lead-import';
import type { Evidence, Lead, Project, Rubric, TrainingSnapshot, User } from '../shared/types';
import type { ScreenResult } from './import-screen';

/** Jev reads up to 32K tokens; the website text is the bulk and is kept well inside that. */
const websiteLimit = 12_000;
const noteLimit = 600;
const summaryLimit = 600;
const cut = (value: string, limit: number) =>
  value.length > limit ? value.slice(0, limit) + '…' : value;

/**
 * One question per published rule plus an overall impression, asked together: they are
 * independent judgements over the same company, so Jev answers them in parallel in one request.
 * Question ids are for this code only; the meaning is all in the instructions.
 */
export function ruleQuestions(rubric: Rubric): DecisionQuestions {
  const questions: DecisionQuestions = {};
  rubric.criteria.forEach((rule, index) => {
    questions['c' + (index + 1)] = {
      type: 'choice',
      instructions:
        'A qualification rule this project applies to companies: "' +
        rule +
        '". Using only what the state says about the company, does the company meet this rule? A blank or missing detail is not evidence either way.',
      criteria: {
        meets: 'What is known about the company shows it meets this rule',
        does_not_meet: 'What is known about the company shows it does not meet this rule',
        unknown: 'What is known does not settle whether the company meets this rule',
      },
    };
  });
  rubric.exclusions.forEach((rule, index) => {
    questions['x' + (index + 1)] = {
      type: 'choice',
      instructions:
        'An exclusion rule: a company it applies to is not a target for this project. The exclusion: "' +
        rule +
        '". Using only what the state says about the company, does this exclusion apply to it?',
      criteria: {
        applies: 'What is known about the company shows this exclusion applies',
        does_not_apply: 'What is known about the company shows this exclusion does not apply',
        unknown: 'What is known does not settle whether this exclusion applies',
      },
    };
  });
  questions.overall = {
    type: 'score',
    instructions:
      'The project looks for companies like this: "' +
      cut(rubric.summary, summaryLimit) +
      '". Using only what the state says about the company, how well does it fit?',
    criteria: [...overallFitLevels],
  };
  return questions;
}

type Choice = { choice: string; probabilities?: Record<string, number> };
/** Reads Jev's answers back into rule calls and a verdict. */
export function readAnswers(rubric: Rubric, answers: DecisionAnswers) {
  const choice = (id: string) => {
    const answer = answers[id];
    return answer && answer.type === 'choice' ? (answer as Choice) : undefined;
  };
  const criteria: JudgedRule[] = rubric.criteria.map((rule, index) =>
    judgedRule(rule, choice('c' + (index + 1)), { yes: 'meets', no: 'does_not_meet' }),
  );
  const exclusions: JudgedRule[] = rubric.exclusions.map((rule, index) =>
    judgedRule(rule, choice('x' + (index + 1)), { yes: 'applies', no: 'does_not_apply' }),
  );
  const overallAnswer = answers.overall;
  const level =
    overallAnswer && overallAnswer.type === 'score'
      ? Math.max(0, Math.min(overallFitLevels.length - 1, Math.round(overallAnswer.score)))
      : null;
  return {
    criteria,
    exclusions,
    overall: level === null ? null : { level, label: overallFitLevels[level] },
    ...quickVerdict(criteria, exclusions),
  };
}

/**
 * What Jev reads about a company: the record, the team's own list data, facts research proved on
 * the company's website, and the website's text. The contact's name, email address and phone
 * stay out: they are personal data and say nothing about whether the company fits.
 */
export function companyState(parts: {
  lead: Pick<
    Lead,
    'name' | 'website' | 'industry' | 'city' | 'country' | 'employee_count' | 'contact_role' | 'notes'
  > & { contact_email?: string };
  listData: Record<string, string>;
  facts: Array<{ field: string; value: string; evidence: string }>;
  website: { url: string; text: string } | null;
}) {
  const { lead } = parts;
  const lines: string[] = ['Company: ' + lead.name];
  const add = (label: string, value: string | undefined) => {
    if (value && value.trim()) lines.push(label + ': ' + value.trim());
  };
  add('Website', lead.website || 'none on record');
  add('Industry', lead.industry);
  add('Location', [lead.city, lead.country].filter(Boolean).join(', '));
  add('Company size', lead.employee_count);
  add('Contact role', lead.contact_role);
  const domain = /@([a-z0-9.-]+)$/i.exec(lead.contact_email || '')?.[1]?.toLowerCase();
  if (domain && !isSharedMailDomain(domain)) add('Contact email domain', domain);
  add('Team notes (unverified)', cut(lead.notes || '', noteLimit));
  const list = Object.entries(parts.listData);
  if (list.length)
    lines.push(
      'From the team’s own lead list: ' +
        list.map(([label, value]) => label + ': ' + cut(value, 160)).join('; '),
    );
  if (parts.facts.length)
    lines.push(
      'Proved on the company’s own website: ' +
        parts.facts
          .slice(0, 12)
          .map((fact) => fact.field + ' = ' + fact.value + ' (“' + cut(fact.evidence, 200) + '”)')
          .join('; '),
    );
  if (parts.website)
    lines.push(
      'Text from the company’s website (' + parts.website.url + '):\n' + cut(parts.website.text, websiteLimit),
    );
  else lines.push('No text from the company’s website is available.');
  return lines.join('\n');
}

/** The published training a quick decision judges against, or why there is none. */
function publishedRubric(db: DB, project: Project) {
  if (!project.active_version || project.revision !== project.trained_revision)
    throw new HttpError(409, 'Publish the current project training before a quick decision.');
  const row = db
    .prepare('SELECT snapshot_json FROM training_versions WHERE project_id=? AND version=?')
    .get(project.id, project.active_version) as { snapshot_json: string } | undefined;
  if (!row) throw new HttpError(409, 'Publish the current project training before a quick decision.');
  return (JSON.parse(row.snapshot_json) as TrainingSnapshot).rubric;
}

function stored(db: DB, project: Project, lead: { id: number; revision: number }) {
  const row = db
    .prepare('SELECT result_json FROM lead_quick_decisions WHERE project_id=? AND lead_id=?')
    .get(project.id, lead.id) as { result_json: string } | undefined;
  if (!row) return null;
  try {
    const decision = JSON.parse(row.result_json) as QuickDecision;
    decision.stale =
      decision.lead_revision !== lead.revision ||
      decision.training_version !== project.active_version ||
      project.revision !== project.trained_revision;
    return decision;
  } catch {
    return null;
  }
}
export const quickDecisionFor = stored;

/** For the lead list: the latest decision as "VERDICT|score|lead_revision|training_version". */
export const quickSummarySql =
  "(SELECT q.verdict||'|'||q.score||'|'||q.lead_revision||'|'||q.training_version FROM lead_quick_decisions q WHERE q.project_id=l.project_id AND q.lead_id=l.id)";
export function readQuickSummary(raw: unknown, lead: { revision: number }, project: Project): QuickSummary | null {
  if (typeof raw !== 'string') return null;
  const [verdict, score, revision, version] = raw.split('|');
  if (!verdict) return null;
  return {
    verdict: verdict as QuickVerdict,
    score: Number(score) || 0,
    stale:
      Number(revision) !== lead.revision ||
      Number(version) !== project.active_version ||
      project.revision !== project.trained_revision,
  };
}
/**
 * The "Fast decision" filter: the current decision's verdict, or none. A decision about an older
 * version of the lead or the training is not current, so it counts as none.
 */
export function quickVerdictSql(project: Project) {
  const current =
    project.active_version && project.revision === project.trained_revision
      ? 'q.training_version=' + Number(project.active_version)
      : '0';
  return (
    "COALESCE((SELECT q.verdict FROM lead_quick_decisions q WHERE q.project_id=l.project_id AND q.lead_id=l.id AND q.lead_revision=l.revision AND " +
    current +
    "),'NONE')"
  );
}

export function installQuickDecisions(
  app: Express,
  deps: {
    db: DB;
    secrets: Secrets;
    getProject: (db: DB, id: number, user: User) => Project;
    decide: typeof createDecision;
    readWebsite: typeof fetchWebsite;
    limit: RequestHandler;
  },
) {
  const { db, secrets, getProject, decide, readWebsite, limit } = deps;

  function jev() {
    const found = getJevKey(db, secrets);
    if (!found.key)
      throw new HttpError(409, 'Add a Jev key in Settings → Fast decisions first.');
    return found;
  }

  /** The website text Jev reads: the last qualification's pages if any, else the home page now. */
  async function websiteText(project: Project, lead: Lead, readNow: boolean) {
    const run = db
      .prepare(
        'SELECT evidence_json FROM qualification_runs WHERE project_id=? AND lead_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(project.id, lead.id) as { evidence_json: string } | undefined;
    if (run) {
      try {
        const pages = (JSON.parse(run.evidence_json) as Evidence[]).filter(
          (item) => item.kind === 'website' && item.content,
        );
        if (pages.length)
          return {
            url: pages[0].url,
            text: pages.map((page) => page.content).join('\n\n'),
          };
      } catch {
        // An unreadable stored run just means the page is read again.
      }
    }
    if (!readNow || !lead.website) return null;
    try {
      const page = await readWebsite(lead.website);
      return page.content ? { url: page.url, text: page.content } : null;
    } catch {
      return null;
    }
  }

  async function decideLead(project: Project, rubric: Rubric, leadId: number, actor: string) {
    const lead = db
      .prepare('SELECT * FROM leads WHERE id=? AND project_id=?')
      .get(leadId, project.id) as (Lead & { list_data: unknown }) | undefined;
    if (!lead) throw new HttpError(404, 'Lead not found in this project.');
    const { key, model } = jev();
    const facts = db
      .prepare(
        'SELECT field,value,evidence FROM lead_research_citations WHERE project_id=? AND lead_id=? ORDER BY id DESC LIMIT 12',
      )
      .all(project.id, lead.id) as Array<{ field: string; value: string; evidence: string }>;
    const website = await websiteText(project, lead, true);
    const state = companyState({ lead, listData: storedListData(lead.list_data), facts, website });
    const result = await decide({ apiKey: key, model, state, questions: ruleQuestions(rubric) });
    const read = readAnswers(rubric, result.answers);
    const decision: QuickDecision = {
      ...read,
      website_read: Boolean(website),
      model: result.model,
      latency_ms: result.latency_ms,
      lead_revision: lead.revision,
      training_version: project.active_version!,
      created_at: new Date().toISOString(),
      created_by: actor,
      stale: false,
    };
    db.prepare(
      `INSERT INTO lead_quick_decisions
        (project_id,lead_id,lead_revision,training_version,verdict,score,result_json,created_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id,lead_id) DO UPDATE SET lead_revision=excluded.lead_revision,
        training_version=excluded.training_version,verdict=excluded.verdict,score=excluded.score,
        result_json=excluded.result_json,created_at=excluded.created_at,created_by=excluded.created_by`,
    ).run(
      project.id,
      lead.id,
      decision.lead_revision,
      decision.training_version,
      decision.verdict,
      decision.score,
      JSON.stringify(decision),
      decision.created_at,
      actor,
    );
    return decision;
  }

  app.post(
    '/api/projects/:projectId/leads/:leadId/quick-decision',
    limit,
    async (req, res) => {
      const project = getProject(db, positiveId(req.params.projectId), req.user);
      const rubric = publishedRubric(db, project);
      res.json(await decideLead(project, rubric, positiveId(req.params.leadId), req.user.name));
    },
  );

  /** Up to 25 leads per call, five at a time; one failing lead never stops the rest. */
  app.post('/api/projects/:projectId/quick-decisions', limit, async (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = z
      .object({ lead_ids: z.array(z.number().int().positive()).min(1).max(25) })
      .strict()
      .parse(req.body);
    const rubric = publishedRubric(db, project);
    jev();
    const ids = [...new Set(input.lead_ids)];
    const results: Array<{ lead_id: number; decision?: QuickDecision; error?: string }> = [];
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const leadId = ids[next++];
        try {
          results.push({
            lead_id: leadId,
            decision: await decideLead(project, rubric, leadId, req.user.name),
          });
        } catch (error) {
          results.push({
            lead_id: leadId,
            error: error instanceof HttpError ? error.message : 'The decision failed.',
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, ids.length) }, worker));
    res.json({ results: ids.map((id) => results.find((item) => item.lead_id === id)!) });
  });

  /**
   * The import quick screen through Jev, when a Jev key is set: the same rule questions over
   * each row's own data, eight rows at a time. Null when there is no key, so the chat-model
   * screen runs instead. Like that screen it reads the row alone and only advises.
   */
  async function screenWithJev(rubric: Rubric, leads: ImportLead[]): Promise<ScreenResult[] | null> {
    const { key, model } = getJevKey(db, secrets);
    if (!key) return null;
    const questions = ruleQuestions(rubric);
    const results: ScreenResult[] = new Array(leads.length);
    let next = 0;
    // One row's call failing is usually the connection, not the row. An unanswered row is not a
    // verdict and is not remembered, so it would be asked again on the next import and could
    // come back differently — the same list giving different counts. Ask twice here instead.
    const attempts = 2;
    const worker = async () => {
      while (next < leads.length) {
        const index = next++;
        const lead = leads[index];
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            const state = companyState({
              lead,
              listData: lead.list_data ?? {},
              facts: [],
              website: null,
            });
            const read = readAnswers(rubric, (await decide({ apiKey: key, model, state, questions })).answers);
            const met = read.criteria.filter((item) => item.call === 'MEETS');
            results[index] = read.excluded_by
              ? {
                  verdict: 'REJECT',
                  reason: 'Matches exclusion: ' + cut(read.excluded_by, 150) + ' (Jev)',
                  rule: read.excluded_by,
                }
              : met.length
                ? {
                    verdict: 'PASS',
                    reason: 'Fits: ' + cut(met[0].rule, 150) + ' (Jev)',
                    rule: met[0].rule,
                  }
                : {
                    verdict: 'UNCLEAR',
                    reason: 'The row does not say enough to judge the rules (Jev).',
                    rule: '',
                  };
            break;
          } catch {
            results[index] = { verdict: 'UNCLEAR', reason: notScreened, rule: '' };
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, leads.length) }, worker));
    return results;
  }

  return { screenWithJev };
}

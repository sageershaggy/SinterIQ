import type { Express } from 'express';
import { z } from 'zod';
import type { DB } from './database';
import { HttpError, positiveId, text } from './validation';
import { pipelineStatusSql } from './crm';
import {
  ASSIGNED_TO_ANYONE,
  ASSIGNED_TO_ME,
  UNASSIGNED,
  callOutcomeStatus,
  callStatuses,
  dateAddedPresets,
  emailStatuses,
  fitScoreBands,
  fitScoreValues,
  leadSortValues,
  leadStatuses,
  nextStepFilters,
  qualificationStates,
  researchStatuses,
  type LeadFacetOptions,
  type LeadSort,
  type LeadSummary,
  type NextStepFilter,
  type QualificationState,
} from '../shared/lead-filters';
import { nextStepBands, type Project, type User } from '../shared/types';

/**
 * The filter bar's half of the lead query. app.ts spreads this into leadQuerySchema and
 * calls facetWhere from leadFilter, so the table and the CSV export share every facet and sort.
 */
type Param = string | number;

/** A query value that may arrive once (a string) or repeated (an array). */
const many = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
    z.array(item).max(200),
  );
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'That date does not exist.');

export const leadFacetShape = {
  qualification: many(z.enum(qualificationStates)),
  score: many(z.enum(fitScoreValues)),
  next_step: many(z.enum(nextStepFilters)),
  call: many(z.enum(callStatuses)),
  industry: many(text(200)),
  country: many(text(120)),
  city: many(text(120)),
  assignee: many(z.string().regex(/^(none|me|any|[1-9]\d{0,9})$/, 'Unknown assignee.')),
  lead_status: many(z.enum(leadStatuses)),
  email_status: many(z.enum(emailStatuses)),
  research: many(z.enum(researchStatuses)),
  added: z.enum(dateAddedPresets).optional(),
  added_from: day.optional(),
  added_to: day.optional(),
  /** The viewer's offset east of UTC in minutes, so "today" is the viewer's today. */
  tz: z.coerce.number().int().min(-840).max(840).default(0),
  sort: z.enum(leadSortValues).default('updated'),
};
const facetObject = z.object(leadFacetShape);
export type LeadFacetInput = z.infer<typeof facetObject>;

/** Project numbers are inlined into derived expressions, so they must really be integers. */
function integer(value: number) {
  if (!Number.isSafeInteger(value)) throw new Error('Expected an integer.');
  return String(value);
}
// The call map is spliced into SQL as literals. It is a closed constant, but say so in code.
for (const [outcome, status] of Object.entries(callOutcomeStatus))
  if (!/^[A-Z_]+$/.test(outcome + status)) throw new Error('Unsafe call outcome ' + outcome);

/** A result from an older training version, an older lead revision or unpublished training. */
export function staleSql(project: Project) {
  return (
    '(l.training_version IS NOT ' +
    integer(project.active_version ?? 0) +
    ' OR l.qualified_revision IS NOT l.revision' +
    (project.revision !== project.trained_revision ? ' OR 1' : '') +
    ')'
  );
}
/** Mirrors the table badge: a superseded result is "Requalification needed", whatever it said. */
export function qualificationStateSql(project: Project) {
  return (
    "(CASE WHEN l.latest_run_id IS NULL THEN 'RAW' WHEN " +
    staleSql(project) +
    " THEN 'REQUALIFY' WHEN l.status='QUALIFIED' THEN 'QUALIFIED'" +
    " WHEN l.status='NOT_A_TARGET' THEN 'NOT_QUALIFIED' ELSE 'NEEDS_REVIEW' END)"
  );
}
/**
 * A lead's call status, from its assignment and its most recent logged call. The one place it
 * is derived: the Calls screen and anything else that shows a call status should select this.
 * An outcome this build does not know yet counts as a call that happened.
 */
export function callStatusSql() {
  const last =
    '(SELECT c.outcome FROM call_logs c WHERE c.project_id=l.project_id AND c.lead_id=l.id ORDER BY c.id DESC LIMIT 1)';
  const known = Object.entries(callOutcomeStatus)
    .map(([outcome, status]) => "WHEN '" + outcome + "' THEN '" + status + "'")
    .join(' ');
  return (
    '(CASE COALESCE(' +
    last +
    ",'') WHEN '' THEN (CASE WHEN l.assigned_to IS NULL THEN 'NONE' ELSE 'ASSIGNED' END) " +
    known +
    " ELSE 'COMPLETED' END)"
  );
}
/** Lead status: the manual CRM status, New until someone moves it (server/crm.ts). */
export const leadStatusSql = pipelineStatusSql;
/** Email status: the outreach status the mail and funnel code maintains. */
export const emailStatusSql = 'l.outreach_status';
/** Analysed by AI, or has at least one value filled in from its own website. */
export const researchedSql =
  '(l.latest_run_id IS NOT NULL OR EXISTS (SELECT 1 FROM lead_research_citations r WHERE r.project_id=l.project_id AND r.lead_id=l.id))';
/** The facts a qualification leans on — the same test as the NEEDS_RESEARCH view. */
export const missingDetailsSql = "(l.website='' OR l.industry='' OR (l.city='' AND l.country=''))";
/** The same test as the NO_WEBSITE view. */
export const noWebsiteSql = "l.website=''";
/**
 * The outreach step, as nextStepFor (shared/types.ts) derives it for a current result: a lead
 * with no run, a superseded run or no score has none, so the filter and the row always agree.
 */
export function nextStepSql(project: Project, step: NextStepFilter) {
  const band =
    step === 'CALL_READY'
      ? "l.status='QUALIFIED' AND l.score>=" + integer(nextStepBands.call)
      : step === 'SEND_EMAIL'
        ? "l.status='QUALIFIED' AND l.score>=" +
          integer(nextStepBands.email) +
          ' AND l.score<' +
          integer(nextStepBands.call)
        : "(l.status='NEEDS_REVIEW' OR (l.status='QUALIFIED' AND l.score>=" +
          integer(nextStepBands.review) +
          ' AND l.score<' +
          integer(nextStepBands.email) +
          '))';
  return (
    '(l.latest_run_id IS NOT NULL AND l.score IS NOT NULL AND NOT ' +
    staleSql(project) +
    ' AND ' +
    band +
    ')'
  );
}

/**
 * The instants that bound "date added". Presets count whole days in the viewer's time zone,
 * today included; a custom range includes both of its end dates.
 */
export function addedRange(input: LeadFacetInput, nowMs = Date.now()) {
  if (!input.added) return {};
  const offset = input.tz * 60_000;
  const local = new Date(nowMs + offset);
  const start = (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m, d) - offset).toISOString();
  const [y, m, d] = [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()];
  if (input.added === 'TODAY') return { from: start(y, m, d) };
  if (input.added === '7D') return { from: start(y, m, d - 6) };
  if (input.added === '30D') return { from: start(y, m, d - 29) };
  if (!input.added_from && !input.added_to)
    throw new HttpError(400, 'Choose a start or an end date for the custom range.');
  if (input.added_from && input.added_to && input.added_from > input.added_to)
    throw new HttpError(400, 'The custom date range ends before it starts.');
  const parts = (value: string) => value.split('-').map(Number);
  let from: string | undefined, to: string | undefined;
  if (input.added_from) {
    const [fy, fm, fd] = parts(input.added_from);
    from = start(fy, fm - 1, fd);
  }
  if (input.added_to) {
    const [ty, tm, td] = parts(input.added_to);
    to = start(ty, tm - 1, td + 1);
  }
  return { from, to };
}

/**
 * The facet conditions, appended to leadFilter's WHERE. Pushes its parameters onto `params` in
 * placeholder order. Facets AND together; the values inside one facet OR. `viewerId` is the
 * signed-in account, which the Assigned-to facet's "me" means.
 */
export function facetWhere(
  project: Project,
  input: LeadFacetInput,
  params: Param[],
  context: { viewerId: number; nowMs?: number },
) {
  const nowMs = context.nowMs ?? Date.now();
  let where = '';
  const oneOf = (expression: string, values: readonly Param[]) => {
    params.push(...values);
    return ' AND ' + expression + ' IN (' + values.map(() => '?').join(',') + ')';
  };
  const anyOf = (parts: string[]) => (parts.length ? ' AND (' + parts.join(' OR ') + ')' : '');
  if (input.qualification.length)
    where += oneOf(qualificationStateSql(project), input.qualification);
  if (input.score.length)
    where += anyOf(
      fitScoreBands
        .filter((band) => input.score.includes(band.value))
        .map((band) => {
          params.push(band.min, band.max);
          return '(l.score BETWEEN ? AND ?)';
        }),
    );
  if (input.next_step.length)
    where += anyOf(
      nextStepFilters
        .filter((step) => input.next_step.includes(step))
        .map((step) => nextStepSql(project, step)),
    );
  if (input.call.length) where += oneOf(callStatusSql(), input.call);
  // Case-insensitive, as the options are grouped; an empty value selects the blank ones.
  for (const column of ['industry', 'country', 'city'] as const)
    if (input[column].length)
      where += oneOf('trim(l.' + column + ') COLLATE NOCASE', input[column]);
  if (input.assignee.length) {
    const words = [UNASSIGNED, ASSIGNED_TO_ME, ASSIGNED_TO_ANYONE];
    const ids = input.assignee.filter((value) => !words.includes(value)).map(Number);
    if (input.assignee.includes(ASSIGNED_TO_ME)) {
      if (!Number.isSafeInteger(context.viewerId)) throw new Error('No viewer for "me".');
      ids.push(context.viewerId);
    }
    const parts: string[] = [];
    if (ids.length) {
      parts.push('l.assigned_to IN (' + ids.map(() => '?').join(',') + ')');
      params.push(...ids);
    }
    if (input.assignee.includes(UNASSIGNED)) parts.push('l.assigned_to IS NULL');
    if (input.assignee.includes(ASSIGNED_TO_ANYONE)) parts.push('l.assigned_to IS NOT NULL');
    where += anyOf(parts);
  }
  if (input.lead_status.length) where += oneOf(leadStatusSql, input.lead_status);
  if (input.email_status.length) where += oneOf(emailStatusSql, input.email_status);
  if (input.research.length)
    where += anyOf(
      input.research.map((status) =>
        status === 'RESEARCHED'
          ? researchedSql
          : status === 'NOT_RESEARCHED'
            ? 'NOT ' + researchedSql
            : status === 'NO_WEBSITE'
              ? noWebsiteSql
              : missingDetailsSql,
      ),
    );
  const range = addedRange(input, nowMs);
  // julianday() reads both ISO timestamps and the legacy "YYYY-MM-DD HH:MM:SS" form.
  if (range.from) {
    where += ' AND julianday(l.created_at)>=julianday(?)';
    params.push(range.from);
  }
  if (range.to) {
    where += ' AND julianday(l.created_at)<julianday(?)';
    params.push(range.to);
  }
  return where;
}

const orders: Record<LeadSort, string> = {
  updated: 'l.updated_at DESC,l.id DESC',
  added_desc: 'julianday(l.created_at) DESC,l.id DESC',
  added_asc: 'julianday(l.created_at) ASC,l.id ASC',
  name_asc: 'l.name COLLATE NOCASE ASC,l.id ASC',
  name_desc: 'l.name COLLATE NOCASE DESC,l.id DESC',
  // Unscored and blank-industry leads go last in both directions: they are not "lowest".
  score_desc: 'l.score IS NULL,l.score DESC,l.name COLLATE NOCASE,l.id',
  score_asc: 'l.score IS NULL,l.score ASC,l.name COLLATE NOCASE,l.id',
  industry_asc:
    "trim(l.industry)='',trim(l.industry) COLLATE NOCASE ASC,l.name COLLATE NOCASE,l.id",
  industry_desc:
    "trim(l.industry)='',trim(l.industry) COLLATE NOCASE DESC,l.name COLLATE NOCASE,l.id",
};
/** ORDER BY for the list and the export alike. Always ends on the id, so pages never overlap. */
export function leadOrder(sort: LeadSort) {
  return orders[sort];
}

/** Counts for the row above the table, over the unfiltered lead list of the project. */
export function leadSummary(
  db: DB,
  project: Project,
  scope: { where: string; params: Param[] },
): LeadSummary {
  const rows = db
    .prepare(
      'SELECT ' +
        qualificationStateSql(project) +
        ' state,COUNT(*) n FROM leads l WHERE ' +
        scope.where +
        ' GROUP BY state',
    )
    .all(...scope.params) as Array<{ state: QualificationState; n: number }>;
  const count = (state: QualificationState) => rows.find((row) => row.state === state)?.n ?? 0;
  return {
    total: rows.reduce((total, row) => total + row.n, 0),
    raw: count('RAW'),
    qualified: count('QUALIFIED'),
    needs_review: count('NEEDS_REVIEW'),
    not_qualified: count('NOT_QUALIFIED'),
    requalify: count('REQUALIFY'),
  };
}

/**
 * GET /api/projects/:projectId/lead-facets — the values the Industry, Location and Assigned-to
 * facets offer, over the same default view the counts use.
 */
export function installLeadFilters(
  app: Express,
  options: {
    db: DB;
    getProject: (db: DB, id: number, user: User) => Project;
    scope: (project: Project, user: User) => { where: string; params: Param[] };
  },
) {
  const { db, getProject, scope } = options;
  app.get('/api/projects/:projectId/lead-facets', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const { where, params } = scope(project, req.user);
    const values = (column: 'industry' | 'country' | 'city') =>
      db
        .prepare(
          'SELECT MIN(trim(l.' +
            column +
            ')) value,COUNT(*) count FROM leads l WHERE ' +
            where +
            ' GROUP BY trim(l.' +
            column +
            ') COLLATE NOCASE ORDER BY value COLLATE NOCASE LIMIT 500',
        )
        .all(...params) as Array<{ value: string; count: number }>;
    const assigned = db
      .prepare(
        "SELECT CAST(l.assigned_to AS TEXT) value,COALESCE(a.name,'Account #'||l.assigned_to) label,COUNT(*) count FROM leads l LEFT JOIN accounts a ON a.id=l.assigned_to WHERE " +
          where +
          ' AND l.assigned_to IS NOT NULL GROUP BY l.assigned_to ORDER BY label COLLATE NOCASE',
      )
      .all(...params) as LeadFacetOptions['assignee'];
    const unassigned = (
      db
        .prepare('SELECT COUNT(*) n FROM leads l WHERE ' + where + ' AND l.assigned_to IS NULL')
        .get(...params) as { n: number }
    ).n;
    const body: LeadFacetOptions = {
      industry: values('industry'),
      country: values('country'),
      city: values('city'),
      assignee: [{ value: UNASSIGNED, label: 'Unassigned', count: unassigned }, ...assigned],
    };
    res.json(body);
  });
}

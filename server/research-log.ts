import type { Express } from 'express';
import { z } from 'zod';
import { now, type DB } from './database';
import { notifyLead } from './workspace';
import { HttpError, positiveId } from './validation';
import {
  fieldLabel,
  researchLogKinds,
  type QualificationEntry,
  type ResearchFinding,
  type ResearchLogEntry,
  type ResearchLogPage,
  type ResearchPassEntry,
  type ReviewEntry,
} from '../shared/research-log';
import type { Decision, Project, ResearchOutcome, User } from '../shared/types';

/**
 * Notes the research pass wrote itself (which domain redirected, which page did not name the
 * company). Notes relayed from the model are left out: they are unverified and may repeat a
 * personal detail from the page, which must stay erasable with the contact.
 */
function systemNotes(notes: string[]) {
  return notes
    .filter((note) => !note.startsWith('Reported while reading the page'))
    .slice(0, 6)
    .map((note) => note.slice(0, 300));
}

/**
 * Records a finished website research pass — including one that found nothing, because
 * "checked three domains and none named the company" is research that was done — and tells the
 * project team it completed. Called once per pass, after any values were applied.
 */
export function recordResearchPass(
  db: DB,
  projectId: number,
  lead: { id: number; name: string },
  actor: string,
  outcome: ResearchOutcome,
  applied: string[],
) {
  db.prepare(
    `INSERT INTO lead_research_runs
      (project_id,lead_id,website,discovered,tried_json,applied_json,notes_json,refused_count,created_at,created_by)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM leads WHERE id=? AND project_id=?)`,
  ).run(
    projectId,
    lead.id,
    outcome.website || '',
    outcome.discovered ? 1 : 0,
    JSON.stringify(outcome.tried.slice(0, 10)),
    JSON.stringify(applied),
    JSON.stringify(systemNotes(outcome.notes)),
    outcome.refused.length,
    now(),
    actor,
    lead.id,
    projectId,
  );
  notifyLead(
    db,
    projectId,
    lead.id,
    'research',
    lead.name +
      ': research completed — ' +
      (applied.length
        ? 'filled ' + applied.map((field) => fieldLabel(field).toLowerCase()).join(', ')
        : 'nothing new found'),
  );
}

interface CitationRow {
  id: number;
  lead_id: number;
  lead_name: string;
  field: string;
  value: string;
  evidence: string;
  source_url: string;
  created_at: string;
  created_by: string;
}
const finding = (row: CitationRow): ResearchFinding => ({
  field: row.field,
  value: row.value,
  evidence: row.evidence,
  source_url: row.source_url,
});
const parseList = (value: unknown) => {
  try {
    const list = JSON.parse(String(value ?? '[]'));
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

export function installResearchLog(
  app: Express,
  db: DB,
  getProject: (db: DB, id: number, user: User) => Project,
) {
  /**
   * The research record of a project, newest first: every website research pass (what it
   * checked, and each value it wrote with the sentence and page behind it), every qualification
   * run and every human review. Narrowed to one lead with lead_id; paged with `before`.
   */
  app.get('/api/projects/:projectId/research-log', (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = z
      .object({
        lead_id: z.coerce.number().int().positive().optional(),
        kind: z.enum(['all', 'research', 'qualification', 'review']).default('all'),
        before: z.iso.datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(40),
      })
      .parse(req.query);
    const lead = input.lead_id
      ? (db
          .prepare('SELECT id,name FROM leads WHERE id=? AND project_id=?')
          .get(input.lead_id, project.id) as { id: number; name: string } | undefined)
      : undefined;
    if (input.lead_id && !lead) throw new HttpError(404, 'Lead not found.');
    const wants = (kind: (typeof researchLogKinds)[number]) =>
      input.kind === 'all' || input.kind === kind;
    const take = input.limit + 1;
    /** Every query is confined to this project, and to one lead when asked. */
    const scope = (owner: string, time = owner) => {
      const where = [owner + '.project_id=?'];
      const params: Array<string | number> = [project.id];
      if (lead) {
        where.push(owner + '.lead_id=?');
        params.push(lead.id);
      }
      if (input.before) {
        where.push(time + '.created_at<?');
        params.push(input.before);
      }
      return { where: where.join(' AND '), params };
    };
    let truncated = false;
    const entries: ResearchLogEntry[] = [];

    if (wants('research')) {
      const passes = scope('r');
      const runs = db
        .prepare(
          `SELECT r.*,l.name lead_name FROM lead_research_runs r
          JOIN leads l ON l.id=r.lead_id AND l.project_id=r.project_id
          WHERE ${passes.where} ORDER BY r.id DESC LIMIT ?`,
        )
        .all(...passes.params, take) as Array<Record<string, unknown>>;
      // A pass keeps field names only; the value and its quote are the citation written with
      // it: the newest citation for that lead and field made no later than the pass itself.
      const leadIds = [...new Set(runs.map((run) => Number(run.lead_id)))];
      const citations = leadIds.length
        ? (db
            .prepare(
              `SELECT * FROM lead_research_citations WHERE project_id=? AND lead_id IN (${leadIds.map(() => '?').join(',')})
              ORDER BY id DESC`,
            )
            .all(project.id, ...leadIds) as CitationRow[])
        : [];
      for (const run of runs) {
        const applied = parseList(run.applied_json);
        const found: ResearchFinding[] = [];
        const erased: string[] = [];
        for (const field of applied) {
          const cited = citations.find(
            (row) =>
              row.lead_id === run.lead_id &&
              row.field === field &&
              row.created_at <= String(run.created_at),
          );
          if (cited) found.push(finding(cited));
          else erased.push(field);
        }
        entries.push({
          kind: 'research',
          id: 'research-' + run.id,
          lead_id: Number(run.lead_id),
          lead_name: String(run.lead_name),
          created_at: String(run.created_at),
          created_by: String(run.created_by),
          website: String(run.website),
          discovered: Boolean(run.discovered),
          tried: parseList(run.tried_json),
          found,
          erased,
          refused_count: Number(run.refused_count),
          notes: parseList(run.notes_json),
        } satisfies ResearchPassEntry);
      }
      // Citations written before passes were recorded have no pass row. Rows of one pass were
      // written together, so consecutive citations for one lead by one person, seconds apart,
      // are gathered back into the pass they came from.
      const since = (
        db.prepare("SELECT value FROM meta WHERE key='research_runs_since'").get() as
          { value: string } | undefined
      )?.value;
      if (since) {
        const older = scope('c');
        const cap = take * 9;
        const rows = db
          .prepare(
            `SELECT c.*,l.name lead_name FROM lead_research_citations c
            JOIN leads l ON l.id=c.lead_id AND l.project_id=c.project_id
            WHERE ${older.where} AND c.created_at<? ORDER BY c.id DESC LIMIT ?`,
          )
          .all(...older.params, since, cap) as CitationRow[];
        const groups: CitationRow[][] = [];
        for (const row of rows) {
          const group = groups[groups.length - 1];
          const last = group?.[group.length - 1];
          if (
            last &&
            last.lead_id === row.lead_id &&
            last.created_by === row.created_by &&
            Date.parse(last.created_at) - Date.parse(row.created_at) <= 5000
          )
            group.push(row);
          else groups.push([row]);
        }
        // The oldest group may continue past the cap; it is read whole on the next page.
        if (rows.length === cap && groups.length > 1) {
          groups.pop();
          truncated = true;
        }
        for (const group of groups) {
          const newest = group[0];
          const site = group.find((row) => row.field === 'website');
          entries.push({
            kind: 'research',
            id: 'citation-' + newest.id,
            lead_id: newest.lead_id,
            lead_name: newest.lead_name,
            created_at: newest.created_at,
            created_by: newest.created_by,
            website: site?.value || newest.source_url,
            discovered: Boolean(site),
            tried: [],
            found: [...group].reverse().map(finding),
            erased: [],
            refused_count: 0,
            notes: [],
          } satisfies ResearchPassEntry);
        }
      }
    }

    if (wants('qualification')) {
      const runs = scope('r');
      const rows = db
        .prepare(
          `SELECT r.id,r.lead_id,l.name lead_name,r.training_version,r.created_at,r.created_by,
            json_extract(r.result_json,'$.decision') decision,
            json_extract(r.result_json,'$.score') score,
            json_extract(r.result_json,'$.confidence') confidence,
            json_extract(r.result_json,'$.summary') summary,
            (SELECT COUNT(*) FROM json_each(r.result_json,'$.criteria')) criteria_total,
            (SELECT COUNT(*) FROM json_each(r.result_json,'$.criteria')
              WHERE json_extract(value,'$.outcome')='MATCH') criteria_met,
            (SELECT COUNT(*) FROM json_each(r.result_json,'$.criteria')
              WHERE json_extract(value,'$.outcome')='UNKNOWN') criteria_unknown,
            (SELECT COUNT(*) FROM json_each(r.result_json,'$.exclusions')
              WHERE json_extract(value,'$.outcome')='MATCH') exclusions_hit,
            (SELECT json_group_array(value) FROM json_each(r.result_json,'$.gaps')) gaps,
            (SELECT json_group_array(json_extract(value,'$.url')) FROM json_each(r.evidence_json)
              WHERE json_extract(value,'$.kind')='website') pages
          FROM qualification_runs r JOIN leads l ON l.id=r.lead_id AND l.project_id=r.project_id
          WHERE ${runs.where} ORDER BY r.id DESC LIMIT ?`,
        )
        .all(...runs.params, take) as Array<Record<string, unknown>>;
      for (const row of rows)
        entries.push({
          kind: 'qualification',
          id: 'qualification-' + row.id,
          run_id: Number(row.id),
          lead_id: Number(row.lead_id),
          lead_name: String(row.lead_name),
          created_at: String(row.created_at),
          created_by: String(row.created_by),
          training_version: Number(row.training_version),
          decision: String(row.decision) as Decision,
          score: Number(row.score) || 0,
          confidence: Number(row.confidence) || 0,
          summary: String(row.summary ?? '').slice(0, 600),
          criteria_total: Number(row.criteria_total),
          criteria_met: Number(row.criteria_met),
          criteria_unknown: Number(row.criteria_unknown),
          exclusions_hit: Number(row.exclusions_hit),
          gaps: parseList(row.gaps)
            .slice(0, 5)
            .map((gap) => gap.slice(0, 300)),
          pages: parseList(row.pages).slice(0, 6),
        } satisfies QualificationEntry);
    }

    if (wants('review')) {
      const reviews = scope('r', 'v');
      const rows = db
        .prepare(
          `SELECT v.id,v.run_id,v.decision,v.notes,v.created_by,v.created_at,r.lead_id,l.name lead_name
          FROM reviews v JOIN qualification_runs r ON r.id=v.run_id
          JOIN leads l ON l.id=r.lead_id AND l.project_id=r.project_id
          WHERE ${reviews.where} ORDER BY v.id DESC LIMIT ?`,
        )
        .all(...reviews.params, take) as Array<Record<string, unknown>>;
      for (const row of rows)
        entries.push({
          kind: 'review',
          id: 'review-' + row.id,
          run_id: Number(row.run_id),
          lead_id: Number(row.lead_id),
          lead_name: String(row.lead_name),
          created_at: String(row.created_at),
          created_by: String(row.created_by),
          decision: String(row.decision) as Decision,
          notes: String(row.notes).slice(0, 600),
        } satisfies ReviewEntry);
    }

    entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = entries.slice(0, input.limit);
    const more = truncated || entries.length > input.limit;
    res.json({
      entries: page,
      next_before: more && page.length ? page[page.length - 1].created_at : null,
      lead: lead ? { id: lead.id, name: lead.name } : null,
    } satisfies ResearchLogPage);
  });
}

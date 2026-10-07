import type { Express } from 'express';
import { z } from 'zod';
import { audit, now, websiteKey, type DB } from './database';
import { researchMissing, researchableFields, type ResearchTraining } from './enrich';
import type { AiConfig, Generate, ResearchContext } from './ai';
import type { WebsitePage } from './network';
import type { CrawledPage } from './crawl';
import type { ResearchSearch } from './research-settings';
import { HttpError, leadSchema, positiveId } from './validation';
import { recordResearchPass } from './research-log';
import { stopContactSequences } from './funnels';
import { currentOrigin, leadFieldHistory, recordFieldChanges } from './field-history';
import {
  conflictFields,
  type ConflictField,
  type Evidence,
  type Lead,
  type Project,
  type ResearchOutcome,
  type ResearchableField,
  type TrainingSnapshot,
  type User,
} from '../shared/types';
import {
  rolesSought,
  type FieldCitation,
  type LeadContact,
  type QualificationResearch,
  type ResearchFact,
  type ResearchProfile,
  type ResearchRunSummary,
} from '../shared/research';

/** Comparison form for a person's name, so one person found twice is listed once. */
const nameKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const blank = (lead: Lead) =>
  researchableFields.filter((field) => !String(lead[field] ?? '').trim()) as ResearchableField[];

/**
 * Lead research as the application runs it: the pass in server/enrich.ts, the gap-only write
 * of what it proved, the people it found, and the research log. Used by the manual "Research
 * missing details" action and by qualification, which researches a record before judging it.
 */
export function createLeadResearch(deps: {
  db: DB;
  getProject: (db: DB, id: number, user?: User) => Project;
  generate: Generate;
  fetchPage?: (url: string) => Promise<WebsitePage>;
  /** Web search for this pass, read when it starts (the key or the setting may have changed). */
  search?: () => ResearchSearch;
}) {
  const { db } = deps;

  /** The rules qualification will apply: the published version, or the draft before one. */
  function trainingFor(project: Project): ResearchTraining {
    const row = project.active_version
      ? (db
          .prepare('SELECT snapshot_json FROM training_versions WHERE project_id=? AND version=?')
          .get(project.id, project.active_version) as { snapshot_json: string } | undefined)
      : undefined;
    const rubric = row
      ? (JSON.parse(row.snapshot_json) as TrainingSnapshot).rubric
      : project.rubric;
    return {
      summary: rubric.summary,
      criteria: rubric.criteria,
      exclusions: rubric.exclusions,
      categories: rubric.categories ?? [],
    };
  }
  function readLead(projectId: number, leadId: number) {
    const row = db
      .prepare('SELECT * FROM leads WHERE id=? AND project_id=?')
      .get(leadId, projectId) as Lead | undefined;
    if (!row) throw new HttpError(404, 'Lead not found in this project.');
    return row;
  }
  function runs(projectId: number, leadId: number, limit = 20): ResearchRunSummary[] {
    return (
      db
        .prepare(
          'SELECT * FROM lead_research_runs WHERE project_id=? AND lead_id=? ORDER BY id DESC LIMIT ?',
        )
        .all(projectId, leadId, limit) as Array<Record<string, unknown>>
    ).map(({ summary_json, project_id: _p, lead_id: _l, ...row }) => ({
      ...(JSON.parse(String(summary_json)) as Omit<
        ResearchRunSummary,
        'id' | 'origin' | 'lead_revision' | 'result_revision' | 'created_at' | 'created_by'
      >),
      ...(row as Pick<
        ResearchRunSummary,
        'id' | 'origin' | 'lead_revision' | 'result_revision' | 'created_at' | 'created_by'
      >),
    }));
  }
  /** The pass that already ran on exactly this revision of the record, if one did. */
  function researchedAt(projectId: number, leadId: number, revision: number) {
    const row = db
      .prepare(
        'SELECT id FROM lead_research_runs WHERE project_id=? AND lead_id=? AND result_revision=? ORDER BY id DESC LIMIT 1',
      )
      .get(projectId, leadId, revision) as { id: number } | undefined;
    return row ? runs(projectId, leadId, 50).find((run) => run.id === row.id) : undefined;
  }

  /**
   * One research pass, written back the way a person's edit would be: inside a transaction
   * against a freshly read lead, only into blanks, through the lead form's own validators, with
   * the revision moved and the review cleared. The people found are added alongside, never in
   * place of, the record's own contact.
   */
  async function run(options: {
    project: Project;
    lead: Lead;
    actor: string;
    origin: 'manual' | 'qualification';
    config: AiConfig;
    /** Receives the pages read, for a qualification that follows straight away. */
    onPages?: (pages: CrawledPage[]) => void;
  }) {
    const { project, lead, actor, origin, config } = options;
    const searching = deps.search?.() ?? { off: '' };
    const outcome: ResearchOutcome = await researchMissing({
      lead,
      config,
      generate: deps.generate,
      fetchPage: deps.fetchPage,
      training: trainingFor(project),
      search: searching.search,
      searchOff: searching.off,
      onPages: options.onPages,
    });
    const applied: ResearchableField[] = [];
    const replaced: string[] = [];
    let contactsAdded = 0;
    const fieldSchemas = leadSchema.shape as Record<string, z.ZodTypeAny>;
    db.transaction(() => {
      // Re-read inside the transaction. The pass spends real time on the network, and
      // someone may have typed the very value we are about to write: research fills gaps,
      // it never overwrites what a person entered.
      const current = db
        .prepare('SELECT * FROM leads WHERE id=? AND project_id=?')
        .get(lead.id, project.id) as Record<string, string | number> | undefined;
      if (!current) throw new HttpError(404, 'Lead not found in this project.');
      const site = outcome.proposals.find((proposal) => proposal.field === 'website');
      const clash = site
        ? (db
            .prepare(
              "SELECT name FROM leads WHERE project_id=? AND id<>? AND website_key=? AND website_key<>''",
            )
            .get(project.id, lead.id, websiteKey(site.value)) as { name: string } | undefined)
        : undefined;
      if (clash) {
        // The site belongs to another lead here, so this record is most likely a duplicate
        // of that one. Nothing read from that page is written, not merely the address.
        for (const proposal of outcome.proposals)
          outcome.refused.push({
            field: proposal.field,
            value: proposal.value,
            reason:
              'That website already belongs to ' +
              clash.name +
              ' in this project, so this lead may be a duplicate of it. Nothing was saved.',
          });
        if (outcome.contacts?.length)
          outcome.notes.push(
            'The people named on that website were not saved either, for the same reason.',
          );
        // Nor is anything it says kept for the qualification: it describes the other lead.
        outcome.facts = [];
        outcome.opportunities = [];
      } else {
        for (const proposal of outcome.proposals) {
          // The column name comes from this closed list, never from the response.
          if (!researchableFields.includes(proposal.field)) continue;
          const previous = String(current[proposal.field] ?? '');
          if (previous.trim()) {
            // Filled while the pass ran (it researches blanks only). Research wins over imported
            // data, never over a person: a company detail the import wrote (or earlier research)
            // is replaced by what the site states; one a person typed, or one nothing recorded
            // the origin of, is left alone. A website or a contact is never replaced.
            const detail = (conflictFields as readonly string[]).includes(proposal.field)
              ? (proposal.field as ConflictField)
              : null;
            const origin = detail && currentOrigin(db, project.id, lead.id, detail, previous);
            const held = previous.trim().toLowerCase() === proposal.value.trim().toLowerCase();
            if (held || (origin !== 'import' && origin !== 'research')) {
              outcome.refused.push({
                field: proposal.field,
                value: proposal.value,
                reason: held
                  ? 'The record already holds this value.'
                  : origin === 'person'
                    ? 'A person entered this value, so research left it alone.'
                    : 'This was filled in while the research was running, so it was left alone.',
              });
              continue;
            }
          }
          // The same validator the edit form uses, so research can never write a value a
          // person could not have typed, and the lead stays saveable afterwards.
          const parsed = fieldSchemas[proposal.field]?.safeParse(proposal.value);
          if (!parsed?.success) {
            outcome.refused.push({
              field: proposal.field,
              value: proposal.value,
              reason: 'The lead form would not accept that value, so it was not saved.',
            });
            continue;
          }
          const value = parsed.data as string;
          if (proposal.field === 'website')
            db.prepare('UPDATE leads SET website=?,website_key=? WHERE id=? AND project_id=?').run(
              value,
              websiteKey(value),
              lead.id,
              project.id,
            );
          else
            db.prepare('UPDATE leads SET ' + proposal.field + '=? WHERE id=? AND project_id=?').run(
              value,
              lead.id,
              project.id,
            );
          current[proposal.field] = value;
          // Keep the provenance with the value, not only in this response.
          db.prepare(
            `INSERT INTO lead_research_citations
              (project_id,lead_id,field,value,evidence,source_url,created_at,created_by)
            VALUES (?,?,?,?,?,?,?,?)`,
          ).run(
            project.id,
            lead.id,
            proposal.field,
            value,
            proposal.evidence,
            proposal.source_url,
            now(),
            actor,
          );
          // And the value it replaced, so an imported value research overwrote stays on record.
          recordFieldChanges(db, {
            projectId: project.id,
            leadId: lead.id,
            before: { [proposal.field]: previous },
            after: { [proposal.field]: value },
            origin: 'research',
            actor,
            evidence: proposal.evidence,
            sourceUrl: proposal.source_url,
          });
          if (previous.trim()) replaced.push(proposal.field + ' (was "' + previous + '")');
          applied.push(proposal.field);
        }
        // People are kept only from the site that is now this lead's own website, so a page
        // that was read but not accepted as the company's never contributes a person.
        const onRecordSite =
          websiteKey(String(current.website || '')) !== '' &&
          websiteKey(String(current.website)) === websiteKey(outcome.website);
        if (onRecordSite)
          for (const contact of outcome.contacts || []) {
            const inserted = db
              .prepare(
                `INSERT OR IGNORE INTO lead_contacts
                  (project_id,lead_id,name,name_key,role,role_category,email,phone,source_url,evidence,created_at,created_by)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                project.id,
                lead.id,
                contact.name,
                nameKey(contact.name),
                contact.role,
                contact.role_category,
                contact.email,
                contact.phone,
                contact.source_url,
                contact.evidence,
                now(),
                actor,
              );
            contactsAdded += inserted.changes;
          }
        if (applied.length) {
          db.prepare(
            'UPDATE leads SET revision=revision+1,reviewed=0,updated_at=? WHERE id=? AND project_id=?',
          ).run(now(), lead.id, project.id);
          audit(
            db,
            project.id,
            actor,
            'lead.researched',
            'Filled ' +
              applied.join(', ') +
              ' for ' +
              lead.name +
              ' from ' +
              outcome.website +
              '.' +
              // Company details only (never a contact), so the old value may sit here.
              (replaced.length ? ' Imported value replaced: ' + replaced.join(', ') + '.' : ''),
          );
        }
        // Counted, not named: the audit log is not a place to copy personal data into.
        if (contactsAdded)
          audit(
            db,
            project.id,
            actor,
            'lead.contacts_found',
            contactsAdded +
              (contactsAdded === 1 ? ' person' : ' people') +
              ' found on the website of ' +
              lead.name +
              '.',
          );
      }
      const after = db
        .prepare('SELECT revision FROM leads WHERE id=? AND project_id=?')
        .get(lead.id, project.id) as { revision: number };
      // If someone edited the record while the pass ran, this pass did not see that version,
      // so it must not count as research of it.
      const clean = Number(current.revision) === lead.revision;
      db.prepare(
        `INSERT INTO lead_research_runs
          (project_id,lead_id,origin,lead_revision,result_revision,summary_json,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        project.id,
        lead.id,
        origin,
        lead.revision,
        clean ? after.revision : 0,
        JSON.stringify({
          website: outcome.website,
          discovered: outcome.discovered,
          tried: outcome.tried,
          pages: outcome.pages || [],
          applied,
          // Reasons only: a refused value may be a personal detail that was never proven.
          refused: outcome.refused.map(({ field, reason }) => ({ field, reason })),
          // The pass's own checks; the model's free-text remarks are not kept.
          notes: outcome.notes.filter((note) => !note.startsWith('Reported while reading')),
          contacts_added: contactsAdded,
          facts: outcome.facts || [],
          opportunities: outcome.opportunities || [],
          searches: outcome.searches || [],
          pages_read: outcome.pages_read || [],
          ...(outcome.person_record ? { person_record: true } : {}),
        }),
        now(),
        actor,
      );
    })();
    // The Research history log and its "research completed" update (server/research-log.ts).
    recordResearchPass(db, project.id, lead, actor, outcome, applied, origin);
    return { ...outcome, applied, contacts_added: contactsAdded };
  }

  /** A short account of a pass for the qualification that follows it. */
  function summarize(
    pass: Pick<
      ResearchRunSummary,
      | 'website'
      | 'discovered'
      | 'applied'
      | 'contacts_added'
      | 'tried'
      | 'notes'
      | 'searches'
      | 'opportunities'
      | 'person_record'
    >,
    ran: boolean,
    origin: 'manual' | 'qualification',
  ): QualificationResearch {
    const checked = [
      ...(pass.tried.length ? ['Candidate websites checked: ' + pass.tried.join(', ') + '.'] : []),
      ...(pass.searches || []).map(
        (search) =>
          'Searched the web for “' +
          search.query +
          '”: ' +
          (search.error
            ? 'the search failed.'
            : search.verified
              ? search.verified + ' verified.'
              : search.results.length
                ? search.results.length + ' result(s), none verified.'
                : 'no results.'),
      ),
      ...pass.notes,
    ].slice(0, 10);
    return {
      ran,
      origin,
      website: pass.website,
      website_found: Boolean(pass.website),
      filled: pass.applied,
      contacts_added: pass.contacts_added,
      checked,
      searches: pass.searches || [],
      opportunities: pass.opportunities?.length || 0,
      ...(pass.person_record ? { person_record: true } : {}),
    };
  }

  /**
   * Research before judging. A record with blank fields is researched first, once per revision:
   * a pass that already ran on this exact version of the record is reused rather than repeated,
   * because it would read the same pages and find the same things. That includes the revision
   * the pass itself created by filling a field (lead_research_runs.result_revision), so a new
   * qualification run or job never starts the same research over.
   */
  async function beforeQualification(options: {
    project: Project;
    lead: Lead;
    actor: string;
    config: AiConfig;
  }): Promise<{
    research: QualificationResearch | null;
    facts: ResearchFact[];
    opportunities: ResearchFact[];
    /** The company pages this pass read just now, when it ran. */
    pages: CrawledPage[];
  }> {
    const { project, lead } = options;
    const previous = researchedAt(project.id, lead.id, lead.revision);
    if (previous)
      return {
        research: summarize(previous, false, previous.origin),
        facts: previous.facts,
        opportunities: previous.opportunities || [],
        pages: [],
      };
    if (!blank(lead).length) return { research: null, facts: [], opportunities: [], pages: [] };
    let pages: CrawledPage[] = [];
    const outcome = await run({
      ...options,
      origin: 'qualification',
      onPages: (read) => (pages = read),
    });
    return {
      research: summarize(
        {
          website: outcome.website,
          discovered: outcome.discovered,
          applied: outcome.applied,
          contacts_added: outcome.contacts_added,
          tried: outcome.tried,
          notes: outcome.notes.filter((note) => !note.startsWith('Reported while reading')),
          searches: outcome.searches,
          opportunities: outcome.opportunities,
          person_record: outcome.person_record,
        },
        true,
        'qualification',
      ),
      facts: outcome.facts || [],
      opportunities: outcome.opportunities || [],
      pages,
    };
  }

  /**
   * What research did, in one sentence, for a lead it could not find anything for: the blocker
   * "Not enough found to judge" says what was searched, so nobody has to wonder whether anyone
   * looked.
   */
  function searchedSummary(research: QualificationResearch | null) {
    if (!research) return 'no research could be run and the record has no website or list data.';
    const parts: string[] = [];
    for (const search of research.searches || [])
      parts.push(
        'searched the web for “' +
          search.query +
          '”' +
          (search.error ? ' (the search failed)' : search.results.length ? '' : ' (no results)'),
      );
    const tried = research.checked.find((line) => line.startsWith('Candidate websites checked:'));
    if (tried) parts.push(tried.replace(/^Candidate websites checked: /, 'checked ').replace(/\.$/, ''));
    if (!(research.searches || []).length) {
      const off = research.checked.find((line) => /web search/i.test(line));
      parts.push(off ? off.replace(/\.$/, '').toLowerCase() : 'no web search was run');
    }
    return (
      'no company website could be verified and there is no list data. Research ' +
      (research.ran ? '' : '(already run on this version of the record) ') +
      parts.join('; ') +
      '.'
    ).slice(0, 600);
  }

  /** The research citations behind the values the record holds now, newest first. */
  function citations(projectId: number, lead: Lead): FieldCitation[] {
    const rows = db
      .prepare(
        'SELECT field,value,evidence,source_url,created_at,created_by FROM lead_research_citations WHERE project_id=? AND lead_id=? ORDER BY id DESC',
      )
      .all(projectId, lead.id) as FieldCitation[];
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (seen.has(row.field)) return false;
      seen.add(row.field);
      return String(lead[row.field] ?? '').trim() === row.value;
    });
  }

  /**
   * What the evaluation is told about where each detail came from, and one evidence item that
   * carries the research findings with their sentences. That item is website evidence: every
   * line in it is a quote checked against a page of the company's own site.
   */
  function qualificationContext(
    project: Project,
    lead: Lead,
    research: QualificationResearch | null,
    facts: ResearchFact[],
    nextId: string,
    opportunities: ResearchFact[] = [],
  ): {
    origin: Record<string, 'record' | 'research'>;
    evidence: Evidence | null;
    context: ResearchContext | undefined;
    recordOnly: Record<string, string>;
  } {
    const cited = citations(project.id, lead);
    const origin: Record<string, 'record' | 'research'> = {};
    const recordOnly: Record<string, string> = {};
    for (const field of researchableFields) {
      const value = String(lead[field] ?? '').trim();
      if (!value) continue;
      const fromResearch = cited.some((item) => item.field === field);
      origin[field] = fromResearch ? 'research' : 'record';
      if (!fromResearch && !field.startsWith('contact_')) recordOnly[field] = value;
    }
    // Opportunity first: the evaluation looks for what the project could do for the company
    // before it weighs an exclusion, and these are the company's own words about it.
    const lines = [
      ...opportunities.map(
        (item) => 'Opportunity (' + item.rule + '): “' + item.quote + '” (' + item.source_url + ')',
      ),
      ...cited.map(
        (item) =>
          item.field +
          ': ' +
          item.value +
          (item.evidence ? ' — “' + item.evidence + '”' : ' — verified as the company’s own site') +
          ' (' +
          item.source_url +
          ')',
      ),
      ...facts.map(
        (fact) => 'On "' + fact.rule + '": “' + fact.quote + '” (' + fact.source_url + ')',
      ),
    ];
    const url =
      lead.website ||
      cited[0]?.source_url ||
      opportunities[0]?.source_url ||
      facts[0]?.source_url ||
      '';
    return {
      origin,
      recordOnly,
      evidence:
        lines.length && url
          ? {
              id: nextId,
              kind: 'website',
              title: 'Details found by research on the company website',
              url,
              content: lines.join('\n').slice(0, 8000),
              captured_at: now(),
            }
          : null,
      context: research
        ? {
            ran: research.ran,
            website_found: research.website_found,
            filled: research.filled,
            checked: research.checked,
            opportunities_found: opportunities.length,
            ...(research.person_record ? { record_names_person: true } : {}),
          }
        : undefined,
    };
  }

  function contactsOf(project: Project, leadId: number): LeadContact[] {
    const training = trainingFor(project);
    const sought = rolesSought([training.summary, ...training.criteria]);
    return (
      db
        .prepare(
          'SELECT id,project_id,lead_id,name,role,role_category,email,phone,source_url,evidence,created_at,created_by FROM lead_contacts WHERE project_id=? AND lead_id=? ORDER BY id',
        )
        .all(project.id, leadId) as LeadContact[]
    )
      .map((contact) => ({
        ...contact,
        relevant:
          sought.categories.includes(contact.role_category) ||
          sought.phrases.some((phrase) => contact.role.toLowerCase().includes(phrase)),
      }))
      .sort((a, b) => Number(b.relevant) - Number(a.relevant) || a.id - b.id);
  }

  function install(app: Express) {
    const scope = (req: { params: Record<string, string>; user: User }) => {
      const project = deps.getProject(db, positiveId(req.params.projectId), req.user);
      return { project, lead: readLead(project.id, positiveId(req.params.leadId)) };
    };
    /** Where each detail on the record came from, the people found, and the research log. */
    app.get('/api/projects/:projectId/leads/:leadId/research-profile', (req, res) => {
      const { project, lead } = scope(req);
      const training = trainingFor(project);
      const profile: ResearchProfile = {
        citations: citations(project.id, lead),
        contacts: contactsOf(project, lead.id),
        runs: runs(project.id, lead.id),
        roles_sought: rolesSought([training.summary, ...training.criteria]),
        // Who set each company detail, and the imported value research replaced.
        history: leadFieldHistory(db, project.id, lead.id),
      };
      res.json(profile);
    });
    /**
     * The people on a lead, each with a stable id. This is what campaign enrolment reads to
     * address a particular person rather than the lead's primary contact.
     */
    app.get('/api/projects/:projectId/leads/:leadId/contacts', (req, res) => {
      const { project, lead } = scope(req);
      res.json(contactsOf(project, lead.id));
    });
    // Erasure. The row holds the quote that names the person, so deleting it deletes the
    // citation too; nothing about them is left behind in the research log. Whatever campaign
    // mail was still due to reach them stops in the same transaction.
    app.delete('/api/projects/:projectId/leads/:leadId/contacts/:contactId', (req, res) => {
      const { project, lead } = scope(req);
      const contactId = positiveId(req.params.contactId);
      db.transaction(() => {
        const result = db
          .prepare('DELETE FROM lead_contacts WHERE id=? AND project_id=? AND lead_id=?')
          .run(contactId, project.id, lead.id);
        if (!result.changes) throw new HttpError(404, 'Contact not found on this lead.');
        stopContactSequences(db, project.id, lead.id, [contactId]);
        audit(db, project.id, req.user.name, 'lead.contact_removed', lead.name);
      })();
      res.json(contactsOf(project, lead.id));
    });
    app.delete('/api/projects/:projectId/leads/:leadId/contacts', (req, res) => {
      const { project, lead } = scope(req);
      db.transaction(() => {
        const ids = (
          db
            .prepare('SELECT id FROM lead_contacts WHERE project_id=? AND lead_id=?')
            .all(project.id, lead.id) as Array<{ id: number }>
        ).map((row) => row.id);
        const result = db
          .prepare('DELETE FROM lead_contacts WHERE project_id=? AND lead_id=?')
          .run(project.id, lead.id);
        stopContactSequences(db, project.id, lead.id, ids);
        audit(
          db,
          project.id,
          req.user.name,
          'lead.contact_removed',
          lead.name + ': ' + result.changes + ' researched contact(s) erased.',
        );
      })();
      res.json([]);
    });
  }

  return { run, beforeQualification, qualificationContext, searchedSummary, install };
}

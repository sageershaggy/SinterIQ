import express, { type Express, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { audit, nameKey, now, websiteKey, type DB, type Secrets } from './database';
import { getAiConfig, type Generate } from './ai';
import { notifyProject } from './notifications';
import { checkedUrl } from './network';
import { importLimits, listData, mapImportRows, readImportRows, storedListData } from './import';
import { screenRows, type ScreenResult } from './import-screen';
import { HttpError, leadSchema, positiveId } from './validation';
import {
  screenBatchSize,
  type ImportLead,
  type ImportPreview,
  type ImportProblem,
  type ScreenVerdict,
} from '../shared/lead-import';
import type { Lead, Project, Rubric, TrainingSnapshot, User } from '../shared/types';

/*
 * Lead import: the checks every row passes and the one transaction every import writes through,
 * plus the preview → quick screen → chosen rows flow the import dialog uses. The one-shot file
 * route in app.ts shares the checks and the write, so the two can never import differently.
 */
const fieldLabels: Record<string, string> = {
  name: 'Company name',
  website: 'Website',
  country: 'Country',
  city: 'City',
  industry: 'Industry',
  employee_count: 'Employees',
  contact_name: 'Contact name',
  contact_role: 'Job title',
  contact_email: 'Contact email',
  contact_phone: 'Contact phone',
  notes: 'Notes',
  list_data: 'The other columns',
};
/**
 * An imported row's list data, which only the import path accepts: leadSchema stays the lead
 * form's contract, so an edit can neither send nor clear it. Whatever arrives is cleaned by the
 * same rule as a file read (listData), so a hand-made request cannot store personal details.
 */
const listDataSchema = z.record(z.string(), z.union([z.string(), z.number()])).transform(listData);
/** A row as the import path accepts it: the lead form's fields plus its list data. */
const importLeadSchema = leadSchema.extend({ list_data: listDataSchema.default({}) });
/** Turns a validator issue into something a person reading a spreadsheet can act on. */
function friendlyIssue(path: string, message: string) {
  const label = fieldLabels[path] || 'This row';
  if (/expected string to have >=1|too small/i.test(message)) return label + ' is empty.';
  if (/at most|too big|>=?d+ characters/i.test(message)) return label + ' is too long.';
  if (/email/i.test(message)) return label + ' is not a valid email address.';
  if (/phone/i.test(message)) return label + ' is not a valid phone number.';
  if (/http/i.test(message)) return label + ' must be a complete http(s) address.';
  return label + ': ' + message;
}
/**
 * Validates one imported row. Reasons name the field in plain words — never a raw validator
 * message. An unusable website must not cost us the company: blank it, keep the lead, and
 * say so — the researcher can add the real address and qualify it afterwards.
 */
export function checkImportLead(
  candidate: Record<string, unknown>,
): { ok: true; value: ImportLead; warning: string } | { ok: false; reason: string } {
  const row = { ...candidate };
  let warning = '';
  if (typeof row.website === 'string' && row.website) {
    const supplied = row.website;
    let usable = false;
    try {
      usable = checkedUrl(supplied).hostname.includes('.');
    } catch {
      usable = false;
    }
    if (!usable) {
      row.website = '';
      warning =
        'Imported without a website: "' +
        supplied.slice(0, 120) +
        '" is not a usable public address. Add the real website, then qualify the lead.';
    }
  }
  const parsed = importLeadSchema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: friendlyIssue(String(issue.path[0] ?? ''), issue.message) };
  }
  return { ok: true, value: parsed.data, warning };
}
/** A file with nothing importable is refused outright, naming the first problem. */
export function requireImportable(count: number, problems: ImportProblem[]) {
  if (!count)
    throw new HttpError(
      400,
      'Nothing in that file could be imported as a company lead. This importer creates companies, so each row needs a Company Name (or Name) value. ' +
        (problems.length
          ? 'First problem — row ' + problems[0].row + ': ' + problems[0].reason
          : ''),
    );
}
/** The lead in this project a company would duplicate: same name key, or same website domain. */
export function findDuplicate(db: DB, projectId: number, lead: { name: string; website: string }) {
  // Two indexed probes rather than one OR across two columns: SQLite cannot use either of
  // leads_project_name / leads_project_website for the OR, so it scanned the whole project
  // once per imported row — 5,000 rows against 1,200 existing leads is six million rows of
  // scanning inside a single transaction.
  const byKey = (column: string, value: string) =>
    value
      ? (db
          .prepare('SELECT id,name FROM leads WHERE project_id=? AND ' + column + '=? LIMIT 1')
          .get(projectId, value) as { id: number; name: string } | undefined)
      : undefined;
  return byKey('name_key', nameKey(lead.name)) || byKey('website_key', websiteKey(lead.website));
}
export function insertLead(db: DB, projectId: number, lead: ImportLead) {
  const duplicate = findDuplicate(db, projectId, lead);
  if (duplicate) return { duplicate };
  const id = Number(
    db
      .prepare(
        'INSERT INTO leads (project_id,name,name_key,website,website_key,country,city,industry,employee_count,contact_name,contact_role,contact_email,contact_phone,notes,list_data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        projectId,
        lead.name,
        nameKey(lead.name),
        lead.website,
        websiteKey(lead.website),
        lead.country,
        lead.city,
        lead.industry,
        lead.employee_count,
        lead.contact_name,
        lead.contact_role,
        lead.contact_email,
        lead.contact_phone,
        lead.notes,
        JSON.stringify(lead.list_data ?? {}),
        now(),
        now(),
      ).lastInsertRowid,
  );
  return { id };
}
/**
 * Writes validated leads in one transaction. A company already in the project is skipped, or
 * with 'update' given the values this import carries. The file route and the chosen-rows route
 * both write through here, so a screened import can never store, match or record differently
 * from a plain one.
 */
export function importLeads(
  db: DB,
  options: {
    project: Project;
    actor: string;
    leads: ImportLead[];
    onDuplicate: 'skip' | 'update';
    /** Further counts for the audit line, in words. Counts only: never row contents. */
    notes: string[];
  },
) {
  const { project, leads } = options;
  return db.transaction(() => {
    let updated = 0;
    const createdIds: number[] = [];
    const duplicates: string[] = [];
    for (const lead of leads) {
      const result = insertLead(db, project.id, lead);
      if (!result.duplicate) {
        createdIds.push(result.id);
        continue;
      }
      if (options.onDuplicate !== 'update') {
        duplicates.push(lead.name);
        continue;
      }
      // Only fill in values the CSV actually carries, so a sparse row never blanks a lead.
      const current = db
        .prepare('SELECT * FROM leads WHERE id=? AND project_id=?')
        .get(result.duplicate.id, project.id) as Omit<Lead, 'list_data'> & { list_data: string };
      const stored = storedListData(current.list_data);
      const merged = {
        // The same site written another way ("acme.de" for the "https://www.acme.de/" research
        // found) is not a change: it must not make the lead look new and send it back to research.
        website:
          lead.website && websiteKey(lead.website) !== websiteKey(current.website)
            ? lead.website
            : current.website,
        country: lead.country || current.country,
        industry: lead.industry || current.industry,
        notes: lead.notes || current.notes,
        // The list's columns merge: a new value replaces the same column, the others stay.
        list_data: JSON.stringify(listData({ ...stored, ...lead.list_data })),
      };
      const changedFields =
        merged.website !== current.website ||
        merged.country !== current.country ||
        merged.industry !== current.industry ||
        merged.notes !== current.notes ||
        merged.list_data !== JSON.stringify(stored);
      if (!changedFields) {
        duplicates.push(lead.name);
        continue;
      }
      db.prepare(
        'UPDATE leads SET website=?,website_key=?,country=?,industry=?,notes=?,list_data=?,revision=revision+1,reviewed=0,updated_at=? WHERE id=? AND project_id=?',
      ).run(
        merged.website,
        websiteKey(merged.website),
        merged.country,
        merged.industry,
        merged.notes,
        merged.list_data,
        now(),
        result.duplicate.id,
        project.id,
      );
      updated++;
    }
    const created = createdIds.length;
    audit(
      db,
      project.id,
      options.actor,
      'leads.imported',
      [
        created + ' created',
        updated + ' updated',
        duplicates.length + ' unchanged duplicates skipped',
        ...options.notes,
      ].join('; ') + '.',
    );
    if (created || updated)
      notifyProject(
        db,
        project.id,
        'leads_imported',
        `Leads imported: ${created} new, ${updated} updated`,
      );
    return { updated, created, skipped: duplicates.length, duplicates, created_ids: createdIds };
  })();
}

/**
 * Chosen rows arrive as one JSON body, which for a full 5,000-row file is far above the 1 MB
 * every other route accepts: the file itself may be 4 MB, an .xlsx is compressed, and JSON
 * repeats each field name on every row. That route parses its own body (app.ts skips it), and
 * only after sign-in and a project check, so nobody can make the server read 16 MB anonymously.
 */
export const importRowsPath = /^\/api\/projects\/[^/]+\/leads\/import\/rows\/?$/i;
const importRowsBodyLimit = '16mb';

const rowsSchema = z
  .object({
    leads: z.array(z.record(z.string(), z.unknown())).min(1).max(importLimits.rows),
    on_duplicate: z.enum(['skip', 'update']).default('skip'),
    // What the quick screen left out, for the audit line. Counts only: rejected rows are never sent.
    screened: z
      .object({
        rejected: z.number().int().min(0).max(importLimits.rows),
        unclear: z.number().int().min(0).max(importLimits.rows),
      })
      .strict()
      .optional(),
  })
  .strict();

export function installLeadImport(
  app: Express,
  options: {
    db: DB;
    secrets: Secrets;
    getProject: (db: DB, id: number, user: User) => Project;
    generate: Generate;
    /** True when an AI provider can be called: a saved key, or a model a test injected. */
    aiReady: () => boolean;
    /** The quick screen through Jev when a Jev key is set; null means use the chat model. */
    screenWithJev?: (rubric: Rubric, leads: ImportLead[]) => Promise<ScreenResult[] | null>;
    upload: RequestHandler;
    fileLimit: RequestHandler;
  },
) {
  const { db, getProject } = options;
  const trainingReady = (project: Project) =>
    Boolean(project.active_version) && project.revision === project.trained_revision;
  // Its own budget rather than the shared 100 AI runs: a 600-row file is only 15 batches, but
  // a full 5,000-row file is 125, and screening a list must not use up the qualification that
  // follows it. 150 batches is one full file with room to stop and carry on.
  const screenLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 150,
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error:
        'Quick-screen limit reached (150 batches of 40 rows per 15 minutes). Wait, then screen the rest.',
    },
  });

  /**
   * Reads and checks a file exactly as the import does, and saves nothing: the rows that can be
   * imported, the ones that cannot and why, and which companies are already in this project.
   */
  app.post(
    '/api/projects/:projectId/leads/import/preview',
    options.fileLimit,
    options.upload,
    async (req, res) => {
      const project = getProject(db, positiveId(req.params.projectId), req.user);
      if (!req.file) throw new HttpError(400, 'Choose a file to import.');
      const raw = await readImportRows(req.file.originalname, req.file.buffer);
      const { leads, lines, problems, warnings } = mapImportRows(raw, checkImportLead);
      requireImportable(leads.length, problems);
      const columns = [...new Set(raw.flatMap((row) => Object.keys(row)))].filter(Boolean);
      const preview: ImportPreview = {
        total: raw.length,
        columns,
        rows: leads.map((lead, i) => ({
          row: lines[i],
          lead,
          // Header is line 1, so line n is raw row n - 2.
          cells: columns.map((column) => raw[lines[i] - 2][column] ?? ''),
          duplicate: findDuplicate(db, project.id, lead) || null,
        })),
        problems,
        warnings,
        screening: !trainingReady(project)
          ? {
              available: false,
              reason:
                'Publish the current training first; the quick screen checks rows against it.',
            }
          : !options.aiReady()
            ? {
                available: false,
                reason: 'No AI provider is set up yet. An administrator can add one in Settings.',
              }
            : { available: true, reason: '' },
      };
      res.json(preview);
    },
  );

  /**
   * Quick-screens one batch of rows against the published training. The browser sends the
   * file in batches so it can show progress and stop; the server keeps nothing. A row that is
   * already in this project is answered from the project's own duplicate matching and never
   * reaches the AI.
   */
  app.post('/api/projects/:projectId/leads/import/screen', screenLimit, async (req, res) => {
    const project = getProject(db, positiveId(req.params.projectId), req.user);
    const input = z
      .object({
        rows: z
          .array(importLeadSchema)
          .min(1)
          .max(screenBatchSize, 'Send at most ' + screenBatchSize + ' rows per quick screen.'),
      })
      .strict()
      .parse(req.body);
    if (!trainingReady(project))
      throw new HttpError(409, 'Publish the current project training before quick-screening rows.');
    const version = db
      .prepare('SELECT snapshot_json FROM training_versions WHERE project_id=? AND version=?')
      .get(project.id, project.active_version) as { snapshot_json: string };
    const snapshot = JSON.parse(version.snapshot_json) as TrainingSnapshot;
    const verdicts: ScreenVerdict[] = [];
    const pending: Array<{ index: number; lead: ImportLead }> = [];
    input.rows.forEach((lead, index) => {
      const duplicate = findDuplicate(db, project.id, lead);
      if (duplicate)
        verdicts[index] = {
          index,
          verdict: 'DUPLICATE',
          reason: 'Already in this project as ' + duplicate.name + '.',
          rule: '',
          duplicate,
        };
      else pending.push({ index, lead });
    });
    if (pending.length) {
      const rows = pending.map((item) => item.lead);
      // Jev answers each row in about a second; without a Jev key the chat model screens.
      const fast = await options.screenWithJev?.(snapshot.rubric, rows);
      if (!fast && !options.aiReady())
        throw new HttpError(409, 'Configure an AI provider or a Jev key in Settings first.');
      const results =
        fast ?? (await screenRows(getAiConfig(db, options.secrets), snapshot.rubric, rows, options.generate));
      pending.forEach((item, i) => (verdicts[item.index] = { index: item.index, ...results[i] }));
    }
    res.json({ verdicts });
  });

  /**
   * Imports the rows the person chose after the preview, through the same validation and the
   * same transaction as a file import. Every row is checked before any is written, so one bad
   * row imports nothing.
   */
  app.post(
    '/api/projects/:projectId/leads/import/rows',
    options.fileLimit,
    (req, _res, next) => {
      getProject(db, positiveId(req.params.projectId), req.user);
      next();
    },
    express.json({ limit: importRowsBodyLimit }),
    (req, res) => {
      const project = getProject(db, positiveId(req.params.projectId), req.user);
      const input = rowsSchema.parse(req.body);
      const leads: ImportLead[] = [];
      const warnings: ImportProblem[] = [];
      input.leads.forEach((candidate, index) => {
        const result = checkImportLead(candidate);
        const name = typeof candidate.name === 'string' ? candidate.name.slice(0, 200) : '';
        if (!result.ok)
          throw new HttpError(
            400,
            'Lead ' +
              (index + 1) +
              (name ? ' (' + name + ')' : '') +
              ': ' +
              result.reason +
              ' Nothing was imported.',
          );
        leads.push(result.value);
        if (result.warning) warnings.push({ row: index + 1, name, reason: result.warning });
      });
      const notes = [warnings.length + ' imported without a usable website'];
      if (input.screened)
        notes.push(
          'quick screen left out ' +
            input.screened.rejected +
            ' rejected and ' +
            input.screened.unclear +
            ' unclear or unscreened rows',
        );
      const results = importLeads(db, {
        project,
        actor: req.user.name,
        leads,
        onDuplicate: input.on_duplicate,
        notes,
      });
      res.json({
        ...results,
        total: leads.length,
        warned: warnings.length,
        warnings: warnings.slice(0, 50),
      });
    },
  );
}

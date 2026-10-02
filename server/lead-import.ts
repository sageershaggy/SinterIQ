import type { z } from 'zod';
import { audit, nameKey, now, websiteKey, type DB } from './database';
import { notifyProject } from './notifications';
import { checkedUrl } from './network';
import type { RowProblem } from './import';
import { HttpError, leadSchema } from './validation';
import type { Lead, Project } from '../shared/types';

type ImportLead = z.infer<typeof leadSchema>;

/*
 * Lead import: the checks every row passes and the one transaction every import writes through.
 * The one-shot file route in app.ts uses both.
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
};
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
  const parsed = leadSchema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: friendlyIssue(String(issue.path[0] ?? ''), issue.message) };
  }
  return { ok: true, value: parsed.data, warning };
}
/** A file with nothing importable is refused outright, naming the first problem. */
export function requireImportable(count: number, problems: RowProblem[]) {
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
        'INSERT INTO leads (project_id,name,name_key,website,website_key,country,city,industry,employee_count,contact_name,contact_role,contact_email,contact_phone,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
        .get(result.duplicate.id, project.id) as Lead;
      const merged = {
        website: lead.website || current.website,
        country: lead.country || current.country,
        industry: lead.industry || current.industry,
        notes: lead.notes || current.notes,
      };
      const changedFields =
        merged.website !== current.website ||
        merged.country !== current.country ||
        merged.industry !== current.industry ||
        merged.notes !== current.notes;
      if (!changedFields) {
        duplicates.push(lead.name);
        continue;
      }
      db.prepare(
        'UPDATE leads SET website=?,website_key=?,country=?,industry=?,notes=?,revision=revision+1,reviewed=0,updated_at=? WHERE id=? AND project_id=?',
      ).run(
        merged.website,
        websiteKey(merged.website),
        merged.country,
        merged.industry,
        merged.notes,
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

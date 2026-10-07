/**
 * The import dialog's contract with the server (server/lead-import.ts). A file is read and
 * checked without saving anything, its rows can be quick-screened against the published
 * training in small batches, and only the rows the person then chooses are imported.
 */

/**
 * Rows per quick-screen request. Small enough to stay one cheap AI call and for Stop to take
 * effect within seconds; a 600-row file is 15 requests.
 */
export const screenBatchSize = 40;

/** The reason given for a row the screen did not answer. */
export const notScreened = 'Not screened';

/**
 * The columns of an uploaded list that are not lead fields — an event, a booth, a funding round —
 * as label → value. Kept with the lead as the team's own data, never checked on the web, and
 * cleaned of personal details on the server whichever route it arrives through.
 */
export type ListData = Record<string, string>;

/** One company as the importer validated it: the fields the lead form saves, and the list data. */
export interface ImportLead {
  name: string;
  website: string;
  country: string;
  city: string;
  industry: string;
  employee_count: string;
  contact_name: string;
  contact_role: string;
  contact_email: string;
  contact_phone: string;
  notes: string;
  /** Import only: the lead form never sends it, so an edit can never wipe it. */
  list_data?: ListData;
}
/** A row that cannot be imported, or that imports with something dropped. */
export interface ImportProblem {
  /** Line in the file; the header is line 1. */
  row: number;
  name: string;
  reason: string;
}
export interface PreviewRow {
  /** Line in the file; the header is line 1. */
  row: number;
  lead: ImportLead;
  /** The row as it was in the file, in the order of ImportPreview.columns. */
  cells: string[];
  /** The lead already in this project that the import would match this row to. */
  duplicate: { id: number; name: string } | null;
  /**
   * The file line of an earlier row in this same file that is the same company (same name or
   * website domain, matched as the import matches leads), or null. Such a row is counted once:
   * it is never screened and never imported a second time, so adding the same leads to a file
   * again does not change the counts.
   */
  repeat_of?: number | null;
}
export interface ImportPreview {
  /** Data rows read from the file. */
  total: number;
  /** The file's columns, as the importer reads them. */
  columns: string[];
  /** Every row that can be imported, in file order. */
  rows: PreviewRow[];
  problems: ImportProblem[];
  warnings: ImportProblem[];
  /** Whether the quick screen can run for this project now, and if not, why not. */
  screening: { available: boolean; reason: string };
}
export type ScreenOutcome = 'PASS' | 'REJECT' | 'UNCLEAR';
export interface ScreenVerdict {
  /** Position of the row in the screen request. */
  index: number;
  /** DUPLICATE: the row matches a lead already in the project and was never sent to the AI. */
  verdict: ScreenOutcome | 'DUPLICATE';
  reason: string;
  /** The approved criterion or exclusion the verdict relies on, word for word; '' when none. */
  rule: string;
  duplicate?: { id: number; name: string };
  /**
   * True when this exact row was screened before against the same published training and its
   * verdict was reused (server/screen-cache.ts) rather than asked again.
   */
  reused?: boolean;
}
export interface ImportRowsResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  /** Names of the companies already in the project that were left unchanged. */
  duplicates: string[];
  /** The new leads, so the detailed qualification can be started on exactly these. */
  created_ids: number[];
  warned: number;
  warnings: ImportProblem[];
}

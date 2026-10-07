import crypto from 'node:crypto';
import type { DB } from './database';

/**
 * The same thing twice gets the same answer once. Additive only: a new table, new columns with
 * defaults, and a derived value filled into one of those new columns.
 *
 * - import_screen_verdicts: the import quick screen's verdict for a row, keyed by project, the
 *   published training version it was judged against and a SHA-256 of the row's screened fields
 *   (screenFingerprint in server/import-screen.ts). Screening the same row again against the same
 *   version reuses it, so the same list gives the same counts every time. It holds the verdict,
 *   its one-line reason and rule — never the row, a company name field or a contact. Entries for
 *   other versions of the project are dropped whenever the project's screen writes, and the rows
 *   go with their project, which project deletion finds from project_id.
 * - sources.file_sha256: a SHA-256 of the uploaded file's bytes, so a file already in the library
 *   is refused before it is read again. Filled once from the stored original for older sources;
 *   '' for notes and website captures, which have no file.
 * - source_uploads.file_sha256: the same for every upload attempt, so the log can say that a
 *   failed attempt's file is in the library now. source_uploads.duplicate_of: the library copy an
 *   attempt was refused as a duplicate of, set to NULL if that copy is removed (sources ids are
 *   reused, so a dangling id would point at another document).
 */
export function installDedupeSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_screen_verdicts (
      project_id INTEGER NOT NULL REFERENCES projects(id),
      training_version INTEGER NOT NULL,
      row_hash TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('PASS','REJECT','UNCLEAR')),
      reason TEXT NOT NULL,
      rule TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, training_version, row_hash)
    );
  `);
  const has = (table: string, column: string) =>
    (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>).some(
      (info) => info.name === column,
    );
  if (!has('sources', 'file_sha256'))
    db.exec("ALTER TABLE sources ADD COLUMN file_sha256 TEXT NOT NULL DEFAULT ''");
  if (!has('source_uploads', 'file_sha256'))
    db.exec("ALTER TABLE source_uploads ADD COLUMN file_sha256 TEXT NOT NULL DEFAULT ''");
  if (!has('source_uploads', 'duplicate_of'))
    db.exec(
      'ALTER TABLE source_uploads ADD COLUMN duplicate_of INTEGER REFERENCES sources(id) ON DELETE SET NULL',
    );
  // One blob at a time: a library can hold 30 files of up to 5 MB each.
  const pending = db
    .prepare("SELECT id FROM sources WHERE file_sha256='' AND original IS NOT NULL")
    .all() as Array<{ id: number }>;
  const read = db.prepare('SELECT original FROM sources WHERE id=?');
  const fill = db.prepare('UPDATE sources SET file_sha256=? WHERE id=?');
  for (const { id } of pending) {
    const row = read.get(id) as { original: Buffer | null } | undefined;
    if (row?.original)
      fill.run(crypto.createHash('sha256').update(row.original).digest('hex'), id);
  }
}

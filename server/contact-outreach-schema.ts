import type { DB } from './database';

/**
 * Campaign enrollment for the people research found on a company's own website (lead_contacts).
 * Additive: every existing enrollment keeps its row, its id and its meaning.
 *
 * - funnel_enrollments gains contact_id. NULL is the lead's primary contact, which is what every
 *   existing row already is; a number is the lead_contacts row that sequence mails. It carries no
 *   foreign key on purpose: erasing a person must never be blocked by their outreach history,
 *   and ON DELETE SET NULL would silently turn their sequence into one for the primary contact.
 *   Erasure stops the sequence instead (stopContactSequences in server/funnels.ts).
 * - The one-per-(funnel, lead) key becomes one per (funnel, lead, recipient), so two people at
 *   one company can be in the same campaign. one_active_funnel_per_recipient is untouched: a
 *   person is still in at most one running sequence anywhere in the workspace.
 */
export function installContactOutreachSchema(db: DB) {
  rekeyEnrollments(db);
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('funnel_enrollments') as
    Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'contact_id'))
    db.exec('ALTER TABLE funnel_enrollments ADD COLUMN contact_id INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS enrollments_contact
    ON funnel_enrollments(project_id,lead_id,contact_id) WHERE contact_id IS NOT NULL`);
}

/**
 * SQLite cannot alter a UNIQUE constraint, so an enrollment table still keyed on
 * (funnel_id,lead_id) is rebuilt once, the way server/crm-schema.ts widens the call log: the
 * stored CREATE statement is copied with only that key replaced (so any column added since, by
 * anyone, survives), every row is copied with its id, the AUTOINCREMENT counter is carried over
 * (a delivery key names an enrollment id, so an id must never be handed out twice), and the
 * table's own indexes are recreated. Afterwards the stored statement has the new key, so this
 * never runs again.
 */
function rekeyEnrollments(db: DB) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='funnel_enrollments'")
    .get() as { sql: string } | undefined;
  if (!table) return;
  const oldKey = /UNIQUE\s*\(\s*funnel_id\s*,\s*lead_id\s*\)/i;
  if (!oldKey.test(table.sql)) return;
  const rekeyed = table.sql
    .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["'`[]?funnel_enrollments["'`\]]?/i, () => {
      return 'CREATE TABLE funnel_enrollments_rekeyed';
    })
    .replace(oldKey, () => 'UNIQUE(funnel_id,lead_id,recipient)');
  if (!rekeyed.startsWith('CREATE TABLE funnel_enrollments_rekeyed'))
    throw new Error('The enrollment schema has an unexpected shape; not rebuilding it.');
  const indexes = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='funnel_enrollments' AND sql IS NOT NULL",
      )
      .all() as Array<{ sql: string }>
  ).map((row) => row.sql);
  const sequence = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name='funnel_enrollments'")
    .get() as { seq: number } | undefined;
  // The documented way to rebuild a table: rows are copied as they are, and nothing else in the
  // schema refers to this table, so no reference can dangle while it is briefly renamed.
  const enforced = Boolean(db.pragma('foreign_keys', { simple: true }));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS funnel_enrollments_rekeyed');
      db.exec(rekeyed);
      db.exec('INSERT INTO funnel_enrollments_rekeyed SELECT * FROM funnel_enrollments');
      db.exec('DROP TABLE funnel_enrollments');
      db.exec('ALTER TABLE funnel_enrollments_rekeyed RENAME TO funnel_enrollments');
      for (const sql of indexes) db.exec(sql);
      if (sequence) {
        const updated = db
          .prepare(
            "UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='funnel_enrollments'",
          )
          .run(sequence.seq);
        if (!updated.changes)
          db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('funnel_enrollments',?)").run(
            sequence.seq,
          );
      }
    })();
  } finally {
    if (enforced) db.pragma('foreign_keys = ON');
  }
}

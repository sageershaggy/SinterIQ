import type { DB } from './database';

/**
 * Funnel reporting: when a funnel last changed, whether it counts opens, and the opens
 * themselves. Additive only: new columns with defaults and a new table.
 *
 * - funnels.updated_at is backfilled from created_at, so "Recently updated" has a value for
 *   every funnel from the start. It moves on an edit, a start or pause, the open-counting
 *   switch and new enrollments, not on each message the worker sends.
 * - funnels.track_opens is "Count opens", on unless an administrator turns it off. It only
 *   decides whether messages not yet sent carry the image, so existing funnels count opens from
 *   their next message on.
 * - funnel_message_opens holds one row per funnel message that carried the image. The address
 *   in the image holds a random token; only its SHA-256 is kept here, as with unsubscribe
 *   tokens, so a copy of the database cannot be used to record opens. Nothing about the reader
 *   is stored: no IP address, no user agent, only when the message was first opened and how
 *   often the image was fetched. enrollment_id carries no foreign key, like
 *   funnel_enrollments.contact_id: the rows go with their lead (ON DELETE CASCADE) and with
 *   their project, which project deletion finds from project_id.
 */
export function installFunnelTrackingSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS funnel_message_opens (
      token_hash TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      enrollment_id INTEGER NOT NULL, step INTEGER NOT NULL,
      created_at TEXT NOT NULL, first_opened_at TEXT, open_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS funnel_message_opens_enrollment
      ON funnel_message_opens(project_id, enrollment_id);
  `);
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('funnels') as Array<{
    name: string;
  }>;
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has('updated_at'))
    db.exec("ALTER TABLE funnels ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
  if (!has('track_opens'))
    db.exec('ALTER TABLE funnels ADD COLUMN track_opens INTEGER NOT NULL DEFAULT 1');
  db.prepare("UPDATE funnels SET updated_at=created_at WHERE updated_at=''").run();
}

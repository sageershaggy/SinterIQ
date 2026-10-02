import type { DB } from './database';

/**
 * Additive column for service categories (server/ai.ts). Nothing here rewrites an existing row.
 *
 * leads.service_fit: the categories the lead's latest qualification rates GOOD or POSSIBLE, as a
 * JSON array of {category, fit} with GOOD first, written in the same transaction as the status
 * and score. It is the lead list's copy of what the run says, kept so the list can show and
 * filter on it without reading every run; the run itself stays the record. Like the score it is
 * superseded, not cleared, when the training or the lead changes: the list shows it as stale.
 */
export function installServiceFitSchema(db: DB) {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('leads') as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'service_fit'))
    db.exec("ALTER TABLE leads ADD COLUMN service_fit TEXT NOT NULL DEFAULT '[]'");
}

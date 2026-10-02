import type { DB } from './database';

/**
 * Additive column for the lead list's own data (server/import.ts). Nothing here rewrites an
 * existing row.
 *
 * leads.list_data: the columns of an imported list that are not lead fields — an event, a booth,
 * a funding round — as a JSON object of label → value, cleaned by listData before it is written.
 * It is the team's data, never checked on the web, and qualification may cite it as such. Only an
 * import writes it: the lead form neither sends nor clears it, and it never holds personal details.
 */
export function installListDataSchema(db: DB) {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('leads') as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'list_data'))
    db.exec("ALTER TABLE leads ADD COLUMN list_data TEXT NOT NULL DEFAULT '{}'");
}

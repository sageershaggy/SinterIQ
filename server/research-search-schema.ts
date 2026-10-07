import type { DB } from './database';

/**
 * Additive columns for the Research history log (research_log_passes, server/activity-schema.ts):
 * the web searches a pass ran with the addresses they returned, and the company pages it read
 * with the kind of page each was. Older passes keep the empty defaults. Nothing is rewritten.
 */
export function installResearchSearchSchema(db: DB) {
  const columns = (
    db.prepare("SELECT name FROM pragma_table_info('research_log_passes')").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  for (const column of ['searches_json', 'pages_json'])
    if (!columns.includes(column))
      db.exec(
        'ALTER TABLE research_log_passes ADD COLUMN ' + column + " TEXT NOT NULL DEFAULT '[]'",
      );
}

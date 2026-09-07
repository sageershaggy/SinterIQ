import { audit, hash, now, type DB } from './database';
import { fetchWebsite } from './network';

// Capture the starter project's official website once. Later source changes are explicit user actions.
export async function bootstrapWebsite(db: DB) {
  if (db.prepare("SELECT 1 FROM meta WHERE key='starter_website_attempted'").get()) return;
  const starter = db
    .prepare('SELECT id,revision,website FROM projects WHERE id=1 AND name=?')
    .get('Sintertechnik') as { id: number; revision: number; website: string } | undefined;
  if (starter?.revision === 1 && starter.website === 'https://www.sintertechnik.com/') {
    try {
      const page = await fetchWebsite(starter.website);
      db.transaction(() => {
        db.prepare(
          'INSERT INTO sources (project_id,kind,title,url,content,sha256,created_at) VALUES (?,?,?,?,?,?,?)',
        ).run(
          starter.id,
          'website',
          'Sintertechnik · official website',
          page.url,
          page.content,
          hash(page.content),
          now(),
        );
        db.prepare(
          'UPDATE projects SET revision=revision+1,updated_at=? WHERE id=? AND revision=1',
        ).run(now(), starter.id);
        audit(
          db,
          starter.id,
          'Migration',
          'source.added',
          'Official Sintertechnik website captured for the starter training library.',
        );
      })();
    } catch {
      audit(
        db,
        starter.id,
        'Migration',
        'source.capture_pending',
        'The starter website was unavailable. Capture it from the Training library when available.',
      );
    }
  }
  db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run(
    'starter_website_attempted',
    now(),
  );
}

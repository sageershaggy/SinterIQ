import { now, type DB } from './database';
import type { ScreenResult } from './import-screen';
import { notScreened } from '../shared/lead-import';

/**
 * The import quick screen's memory (import_screen_verdicts, server/dedupe-schema.ts): one verdict
 * per project, published training version and row fingerprint (screenFingerprint). A row screened
 * once is answered the same way every later time against that version, whichever batch it lands
 * in, whatever rows surround it and whichever tab asks — so the same list always gives the same
 * counts. A new published version is a new question and is screened afresh.
 *
 * Only real answers are kept: a row that came back "Not screened" (the provider failed or left it
 * out) is asked again next time rather than remembered as unanswered.
 */
export function createScreenCache(db: DB) {
  const select = db.prepare(
    `SELECT verdict,reason,rule FROM import_screen_verdicts
    WHERE project_id=? AND training_version=? AND row_hash=?`,
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO import_screen_verdicts
      (project_id,training_version,row_hash,verdict,reason,rule,created_at)
    VALUES (?,?,?,?,?,?,?)`,
  );
  const prune = db.prepare(
    'DELETE FROM import_screen_verdicts WHERE project_id=? AND training_version<>?',
  );

  /** The remembered verdicts for these fingerprints, by fingerprint. */
  function read(projectId: number, version: number, fingerprints: Iterable<string>) {
    const found = new Map<string, ScreenResult>();
    for (const fingerprint of new Set(fingerprints)) {
      const row = select.get(projectId, version, fingerprint) as ScreenResult | undefined;
      if (row) found.set(fingerprint, { verdict: row.verdict, reason: row.reason, rule: row.rule });
    }
    return found;
  }

  /**
   * Remembers new answers and returns what is now remembered for them. The first answer stored
   * wins: two tabs screening the same rows at once both report the one that was kept, so they
   * cannot disagree. Answers for the project's other versions are dropped, since only the
   * published version is ever screened against.
   */
  function write(projectId: number, version: number, answers: Map<string, ScreenResult>) {
    db.transaction(() => {
      prune.run(projectId, version);
      for (const [fingerprint, answer] of answers)
        if (answer.reason !== notScreened)
          insert.run(
            projectId,
            version,
            fingerprint,
            answer.verdict,
            answer.reason,
            answer.rule,
            now(),
          );
    })();
    const kept = read(projectId, version, answers.keys());
    return new Map([...answers].map(([key, answer]) => [key, kept.get(key) ?? answer]));
  }

  return { read, write };
}

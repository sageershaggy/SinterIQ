import type { Express } from 'express';
import { z } from 'zod';
import { audit, hash, now, type DB } from './database';
import { HttpError, positiveId } from './validation';
import type { Project, Qualification, TrainingSnapshot, User } from '../shared/types';
import type {
  SourceDuplicate,
  SourceUpload,
  TrainingGraph,
} from '../shared/research';

/** A source as the library compares it: its text, and the fingerprint of the file it came from. */
interface LibrarySource {
  id: number;
  title: string;
  content: string;
  file_sha256: string;
  created_at: string;
}
/** The same text however it is spaced or wrapped: a re-saved file reads the same. */
const textKey = (content: string) => hash(content.replace(/\s+/g, ' ').trim());
/** The same title, ignoring case and spacing. */
const titleKey = (title: string) => title.replace(/\s+/g, ' ').trim().toLowerCase();
const day = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(at);
};

/**
 * Refusal of content the library already holds. It names the copy, so the person can find the
 * one that was read, and the upload log keeps which copy it was (source_uploads.duplicate_of).
 */
export class DuplicateSource extends HttpError {
  constructor(readonly source: { id: number; title: string; created_at: string }) {
    super(409, 'Already in the library as ' + source.title + ' (added ' + day(source.created_at) + ').');
  }
}

/**
 * The training library's record of what happened to each uploaded document, the graph of how a
 * published version's rules played out across the leads qualified against it, and the guards
 * that keep one document from being read, stored or analysed more than once at a time.
 */
export function createTrainingLibrary(deps: {
  db: DB;
  getProject: (db: DB, id: number, user?: User) => Project;
}) {
  const { db } = deps;
  /**
   * Documents being read right now, per project, by file fingerprint. In memory on purpose: a
   * read lives exactly as long as the request doing it, so a restart cannot leave one "reading"
   * forever. Every reader of the upload log sees them (status READING) until they finish.
   */
  const reading = new Map<
    number,
    Map<string, { id: number; filename: string; size: number; actor: string; started_at: string }>
  >();
  let readingSerial = 0;
  /** Projects whose training analysis (Train AI) is running, and who started it. */
  const analysing = new Map<number, { by: string; since: string }>();

  function librarySources(projectId: number) {
    return db
      .prepare(
        'SELECT id,title,content,file_sha256,created_at FROM sources WHERE project_id=? ORDER BY created_at,id',
      )
      .all(projectId) as LibrarySource[];
  }

  /**
   * The library's copy of this content, if it has one: the same file, or the same text however
   * it is spaced. Notes and website captures are compared by text like documents are.
   */
  function libraryCopy(projectId: number, match: { fileHash?: string; content?: string }) {
    const key = match.content === undefined ? '' : textKey(match.content);
    return librarySources(projectId).find(
      (source) =>
        (match.fileHash && source.file_sha256 === match.fileHash) ||
        (key && textKey(source.content) === key),
    );
  }
  /** Throws DuplicateSource when the library already holds this file or this text. */
  function refuseCopy(projectId: number, match: { fileHash?: string; content?: string }) {
    const copy = libraryCopy(projectId, match);
    if (copy) throw new DuplicateSource(copy);
  }

  /**
   * Reads a document, unless the same file is already being read in this project: a second
   * copy sent while the first is still being read is refused instead of taking a reading slot
   * and racing the first into the library.
   */
  async function readOnce<T>(
    projectId: number,
    entry: { fileHash: string; filename: string; size: number; actor: string },
    work: () => Promise<T>,
  ) {
    const inProject = reading.get(projectId) ?? new Map();
    if (inProject.has(entry.fileHash))
      throw new HttpError(
        409,
        'This document is already being read. It appears in the library when that read finishes.',
      );
    inProject.set(entry.fileHash, {
      id: ++readingSerial,
      filename: entry.filename,
      size: entry.size,
      actor: entry.actor,
      started_at: now(),
    });
    reading.set(projectId, inProject);
    try {
      return await work();
    } finally {
      inProject.delete(entry.fileHash);
      if (!inProject.size) reading.delete(projectId);
    }
  }

  /**
   * Train AI runs once per project at a time. A second request while one runs is refused here,
   * before it reaches the shared pool of remote work, so it never holds a slot of its own.
   */
  async function analysisOnce<T>(projectId: number, actor: string, work: () => Promise<T>) {
    const running = analysing.get(projectId);
    if (running)
      throw new HttpError(
        409,
        'Training analysis is already running for this project (started by ' +
          running.by +
          '). Wait for it to finish, then review its draft.',
      );
    analysing.set(projectId, { by: actor, since: now() });
    try {
      return await work();
    } finally {
      analysing.delete(projectId);
    }
  }

  /**
   * An upload attempt, kept whether it was read or refused. Someone who uploaded a file needs to
   * be able to come back and see that it worked, or why it did not; a toast that vanished is
   * not an answer. The reason is the application's own message, never a raw parser error.
   */
  function recordUpload(entry: {
    projectId: number;
    filename: string;
    size: number;
    actor: string;
    fileHash?: string;
    sourceId?: number;
    content?: string;
    error?: unknown;
  }) {
    const read = entry.sourceId !== undefined && entry.content !== undefined;
    const reason = read
      ? ''
      : entry.error instanceof HttpError
        ? entry.error.message
        : 'The document could not be read.';
    db.prepare(
      `INSERT INTO source_uploads
        (project_id,source_id,filename,size,status,characters,words,reason,created_at,created_by,
         file_sha256,duplicate_of)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      entry.projectId,
      read ? entry.sourceId : null,
      entry.filename.slice(0, 180),
      entry.size,
      read ? 'READ' : 'FAILED',
      read ? entry.content!.length : 0,
      read ? entry.content!.split(/\s+/).filter(Boolean).length : 0,
      reason.slice(0, 500),
      now(),
      entry.actor,
      entry.fileHash ?? '',
      entry.error instanceof DuplicateSource ? entry.error.source.id : null,
    );
  }

  /**
   * The upload log, newest first, with the reads still in progress at the top. Each attempt
   * says which library source holds its content now — the copy it was read into, the copy it
   * duplicated, or a later upload of the same file — so a failed attempt whose file did make it
   * in is not reported as missing.
   */
  function uploads(projectId: number): SourceUpload[] {
    const sources = librarySources(projectId);
    const byId = new Map(sources.map((source) => [source.id, source]));
    const byFile = new Map(
      sources.filter((source) => source.file_sha256).map((source) => [source.file_sha256, source]),
    );
    const inProgress = [...(reading.get(projectId)?.entries() ?? [])]
      .map(
        ([fileHash, entry]): SourceUpload => ({
          // Negative, so it never collides with a logged attempt's id.
          id: -entry.id,
          project_id: projectId,
          source_id: null,
          filename: entry.filename,
          size: entry.size,
          status: 'READING',
          characters: 0,
          words: 0,
          reason: '',
          created_at: entry.started_at,
          created_by: entry.actor,
          file_sha256: fileHash,
          duplicate_of: null,
          in_library: null,
        }),
      )
      .reverse();
    const logged = (
      db
        .prepare('SELECT * FROM source_uploads WHERE project_id=? ORDER BY id DESC LIMIT 50')
        .all(projectId) as Array<Omit<SourceUpload, 'in_library'>>
    ).map((row): SourceUpload => {
      const holder =
        (row.source_id !== null ? byId.get(row.source_id) : undefined) ??
        (row.duplicate_of ? byId.get(row.duplicate_of) : undefined) ??
        (row.file_sha256 ? byFile.get(row.file_sha256) : undefined);
      return { ...row, in_library: holder ? { id: holder.id, title: holder.title } : null };
    });
    return [...inProgress, ...logged];
  }

  /**
   * Sources that repeat an earlier one. Same content (the same file, or the same text however it
   * is spaced) is a duplicate of the oldest copy, which is the one kept; every source in the
   * library was read in full before it was stored, so the oldest copy is a complete one. The
   * same title with different content is only pointed out — it may be a newer edition.
   */
  function duplicates(projectId: number): SourceDuplicate[] {
    const kept: Array<LibrarySource & { key: string }> = [];
    const found: SourceDuplicate[] = [];
    for (const source of librarySources(projectId)) {
      const entry = { ...source, key: textKey(source.content) };
      const original = kept.find(
        (item) =>
          item.key === entry.key || (entry.file_sha256 && item.file_sha256 === entry.file_sha256),
      );
      const brief = (item: LibrarySource) => ({
        id: item.id,
        title: item.title,
        created_at: item.created_at,
      });
      if (original) {
        found.push({ ...brief(entry), kind: 'content', duplicate_of: brief(original) });
        continue;
      }
      const named = kept.find((item) => titleKey(item.title) === titleKey(entry.title));
      if (named) found.push({ ...brief(entry), kind: 'name', duplicate_of: brief(named) });
      kept.push(entry);
    }
    return found;
  }

  function graph(project: Project): TrainingGraph {
    const empty: TrainingGraph = {
      version: project.active_version,
      leads_evaluated: 0,
      decisions: { QUALIFIED: 0, NEEDS_REVIEW: 0, NOT_A_TARGET: 0 },
      rules: [],
    };
    if (!project.active_version) return empty;
    const row = db
      .prepare('SELECT snapshot_json FROM training_versions WHERE project_id=? AND version=?')
      .get(project.id, project.active_version) as { snapshot_json: string } | undefined;
    if (!row) return empty;
    const rubric = (JSON.parse(row.snapshot_json) as TrainingSnapshot).rubric;
    const rules: TrainingGraph['rules'] = [
      ...rubric.criteria.map((text) => ({ kind: 'criterion' as const, text })),
      ...rubric.exclusions.map((text) => ({ kind: 'exclusion' as const, text })),
    ].map((rule) => ({ ...rule, meets: 0, does_not_meet: 0, unable: 0 }));
    // Each lead's latest analysis on this version, and the lead's current decision, which
    // includes any human review of that analysis.
    const runs = db
      .prepare(
        `SELECT q.result_json,l.status FROM leads l
        JOIN qualification_runs q ON q.id=l.latest_run_id AND q.project_id=l.project_id
        WHERE l.project_id=? AND q.training_version=?`,
      )
      .all(project.id, project.active_version) as Array<{ result_json: string; status: string }>;
    const decisions = { ...empty.decisions };
    for (const run of runs) {
      const result = JSON.parse(run.result_json) as Qualification;
      if (run.status in decisions) decisions[run.status as keyof typeof decisions]++;
      for (const [kind, items] of [
        ['criterion', result.criteria],
        ['exclusion', result.exclusions],
      ] as const)
        for (const item of items || []) {
          const rule = rules.find((entry) => entry.kind === kind && entry.text === item.criterion);
          if (!rule) continue;
          if (item.outcome === 'MATCH') rule.meets++;
          else if (item.outcome === 'NO_MATCH') rule.does_not_meet++;
          else rule.unable++;
        }
    }
    return { ...empty, leads_evaluated: runs.length, decisions, rules };
  }

  function install(app: Express) {
    const projectOf = (req: { params: Record<string, string>; user: User }) =>
      deps.getProject(db, positiveId(req.params.projectId), req.user);
    app.get('/api/projects/:projectId/training/uploads', (req, res) => {
      res.json(uploads(projectOf(req).id));
    });
    app.get('/api/projects/:projectId/training/graph', (req, res) => {
      res.json(graph(projectOf(req)));
    });
    app.get('/api/projects/:projectId/training/duplicates', (req, res) => {
      res.json(duplicates(projectOf(req).id));
    });
    /**
     * "Remove duplicates": removes the newer copies of content the library holds more than once,
     * keeping the oldest copy of each. The person confirms the exact list they were shown; if
     * the library changed since, nothing is removed. Like removing one source, it changes the
     * training draft, and published versions keep the text they were approved with.
     */
    app.post('/api/projects/:projectId/training/duplicates/remove', (req, res) => {
      const project = projectOf(req);
      const input = z
        .object({
          revision: z.number().int().positive(),
          ids: z.array(z.number().int().positive()).min(1).max(30),
        })
        .strict()
        .parse(req.body);
      if (input.revision !== project.revision)
        throw new HttpError(409, 'This record changed in another session. Refresh before saving.');
      const removed = db.transaction(() => {
        const current = duplicates(project.id).filter((item) => item.kind === 'content');
        const expected = current.map((item) => item.id).sort((a, b) => a - b);
        const asked = [...new Set(input.ids)].sort((a, b) => a - b);
        if (expected.join(',') !== asked.join(','))
          throw new HttpError(
            409,
            'The duplicates changed since you looked. Review the list again before removing.',
          );
        const remove = db.prepare('DELETE FROM sources WHERE id=? AND project_id=?');
        for (const item of current) remove.run(item.id, project.id);
        db.prepare('UPDATE projects SET revision=revision+1,updated_at=? WHERE id=?').run(
          now(),
          project.id,
        );
        audit(
          db,
          project.id,
          req.user.name,
          'source.duplicates_removed',
          current.length +
            ' duplicate source' +
            (current.length === 1 ? '' : 's') +
            ' removed; the oldest copy of each was kept. Published snapshots retain their source text.',
        );
        return current.length;
      })();
      res.json({ removed, project: deps.getProject(db, project.id) });
    });
  }

  return {
    install,
    recordUpload,
    graph,
    refuseCopy,
    readOnce,
    analysisOnce,
    uploads,
    duplicates,
  };
}

/**
 * Harness fixtures for the training library's copies and reads (server/training-library.ts).
 * By default there are no duplicates. With ?library-copies the library looks like the team's did:
 * the Master Training stored three times, an old source still in place, one document still
 * being read, and the refused copies in the upload log.
 */
import type { SourceDuplicate, SourceUpload } from '../../shared/research';

const masterText =
  'Innovista AI lead qualification master training. A lead is qualified when it is a genuine business with a working website, a visible digital gap and a decision maker we can reach. ';
const master = 'Innovista_AI_Lead_Qualification_Master_Training_V3.docx';
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export function libraryRoutes(base: {
  project: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
  versions: unknown[];
  /** The default harness upload log, shown below the ones added here. */
  uploads: unknown[];
}): Array<[RegExp, (route: string) => unknown]> {
  if (!new URLSearchParams(location.search).has('library-copies'))
    return [[/^\/projects\/2\/training\/duplicates$/, () => []]];
  const copy = (id: number, minutesAgo: number, title = master, text = masterText) => ({
    id,
    project_id: 2,
    title,
    kind: 'document',
    url: '',
    content: text.repeat(60),
    filename: title,
    sha256: 'm' + id,
    created_at: at(minutesAgo),
  });
  const sources = [
    ...base.sources,
    copy(4, 60 * 50),
    copy(5, 60 * 49),
    copy(6, 60 * 48),
    copy(
      7,
      60 * 24 * 20,
      '08_Decision_Maker_Research.docx',
      'Decision makers: managing directors, heads of marketing and IT leads at companies of 10 to 200 people. ',
    ),
  ];
  const kept = { id: 4, title: master, created_at: sources[3].created_at as string };
  const duplicates: SourceDuplicate[] = [5, 6].map((id) => ({
    id,
    title: master,
    created_at: sources.find((source) => source.id === id)!.created_at as string,
    kind: 'content',
    duplicate_of: kept,
  }));
  const upload = (entry: Partial<SourceUpload> & Pick<SourceUpload, 'id' | 'status'>): SourceUpload => ({
    project_id: 2,
    source_id: null,
    filename: master,
    size: 48_200,
    characters: 0,
    words: 0,
    reason: '',
    created_at: at(30),
    created_by: 'Qudsiya',
    in_library: null,
    ...entry,
  });
  const uploads: unknown[] = [
    upload({
      id: -1,
      status: 'READING',
      filename: 'Pricing_Guide_2026.docx',
      size: 1_250_000,
      created_at: at(0.3),
      created_by: 'Sageer',
    }),
    upload({
      id: 12,
      status: 'FAILED',
      reason: 'Already in the library as ' + master + ' (added 5 Oct 2026).',
      duplicate_of: 4,
      in_library: { id: 4, title: master },
      created_at: at(20),
    }),
    upload({
      id: 11,
      status: 'FAILED',
      reason: 'This document is already being read. It appears in the library when that read finishes.',
      in_library: { id: 4, title: master },
      created_at: at(60 * 50 - 1),
    }),
    upload({
      id: 10,
      status: 'READ',
      source_id: 4,
      characters: 10_620,
      words: 1_620,
      in_library: { id: 4, title: master },
      created_at: at(60 * 50),
    }),
    ...base.uploads,
  ];
  return [
    [
      /^\/projects\/2$/,
      () => ({ ...base.project, source_count: sources.length, sources, versions: base.versions }),
    ],
    [/^\/projects\/2\/training\/uploads$/, () => uploads],
    [/^\/projects\/2\/training\/duplicates$/, () => duplicates],
  ];
}

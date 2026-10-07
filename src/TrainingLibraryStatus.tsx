import { useState } from 'react';
import { Copy, FileCheck2, LoaderCircle } from 'lucide-react';
import type { SourceDuplicate, SourceUpload } from '../shared/research';
import { date } from './api';
import { Alert, Modal, Spinner } from './ui';
import './TrainingLibraryStatus.css';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
/** Date and time: copies of one document are often added on the same day. */
const when = (iso: string) => date(iso) + ', ' + time(iso);
const kb = (bytes: number) =>
  bytes >= 1_000_000
    ? (bytes / 1_000_000).toFixed(1) + ' MB'
    : Math.max(1, Math.round(bytes / 1000)) + ' KB';

/**
 * Documents being read right now, by anyone in the project. They are not in the library yet and
 * are never shown as read: they appear in the source list once the read has finished.
 */
export function ReadingNow({ uploads }: { uploads: SourceUpload[] }) {
  const reading = uploads.filter((item) => item.status === 'READING');
  if (!reading.length) return null;
  return (
    <div className="library-reading" role="status">
      {reading.map((item) => (
        <div key={item.id} className="library-reading-row">
          <LoaderCircle size={15} className="spin" aria-hidden="true" />
          <span>
            <strong>Reading {item.filename}…</strong>
            <small>
              {kb(item.size)} · started {time(item.created_at)} by {item.created_by} · not in the
              library until the read finishes
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Uploads that were not added because the library already holds their content, with the copy
 * that holds it. Not a problem to fix — the document is in the library — so it stays folded.
 */
export function NotAddedAgain({ uploads }: { uploads: SourceUpload[] }) {
  const copies = uploads
    .filter((item) => item.status === 'FAILED' && item.in_library)
    .slice(0, 12);
  if (!copies.length) return null;
  return (
    <details className="library-copies">
      <summary>
        <FileCheck2 size={14} aria-hidden="true" />
        {copies.length === 1
          ? 'One upload was not added again: the library already has it'
          : copies.length + ' uploads were not added again: the library already has them'}
      </summary>
      <ul>
        {copies.map((item) => (
          <li key={item.id}>
            <span className="library-copy-name">{item.filename}</span>
            <span>
              In the library as <strong>{item.in_library!.title}</strong>
            </span>
            <small>
              {date(item.created_at)} · {item.created_by}
            </small>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** On a source row: what it repeats. */
export function DuplicateFlag({ duplicate }: { duplicate?: SourceDuplicate }) {
  if (!duplicate) return null;
  return duplicate.kind === 'content' ? (
    <span className="library-duplicate-flag is-content">
      <Copy size={11} aria-hidden="true" />
      <span>
        Duplicate of {duplicate.duplicate_of.title} (added{' '}
        {when(duplicate.duplicate_of.created_at)})
      </span>
    </span>
  ) : (
    <span className="library-duplicate-flag is-name">
      <span>
        Same name as a source added {date(duplicate.duplicate_of.created_at)}, different content
      </span>
    </span>
  );
}

/**
 * Copies of content the library already holds, and the one step that removes them: the oldest
 * copy of each is kept. The person confirms the exact list; the server refuses if it changed.
 */
export function DuplicateSources({
  duplicates,
  busy,
  onRemove,
}: {
  duplicates: SourceDuplicate[];
  busy: boolean;
  onRemove: (ids: number[]) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false),
    [working, setWorking] = useState(false),
    [error, setError] = useState('');
  const copies = duplicates.filter((item) => item.kind === 'content');
  if (!copies.length) return null;
  const kept = [
    ...new Map(copies.map((item) => [item.duplicate_of.id, item.duplicate_of])).values(),
  ];
  return (
    <div className="library-duplicates">
      <Copy size={17} aria-hidden="true" />
      <span>
        <strong>
          {copies.length === 1
            ? 'One source is a copy of another'
            : copies.length + ' sources are copies of others'}
        </strong>
        <small>
          Train AI would read the same text more than once. Removing them keeps the oldest copy
          of each.
        </small>
      </span>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => {
          setError('');
          setConfirming(true);
        }}
      >
        Remove duplicates
      </button>
      {confirming && (
        <Modal title="Remove duplicate sources?" onClose={() => !working && setConfirming(false)}>
          <div className="form-stack">
            <p>
              {copies.length === 1 ? 'This copy is' : 'These ' + copies.length + ' copies are'}{' '}
              removed from the current library. Published versions keep their original source
              text. This changes the training draft.
            </p>
            <ul className="library-duplicates-list">
              {copies.map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong>
                  <small>
                    added {when(item.created_at)} · copy of {item.duplicate_of.title}
                  </small>
                </li>
              ))}
            </ul>
            <p className="fine-print">
              Kept:{' '}
              {kept.map((item) => item.title + ' (added ' + when(item.created_at) + ')').join(', ')}
            </p>
            {error && <Alert>{error}</Alert>}
            <div className="form-actions">
              <button
                className="button secondary"
                type="button"
                disabled={working}
                onClick={() => setConfirming(false)}
              >
                Keep them
              </button>
              <button
                className="button danger"
                type="button"
                disabled={working}
                onClick={async () => {
                  setWorking(true);
                  setError('');
                  try {
                    await onRemove(copies.map((item) => item.id));
                    setConfirming(false);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setWorking(false);
                  }
                }}
              >
                {working ? (
                  <Spinner text="Removing…" />
                ) : (
                  'Remove ' + copies.length + (copies.length === 1 ? ' copy' : ' copies')
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

import { useEffect, useId, useState, type FormEvent } from 'react';
import { DatabaseBackup, ShieldCheck, Trash2 } from 'lucide-react';
import type { Project } from '../shared/types';
import type { ProjectDeletionResult, ProjectDeletionSummary } from '../shared/project-deletion';
import { api, json } from './api';
import { Alert, Modal, Spinner } from './ui';
import './DeleteProject.css';

const plural = (count: number, one: string, many = one + 's') =>
  count.toLocaleString() + ' ' + (count === 1 ? one : many);

/**
 * Deleting a project, administrators only. The dialog says exactly what goes, what stays and
 * that a snapshot is written first, and the project name has to be typed to confirm. The server
 * checks the typed name too, so the confirmation is not only a front-end nicety.
 */
export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: Project;
  onClose: () => void;
  onDeleted: (result: ProjectDeletionResult) => void;
}) {
  const [summary, setSummary] = useState<ProjectDeletionSummary | null>(null),
    [typed, setTyped] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const hintId = useId();
  useEffect(() => {
    let cancelled = false;
    api<ProjectDeletionSummary>('/projects/' + project.id + '/deletion-summary')
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);
  const matches = typed.trim() === project.name.trim();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError('');
    try {
      onDeleted(
        await api<ProjectDeletionResult>('/projects/' + project.id, {
          method: 'DELETE',
          body: json({ confirm_name: typed }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const c = summary?.counts;
  return (
    <Modal title={'Delete ' + project.name + '?'} onClose={busy ? () => undefined : onClose}>
      <form className="form-stack delete-project" onSubmit={submit}>
        <p className="delete-project-lead">
          This permanently removes the project and everything recorded in it. It cannot be undone
          from the app.
        </p>
        {!summary && !error && <Spinner text="Counting what is in this project…" />}
        {c && (
          <ul className="delete-project-list">
            <li>
              <strong>{plural(c.leads, 'lead')}</strong>
              {c.archived_leads > 0 && <> ({c.archived_leads.toLocaleString()} archived)</>}, with
              their research, contacts found ({c.contacts.toLocaleString()}) and review history
            </li>
            <li>
              <strong>{plural(c.sources, 'training source')}</strong> and{' '}
              <strong>{plural(c.training_versions, 'published training version')}</strong>
            </li>
            <li>
              <strong>{plural(c.runs, 'qualification run')}</strong>
            </li>
            <li>
              <strong>{plural(c.emails, 'email')}</strong> in the history,{' '}
              <strong>{plural(c.calls, 'call')}</strong> and{' '}
              <strong>{plural(c.comments, 'comment')}</strong>
            </li>
            <li>
              <strong>{plural(c.campaigns, 'campaign')}</strong>
              {c.queued_sequences > 0 ? (
                <>
                  ; {plural(c.queued_sequences, 'queued follow-up sequence')} stop and nothing more
                  is sent
                </>
              ) : null}
            </li>
            <li>
              {summary.mailbox ? (
                <>
                  <strong>The project mailbox settings</strong>
                  {c.incoming_messages > 0 && (
                    <> and {plural(c.incoming_messages, 'received email')}</>
                  )}
                  ; checking its inbox stops
                </>
              ) : (
                <>No mailbox is configured for this project</>
              )}
            </li>
            <li>
              Access for <strong>{plural(c.members, 'assigned team member')}</strong> (their
              accounts stay)
            </li>
          </ul>
        )}
        <div className="delete-project-note">
          <ShieldCheck size={17} aria-hidden="true" />
          <p>
            <strong>Kept for the whole workspace:</strong> opt-outs, bounces and the three-email
            limit for every address this project wrote to, so nobody can be mailed again by mistake.
          </p>
        </div>
        <div className="delete-project-note">
          <DatabaseBackup size={17} aria-hidden="true" />
          <p>
            <strong>A snapshot is kept.</strong> Before anything is deleted, a copy of the whole
            database is saved on the server (in the data folder, under backups), so an administrator
            can restore it if this was a mistake.
          </p>
        </div>
        <label>
          <span>
            Type <strong className="delete-project-name">{project.name}</strong> to confirm
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            aria-describedby={hintId}
            aria-invalid={typed.length > 0 && !matches}
          />
          <small id={hintId}>The name must match exactly, including capital letters.</small>
        </label>
        {error && <Alert>{error}</Alert>}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button danger" disabled={!matches || busy || !summary}>
            {busy ? (
              <Spinner text="Deleting…" />
            ) : (
              <>
                <Trash2 size={15} aria-hidden="true" />
                Delete project
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

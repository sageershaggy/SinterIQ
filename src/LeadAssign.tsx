import { useEffect, useState } from 'react';
import { Pencil, UserPlus } from 'lucide-react';
import type { Lead, User } from '../shared/types';
import { api, json } from './api';
import { Alert, Modal, Spinner } from './ui';
import './LeadFilters.css';

/**
 * Assignment for calling, now that the table has no "Assigned to" column: a row action in the
 * list, and a chip on the lead page that shows who holds the lead and changes it.
 */

/** The list's row action. Shows the assignee's initial once someone holds the lead. */
export function AssignRowButton({
  lead,
  disabled,
  onClick,
}: {
  lead: Lead;
  disabled: boolean;
  onClick: () => void;
}) {
  const who = lead.assigned_to_name;
  const calls = lead.call_count || 0;
  const title = who
    ? 'Assigned to ' +
      who +
      ' for calling' +
      (calls ? ' · ' + calls + ' call' + (calls === 1 ? '' : 's') + ' logged' : '') +
      '. Change the assignment'
    : 'Assign for calling';
  return (
    <button
      type="button"
      className={'icon-button row-assign' + (who ? ' is-assigned' : '')}
      disabled={disabled}
      onClick={onClick}
      aria-label={who ? title : 'Assign ' + lead.name + ' for calling'}
      title={title}
    >
      {who ? <span className="assignee-avatar">{who[0]}</span> : <UserPlus size={17} />}
    </button>
  );
}

/** The lead page's assignment: who is calling this company, and a way to change it. */
export function AssignForCalling({
  projectId,
  projectName,
  lead,
  onSaved,
  notify,
}: {
  projectId: number;
  projectName: string;
  lead: Lead;
  onSaved: () => void;
  notify: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<User[] | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError('');
    api<User[]>('/projects/' + projectId + '/assignees')
      .then((list) => {
        if (!cancelled) setPeople(list);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);
  async function assign(person: User | null) {
    setBusy(true);
    setError('');
    try {
      await api('/projects/' + projectId + '/leads/' + lead.id + '/assignment', {
        method: 'PUT',
        body: json({ account_id: person?.id ?? null }),
      });
      setOpen(false);
      onSaved();
      notify(
        person
          ? lead.name + ' assigned to ' + person.name + ' for calling.'
          : lead.name + ' returned to the pool — no longer assigned to anyone.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const who = lead.assigned_to_name;
  return (
    <>
      <button
        type="button"
        className={'assign-chip' + (who ? ' is-assigned' : '')}
        onClick={() => setOpen(true)}
        title={who ? 'Change who calls this company' : 'Assign this company for calling'}
      >
        {who ? (
          <>
            <span className="assignee-avatar">{who[0]}</span>
            Calling: {who}
            <Pencil size={12} aria-hidden="true" />
          </>
        ) : (
          <>
            <UserPlus size={13} aria-hidden="true" />
            Assign for calling
          </>
        )}
      </button>
      {open && (
        <Modal title="Assign this lead for calling" onClose={() => setOpen(false)}>
          <div className="form-stack">
            <p className="muted">
              The person you pick sees this lead under &ldquo;Assigned to me&rdquo; in the Review
              queue, where they log each call. Only people with access to {projectName} can be
              assigned.
            </p>
            {error && <Alert>{error}</Alert>}
            {!people ? (
              !error && <Spinner text="Loading the team…" />
            ) : people.length === 0 ? (
              <Alert>No one has access to this project yet. Assign it in Workspace settings.</Alert>
            ) : (
              <div className="assignment-list">
                {people.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    className="assignee-option"
                    aria-pressed={lead.assigned_to === person.id}
                    disabled={busy}
                    onClick={() => void assign(person)}
                  >
                    <span className="assignee-avatar">{person.name[0]}</span>
                    <span>
                      <strong>{person.name}</strong>
                      <small>
                        @{person.username} ·{' '}
                        {person.role === 'admin' ? 'Administrator' : 'Researcher'}
                        {lead.assigned_to === person.id ? ' · assigned now' : ''}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="form-actions">
              <button type="button" className="button secondary" onClick={() => setOpen(false)}>
                Cancel
              </button>
              {who && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void assign(null)}
                >
                  Clear assignment
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

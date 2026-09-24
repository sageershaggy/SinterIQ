import { useState, type FormEvent } from 'react';
import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { pipelineStatusLabels, type LeadComment, type LeadCrm } from '../shared/crm';
import type { Lead } from '../shared/types';
import { api, json } from './api';
import type { LeadTab } from './navigation';
import { Alert, Spinner } from './ui';
import { StatusHistory } from './LeadStatus';
import './LeadComments.css';

/** Status changes and comments as entries for the lead's recent-activity timeline. */
export function crmEvents(lead: Lead) {
  return [
    ...(lead.pipeline_changes || []).map((item) => ({
      key: 'status-' + item.id,
      when: item.created_at,
      title: 'Lead status · ' + (pipelineStatusLabels[item.to_status] || item.to_status),
      detail:
        'From ' +
        (pipelineStatusLabels[item.from_status] || item.from_status) +
        ', by ' +
        item.created_by,
      tab: 'comments' as LeadTab,
    })),
    ...(lead.comments || []).map((item) => ({
      key: 'comment-' + item.id,
      when: item.created_at,
      title: 'Comment · ' + item.author,
      detail: item.body,
      tab: 'comments' as LeadTab,
    })),
  ];
}

const when = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

/**
 * The team's comments on a lead, with the manual status history beside them. Authors edit and
 * delete their own comments; administrators may delete any. The server decides both, per viewer.
 */
export function LeadComments({
  base,
  lead,
  onSaved,
}: {
  /** The lead's API path, /projects/:id/leads/:id. */
  base: string;
  lead: Lead;
  onSaved: (crm: LeadCrm) => void;
}) {
  const comments = lead.comments || [];
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSaved(await api<LeadCrm>(base + '/comments', { method: 'POST', body: json({ body }) }));
      setBody('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="lead-comments">
      <section className="lead-comments-main">
        <form className="lead-comment-form" onSubmit={add}>
          <label>
            Add a comment
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              maxLength={4000}
              required
              placeholder="What was said, what was agreed, what the team should know."
            />
          </label>
          {error && <Alert>{error}</Alert>}
          <div>
            <button className="button primary" disabled={busy || !body.trim()}>
              {busy ? <Spinner text="Saving…" /> : 'Add comment'}
            </button>
          </div>
        </form>
        {comments.length ? (
          <ol className="lead-comment-list">
            {comments.map((comment) => (
              <CommentItem key={comment.id} base={base} comment={comment} onSaved={onSaved} />
            ))}
          </ol>
        ) : (
          <div className="lead-comments-empty">
            <MessageSquare size={18} />
            <p>No comments yet. Anything the team should know about this company goes here.</p>
          </div>
        )}
      </section>
      <aside className="lead-comments-side">
        <h3>Status history</h3>
        <StatusHistory changes={lead.pipeline_changes || []} />
      </aside>
    </div>
  );
}

function CommentItem({
  base,
  comment,
  onSaved,
}: {
  base: string;
  comment: LeadComment;
  onSaved: (crm: LeadCrm) => void;
}) {
  const [editing, setEditing] = useState(false),
    [confirming, setConfirming] = useState(false),
    [draft, setDraft] = useState(comment.body),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const url = base + '/comments/' + comment.id;
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSaved(await api<LeadCrm>(url, { method: 'PUT', body: json({ body: draft }) }));
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      onSaved(await api<LeadCrm>(url, { method: 'DELETE' }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setConfirming(false);
    }
  }
  return (
    <li className="lead-comment">
      <span className="lead-comment-avatar" aria-hidden="true">
        {initials(comment.author)}
      </span>
      <div className="lead-comment-body">
        <header>
          <strong>{comment.author}</strong>
          <small title={comment.updated_at ? 'Edited ' + when(comment.updated_at) : undefined}>
            {when(comment.created_at)}
            {comment.updated_at && ' · edited'}
          </small>
          {!editing && !confirming && (comment.can_edit || comment.can_delete) && (
            <span className="lead-comment-actions">
              {comment.can_edit && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Edit comment"
                  title="Edit"
                  onClick={() => {
                    setDraft(comment.body);
                    setEditing(true);
                  }}
                >
                  <Pencil size={14} />
                </button>
              )}
              {comment.can_delete && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Delete comment"
                  title="Delete"
                  onClick={() => setConfirming(true)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </span>
          )}
        </header>
        {editing ? (
          <form className="lead-comment-edit" onSubmit={save}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              maxLength={4000}
              required
              aria-label="Edit comment"
              autoFocus
            />
            <div>
              <button className="button primary" disabled={busy || !draft.trim()}>
                {busy ? <Spinner text="Saving…" /> : 'Save'}
              </button>
              <button type="button" className="button secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <p>{comment.body}</p>
        )}
        {confirming && (
          <div className="lead-comment-confirm" role="alert">
            <span>Delete this comment? This cannot be undone.</span>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? <Spinner text="Deleting…" /> : 'Delete'}
            </button>
            <button type="button" className="button secondary" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    </li>
  );
}

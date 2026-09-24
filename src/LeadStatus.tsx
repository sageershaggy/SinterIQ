import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, History } from 'lucide-react';
import {
  defaultPipelineStatus,
  pipelineStatusLabels,
  pipelineStatuses,
  type LeadCrm,
  type PipelineChange,
  type PipelineStatus,
} from '../shared/crm';
import type { Lead } from '../shared/types';
import { api, json } from './api';
import './LeadStatus.css';

/**
 * The manual lead status, for the top right of the lead header. It is the team's own pipeline
 * and deliberately separate from the AI qualification: moving it records who, when and from
 * what, and never touches the fit score or the decision.
 */
export function LeadStatus({
  base,
  lead,
  onSaved,
}: {
  /** The lead's API path, /projects/:id/leads/:id. */
  base: string;
  lead: Lead;
  onSaved: (crm: LeadCrm) => void;
}) {
  const id = useId();
  const status = lead.pipeline_status || defaultPipelineStatus;
  const changes = lead.pipeline_changes || [];
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !box.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  async function change(next: PipelineStatus) {
    if (next === status) return;
    setBusy(true);
    setError('');
    try {
      onSaved(
        await api<LeadCrm>(base + '/pipeline-status', {
          method: 'PUT',
          body: json({ from: status, status: next }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="lead-status" ref={box}>
      <div className={'lead-status-control lead-status-' + status.toLowerCase()}>
        <label htmlFor={id}>Lead status</label>
        <span className="lead-status-dot" aria-hidden="true" />
        <select
          id={id}
          value={status}
          disabled={busy}
          onChange={(e) => void change(e.target.value as PipelineStatus)}
        >
          {pipelineStatuses.map((value) => (
            <option key={value} value={value}>
              {pipelineStatusLabels[value]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="lead-status-history-button"
          aria-expanded={open}
          aria-label="Status history"
          title="Status history"
          onClick={() => setOpen((value) => !value)}
        >
          <History size={15} />
        </button>
      </div>
      {error && (
        <p className="lead-status-error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <div className="lead-status-popover" role="dialog" aria-label="Status history">
          <strong>Status history</strong>
          <StatusHistory changes={changes} />
        </div>
      )}
    </div>
  );
}

/** Every change of the manual status, newest first: who moved it, when, and from what. */
export function StatusHistory({ changes }: { changes: PipelineChange[] }) {
  if (!changes.length)
    return (
      <p className="lead-status-empty">
        Not changed yet. Every lead starts as {pipelineStatusLabels[defaultPipelineStatus]}.
      </p>
    );
  return (
    <ol className="lead-status-history">
      {changes.map((item) => (
        <li key={item.id}>
          <span className="lead-status-move">
            {pipelineStatusLabels[item.from_status] || item.from_status}
            <ArrowRight size={12} aria-label="to" />
            <strong>{pipelineStatusLabels[item.to_status] || item.to_status}</strong>
          </span>
          <small>
            {item.created_by} ·{' '}
            {new Date(item.created_at).toLocaleString(undefined, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </small>
        </li>
      ))}
    </ol>
  );
}

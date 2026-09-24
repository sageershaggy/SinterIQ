import { useId, useState, type FormEvent } from 'react';
import type { CallOutcome } from '../shared/types';
import {
  callOutcomeLabels,
  datedCallOutcomes,
  manualCallOutcomes,
  type CallQueueRow,
} from '../shared/calls';
import { api, json } from './api';
import { Alert, Spinner } from './ui';
import './CallStatus.css';

/** A call status as a coloured pill. Unknown values still render, as their raw name. */
export function CallStatusBadge({ outcome }: { outcome: CallOutcome | null }) {
  if (!outcome) return <span className="call-pill call-pill-none">Not called yet</span>;
  return (
    <span className={'call-pill call-pill-' + outcome.toLowerCase()}>
      {callOutcomeLabels[outcome] || outcome}
    </span>
  );
}

/** Today in the viewer's own calendar, as YYYY-MM-DD. */
export function today() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * A YYYY-MM-DD next-action date, read as a local day. Parsing it with new Date() alone would
 * treat it as UTC midnight and show the day before for anyone west of Greenwich.
 */
export function formatDay(value: string) {
  return new Date(value + 'T00:00:00').toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Record how a call went. Saved through the call-status route, so every save is a new entry in
 * the lead's call history; nothing here can change the qualification or the fit score.
 */
export function CallStatusForm({
  projectId,
  leadId,
  options = manualCallOutcomes,
  initial,
  onSaved,
  onCancel,
  autoFocus,
}: {
  projectId: number;
  leadId: number;
  options?: readonly CallOutcome[];
  initial?: CallOutcome | null;
  onSaved: (row: CallQueueRow) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [outcome, setOutcome] = useState<CallOutcome>(
    initial && options.includes(initial) ? initial : options[0],
  );
  const [nextActionAt, setNextActionAt] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const dated = datedCallOutcomes.includes(outcome);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const row = await api<CallQueueRow>(
        '/projects/' + projectId + '/leads/' + leadId + '/call-status',
        {
          method: 'POST',
          body: json({
            outcome,
            notes,
            next_action_at: dated && nextActionAt ? nextActionAt : null,
          }),
        },
      );
      setNotes('');
      setNextActionAt('');
      onSaved(row);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="call-status-form" onSubmit={submit}>
      <fieldset className="call-status-options">
        <legend>How did the call go?</legend>
        <div>
          {options.map((value, index) => (
            <label
              key={value}
              className={'call-status-option' + (value === outcome ? ' is-selected' : '')}
            >
              <input
                type="radio"
                name={id + '-outcome'}
                value={value}
                checked={value === outcome}
                onChange={() => setOutcome(value)}
                autoFocus={autoFocus && index === 0}
              />
              <span className={'call-dot call-pill-' + value.toLowerCase()} />
              {callOutcomeLabels[value]}
            </label>
          ))}
        </div>
      </fieldset>
      {dated && (
        <label className="call-status-date">
          {outcome === 'CALLBACK' ? 'Call back on' : 'Follow up on'}
          <input
            type="date"
            value={nextActionAt}
            min={today()}
            onChange={(e) => setNextActionAt(e.target.value)}
          />
          <small>Optional. It orders the Calls list and shows as the next action.</small>
        </label>
      )}
      <label>
        <span>
          Notes <span className="call-optional">(optional)</span>
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="Who you spoke to, what they said, and what happens next."
        />
      </label>
      {error && <Alert>{error}</Alert>}
      <div className="call-status-actions">
        <button className="button primary" disabled={busy}>
          {busy ? <Spinner text="Saving…" /> : 'Save call status'}
        </button>
        {onCancel && (
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

import { useState } from 'react';
import { Sparkles, Zap } from 'lucide-react';
import type { Lead } from '../shared/types';
import {
  quickVerdictHints,
  quickVerdictLabels,
  type JudgedRule,
  type QuickDecision,
} from '../shared/quick-decision';
import { api, json } from './api';
import { Alert, Spinner } from './ui';
import './QuickDecision.css';

const callLabels = {
  criterion: { MEETS: 'Meets', DOES_NOT_MEET: 'Does not meet', UNKNOWN: 'Unable to verify' },
  exclusion: { MEETS: 'Applies', DOES_NOT_MEET: 'Does not apply', UNKNOWN: 'Unable to verify' },
} as const;
const percent = (value: number) => Math.round(value * 100) + '%';
function confidence(rule: JudgedRule) {
  return rule.call === 'MEETS'
    ? rule.probabilities.meets
    : rule.call === 'DOES_NOT_MEET'
      ? rule.probabilities.does_not_meet
      : Math.max(rule.probabilities.unknown, 1 - rule.probabilities.meets - rule.probabilities.does_not_meet);
}
function ago(value: string) {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  return hours < 24 ? hours + ' h ago' : new Date(value).toLocaleDateString();
}

function Rules({ rules, kind }: { rules: JudgedRule[]; kind: 'criterion' | 'exclusion' }) {
  return (
    <ul className="quick-rules">
      {rules.map((rule, index) => (
        <li key={kind + index} className={'is-' + rule.call.toLowerCase()} title={rule.rule}>
          <span className="quick-call">
            {callLabels[kind][rule.call]}
            <small>{percent(confidence(rule))}</small>
          </span>
          <span className="quick-rule-text">
            <b>{(kind === 'criterion' ? 'C' : 'X') + (index + 1)}</b> {rule.rule}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The fast decision on the lead page: Jev's verdict on every training rule in about a second,
 * for deciding what to qualify in full. It never changes the qualification.
 */
export function QuickDecisionCard({
  base,
  lead,
  ready,
  onDecided,
  onQualify,
  notify,
}: {
  base: string;
  lead: Lead;
  ready: boolean;
  onDecided?: () => void;
  onQualify: () => void;
  notify?: (text: string) => void;
}) {
  const [fresh, setDecision] = useState<QuickDecision | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  // The reloaded lead's copy wins once it has caught up, since it knows whether it is stale.
  const saved = lead.quick_decision ?? null;
  const shown = fresh && (!saved || fresh.created_at > saved.created_at) ? fresh : saved;
  async function decide() {
    setBusy(true);
    setError('');
    try {
      const result = await api<QuickDecision>(base + '/quick-decision', { method: 'POST', body: json({}) });
      setDecision(result);
      notify?.('Fast decision: ' + quickVerdictLabels[result.verdict] + '.');
      onDecided?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const met = shown?.criteria.filter((rule) => rule.call === 'MEETS').length ?? 0;
  return (
    <section className={'company-card quick-decision' + (shown ? ' is-' + shown.verdict.toLowerCase() : '')}>
      <div className="section-title">
        <div>
          <h3>
            <Zap size={16} />
            Fast decision
            <small> · Jev</small>
          </h3>
          <p className="muted">
            {shown
              ? quickVerdictHints[shown.verdict]
              : 'Jev judges this company against every training rule in about a second, to decide what to qualify in full. It never changes the qualification.'}
          </p>
        </div>
        <div className="quick-actions">
          <button
            type="button"
            className={'button ' + (shown ? 'secondary' : 'primary')}
            disabled={busy || !ready}
            title={ready ? undefined : 'Publish the project training first.'}
            onClick={() => void decide()}
          >
            {busy ? (
              <Spinner text="Deciding…" />
            ) : (
              <>
                <Zap size={15} />
                {shown ? 'Decide again' : 'Decide now'}
              </>
            )}
          </button>
          {shown?.verdict === 'LIKELY_QUALIFIED' && (
            <button type="button" className="button primary" disabled={busy} onClick={onQualify}>
              <Sparkles size={15} />
              Run full AI qualification
            </button>
          )}
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {shown && (
        <>
          <div className="quick-summary">
            <span className="quick-verdict">{quickVerdictLabels[shown.verdict]}</span>
            <span>
              <strong>{shown.score}</strong>/100
            </span>
            <span>
              {met} of {shown.criteria.length} criteria met
              {shown.excluded_by ? ' · an exclusion applies' : ''}
            </span>
            {shown.overall && <span>Overall: {shown.overall.label.toLowerCase()}</span>}
            <span className="quick-meta">
              {shown.website_read ? 'read the website' : 'no website text'} · {shown.latency_ms} ms ·{' '}
              {ago(shown.created_at)}
            </span>
          </div>
          {shown.stale && (
            <p className="fine-print quick-stale">
              The lead or the training changed since this decision. Decide again to judge the
              current version.
            </p>
          )}
          <Rules rules={shown.criteria} kind="criterion" />
          {shown.exclusions.length > 0 && (
            <>
              <p className="quick-group">Exclusions</p>
              <Rules rules={shown.exclusions} kind="exclusion" />
            </>
          )}
          <p className="fine-print">
            A call is only made when Jev is at least 60% sure (70% for an exclusion); otherwise the
            rule reads Unable to verify. Jev quotes nothing: the full qualification is the one that
            cites evidence.
          </p>
        </>
      )}
    </section>
  );
}

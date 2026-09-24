import { ArrowRight, GitBranch, Mail, Sparkles } from 'lucide-react';
import type { CampaignOption, CampaignSuggestion } from '../shared/email';
import { fitBandLabels } from '../shared/funnels';
import { label } from './api';
import { Badge } from './ui';
import './CampaignPicker.css';

/**
 * The first question when someone emails a lead: which campaign is this email for? Every
 * campaign in the project is offered, plus a one-off email. The suggestion follows the fit
 * score (80+ to the high-quality campaign, 50–79 to the email campaign), and any other
 * campaign the lead can join can still be chosen.
 */
export function CampaignPicker({
  campaigns,
  suggested,
  selected,
  score,
  onSelect,
  onContinue,
}: {
  campaigns: CampaignOption[];
  suggested: CampaignSuggestion;
  selected: number | null;
  score: number | null;
  onSelect: (id: number | null) => void;
  onContinue: () => void;
}) {
  return (
    <section className="campaign-picker" aria-labelledby="campaign-picker-title">
      <div className="campaign-picker-head">
        <span className="eyebrow">STEP 1 OF 2</span>
        <h3 id="campaign-picker-title">Which campaign is this email for?</h3>
        <p className="muted">
          {suggested.reason}
          {score !== null && !suggested.reason.includes(String(score))
            ? ' (fit score ' + score + ')'
            : ''}
        </p>
      </div>
      <div className="campaign-options" role="radiogroup" aria-label="Campaign">
        {campaigns.map((campaign) => {
          const blocked = Boolean(campaign.blocked);
          return (
            <label
              key={campaign.id}
              className={
                'campaign-option' +
                (selected === campaign.id ? ' is-selected' : '') +
                (blocked ? ' is-blocked' : '')
              }
            >
              <input
                type="radio"
                name="campaign"
                checked={selected === campaign.id}
                disabled={blocked}
                onChange={() => onSelect(campaign.id)}
              />
              <GitBranch size={18} aria-hidden="true" />
              <span className="campaign-option-body">
                <strong>
                  {campaign.name}
                  {suggested.funnel_id === campaign.id && (
                    <span className="campaign-suggested">
                      <Sparkles size={11} /> Suggested
                    </span>
                  )}
                </strong>
                <small>
                  {campaign.steps.length} message{campaign.steps.length === 1 ? '' : 's'} ·{' '}
                  {fitBandLabels[campaign.fit_band]}
                  {campaign.audience ? ' · ' + campaign.audience : ''}
                </small>
                <small className="campaign-first">First: {campaign.steps[0]?.subject}</small>
                {blocked && <small className="campaign-blocked">{campaign.blocked}</small>}
              </span>
              <Badge value={campaign.status}>{label(campaign.status)}</Badge>
            </label>
          );
        })}
        <label className={'campaign-option' + (selected === null ? ' is-selected' : '')}>
          <input
            type="radio"
            name="campaign"
            checked={selected === null}
            onChange={() => onSelect(null)}
          />
          <Mail size={18} aria-hidden="true" />
          <span className="campaign-option-body">
            <strong>
              One-off email
              {suggested.funnel_id === null && (
                <span className="campaign-suggested">
                  <Sparkles size={11} /> Suggested
                </span>
              )}
            </strong>
            <small>A single message with no follow-ups.</small>
          </span>
        </label>
      </div>
      {!campaigns.length && (
        <p className="muted">
          This project has no campaigns yet. An administrator creates them under Email funnels.
        </p>
      )}
      <div className="campaign-picker-actions">
        <button type="button" className="button primary" onClick={onContinue}>
          Continue to the email
          <ArrowRight size={15} />
        </button>
      </div>
    </section>
  );
}

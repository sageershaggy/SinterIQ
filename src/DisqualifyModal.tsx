import React, { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

import { disqualificationCategoryOptions } from './companyData';

interface Props {
  open: boolean;
  companyName?: string;
  defaultReason?: string;
  defaultCategory?: string;
  onClose: () => void;
  onSubmit: (payload: { reason: string; category: string }) => Promise<void> | void;
  submitting?: boolean;
}

const REASON_QUICK_PICKS: Record<string, string[]> = {
  COMPETITOR: [
    'Manufactures rolling bearings as primary product',
    'Subsidiary of a known bearing manufacturer',
    'Plain-bearing (Gleitlager) specialist — too close to core business',
  ],
  WHOLESALER_TRADER: [
    'Trade/wholesale only, no in-house manufacturing or engineering',
    'Mail-order / catalog distributor',
    'Authorized dealer of finished equipment — no spec authority',
  ],
  UTILITY_OR_SOFTWARE: [
    'Energy/water utility operator, no machine design',
    'Software-only flex operator (SaaS / algorithmic)',
  ],
  SERVICE_MRO: [
    'Pure service provider — uses but does not build machinery',
    'MRO / site operator with no engineering authority',
  ],
  GLOBAL_ENTERPRISE: [
    '>5k employees with centralized procurement abroad',
    'German entity has no local spec authority',
  ],
  SALES_BRANCH: [
    'Vertriebs-GmbH / regional sales office of foreign parent',
    'Deutschland-GmbH of Asian/US parent — no German spec authority',
  ],
  EPC_INTEGRATOR: [
    'EPC contractor — installs third-party components only',
    'System integrator without manufacturing',
  ],
  SMALL_END_USER: [
    'Tiny craft producer with low-complexity equipment',
    'Regional end-user, no meaningful bearing volume',
  ],
  LOW_FIT: [
    'No plausible bearing application in their products',
    'Industry mismatch — outside Sintertechnik addressable market',
  ],
  DUPLICATE: [
    'Duplicate record — same legal entity already exists',
  ],
  OTHER: [],
};

export default function DisqualifyModal({
  open,
  companyName,
  defaultReason,
  defaultCategory,
  onClose,
  onSubmit,
  submitting = false,
}: Props) {
  const [category, setCategory] = useState(defaultCategory || '');
  const [reason, setReason] = useState(defaultReason || '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCategory(defaultCategory || '');
      setReason(defaultReason || '');
      setError(null);
    }
  }, [open, defaultCategory, defaultReason]);

  if (!open) return null;

  const quickPicks = category ? REASON_QUICK_PICKS[category] || [] : [];

  const handleSubmit = async () => {
    setError(null);
    if (!category) {
      setError('Pick a category');
      return;
    }
    if (!reason.trim() || reason.trim().length < 3) {
      setError('Add a short reason (at least 3 characters)');
      return;
    }
    try {
      await onSubmit({ reason: reason.trim(), category });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disqualify');
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Disqualify lead" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-lg">
        <div className="flex items-start justify-between p-5 border-b border-slate-100">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-50 text-red-600 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Disqualify lead</h2>
              {companyName && (
                <p className="text-sm text-slate-500 mt-0.5 truncate max-w-sm">{companyName}</p>
              )}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1.5 block">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => { setCategory(e.target.value); setReason(''); }}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white outline-none focus:border-red-500"
            >
              <option value="">Select a category…</option>
              {disqualificationCategoryOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {quickPicks.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1.5 block">
                Quick picks
              </label>
              <div className="flex flex-wrap gap-1.5">
                {quickPicks.map((pick) => (
                  <button
                    key={pick}
                    type="button"
                    onClick={() => setReason(pick)}
                    className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                      reason === pick
                        ? 'bg-red-50 border-red-300 text-red-700'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {pick}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1.5 block">
              Reason
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this lead not a fit?"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm outline-none focus:border-red-500 resize-none"
            />
            <div className="text-[11px] text-slate-400 mt-1">
              Stored on the company so future QC reviewers see why it was rejected.
            </div>
          </div>

          {error && (
            <div className="text-xs bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-slate-100 bg-slate-50/50 rounded-b-xl">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !category || !reason.trim()}
            className="px-4 py-1.5 text-sm bg-red-600 hover:bg-red-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-md font-medium transition-colors"
          >
            {submitting ? 'Saving…' : 'Disqualify'}
          </button>
        </div>
      </div>
    </div>
  );
}

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Eye,
  Search,
  Shield,
  Sparkles,
} from 'lucide-react';

import { Company } from './appTypes';
import { showToast } from './Toast';
import { leadPriorityOptions } from './companyData';
import DisqualifyModal from './DisqualifyModal';

interface Props {
  companies: Company[];
  onCompanyClick: (id: number) => void;
  onCompanyUpdated: (updated: Company) => void;
}

type ConfidenceBand = 'ALL' | 'LOW' | 'MEDIUM' | 'UNKNOWN';

const LOW_CONFIDENCE_THRESHOLD = 70;
const MEDIUM_CONFIDENCE_FLOOR = 50;

function needsReview(c: Company): boolean {
  if (c.human_reviewed) return false;
  if (c.lead_status === 'DISQUALIFIED') return false;
  if (!c.ai_qualified_at) return false;
  if (c.ai_confidence === null || c.ai_confidence === undefined) return true;
  return c.ai_confidence < LOW_CONFIDENCE_THRESHOLD;
}

function confidenceBand(c: Company): ConfidenceBand {
  if (c.ai_confidence === null || c.ai_confidence === undefined) return 'UNKNOWN';
  if (c.ai_confidence < MEDIUM_CONFIDENCE_FLOOR) return 'LOW';
  return 'MEDIUM';
}

export default function ReviewQueueTab({ companies, onCompanyClick, onCompanyUpdated }: Props) {
  const [bandFilter, setBandFilter] = useState<ConfidenceBand>('ALL');
  const [search, setSearch] = useState('');
  const [disqualifyTarget, setDisqualifyTarget] = useState<{ id: number; name: string } | null>(null);
  const [disqualifying, setDisqualifying] = useState(false);
  const [marking, setMarking] = useState<number | null>(null);
  const [expandedNoteId, setExpandedNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkMarking, setBulkMarking] = useState(false);

  const queue = useMemo(() => companies.filter(needsReview), [companies]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return queue.filter((c) => {
      if (bandFilter !== 'ALL' && confidenceBand(c) !== bandFilter) return false;
      if (!q) return true;
      const haystack = [c.company_name, c.country, c.city, c.industry, c.qualification_notes, c.opportunity_notes]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [queue, bandFilter, search]);

  const stats = useMemo(() => {
    let low = 0;
    let medium = 0;
    let unknown = 0;
    for (const c of queue) {
      const band = confidenceBand(c);
      if (band === 'LOW') low++;
      else if (band === 'MEDIUM') medium++;
      else if (band === 'UNKNOWN') unknown++;
    }
    return { total: queue.length, low, medium, unknown };
  }, [queue]);

  const currentUser = (() => {
    try { return JSON.parse(localStorage.getItem('sinteriq_user') || '{}').name || 'Unknown'; }
    catch { return 'Unknown'; }
  })();

  const handleMarkReviewed = async (id: number, notes?: string) => {
    setMarking(id);
    try {
      const cleanNotes = notes?.trim() ? notes.trim() : undefined;
      const res = await fetch(`/api/companies/${id}/mark-reviewed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: currentUser, notes: cleanNotes }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || 'Failed to mark reviewed');
      onCompanyUpdated(payload);
      setNoteDraft((prev) => { const next = { ...prev }; delete next[id]; return next; });
      setExpandedNoteId((prev) => (prev === id ? null : prev));
      showToast('success', cleanNotes ? 'Reviewed with note' : 'Marked as reviewed');
    } catch (err) {
      showToast('error', 'Mark failed', err instanceof Error ? err.message : '');
    } finally {
      setMarking(null);
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((c) => c.id)));
    }
  };

  const handleBulkMarkReviewed = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Mark ${selectedIds.size} leads as reviewed?`)) return;
    setBulkMarking(true);
    let succeeded = 0;
    let failed = 0;
    try {
      for (const id of selectedIds) {
        try {
          const res = await fetch(`/api/companies/${id}/mark-reviewed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ by: currentUser }),
          });
          if (res.ok) {
            const payload = await res.json();
            onCompanyUpdated(payload);
            succeeded++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }
      setSelectedIds(new Set());
      showToast(
        failed === 0 ? 'success' : 'info',
        `Bulk review complete`,
        `${succeeded} marked reviewed${failed > 0 ? `, ${failed} failed` : ''}`
      );
    } finally {
      setBulkMarking(false);
    }
  };

  const handleDisqualifySubmit = async ({ reason, category }: { reason: string; category: string }) => {
    if (!disqualifyTarget) return;
    setDisqualifying(true);
    try {
      const res = await fetch(`/api/companies/${disqualifyTarget.id}/disqualify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, category, by: currentUser }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || 'Failed to disqualify');
      onCompanyUpdated(payload);
      setDisqualifyTarget(null);
      showToast('success', 'Lead disqualified', disqualifyTarget.name);
    } catch (err) {
      showToast('error', 'Disqualify failed', err instanceof Error ? err.message : '');
      throw err;
    } finally {
      setDisqualifying(false);
    }
  };

  const renderConfidenceBadge = (c: Company) => {
    if (c.ai_confidence === null || c.ai_confidence === undefined) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-slate-100 text-slate-600 border border-slate-200">
          <AlertTriangle className="w-3 h-3" /> Confidence unknown
        </span>
      );
    }
    const tone = c.ai_confidence < MEDIUM_CONFIDENCE_FLOOR
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-amber-50 text-amber-700 border-amber-200';
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border ${tone}`}>
        <Bot className="w-3 h-3" /> {c.ai_confidence}% confidence
      </span>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-400 to-rose-500 flex items-center justify-center shadow-sm">
            <ClipboardCheck className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Review Queue</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {stats.total} AI-qualified leads need a human spot-check — keep the AI honest
            </p>
          </div>
        </div>
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">{selectedIds.size} selected</span>
            <button
              onClick={() => void handleBulkMarkReviewed()}
              disabled={bulkMarking}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-sm font-medium rounded-md transition-colors"
            >
              <CheckCircle2 className="w-4 h-4" />
              {bulkMarking ? 'Marking…' : `Mark ${selectedIds.size} reviewed`}
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100 rounded-md transition-colors"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Pending review" value={stats.total} icon={<ClipboardCheck className="w-4 h-4" />} tone="slate" />
        <KpiCard label="Low confidence (<50%)" value={stats.low} icon={<AlertTriangle className="w-4 h-4" />} tone="rose" />
        <KpiCard label="Medium confidence (50–69%)" value={stats.medium} icon={<Bot className="w-4 h-4" />} tone="amber" />
        <KpiCard label="No confidence reported" value={stats.unknown} icon={<Eye className="w-4 h-4" />} tone="slate" />
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company, country, AI notes…"
            className="w-full pl-9 pr-3 py-1.5 border border-slate-200 rounded-md text-sm outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-md p-0.5">
          {([
            ['ALL', `All (${stats.total})`],
            ['LOW', `Low (${stats.low})`],
            ['MEDIUM', `Medium (${stats.medium})`],
            ['UNKNOWN', `Unknown (${stats.unknown})`],
          ] as Array<[ConfidenceBand, string]>).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setBandFilter(key)}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                bandFilter === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {filtered.length > 0 && (
          <button
            onClick={toggleSelectAll}
            className="ml-auto text-xs text-slate-500 hover:text-slate-800 transition-colors px-2 py-1"
          >
            {selectedIds.size === filtered.length ? 'Deselect all' : `Select all (${filtered.length})`}
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-300 mx-auto mb-3" />
          <div className="text-sm font-medium text-slate-700">All caught up</div>
          <div className="text-xs text-slate-500 mt-1">
            No AI-qualified leads are waiting for human verification.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((c) => {
            const priorityLabel = leadPriorityOptions.find((p) => p.value === c.lead_priority)?.label || c.lead_priority || 'Unclassified';
            return (
              <div
                key={c.id}
                className={`bg-white border rounded-xl p-4 hover:shadow-sm transition-all ${
                  selectedIds.has(c.id) ? 'border-amber-400 ring-2 ring-amber-100' : 'border-slate-200 hover:border-amber-300'
                }`}
              >
                <div className="flex items-start gap-4">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id)}
                    onChange={() => toggleSelect(c.id)}
                    className="mt-1.5 w-4 h-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500 cursor-pointer shrink-0"
                    title="Select for bulk action"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      <button
                        onClick={() => onCompanyClick(c.id)}
                        className="font-semibold text-slate-900 hover:text-blue-600 transition-colors"
                      >
                        {c.company_name}
                      </button>
                      {renderConfidenceBadge(c)}
                      {c.lead_priority && (
                        <span className={`px-2 py-0.5 text-[11px] rounded border ${
                          c.lead_priority === 'HIGH_PRIORITY' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : c.lead_priority === 'STRONG' ? 'bg-sky-50 text-sky-700 border-sky-200'
                          : c.lead_priority === 'LOW_PRIORITY' ? 'bg-slate-50 text-slate-600 border-slate-200'
                          : 'bg-rose-50 text-rose-700 border-rose-200'
                        }`}>
                          {priorityLabel}
                        </span>
                      )}
                      {c.lead_score !== null && c.lead_score !== undefined && (
                        <span className="px-2 py-0.5 text-[11px] rounded border bg-slate-50 text-slate-600 border-slate-200">
                          Score {c.lead_score}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mb-2">
                      {[c.city, c.country].filter(Boolean).join(', ')} {c.industry ? `· ${c.industry}` : ''}
                      {c.employee_count ? ` · ${c.employee_count} employees` : ''}
                    </div>
                    {c.qualification_notes && (
                      <div className="text-sm text-slate-600 line-clamp-3 mb-2">
                        <span className="font-medium text-slate-700">AI: </span>
                        {c.qualification_notes}
                      </div>
                    )}
                    {c.opportunity_notes && (
                      <div className="text-xs text-emerald-700 line-clamp-2 mb-2">
                        <Sparkles className="w-3 h-3 inline mr-1" />
                        {c.opportunity_notes}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 flex flex-col gap-2 min-w-[160px]">
                    <button
                      onClick={() => void handleMarkReviewed(c.id, noteDraft[c.id])}
                      disabled={marking === c.id}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-xs font-medium rounded-md transition-colors"
                      title={noteDraft[c.id] ? 'Mark reviewed with your note' : 'Mark reviewed'}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {marking === c.id ? 'Saving…' : noteDraft[c.id] ? 'Mark with note' : 'Looks good'}
                    </button>
                    <button
                      onClick={() => setDisqualifyTarget({ id: c.id, name: c.company_name })}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white border border-red-200 hover:bg-red-50 text-red-600 text-xs font-medium rounded-md transition-colors"
                    >
                      <Shield className="w-3.5 h-3.5" /> Disqualify
                    </button>
                    <button
                      onClick={() => setExpandedNoteId(expandedNoteId === c.id ? null : c.id)}
                      className="inline-flex items-center justify-center gap-1 px-3 py-1.5 text-slate-500 hover:bg-slate-50 text-xs font-medium rounded-md transition-colors"
                    >
                      {expandedNoteId === c.id ? 'Hide note' : noteDraft[c.id] ? 'Edit note' : '+ Add note'}
                    </button>
                    <button
                      onClick={() => onCompanyClick(c.id)}
                      className="inline-flex items-center justify-center gap-1 px-3 py-1.5 text-slate-400 hover:bg-slate-50 text-[11px] font-medium rounded-md transition-colors"
                    >
                      Open <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                {expandedNoteId === c.id && (
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1 block">
                      Review note (optional)
                    </label>
                    <textarea
                      value={noteDraft[c.id] || ''}
                      onChange={(e) => setNoteDraft({ ...noteDraft, [c.id]: e.target.value })}
                      rows={2}
                      placeholder="Why is this lead OK as-is? e.g. 'Verified manufacturer of food-grade pumps — score should be higher.'"
                      className="w-full border border-slate-200 rounded-md px-2.5 py-1.5 text-xs outline-none focus:border-amber-400 resize-none"
                    />
                    <div className="text-[10px] text-slate-400 mt-1">
                      Saved when you click <span className="font-medium">Mark with note</span>. Helps future QC reviewers see why this lead was approved despite low AI confidence.
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <DisqualifyModal
        open={!!disqualifyTarget}
        companyName={disqualifyTarget?.name}
        onClose={() => { if (!disqualifying) setDisqualifyTarget(null); }}
        onSubmit={handleDisqualifySubmit}
        submitting={disqualifying}
      />
    </div>
  );
}

function KpiCard({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: 'slate' | 'rose' | 'amber' }) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-50 text-slate-700 border-slate-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
  };
  return (
    <div className={`border rounded-xl p-3 ${tones[tone]}`}>
      <div className="flex items-center gap-2 text-xs font-medium opacity-80">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}

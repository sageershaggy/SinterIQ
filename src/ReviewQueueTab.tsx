import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Download,
  Eye,
  RotateCcw,
  Search,
  Shield,
  Sparkles,
  Trash2,
  User,
} from 'lucide-react';

import { Company } from './appTypes';
import { showToast } from './Toast';
import { leadPriorityOptions } from './companyData';
import DisqualifyModal from './DisqualifyModal';
import { getDateOnly } from './formatters';
import { downloadCsv } from './utils/csvExport';
import { getCurrentUserName } from './utils/user';
import { showConfirm } from './ConfirmDialog';
import { leadPriorityBadgeClass } from './utils/statusColors';
import KpiCard from './components/KpiCard';

interface Props {
  companies: Company[];
  onCompanyClick: (id: number) => void;
  onCompanyUpdated: (updated: Company) => void;
  onCompanyDeleted: (id: number) => void;
}

type ConfidenceBand = 'ALL' | 'LOW' | 'MEDIUM' | 'UNKNOWN';
type StatusTab = 'PENDING' | 'QUALIFIED' | 'NON_QUALIFIED';

const LOW_CONFIDENCE_THRESHOLD = 70;
const MEDIUM_CONFIDENCE_FLOOR = 50;
const REVIEW_QUEUE_STATE_KEY = 'sinteriq_review_queue_state';

interface PersistedReviewQueueState {
  bandFilter?: ConfidenceBand;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  statusTab?: StatusTab;
}

function loadReviewQueueState(): PersistedReviewQueueState {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(REVIEW_QUEUE_STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isAiDisqualifiedPendingReview(c: Company): boolean {
  if (c.human_reviewed) return false;
  if (c.lead_status !== 'DISQUALIFIED') return false;
  if (!c.ai_qualified_at) return false;
  const by = (c.disqualified_by || '').toLowerCase();
  const isAi = !by || by.includes('ai') || by.includes('prefilter');
  if (!isAi) return false;
  // Only surface AI disqualifications for human review when the AI was NOT confident.
  // High-confidence AI/prefilter rejections (>=70%) go straight to Not a Target instead.
  return c.ai_confidence === null || c.ai_confidence === undefined || c.ai_confidence < LOW_CONFIDENCE_THRESHOLD;
}

function needsReview(c: Company): boolean {
  if (c.human_reviewed) return false;
  if (isAiDisqualifiedPendingReview(c)) return true;
  if (c.lead_status === 'DISQUALIFIED') return false;
  if (!c.ai_qualified_at) return false;
  if (c.ai_confidence === null || c.ai_confidence === undefined) return true;
  return c.ai_confidence < LOW_CONFIDENCE_THRESHOLD;
}

function isQualifiedByHuman(c: Company): boolean {
  return Boolean(c.human_reviewed) && c.lead_status !== 'DISQUALIFIED' && Boolean(c.ai_qualified_at);
}

function isDisqualifiedByHuman(c: Company): boolean {
  if (c.lead_status !== 'DISQUALIFIED') return false;
  return Boolean(c.human_reviewed);
}

function confidenceBand(c: Company): ConfidenceBand {
  if (c.ai_confidence === null || c.ai_confidence === undefined) return 'UNKNOWN';
  if (c.ai_confidence < MEDIUM_CONFIDENCE_FLOOR) return 'LOW';
  return 'MEDIUM';
}

export default function ReviewQueueTab({ companies, onCompanyClick, onCompanyUpdated, onCompanyDeleted }: Props) {
  const persistedState = useMemo(loadReviewQueueState, []);
  const [statusTab, setStatusTab] = useState<StatusTab>(persistedState.statusTab || 'PENDING');
  const [bandFilter, setBandFilter] = useState<ConfidenceBand>(persistedState.bandFilter || 'ALL');
  const [search, setSearch] = useState(persistedState.search || '');
  const [dateFrom, setDateFrom] = useState(persistedState.dateFrom || '');
  const [dateTo, setDateTo] = useState(persistedState.dateTo || '');
  const [disqualifyTarget, setDisqualifyTarget] = useState<{ id: number; name: string } | null>(null);
  const [disqualifying, setDisqualifying] = useState(false);
  const [marking, setMarking] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [expandedNoteId, setExpandedNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkMarking, setBulkMarking] = useState(false);

  const pendingPool = useMemo(() => companies.filter(needsReview), [companies]);
  const qualifiedPool = useMemo(() => companies.filter(isQualifiedByHuman), [companies]);
  const nonQualifiedPool = useMemo(() => companies.filter(isDisqualifiedByHuman), [companies]);

  const activePool = statusTab === 'PENDING'
    ? pendingPool
    : statusTab === 'QUALIFIED'
      ? qualifiedPool
      : nonQualifiedPool;

  // Clear selection when switching tabs — actions differ between tabs.
  useEffect(() => { setSelectedIds(new Set()); setExpandedNoteId(null); }, [statusTab]);

  useEffect(() => {
    sessionStorage.setItem(REVIEW_QUEUE_STATE_KEY, JSON.stringify({
      bandFilter,
      dateFrom,
      dateTo,
      search,
      statusTab,
    }));
  }, [bandFilter, dateFrom, dateTo, search, statusTab]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activePool.filter((c) => {
      // Confidence band only meaningful for Pending — Qualified/Non-Qualified ignore it.
      if (statusTab === 'PENDING' && bandFilter !== 'ALL' && confidenceBand(c) !== bandFilter) return false;
      if (dateFrom || dateTo) {
        const dateOnly = getDateOnly(c.ai_qualified_at);
        if (!dateOnly) return false;
        if (dateFrom && dateOnly < dateFrom) return false;
        if (dateTo && dateOnly > dateTo) return false;
      }
      if (!q) return true;
      const haystack = [c.company_name, c.country, c.city, c.industry, c.qualification_notes, c.opportunity_notes, c.disqualification_reason, c.human_review_notes]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [activePool, statusTab, bandFilter, search, dateFrom, dateTo]);

  const filtersActive = (statusTab === 'PENDING' && bandFilter !== 'ALL') || !!dateFrom || !!dateTo || !!search.trim();

  const stats = useMemo(() => {
    let low = 0;
    let medium = 0;
    let unknown = 0;
    for (const c of pendingPool) {
      const band = confidenceBand(c);
      if (band === 'LOW') low++;
      else if (band === 'MEDIUM') medium++;
      else if (band === 'UNKNOWN') unknown++;
    }
    return {
      pending: pendingPool.length,
      qualified: qualifiedPool.length,
      nonQualified: nonQualifiedPool.length,
      low,
      medium,
      unknown,
    };
  }, [pendingPool, qualifiedPool, nonQualifiedPool]);

  const currentUser = getCurrentUserName();

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
    if (!(await showConfirm({ title: `Mark ${selectedIds.size} leads as reviewed?`, confirmText: 'Mark reviewed' }))) return;
    setBulkMarking(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await fetch('/api/bulk/companies/mark-reviewed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, by: currentUser }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || 'Bulk mark failed');
      const updated = Array.isArray(payload?.updated) ? payload.updated as Company[] : [];
      for (const company of updated) onCompanyUpdated(company);
      setSelectedIds(new Set());
      const succeeded = Number(payload?.succeeded ?? updated.length);
      const failed = Number(payload?.failed ?? 0);
      showToast(
        failed === 0 ? 'success' : 'info',
        'Bulk review complete',
        `${succeeded} marked reviewed${failed > 0 ? `, ${failed} not found` : ''}`
      );
    } catch (err) {
      showToast('error', 'Bulk mark failed', err instanceof Error ? err.message : '');
    } finally {
      setBulkMarking(false);
    }
  };

  const handleUnmarkReviewed = async (id: number) => {
    setMarking(id);
    try {
      const res = await fetch(`/api/companies/${id}/unmark-reviewed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: currentUser }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || 'Failed to unmark');
      onCompanyUpdated(payload);
      showToast('success', 'Moved back to Pending');
    } catch (err) {
      showToast('error', 'Unmark failed', err instanceof Error ? err.message : '');
    } finally {
      setMarking(null);
    }
  };

  const handleRestore = async (id: number) => {
    setMarking(id);
    try {
      const res = await fetch(`/api/companies/${id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: currentUser }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || 'Failed to restore');
      onCompanyUpdated(payload);
      showToast('success', 'Lead restored to Enriched');
    } catch (err) {
      showToast('error', 'Restore failed', err instanceof Error ? err.message : '');
    } finally {
      setMarking(null);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!(await showConfirm({ title: 'Delete lead?', message: `Delete ${name} and all its contacts, activities, and notes? This cannot be undone.`, confirmText: 'Delete', tone: 'danger' }))) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/companies/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error || 'Failed to delete');
      }
      onCompanyDeleted(id);
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      showToast('success', 'Company deleted', name);
    } catch (err) {
      showToast('error', 'Delete failed', err instanceof Error ? err.message : '');
    } finally {
      setDeletingId(null);
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

  const handleExportCsv = () => {
    if (filtered.length === 0) {
      showToast('info', 'Nothing to export', 'Adjust filters to include leads');
      return;
    }
    const headers = [
      'Company', 'Country', 'City', 'Industry', 'Employees',
      'AI Confidence %', 'Lead Priority', 'Lead Score',
      'AI Qualified At', 'AI Notes', 'Opportunity Notes',
    ];
    const rows = filtered.map((c) => [
      c.company_name || '',
      c.country || '',
      c.city || '',
      c.industry || '',
      c.employee_count ?? '',
      c.ai_confidence ?? '',
      c.lead_priority || '',
      c.lead_score ?? '',
      c.ai_qualified_at || '',
      (c.qualification_notes || '').replace(/\s+/g, ' ').trim(),
      (c.opportunity_notes || '').replace(/\s+/g, ' ').trim(),
    ]);
    const today = new Date().toISOString().split('T')[0];
    const rangeTag = dateFrom || dateTo ? `_${dateFrom || 'start'}_to_${dateTo || today}` : '';
    downloadCsv(headers, rows, `SinterIQ_ReviewQueue${rangeTag}_${filtered.length}leads`);
    showToast('success', 'Export ready', `${filtered.length} leads exported`);
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
              {stats.pending} pending · {stats.qualified} qualified · {stats.nonQualified} non-qualified
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {statusTab === 'PENDING' && selectedIds.size > 0 && (
            <>
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
            </>
          )}
          <button
            onClick={handleExportCsv}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed text-slate-700 text-sm font-medium rounded-md transition-colors"
            title={filtersActive ? `Export ${filtered.length} filtered leads as CSV` : `Export all ${filtered.length} leads as CSV`}
          >
            <Download className="w-4 h-4" />
            Export CSV ({filtered.length})
          </button>
        </div>
      </div>

      {/* Status tabs — primary scope of the queue */}
      <div className="flex items-center gap-1 bg-slate-100 border border-slate-200 rounded-xl p-1 w-fit">
        {([
          ['PENDING', 'Pending Review', stats.pending, 'amber'],
          ['QUALIFIED', 'Qualified', stats.qualified, 'emerald'],
          ['NON_QUALIFIED', 'Non Qualified', stats.nonQualified, 'rose'],
        ] as Array<[StatusTab, string, number, 'amber' | 'emerald' | 'rose']>).map(([key, label, count, tone]) => {
          const isActive = statusTab === key;
          const activeTone = tone === 'amber' ? 'bg-amber-500 text-white' : tone === 'emerald' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white';
          return (
            <button
              key={key}
              onClick={() => setStatusTab(key)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                isActive ? activeTone : 'text-slate-600 hover:bg-white hover:text-slate-900'
              }`}
            >
              {label} <span className={`ml-1 text-xs ${isActive ? 'opacity-90' : 'text-slate-400'}`}>({count})</span>
            </button>
          );
        })}
      </div>

      {/* Confidence breakdown — only meaningful for the Pending tab. */}
      {statusTab === 'PENDING' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Pending total"
            value={stats.pending}
            icon={<ClipboardCheck className="w-4 h-4" />}
            tone="slate"
            active={bandFilter === 'ALL'}
            onClick={() => setBandFilter('ALL')}
          />
          <KpiCard
            label="Low confidence (<50%)"
            value={stats.low}
            icon={<AlertTriangle className="w-4 h-4" />}
            tone="rose"
            active={bandFilter === 'LOW'}
            onClick={() => setBandFilter(bandFilter === 'LOW' ? 'ALL' : 'LOW')}
          />
          <KpiCard
            label="Medium confidence (50–69%)"
            value={stats.medium}
            icon={<Bot className="w-4 h-4" />}
            tone="amber"
            active={bandFilter === 'MEDIUM'}
            onClick={() => setBandFilter(bandFilter === 'MEDIUM' ? 'ALL' : 'MEDIUM')}
          />
          <KpiCard
            label="No confidence reported"
            value={stats.unknown}
            icon={<Eye className="w-4 h-4" />}
            tone="slate"
            active={bandFilter === 'UNKNOWN'}
            onClick={() => setBandFilter(bandFilter === 'UNKNOWN' ? 'ALL' : 'UNKNOWN')}
          />
        </div>
      )}

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
        <div className="flex items-center gap-1.5 text-xs text-slate-600">
          <span className="text-slate-500">AI qualified</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            max={dateTo || undefined}
            className="border border-slate-200 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-500"
            title="From date (AI qualified at)"
          />
          <span className="text-slate-400">→</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            min={dateFrom || undefined}
            className="border border-slate-200 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-500"
            title="To date (AI qualified at)"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(''); setDateTo(''); }}
              className="text-slate-400 hover:text-slate-700 px-1"
              title="Clear date range"
            >
              ×
            </button>
          )}
        </div>
        {filtersActive && (
          <button
            onClick={() => { setBandFilter('ALL'); setSearch(''); setDateFrom(''); setDateTo(''); }}
            className="text-xs text-slate-500 hover:text-slate-800 transition-colors px-2 py-1 border border-slate-200 rounded-md"
          >
            Clear all
          </button>
        )}
        {statusTab === 'PENDING' && filtered.length > 0 && (
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
          <div className="text-sm font-medium text-slate-700">
            {filtersActive && activePool.length > 0
              ? 'No leads match your filters'
              : statusTab === 'PENDING' ? 'All caught up'
              : statusTab === 'QUALIFIED' ? 'No leads have been marked Looks good yet'
              : 'No leads have been disqualified by a human yet'}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {filtersActive && activePool.length > 0
              ? `${activePool.length} leads in this tab — try clearing filters or widening the date range.`
              : statusTab === 'PENDING'
                ? 'No AI-qualified leads are waiting for human verification.'
                : statusTab === 'QUALIFIED'
                  ? 'Approve leads from the Pending tab to populate this view.'
                  : 'Disqualify leads from the Pending tab to populate this view.'}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((c) => {
            const priorityLabel = leadPriorityOptions.find((p) => p.value === c.lead_priority)?.label || c.lead_priority || 'Unclassified';
            const isPendingAiDisqualified = statusTab === 'PENDING' && isAiDisqualifiedPendingReview(c);
            return (
              <div
                key={c.id}
                className={`bg-white border rounded-xl p-4 hover:shadow-sm transition-all ${
                  selectedIds.has(c.id) ? 'border-amber-400 ring-2 ring-amber-100' : 'border-slate-200 hover:border-amber-300'
                }`}
              >
                <div className="flex items-start gap-4">
                  {statusTab === 'PENDING' && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(c.id)}
                      onChange={() => toggleSelect(c.id)}
                      className="mt-1.5 w-4 h-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500 cursor-pointer shrink-0"
                      title="Select for bulk action"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      <button
                        onClick={() => onCompanyClick(c.id)}
                        className="font-semibold text-slate-900 hover:text-blue-600 transition-colors"
                      >
                        {c.company_name}
                      </button>
                      {renderConfidenceBadge(c)}
                      {isPendingAiDisqualified && (
                        <span className="px-2 py-0.5 text-[11px] rounded border bg-rose-50 text-rose-700 border-rose-200">
                          AI disqualified
                        </span>
                      )}
                      {c.lead_priority && (
                        <span className={`px-2 py-0.5 text-[11px] rounded border ${leadPriorityBadgeClass(c.lead_priority)}`}>
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
                    {statusTab === 'QUALIFIED' && c.human_reviewed_by && (
                      <div className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 mb-2 inline-flex items-center gap-1.5">
                        <CheckCircle2 className="w-3 h-3" />
                        Reviewed by {c.human_reviewed_by}
                        {c.human_reviewed_at ? ` · ${String(c.human_reviewed_at).slice(0, 10)}` : ''}
                        {c.human_review_notes ? ` · "${c.human_review_notes}"` : ''}
                      </div>
                    )}
                    {statusTab === 'NON_QUALIFIED' && (
                      <div className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 mb-2">
                        <div className="inline-flex items-center gap-1.5">
                          <Shield className="w-3 h-3" />
                          Disqualified by {c.disqualified_by || 'Unknown'}
                          {c.disqualified_at ? ` · ${String(c.disqualified_at).slice(0, 10)}` : ''}
                          {c.disqualification_category ? ` · ${c.disqualification_category}` : ''}
                        </div>
                        {c.disqualification_reason && (
                          <div className="mt-0.5 text-rose-800 line-clamp-2">{c.disqualification_reason}</div>
                        )}
                      </div>
                    )}
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
                    {statusTab === 'PENDING' && (
                      <>
                        {isPendingAiDisqualified && (
                          <button
                            onClick={() => void handleRestore(c.id)}
                            disabled={marking === c.id}
                            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-xs font-medium rounded-md transition-colors"
                            title="Clear AI disqualification and move this lead back to Enriched"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            {marking === c.id ? 'Restoring...' : 'Restore as Enriched'}
                          </button>
                        )}
                        <button
                          onClick={() => void handleMarkReviewed(c.id, isPendingAiDisqualified ? (noteDraft[c.id] || 'Confirmed AI disqualification') : noteDraft[c.id])}
                          disabled={marking === c.id}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-xs font-medium rounded-md transition-colors"
                          title={noteDraft[c.id] ? 'Mark reviewed with your note' : 'Mark reviewed'}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {marking === c.id ? 'Saving...' : isPendingAiDisqualified ? 'Confirm Not Target' : noteDraft[c.id] ? 'Mark with note' : 'Looks good'}
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
                      </>
                    )}
                    {statusTab === 'QUALIFIED' && (
                      <>
                        <button
                          onClick={() => void handleUnmarkReviewed(c.id)}
                          disabled={marking === c.id}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-medium rounded-md transition-colors"
                          title="Move this lead back to Pending Review"
                        >
                          <User className="w-3.5 h-3.5" />
                          {marking === c.id ? 'Saving…' : 'Move to Pending'}
                        </button>
                        <button
                          onClick={() => setDisqualifyTarget({ id: c.id, name: c.company_name })}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white border border-red-200 hover:bg-red-50 text-red-600 text-xs font-medium rounded-md transition-colors"
                          title="Change your mind — disqualify this lead"
                        >
                          <Shield className="w-3.5 h-3.5" /> Disqualify
                        </button>
                      </>
                    )}
                    {statusTab === 'NON_QUALIFIED' && (
                      <button
                        onClick={() => void handleRestore(c.id)}
                        disabled={marking === c.id}
                        className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-medium rounded-md transition-colors"
                        title="Clear disqualification and revert to Enriched"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        {marking === c.id ? 'Restoring…' : 'Restore'}
                      </button>
                    )}
                    <button
                      onClick={() => void handleDelete(c.id, c.company_name)}
                      disabled={deletingId === c.id}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white border border-red-300 hover:bg-red-100 disabled:opacity-50 text-red-700 text-xs font-medium rounded-md transition-colors"
                      title="Permanently delete this lead and all its contacts, activities, and notes"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      {deletingId === c.id ? 'Deleting…' : 'Delete'}
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


import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Building2,
  Download,
  RotateCcw,
  Search,
  Shield,
  User,
} from 'lucide-react';

import { Company } from './appTypes';
import { showToast } from './Toast';
import { disqualificationCategoryOptions } from './companyData';
import { downloadCsv } from './utils/csvExport';
import { showConfirm } from './ConfirmDialog';
import KpiCard from './components/KpiCard';

type SourceFilter = 'ALL' | 'HUMAN' | 'AI';

// Sentinel for the country filter: matches leads that have no country recorded.
const NO_COUNTRY = '__NO_COUNTRY__';

interface Props {
  companies: Company[];
  onCompanyClick: (id: number) => void;
  onRestore: (id: number) => Promise<void> | void;
}

function getSource(c: Company): 'HUMAN' | 'AI' | 'OTHER' {
  if (c.lead_status === 'DISQUALIFIED' && c.disqualified_by) {
    // The pre-classifier and AI qualifier set disqualified_by to 'AI Pre-classifier' / 'AI Qualifier'.
    // Anything else is a real human reviewer.
    return c.disqualified_by.toLowerCase().includes('ai') ? 'AI' : 'HUMAN';
  }
  if (c.lead_priority === 'NOT_A_TARGET') return 'AI';
  return 'OTHER';
}

function categoryLabel(value?: string | null) {
  if (!value) return null;
  return disqualificationCategoryOptions.find((o) => o.value === value)?.label || value;
}

export default function NotATargetTab({ companies, onCompanyClick, onRestore }: Props) {
  // Default to the AI view: this list is primarily the imports the AI disqualified.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('AI');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [restoringId, setRestoringId] = useState<number | null>(null);

  const notTargets = useMemo(() => companies.filter((c) =>
    c.lead_status === 'DISQUALIFIED' || c.lead_priority === 'NOT_A_TARGET'
  ), [companies]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return notTargets.filter((c) => {
      const src = getSource(c);
      if (sourceFilter !== 'ALL' && src !== sourceFilter) return false;
      if (categoryFilter && c.disqualification_category !== categoryFilter) return false;
      if (countryFilter) {
        if (countryFilter === NO_COUNTRY) {
          if (c.country) return false;
        } else if (c.country !== countryFilter) {
          return false;
        }
      }
      if (!q) return true;
      const haystack = [c.company_name, c.country, c.city, c.industry, c.disqualification_reason, c.qualification_notes]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [notTargets, sourceFilter, categoryFilter, countryFilter, search]);

  const stats = useMemo(() => {
    let human = 0;
    let ai = 0;
    const byCategory: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    for (const c of notTargets) {
      const src = getSource(c);
      if (src === 'HUMAN') human++;
      if (src === 'AI') ai++;
      const cat = c.disqualification_category || 'UNCATEGORIZED';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      const country = c.country || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;
    }
    return { total: notTargets.length, human, ai, byCategory, byCountry };
  }, [notTargets]);

  const availableCountries = useMemo(
    () => Array.from(new Set(notTargets.map((c) => c.country).filter(Boolean) as string[])).sort(),
    [notTargets]
  );

  const noCountryCount = useMemo(() => notTargets.filter((c) => !c.country).length, [notTargets]);

  const handleRestore = async (id: number) => {
    if (!(await showConfirm({ title: 'Restore this lead?', message: 'Status will revert to Enriched and the disqualification reason will be cleared.', confirmText: 'Restore' }))) return;
    setRestoringId(id);
    try {
      await onRestore(id);
    } finally {
      setRestoringId(null);
    }
  };

  const handleExport = () => {
    if (filtered.length === 0) {
      showToast('info', 'Nothing to export');
      return;
    }
    const headers = [
      'Company Name', 'Country', 'City', 'Industry', 'Source',
      'Disqualification Category', 'Disqualification Reason', 'Disqualified By', 'Disqualified At',
      'AI Lead Priority', 'AI Qualification Notes', 'Website',
    ];
    const rows = filtered.map((c) => [
      c.company_name,
      c.country || '',
      c.city || '',
      c.industry || '',
      getSource(c),
      c.disqualification_category || '',
      (c.disqualification_reason || '').replace(/[\r\n]+/g, ' '),
      c.disqualified_by || '',
      c.disqualified_at || '',
      c.lead_priority || '',
      (c.qualification_notes || '').replace(/[\r\n]+/g, ' '),
      c.website || '',
    ]);
    downloadCsv(headers, rows, `SinterIQ_NotATarget_${new Date().toISOString().split('T')[0]}_${filtered.length}leads`);
    showToast('success', 'Export ready', `${filtered.length} not-a-target leads exported`);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-slate-500 to-slate-700 flex items-center justify-center shadow-sm">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Not a Target</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {stats.total} leads filtered out — keep marketing focused on real prospects
            </p>
          </div>
        </div>
        <button
          onClick={handleExport}
          disabled={filtered.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-800 disabled:bg-slate-300 text-white rounded-md text-sm font-medium transition-colors"
        >
          <Download className="w-4 h-4" /> Export ({filtered.length})
        </button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-3">
        <KpiCard label="Total filtered" value={stats.total} icon={<Shield className="w-4 h-4" />} tone="slate" />
        <KpiCard label="Disqualified by human" value={stats.human} icon={<User className="w-4 h-4" />} tone="rose" />
        <KpiCard label="AI flagged NOT_A_TARGET" value={stats.ai} icon={<Bot className="w-4 h-4" />} tone="violet" />
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company, country, reason…"
            className="w-full pl-9 pr-3 py-1.5 border border-slate-200 rounded-md text-sm outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-md p-0.5">
          {(['ALL', 'HUMAN', 'AI'] as SourceFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(s)}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                sourceFilter === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {s === 'ALL' ? `All (${stats.total})` : s === 'HUMAN' ? `Human (${stats.human})` : `AI (${stats.ai})`}
            </button>
          ))}
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="bg-white border border-slate-200 px-3 py-1.5 rounded-md text-sm outline-none"
        >
          <option value="">All categories</option>
          {disqualificationCategoryOptions.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label} {stats.byCategory[c.value] ? `(${stats.byCategory[c.value]})` : ''}
            </option>
          ))}
        </select>
        {(availableCountries.length > 0 || noCountryCount > 0) && (
          <select
            value={countryFilter}
            onChange={(e) => setCountryFilter(e.target.value)}
            className="bg-white border border-slate-200 px-3 py-1.5 rounded-md text-sm outline-none"
          >
            <option value="">All countries</option>
            {availableCountries.map((c) => (
              <option key={c} value={c}>{c}{stats.byCountry[c] ? ` (${stats.byCountry[c]})` : ''}</option>
            ))}
            {noCountryCount > 0 && (
              <option value={NO_COUNTRY}>No country ({noCountryCount})</option>
            )}
          </select>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center">
            <AlertTriangle className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <div className="text-sm font-medium text-slate-700">No leads match these filters</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Company</th>
                <th className="text-left px-4 py-2.5 font-medium">Source</th>
                <th className="text-left px-4 py-2.5 font-medium">Category</th>
                <th className="text-left px-4 py-2.5 font-medium">Reason</th>
                <th className="text-left px-4 py-2.5 font-medium">By</th>
                <th className="text-right px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((c) => {
                const source = getSource(c);
                const reason = c.disqualification_reason
                  || (source === 'AI' ? (c.qualification_notes || 'AI flagged as NOT_A_TARGET') : '—');
                return (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <button
                        onClick={() => onCompanyClick(c.id)}
                        className="text-left"
                      >
                        <div className="font-medium text-slate-900 hover:text-blue-600">{c.company_name}</div>
                        <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                          <Building2 className="w-3 h-3" />
                          {[c.city, c.country].filter(Boolean).join(', ')} {c.industry ? `· ${c.industry}` : ''}
                        </div>
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      {source === 'HUMAN' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-rose-50 text-rose-700 border border-rose-200 rounded">
                          <User className="w-3 h-3" /> Human
                        </span>
                      ) : source === 'AI' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-violet-50 text-violet-700 border border-violet-200 rounded">
                          <Bot className="w-3 h-3" /> AI
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {categoryLabel(c.disqualification_category) || (source === 'AI' ? 'AI: NOT_A_TARGET' : '—')}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600 max-w-md">
                      <div className="line-clamp-2">{reason}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {c.disqualified_by || (source === 'AI' ? 'AI Qualifier' : '—')}
                      {c.disqualified_at && (
                        <div className="text-[10px] text-slate-400 mt-0.5">{c.disqualified_at.slice(0, 10)}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => void handleRestore(c.id)}
                        disabled={restoringId === c.id}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded transition-colors disabled:opacity-50"
                        title="Restore — clears disqualification and reverts status"
                      >
                        <RotateCcw className="w-3 h-3" />
                        {restoringId === c.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}


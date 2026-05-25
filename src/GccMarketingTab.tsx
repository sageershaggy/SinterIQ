import React, { useMemo, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Download,
  Globe,
  Mail,
  MapPin,
  Search,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';

import { Company } from './appTypes';
import { showToast } from './Toast';
import { industryOptions } from './companyData';
import { formatCompactEur } from './formatters';

const GCC_COUNTRY_CODES = new Set(['AE', 'SA', 'QA', 'OM', 'BH', 'KW']);
const GCC_COUNTRY_NAMES: Record<string, string> = {
  AE: 'UAE',
  SA: 'Saudi Arabia',
  QA: 'Qatar',
  OM: 'Oman',
  BH: 'Bahrain',
  KW: 'Kuwait',
};

const MARKETING_STATUSES = new Set(['QUALIFIED', 'APPROVED']);

interface Props {
  companies: Company[];
  onCompanyClick: (id: number) => void;
}

type StatusFilter = 'ALL' | 'QUALIFIED' | 'APPROVED';

export default function GccMarketingTab({ companies, onCompanyClick }: Props) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [countryFilter, setCountryFilter] = useState<string>('');
  const [industryFilter, setIndustryFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [onlyAiQualified, setOnlyAiQualified] = useState(false);
  const [onlyWithContacts, setOnlyWithContacts] = useState(false);

  const gccLeads = useMemo(() => companies.filter((c) => {
    const region = (c.region || '').toUpperCase();
    const isGccByRegion = region === 'GCC' || region === 'MIDDLE_EAST' || region === 'UAE'
      || region === 'SAUDI_ARABIA' || region === 'QATAR' || region === 'OMAN'
      || region === 'BAHRAIN' || region === 'KUWAIT';
    const isGccByCountry = GCC_COUNTRY_CODES.has((c.country || '').toUpperCase());
    return (isGccByRegion || isGccByCountry) && MARKETING_STATUSES.has(c.lead_status);
  }), [companies]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return gccLeads.filter((c) => {
      if (statusFilter !== 'ALL' && c.lead_status !== statusFilter) return false;
      if (countryFilter && (c.country || '').toUpperCase() !== countryFilter) return false;
      if (industryFilter && c.industry !== industryFilter) return false;
      if (onlyAiQualified && !c.ai_qualified_at) return false;
      if (onlyWithContacts && !(c.contact_count && c.contact_count > 0)) return false;
      if (!q) return true;
      const haystack = [c.company_name, c.country, c.city, c.industry, c.assigned_to, c.main_products]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [gccLeads, statusFilter, countryFilter, industryFilter, search, onlyAiQualified, onlyWithContacts]);

  const stats = useMemo(() => {
    const byCountry: Record<string, number> = {};
    let aiQualified = 0;
    let withContacts = 0;
    let withEmailScript = 0;
    for (const c of gccLeads) {
      const cc = (c.country || 'Unknown').toUpperCase();
      byCountry[cc] = (byCountry[cc] || 0) + 1;
      if (c.ai_qualified_at) aiQualified++;
      if (c.contact_count && c.contact_count > 0) withContacts++;
      if (c.email_script) withEmailScript++;
    }
    return {
      total: gccLeads.length,
      qualified: gccLeads.filter((c) => c.lead_status === 'QUALIFIED').length,
      approved: gccLeads.filter((c) => c.lead_status === 'APPROVED').length,
      aiQualified,
      withContacts,
      withEmailScript,
      byCountry,
    };
  }, [gccLeads]);

  const availableCountries = useMemo(() => {
    const set = new Set<string>();
    for (const c of gccLeads) {
      const code = (c.country || '').toUpperCase();
      if (code) set.add(code);
    }
    return Array.from(set).sort();
  }, [gccLeads]);

  const handleExport = () => {
    if (filtered.length === 0) {
      showToast('info', 'Nothing to export', 'Adjust filters to include leads');
      return;
    }
    const headers = [
      'Company Name', 'Country', 'City', 'Industry', 'Company Type', 'Main Products',
      'Website', 'Employees', 'Revenue (EUR)',
      'Lead Status', 'Lead Priority', 'Lead Score', 'Technical Fit', 'Product Fit', 'Buying Probability',
      'AI Qualified At', 'AI Confidence',
      'Approach Strategy', 'Email Script', 'Sales Script', 'Opportunity Notes', 'Qualification Notes',
      'Contacts on File', 'Assigned To', 'Created By', 'Updated At',
    ];
    const rows = filtered.map((c) => [
      c.company_name,
      GCC_COUNTRY_NAMES[(c.country || '').toUpperCase()] || c.country || '',
      c.city || '',
      c.industry || '',
      c.company_type || '',
      c.main_products || '',
      c.website || '',
      c.employee_count ?? '',
      c.revenue_eur ?? '',
      c.lead_status,
      c.lead_priority || '',
      c.lead_score ?? '',
      c.technical_fit || '',
      c.product_fit || '',
      c.buying_probability ?? '',
      c.ai_qualified_at || '',
      c.ai_confidence ?? '',
      (c.approach_strategy || '').replace(/[\r\n]+/g, ' '),
      (c.email_script || '').replace(/[\r\n]+/g, ' '),
      (c.sales_script || '').replace(/[\r\n]+/g, ' '),
      (c.opportunity_notes || '').replace(/[\r\n]+/g, ' '),
      (c.qualification_notes || '').replace(/[\r\n]+/g, ' '),
      c.contact_count ?? 0,
      c.assigned_to || '',
      c.created_by || '',
      c.updated_at || '',
    ]);
    const bom = '﻿';
    const csv = bom + [headers, ...rows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SinterIQ_GCC_Marketing_${new Date().toISOString().split('T')[0]}_${filtered.length}leads.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('success', 'Export ready', `${filtered.length} GCC leads exported`);
  };

  const formatStatusBadge = (status: string) => {
    const tone = status === 'APPROVED'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : 'bg-violet-50 text-violet-700 border-violet-200';
    return (
      <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded border ${tone}`}>
        {status === 'APPROVED' ? 'Approved' : 'Qualified'}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-sm">
            <Target className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">GCC Marketing</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {stats.total} qualified leads across the Gulf — ready for outreach
            </p>
          </div>
        </div>
        <button
          onClick={handleExport}
          disabled={filtered.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-md text-sm font-semibold transition-colors"
        >
          <Download className="w-4 h-4" /> Export Marketing Pack ({filtered.length})
        </button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Marketing-ready" value={stats.total} icon={<Building2 className="w-4 h-4" />} tone="slate" />
        <KpiCard label="Approved" value={stats.approved} icon={<CheckCircle2 className="w-4 h-4" />} tone="emerald" />
        <KpiCard label="AI Qualified" value={stats.aiQualified} icon={<Sparkles className="w-4 h-4" />} tone="violet" />
        <KpiCard label="With Contacts" value={stats.withContacts} icon={<Users className="w-4 h-4" />} tone="sky" />
      </div>

      {/* Country breakdown */}
      {Object.keys(stats.byCountry).length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Globe className="w-4 h-4 text-slate-400" /> By Country
            </h2>
            {countryFilter && (
              <button
                onClick={() => setCountryFilter('')}
                className="text-xs text-blue-600 hover:underline"
              >
                Clear country filter
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.byCountry).sort((a, b) => b[1] - a[1]).map(([code, count]) => (
              <button
                key={code}
                onClick={() => setCountryFilter(countryFilter === code ? '' : code)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                  countryFilter === code
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {GCC_COUNTRY_NAMES[code] || code} · {count}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company, city, industry, products..."
            className="w-full pl-9 pr-3 py-1.5 border border-slate-200 rounded-md text-sm outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-md p-0.5">
          {(['ALL', 'QUALIFIED', 'APPROVED'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                statusFilter === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {s === 'ALL' ? `All (${stats.total})` : s === 'QUALIFIED' ? `Qualified (${stats.qualified})` : `Approved (${stats.approved})`}
            </button>
          ))}
        </div>
        {availableCountries.length > 1 && (
          <select
            value={countryFilter}
            onChange={(e) => setCountryFilter(e.target.value)}
            className="bg-white border border-slate-200 px-3 py-1.5 rounded-md text-sm outline-none"
          >
            <option value="">All countries</option>
            {availableCountries.map((c) => (
              <option key={c} value={c}>{GCC_COUNTRY_NAMES[c] || c}</option>
            ))}
          </select>
        )}
        <select
          value={industryFilter}
          onChange={(e) => setIndustryFilter(e.target.value)}
          className="bg-white border border-slate-200 px-3 py-1.5 rounded-md text-sm outline-none"
        >
          <option value="">All industries</option>
          {industryOptions.map((i) => (
            <option key={i.value} value={i.value}>{i.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={onlyAiQualified}
            onChange={(e) => setOnlyAiQualified(e.target.checked)}
            className="rounded border-slate-300"
          />
          AI Qualified only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={onlyWithContacts}
            onChange={(e) => setOnlyWithContacts(e.target.checked)}
            className="rounded border-slate-300"
          />
          With contacts
        </label>
      </div>

      {/* Lead cards */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center">
          <Target className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <div className="text-sm font-medium text-slate-700">No marketing-ready leads match these filters</div>
          <div className="text-xs text-slate-500 mt-1">
            {stats.total === 0
              ? 'Run AI qualification on GCC leads to populate this view.'
              : 'Try clearing filters or broadening the search.'}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => onCompanyClick(c.id)}
              className="text-left bg-white border border-slate-200 hover:border-blue-300 hover:shadow-md rounded-xl p-4 transition-all group"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <h3 className="font-semibold text-slate-900 truncate group-hover:text-blue-600 transition-colors">
                      {c.company_name}
                    </h3>
                    {formatStatusBadge(c.lead_status)}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {[c.city, GCC_COUNTRY_NAMES[(c.country || '').toUpperCase()] || c.country].filter(Boolean).join(', ')}
                    </span>
                    {c.industry && <span>· {c.industry}</span>}
                  </div>
                </div>
                {c.lead_score !== null && c.lead_score !== undefined && (
                  <div className={`shrink-0 text-center px-2 py-1 rounded text-xs font-semibold border ${
                    c.lead_score >= 70 ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : c.lead_score >= 40 ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-slate-50 text-slate-600 border-slate-200'
                  }`}>
                    {c.lead_score}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2 text-[11px] mt-3 mb-2">
                <div className="bg-slate-50 rounded px-2 py-1">
                  <div className="text-slate-400 uppercase tracking-wide">Contacts</div>
                  <div className="text-slate-900 font-medium">{c.contact_count ?? 0}</div>
                </div>
                <div className="bg-slate-50 rounded px-2 py-1">
                  <div className="text-slate-400 uppercase tracking-wide">Revenue</div>
                  <div className="text-slate-900 font-medium">{c.revenue_eur ? formatCompactEur(c.revenue_eur) : '—'}</div>
                </div>
                <div className="bg-slate-50 rounded px-2 py-1">
                  <div className="text-slate-400 uppercase tracking-wide">Buying %</div>
                  <div className="text-slate-900 font-medium">{c.buying_probability != null ? `${c.buying_probability}%` : '—'}</div>
                </div>
              </div>

              {c.approach_strategy && (
                <div className="text-xs text-slate-600 line-clamp-2 mb-1.5">
                  <span className="font-medium text-slate-700">Approach: </span>
                  {c.approach_strategy}
                </div>
              )}
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                <div className="flex items-center gap-3 text-[11px] text-slate-500">
                  {c.email_script && (
                    <span className="flex items-center gap-1 text-emerald-600">
                      <Mail className="w-3 h-3" /> Email ready
                    </span>
                  )}
                  {c.ai_qualified_at && (
                    <span className="flex items-center gap-1 text-violet-600">
                      <Sparkles className="w-3 h-3" /> AI qualified
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-400">
                  {c.assigned_to || 'Unassigned'}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: 'slate' | 'emerald' | 'violet' | 'sky' }) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-50 text-slate-700 border-slate-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    violet: 'bg-violet-50 text-violet-700 border-violet-200',
    sky: 'bg-sky-50 text-sky-700 border-sky-200',
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

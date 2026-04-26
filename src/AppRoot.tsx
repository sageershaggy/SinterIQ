import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Building2,
  CheckCircle2,
  Clock,
  Euro,
  Filter,
  Flame,
  Kanban,
  LucideIcon,
  MapPin,
  Bot,
  Plus,
  Search,
  Sparkles,
  TrendingUp,
  Upload,
  Users,
  X,
  Download,
  Trash2,
  CalendarClock,
  Target,
  ChevronDown,
} from 'lucide-react';

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts';
import * as XLSX from 'xlsx';
import { AppUser, Company } from './appTypes';
import { showToast } from './Toast';
import CompanyCreateModal, { CompanyFormData, emptyCompanyForm } from './CompanyCreateModal';
import CompanyDetail from './CompanyDetail';
import FollowUpsTab from './FollowUpsTab';
import ImportTab from './ImportTab';
import KanbanBoard from './KanbanBoard';
import ResearchTab from './ResearchTab';
import SettingsTab from './SettingsTab';
import CommissionAdmin from './CommissionAdmin';
import { companyTypeOptions, industryOptions, internalUsers as defaultInternalUsers, leadStatusOptions } from './companyData';
import { formatCompactEur, getDateOnly, isPastDate } from './formatters';

interface FollowUp {
  follow_up_date: string;
  follow_up_done: number;
}

interface RecentActivity {
  id: number;
  company_id: number;
  company_name: string;
  activity_type: string;
  activity_date: string;
  performed_by: string;
  subject: string;
  outcome: string;
}

interface SearchResult {
  type: 'company';
  id: number;
  label: string;
  sublabel: string;
}

const PIPELINE_STAGE_COLORS: Record<string, string> = {
  RAW: '#94a3b8',
  ENRICHED: '#60a5fa',
  QUALIFIED: '#a78bfa',
  APPROVED: '#34d399',
  IN_OUTREACH: '#fbbf24',
  CONTACTED: '#fb923c',
  OPPORTUNITY: '#f59e0b',
  WON: '#10b981',
  LOST: '#f87171',
  DISQUALIFIED: '#e2e8f0',
};

const CONTACT_GUIDE_ROWS = [
  ['Topic', 'Guidance'],
  ['Goal', 'Your aim is to fully understand the customer problem and their wishes.'],
  ['Listening', 'Listen carefully and let the customer talk so new information can surface.'],
  ['Respect', 'Do not interrupt because it feels disrespectful and closes the conversation.'],
  ['Promises', 'Never promise or assure anything that Sintertechnik cannot reliably fulfill.'],
  ['Technical claims', 'If you are unsure about a technical point, say you will double-check and come back.'],
  ['Pacing', 'Talk slowly because calm pacing is often perceived as competence.'],
  ['Questions', 'Use open questions so the customer gives information instead of yes or no answers.'],
  ['Summary', 'End the call with a short summary so everyone is aligned.'],
  ['Next step', 'Agree on the next concrete step and make sure both sides know it.'],
  ['Open issues', 'Make sure the customer has no open questions left.'],
  ['Data quality', 'Confirm the address, email, and other core contact details before closing.'],
  ['FAQ', 'Be ready to answer why ceramic bearings help, cost expectations, why Sintertechnik is trustworthy, disadvantages versus steel, and delivery time.'],
];

function buildSheetColumns(rows: Array<Array<string | number>>) {
  return rows[0].map((_, columnIndex) => {
    const width = rows.reduce((maxWidth, row) => {
      const cellValue = row[columnIndex] === undefined || row[columnIndex] === null ? '' : String(row[columnIndex]);
      return Math.max(maxWidth, cellValue.length);
    }, 12);

    return { wch: Math.min(Math.max(width + 2, 12), 48) };
  });
}

export default function AppRoot() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [recentActivities, setRecentActivities] = useState<RecentActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');

  // RBAC: determine current user role from localStorage
  const currentUserName = (() => {
    try { const s = localStorage.getItem('sinteriq_user'); return s ? JSON.parse(s)?.name : ''; } catch { return ''; }
  })();
  const isAdmin = currentUserName?.toLowerCase().includes('sageer') || currentUserName?.toLowerCase().includes('admin');
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [initialTab, setInitialTab] = useState('overview');
  const [qualifyingId, setQualifyingId] = useState<number | null>(null);

  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [savingCompany, setSavingCompany] = useState(false);
  const [companyForm, setCompanyForm] = useState<CompanyFormData>(emptyCompanyForm);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [minScore, setMinScore] = useState('');
  const [maxScore, setMaxScore] = useState('');
  const [assignedFilter, setAssignedFilter] = useState('');
  const [industryFilter, setIndustryFilter] = useState('');
  const [companyTypeFilter, setCompanyTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [sortKey, setSortKey] = useState<string>('company_name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkQualifying, setBulkQualifying] = useState(false);
  const [bulkQualifyProgress, setBulkQualifyProgress] = useState({ done: 0, total: 0 });
  const bulkQualifyCancelRef = useRef(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [aiQualFilter, setAiQualFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 50;
  const searchRef = useRef<HTMLDivElement>(null);

  const loadCompanies = async () => {
    const response = await fetch('/api/companies');
    if (!response.ok) throw new Error('Failed to load companies');
    setCompanies(await response.json());
  };

  const loadUsers = async () => {
    const response = await fetch('/api/users');
    if (!response.ok) throw new Error('Failed to load users');
    setUsers(await response.json());
  };

  const loadFollowUps = async () => {
    const response = await fetch('/api/activities/follow-ups');
    if (!response.ok) throw new Error('Failed to load follow-ups');
    setFollowUps(await response.json());
  };

  const loadRecentActivities = async () => {
    try {
      const response = await fetch('/api/activities/recent');
      if (response.ok) setRecentActivities(await response.json());
    } catch (_) {}
  };

  const exportFilteredCSV = (data: Company[], filename: string) => {
    const headers = [
      'Company Name','Type','Country','City','Address','Region','Industry',
      'Employees','Revenue (EUR)','Website','DUNS Number','Legal Form','Main Products','Corporate Parent','Source',
      'Lead Score','Technical Fit','Lead Priority','Product Fit','Lead Status','Buying Probability',
      'Website Score','Social Score','Social Media Active','Mentions Technology',
      'Assigned To','Created By','Created At','Updated At','AI Qualified At',
      'Approach Strategy','Opportunity Notes','Qualification Notes',
      'Sales Script','Email Script',
      'Tracking Level','Tracking Status','Next Tracking Date','Contacts'
    ];
    const rows = data.map((c: any) => [
      c.company_name, c.company_type, c.country, c.city||'', c.address||'', c.region||'', c.industry,
      c.employee_count||'', c.revenue_eur||'', c.website||'', c.duns_number||'', c.legal_form||'', c.main_products||'', c.corporate_parent||'', c.source||'',
      c.lead_score??'', c.technical_fit||'', c.lead_priority||'', c.product_fit||'', c.lead_status, c.buying_probability??'',
      c.website_score??'', c.social_score??'', c.social_media_active?'Yes':'No', c.mentions_technology?'Yes':'No',
      c.assigned_to||'', c.created_by||'', c.created_at||'', c.updated_at||'', c.ai_qualified_at||'',
      (c.approach_strategy||'').replace(/\n/g,' '), (c.opportunity_notes||'').replace(/\n/g,' '), (c.qualification_notes||'').replace(/\n/g,' '),
      (c.sales_script||'').replace(/\n/g,' '), (c.email_script||'').replace(/\n/g,' '),
      c.tracking_level||'', c.tracking_status||'', c.next_tracking_date||'', c.contact_count??''
    ]);
    const bom = '\uFEFF';
    const csv = bom + [headers,...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}_${data.length}companies.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('success', 'Export ready', `${data.length} companies exported`);
  };

  const handleExportCustomerTracker = async () => {
    try {
      const response = await fetch('/api/export/customer-tracker');
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.headers || !payload?.rows) {
        throw new Error(payload?.error || 'Failed to build export');
      }

      const trackerRows: Array<Array<string | number>> = [payload.headers, ...payload.rows];
      const workbook = XLSX.utils.book_new();
      const trackerSheet = XLSX.utils.aoa_to_sheet(trackerRows);
      trackerSheet['!cols'] = buildSheetColumns(trackerRows);
      trackerSheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_cell({ r: 0, c: payload.headers.length - 1 })}` };

      const guideSheet = XLSX.utils.aoa_to_sheet(CONTACT_GUIDE_ROWS);
      guideSheet['!cols'] = buildSheetColumns(CONTACT_GUIDE_ROWS);

      XLSX.utils.book_append_sheet(workbook, trackerSheet, 'Customer Tracker');
      XLSX.utils.book_append_sheet(workbook, guideSheet, 'Contacting Guide');

      const fileDate = new Date().toISOString().split('T')[0];
      XLSX.writeFile(workbook, `SinterIQ_Customer_Tracker_${fileDate}_${payload.rows.length}rows.xlsx`);
      showToast('success', 'Export ready', `${payload.rows.length} rows exported`);
    } catch (error) {
      console.error(error);
      showToast('error', 'Export failed', error instanceof Error ? error.message : '');
    }
  };

  // URL routing: read hash on load
  useEffect(() => {
    const hash = window.location.hash.replace('#/', '').replace('#', '');
    if (hash.startsWith('company/')) {
      const parts = hash.split('/');
      setSelectedCompanyId(Number(parts[1]));
      if (parts[2]) setInitialTab(parts[2]);
    } else if (hash && ['dashboard', 'companies', 'pipeline', 'research', 'import', 'settings'].includes(hash)) {
      setActiveTab(hash);
    }
  }, []);

  // URL routing: update hash on navigation
  useEffect(() => {
    if (selectedCompanyId) {
      window.history.replaceState(null, '', `#/company/${selectedCompanyId}`);
    } else {
      window.history.replaceState(null, '', `#/${activeTab}`);
    }
  }, [activeTab, selectedCompanyId]);

  useEffect(() => {
    const loadAppData = async () => {
      try {
        await Promise.all([loadCompanies(), loadFollowUps(), loadUsers(), loadRecentActivities()]);
      } catch (error) {
        console.error('Failed to load app data:', error);
      } finally {
        setLoading(false);
      }
    };
    void loadAppData();
  }, []);

  // Close search dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearchDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const totalRevenue = companies.reduce((sum, company) => sum + (company.revenue_eur || 0), 0);
  const activeUsers = users.filter((user) => user.is_active).map((user) => user.full_name);
  const userOptions = activeUsers.length > 0 ? activeUsers : [...defaultInternalUsers];
  const qualifiedCount = companies.filter((company) => company.lead_status === 'QUALIFIED').length;
  const today = getDateOnly(new Date().toISOString());
  const overdueFollowUpsCount = followUps.filter(
    (followUp) => !followUp.follow_up_done && getDateOnly(followUp.follow_up_date) < today,
  ).length;
  const trackingDueCount = companies.filter(
    (company) => company.next_tracking_date && getDateOnly(company.next_tracking_date) <= today,
  ).length;

  const filteredCompanies = companies.filter((company) => {
    if (minScore && company.lead_score !== null && company.lead_score < parseInt(minScore, 10)) return false;
    if (maxScore && company.lead_score !== null && company.lead_score > parseInt(maxScore, 10)) return false;
    if (assignedFilter && company.assigned_to !== assignedFilter) return false;
    if (industryFilter && company.industry !== industryFilter) return false;
    if (companyTypeFilter && company.company_type !== companyTypeFilter) return false;
    if (statusFilter && company.lead_status !== statusFilter) return false;
    if (aiQualFilter === 'AI_QUALIFIED' && !company.ai_qualified_at) return false;
    if (aiQualFilter === 'NOT_QUALIFIED' && company.ai_qualified_at) return false;
    if (aiQualFilter === 'ENRICHED' && company.lead_status !== 'ENRICHED') return false;
    if (dateFrom && company.updated_at && company.updated_at < dateFrom) return false;
    if (dateTo && company.updated_at && company.updated_at > dateTo + 'T23:59:59') return false;
    if (!searchQuery.trim()) return true;
    const haystack = [company.company_name, company.country, company.city, company.industry, company.company_type, company.assigned_to]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(searchQuery.trim().toLowerCase());
  });

  const sortedCompanies = [...filteredCompanies].sort((a, b) => {
    const av = (a as any)[sortKey] ?? '';
    const bv = (b as any)[sortKey] ?? '';
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });
  const qualifiedExportCompanies = sortedCompanies.filter((company) => company.lead_status === 'QUALIFIED');
  const approvedExportCompanies = sortedCompanies.filter((company) => company.lead_status === 'APPROVED');
  const disqualifiedExportCompanies = sortedCompanies.filter((company) => company.lead_status === 'DISQUALIFIED');

  const totalPages = Math.ceil(sortedCompanies.length / PAGE_SIZE);
  const paginatedCompanies = sortedCompanies.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Reset page when filters change
  useEffect(() => { setCurrentPage(1); setSelectedIds(new Set()); }, [searchQuery, assignedFilter, industryFilter, companyTypeFilter, statusFilter, aiQualFilter, minScore, maxScore, dateFrom, dateTo]);

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults([]);
      setShowSearchDropdown(false);
      return;
    }
    const q = query.trim().toLowerCase();
    const results: SearchResult[] = companies
      .filter((c) => {
        const haystack = [c.company_name, c.country, c.city, c.industry, c.assigned_to].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      })
      .slice(0, 8)
      .map((c) => ({
        type: 'company' as const,
        id: c.id,
        label: c.company_name,
        sublabel: `${c.city ? c.city + ', ' : ''}${c.country} · ${c.lead_status}`,
      }));
    setSearchResults(results);
    setShowSearchDropdown(results.length > 0);
  };

  const handleSearchSelect = (result: SearchResult) => {
    setShowSearchDropdown(false);
    setSearchQuery('');
    openCompany(result.id);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && searchResults.length > 0) {
      handleSearchSelect(searchResults[0]);
    }
    if (e.key === 'Escape') {
      setShowSearchDropdown(false);
    }
  };

  const openCompany = (id: number, tab = 'overview') => {
    setInitialTab(tab);
    setSelectedCompanyId(id);
    setActiveTab('companies');
    setSearchQuery('');
    setShowSearchDropdown(false);
  };

  const handleDataChanged = async () => {
    await Promise.all([loadCompanies(), loadFollowUps(), loadRecentActivities()]);
  };

  const handleAIQualify = async (id: number) => {
    setQualifyingId(id);
    showToast('info', 'AI Qualification started', 'Searching the web and analyzing...');
    try {
      const response = await fetch(`/api/companies/${id}/ai-qualify?force=true`, { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || 'AI qualification failed');
      setCompanies((prev) => prev.map((c) => (c.id === id ? { ...c, ...payload } : c)));
      showToast('success', 'AI Qualification complete', `${payload.company_name}: Score ${payload.lead_score || 0}`);
    } catch (error) {
      console.error(error);
      const msg = error instanceof Error ? error.message : 'AI qualification failed.';
      showToast('error', 'AI Qualification failed', msg + ' Check Settings for API key.');
    } finally {
      setQualifyingId(null);
    }
  };

  const handleStatusChange = async (id: number, newStatus: string) => {
    try {
      const response = await fetch(`/api/companies/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_status: newStatus }),
      });
      if (response.ok) {
        setCompanies((prev) => prev.map((c) => (c.id === id ? { ...c, lead_status: newStatus } : c)));
      }
    } catch (error) {
      console.error(error);
    }
  };



  const handleDeleteCompany = async (id: number) => {
    if (!confirm('Delete this company and all its contacts, activities, and notes? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/companies/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setCompanies((prev) => prev.filter((c) => c.id !== id));
        showToast('success', 'Company deleted');
      }
    } catch (err) {
      showToast('error', 'Failed to delete company');
    } finally {
      setDeletingId(null);
    }
  };

  const handleBulkAIQualify = async () => {
    const rawLeads = filteredCompanies.filter((c: any) => c.lead_status === 'RAW');
    if (rawLeads.length === 0) {
      showToast('info', 'No RAW leads', 'No unqualified RAW leads found in the current view.');
      return;
    }
    if (!confirm(`Run AI qualification on ${rawLeads.length} RAW leads in parallel (3 at a time)?`)) return;
    setBulkQualifying(true);
    bulkQualifyCancelRef.current = false;
    setBulkQualifyProgress({ done: 0, total: rawLeads.length });

    const CONCURRENCY = 3;
    const queue = [...rawLeads];
    let done = 0;
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    const worker = async () => {
      while (queue.length > 0 && !bulkQualifyCancelRef.current) {
        const lead = queue.shift();
        if (!lead) break;
        setQualifyingId(lead.id);
        try {
          const response = await fetch(`/api/companies/${lead.id}/ai-qualify`, { method: 'POST' });
          const payload = await response.json().catch(() => null);
          if (!response.ok) throw new Error(payload?.error || 'Failed');
          if (payload?.skipped) {
            skippedCount++;
          } else {
            setCompanies((prev: any[]) => prev.map((c: any) => (c.id === lead.id ? { ...c, ...payload } : c)));
            successCount++;
          }
        } catch {
          failCount++;
        }
        done++;
        setBulkQualifyProgress({ done, total: rawLeads.length });
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    setQualifyingId(null);
    setBulkQualifying(false);
    setBulkQualifyProgress({ done: 0, total: 0 });
    const parts = [`${successCount} qualified`];
    if (skippedCount > 0) parts.push(`${skippedCount} skipped (recently qualified)`);
    if (failCount > 0) parts.push(`${failCount} failed`);
    showToast(failCount > 0 ? 'info' : 'success', 'Bulk AI Qualification complete', parts.join(', '));
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} selected companies and all their contacts, activities, and notes? This cannot be undone.`)) return;
    setBulkDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      await Promise.all(ids.map(id => fetch(`/api/companies/${id}`, { method: 'DELETE' })));
      setCompanies((prev) => prev.filter((c) => !selectedIds.has(c.id)));
      showToast('success', `${ids.length} companies deleted`);
      setSelectedIds(new Set());
    } catch (err) {
      showToast('error', 'Failed to delete some companies');
    } finally {
      setBulkDeleting(false);
    }
  };

  const toggleSelectCompany = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === paginatedCompanies.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginatedCompanies.map(c => c.id)));
    }
  };

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const handleCreateCompany = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingCompany(true);
    try {
      const response = await fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...companyForm,
          employee_count: companyForm.employee_count ? parseInt(companyForm.employee_count, 10) : null,
          revenue_eur: companyForm.revenue_eur ? parseFloat(companyForm.revenue_eur) : null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409 && payload?.duplicate_id) {
        const goToExisting = confirm(
          `${payload.error}\n\nClick OK to open the existing company, or Cancel to go back.`
        );
        if (goToExisting) {
          setShowCompanyForm(false);
          openCompany(payload.duplicate_id);
        }
        setSavingCompany(false);
        return;
      }
      if (!response.ok) throw new Error(payload?.error || 'Failed to create company');
      await loadCompanies();
      setShowCompanyForm(false);
      setCompanyForm(emptyCompanyForm);
      showToast('success', 'Company created', payload.company_name);
      openCompany(payload.id);
    } catch (error) {
      console.error(error);
      showToast('error', 'Failed to create company', error instanceof Error ? error.message : '');
    } finally {
      setSavingCompany(false);
    }
  };

  // --- Dashboard ---
  const pipelineByStage = leadStatusOptions.map((opt) => ({
    name: opt.label,
    key: opt.value,
    count: companies.filter((c) => c.lead_status === opt.value).length,
    value: companies.filter((c) => c.lead_status === opt.value).reduce((s, c) => s + (c.revenue_eur || 0), 0),
  })).filter((s) => s.count > 0);

  const regionCounts = companies.reduce<Record<string, number>>((acc, c) => {
    const r = c.country || 'Unknown';
    acc[r] = (acc[r] || 0) + 1;
    return acc;
  }, {});
  const regionData = Object.entries(regionCounts).map(([name, value]) => ({ name, value }));

  const activityTypeLabel: Record<string, string> = {
    CALL_MADE: 'Call', EMAIL_SENT: 'Email', MEETING_HELD: 'Meeting',
    LINKEDIN_MESSAGE: 'LinkedIn', NOTE: 'Note',
  };

  const renderSkeletonCards = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm animate-pulse">
          <div className="h-3 bg-slate-200 rounded mb-3 w-28" />
          <div className="h-8 bg-slate-200 rounded w-20" />
        </div>
      ))}
    </div>
  );

  const renderDashboard = () => (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Pipeline Dashboard</h1>

      {loading ? renderSkeletonCards() : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="sinter-card sinter-kpi p-5 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-slate-500">Total Companies</h3>
              <Building2 className="w-4 h-4 text-slate-400" />
            </div>
            <div className="text-3xl font-bold text-slate-900">{companies.length}</div>
          </div>
          <div className="sinter-card sinter-kpi p-5 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-slate-500">Qualified Leads</h3>
              <CheckCircle2 className="w-4 h-4 text-green-500" />
            </div>
            <div className="text-3xl font-bold text-slate-900">{qualifiedCount}</div>
          </div>
          <div className="sinter-card sinter-kpi p-5 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-slate-500">Pipeline Value</h3>
              <Euro className="w-4 h-4 text-blue-500" />
            </div>
            <div className="text-3xl font-bold text-slate-900">{formatCompactEur(totalRevenue)}</div>
          </div>
          <div
            className="sinter-card sinter-kpi p-5 rounded-lg cursor-pointer hover:border-red-300 transition-colors"
            onClick={() => setActiveTab('followups')}
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-slate-500">Overdue Follow-ups</h3>
              <AlertCircle className="w-4 h-4 text-red-500" />
            </div>
            <div className={`text-3xl font-bold ${overdueFollowUpsCount > 0 ? 'text-red-600' : 'text-slate-900'}`}>
              {overdueFollowUpsCount}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pipeline by stage bar chart */}
        <div className="lg:col-span-2 sinter-card rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-5 h-5 text-blue-500" />
            <h2 className="text-base font-semibold text-slate-900">Pipeline by Stage</h2>
          </div>
          {loading || pipelineByStage.length === 0 ? (
            <div className="text-slate-400 text-sm text-center py-8">No pipeline data yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={pipelineByStage} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  formatter={(value: number, name: string) =>
                    name === 'count' ? [value, 'Companies'] : [formatCompactEur(value), 'Revenue']
                  }
                />
                <Bar dataKey="count" name="count" radius={[4, 4, 0, 0]}>
                  {pipelineByStage.map((entry) => (
                    <Cell key={entry.key} fill={PIPELINE_STAGE_COLORS[entry.key] || '#94a3b8'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Leads by country donut */}
        <div className="sinter-card rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4">
            <MapPin className="w-5 h-5 text-indigo-500" />
            <h2 className="text-base font-semibold text-slate-900">Leads by Country</h2>
          </div>
          {loading || regionData.length === 0 ? (
            <div className="text-slate-400 text-sm text-center py-8">No data yet.</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={140}>
                <PieChart>
                  <Pie data={regionData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} fontSize={10}>
                    {regionData.map((_, i) => (
                      <Cell key={i} fill={['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'][i % 6]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Activity */}
        <div className="sinter-card rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-5 h-5 text-slate-400" />
            <h2 className="text-lg font-semibold text-slate-900">Recent Activity</h2>
          </div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse flex gap-3">
                  <div className="w-8 h-8 bg-slate-200 rounded-full shrink-0" />
                  <div className="flex-1 space-y-1">
                    <div className="h-3 bg-slate-200 rounded w-3/4" />
                    <div className="h-3 bg-slate-200 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : recentActivities.length === 0 ? (
            <div className="text-slate-400 text-sm text-center py-6">No activities logged yet. Log your first activity on a company's Activity History tab.</div>
          ) : (
            <div className="space-y-3">
              {recentActivities.slice(0, 6).map((activity) => (
                <div
                  key={activity.id}
                  className="flex items-start gap-3 p-2 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors"
                  onClick={() => openCompany(activity.company_id, 'activities')}
                >
                  <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold shrink-0">
                    {(activityTypeLabel[activity.activity_type] || 'A')[0]}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{activity.subject || activity.activity_type}</div>
                    <div className="text-xs text-slate-500">
                      <span className="text-blue-600 hover:underline">{activity.company_name}</span>
                      {' · '}
                      {activity.performed_by}
                      {' · '}
                      {new Date(activity.activity_date).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upcoming Follow-ups */}
        <div className="sinter-card rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CalendarClock className="w-5 h-5 text-orange-400" />
              <h2 className="text-lg font-semibold text-slate-900">Upcoming Follow-ups</h2>
            </div>
            <button onClick={() => setActiveTab('followups')} className="text-xs text-blue-600 hover:underline">View all →</button>
          </div>
          {followUps.filter(f => !f.follow_up_done).length === 0 ? (
            <div className="text-slate-400 text-sm text-center py-4">No pending follow-ups</div>
          ) : (
            <div className="space-y-2">
              {followUps.filter(f => !f.follow_up_done).slice(0, 5).map((f: any, i: number) => {
                const isOverdue = f.follow_up_date && f.follow_up_date.slice(0, 10) < new Date().toISOString().slice(0, 10);
                return (
                  <div key={i} className={`flex items-center justify-between p-2.5 rounded-lg border transition-colors cursor-pointer hover:bg-slate-50 ${isOverdue ? 'border-red-200 bg-red-50/50' : 'border-slate-100'}`}
                    onClick={() => f.company_id && openCompany(f.company_id, 'activities')}>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{f.company_name || 'Unknown'}</div>
                      <div className="text-xs text-slate-500">{f.subject || f.activity_type}</div>
                    </div>
                    <div className="text-right shrink-0 ml-2">
                      <div className={`text-xs font-medium ${isOverdue ? 'text-red-600' : 'text-slate-600'}`}>
                        {f.follow_up_date ? new Date(f.follow_up_date).toLocaleDateString() : '-'}
                      </div>
                      {isOverdue && <div className="text-[10px] text-red-500 font-medium">OVERDUE</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* My Assigned Leads */}
        <div className="sinter-card rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-5 h-5 text-slate-400" />
            <h2 className="text-lg font-semibold text-slate-900">My Assigned Leads</h2>
          </div>
          {loading ? (
            <div className="space-y-2 animate-pulse">
              {[1, 2, 3, 4].map((i) => <div key={i} className="h-10 bg-slate-100 rounded-lg" />)}
            </div>
          ) : companies.length === 0 ? (
            <div className="text-slate-400 text-sm text-center py-6">No companies yet.</div>
          ) : (
            <div className="space-y-2">
              {companies.slice(0, 5).map((company) => (
                <div
                  key={company.id}
                  className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors"
                  onClick={() => openCompany(company.id)}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{company.company_name}</div>
                    <div className="text-xs text-slate-500">{company.assigned_to || 'Unassigned'}</div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ml-2 ${
                    company.lead_status === 'QUALIFIED' || company.lead_status === 'APPROVED' ? 'bg-green-100 text-green-700' :
                    company.lead_status === 'WON' ? 'bg-emerald-100 text-emerald-700' :
                    company.lead_status === 'LOST' || company.lead_status === 'DISQUALIFIED' ? 'bg-red-100 text-red-700' :
                    'bg-slate-100 text-slate-600'
                  }`}>
                    {company.lead_status}
                  </span>
                </div>
              ))}
              {companies.length > 5 && (
                <button onClick={() => setActiveTab('companies')} className="text-xs text-blue-600 hover:underline w-full text-center pt-1">
                  View all {companies.length} companies →
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // --- Companies list ---
  const renderCompanies = () => (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Companies</h1>
            <p className="text-sm text-slate-500 mt-1">{filteredCompanies.length} companies match the current view</p>
          </div>
          {selectedIds.size > 0 && (
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="flex items-center gap-2 px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              {bulkDeleting ? 'Deleting...' : `Delete ${selectedIds.size} selected`}
            </button>
          )}
        </div>
        <div className="flex items-center gap-4">
          {bulkQualifying ? (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-purple-50 border border-purple-200 rounded-md text-sm font-medium text-purple-700">
              <Sparkles className="w-4 h-4 animate-pulse" />
              <span>Qualifying {bulkQualifyProgress.done}/{bulkQualifyProgress.total}...</span>
              <button
                onClick={() => { bulkQualifyCancelRef.current = true; }}
                className="ml-1 text-purple-400 hover:text-purple-700"
                title="Cancel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={handleBulkAIQualify}
              className="flex items-center gap-2 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-md text-sm font-medium transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              Run AI
            </button>
          )}
          <select
            value={assignedFilter}
            onChange={(event) => setAssignedFilter(event.target.value)}
            className="bg-white border border-slate-300 text-slate-700 px-3 py-1.5 rounded-md text-sm font-medium outline-none"
          >
            <option value="">All Users</option>
            {userOptions.map((user) => (
              <option key={user} value={user}>{user}</option>
            ))}
          </select>
          <div className="flex items-center gap-2 bg-white border border-slate-300 px-3 py-1.5 rounded-md text-sm">
            <span className="text-slate-500 font-medium">Score:</span>
            <input type="number" placeholder="Min" value={minScore} onChange={(e) => setMinScore(e.target.value)} className="w-14 outline-none bg-transparent placeholder:text-slate-300" />
            <span className="text-slate-300">-</span>
            <input type="number" placeholder="Max" value={maxScore} onChange={(e) => setMaxScore(e.target.value)} className="w-14 outline-none bg-transparent placeholder:text-slate-300" />
          </div>
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={`flex items-center gap-2 border px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              (industryFilter || companyTypeFilter || statusFilter || aiQualFilter || dateFrom || dateTo)
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : showFilters ? 'bg-slate-100 border-slate-300 text-slate-800'
                : 'bg-white border-slate-300 hover:bg-slate-50 text-slate-700'
            }`}
          >
            <Filter className="w-4 h-4" /> Filters
            {(() => {
              const count = [industryFilter, companyTypeFilter, statusFilter, aiQualFilter, dateFrom, dateTo].filter(Boolean).length;
              return count > 0 ? <span className="bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">{count}</span> : null;
            })()}
          </button>
          <div className="relative group">
            <button
              className="flex items-center gap-2 border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 rounded-md text-sm font-medium text-slate-700 transition-colors"
            >
              <Download className="w-4 h-4" /> Export <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>
            <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-56 z-50 hidden group-hover:block">
              {selectedIds.size > 0 && (
                <>
                  <button
                    onClick={() => {
                      const selectedCompanies = sortedCompanies.filter((c) => selectedIds.has(c.id));
                      if (selectedCompanies.length === 0) { showToast('info', 'No companies selected'); return; }
                      exportFilteredCSV(selectedCompanies, `SinterIQ_Selected_${new Date().toISOString().split('T')[0]}`);
                    }}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50 text-blue-700 font-medium"
                  >
                    Export Selected ({selectedIds.size})
                  </button>
                  <div className="border-t border-slate-100 my-1" />
                </>
              )}
              <button
                onClick={() => { void handleExportCustomerTracker(); }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50 text-slate-700"
              >
                Export All ({companies.length} companies)
              </button>
              <button
                onClick={() => {
                  if (qualifiedExportCompanies.length === 0) { showToast('info', 'No qualified leads to export'); return; }
                  exportFilteredCSV(qualifiedExportCompanies, `SinterIQ_Qualified_${new Date().toISOString().split('T')[0]}`);
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50 text-slate-700"
              >
                Export Qualified Only ({qualifiedExportCompanies.length})
              </button>
              <button
                onClick={() => {
                  exportFilteredCSV(sortedCompanies, `SinterIQ_Filtered_${new Date().toISOString().split('T')[0]}`);
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50 text-slate-700"
              >
                Export Current Filter ({filteredCompanies.length})
              </button>
              <div className="border-t border-slate-100 my-1" />
              <button
                onClick={() => {
                  if (approvedExportCompanies.length === 0) { showToast('info', 'No approved leads'); return; }
                  exportFilteredCSV(approvedExportCompanies, `SinterIQ_Approved_${new Date().toISOString().split('T')[0]}`);
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50 text-green-700"
              >
                Export Approved ({approvedExportCompanies.length})
              </button>
              <button
                onClick={() => {
                  if (disqualifiedExportCompanies.length === 0) { showToast('info', 'No disqualified leads'); return; }
                  exportFilteredCSV(disqualifiedExportCompanies, `SinterIQ_Disqualified_${new Date().toISOString().split('T')[0]}`);
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50 text-red-600"
              >
                Export Disqualified ({disqualifiedExportCompanies.length})
              </button>
            </div>
          </div>
        </div>
      </div>

      {showFilters && (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm p-4 space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Industry</label>
              <select value={industryFilter} onChange={(e) => setIndustryFilter(e.target.value)} className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none">
                <option value="">All Industries</option>
                {industryOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Company Type</label>
              <select value={companyTypeFilter} onChange={(e) => setCompanyTypeFilter(e.target.value)} className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none">
                <option value="">All Types</option>
                {companyTypeOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Lead Status</label>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none">
                <option value="">All Statuses</option>
                {leadStatusOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">AI Qualification</label>
              <select value={aiQualFilter} onChange={(e) => setAiQualFilter(e.target.value)} className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none">
                <option value="">All</option>
                <option value="AI_QUALIFIED">AI Qualified</option>
                <option value="NOT_QUALIFIED">Not Qualified</option>
                <option value="ENRICHED">Enriched</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Updated From</label>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Updated To</label>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none" />
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
            {(industryFilter || companyTypeFilter || statusFilter || aiQualFilter || dateFrom || dateTo || minScore || maxScore) && (
              <span className="text-xs text-slate-500 mr-auto">
                {filteredCompanies.length} of {companies.length} companies shown
              </span>
            )}
            <button
              onClick={() => {
                setIndustryFilter(''); setCompanyTypeFilter(''); setStatusFilter('');
                setAiQualFilter(''); setDateFrom(''); setDateTo('');
                setMinScore(''); setMaxScore(''); setAssignedFilter('');
              }}
              className="px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
            >
              Clear All
            </button>
            <button
              onClick={() => setShowFilters(false)}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
            >
              Apply Filters
            </button>
          </div>
        </div>
      )}

      <div className="sinter-card rounded-lg overflow-x-auto max-h-[calc(100vh-320px)] overflow-y-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 sticky top-0 z-10">
            <tr>
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  checked={paginatedCompanies.length > 0 && selectedIds.size === paginatedCompanies.length}
                  onChange={toggleSelectAll}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              {[
                { key: 'company_name', label: 'Company Name', cls: 'px-6' },
                { key: 'country', label: 'Location', cls: 'px-6' },
                { key: 'contact_count', label: 'Contacts', cls: 'px-6 text-center' },
                { key: 'lead_score', label: 'Score', cls: 'px-6' },
                { key: 'technical_fit', label: 'Tech Fit', cls: 'px-4' },
                { key: 'lead_status', label: 'Status', cls: 'px-4' },
                { key: 'assigned_to', label: 'Assigned To', cls: 'px-4' },
                { key: 'updated_at', label: 'Updated', cls: 'px-4' },
              ].map(col => (
                <th key={col.key} className={`${col.cls} py-3 font-medium cursor-pointer hover:text-blue-600 select-none transition-colors`}
                  onClick={() => toggleSort(col.key)}>
                  {col.label}
                  {sortKey === col.key && <span className="ml-1 text-blue-500">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                </th>
              ))}
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {loading ? (
              <tr>
                <td colSpan={10} className="px-6 py-8 text-center text-slate-500">Loading companies...</td>
              </tr>
            ) : filteredCompanies.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-6 py-8 text-center text-slate-500">No companies matched the current filters.</td>
              </tr>
            ) : (
              paginatedCompanies.map((company) => (
                <tr key={company.id} onClick={() => openCompany(company.id)} className={`hover:bg-slate-50 cursor-pointer transition-colors ${selectedIds.has(company.id) ? 'bg-blue-50' : ''}`}>
                  <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(company.id)}
                      onChange={() => toggleSelectCompany(company.id)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                  </td>
                  <td className="px-6 py-4">
                    <div className="font-medium text-slate-900">{company.company_name}</div>
                    <div className="text-slate-500 text-xs mt-0.5">{company.company_type}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-1.5 text-slate-700">
                      <MapPin className="w-3.5 h-3.5 text-slate-400" />
                      {company.city ? `${company.city}, ` : ''}{company.country}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-center">
                    <button
                      onClick={(e) => { e.stopPropagation(); openCompany(company.id, 'contacts'); }}
                      className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition-colors"
                    >
                      {company.contact_count || 0}
                    </button>
                  </td>
                  <td className="px-6 py-4">{company.lead_score ?? '-'}</td>
                  <td className="px-4 py-4">
                    {company.technical_fit ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        company.technical_fit === 'HIGH' ? 'bg-green-100 text-green-700' :
                        company.technical_fit === 'MEDIUM' ? 'bg-yellow-100 text-yellow-700' :
                        company.technical_fit === 'LOW' ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-600'
                      }`}>{company.technical_fit.replace('_', ' ')}</span>
                    ) : <span className="text-slate-400 text-xs">-</span>}
                  </td>
                  <td className="px-4 py-4">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      company.lead_status === 'QUALIFIED' || company.lead_status === 'APPROVED' ? 'bg-green-100 text-green-700' :
                      company.lead_status === 'WON' ? 'bg-emerald-100 text-emerald-700' :
                      company.lead_status === 'LOST' || company.lead_status === 'DISQUALIFIED' ? 'bg-red-100 text-red-700' :
                      company.lead_status === 'IN_OUTREACH' || company.lead_status === 'CONTACTED' ? 'bg-blue-100 text-blue-700' :
                      'bg-slate-100 text-slate-600'
                    }`}>{company.lead_status.replace('_', ' ')}</span>
                  </td>
                  <td className="px-4 py-4 text-slate-700 text-xs">{company.assigned_to || <span className="text-slate-400">—</span>}</td>
                  <td className="px-4 py-4 text-slate-500 text-xs">
                    {company.updated_at ? new Date(company.updated_at).toLocaleDateString() : '-'}
                  </td>
                  <td className="px-4 py-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleAIQualify(company.id); }}
                        disabled={qualifyingId === company.id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        {qualifyingId === company.id ? 'Working...' : 'AI Qualify'}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDeleteCompany(company.id); }}
                        disabled={deletingId === company.id}
                        className="inline-flex items-center p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50"
                        title="Delete company"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          <div className="text-sm text-slate-500">
            Showing {((currentPage - 1) * PAGE_SIZE) + 1}–{Math.min(currentPage * PAGE_SIZE, filteredCompanies.length)} of {filteredCompanies.length}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(1)}
              disabled={currentPage === 1}
              className="px-2 py-1 text-xs rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-default"
            >
              First
            </button>
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="px-2.5 py-1 text-xs rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-default"
            >
              ← Prev
            </button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let page: number;
              if (totalPages <= 5) { page = i + 1; }
              else if (currentPage <= 3) { page = i + 1; }
              else if (currentPage >= totalPages - 2) { page = totalPages - 4 + i; }
              else { page = currentPage - 2 + i; }
              return (
                <button
                  key={page}
                  onClick={() => setCurrentPage(page)}
                  className={`px-2.5 py-1 text-xs rounded border ${
                    currentPage === page
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {page}
                </button>
              );
            })}
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="px-2.5 py-1 text-xs rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-default"
            >
              Next →
            </button>
            <button
              onClick={() => setCurrentPage(totalPages)}
              disabled={currentPage === totalPages}
              className="px-2 py-1 text-xs rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-default"
            >
              Last
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const navigationItems: Array<{ icon: LucideIcon; key: string; label: string }> = [
    { key: 'dashboard', label: 'Dashboard', icon: Activity },
    { key: 'companies', label: 'Companies', icon: Building2 },
    { key: 'pipeline', label: 'Pipeline', icon: Kanban },
    { key: 'research', label: 'Lead Research', icon: Search },
    { key: 'import', label: 'Import Data', icon: Upload },
    ...(isAdmin ? [{ key: 'commissions', label: 'Commissions', icon: Euro as LucideIcon }] : []),
    { key: 'settings', label: 'Settings', icon: Bot },
  ];

  return (
    <div className="sinter-shell min-h-screen text-slate-900 font-sans flex">
      <aside className="sinter-sidebar w-64 text-slate-300 flex flex-col shrink-0">
        <div className="p-4 border-b border-white/10">
          <div className="flex items-center gap-3 mb-1">
            <div className="sinter-brand-mark w-8 h-8 rounded flex items-center justify-center text-white">
              <Flame className="w-5 h-5" />
            </div>
            <div className="sinter-brand-title font-bold text-white tracking-tight text-xl">SinterIQ</div>
          </div>
          <div className="text-xs text-slate-400 font-medium ml-11">Hi-Tech Lead Intelligence</div>
        </div>
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {navigationItems.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => { setActiveTab(key); setSelectedCompanyId(null); }}
              className={`sinter-nav-button w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors text-sm ${
                activeTab === key && !selectedCompanyId ? 'sinter-nav-button-active' : ''
              }`}
            >
              <Icon className={`w-4 h-4 shrink-0 ${activeTab === key && !selectedCompanyId ? 'text-sky-300' : ''}`} />
              {label}
            </button>
          ))}
        </nav>
        {/* User footer */}
        <div className="p-4 border-t border-white/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className="sinter-brand-mark w-7 h-7 rounded-full flex items-center justify-center text-xs text-white font-medium shrink-0">
                {(() => { try { const u = JSON.parse(localStorage.getItem('sinteriq_user') || '{}'); return u.name?.split(' ').map((n: string) => n[0]).join('').slice(0, 2) || '?'; } catch { return '?'; } })()}
              </div>
              <div className="min-w-0">
                <div className="text-xs text-white font-medium truncate">
                  {(() => { try { return JSON.parse(localStorage.getItem('sinteriq_user') || '{}').name || 'User'; } catch { return 'User'; } })()}
                </div>
                <div className="text-[10px] text-slate-500 truncate">
                  {(() => { try { return JSON.parse(localStorage.getItem('sinteriq_user') || '{}').role || ''; } catch { return ''; } })()}
                </div>
              </div>
            </div>
            <button
              onClick={() => { localStorage.removeItem('sinteriq_user'); window.location.reload(); }}
              className="text-slate-500 hover:text-red-400 text-xs font-medium transition-colors"
              title="Sign out"
            >
              Logout
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="sinter-topbar h-16 flex items-center justify-between px-6 shrink-0">
          <div className="relative w-96" ref={searchRef}>
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              onFocus={() => searchResults.length > 0 && setShowSearchDropdown(true)}
              placeholder="Search companies, countries, assignees..."
              className="sinter-search w-full pl-9 pr-8 py-2 rounded-md text-sm outline-none transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); setSearchResults([]); setShowSearchDropdown(false); }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            {showSearchDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 overflow-hidden">
                {searchResults.map((result) => (
                  <button
                    key={`${result.type}-${result.id}`}
                    onClick={() => handleSearchSelect(result)}
                    className="w-full flex items-start gap-3 px-4 py-3 hover:bg-slate-50 text-left transition-colors"
                  >
                    <Building2 className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-slate-900">{result.label}</div>
                      <div className="text-xs text-slate-500">{result.sublabel}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setShowCompanyForm(true)}
            className="sinter-button-primary flex items-center gap-2 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> New Company
          </button>
        </header>

        <div className="sinter-content flex-1 overflow-auto p-6">
          {selectedCompanyId ? (
            <CompanyDetail
              companyId={selectedCompanyId}
              onBack={() => { setSelectedCompanyId(null); setInitialTab('overview'); }}
              initialTab={initialTab}
              onDataChanged={handleDataChanged}
              users={userOptions}
            />
          ) : activeTab === 'dashboard' ? (
            <div className="space-y-6">
              {renderDashboard()}
              {/* Action Items — follow-ups merged into dashboard */}
              <div className="mt-2">
                <FollowUpsTab onCompanyClick={(id) => openCompany(id, 'activities')} onChange={setFollowUps} />
              </div>
            </div>
          ) : activeTab === 'pipeline' ? (
            <KanbanBoard companies={companies} onCompanyClick={openCompany} onStatusChange={handleStatusChange} />
          ) : activeTab === 'research' ? (
            <ResearchTab users={userOptions} onCompanyClick={openCompany} />
          ) : activeTab === 'commissions' && isAdmin ? (
            <CommissionAdmin />
          ) : activeTab === 'settings' ? (
            <SettingsTab />
          ) : activeTab === 'import' ? (
            <ImportTab onImportComplete={loadCompanies} />
          ) : (
            renderCompanies()
          )}
        </div>
      </main>

      <CompanyCreateModal
        open={showCompanyForm}
        form={companyForm}
        onChange={setCompanyForm}
        onClose={() => setShowCompanyForm(false)}
        onSubmit={handleCreateCompany}
        submitting={savingCompany}
        users={userOptions}
      />
    </div>
  );
}

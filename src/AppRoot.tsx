import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock,
  Euro,
  Filter,
  Flame,
  LucideIcon,
  MapPin,
  Bot,
  Plus,
  Search,
  Sparkles,
  Target,
  Upload,
  Users,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { AppUser, Company } from './appTypes';
import CompanyCreateModal, { CompanyFormData, emptyCompanyForm } from './CompanyCreateModal';
import CompanyDetail from './CompanyDetail';
import CommissionsTab from './CommissionsTab';
import ContactsTab from './ContactsTab';
import FollowUpsTab from './FollowUpsTab';
import ResearchTab from './ResearchTab';
import SettingsTab from './SettingsTab';
import TrackingTab from './TrackingTab';
import UsersTab from './UsersTab';
import { companyTypeOptions, industryOptions, internalUsers as defaultInternalUsers, leadStatusOptions } from './companyData';
import { formatCompactEur, getDateOnly, isPastDate } from './formatters';

interface FollowUp {
  follow_up_date: string;
  follow_up_done: number;
}

export default function AppRoot() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [initialTab, setInitialTab] = useState('overview');
  const [qualifyingId, setQualifyingId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [savingCompany, setSavingCompany] = useState(false);
  const [companyForm, setCompanyForm] = useState<CompanyFormData>(emptyCompanyForm);
  const [searchQuery, setSearchQuery] = useState('');
  const [minScore, setMinScore] = useState('');
  const [maxScore, setMaxScore] = useState('');
  const [assignedFilter, setAssignedFilter] = useState('');
  const [industryFilter, setIndustryFilter] = useState('');
  const [companyTypeFilter, setCompanyTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadCompanies = async () => {
    const response = await fetch('/api/companies');
    if (!response.ok) {
      throw new Error('Failed to load companies');
    }

    setCompanies(await response.json());
  };

  const loadUsers = async () => {
    const response = await fetch('/api/users');
    if (!response.ok) {
      throw new Error('Failed to load users');
    }

    setUsers(await response.json());
  };

  const loadFollowUps = async () => {
    const response = await fetch('/api/activities/follow-ups');
    if (!response.ok) {
      throw new Error('Failed to load follow-ups');
    }

    setFollowUps(await response.json());
  };

  useEffect(() => {
    const loadAppData = async () => {
      try {
        await Promise.all([loadCompanies(), loadFollowUps(), loadUsers()]);
      } catch (error) {
        console.error('Failed to load app data:', error);
      } finally {
        setLoading(false);
      }
    };

    void loadAppData();
  }, []);

  const totalRevenue = companies.reduce((sum, company) => sum + (company.revenue_eur || 0), 0);
  const activeUsers = users.filter((user) => user.is_active).map((user) => user.full_name);
  const userOptions = activeUsers.length > 0 ? activeUsers : [...defaultInternalUsers];
  const qualifiedCount = companies.filter((company) => ['QUALIFIED', 'APPROVED'].includes(company.lead_status)).length;
  const today = getDateOnly(new Date().toISOString());
  const overdueFollowUpsCount = followUps.filter(
    (followUp) => !followUp.follow_up_done && getDateOnly(followUp.follow_up_date) < today,
  ).length;
  const trackingDueCount = companies.filter(
    (company) => company.next_tracking_date && getDateOnly(company.next_tracking_date) <= today,
  ).length;

  const filteredCompanies = companies.filter((company) => {
    if (minScore && company.lead_score !== null && company.lead_score < parseInt(minScore, 10)) {
      return false;
    }

    if (maxScore && company.lead_score !== null && company.lead_score > parseInt(maxScore, 10)) {
      return false;
    }

    if (assignedFilter && company.assigned_to !== assignedFilter) {
      return false;
    }

    if (industryFilter && company.industry !== industryFilter) {
      return false;
    }

    if (companyTypeFilter && company.company_type !== companyTypeFilter) {
      return false;
    }

    if (statusFilter && company.lead_status !== statusFilter) {
      return false;
    }

    if (!searchQuery.trim()) {
      return true;
    }

    const haystack = [
      company.company_name,
      company.country,
      company.city,
      company.industry,
      company.company_type,
      company.assigned_to,
      company.tracking_level,
      company.tracking_status,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(searchQuery.trim().toLowerCase());
  });

  const openCompany = (id: number, tab = 'overview') => {
    setInitialTab(tab);
    setSelectedCompanyId(id);
    setActiveTab('companies');
  };

  const handleDataChanged = async () => {
    await Promise.all([loadCompanies(), loadFollowUps()]);
  };

  const handleAIQualify = async (id: number) => {
    setQualifyingId(id);

    try {
      const response = await fetch(`/api/companies/${id}/ai-qualify`, { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'AI qualification failed');
      }

      const updatedCompany = payload;
      setCompanies((currentCompanies) =>
        currentCompanies.map((company) => (company.id === id ? { ...company, ...updatedCompany } : company)),
      );
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : 'AI qualification failed.');
    } finally {
      setQualifyingId(null);
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setImporting(true);
    const reader = new FileReader();

    reader.onload = async (loadEvent) => {
      try {
        const workbook = XLSX.read(loadEvent.target?.result, { type: 'binary' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const importedRows = XLSX.utils.sheet_to_json(sheet);

        const response = await fetch('/api/companies/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companies: importedRows }),
        });

        if (!response.ok) {
          throw new Error('Import failed');
        }

        await loadCompanies();
        setActiveTab('companies');
        alert('Import successful.');
      } catch (error) {
        console.error(error);
        alert('Failed to import file.');
      } finally {
        setImporting(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    };

    reader.readAsBinaryString(file);
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
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to create company');
      }

      await loadCompanies();
      setShowCompanyForm(false);
      setCompanyForm(emptyCompanyForm);
      openCompany(payload.id);
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : 'Failed to create company.');
    } finally {
      setSavingCompany(false);
    }
  };

  const renderDashboard = () => (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Pipeline Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-slate-500">Total Companies</h3>
            <Building2 className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-3xl font-bold text-slate-900">{companies.length}</div>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-slate-500">Qualified Leads</h3>
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          </div>
          <div className="text-3xl font-bold text-slate-900">{qualifiedCount}</div>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-slate-500">Pipeline Value</h3>
            <Euro className="w-4 h-4 text-blue-500" />
          </div>
          <div className="text-3xl font-bold text-slate-900">{formatCompactEur(totalRevenue)}</div>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-slate-500">Overdue Follow-ups</h3>
            <AlertCircle className="w-4 h-4 text-red-500" />
          </div>
          <div className="text-3xl font-bold text-slate-900">{overdueFollowUpsCount}</div>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-slate-500">Tracking Due</h3>
            <Target className="w-4 h-4 text-orange-500" />
          </div>
          <div className="text-3xl font-bold text-slate-900">{trackingDueCount}</div>
        </div>
      </div>
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-5 h-5 text-slate-400" />
          <h2 className="text-lg font-semibold text-slate-900">Recent Activity</h2>
        </div>
        <div className="text-slate-500 text-sm text-center py-8">No recent activities to display.</div>
      </div>
    </div>
  );

  const renderCompanies = () => (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Companies</h1>
          <p className="text-sm text-slate-500 mt-1">{filteredCompanies.length} companies match the current view</p>
        </div>
        <div className="flex items-center gap-4">
          <select
            value={assignedFilter}
            onChange={(event) => setAssignedFilter(event.target.value)}
            className="bg-white border border-slate-300 text-slate-700 px-3 py-1.5 rounded-md text-sm font-medium outline-none"
          >
            <option value="">All Users</option>
            {userOptions.map((user) => (
              <option key={user} value={user}>
                {user}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2 bg-white border border-slate-300 px-3 py-1.5 rounded-md text-sm">
            <span className="text-slate-500 font-medium">Score:</span>
            <input
              type="number"
              placeholder="Min"
              value={minScore}
              onChange={(event) => setMinScore(event.target.value)}
              className="w-14 outline-none bg-transparent placeholder:text-slate-300"
            />
            <span className="text-slate-300">-</span>
            <input
              type="number"
              placeholder="Max"
              value={maxScore}
              onChange={(event) => setMaxScore(event.target.value)}
              className="w-14 outline-none bg-transparent placeholder:text-slate-300"
            />
          </div>
          <button
            onClick={() => setShowFilters((currentValue) => !currentValue)}
            className={`flex items-center gap-2 border px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              showFilters ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-white border-slate-300 hover:bg-slate-50 text-slate-700'
            }`}
          >
            <Filter className="w-4 h-4" />
            Filters
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm p-4 grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Industry</label>
            <select
              value={industryFilter}
              onChange={(event) => setIndustryFilter(event.target.value)}
              className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none"
            >
              <option value="">All Industries</option>
              {industryOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Company Type</label>
            <select
              value={companyTypeFilter}
              onChange={(event) => setCompanyTypeFilter(event.target.value)}
              className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none"
            >
              <option value="">All Types</option>
              {companyTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Lead Status</label>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none"
            >
              <option value="">All Statuses</option>
              {leadStatusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
            <tr>
              <th className="px-6 py-3 font-medium">Company Name</th>
              <th className="px-6 py-3 font-medium">Location</th>
              <th className="px-6 py-3 font-medium text-center">Contacts</th>
              <th className="px-6 py-3 font-medium">Score</th>
              <th className="px-6 py-3 font-medium">Tech Fit</th>
              <th className="px-6 py-3 font-medium">Status</th>
              <th className="px-6 py-3 font-medium">Tracking</th>
              <th className="px-6 py-3 font-medium">Assigned To</th>
              <th className="px-6 py-3 font-medium">Follow Up</th>
              <th className="px-6 py-3 font-medium">Next Track</th>
              <th className="px-6 py-3 font-medium text-right">Revenue</th>
              <th className="px-6 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {loading ? (
              <tr>
                <td colSpan={12} className="px-6 py-8 text-center text-slate-500">
                  Loading companies...
                </td>
              </tr>
            ) : filteredCompanies.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-6 py-8 text-center text-slate-500">
                  No companies matched the current filters.
                </td>
              </tr>
            ) : (
              filteredCompanies.map((company) => (
                <tr key={company.id} onClick={() => openCompany(company.id)} className="hover:bg-slate-50 cursor-pointer transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-medium text-slate-900">{company.company_name}</div>
                    <div className="text-slate-500 text-xs mt-0.5">{company.company_type}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-1.5 text-slate-700">
                      <MapPin className="w-3.5 h-3.5 text-slate-400" />
                      {company.city ? `${company.city}, ` : ''}
                      {company.country}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-center">
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        openCompany(company.id, 'contacts');
                      }}
                      className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition-colors"
                    >
                      {company.contact_count || 0}
                    </button>
                  </td>
                  <td className="px-6 py-4">{company.lead_score ?? '-'}</td>
                  <td className="px-6 py-4">
                    {company.technical_fit ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
                        {company.technical_fit.replace('_', ' ')}
                      </span>
                    ) : (
                      <span className="text-slate-400 text-xs">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4">{company.lead_status}</td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-50 text-orange-700 border border-orange-200">
                        {company.tracking_level || 'WATCHLIST'}
                      </span>
                      <span className="text-xs text-slate-500">{company.tracking_status || 'PENDING'}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-slate-700 text-sm">{company.assigned_to || 'Unassigned'}</td>
                  <td className="px-6 py-4">
                    {company.follow_up_date ? (
                      <span className={`text-xs font-medium ${isPastDate(company.follow_up_date) ? 'text-red-600' : 'text-slate-600'}`}>
                        {new Date(company.follow_up_date).toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="text-slate-400 text-xs">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {company.next_tracking_date ? (
                      <span className={`text-xs font-medium ${isPastDate(company.next_tracking_date) ? 'text-red-600' : 'text-slate-600'}`}>
                        {new Date(company.next_tracking_date).toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="text-slate-400 text-xs">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right text-slate-700">{formatCompactEur(company.revenue_eur)}</td>
                  <td className="px-6 py-4 text-right">
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleAIQualify(company.id);
                      }}
                      disabled={qualifyingId === company.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {qualifyingId === company.id ? 'Qualifying...' : 'AI Qualify'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const navigationItems: Array<{ icon: LucideIcon; key: string; label: string }> = [
    { key: 'dashboard', label: 'Dashboard', icon: Activity },
    { key: 'companies', label: 'Companies', icon: Building2 },
    { key: 'contacts', label: 'Contacts', icon: Users },
    { key: 'commissions', label: 'Commissions', icon: Euro },
    { key: 'research', label: 'Lead Research', icon: Search },
    { key: 'followups', label: 'Follow-ups', icon: CalendarClock },
    { key: 'tracking', label: 'Company Tracking', icon: Target },
    { key: 'import', label: 'Import Leads', icon: Upload },
    { key: 'users', label: 'Users', icon: Users },
    { key: 'settings', label: 'Settings', icon: Bot },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex">
      <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col border-r border-slate-800 shrink-0">
        <div className="p-4 border-b border-slate-800">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 rounded bg-blue-600 flex items-center justify-center text-white">
              <Flame className="w-5 h-5" />
            </div>
            <div className="font-bold text-white tracking-tight text-xl">SinterIQ</div>
          </div>
          <div className="text-xs text-slate-400 font-medium ml-11">Precision Lead Intelligence</div>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navigationItems.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => {
                setActiveTab(key);
                setSelectedCompanyId(null);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${
                activeTab === key ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Icon className={`w-5 h-5 ${activeTab === key ? 'text-blue-400' : ''}`} />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 shrink-0">
          <div className="relative w-96">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search companies, countries, assignees..."
              className="w-full pl-9 pr-4 py-2 bg-slate-100 border-transparent rounded-md text-sm focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none transition-all"
            />
          </div>
          <button
            onClick={() => setShowCompanyForm(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Company
          </button>
        </header>

        <div className="flex-1 overflow-auto p-6">
          {selectedCompanyId ? (
            <CompanyDetail
              companyId={selectedCompanyId}
              onBack={() => {
                setSelectedCompanyId(null);
                setInitialTab('overview');
              }}
              initialTab={initialTab}
              onDataChanged={handleDataChanged}
              users={userOptions}
            />
          ) : activeTab === 'contacts' ? (
            <ContactsTab />
          ) : activeTab === 'commissions' ? (
            <CommissionsTab />
          ) : activeTab === 'research' ? (
            <ResearchTab users={userOptions} />
          ) : activeTab === 'followups' ? (
            <FollowUpsTab onCompanyClick={(id) => openCompany(id, 'activities')} onChange={setFollowUps} />
          ) : activeTab === 'tracking' ? (
            <TrackingTab companies={companies} onCompanyClick={(id) => openCompany(id)} />
          ) : activeTab === 'dashboard' ? (
            renderDashboard()
          ) : activeTab === 'users' ? (
            <UsersTab users={users} onUsersChanged={loadUsers} />
          ) : activeTab === 'settings' ? (
            <SettingsTab />
          ) : activeTab === 'import' ? (
            <div className="space-y-6 max-w-2xl mx-auto mt-10">
              <div className="text-center">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Import Leads from D&B Hoovers</h1>
                <p className="text-slate-500 mt-2">Upload your Excel or CSV file containing company and contact data.</p>
              </div>
              <div className="bg-white border-2 border-dashed border-slate-300 rounded-xl p-10 text-center hover:bg-slate-50 transition-colors">
                <Upload className="w-10 h-10 text-slate-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-slate-900 mb-1">Upload a file</h3>
                <p className="text-sm text-slate-500 mb-6">XLSX or CSV format up to 10MB</p>
                <input type="file" accept=".xlsx, .xls, .csv" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-md font-medium transition-colors disabled:opacity-50"
                >
                  {importing ? 'Importing...' : 'Select File'}
                </button>
              </div>
            </div>
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

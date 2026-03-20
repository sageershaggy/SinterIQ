/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Building2, Users, MapPin, Activity, Euro, Search, Filter, Plus, CheckCircle2, AlertCircle, Clock, Sparkles, Upload, Flame, CalendarClock } from 'lucide-react';
import * as XLSX from 'xlsx';
import CompanyDetail from './CompanyDetail';
import ContactsTab from './ContactsTab';
import CommissionsTab from './CommissionsTab';
import ResearchTab from './ResearchTab';
import FollowUpsTab from './FollowUpsTab';
import CompanyCreateModal, { CompanyFormData, emptyCompanyForm } from './CompanyCreateModal';
import { internalUsers } from './companyData';
import { formatCompactEur, getDateOnly, isPastDate } from './formatters';

interface Company {
  id: number;
  company_name: string;
  country: string;
  city: string;
  industry: string;
  company_type: string;
  employee_count: number;
  revenue_eur: number;
  lead_status: string;
  technical_fit: string;
  lead_score: number;
  assigned_to: string;
  contact_count?: number;
  follow_up_date?: string | null;
}

interface FollowUp {
  follow_up_date: string;
  follow_up_done: number;
}

export default function App() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [qualifyingId, setQualifyingId] = useState<number | null>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [initialTab, setInitialTab] = useState<string>('overview');
  const [importing, setImporting] = useState(false);
  const [savingCompany, setSavingCompany] = useState(false);
  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [companyForm, setCompanyForm] = useState<CompanyFormData>(emptyCompanyForm);
  const [searchQuery, setSearchQuery] = useState('');
  const [minScore, setMinScore] = useState<string>('');
  const [maxScore, setMaxScore] = useState<string>('');
  const [assignedFilter, setAssignedFilter] = useState<string>('');
  const [industryFilter, setIndustryFilter] = useState<string>('');
  const [companyTypeFilter, setCompanyTypeFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showFilters, setShowFilters] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const legacyInternalUsers = [
    'Dr. Jochen Langguth',
    'Dr. Jürgen Schellenberger',
    'Ahmad Khan',
    'Sageer A. Shaikh',
    'Christoph Langguth',
    'Patton Lucas',
    'Dr. Kathrin Langguth'
  ];

  useEffect(() => {
    const loadAppData = async () => {
      try {
        const [companiesRes, followUpsRes] = await Promise.all([
          fetch('/api/companies'),
          fetch('/api/activities/follow-ups'),
        ]);

        if (!companiesRes.ok || !followUpsRes.ok) {
          throw new Error('Failed to load app data');
        }

        const [companiesData, followUpsData] = await Promise.all([
          companiesRes.json(),
          followUpsRes.json(),
        ]);

        setCompanies(companiesData);
        setFollowUps(followUpsData);
      } catch (err) {
        console.error('Failed to fetch app data:', err);
      } finally {
        setLoading(false);
      }
    };

    void loadAppData();
  }, []);

  const qualifiedCount = companies.filter(c => c.lead_status === 'QUALIFIED' || c.lead_status === 'APPROVED').length;
  const totalRevenue = companies.reduce((sum, c) => sum + (c.revenue_eur || 0), 0);
  const today = getDateOnly(new Date().toISOString());
  const overdueFollowUpCount = followUps.filter(f => !f.follow_up_done && getDateOnly(f.follow_up_date) < today).length;

  const filteredCompanies = companies.filter(c => {
    if (minScore && c.lead_score !== null && c.lead_score < parseInt(minScore, 10)) return false;
    if (maxScore && c.lead_score !== null && c.lead_score > parseInt(maxScore, 10)) return false;
    if (assignedFilter && c.assigned_to !== assignedFilter) return false;
    if (industryFilter && c.industry !== industryFilter) return false;
    if (companyTypeFilter && c.company_type !== companyTypeFilter) return false;
    if (statusFilter && c.lead_status !== statusFilter) return false;
    if (searchQuery) {
      const normalizedQuery = searchQuery.trim().toLowerCase();
      const searchTarget = [c.company_name, c.country, c.city, c.industry, c.company_type, c.assigned_to]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (!searchTarget.includes(normalizedQuery)) return false;
    }
    return true;
  });

  const refreshCompanies = async () => {
    const res = await fetch('/api/companies');
    if (!res.ok) throw new Error('Failed to refresh companies');
    setCompanies(await res.json());
  };

  const handleAIQualify = async (id: number) => {
    setQualifyingId(id);
    try {
      const res = await fetch(`/api/companies/${id}/ai-qualify`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to qualify');
      const updatedCompany = await res.json();
      setCompanies(prev => prev.map(c => c.id === id ? updatedCompany : c));
    } catch (err) {
      console.error(err);
      alert('AI Qualification failed. Please try again.');
    } finally {
      setQualifyingId(null);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws);

        const res = await fetch('/api/companies/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companies: data })
        });

        if (!res.ok) throw new Error('Import failed');
        
        await refreshCompanies();
        alert('Import successful!');
        setActiveTab('companies');
      } catch (err) {
        console.error(err);
        alert('Failed to import file.');
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleCreateCompany = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingCompany(true);

    try {
      const res = await fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...companyForm,
          employee_count: companyForm.employee_count ? parseInt(companyForm.employee_count, 10) : null,
          revenue_eur: companyForm.revenue_eur ? parseFloat(companyForm.revenue_eur) : null,
        }),
      });

      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error || 'Failed to create company');
      }

      await refreshCompanies();
      setShowCompanyForm(false);
      setCompanyForm(emptyCompanyForm);
      setActiveTab('companies');
      setInitialTab('overview');
      setSelectedCompanyId(payload.id);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Failed to create company.');
    } finally {
      setSavingCompany(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex">
      {/* Sidebar */}
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
          <button 
            onClick={() => { setActiveTab('dashboard'); setSelectedCompanyId(null); }}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${activeTab === 'dashboard' ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}
          >
            <Activity className={`w-5 h-5 ${activeTab === 'dashboard' ? 'text-blue-400' : ''}`} />
            Dashboard
          </button>
          <button 
            onClick={() => { setActiveTab('companies'); setSelectedCompanyId(null); }}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${activeTab === 'companies' ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}
          >
            <Building2 className={`w-5 h-5 ${activeTab === 'companies' ? 'text-blue-400' : ''}`} />
            Companies
          </button>
          <button 
            onClick={() => { setActiveTab('contacts'); setSelectedCompanyId(null); }}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${activeTab === 'contacts' ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}
          >
            <Users className={`w-5 h-5 ${activeTab === 'contacts' ? 'text-blue-400' : ''}`} />
            Contacts
          </button>
          <button 
            onClick={() => { setActiveTab('commissions'); setSelectedCompanyId(null); }}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${activeTab === 'commissions' ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}
          >
            <Euro className={`w-5 h-5 ${activeTab === 'commissions' ? 'text-blue-400' : ''}`} />
            Commissions
          </button>
          <button 
            onClick={() => { setActiveTab('research'); setSelectedCompanyId(null); }}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${activeTab === 'research' ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}
          >
            <Search className={`w-5 h-5 ${activeTab === 'research' ? 'text-blue-400' : ''}`} />
            Lead Research
          </button>
          <button 
            onClick={() => { setActiveTab('followups'); setSelectedCompanyId(null); }}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${activeTab === 'followups' ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}
          >
            <CalendarClock className={`w-5 h-5 ${activeTab === 'followups' ? 'text-blue-400' : ''}`} />
            Follow-ups
          </button>
          <button 
            onClick={() => { setActiveTab('import'); setSelectedCompanyId(null); }}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${activeTab === 'import' ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}
          >
            <Upload className={`w-5 h-5 ${activeTab === 'import' ? 'text-blue-400' : ''}`} />
            Import Leads
          </button>
        </nav>
        <div className="p-4 border-t border-slate-800 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-xs text-white">SS</div>
            <span>Sageer A. Shaikh</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 shrink-0">
          <div className="flex items-center gap-4 flex-1">
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
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowCompanyForm(true)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Company
            </button>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-auto p-6">
          {selectedCompanyId ? (
            <CompanyDetail 
              companyId={selectedCompanyId} 
              onBack={() => setSelectedCompanyId(null)} 
              initialTab={initialTab}
              users={[...internalUsers]}
            />
          ) : activeTab === 'contacts' ? (
            <ContactsTab />
          ) : activeTab === 'commissions' ? (
            <CommissionsTab />
          ) : activeTab === 'research' ? (
            <ResearchTab users={[...internalUsers]} />
          ) : activeTab === 'followups' ? (
            <FollowUpsTab
              onCompanyClick={(id) => {
                setInitialTab('activities');
                setSelectedCompanyId(id);
                setActiveTab('companies');
              }}
            />
          ) : activeTab === 'dashboard' ? (
            <div className="space-y-6">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Pipeline Dashboard</h1>
              
              {/* KPI Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
                  <div className="text-3xl font-bold text-slate-900">€{(totalRevenue / 1000000).toFixed(1)}M</div>
                </div>
                <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-medium text-slate-500">Overdue Follow-ups</h3>
                    <AlertCircle className="w-4 h-4 text-red-500" />
                  </div>
                  <div className="text-3xl font-bold text-slate-900">{overdueFollowUpCount}</div>
                </div>
              </div>

              {/* Recent Activity placeholder */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Clock className="w-5 h-5 text-slate-400" />
                  <h2 className="text-lg font-semibold text-slate-900">Recent Activity</h2>
                </div>
                <div className="text-slate-500 text-sm text-center py-8">
                  No recent activities to display.
                </div>
              </div>
            </div>
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
                
                <input 
                  type="file" 
                  accept=".xlsx, .xls, .csv" 
                  className="hidden" 
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                />
                
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-md font-medium transition-colors disabled:opacity-50"
                >
                  {importing ? 'Importing...' : 'Select File'}
                </button>
              </div>

              <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-sm text-blue-800">
                <h4 className="font-semibold mb-2">Expected Columns:</h4>
                <p>Country, Company Name, Address, Website, Type of Activity, Industry, Phone (Main), Revenue, Employee Count, Corporate Family, Contact Name, Contact Job Title, Contact Email, Contact, Phone, LinkedIn, Notes</p>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Companies</h1>
                <div className="flex items-center gap-4">
                  <select 
                    value={assignedFilter} 
                    onChange={(e) => setAssignedFilter(e.target.value)}
                    className="bg-white border border-slate-300 text-slate-700 px-3 py-1.5 rounded-md text-sm font-medium outline-none"
                  >
                    <option value="">All Users</option>
                    {internalUsers.map(user => (
                      <option key={user} value={user}>{user}</option>
                    ))}
                  </select>
                  <div className="flex items-center gap-2 bg-white border border-slate-300 px-3 py-1.5 rounded-md text-sm">
                    <span className="text-slate-500 font-medium">Score:</span>
                    <input 
                      type="number" 
                      placeholder="Min" 
                      value={minScore}
                      onChange={(e) => setMinScore(e.target.value)}
                      className="w-14 outline-none bg-transparent placeholder:text-slate-300"
                    />
                    <span className="text-slate-300">-</span>
                    <input 
                      type="number" 
                      placeholder="Max" 
                      value={maxScore}
                      onChange={(e) => setMaxScore(e.target.value)}
                      className="w-14 outline-none bg-transparent placeholder:text-slate-300"
                    />
                  </div>
                  <button 
                    onClick={() => setShowFilters(!showFilters)}
                    className={`flex items-center gap-2 border px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${showFilters ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-white border-slate-300 hover:bg-slate-50 text-slate-700'}`}
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
                      onChange={(e) => setIndustryFilter(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none"
                    >
                      <option value="">All Industries</option>
                      <option value="BEARING_TRADER">Bearing Traders / Distributors</option>
                      <option value="OIL_GAS">Oil & Gas / Petrochemicals</option>
                      <option value="FOOD_BEV">Food & Beverage Manufacturing</option>
                      <option value="PHARMA">Pharmaceutical / Cleanroom</option>
                      <option value="CHEMICAL">Chemical Processing & Pumps</option>
                      <option value="DESAL_WATER">Desalination / Water Treatment</option>
                      <option value="CEMENT">Cement & Construction Materials</option>
                      <option value="POWER_GEN">Power Generation / Energy</option>
                      <option value="MINING">Mining & Minerals</option>
                      <option value="AUTOMOTIVE">Automotive Manufacturing</option>
                      <option value="TEXTILE">Textile Machinery</option>
                      <option value="VACUUM">Vacuum Technology</option>
                      <option value="CRYO">Cryogenic Applications</option>
                      <option value="UNIVERSITY">Universities & Scientific Institutes</option>
                      <option value="ROBOTICS">Robotics & Automation</option>
                      <option value="ELECTROPLATING">Electroplating / Surface Treatment</option>
                      <option value="INDUSTRIAL_DIST">Industrial Component Distributors</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Company Type</label>
                    <select 
                      value={companyTypeFilter} 
                      onChange={(e) => setCompanyTypeFilter(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none"
                    >
                      <option value="">All Types</option>
                      <option value="BEARING_TRADER">Bearing Trader</option>
                      <option value="MANUFACTURER">Manufacturer</option>
                      <option value="DISTRIBUTOR">Distributor</option>
                      <option value="UNIVERSITY">University</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Lead Status</label>
                    <select 
                      value={statusFilter} 
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 rounded-md text-sm outline-none"
                    >
                      <option value="">All Statuses</option>
                      <option value="RAW">Raw</option>
                      <option value="ENRICHED">Enriched</option>
                      <option value="QUALIFIED">Qualified</option>
                      <option value="APPROVED">Approved</option>
                      <option value="IN_OUTREACH">In Outreach</option>
                      <option value="CONTACTED">Contacted</option>
                      <option value="OPPORTUNITY">Opportunity</option>
                      <option value="WON">Won</option>
                      <option value="LOST">Lost</option>
                      <option value="DISQUALIFIED">Disqualified</option>
                    </select>
                  </div>
                </div>
              )}

              {/* Table */}
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
                      <th className="px-6 py-3 font-medium">Assigned To</th>
                      <th className="px-6 py-3 font-medium">Follow Up</th>
                      <th className="px-6 py-3 font-medium text-right">Revenue</th>
                      <th className="px-6 py-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {loading ? (
                      <tr>
                        <td colSpan={10} className="px-6 py-8 text-center text-slate-500">Loading companies...</td>
                      </tr>
                    ) : filteredCompanies.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-6 py-8 text-center text-slate-500">No companies found.</td>
                      </tr>
                    ) : (
                      filteredCompanies.map(company => (
                        <tr key={company.id} onClick={() => { setInitialTab('overview'); setSelectedCompanyId(company.id); }} className="hover:bg-slate-50 cursor-pointer transition-colors">
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
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                setInitialTab('contacts');
                                setSelectedCompanyId(company.id); 
                              }}
                              className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition-colors"
                            >
                              {company.contact_count || 0}
                            </button>
                          </td>
                          <td className="px-6 py-4">
                            {company.lead_score !== null ? (
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold bg-slate-100 text-slate-700">
                                  {company.lead_score}
                                </div>
                              </div>
                            ) : (
                              <span className="text-slate-400 text-xs">-</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            {company.technical_fit ? (
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                company.technical_fit === 'HIGH' ? 'bg-green-100 text-green-700' :
                                company.technical_fit === 'MEDIUM' ? 'bg-yellow-100 text-yellow-700' :
                                company.technical_fit === 'LOW' ? 'bg-orange-100 text-orange-700' :
                                'bg-red-100 text-red-700'
                              }`}>
                                {company.technical_fit}
                              </span>
                            ) : (
                              <span className="text-slate-400 text-xs">-</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                              company.lead_status === 'APPROVED' ? 'bg-green-100 text-green-700' :
                              company.lead_status === 'QUALIFIED' ? 'bg-purple-100 text-purple-700' :
                              company.lead_status === 'DISQUALIFIED' ? 'bg-red-100 text-red-700' :
                              company.lead_status === 'RAW' ? 'bg-slate-100 text-slate-700' :
                              'bg-blue-100 text-blue-700'
                            }`}>
                              {company.lead_status}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-slate-700 text-sm">
                            {company.assigned_to || <span className="text-slate-400 italic">Unassigned</span>}
                          </td>
                          <td className="px-6 py-4">
                            {company.follow_up_date ? (
                              <span className={`text-xs font-medium ${new Date(company.follow_up_date) < new Date() ? 'text-red-600' : 'text-slate-600'}`}>
                                {new Date(company.follow_up_date).toLocaleDateString()}
                              </span>
                            ) : (
                              <span className="text-slate-400 text-xs">-</span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-right text-slate-700">
                            {company.revenue_eur ? `€${(company.revenue_eur / 1000000).toFixed(1)}M` : '-'}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button 
                                onClick={(e) => { e.stopPropagation(); handleAIQualify(company.id); }}
                                disabled={qualifyingId === company.id}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
                              >
                                <Sparkles className="w-3.5 h-3.5" />
                                {qualifyingId === company.id ? 'Qualifying...' : 'AI Qualify'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

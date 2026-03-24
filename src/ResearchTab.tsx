import React, { useEffect, useState } from 'react';
import { Search, Users, Building2, Globe, Sparkles, Plus, CheckCircle2, Clock, ArrowRight, Link2, History } from 'lucide-react';
import { companyTypeOptions, industryOptions, technicalFitOptions } from './companyData';

interface HistoryEntry {
  id: number;
  company_name: string;
  website: string;
  contacts_found: number;
  saved_to_company_id: number | null;
  saved_to_company_name: string | null;
  created_at: string;
}

export default function ResearchTab({ users, onCompanyClick }: { users: string[]; onCompanyClick?: (id: number) => void }) {
  const [companyName, setCompanyName] = useState('');
  const [website, setWebsite] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [assignedTo, setAssignedTo] = useState('Sageer A. Shaikh');
  const [industry, setIndustry] = useState('BEARING_TRADER');
  const [companyType, setCompanyType] = useState('BEARING_TRADER');
  const [technicalFit, setTechnicalFit] = useState('');
  const [qualificationNotes, setQualificationNotes] = useState('');

  // History
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [currentHistoryId, setCurrentHistoryId] = useState<number | null>(null);

  // Link to existing company
  const [companies, setCompanies] = useState<any[]>([]);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    void loadHistory();
    void loadCompanies();
  }, []);

  const loadHistory = async () => {
    try {
      const res = await fetch('/api/research/history');
      if (res.ok) setHistory(await res.json());
    } catch (err) { console.error(err); }
    finally { setLoadingHistory(false); }
  };

  const loadCompanies = async () => {
    try {
      const res = await fetch('/api/companies');
      if (res.ok) setCompanies(await res.json());
    } catch (err) { console.error(err); }
  };

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!companyName || !website) return;
    setLoading(true);
    setError('');
    setSearched(true);
    setSaved(false);
    setSaveMessage('');
    setResults([]);
    setCurrentHistoryId(null);
    try {
      const response = await fetch('/api/research/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName, website }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || 'Failed to fetch research data');
      setResults(Array.isArray(payload) ? payload : []);
      void loadHistory(); // refresh history
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : 'An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const loadHistoryEntry = async (entry: HistoryEntry) => {
    try {
      const res = await fetch(`/api/research/history/${entry.id}`);
      if (!res.ok) return;
      const data = await res.json();
      setCompanyName(entry.company_name);
      setWebsite(entry.website || '');
      setResults(data.results || []);
      setSearched(true);
      setSaved(!!entry.saved_to_company_id);
      setSaveMessage(entry.saved_to_company_id ? `Saved to ${entry.saved_to_company_name}` : '');
      setCurrentHistoryId(entry.id);
      setError('');
    } catch (err) {
      console.error(err);
    }
  };

  const handleSave = async () => {
    if (results.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/research/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName, website, contacts: results, assignedTo, industry, companyType, technicalFit, qualificationNotes }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || 'Failed to save');
      setSaved(true);
      setSaveMessage(`Merged with company #${payload.companyId} via ${payload.matchedBy}. Added ${payload.insertedContacts} contacts.`);
      void loadHistory();
      void loadCompanies();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleLinkToCompany = async () => {
    if (!selectedCompanyId || results.length === 0) return;
    setLinking(true);
    setError('');
    try {
      const response = await fetch('/api/research/add-to-company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: Number(selectedCompanyId), contacts: results, historyId: currentHistoryId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || 'Failed to link');
      setSaved(true);
      setSaveMessage(`Added ${payload.added} contacts to ${payload.companyName}.`);
      setShowLinkModal(false);
      void loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link contacts.');
    } finally {
      setLinking(false);
    }
  };

  return (
    <div className="flex gap-6">
      {/* Main content */}
      <div className="flex-1 space-y-6 min-w-0">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Lead Research</h1>
          <div className="bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-full text-sm font-medium flex items-center gap-2">
            <Sparkles className="w-4 h-4" /> AI-Powered Extraction
          </div>
        </div>

        {/* Search form */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-2">Find Key Contacts</h2>
          <p className="text-sm text-slate-500 mb-5">Enter a company name and website. SinterIQ will search the web to identify key decision-makers.</p>

          <form onSubmit={handleSearch} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company Name</label>
                <div className="relative">
                  <Building2 className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input type="text" required value={companyName} onChange={e => setCompanyName(e.target.value)}
                    placeholder="e.g., Siemens AG"
                    className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Website</label>
                <div className="relative">
                  <Globe className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input type="text" required value={website} onChange={e => setWebsite(e.target.value)}
                    placeholder="e.g., siemens.com"
                    className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                </div>
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button type="submit" disabled={loading || !companyName || !website}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50">
                {loading ? (
                  <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Searching...</>
                ) : (
                  <><Search className="w-4 h-4" /> Search Contacts</>
                )}
              </button>
            </div>
          </form>
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
        {saveMessage && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> {saveMessage}</div>}

        {/* Results */}
        {searched && !loading && !error && (
          <div className="space-y-6">
            {/* Qualification form */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
              <h3 className="text-base font-semibold text-slate-900 mb-3">Qualification Criteria</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Industry</label>
                  <select value={industry} onChange={e => setIndustry(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white">
                    {industryOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Company Type</label>
                  <select value={companyType} onChange={e => setCompanyType(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white">
                    {companyTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Technical Fit</label>
                  <select value={technicalFit} onChange={e => setTechnicalFit(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white">
                    {technicalFitOptions.map(o => <option key={o.value || 'blank'} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
                  <input type="text" value={qualificationNotes} onChange={e => setQualificationNotes(e.target.value)}
                    placeholder="Why is this a target?" className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm" />
                </div>
              </div>
            </div>

            {/* Contacts table */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between flex-wrap gap-2">
                <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                  <Users className="w-5 h-5 text-slate-500" /> Found Contacts ({results.length})
                </h3>
                {results.length > 0 && !saved && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)}
                      className="border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white">
                      <option value="">Assign To...</option>
                      {users.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <button onClick={handleSave} disabled={saving}
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
                      {saving ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving...</>
                        : <><Plus className="w-3.5 h-3.5" /> Save as New Lead</>}
                    </button>
                    <button onClick={() => setShowLinkModal(true)}
                      className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5">
                      <Link2 className="w-3.5 h-3.5" /> Add to Existing Company
                    </button>
                  </div>
                )}
                {saved && (
                  <span className="flex items-center gap-1.5 text-sm text-green-700 bg-green-50 px-3 py-1.5 rounded-md font-medium">
                    <CheckCircle2 className="w-4 h-4" /> Saved
                  </span>
                )}
              </div>

              {/* Link to company modal */}
              {showLinkModal && (
                <div className="p-4 bg-green-50 border-b border-green-200 flex items-center gap-3 flex-wrap">
                  <span className="text-sm font-medium text-green-800">Link contacts to:</span>
                  <select value={selectedCompanyId} onChange={e => setSelectedCompanyId(e.target.value)}
                    className="border border-green-300 rounded-md px-3 py-1.5 text-sm bg-white flex-1 min-w-[200px]">
                    <option value="">Select a company...</option>
                    {companies.map((c: any) => (
                      <option key={c.id} value={c.id}>{c.company_name} — {c.country}</option>
                    ))}
                  </select>
                  <button onClick={handleLinkToCompany} disabled={!selectedCompanyId || linking}
                    className="bg-green-600 hover:bg-green-700 text-white px-4 py-1.5 rounded-md text-sm font-medium disabled:opacity-50 flex items-center gap-1.5">
                    {linking ? 'Linking...' : <><ArrowRight className="w-3.5 h-3.5" /> Add Contacts</>}
                  </button>
                  <button onClick={() => setShowLinkModal(false)} className="text-sm text-slate-500 hover:text-slate-700">Cancel</button>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="px-5 py-3 font-medium">Name</th>
                      <th className="px-5 py-3 font-medium">Job Title</th>
                      <th className="px-5 py-3 font-medium">Email</th>
                      <th className="px-5 py-3 font-medium">Phone</th>
                      <th className="px-5 py-3 font-medium">LinkedIn</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {results.length === 0 ? (
                      <tr><td colSpan={5} className="px-5 py-8 text-center text-slate-500">No contacts found.</td></tr>
                    ) : (
                      results.map((contact, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <td className="px-5 py-3 font-medium text-slate-900">{contact.full_name || '-'}</td>
                          <td className="px-5 py-3 text-slate-600">{contact.job_title || '-'}</td>
                          <td className="px-5 py-3 text-slate-600">{contact.email || '-'}</td>
                          <td className="px-5 py-3 text-slate-600">{contact.phone_direct || '-'}</td>
                          <td className="px-5 py-3">
                            {contact.linkedin_url ? <a href={contact.linkedin_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline text-xs">Profile</a> : '-'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* History sidebar */}
      <div className="w-72 shrink-0">
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm sticky top-4">
          <div className="p-4 border-b border-slate-200">
            <h3 className="font-semibold text-slate-900 flex items-center gap-2 text-sm">
              <History className="w-4 h-4 text-slate-500" /> Research History
            </h3>
          </div>
          <div className="max-h-[600px] overflow-y-auto divide-y divide-slate-100">
            {loadingHistory ? (
              <div className="p-4 text-center text-sm text-slate-400">Loading...</div>
            ) : history.length === 0 ? (
              <div className="p-4 text-center text-sm text-slate-400">No research yet</div>
            ) : (
              history.map(entry => (
                <button
                  key={entry.id}
                  onClick={() => void loadHistoryEntry(entry)}
                  className={`w-full text-left p-3 hover:bg-slate-50 transition-colors ${currentHistoryId === entry.id ? 'bg-blue-50' : ''}`}
                >
                  <div className="font-medium text-sm text-slate-900 truncate">{entry.company_name}</div>
                  <div className="text-xs text-slate-500 truncate">{entry.website}</div>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-xs text-slate-400">{new Date(entry.created_at).toLocaleDateString()}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">{entry.contacts_found} contacts</span>
                      {entry.saved_to_company_id ? (
                        <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Saved</span>
                      ) : (
                        <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">Unsaved</span>
                      )}
                    </div>
                  </div>
                  {entry.saved_to_company_name && (
                    <div className="text-[10px] text-green-600 mt-1 flex items-center gap-1">
                      <Building2 className="w-3 h-3" /> {entry.saved_to_company_name}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

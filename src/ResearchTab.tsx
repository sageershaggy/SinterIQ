import React, { useState } from 'react';
import { Search, Users, Building2, Globe, Sparkles, Plus, CheckCircle2 } from 'lucide-react';
import { companyTypeOptions, industryOptions, technicalFitOptions } from './companyData';

export default function ResearchTab({ users }: { users: string[] }) {
  const [companyName, setCompanyName] = useState('');
  const [website, setWebsite] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [industry, setIndustry] = useState('BEARING_TRADER');
  const [companyType, setCompanyType] = useState('BEARING_TRADER');
  const [technicalFit, setTechnicalFit] = useState('');
  const [qualificationNotes, setQualificationNotes] = useState('');

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!companyName || !website) {
      return;
    }

    setLoading(true);
    setError('');
    setSearched(true);
    setSaved(false);
    setSaveMessage('');
    setResults([]);

    try {
      const response = await fetch('/api/research/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName, website }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to fetch research data');
      }

      setResults(Array.isArray(payload) ? payload : []);
    } catch (searchError) {
      console.error(searchError);
      setError(
        searchError instanceof Error ? searchError.message : 'An error occurred while researching contacts. Please try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (results.length === 0) {
      return;
    }

    setSaving(true);
    setError('');

    try {
      const response = await fetch('/api/research/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName,
          website,
          contacts: results,
          assignedTo,
          industry,
          companyType,
          technicalFit,
          qualificationNotes,
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to save');
      }

      setSaved(true);
      setSaveMessage(
        `Merged with company #${payload.companyId} via ${payload.matchedBy}. Added ${payload.insertedContacts} contacts and updated ${payload.updatedContacts} contacts.`,
      );
    } catch (saveError) {
      console.error(saveError);
      setError(saveError instanceof Error ? saveError.message : 'Failed to save to database.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Lead Research</h1>
        <div className="bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-full text-sm font-medium flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          AI-Powered Extraction
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-3xl">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Find Key Contacts</h2>
        <p className="text-sm text-slate-500 mb-6">
          Enter a company name and website. SinterIQ will search the web to identify key decision-makers and extract
          their contact information.
        </p>

        <form onSubmit={handleSearch} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company Name</label>
              <div className="relative">
                <Building2 className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  required
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder="e.g., Siemens AG"
                  className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Website</label>
              <div className="relative">
                <Globe className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  required
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                  placeholder="e.g., siemens.com"
                  className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={loading || !companyName || !website}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  Extracting...
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  Search Contacts
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {saveMessage && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
          {saveMessage}
        </div>
      )}

      {searched && !loading && !error && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-3xl">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Qualification Criteria</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Industry</label>
                <select
                  value={industry}
                  onChange={(event) => setIndustry(event.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
                >
                  {industryOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company Type</label>
                <select
                  value={companyType}
                  onChange={(event) => setCompanyType(event.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
                >
                  {companyTypeOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Technical Fit</label>
                <select
                  value={technicalFit}
                  onChange={(event) => setTechnicalFit(event.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
                >
                  {technicalFitOptions.map((option) => (
                    <option key={option.value || 'blank'} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Qualification Notes</label>
                <textarea
                  value={qualificationNotes}
                  onChange={(event) => setQualificationNotes(event.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
                  rows={2}
                  placeholder="Why is this company a target?"
                />
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                <Users className="w-5 h-5 text-slate-500" />
                Found Contacts ({results.length})
              </h3>
              {results.length > 0 && (
                <div className="flex items-center gap-3">
                  {!saved && (
                    <select
                      value={assignedTo}
                      onChange={(event) => setAssignedTo(event.target.value)}
                      className="border border-slate-300 rounded-md px-3 py-1.5 text-sm outline-none bg-white"
                    >
                      <option value="">Assign To...</option>
                      {users.map((user) => (
                        <option key={user} value={user}>{user}</option>
                      ))}
                    </select>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={saving || saved}
                    className={`px-4 py-1.5 rounded-md text-sm font-medium flex items-center gap-2 transition-colors ${
                      saved
                        ? 'bg-green-100 text-green-700'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50'
                    }`}
                  >
                    {saved ? (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        Saved to Database
                      </>
                    ) : saving ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        Saving...
                      </>
                    ) : (
                      <>
                        <Plus className="w-4 h-4" />
                        Save as Lead
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="px-6 py-3 font-medium">Name</th>
                    <th className="px-6 py-3 font-medium">Job Title</th>
                    <th className="px-6 py-3 font-medium">Email</th>
                    <th className="px-6 py-3 font-medium">Phone</th>
                    <th className="px-6 py-3 font-medium">LinkedIn</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {results.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-slate-500">No contacts found for this company.</td>
                    </tr>
                  ) : (
                    results.map((contact, index) => (
                      <tr key={index} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 font-medium text-slate-900">{contact.full_name || '-'}</td>
                        <td className="px-6 py-4 text-slate-600">{contact.job_title || '-'}</td>
                        <td className="px-6 py-4 text-slate-600">{contact.email || '-'}</td>
                        <td className="px-6 py-4 text-slate-600">{contact.phone_direct || '-'}</td>
                        <td className="px-6 py-4 text-blue-600">
                          {contact.linkedin_url ? (
                            <a href={contact.linkedin_url} target="_blank" rel="noreferrer" className="hover:underline">Profile</a>
                          ) : '-'}
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
  );
}

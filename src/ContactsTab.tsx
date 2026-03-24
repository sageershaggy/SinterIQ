import React, { useEffect, useState } from 'react';
import { Mail, Phone, Linkedin, Building2, CheckCircle2, Search, Filter, X } from 'lucide-react';

interface ContactsTabProps {
  onCompanyClick?: (id: number) => void;
}

export default function ContactsTab({ onCompanyClick }: ContactsTabProps) {
  const [contacts, setContacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [verifiedFilter, setVerifiedFilter] = useState<'all' | 'verified' | 'unverified'>('all');

  useEffect(() => {
    fetch('/api/contacts')
      .then((res) => res.json())
      .then((data) => {
        setContacts(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  const filtered = contacts.filter((contact) => {
    if (verifiedFilter === 'verified' && !contact.is_verified) return false;
    if (verifiedFilter === 'unverified' && contact.is_verified) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.trim().toLowerCase();
    return (
      contact.full_name?.toLowerCase().includes(q) ||
      contact.job_title?.toLowerCase().includes(q) ||
      contact.company_name?.toLowerCase().includes(q) ||
      contact.email?.toLowerCase().includes(q)
    );
  });

  if (loading) return <div className="p-8 text-center text-slate-500">Loading contacts...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">All Contacts</h1>
          <p className="text-sm text-slate-500 mt-1">{filtered.length} of {contacts.length} contacts</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, title, company, email..."
            className="w-full pl-9 pr-8 py-2 bg-white border border-slate-300 rounded-md text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-md p-1">
          {(['all', 'verified', 'unverified'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setVerifiedFilter(v)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors capitalize ${
                verifiedFilter === v ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Job Title</th>
                <th className="px-6 py-3 font-medium">Company</th>
                <th className="px-6 py-3 font-medium">Contact Info</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-slate-500">
                    {searchQuery || verifiedFilter !== 'all' ? 'No contacts match the current filters.' : 'No contacts found.'}
                  </td>
                </tr>
              ) : (
                filtered.map((contact) => (
                  <tr key={contact.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 font-medium text-slate-900">
                      <div className="flex items-center gap-2">
                        {contact.full_name}
                        {contact.is_verified ? (
                          <div
                            className="flex items-center gap-1 bg-green-50 text-green-700 px-1.5 py-0.5 rounded text-[10px] font-medium border border-green-200"
                            title={`Verified via ${contact.verification_source} on ${contact.verified_date ? new Date(contact.verified_date).toLocaleDateString() : 'Unknown date'}`}
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            Verified
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-slate-600">{contact.job_title || '-'}</td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => contact.company_id && onCompanyClick?.(contact.company_id)}
                        className={`flex items-center gap-1 text-slate-600 ${contact.company_id && onCompanyClick ? 'hover:text-blue-600 cursor-pointer' : ''}`}
                      >
                        <Building2 className="w-4 h-4 text-slate-400 shrink-0" />
                        {contact.company_name || 'Unknown'}
                      </button>
                    </td>
                    <td className="px-6 py-4">
                      <div className="space-y-1">
                        {contact.email && (
                          <div className="flex items-center gap-2 text-slate-600">
                            <Mail className="w-3.5 h-3.5 text-slate-400" />
                            <a href={`mailto:${contact.email}`} className="hover:text-blue-600">{contact.email}</a>
                          </div>
                        )}
                        {contact.phone_direct && (
                          <div className="flex items-center gap-2 text-slate-600">
                            <Phone className="w-3.5 h-3.5 text-slate-400" />
                            {contact.phone_direct}
                          </div>
                        )}
                        {contact.linkedin_url && (
                          <div className="flex items-center gap-2 text-slate-600">
                            <Linkedin className="w-3.5 h-3.5 text-slate-400" />
                            <a href={contact.linkedin_url} target="_blank" rel="noreferrer" className="hover:text-blue-600">
                              LinkedIn Profile
                            </a>
                          </div>
                        )}
                        {!contact.email && !contact.phone_direct && !contact.linkedin_url && (
                          <span className="text-slate-400 italic text-xs">No contact info</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

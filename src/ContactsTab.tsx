import React, { useEffect, useState } from 'react';
import { Mail, Phone, Linkedin, Building2, CheckCircle2 } from 'lucide-react';

export default function ContactsTab() {
  const [contacts, setContacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/contacts')
      .then(res => res.json())
      .then(data => {
        setContacts(data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="p-8 text-center text-slate-500">Loading contacts...</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">All Contacts</h1>
      
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
              {contacts.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-slate-500">No contacts found.</td>
                </tr>
              ) : (
                contacts.map(contact => (
                  <tr key={contact.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 font-medium text-slate-900">
                      <div className="flex items-center gap-2">
                        {contact.full_name}
                        {contact.is_verified ? (
                          <div className="flex items-center gap-1 bg-green-50 text-green-700 px-1.5 py-0.5 rounded text-[10px] font-medium border border-green-200" title={`Verified via ${contact.verification_source} on ${contact.verified_date ? new Date(contact.verified_date).toLocaleDateString() : 'Unknown date'}`}>
                            <CheckCircle2 className="w-3 h-3" />
                            Verified
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-slate-600">{contact.job_title || '-'}</td>
                    <td className="px-6 py-4 text-slate-600">
                      <div className="flex items-center gap-1">
                        <Building2 className="w-4 h-4 text-slate-400" />
                        {contact.company_name || 'Unknown'}
                      </div>
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
                            <a href={contact.linkedin_url} target="_blank" rel="noreferrer" className="hover:text-blue-600">Profile</a>
                          </div>
                        )}
                        {!contact.email && !contact.phone_direct && !contact.linkedin_url && (
                          <span className="text-slate-400 italic">No contact info</span>
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

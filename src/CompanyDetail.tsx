import React, { useEffect, useState } from 'react';
import { ArrowLeft, Building2, Globe, Users, Euro, Phone, Mail, Linkedin, Plus, Calendar, CheckCircle2, MessageSquare, Briefcase, Trash2, Activity, Edit2, Clock, AlertCircle, Edit, Download } from 'lucide-react';

interface Contact {
  id: number;
  full_name: string;
  job_title: string;
  email: string;
  phone_direct: string;
  linkedin_url: string;
  notes: string;
  is_verified?: boolean;
  verification_source?: string;
  verified_date?: string;
}

interface ActivityLog {
  id: number;
  activity_type: string;
  activity_date: string;
  performed_by: string;
  subject: string;
  details: string;
  outcome: string;
  follow_up_date: string;
}

interface Order {
  id: number;
  order_reference: string;
  order_date: string;
  order_value_eur: number;
  product_type: string;
  is_hybrid: number;
  commission_rate: number;
  commission_eur: number;
  payment_received: number;
  payment_date: string;
  commission_paid: number;
  commission_paid_date: string;
  innovista_contribution: string;
  notes: string;
}

interface CompanyDetailProps {
  companyId: number;
  onBack: () => void;
  initialTab?: string;
}

export default function CompanyDetail({ companyId, onBack, initialTab = 'overview' }: CompanyDetailProps) {
  const [company, setCompany] = useState<any>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(initialTab);

  // Contact Form State
  const [showContactForm, setShowContactForm] = useState(false);
  const [editingContactId, setEditingContactId] = useState<number | null>(null);
  const [contactForm, setContactForm] = useState({ full_name: '', job_title: '', email: '', phone_direct: '', linkedin_url: '', notes: '', is_verified: false, verification_source: '' });

  // Activity Form State
  const [showActivityForm, setShowActivityForm] = useState(false);
  const [activityForm, setActivityForm] = useState({ activity_type: 'CALL_MADE', activity_date: new Date().toISOString().split('T')[0], performed_by: 'Sageer A. Shaikh', subject: '', details: '', outcome: 'NEUTRAL', follow_up_date: '' });

  const [showEditCompany, setShowEditCompany] = useState(false);
  const [companyForm, setCompanyForm] = useState<any>({});

  // Order Form State
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [orderForm, setOrderForm] = useState({
    order_reference: '',
    order_date: new Date().toISOString().split('T')[0],
    order_value_eur: 0,
    product_type: 'CERAMIC_BEARING',
    is_hybrid: false,
    payment_received: false,
    innovista_contribution: 'LEAD_GEN'
  });

  const internalUsers = [
    'Dr. Jochen Langguth',
    'Dr. Jürgen Schellenberger',
    'Ahmad Khan',
    'Sageer A. Shaikh',
    'Christoph Langguth',
    'Patton Lucas',
    'Dr. Kathrin Langguth'
  ];

  const fetchData = async () => {
    try {
      const res = await fetch(`/api/companies/${companyId}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setCompany(data);
      setCompanyForm(data);
      setContacts(data.contacts || []);
      setActivities(data.activities || []);
      setOrders(data.orders || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [companyId]);

  const handleAddContact = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingContactId) {
        await fetch(`/api/contacts/${editingContactId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(contactForm)
        });
      } else {
        await fetch('/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...contactForm, company_id: companyId })
        });
      }
      setShowContactForm(false);
      setEditingContactId(null);
      setContactForm({ full_name: '', job_title: '', email: '', phone_direct: '', linkedin_url: '', notes: '', is_verified: false, verification_source: '' });
      fetchData();
    } catch (err) {
      console.error(err);
      alert('Failed to save contact');
    }
  };

  const handleEditContact = (contact: Contact) => {
    setContactForm({
      full_name: contact.full_name || '',
      job_title: contact.job_title || '',
      email: contact.email || '',
      phone_direct: contact.phone_direct || '',
      linkedin_url: contact.linkedin_url || '',
      notes: contact.notes || '',
      is_verified: contact.is_verified || false,
      verification_source: contact.verification_source || ''
    });
    setEditingContactId(contact.id);
    setShowContactForm(true);
  };

  const handleDeleteContact = async (id: number) => {
    if (!confirm('Are you sure you want to delete this contact?')) return;
    try {
      await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddActivity = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetch('/api/activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...activityForm, company_id: companyId })
      });
      setShowActivityForm(false);
      setActivityForm({ activity_type: 'CALL_MADE', activity_date: new Date().toISOString().split('T')[0], performed_by: 'Sageer A. Shaikh', subject: '', details: '', outcome: 'NEUTRAL', follow_up_date: '' });
      fetchData();
    } catch (err) {
      console.error(err);
      alert('Failed to log activity');
    }
  };

  const handleAddOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...orderForm, company_id: companyId })
      });
      setShowOrderForm(false);
      setOrderForm({
        order_reference: '',
        order_date: new Date().toISOString().split('T')[0],
        order_value_eur: 0,
        product_type: 'CERAMIC_BEARING',
        is_hybrid: false,
        payment_received: false,
        innovista_contribution: 'LEAD_GEN'
      });
      fetchData();
    } catch (err) {
      console.error(err);
      alert('Failed to save order');
    }
  };

  const handleEditCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetch(`/api/companies/${companyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(companyForm)
      });
      setShowEditCompany(false);
      fetchData();
    } catch (err) {
      console.error(err);
      alert('Failed to update company');
    }
  };

  if (loading) return <div className="p-8 text-center text-slate-500">Loading company details...</div>;
  if (!company) return <div className="p-8 text-center text-red-500">Company not found.</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 hover:bg-slate-200 rounded-full transition-colors text-slate-500">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
              {company.company_name}
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                company.lead_status === 'APPROVED' ? 'bg-green-100 text-green-700' :
                company.lead_status === 'QUALIFIED' ? 'bg-purple-100 text-purple-700' :
                company.lead_status === 'DISQUALIFIED' ? 'bg-red-100 text-red-700' :
                company.lead_status === 'RAW' ? 'bg-slate-100 text-slate-700' :
                'bg-blue-100 text-blue-700'
              }`}>
                {company.lead_status}
              </span>
            </h1>
            <div className="text-slate-500 text-sm mt-1 flex items-center gap-4">
              <span className="flex items-center gap-1"><Building2 className="w-4 h-4" /> {company.industry}</span>
              <span className="flex items-center gap-1"><Globe className="w-4 h-4" /> {company.city ? `${company.city}, ` : ''}{company.country}</span>
            </div>
          </div>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={() => setShowEditCompany(true)}
            className="bg-white border border-slate-200 px-4 py-2 rounded-lg flex items-center gap-2 shadow-sm hover:bg-slate-50 transition-colors text-sm font-medium text-slate-700"
          >
            <Edit className="w-4 h-4" /> Edit
          </button>
          {company.lead_score !== null && (
            <div className="bg-white border border-slate-200 px-4 py-2 rounded-lg flex flex-col items-center shadow-sm">
              <span className="text-xs text-slate-500 font-medium uppercase">Score</span>
              <span className="text-lg font-bold text-slate-900">{company.lead_score}</span>
            </div>
          )}
          {company.technical_fit && (
            <div className="bg-white border border-slate-200 px-4 py-2 rounded-lg flex flex-col items-center shadow-sm">
              <span className="text-xs text-slate-500 font-medium uppercase">Tech Fit</span>
              <span className={`text-sm font-bold mt-1 ${
                company.technical_fit === 'HIGH' ? 'text-green-600' :
                company.technical_fit === 'MEDIUM' ? 'text-yellow-600' :
                company.technical_fit === 'LOW' ? 'text-orange-600' : 'text-red-600'
              }`}>{company.technical_fit}</span>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <nav className="-mb-px flex space-x-8">
          {['overview', 'contacts', 'activities', 'orders'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm capitalize ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
              }`}
            >
              {tab === 'activities' ? 'Activity History' : tab === 'orders' ? 'Orders & Commissions' : tab}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        {activeTab === 'overview' && (
          <div className="grid grid-cols-2 gap-8">
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-slate-900 mb-4">Company Details</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
                  <div>
                    <dt className="text-slate-500 font-medium">Type</dt>
                    <dd className="text-slate-900 mt-1">{company.company_type || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">Revenue</dt>
                    <dd className="text-slate-900 mt-1">{company.revenue_eur ? `€${(company.revenue_eur / 1000000).toFixed(2)}M` : '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">Employees</dt>
                    <dd className="text-slate-900 mt-1">{company.employee_count || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">Website</dt>
                    <dd className="text-blue-600 mt-1 hover:underline">
                      {company.website ? <a href={company.website.startsWith('http') ? company.website : `https://${company.website}`} target="_blank" rel="noreferrer">{company.website}</a> : '-'}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-slate-500 font-medium">Source</dt>
                    <dd className="text-slate-900 mt-1">{company.source || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">Region</dt>
                    <dd className="text-slate-900 mt-1">{company.region || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">DUNS Number</dt>
                    <dd className="text-slate-900 mt-1">{company.duns_number || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">Corporate Parent</dt>
                    <dd className="text-slate-900 mt-1">{company.corporate_parent || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">Is Subsidiary?</dt>
                    <dd className="text-slate-900 mt-1">{company.is_subsidiary ? 'Yes' : 'No'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">Assigned To</dt>
                    <dd className="text-slate-900 mt-1">{company.assigned_to || 'Unassigned'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">Created By</dt>
                    <dd className="text-slate-900 mt-1">{company.created_by || 'System'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">Created At</dt>
                    <dd className="text-slate-900 mt-1">{company.created_at ? new Date(company.created_at).toLocaleDateString() : '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 font-medium">Updated At</dt>
                    <dd className="text-slate-900 mt-1">{company.updated_at ? new Date(company.updated_at).toLocaleDateString() : '-'}</dd>
                  </div>
                </dl>
              </div>
            </div>
            
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
                  <Activity className="w-5 h-5 text-blue-500" />
                  AI Research & Reasoning
                </h3>
                <div className="bg-slate-50 rounded-lg p-4 border border-slate-100 space-y-4">
                  {company.qualification_notes ? (
                    <>
                      <div className="grid grid-cols-2 gap-4 text-sm mb-4 border-b border-slate-200 pb-4">
                        <div>
                          <span className="text-slate-500 font-medium block">Product Fit</span>
                          <span className="text-slate-900 font-medium">{company.product_fit || '-'}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 font-medium block">Mentions Technology</span>
                          <span className="text-slate-900">{company.mentions_technology ? 'Yes' : 'No'}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 font-medium block">Social Media Active</span>
                          <span className="text-slate-900">{company.social_media_active ? 'Yes' : 'No'}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-slate-500 font-medium block">Social Media URLs</span>
                          <div className="flex flex-wrap gap-2 mt-1">
                            {company.social_media_urls && JSON.parse(company.social_media_urls).length > 0 ? (
                              JSON.parse(company.social_media_urls).map((url: string, i: number) => (
                                <a key={i} href={url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline text-xs break-all">
                                  {url}
                                </a>
                              ))
                            ) : (
                              <span className="text-slate-400 text-xs">None found</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-500 font-medium block mb-1 text-sm">Reasoning</span>
                        <p className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">
                          {company.qualification_notes}
                        </p>
                      </div>
                    </>
                  ) : (
                    <p className="text-slate-400 text-sm italic">No AI qualification has been run for this lead yet. Click "AI Qualify" from the companies list to generate research.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'contacts' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold text-slate-900">Contacts</h3>
              <div className="flex gap-2">
                <button 
                  onClick={() => {
                    const csvContent = "data:text/csv;charset=utf-8," 
                      + "Name,Title,Email,Phone,LinkedIn,Verified\n"
                      + contacts.map(c => `"${c.full_name}","${c.job_title || ''}","${c.email || ''}","${c.phone_direct || ''}","${c.linkedin_url || ''}","${c.is_verified ? 'Yes' : 'No'}"`).join("\n");
                    const encodedUri = encodeURI(csvContent);
                    const link = document.createElement("a");
                    link.setAttribute("href", encodedUri);
                    link.setAttribute("download", `contacts_${company.company_name.replace(/\s+/g, '_')}.csv`);
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                  }}
                  className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
                >
                  <Download className="w-4 h-4" /> Export Contacts
                </button>
                <button 
                  onClick={() => {
                    setContactForm({ full_name: '', job_title: '', email: '', phone_direct: '', linkedin_url: '', notes: '', is_verified: false, verification_source: '' });
                    setEditingContactId(null);
                    setShowContactForm(!showContactForm);
                  }}
                  className="flex items-center gap-2 bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
                >
                  <Plus className="w-4 h-4" /> Add Contact
                </button>
              </div>
            </div>

            {showContactForm && (
              <form onSubmit={handleAddContact} className="bg-slate-50 p-4 rounded-lg border border-slate-200 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                  <input required type="text" value={contactForm.full_name} onChange={e => setContactForm({...contactForm, full_name: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Job Title</label>
                  <input type="text" value={contactForm.job_title} onChange={e => setContactForm({...contactForm, job_title: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
                  <input type="email" value={contactForm.email} onChange={e => setContactForm({...contactForm, email: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Phone</label>
                  <input type="text" value={contactForm.phone_direct} onChange={e => setContactForm({...contactForm, phone_direct: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">LinkedIn URL</label>
                  <input type="url" value={contactForm.linkedin_url} onChange={e => setContactForm({...contactForm, linkedin_url: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm" />
                </div>
                <div className="col-span-2 flex items-center gap-4 mt-2">
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={contactForm.is_verified} onChange={e => setContactForm({...contactForm, is_verified: e.target.checked})} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                    Verified Contact
                  </label>
                  {contactForm.is_verified && (
                    <select 
                      value={contactForm.verification_source} 
                      onChange={e => setContactForm({...contactForm, verification_source: e.target.value})}
                      className="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white outline-none"
                    >
                      <option value="">Select Source...</option>
                      <option value="LINKEDIN">LinkedIn</option>
                      <option value="COMPANY_WEBSITE">Company Website</option>
                      <option value="DNB_HOOVERS">D&B Hoovers</option>
                      <option value="PHONE_CALL">Phone Call</option>
                    </select>
                  )}
                </div>
                <div className="col-span-2 flex justify-end gap-2 mt-2">
                  <button type="button" onClick={() => setShowContactForm(false)} className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 rounded-md">Cancel</button>
                  <button type="submit" className="px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md">Save Contact</button>
                </div>
              </form>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {contacts.length === 0 ? (
                <div className="col-span-2 text-center py-8 text-slate-500 text-sm">No contacts found.</div>
              ) : (
                contacts.map(contact => (
                  <div key={contact.id} className="border border-slate-200 rounded-lg p-4 flex flex-col relative group">
                    <div className="absolute top-4 right-4 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => handleEditContact(contact)} className="text-slate-300 hover:text-blue-500">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDeleteContact(contact.id)} className="text-slate-300 hover:text-red-500">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 pr-12">
                      <div className="font-semibold text-slate-900">{contact.full_name}</div>
                      {contact.is_verified && (
                        <div className="flex items-center gap-1 bg-green-50 text-green-700 px-1.5 py-0.5 rounded text-[10px] font-medium border border-green-200" title={`Verified via ${contact.verification_source} on ${contact.verified_date ? new Date(contact.verified_date).toLocaleDateString() : 'Unknown date'}`}>
                          <CheckCircle2 className="w-3 h-3" />
                          Verified
                        </div>
                      )}
                    </div>
                    <div className="text-sm text-slate-500 mb-3">{contact.job_title || 'No title'}</div>
                    <div className="space-y-2 mt-auto">
                      {contact.email && <div className="flex items-center gap-2 text-sm text-slate-600"><Mail className="w-4 h-4 text-slate-400" /> <a href={`mailto:${contact.email}`} className="hover:text-blue-600">{contact.email}</a></div>}
                      {contact.phone_direct && <div className="flex items-center gap-2 text-sm text-slate-600"><Phone className="w-4 h-4 text-slate-400" /> {contact.phone_direct}</div>}
                      {contact.linkedin_url && <div className="flex items-center gap-2 text-sm text-slate-600"><Linkedin className="w-4 h-4 text-slate-400" /> <a href={contact.linkedin_url} target="_blank" rel="noreferrer" className="hover:text-blue-600">LinkedIn Profile</a></div>}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'activities' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold text-slate-900">Activity History</h3>
              <button 
                onClick={() => setShowActivityForm(!showActivityForm)}
                className="flex items-center gap-2 bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
              >
                <Plus className="w-4 h-4" /> Log Activity
              </button>
            </div>

            {showActivityForm && (
              <form onSubmit={handleAddActivity} className="bg-slate-50 p-4 rounded-lg border border-slate-200 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Type</label>
                  <select value={activityForm.activity_type} onChange={e => setActivityForm({...activityForm, activity_type: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white">
                    <option value="CALL_MADE">Call Made</option>
                    <option value="EMAIL_SENT">Email Sent</option>
                    <option value="MEETING_HELD">Meeting Held</option>
                    <option value="LINKEDIN_MESSAGE">LinkedIn Message</option>
                    <option value="NOTE">General Note</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Date</label>
                  <input type="date" required value={activityForm.activity_date} onChange={e => setActivityForm({...activityForm, activity_date: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Performed By</label>
                  <select value={activityForm.performed_by} onChange={e => setActivityForm({...activityForm, performed_by: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white">
                    {internalUsers.map(user => (
                      <option key={user} value={user}>{user}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Subject</label>
                  <input type="text" required value={activityForm.subject} onChange={e => setActivityForm({...activityForm, subject: e.target.value})} placeholder="e.g., Initial intro call" className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Details</label>
                  <textarea rows={3} value={activityForm.details} onChange={e => setActivityForm({...activityForm, details: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm"></textarea>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Outcome</label>
                  <select value={activityForm.outcome} onChange={e => setActivityForm({...activityForm, outcome: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white">
                    <option value="POSITIVE">Positive</option>
                    <option value="NEUTRAL">Neutral</option>
                    <option value="NEGATIVE">Negative</option>
                    <option value="FOLLOW_UP_NEEDED">Follow-up Needed</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Follow-up Date (Optional)</label>
                  <input type="date" value={activityForm.follow_up_date} onChange={e => setActivityForm({...activityForm, follow_up_date: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm" />
                </div>
                <div className="col-span-2 flex justify-end gap-2 mt-2">
                  <button type="button" onClick={() => setShowActivityForm(false)} className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 rounded-md">Cancel</button>
                  <button type="submit" className="px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md">Save Activity</button>
                </div>
              </form>
            )}

            <div className="space-y-4">
              {activities.length === 0 ? (
                <div className="text-center py-8 text-slate-500 text-sm">No activities logged yet.</div>
              ) : (
                <div className="relative border-l border-slate-200 ml-3 space-y-6 pb-4">
                  {activities.map(activity => (
                    <div key={activity.id} className="relative pl-6">
                      <div className="absolute -left-1.5 top-1.5 w-3 h-3 rounded-full bg-blue-500 border-2 border-white"></div>
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <span className="font-semibold text-slate-900">{activity.subject}</span>
                            <span className="text-xs text-slate-500 ml-2 px-2 py-0.5 bg-slate-200 rounded-full">{activity.activity_type.replace('_', ' ')}</span>
                          </div>
                          <span className="text-xs text-slate-500 flex items-center gap-1"><Calendar className="w-3 h-3" /> {new Date(activity.activity_date).toLocaleDateString()}</span>
                        </div>
                        {activity.details && <p className="text-sm text-slate-700 mb-3 whitespace-pre-wrap">{activity.details}</p>}
                        <div className="flex items-center gap-4 text-xs">
                          <span className="text-slate-500">By {activity.performed_by}</span>
                          <span className={`font-medium ${
                            activity.outcome === 'POSITIVE' ? 'text-green-600' :
                            activity.outcome === 'NEGATIVE' ? 'text-red-600' :
                            activity.outcome === 'FOLLOW_UP_NEEDED' ? 'text-orange-600' : 'text-slate-600'
                          }`}>Outcome: {activity.outcome.replace('_', ' ')}</span>
                          {activity.follow_up_date && (
                            <span className="text-orange-600 font-medium flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" /> Follow-up: {new Date(activity.follow_up_date).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'orders' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold text-slate-900">Orders & Commissions</h3>
              <button 
                onClick={() => setShowOrderForm(!showOrderForm)}
                className="flex items-center gap-2 bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
              >
                <Plus className="w-4 h-4" /> Add Order
              </button>
            </div>

            {showOrderForm && (
              <form onSubmit={handleAddOrder} className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Order Reference</label>
                    <input type="text" required value={orderForm.order_reference} onChange={e => setOrderForm({...orderForm, order_reference: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white" placeholder="e.g. PO-2026-001" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Order Date</label>
                    <input type="date" required value={orderForm.order_date} onChange={e => setOrderForm({...orderForm, order_date: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Order Value (€)</label>
                    <input type="number" required min="0" step="0.01" value={orderForm.order_value_eur} onChange={e => setOrderForm({...orderForm, order_value_eur: parseFloat(e.target.value)})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Product Type</label>
                    <select value={orderForm.product_type} onChange={e => setOrderForm({...orderForm, product_type: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                      <option value="CERAMIC_BEARING">Ceramic Bearing</option>
                      <option value="HYBRID_BEARING">Hybrid Bearing</option>
                      <option value="CERAMIC_COMPONENT">Ceramic Component</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2 mt-6">
                    <input type="checkbox" id="is_hybrid" checked={orderForm.is_hybrid} onChange={e => setOrderForm({...orderForm, is_hybrid: e.target.checked})} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                    <label htmlFor="is_hybrid" className="text-sm font-medium text-slate-700">Is Hybrid Bearing? (Custom commission)</label>
                  </div>
                  <div className="flex items-center gap-2 mt-6">
                    <input type="checkbox" id="payment_received" checked={orderForm.payment_received} onChange={e => setOrderForm({...orderForm, payment_received: e.target.checked})} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                    <label htmlFor="payment_received" className="text-sm font-medium text-slate-700">Payment Received by ST</label>
                  </div>
                </div>
                <div className="flex justify-end gap-3 mt-4">
                  <button type="button" onClick={() => setShowOrderForm(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800">Cancel</button>
                  <button type="submit" className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700">Save Order</button>
                </div>
              </form>
            )}

            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                <h4 className="text-sm font-medium text-green-800 mb-1">Earned Commission</h4>
                <p className="text-2xl font-bold text-green-700">€{orders.filter(o => o.payment_received).reduce((sum, o) => sum + (o.commission_eur || 0), 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
                <p className="text-xs text-green-600 mt-1">From paid orders</p>
              </div>
              <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
                <h4 className="text-sm font-medium text-orange-800 mb-1">Pending Commission</h4>
                <p className="text-2xl font-bold text-orange-700">€{orders.filter(o => !o.payment_received).reduce((sum, o) => sum + (o.commission_eur || 0), 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
                <p className="text-xs text-orange-600 mt-1">Awaiting customer payment</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Reference</th>
                    <th className="px-4 py-3 font-medium text-right">Order Value</th>
                    <th className="px-4 py-3 font-medium text-right">Commission</th>
                    <th className="px-4 py-3 font-medium text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {orders.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-500">No orders found for this company.</td>
                    </tr>
                  ) : (
                    orders.map(order => (
                      <tr key={order.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 text-slate-900">{new Date(order.order_date).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-slate-600 font-medium">{order.order_reference}</td>
                        <td className="px-4 py-3 text-right text-slate-900 font-medium">€{order.order_value_eur.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        <td className="px-4 py-3 text-right text-blue-600 font-medium">
                          {order.commission_eur ? `€${order.commission_eur.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : 'TBD'}
                          {order.commission_rate && <span className="text-xs text-slate-400 block">({(order.commission_rate * 100).toFixed(0)}%)</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {order.payment_received ? (
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-100 text-green-700 text-xs font-medium">
                              <CheckCircle2 className="w-3 h-3" /> Paid
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-orange-100 text-orange-700 text-xs font-medium">
                              <Clock className="w-3 h-3" /> Pending
                            </span>
                          )}
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

      {/* Edit Company Modal */}
      {showEditCompany && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-200 flex justify-between items-center sticky top-0 bg-white">
              <h2 className="text-xl font-bold text-slate-900">Edit Company</h2>
              <button onClick={() => setShowEditCompany(false)} className="text-slate-500 hover:text-slate-700 text-2xl leading-none">&times;</button>
            </div>
            <form onSubmit={handleEditCompany} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Company Name</label>
                  <input type="text" required value={companyForm.company_name || ''} onChange={e => setCompanyForm({...companyForm, company_name: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Website</label>
                  <input type="text" value={companyForm.website || ''} onChange={e => setCompanyForm({...companyForm, website: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Country</label>
                  <input type="text" required value={companyForm.country || ''} onChange={e => setCompanyForm({...companyForm, country: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">City</label>
                  <input type="text" value={companyForm.city || ''} onChange={e => setCompanyForm({...companyForm, city: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Region</label>
                  <select value={companyForm.region || ''} onChange={e => setCompanyForm({...companyForm, region: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    <option value="">Select Region...</option>
                    <option value="DACH">DACH</option>
                    <option value="GCC">GCC</option>
                    <option value="UK_IE">UK & Ireland</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Industry</label>
                  <select value={companyForm.industry || ''} onChange={e => setCompanyForm({...companyForm, industry: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
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
                  <label className="block text-sm font-medium text-slate-700 mb-1">Company Type</label>
                  <select value={companyForm.company_type || ''} onChange={e => setCompanyForm({...companyForm, company_type: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    <option value="BEARING_TRADER">Bearing Trader</option>
                    <option value="MANUFACTURER">Manufacturer</option>
                    <option value="DISTRIBUTOR">Distributor</option>
                    <option value="UNIVERSITY">University</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Lead Status</label>
                  <select value={companyForm.lead_status || ''} onChange={e => setCompanyForm({...companyForm, lead_status: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
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
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Technical Fit</label>
                  <select value={companyForm.technical_fit || ''} onChange={e => setCompanyForm({...companyForm, technical_fit: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    <option value="">Unassessed</option>
                    <option value="HIGH">High</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="LOW">Low</option>
                    <option value="NOT_FIT">Not a Fit</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Assigned To</label>
                  <select value={companyForm.assigned_to || ''} onChange={e => setCompanyForm({...companyForm, assigned_to: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    <option value="">Unassigned</option>
                    {internalUsers.map(user => (
                      <option key={user} value={user}>{user}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Qualification Notes</label>
                  <textarea rows={3} value={companyForm.qualification_notes || ''} onChange={e => setCompanyForm({...companyForm, qualification_notes: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"></textarea>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
                <button type="button" onClick={() => setShowEditCompany(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-md font-medium transition-colors">Cancel</button>
                <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md font-medium transition-colors">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

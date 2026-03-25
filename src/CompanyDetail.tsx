import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Building2, Globe, Users, Euro, Phone, Mail, Linkedin, Plus, Calendar, CheckCircle2, MessageSquare, Briefcase, Trash2, Activity, Edit2, Clock, AlertCircle, Edit, Download, Send, Sparkles, Copy, Check, ChevronDown, ChevronUp, Target, TrendingUp, Zap } from 'lucide-react';
import {
  companyTypeOptions,
  industryOptions,
  leadStatusOptions,
  regionOptions,
  technicalFitOptions,
  trackingLevelOptions,
  trackingStatusOptions,
} from './companyData';
import { formatCompactEur, formatEur, parseStringArray } from './formatters';
import ErrorBoundary from './ErrorBoundary';
import { showToast } from './Toast';

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
  onDataChanged?: () => Promise<void>;
  users: string[];
}

export default function CompanyDetail({
  companyId,
  onBack,
  initialTab = 'overview',
  onDataChanged,
  users,
}: CompanyDetailProps) {
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
  const [activityForm, setActivityForm] = useState({
    activity_type: 'CALL_MADE',
    activity_date: new Date().toISOString().split('T')[0],
    performed_by: users.find(u => u.includes('Sageer')) || users[0] || 'System',
    subject: '',
    details: '',
    outcome: 'NEUTRAL',
    follow_up_date: '',
  });

  const [showEditCompany, setShowEditCompany] = useState(false);
  const [companyForm, setCompanyForm] = useState<any>({});
  const [qualifying, setQualifying] = useState(false);
  const [copiedScript, setCopiedScript] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  // Social media editing state
  const [editingProfiles, setEditingProfiles] = useState<Array<{ platform?: string; url?: string; followers?: string; lastActive?: string; lastPost?: string }> | null>(null);
  const [savingProfiles, setSavingProfiles] = useState(false);

  // Inline edit state for company details
  const [editField, setEditField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // Order Form State (kept for data integrity)
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

  // Notes (Team Communication) State
  const [notes, setNotes] = useState<Array<{ id: number; author: string; message: string; type: string; created_at: string }>>([]);
  const [noteText, setNoteText] = useState('');
  const [noteAuthor, setNoteAuthor] = useState(users.find(u => u.includes('Sageer')) || users[0] || 'Team');
  const [submittingNote, setSubmittingNote] = useState(false);
  const notesEndRef = useRef<HTMLDivElement>(null);

  const socialMediaUrls = parseStringArray(company?.social_media_urls);

  const internalUsers = [
    'Sageer A. Shaikh',
    'Ahmad Khan',
    'Dr. Jochen Langguth',
    'Dr. Jürgen Schellenberger',
    'Christoph Langguth',
    'Patton Lucas',
    'Dr. Kathrin Langguth'
  ];

  const fetchNotes = async () => {
    try {
      const res = await fetch(`/api/companies/${companyId}/notes`);
      if (res.ok) setNotes(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const [companyRes] = await Promise.all([
        fetch(`/api/companies/${companyId}`),
        fetchNotes(),
      ]);
      if (!companyRes.ok) throw new Error('Failed to fetch');
      const data = await companyRes.json();
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
    setActiveTab(initialTab);
  }, [companyId, initialTab]);

  useEffect(() => {
    void fetchData();
  }, [companyId]);

  useEffect(() => {
    if (!activityForm.performed_by && users[0]) {
      setActivityForm((currentValue) => ({ ...currentValue, performed_by: users[0] }));
    }
  }, [activityForm.performed_by, users]);

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
      await fetchData();
      await onDataChanged?.();
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
      await fetchData();
      await onDataChanged?.();
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
      setActivityForm({ activity_type: 'CALL_MADE', activity_date: new Date().toISOString().split('T')[0], performed_by: users[0] || 'System', subject: '', details: '', outcome: 'NEUTRAL', follow_up_date: '' });
      await fetchData();
      await onDataChanged?.();
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
      await fetchData();
      await onDataChanged?.();
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
      await fetchData();
      await onDataChanged?.();
    } catch (err) {
      console.error(err);
      alert('Failed to update company');
    }
  };

  const handleAIQualify = async () => {
    setQualifying(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/ai-qualify`, { method: 'POST' });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || 'AI qualification failed');
      setCompany(payload);
      setCompanyForm(payload);
      // Refresh contacts (AI may have added new ones)
      await fetchData();
      await onDataChanged?.();
      showToast('success', 'AI Qualification complete', `Score: ${payload.lead_score || 0} | Status: ${payload.lead_status}`);
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'AI qualification failed';
      showToast('error', 'AI Qualification failed', msg + '. Check Settings to ensure your API key is configured.');
    } finally {
      setQualifying(false);
    }
  };

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedScript(key);
      setTimeout(() => setCopiedScript(null), 2000);
    } catch (_) {}
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteText.trim()) return;
    setSubmittingNote(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: noteAuthor, message: noteText.trim(), type: 'note' })
      });
      if (res.ok) {
        const newNote = await res.json();
        setNotes((prev) => [...prev, newNote]);
        setNoteText('');
        setTimeout(() => notesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      }
    } catch (err) {
      console.error(err);
      alert('Failed to add note');
    } finally {
      setSubmittingNote(false);
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
            {/* Quick info: website, main contact, social */}
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              {company.website && (
                <a href={company.website.startsWith('http') ? company.website : `https://${company.website}`} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-1 rounded-full">
                  <Globe className="w-3 h-3" /> {company.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
                </a>
              )}
              {contacts.length > 0 && (
                <span className="flex items-center gap-1 text-xs text-slate-600 bg-slate-100 px-2 py-1 rounded-full">
                  <Users className="w-3 h-3" /> {contacts[0].full_name}{contacts[0].job_title ? ` · ${contacts[0].job_title}` : ''}
                  {contacts[0].email && <> · <a href={`mailto:${contacts[0].email}`} className="text-blue-600 hover:underline">{contacts[0].email}</a></>}
                </span>
              )}
              {socialMediaUrls.map((url: string, i: number) => (
                <a key={i} href={url} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 bg-purple-50 px-2 py-1 rounded-full">
                  <Linkedin className="w-3 h-3" /> {url.replace(/^https?:\/\/(www\.)?/, '').split('/').slice(0, 2).join('/')}
                </a>
              ))}
              {company.employee_count && (
                <span className="text-xs text-slate-500 bg-slate-50 px-2 py-1 rounded-full">{company.employee_count} employees</span>
              )}
              {company.revenue_eur && (
                <span className="text-xs text-slate-500 bg-slate-50 px-2 py-1 rounded-full">€{(company.revenue_eur/1000000).toFixed(1)}M revenue</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-3 items-center">
          <button
            onClick={() => void handleAIQualify()}
            disabled={qualifying}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm"
          >
            <Sparkles className="w-4 h-4" />
            {qualifying ? 'Researching...' : company.ai_qualified_at ? 'Re-qualify' : 'AI Qualify'}
          </button>
          <button
            onClick={() => setShowEditCompany(true)}
            className="bg-white border border-slate-200 px-4 py-2 rounded-lg flex items-center gap-2 shadow-sm hover:bg-slate-50 transition-colors text-sm font-medium text-slate-700"
          >
            <Edit className="w-4 h-4" /> Edit
          </button>
          {company.lead_score !== null && company.lead_score > 0 && (
            <div className="bg-white border border-slate-200 px-4 py-2 rounded-lg flex flex-col items-center shadow-sm min-w-[56px]">
              <span className="text-xs text-slate-500 font-medium uppercase">Score</span>
              <span className={`text-lg font-bold ${company.lead_score >= 70 ? 'text-green-600' : company.lead_score >= 40 ? 'text-yellow-600' : 'text-red-600'}`}>{company.lead_score}</span>
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
          {['overview', 'contacts', 'activities', 'social', 'notes'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm capitalize ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
              }`}
            >
              {tab === 'activities' ? 'Activity History' : tab === 'social' ? (
                <span className="flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" />
                  Social Media
                  {socialMediaUrls.length > 0 && (
                    <span className="bg-purple-100 text-purple-700 text-[10px] px-1.5 py-0.5 rounded-full font-medium">{socialMediaUrls.length}</span>
                  )}
                </span>
              ) : tab === 'notes' ? (
                <span className="flex items-center gap-1.5">
                  <MessageSquare className="w-3.5 h-3.5" />
                  Team Notes
                  {notes.length > 0 && (
                    <span className="bg-blue-100 text-blue-700 text-[10px] px-1.5 py-0.5 rounded-full font-medium">{notes.length}</span>
                  )}
                </span>
              ) : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <ErrorBoundary>
        {activeTab === 'overview' && (
          <div className="space-y-6">

            {/* AI Qualification loading overlay */}
            {qualifying && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" />
                <div>
                  <div className="text-sm font-semibold text-indigo-800">AI Research in progress...</div>
                  <div className="text-xs text-indigo-600">Searching the web, scoring fit, generating sales scripts. This takes 15–30 seconds.</div>
                </div>
              </div>
            )}

            {/* Score Dashboard — shown after AI qualify */}
            {company.ai_qualified_at && (
              <div className="bg-gradient-to-r from-slate-900 to-slate-800 rounded-xl p-5 text-white">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-indigo-400" />
                    <span className="font-semibold text-sm">AI Qualification Results</span>
                    <span className="text-xs text-slate-400">· {new Date(company.ai_qualified_at).toLocaleDateString()}</span>
                  </div>
                  {company.product_fit && (
                    <span className="text-xs bg-indigo-600 px-2.5 py-1 rounded-full font-medium">{company.product_fit}</span>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {/* Overall Score */}
                  <div className="bg-white/10 rounded-lg p-3">
                    <div className="text-xs text-slate-400 mb-1 flex items-center gap-1"><Target className="w-3 h-3" /> Lead Score</div>
                    <div className={`text-3xl font-bold ${(company.lead_score || 0) >= 70 ? 'text-green-400' : (company.lead_score || 0) >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>
                      {company.lead_score ?? '-'}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">out of 100</div>
                  </div>
                  {/* Buying Probability */}
                  <div className="bg-white/10 rounded-lg p-3">
                    <div className="text-xs text-slate-400 mb-1 flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Buy Probability</div>
                    <div className={`text-3xl font-bold ${(company.buying_probability || 0) >= 60 ? 'text-green-400' : (company.buying_probability || 0) >= 30 ? 'text-yellow-400' : 'text-red-400'}`}>
                      {company.buying_probability != null ? `${company.buying_probability}%` : '-'}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">ceramic bearings</div>
                  </div>
                  {/* Website Score */}
                  <div className="bg-white/10 rounded-lg p-3">
                    <div className="text-xs text-slate-400 mb-1 flex items-center gap-1"><Globe className="w-3 h-3" /> Website Score</div>
                    <div className={`text-3xl font-bold ${(company.website_score || 0) >= 60 ? 'text-green-400' : (company.website_score || 0) >= 30 ? 'text-yellow-400' : 'text-red-400'}`}>
                      {company.website_score ?? '-'}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">activity level</div>
                  </div>
                  {/* Social Score */}
                  <div className="bg-white/10 rounded-lg p-3">
                    <div className="text-xs text-slate-400 mb-1 flex items-center gap-1"><Users className="w-3 h-3" /> Social Score</div>
                    <div className={`text-3xl font-bold ${(company.social_score || 0) >= 60 ? 'text-green-400' : (company.social_score || 0) >= 30 ? 'text-yellow-400' : 'text-red-400'}`}>
                      {company.social_score ?? '-'}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                      {company.social_media_active ? 'active' : 'inactive'}
                    </div>
                  </div>
                </div>

                {/* Tech Fit + Social tags */}
                <div className="flex flex-wrap gap-2 mt-4">
                  {company.technical_fit && (
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                      company.technical_fit === 'HIGH' ? 'bg-green-500/20 text-green-300' :
                      company.technical_fit === 'MEDIUM' ? 'bg-yellow-500/20 text-yellow-300' :
                      company.technical_fit === 'LOW' ? 'bg-orange-500/20 text-orange-300' : 'bg-red-500/20 text-red-300'
                    }`}>Tech Fit: {company.technical_fit}</span>
                  )}
                  {company.mentions_technology && (
                    <span className="text-xs px-2.5 py-1 rounded-full bg-blue-500/20 text-blue-300 font-medium">Mentions Bearings/Technology</span>
                  )}
                  {company.social_media_active && (
                    <span className="text-xs px-2.5 py-1 rounded-full bg-purple-500/20 text-purple-300 font-medium">Active on Social Media</span>
                  )}
                  {socialMediaUrls.map((url: string, i: number) => (
                    <a key={i} href={url} target="_blank" rel="noreferrer"
                      className="text-xs px-2.5 py-1 rounded-full bg-white/10 text-slate-300 hover:bg-white/20 transition-colors font-medium truncate max-w-[200px]">
                      {url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* No AI yet prompt */}
            {!company.ai_qualified_at && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-5 flex items-start gap-4">
                <Sparkles className="w-6 h-6 text-indigo-500 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-indigo-900 mb-1">Run AI Qualification for deep insights</div>
                  <div className="text-sm text-indigo-700">Get website score, social media presence, buying probability, ceramic bearing opportunity analysis, approach strategy, sales call script, and a personalised email draft — all generated by AI with live web search.</div>
                  <button onClick={() => void handleAIQualify()} className="mt-3 bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" /> Run AI Qualification
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-6">
              {/* Left: Company Details — inline editable */}
              {(() => {
                const startEdit = (field: string, value: any) => { setEditField(field); setEditValue(value ?? ''); };
                const cancelEdit = () => { setEditField(null); setEditValue(''); };
                const saveField = async (field: string) => {
                  const updates: any = { ...company, [field]: editValue };
                  if (field === 'revenue_eur') updates.revenue_eur = editValue ? Number(editValue) : null;
                  if (field === 'employee_count') updates.employee_count = editValue ? Number(editValue) : null;
                  try {
                    await fetch(`/api/companies/${companyId}`, {
                      method: 'PUT', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(updates),
                    });
                    await fetchData();
                    await onDataChanged?.();
                  } catch (err) { console.error(err); }
                  cancelEdit();
                };
                const handleKeyDown = (e: React.KeyboardEvent, field: string) => {
                  if (e.key === 'Enter') void saveField(field);
                  if (e.key === 'Escape') cancelEdit();
                };

                const EditableField = ({ label, field, value, displayValue, type = 'text', options }: {
                  label: string; field: string; value: any; displayValue?: string; type?: string;
                  options?: Array<{ value: string; label: string }>;
                }) => (
                  <div className="flex justify-between items-center group min-h-[28px]">
                    <dt className="text-slate-500 shrink-0">{label}</dt>
                    {editField === field ? (
                      <dd className="flex items-center gap-1">
                        {options ? (
                          <select value={editValue} onChange={e => setEditValue(e.target.value)}
                            onBlur={() => void saveField(field)} autoFocus
                            className="border border-blue-300 rounded px-1.5 py-0.5 text-xs w-36 bg-white outline-none focus:ring-1 focus:ring-blue-400">
                            <option value="">—</option>
                            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        ) : (
                          <input type={type} value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onBlur={() => void saveField(field)}
                            onKeyDown={e => handleKeyDown(e, field)}
                            autoFocus
                            className="border border-blue-300 rounded px-1.5 py-0.5 text-xs w-36 outline-none focus:ring-1 focus:ring-blue-400 text-right" />
                        )}
                      </dd>
                    ) : (
                      <dd
                        onClick={() => startEdit(field, value)}
                        className="text-slate-900 font-medium text-right cursor-pointer hover:bg-blue-50 hover:text-blue-700 px-1.5 py-0.5 rounded transition-colors -mr-1.5 max-w-[180px] truncate"
                        title="Click to edit"
                      >
                        {displayValue || value || '-'}
                        <Edit2 className="w-2.5 h-2.5 inline ml-1 opacity-0 group-hover:opacity-40" />
                      </dd>
                    )}
                  </div>
                );

                return (
                  <div className="col-span-1 space-y-4">
                    <h3 className="text-base font-semibold text-slate-900">Company Details</h3>
                    <dl className="space-y-3 text-sm">
                      <EditableField label="Type" field="company_type" value={company.company_type}
                        options={companyTypeOptions.map(o => ({ value: o.value, label: o.label }))} />
                      <EditableField label="Revenue" field="revenue_eur" value={company.revenue_eur || ''}
                        displayValue={company.revenue_eur ? `€${(company.revenue_eur/1000000).toFixed(1)}M` : '-'} type="number" />
                      <EditableField label="Employees" field="employee_count" value={company.employee_count || ''} type="number" />
                      <EditableField label="Website" field="website" value={company.website || ''} />
                      <EditableField label="Region" field="region" value={company.region}
                        options={regionOptions.map(o => ({ value: o.value, label: o.label }))} />
                      <EditableField label="Industry" field="industry" value={company.industry}
                        options={industryOptions.map(o => ({ value: o.value, label: o.label }))} />
                      <EditableField label="Assigned To" field="assigned_to" value={company.assigned_to}
                        options={[{ value: '', label: 'Unassigned' }, ...internalUsers.map(u => ({ value: u, label: u }))]} />
                      <EditableField label="DUNS" field="duns_number" value={company.duns_number || ''} />
                      <EditableField label="Corp. Parent" field="corporate_parent" value={company.corporate_parent || ''} />
                      <EditableField label="Source" field="source" value={company.source || ''} />
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Created</dt>
                        <dd className="text-slate-600 text-xs">{company.created_at ? new Date(company.created_at).toLocaleDateString() : '-'}</dd>
                      </div>
                    </dl>

                    {/* Tracking */}
                    <div className="pt-4 border-t border-slate-100">
                      <h4 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
                        <Clock className="w-4 h-4 text-orange-500" /> Tracking
                      </h4>
                      <dl className="space-y-2 text-xs">
                        <EditableField label="Level" field="tracking_level" value={company.tracking_level || 'WATCHLIST'}
                          options={[{ value: 'WATCHLIST', label: 'Watchlist' }, { value: 'ACTIVE', label: 'Active' }, { value: 'PRIORITY', label: 'Priority' }]} />
                        <EditableField label="Status" field="tracking_status" value={company.tracking_status || 'PENDING'}
                          options={[{ value: 'PENDING', label: 'Pending' }, { value: 'QUALIFIED', label: 'Qualified' }, { value: 'IN_PROGRESS', label: 'In Progress' }, { value: 'DONE', label: 'Done' }]} />
                        <EditableField label="Next Date" field="next_tracking_date"
                          value={company.next_tracking_date ? company.next_tracking_date.split('T')[0] : ''}
                          displayValue={company.next_tracking_date ? new Date(company.next_tracking_date).toLocaleDateString() : '-'}
                          type="date" />
                      </dl>
                    </div>

                    {/* Data Compliance */}
                    <div className="pt-3 border-t border-slate-100 mt-3">
                      <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> Compliance
                      </h4>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] bg-green-50 text-green-700 border border-green-200 px-1.5 py-0.5 rounded-full font-medium">Compliant</span>
                        <span className="text-[10px] text-slate-400">Sintertechnik-approved</span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-1">
                        Source: <span className="font-medium text-slate-600">{company.source || 'MANUAL'}</span>
                        {company.ai_qualified_at && <span> · AI {new Date(company.ai_qualified_at).toLocaleDateString()}</span>}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Right: AI Intelligence (2/3 width) */}
              <div className="col-span-2 space-y-4">

                {/* Strategic Analysis */}
                {company.qualification_notes && (
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                    <h4 className="text-sm font-semibold text-slate-800 mb-2 flex items-center gap-1.5">
                      <Activity className="w-4 h-4 text-blue-500" /> Strategic Analysis
                    </h4>
                    <p className="text-sm text-slate-700 leading-relaxed">{company.qualification_notes}</p>
                  </div>
                )}

                {/* Opportunity Notes */}
                {company.opportunity_notes && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                    <h4 className="text-sm font-semibold text-amber-800 mb-2 flex items-center gap-1.5">
                      <Zap className="w-4 h-4 text-amber-500" /> Opportunity & Pain Points
                    </h4>
                    <p className="text-sm text-amber-900 leading-relaxed whitespace-pre-wrap">{company.opportunity_notes}</p>
                  </div>
                )}

                {/* Approach Strategy */}
                {company.approach_strategy && (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                    <h4 className="text-sm font-semibold text-green-800 mb-2 flex items-center gap-1.5">
                      <Target className="w-4 h-4 text-green-500" /> Recommended Approach
                    </h4>
                    <p className="text-sm text-green-900 leading-relaxed whitespace-pre-wrap">{company.approach_strategy}</p>
                  </div>
                )}

                {/* Sales Script */}
                {company.sales_script && (
                  <div className="bg-blue-50 border border-blue-200 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedSection(expandedSection === 'sales' ? null : 'sales')}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-blue-100 transition-colors"
                    >
                      <span className="text-sm font-semibold text-blue-800 flex items-center gap-1.5">
                        <MessageSquare className="w-4 h-4" /> Sales Call Script
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); void copyToClipboard(company.sales_script, 'sales'); }}
                          className="text-blue-600 hover:text-blue-800 flex items-center gap-1 text-xs px-2 py-0.5 rounded hover:bg-blue-200 transition-colors"
                        >
                          {copiedScript === 'sales' ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
                        </button>
                        {expandedSection === 'sales' ? <ChevronUp className="w-4 h-4 text-blue-600" /> : <ChevronDown className="w-4 h-4 text-blue-600" />}
                      </div>
                    </button>
                    {expandedSection === 'sales' && (
                      <div className="px-4 pb-4">
                        <pre className="text-sm text-blue-900 whitespace-pre-wrap font-sans leading-relaxed">{company.sales_script}</pre>
                      </div>
                    )}
                  </div>
                )}

                {/* Email Script */}
                {company.email_script && (
                  <div className="bg-purple-50 border border-purple-200 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedSection(expandedSection === 'email' ? null : 'email')}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-purple-100 transition-colors"
                    >
                      <span className="text-sm font-semibold text-purple-800 flex items-center gap-1.5">
                        <Mail className="w-4 h-4" /> Cold Outreach Email
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); void copyToClipboard(company.email_script, 'email'); }}
                          className="text-purple-600 hover:text-purple-800 flex items-center gap-1 text-xs px-2 py-0.5 rounded hover:bg-purple-200 transition-colors"
                        >
                          {copiedScript === 'email' ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
                        </button>
                        {expandedSection === 'email' ? <ChevronUp className="w-4 h-4 text-purple-600" /> : <ChevronDown className="w-4 h-4 text-purple-600" />}
                      </div>
                    </button>
                    {expandedSection === 'email' && (
                      <div className="px-4 pb-4">
                        <pre className="text-sm text-purple-900 whitespace-pre-wrap font-sans leading-relaxed">{company.email_script}</pre>
                      </div>
                    )}
                  </div>
                )}

                {/* No AI data yet */}
                {!company.qualification_notes && !company.approach_strategy && !company.sales_script && !company.email_script && !company.ai_qualified_at && (
                  <div className="text-center py-8 text-slate-400 text-sm border-2 border-dashed border-slate-200 rounded-xl">
                    No AI research yet — click <strong className="text-indigo-600">AI Qualify</strong> above to generate deep analysis
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'social' && (() => {
          let socialProfiles: Array<{ platform?: string; url?: string; followers?: string; lastActive?: string; lastPost?: string }> = [];
          try { socialProfiles = JSON.parse(company.social_profiles_json || '[]'); } catch (e) {}
          const platformIcon = (p: string) => {
            const lower = p?.toLowerCase() || '';
            if (lower.includes('linkedin')) return '🔗';
            if (lower.includes('facebook')) return '📘';
            if (lower.includes('instagram')) return '📷';
            if (lower.includes('youtube')) return '🎥';
            if (lower.includes('twitter') || lower.includes('x')) return '🐦';
            return '🌐';
          };
          const platformColor = (p: string) => {
            const lower = p?.toLowerCase() || '';
            if (lower.includes('linkedin')) return 'border-blue-200 bg-blue-50';
            if (lower.includes('facebook')) return 'border-indigo-200 bg-indigo-50';
            if (lower.includes('instagram')) return 'border-pink-200 bg-pink-50';
            if (lower.includes('youtube')) return 'border-red-200 bg-red-50';
            if (lower.includes('twitter') || lower.includes('x')) return 'border-sky-200 bg-sky-50';
            return 'border-slate-200 bg-slate-50';
          };
          const PLATFORMS = ['LinkedIn', 'Facebook', 'Instagram', 'YouTube', 'Twitter/X'];

          const startEditing = () => {
            const current = socialProfiles.length > 0 ? [...socialProfiles] : PLATFORMS.map(p => ({ platform: p, url: '', followers: '', lastActive: '', lastPost: '' }));
            setEditingProfiles(current);
          };

          const saveProfiles = async () => {
            if (!editingProfiles) return;
            setSavingProfiles(true);
            try {
              const filtered = editingProfiles.filter(p => p.url?.trim());
              const res = await fetch(`/api/companies/${companyId}/social-profiles`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profiles: filtered }),
              });
              if (res.ok) {
                const updated = await res.json();
                setCompany(updated);
                setEditingProfiles(null);
              }
            } catch (err) { console.error(err); }
            finally { setSavingProfiles(false); }
          };

          const updateEditProfile = (idx: number, field: string, value: string) => {
            if (!editingProfiles) return;
            const updated = [...editingProfiles];
            updated[idx] = { ...updated[idx], [field]: value };
            setEditingProfiles(updated);
          };

          const addEditProfile = () => {
            if (!editingProfiles) return;
            setEditingProfiles([...editingProfiles, { platform: '', url: '', followers: '', lastActive: '', lastPost: '' }]);
          };

          const removeEditProfile = (idx: number) => {
            if (!editingProfiles) return;
            setEditingProfiles(editingProfiles.filter((_, i) => i !== idx));
          };

          return (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-slate-900">Social Media Profiles</h3>
                <div className="flex items-center gap-2">
                  {!company.ai_qualified_at && (
                    <button onClick={() => void handleAIQualify()} disabled={qualifying}
                      className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-60">
                      <Sparkles className="w-3.5 h-3.5" /> {qualifying ? 'Researching...' : 'AI Discover'}
                    </button>
                  )}
                  {!editingProfiles ? (
                    <button onClick={startEditing}
                      className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 px-3 py-1.5 rounded-lg text-sm font-medium">
                      <Edit className="w-3.5 h-3.5" /> Edit Profiles
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <button onClick={() => setEditingProfiles(null)} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700">Cancel</button>
                      <button onClick={() => void saveProfiles()} disabled={savingProfiles}
                        className="flex items-center gap-1.5 bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-60">
                        <Check className="w-3.5 h-3.5" /> {savingProfiles ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Overall social score */}
              {company.ai_qualified_at && (
                <div className="flex items-center gap-6 bg-slate-50 rounded-xl p-4 border border-slate-200">
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Social Score</div>
                    <div className={`text-3xl font-bold ${(company.social_score || 0) >= 60 ? 'text-green-600' : (company.social_score || 0) >= 30 ? 'text-yellow-600' : 'text-red-500'}`}>
                      {company.social_score ?? '-'}<span className="text-sm text-slate-400 font-normal">/100</span>
                    </div>
                  </div>
                  <div className="h-12 w-px bg-slate-200" />
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Website Score</div>
                    <div className={`text-3xl font-bold ${(company.website_score || 0) >= 60 ? 'text-green-600' : (company.website_score || 0) >= 30 ? 'text-yellow-600' : 'text-red-500'}`}>
                      {company.website_score ?? '-'}<span className="text-sm text-slate-400 font-normal">/100</span>
                    </div>
                  </div>
                  <div className="h-12 w-px bg-slate-200" />
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Status</div>
                    <span className={`text-sm font-semibold ${company.social_media_active ? 'text-green-600' : 'text-slate-400'}`}>
                      {company.social_media_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div className="h-12 w-px bg-slate-200" />
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Profiles</div>
                    <span className="text-sm font-semibold text-slate-900">{socialMediaUrls.length}</span>
                  </div>
                </div>
              )}

              {/* Edit mode */}
              {editingProfiles ? (
                <div className="space-y-3">
                  {editingProfiles.map((profile, i) => (
                    <div key={i} className="bg-white border border-slate-200 rounded-xl p-4">
                      <div className="grid grid-cols-6 gap-3 items-end">
                        <div>
                          <label className="block text-[10px] uppercase text-slate-500 font-medium mb-1">Platform</label>
                          <select value={profile.platform || ''} onChange={e => updateEditProfile(i, 'platform', e.target.value)}
                            className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white">
                            <option value="">Select...</option>
                            {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                            <option value="Other">Other</option>
                          </select>
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[10px] uppercase text-slate-500 font-medium mb-1">URL</label>
                          <input type="text" value={profile.url || ''} onChange={e => updateEditProfile(i, 'url', e.target.value)}
                            placeholder="https://linkedin.com/company/..."
                            className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm font-mono text-xs" />
                        </div>
                        <div>
                          <label className="block text-[10px] uppercase text-slate-500 font-medium mb-1">Followers</label>
                          <input type="text" value={profile.followers || ''} onChange={e => updateEditProfile(i, 'followers', e.target.value)}
                            placeholder="e.g. 5.2K"
                            className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                        </div>
                        <div>
                          <label className="block text-[10px] uppercase text-slate-500 font-medium mb-1">Last Active</label>
                          <input type="text" value={profile.lastActive || ''} onChange={e => updateEditProfile(i, 'lastActive', e.target.value)}
                            placeholder="e.g. Active"
                            className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                        </div>
                        <div className="flex items-end gap-1">
                          <button onClick={() => removeEditProfile(i)} className="text-red-400 hover:text-red-600 p-1.5" title="Remove">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  <button onClick={addEditProfile}
                    className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium">
                    <Plus className="w-4 h-4" /> Add Profile
                  </button>
                </div>
              ) : (
                /* View mode */
                <>
                  {socialProfiles.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {socialProfiles.map((profile, i) => (
                        <div key={i} className={`border rounded-xl p-4 ${platformColor(profile.platform || '')}`}>
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <span className="text-2xl">{platformIcon(profile.platform || '')}</span>
                              <div>
                                <div className="font-semibold text-slate-900 text-sm">{profile.platform || 'Unknown'}</div>
                                {profile.url && (
                                  <a href={profile.url} target="_blank" rel="noreferrer"
                                    className="text-xs text-blue-600 hover:underline truncate block max-w-[250px]">
                                    {profile.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
                                  </a>
                                )}
                              </div>
                            </div>
                            {profile.url && (
                              <a href={profile.url} target="_blank" rel="noreferrer"
                                className="text-xs text-slate-500 hover:text-blue-600 bg-white px-2 py-1 rounded-md border border-slate-200">
                                Visit →
                              </a>
                            )}
                          </div>
                          <div className="grid grid-cols-3 gap-3">
                            <div>
                              <div className="text-[10px] uppercase text-slate-500 font-medium">Followers</div>
                              <div className="text-sm font-semibold text-slate-900 mt-0.5">{profile.followers || 'Unknown'}</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase text-slate-500 font-medium">Last Active</div>
                              <div className="text-sm font-semibold text-slate-900 mt-0.5">{profile.lastActive || 'Unknown'}</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase text-slate-500 font-medium">Last Post</div>
                              <div className="text-xs text-slate-700 mt-0.5 line-clamp-2">{profile.lastPost || 'Unknown'}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : socialMediaUrls.length > 0 ? (
                    <div className="space-y-3">
                      {socialMediaUrls.map((url: string, i: number) => (
                        <a key={i} href={url} target="_blank" rel="noreferrer"
                          className="flex items-center gap-3 p-3 border border-slate-200 rounded-xl bg-white hover:bg-slate-50 transition-colors">
                          <span className="text-xl">{platformIcon(url)}</span>
                          <span className="text-sm text-blue-600 hover:underline truncate">{url}</span>
                        </a>
                      ))}
                      <p className="text-xs text-slate-400 italic mt-2">Click "Edit Profiles" to correct URLs or add details.</p>
                    </div>
                  ) : (
                    <div className="text-center py-12 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl">
                      <Globe className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                      <p className="text-sm">No social media profiles found yet.</p>
                      <p className="text-xs mt-1">Click "Edit Profiles" to add manually, or run AI Qualify to discover them.</p>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}

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
                    <div className="text-sm text-slate-500 mb-3 flex items-center gap-2">
                      {contact.job_title || 'No title'}
                      {(() => {
                        const t = (contact.job_title || '').toLowerCase();
                        if (t.includes('maintenance') || t.includes('r&m') || t.includes('instandhaltung'))
                          return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-bold shrink-0">HIGHEST</span>;
                        if (t.includes('production') || t.includes('r&d') || t.includes('research') || t.includes('fertigung'))
                          return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 font-bold shrink-0">HIGH</span>;
                        if (t.includes('cto') || t.includes('technical director') || t.includes('owner') || t.includes('geschäftsführer') || t.includes('managing'))
                          return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-bold shrink-0">MEDIUM</span>;
                        if (t.includes('ceo') || t.includes('director') || t.includes('leiter'))
                          return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-bold shrink-0">LOW</span>;
                        if (t.includes('purchasing') || t.includes('einkauf') || t.includes('procurement'))
                          return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 font-bold shrink-0">AVOID</span>;
                        return null;
                      })()}
                    </div>
                    <div className="space-y-2 mt-auto">
                      {contact.email && <div className="flex items-center gap-2 text-sm text-slate-600"><Mail className="w-4 h-4 text-slate-400" /> <a href={`mailto:${contact.email}`} className="hover:text-blue-600">{contact.email}</a></div>}
                      {contact.phone_direct && <div className="flex items-center gap-2 text-sm text-slate-600"><Phone className="w-4 h-4 text-slate-400" /> {contact.phone_direct}</div>}
                      {contact.linkedin_url && <div className="flex items-center gap-2 text-sm text-slate-600"><Linkedin className="w-4 h-4 text-slate-400" /> <a href={contact.linkedin_url} target="_blank" rel="noreferrer" className="hover:text-blue-600">LinkedIn Profile</a></div>}
                    </div>
                    {/* Quick log actions */}
                    <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-slate-100">
                      {contact.phone_direct && (
                        <button
                          onClick={async () => {
                            const subject = prompt('Call subject:', `Call with ${contact.full_name}`);
                            if (!subject) return;
                            const outcome = prompt('Outcome (Positive/Neutral/Negative):', 'Neutral');
                            try {
                              await fetch('/api/activities', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  company_id: companyId, contact_id: contact.id,
                                  activity_type: 'CALL_MADE', activity_date: new Date().toISOString().split('T')[0],
                                  performed_by: users.find(u => u.includes('Sageer')) || users[0] || 'System',
                                  subject, details: `Called ${contact.full_name} (${contact.job_title || ''}) at ${contact.phone_direct}`,
                                  outcome: (outcome || 'NEUTRAL').toUpperCase(),
                                }),
                              });
                              showToast('success', 'Call logged', `${contact.full_name}`);
                              await fetchData();
                            } catch { showToast('error', 'Failed to log call'); }
                          }}
                          className="flex items-center gap-1 px-2 py-1 text-xs bg-green-50 text-green-700 border border-green-200 rounded-md hover:bg-green-100 transition-colors font-medium"
                        >
                          <Phone className="w-3 h-3" /> Log Call
                        </button>
                      )}
                      {contact.email && (
                        <button
                          onClick={async () => {
                            const subject = prompt('Email subject:', `Email to ${contact.full_name}`);
                            if (!subject) return;
                            try {
                              await fetch('/api/activities', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  company_id: companyId, contact_id: contact.id,
                                  activity_type: 'EMAIL_SENT', activity_date: new Date().toISOString().split('T')[0],
                                  performed_by: users.find(u => u.includes('Sageer')) || users[0] || 'System',
                                  subject, details: `Emailed ${contact.full_name} (${contact.job_title || ''}) at ${contact.email}`,
                                  outcome: 'NEUTRAL',
                                }),
                              });
                              showToast('success', 'Email logged', `${contact.full_name}`);
                              window.open(`mailto:${contact.email}?subject=${encodeURIComponent(subject)}`, '_blank');
                              await fetchData();
                            } catch { showToast('error', 'Failed to log email'); }
                          }}
                          className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors font-medium"
                        >
                          <Mail className="w-3 h-3" /> Log Email
                        </button>
                      )}
                      {contact.linkedin_url && (
                        <button
                          onClick={async () => {
                            try {
                              await fetch('/api/activities', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  company_id: companyId, contact_id: contact.id,
                                  activity_type: 'LINKEDIN_MESSAGE', activity_date: new Date().toISOString().split('T')[0],
                                  performed_by: users.find(u => u.includes('Sageer')) || users[0] || 'System',
                                  subject: `LinkedIn message to ${contact.full_name}`,
                                  details: `Sent LinkedIn message to ${contact.full_name} (${contact.job_title || ''})`,
                                  outcome: 'NEUTRAL',
                                }),
                              });
                              showToast('success', 'LinkedIn message logged', `${contact.full_name}`);
                              window.open(contact.linkedin_url, '_blank');
                              await fetchData();
                            } catch { showToast('error', 'Failed to log message'); }
                          }}
                          className="flex items-center gap-1 px-2 py-1 text-xs bg-sky-50 text-sky-700 border border-sky-200 rounded-md hover:bg-sky-100 transition-colors font-medium"
                        >
                          <Linkedin className="w-3 h-3" /> Log LinkedIn
                        </button>
                      )}
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
                      {users.map(user => (
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

        {activeTab === 'notes' && (
          <div className="flex flex-col h-full" style={{ minHeight: '480px' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-blue-500" />
                Team Notes
              </h3>
              <span className="text-xs text-slate-500">{notes.length} note{notes.length !== 1 ? 's' : ''}</span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-1" style={{ maxHeight: '380px' }}>
              {notes.length === 0 ? (
                <div className="text-center py-12 text-slate-400">
                  <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No notes yet. Be the first to add a team note.</p>
                </div>
              ) : (
                notes.map((note) => (
                  <div key={note.id} className="flex gap-3 group">
                    <div className="w-8 h-8 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                      {note.author.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-sm font-semibold text-slate-900">{note.author}</span>
                        <span className="text-xs text-slate-400">
                          {new Date(note.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="bg-slate-50 border border-slate-200 rounded-xl rounded-tl-none px-4 py-3 text-sm text-slate-700 whitespace-pre-wrap">
                        {note.message}
                      </div>
                    </div>
                  </div>
                ))
              )}
              <div ref={notesEndRef} />
            </div>

            <form onSubmit={handleAddNote} className="border-t border-slate-200 pt-4">
              <div className="flex items-center gap-2 mb-2">
                <select
                  value={noteAuthor}
                  onChange={(e) => setNoteAuthor(e.target.value)}
                  className="border border-slate-200 rounded-md px-2 py-1 text-sm bg-white text-slate-700 outline-none"
                >
                  {users.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
                <span className="text-xs text-slate-400">posting as</span>
              </div>
              <div className="flex gap-2">
                <textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleAddNote(e as any); }}}
                  placeholder="Write a team note... (Ctrl+Enter to post)"
                  rows={2}
                  className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm resize-none outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                />
                <button
                  type="submit"
                  disabled={submittingNote || !noteText.trim()}
                  className="px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1.5 text-sm font-medium shrink-0"
                >
                  <Send className="w-4 h-4" />
                  Post
                </button>
              </div>
            </form>
          </div>
        )}

        {false && activeTab === 'orders_hidden' && (
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
        </ErrorBoundary>
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
                    {regionOptions.map((option) => (
                      <option key={option.value || 'blank'} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Industry</label>
                  <select value={companyForm.industry || ''} onChange={e => setCompanyForm({...companyForm, industry: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    {industryOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Company Type</label>
                  <select value={companyForm.company_type || ''} onChange={e => setCompanyForm({...companyForm, company_type: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    {companyTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Lead Status</label>
                  <select value={companyForm.lead_status || ''} onChange={e => setCompanyForm({...companyForm, lead_status: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    {leadStatusOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Technical Fit</label>
                  <select value={companyForm.technical_fit || ''} onChange={e => setCompanyForm({...companyForm, technical_fit: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    {technicalFitOptions.map(option => (
                      <option key={option.value || 'blank'} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Assigned To</label>
                  <select value={companyForm.assigned_to || ''} onChange={e => setCompanyForm({...companyForm, assigned_to: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    <option value="">Unassigned</option>
                    {users.map(user => (
                      <option key={user} value={user}>{user}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Tracking Level</label>
                  <select value={companyForm.tracking_level || 'WATCHLIST'} onChange={e => setCompanyForm({...companyForm, tracking_level: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    {trackingLevelOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Tracking Status</label>
                  <select value={companyForm.tracking_status || 'PENDING'} onChange={e => setCompanyForm({...companyForm, tracking_status: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
                    {trackingStatusOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Next Tracking Date</label>
                  <input type="date" value={companyForm.next_tracking_date || ''} onChange={e => setCompanyForm({...companyForm, next_tracking_date: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Qualification Notes</label>
                  <textarea rows={3} value={companyForm.qualification_notes || ''} onChange={e => setCompanyForm({...companyForm, qualification_notes: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"></textarea>
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Tracking Notes</label>
                  <textarea rows={3} value={companyForm.tracking_notes || ''} onChange={e => setCompanyForm({...companyForm, tracking_notes: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"></textarea>
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

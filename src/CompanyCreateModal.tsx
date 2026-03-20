import React from 'react';
import {
  companyTypeOptions,
  industryOptions,
  leadStatusOptions,
  regionOptions,
  technicalFitOptions,
  trackingLevelOptions,
  trackingStatusOptions,
} from './companyData';

export interface CompanyFormData {
  assigned_to: string;
  city: string;
  company_name: string;
  company_type: string;
  country: string;
  employee_count: string;
  industry: string;
  lead_status: string;
  qualification_notes: string;
  region: string;
  revenue_eur: string;
  technical_fit: string;
  tracking_level: string;
  tracking_notes: string;
  tracking_status: string;
  next_tracking_date: string;
  website: string;
}

export const emptyCompanyForm: CompanyFormData = {
  assigned_to: '',
  city: '',
  company_name: '',
  company_type: 'BEARING_TRADER',
  country: '',
  employee_count: '',
  industry: 'BEARING_TRADER',
  lead_status: 'RAW',
  qualification_notes: '',
  region: '',
  revenue_eur: '',
  technical_fit: '',
  tracking_level: 'WATCHLIST',
  tracking_notes: '',
  tracking_status: 'PENDING',
  next_tracking_date: '',
  website: '',
};

interface CompanyCreateModalProps {
  form: CompanyFormData;
  onChange: (nextForm: CompanyFormData) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
  open: boolean;
  submitting: boolean;
  users: string[];
}

export default function CompanyCreateModal({
  form,
  onChange,
  onClose,
  onSubmit,
  open,
  submitting,
  users,
}: CompanyCreateModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Add Company</h2>
            <p className="text-sm text-slate-500 mt-1">Create a manual lead and open it directly in the company workspace.</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700 text-2xl leading-none">
            &times;
          </button>
        </div>

        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company Name</label>
              <input
                type="text"
                required
                value={form.company_name}
                onChange={(event) => onChange({ ...form, company_name: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Website</label>
              <input
                type="text"
                value={form.website}
                onChange={(event) => onChange({ ...form, website: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Country</label>
              <input
                type="text"
                required
                value={form.country}
                onChange={(event) => onChange({ ...form, country: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">City</label>
              <input
                type="text"
                value={form.city}
                onChange={(event) => onChange({ ...form, city: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Region</label>
              <select
                value={form.region}
                onChange={(event) => onChange({ ...form, region: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
              >
                {regionOptions.map((option) => (
                  <option key={option.value || 'blank'} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Industry</label>
              <select
                value={form.industry}
                onChange={(event) => onChange({ ...form, industry: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
              >
                {industryOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company Type</label>
              <select
                value={form.company_type}
                onChange={(event) => onChange({ ...form, company_type: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
              >
                {companyTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Lead Status</label>
              <select
                value={form.lead_status}
                onChange={(event) => onChange({ ...form, lead_status: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
              >
                {leadStatusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Technical Fit</label>
              <select
                value={form.technical_fit}
                onChange={(event) => onChange({ ...form, technical_fit: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
              >
                {technicalFitOptions.map((option) => (
                  <option key={option.value || 'blank'} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Assigned To</label>
              <select
                value={form.assigned_to}
                onChange={(event) => onChange({ ...form, assigned_to: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
              >
                <option value="">Unassigned</option>
                {users.map((user) => (
                  <option key={user} value={user}>
                    {user}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Employee Count</label>
              <input
                type="number"
                min="0"
                value={form.employee_count}
                onChange={(event) => onChange({ ...form, employee_count: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Revenue (EUR)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.revenue_eur}
                onChange={(event) => onChange({ ...form, revenue_eur: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Qualification Notes</label>
              <textarea
                rows={3}
                value={form.qualification_notes}
                onChange={(event) => onChange({ ...form, qualification_notes: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Tracking Level</label>
              <select
                value={form.tracking_level}
                onChange={(event) => onChange({ ...form, tracking_level: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
              >
                {trackingLevelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Tracking Status</label>
              <select
                value={form.tracking_status}
                onChange={(event) => onChange({ ...form, tracking_status: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
              >
                {trackingStatusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Next Tracking Date</label>
              <input
                type="date"
                value={form.next_tracking_date}
                onChange={(event) => onChange({ ...form, next_tracking_date: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Tracking Notes</label>
              <textarea
                rows={3}
                value={form.tracking_notes}
                onChange={(event) => onChange({ ...form, tracking_notes: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
                placeholder="How closely should this company be monitored and why?"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-md font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md font-medium transition-colors disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Create Company'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

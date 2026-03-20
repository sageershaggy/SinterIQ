import React from 'react';
import { Building2, CalendarClock, Target } from 'lucide-react';
import { Company } from './appTypes';
import { getDateOnly } from './formatters';

function TrackingSection({
  companies,
  onCompanyClick,
  title,
  tone,
}: {
  companies: Company[];
  onCompanyClick: (id: number) => void;
  title: string;
  tone: string;
}) {
  if (companies.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <h2 className={`text-lg font-semibold ${tone}`}>{title} ({companies.length})</h2>
      <div className="space-y-3">
        {companies.map((company) => (
          <div key={company.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:border-blue-300 transition-colors">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <button
                  onClick={() => onCompanyClick(company.id)}
                  className="text-left font-semibold text-slate-900 hover:text-blue-600 hover:underline"
                >
                  {company.company_name}
                </button>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                    {company.tracking_level || 'Watchlist'}
                  </span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                    {company.tracking_status || 'Pending'}
                  </span>
                  <span className="inline-flex items-center gap-1 text-slate-500">
                    <Building2 className="w-3.5 h-3.5" />
                    {company.city ? `${company.city}, ` : ''}{company.country}
                  </span>
                </div>
                <p className="text-sm text-slate-600">{company.tracking_notes || 'No company-level tracking notes yet.'}</p>
              </div>
              <div className="text-right shrink-0">
                <div className="text-xs text-slate-500 uppercase font-medium">Next Tracking</div>
                <div className="text-sm font-semibold text-slate-900 mt-1">
                  {company.next_tracking_date ? new Date(company.next_tracking_date).toLocaleDateString() : 'Not scheduled'}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TrackingTab({
  companies,
  onCompanyClick,
}: {
  companies: Company[];
  onCompanyClick: (id: number) => void;
}) {
  const today = getDateOnly(new Date().toISOString());
  const trackedCompanies = companies.filter(
    (company) =>
      Boolean(company.next_tracking_date)
      || Boolean(company.tracking_notes)
      || (company.tracking_level && company.tracking_level !== 'WATCHLIST')
      || (company.tracking_status && company.tracking_status !== 'PENDING'),
  );
  const overdue = trackedCompanies.filter(
    (company) => company.next_tracking_date && getDateOnly(company.next_tracking_date) < today,
  );
  const dueToday = trackedCompanies.filter(
    (company) => company.next_tracking_date && getDateOnly(company.next_tracking_date) === today,
  );
  const upcoming = trackedCompanies.filter(
    (company) => company.next_tracking_date && getDateOnly(company.next_tracking_date) > today,
  );
  const unscheduled = trackedCompanies.filter((company) => !company.next_tracking_date);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Company Tracking</h1>
          <p className="text-sm text-slate-500 mt-1">Track account-level follow-through separate from contact activity.</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm text-right">
          <div className="text-xs uppercase tracking-wide text-slate-500">Tracked Companies</div>
          <div className="text-2xl font-bold text-slate-900">{trackedCompanies.length}</div>
        </div>
      </div>

      {trackedCompanies.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center shadow-sm">
          <Target className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-slate-900 mb-1">No tracking plans yet</h3>
          <p className="text-slate-500">Set tracking fields on a company to start managing account-level follow-through.</p>
        </div>
      ) : (
        <>
          <TrackingSection companies={overdue} onCompanyClick={onCompanyClick} title="Overdue" tone="text-red-600" />
          <TrackingSection companies={dueToday} onCompanyClick={onCompanyClick} title="Due Today" tone="text-orange-600" />
          <TrackingSection companies={upcoming} onCompanyClick={onCompanyClick} title="Upcoming" tone="text-blue-600" />

          {unscheduled.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-slate-700">Unscheduled ({unscheduled.length})</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {unscheduled.map((company) => (
                  <button
                    key={company.id}
                    onClick={() => onCompanyClick(company.id)}
                    className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm text-left hover:border-blue-300 transition-colors"
                  >
                    <div className="font-semibold text-slate-900">{company.company_name}</div>
                    <div className="text-xs text-slate-500 mt-1 flex items-center gap-1">
                      <CalendarClock className="w-3.5 h-3.5" />
                      No next tracking date
                    </div>
                    <div className="mt-3 text-sm text-slate-600">{company.tracking_notes || 'Tracking notes not set.'}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

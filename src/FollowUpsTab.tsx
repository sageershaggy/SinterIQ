import React, { useEffect, useState } from 'react';
import { CalendarClock, Building2, User, CheckCircle2, Clock, AlarmClock, Filter, X } from 'lucide-react';
import { getDateOnly } from './formatters';

interface FollowUp {
  id: number;
  company_id: number;
  company_name: string;
  activity_type: string;
  activity_date: string;
  performed_by: string;
  subject: string;
  details: string;
  follow_up_date: string;
  follow_up_done: number;
}

export default function FollowUpsTab({
  onCompanyClick,
  onChange,
}: {
  onCompanyClick: (id: number) => void;
  onChange?: (followUps: FollowUp[]) => void;
}) {
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [assignedFilter, setAssignedFilter] = useState('all');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [snoozingId, setSnoozingId] = useState<number | null>(null);

  const fetchFollowUps = async () => {
    try {
      const res = await fetch('/api/activities/follow-ups');
      if (res.ok) {
        const data = await res.json();
        setFollowUps(data);
        onChange?.(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchFollowUps(); }, []);

  const handleMarkDone = async (id: number) => {
    try {
      await fetch(`/api/activities/${id}/done`, { method: 'PUT' });
      void fetchFollowUps();
    } catch (err) {
      console.error(err);
    }
  };

  const handleSnooze = async (id: number, days: number) => {
    setSnoozingId(null);
    try {
      await fetch(`/api/activities/${id}/snooze`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }),
      });
      void fetchFollowUps();
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return <div className="p-8 text-center text-slate-500">Loading follow-ups...</div>;

  const today = getDateOnly(new Date().toISOString());

  // Get unique assignees
  const assignees = Array.from(new Set(followUps.map(f => f.performed_by).filter(Boolean)));

  // Filter
  const filtered = followUps.filter(f => {
    if (f.follow_up_done) return false;
    if (assignedFilter !== 'all' && f.performed_by !== assignedFilter) return false;
    if (overdueOnly && getDateOnly(f.follow_up_date) >= today) return false;
    return true;
  });

  const overdue = filtered.filter(f => getDateOnly(f.follow_up_date) < today);
  const dueToday = filtered.filter(f => getDateOnly(f.follow_up_date) === today);
  const upcoming = filtered.filter(f => getDateOnly(f.follow_up_date) > today);

  const renderCard = (f: FollowUp) => {
    const isOverdue = getDateOnly(f.follow_up_date) < today;
    return (
      <div key={f.id} className={`bg-white border rounded-xl p-4 shadow-sm flex items-start justify-between group transition-colors ${
        isOverdue ? 'border-red-200 hover:border-red-300' : 'border-slate-200 hover:border-blue-300'
      }`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <button
              className="text-sm font-medium text-slate-900 hover:text-blue-600 hover:underline truncate"
              onClick={() => onCompanyClick(f.company_id)}
            >
              {f.company_name}
            </button>
            <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full shrink-0">{f.activity_type}</span>
            {isOverdue && (
              <span className="text-xs text-red-600 bg-red-50 px-2 py-0.5 rounded-full font-medium shrink-0">
                {Math.ceil((new Date(today).getTime() - new Date(f.follow_up_date).getTime()) / 86400000)}d overdue
              </span>
            )}
          </div>
          <h3 className="text-base font-medium text-slate-800 mb-1 truncate">{f.subject}</h3>
          {f.details && <p className="text-sm text-slate-600 mb-2 line-clamp-2">{f.details}</p>}
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <CalendarClock className="w-3.5 h-3.5" />
              Due: {new Date(f.follow_up_date).toLocaleDateString()}
            </span>
            <span className="flex items-center gap-1">
              <User className="w-3.5 h-3.5" /> {f.performed_by}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 ml-3 shrink-0">
          {/* Snooze dropdown */}
          <div className="relative">
            <button
              onClick={() => setSnoozingId(snoozingId === f.id ? null : f.id)}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-50 hover:bg-amber-50 text-slate-600 hover:text-amber-700 border border-slate-200 hover:border-amber-200 rounded-md text-xs font-medium transition-colors"
              title="Snooze follow-up"
            >
              <AlarmClock className="w-3.5 h-3.5" />
              Snooze
            </button>
            {snoozingId === f.id && (
              <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-20 py-1 min-w-[140px]">
                {[
                  { label: '1 day', days: 1 },
                  { label: '2 days', days: 2 },
                  { label: '3 days', days: 3 },
                  { label: '1 week', days: 7 },
                  { label: '2 weeks', days: 14 },
                  { label: '1 month', days: 30 },
                ].map(opt => (
                  <button
                    key={opt.days}
                    onClick={() => void handleSnooze(f.id, opt.days)}
                    className="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-amber-50 hover:text-amber-700 transition-colors"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => void handleMarkDone(f.id)}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-50 hover:bg-green-50 text-slate-600 hover:text-green-700 border border-slate-200 hover:border-green-200 rounded-md text-xs font-medium transition-colors"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Done
          </button>
        </div>
      </div>
    );
  };

  const renderSection = (list: FollowUp[], title: string, colorClass: string, icon: React.ReactNode) => {
    if (list.length === 0) return null;
    return (
      <div className="mb-6">
        <h2 className={`text-base font-semibold mb-3 flex items-center gap-2 ${colorClass}`}>
          {icon} {title} ({list.length})
        </h2>
        <div className="space-y-2">
          {list.map(renderCard)}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Follow-ups Queue</h1>
          <p className="text-sm text-slate-500 mt-1">{filtered.length} pending follow-ups</p>
        </div>
        <div className="text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2">
          To add a follow-up, log an activity on any company's <strong>Activity History</strong> tab and set a follow-up date.
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Filter className="w-4 h-4 text-slate-400" />
          <select
            value={assignedFilter}
            onChange={e => setAssignedFilter(e.target.value)}
            className="bg-white border border-slate-300 rounded-md px-3 py-1.5 text-sm"
          >
            <option value="all">All Assignees</option>
            {assignees.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <button
          onClick={() => setOverdueOnly(!overdueOnly)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
            overdueOnly
              ? 'bg-red-50 text-red-700 border-red-200'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          Overdue only
        </button>
        {(assignedFilter !== 'all' || overdueOnly) && (
          <button
            onClick={() => { setAssignedFilter('all'); setOverdueOnly(false); }}
            className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
          >
            <X className="w-3 h-3" /> Clear filters
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center shadow-sm">
          <CheckCircle2 className="w-12 h-12 text-green-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-slate-900 mb-1">All caught up!</h3>
          <p className="text-slate-500">
            {followUps.length > 0
              ? 'No follow-ups match the current filters.'
              : 'You have no pending follow-ups.'}
          </p>
        </div>
      ) : (
        <>
          {renderSection(overdue, 'Overdue', 'text-red-600', <Clock className="w-5 h-5" />)}
          {renderSection(dueToday, 'Due Today', 'text-orange-600', <Clock className="w-5 h-5" />)}
          {renderSection(upcoming, 'Upcoming', 'text-blue-600', <CalendarClock className="w-5 h-5" />)}
        </>
      )}
    </div>
  );
}

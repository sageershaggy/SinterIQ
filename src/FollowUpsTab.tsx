import React, { useEffect, useState } from 'react';
import { CalendarClock, Building2, User, CheckCircle2, Clock } from 'lucide-react';
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

  useEffect(() => {
    fetchFollowUps();
  }, []);

  const handleMarkDone = async (id: number) => {
    try {
      await fetch(`/api/activities/${id}/done`, { method: 'PUT' });
      fetchFollowUps();
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return <div className="p-8 text-center text-slate-500">Loading follow-ups...</div>;

  const today = getDateOnly(new Date().toISOString());
  
  const overdue = followUps.filter(f => getDateOnly(f.follow_up_date) < today && !f.follow_up_done);
  const dueToday = followUps.filter(f => getDateOnly(f.follow_up_date) === today && !f.follow_up_done);
  const upcoming = followUps.filter(f => getDateOnly(f.follow_up_date) > today && !f.follow_up_done);

  const renderList = (list: FollowUp[], title: string, colorClass: string, icon: React.ReactNode) => {
    if (list.length === 0) return null;
    
    return (
      <div className="mb-8">
        <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${colorClass}`}>
          {icon}
          {title} ({list.length})
        </h2>
        <div className="space-y-3">
          {list.map(f => (
            <div key={f.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex items-start justify-between group hover:border-blue-300 transition-colors">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-slate-900 cursor-pointer hover:text-blue-600 hover:underline" onClick={() => onCompanyClick(f.company_id)}>
                    {f.company_name}
                  </span>
                  <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">{f.activity_type}</span>
                </div>
                <h3 className="text-base font-medium text-slate-800 mb-1">{f.subject}</h3>
                <p className="text-sm text-slate-600 mb-3 line-clamp-2">{f.details}</p>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><CalendarClock className="w-3.5 h-3.5" /> Due: {new Date(f.follow_up_date).toLocaleDateString()}</span>
                  <span className="flex items-center gap-1"><User className="w-3.5 h-3.5" /> {f.performed_by}</span>
                </div>
              </div>
              <button 
                onClick={() => handleMarkDone(f.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-green-50 text-slate-600 hover:text-green-700 border border-slate-200 hover:border-green-200 rounded-md text-sm font-medium transition-colors whitespace-nowrap"
              >
                <CheckCircle2 className="w-4 h-4" />
                Mark Done
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Follow-ups Queue</h1>
      </div>

      {followUps.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center shadow-sm">
          <CheckCircle2 className="w-12 h-12 text-green-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-slate-900 mb-1">All caught up!</h3>
          <p className="text-slate-500">You have no pending follow-ups.</p>
        </div>
      ) : (
        <>
          {renderList(overdue, 'Overdue', 'text-red-600', <Clock className="w-5 h-5" />)}
          {renderList(dueToday, 'Due Today', 'text-orange-600', <Clock className="w-5 h-5" />)}
          {renderList(upcoming, 'Upcoming', 'text-blue-600', <CalendarClock className="w-5 h-5" />)}
        </>
      )}
    </div>
  );
}

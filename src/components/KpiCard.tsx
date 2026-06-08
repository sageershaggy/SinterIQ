import React from 'react';

// Shared KPI stat card. Previously redefined (with slightly different tone maps)
// in ReviewQueueTab, NotATargetTab, and GccMarketingTab. Pass `onClick` to make
// it an interactive filter toggle (with an active ring), otherwise it renders as
// a static card.

export type KpiTone = 'slate' | 'rose' | 'amber' | 'emerald' | 'violet' | 'sky';

const TONES: Record<KpiTone, { base: string; activeRing: string }> = {
  slate: { base: 'bg-slate-50 text-slate-700 border-slate-200', activeRing: 'ring-2 ring-slate-400 border-slate-400' },
  rose: { base: 'bg-rose-50 text-rose-700 border-rose-200', activeRing: 'ring-2 ring-rose-400 border-rose-400' },
  amber: { base: 'bg-amber-50 text-amber-700 border-amber-200', activeRing: 'ring-2 ring-amber-400 border-amber-400' },
  emerald: { base: 'bg-emerald-50 text-emerald-700 border-emerald-200', activeRing: 'ring-2 ring-emerald-400 border-emerald-400' },
  violet: { base: 'bg-violet-50 text-violet-700 border-violet-200', activeRing: 'ring-2 ring-violet-400 border-violet-400' },
  sky: { base: 'bg-sky-50 text-sky-700 border-sky-200', activeRing: 'ring-2 ring-sky-400 border-sky-400' },
};

interface KpiCardProps {
  label: string;
  value: number | string;
  icon?: React.ReactNode;
  tone?: KpiTone;
  active?: boolean;
  onClick?: () => void;
}

export default function KpiCard({ label, value, icon, tone = 'slate', active, onClick }: KpiCardProps) {
  const t = TONES[tone];
  const className = `text-left border rounded-xl p-3 transition-all ${t.base} ${onClick ? 'hover:brightness-95 cursor-pointer' : 'cursor-default'} ${active ? t.activeRing : ''}`;
  const content = (
    <>
      <div className="flex items-center gap-2 text-xs font-medium opacity-80">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={active} className={className}>
        {content}
      </button>
    );
  }
  return <div className={className}>{content}</div>;
}

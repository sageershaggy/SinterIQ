// Shared Tailwind class maps for lead status / priority badges, previously
// duplicated as inline if-chains across AppRoot, ReviewQueueTab, CompanyDetail.

export function leadPriorityBadgeClass(priority?: string | null): string {
  switch (priority) {
    case 'HIGH_PRIORITY':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'STRONG':
      return 'bg-sky-50 text-sky-700 border-sky-200';
    case 'LOW_PRIORITY':
      return 'bg-slate-50 text-slate-600 border-slate-200';
    default: // NOT_A_TARGET / unknown
      return 'bg-rose-50 text-rose-700 border-rose-200';
  }
}

export function leadStatusBadgeClass(status?: string | null): string {
  switch (status) {
    case 'WON':
    case 'APPROVED':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'QUALIFIED':
    case 'OPPORTUNITY':
      return 'bg-violet-50 text-violet-700 border-violet-200';
    case 'IN_OUTREACH':
    case 'CONTACTED':
      return 'bg-sky-50 text-sky-700 border-sky-200';
    case 'ENRICHED':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'DISQUALIFIED':
    case 'LOST':
      return 'bg-rose-50 text-rose-700 border-rose-200';
    default: // RAW / unknown
      return 'bg-slate-50 text-slate-600 border-slate-200';
  }
}

export const leadTabs = [
  'overview',
  'reasoning',
  'evidence',
  'history',
  'feedback',
  'calls',
  'email',
  'campaigns',
] as const;
export type LeadTab = (typeof leadTabs)[number];
export type View =
  | 'projects'
  | 'overview'
  | 'training'
  | 'leads'
  | 'review'
  | 'funnels'
  | 'activity'
  | 'settings'
  | 'mailbox';
const views: View[] = [
  'projects',
  'overview',
  'training',
  'leads',
  'review',
  'funnels',
  'activity',
  'settings',
  // A mailbox belongs to a project, so it is only ever reachable under one.
  'mailbox',
];
export function readRoute(hash = window.location.hash): {
  view: View;
  projectId: number | null;
  leadId: number | null;
  tab: LeadTab;
} {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] !== 'projects' || !/^[1-9]\d*$/.test(parts[1] || ''))
    return {
      view: parts[0] === 'settings' ? 'settings' : 'projects',
      projectId: null,
      leadId: null,
      tab: 'overview',
    };
  const view = views.includes(parts[2] as View) ? (parts[2] as View) : 'overview';
  return {
    view,
    projectId: Number(parts[1]),
    leadId:
      (view === 'leads' || view === 'review') && /^[1-9]\d*$/.test(parts[3] || '')
        ? Number(parts[3])
        : null,
    tab: leadTabs.includes(parts[4] as LeadTab) ? (parts[4] as LeadTab) : 'overview',
  };
}
export function leadLink(
  projectId: number,
  leadId: number,
  tab: LeadTab = 'overview',
  queue = false,
) {
  return `#projects/${projectId}/${queue ? 'review' : 'leads'}/${leadId}/${tab}`;
}

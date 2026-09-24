/**
 * Where a notification points. A lead notification opens that lead; a project notification is
 * about the project as a whole — training published, a new training draft, an import.
 */
export type NotificationScope = 'lead' | 'project';

/** Project-level update kinds, each of which opens a fixed screen of its project. */
export const projectNotificationKinds = [
  'training_published',
  'training_draft',
  'leads_imported',
] as const;
export type ProjectNotificationKind = (typeof projectNotificationKinds)[number];

/**
 * One row of the updates panel. Identical notifications — same project, lead, kind and title —
 * arrive as one row with a count, so four analyses that each said "needs review" read once.
 */
export interface NotificationItem {
  /** Newest notification in the group. Ids are unique only within a scope. */
  id: number;
  scope: NotificationScope;
  project_id: number;
  project_name: string;
  lead_id: number | null;
  kind: string;
  title: string;
  /** Newest occurrence. */
  created_at: string;
  /** Oldest occurrence gathered into this row. */
  first_at: string;
  count: number;
  /** How many of the gathered notifications are still unread. */
  unread: number;
  /** Null while anything in the group is unread. */
  read_at: string | null;
}
export interface NotificationFeed {
  items: NotificationItem[];
  /** Unread rows as the panel shows them, so a group of four counts once. */
  unread: number;
}

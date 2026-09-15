export interface IncomingSettings {
  host: string;
  username: string;
  folder: string;
  enabled: boolean;
  has_password: boolean;
  revision: number;
  last_sync: string;
  last_error: string;
}
export interface IncomingMessage {
  id: number;
  project_id: number | null;
  lead_id: number | null;
  company: string | null;
  from_email: string;
  from_name: string;
  to_email: string;
  subject: string;
  body: string;
  received_at: string;
  read_at: string | null;
  attachment_count: number;
  notice: string;
}
export type MailFolder = 'inbox' | 'outbox' | 'sent' | 'drafts';
export interface MailRow {
  id: number;
  kind: 'incoming' | 'outgoing' | 'queue' | 'draft';
  project_id: number | null;
  lead_id: number | null;
  company: string | null;
  address: string;
  subject: string;
  body: string;
  status: string;
  timestamp: string;
  notice: string;
}
export interface MailPage {
  items: MailRow[];
  total: number;
  counts: Record<MailFolder, number>;
  incoming: IncomingSettings;
  outgoing_configured: boolean;
}

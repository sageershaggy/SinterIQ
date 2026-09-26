/**
 * Deleting a whole project (server/project-delete.ts). The summary is what the confirmation
 * dialog shows before anything happens; the result is what the server did.
 */
export interface ProjectDeletionSummary {
  project_id: number;
  name: string;
  counts: {
    /** Every lead, archived ones included. */
    leads: number;
    archived_leads: number;
    sources: number;
    training_versions: number;
    runs: number;
    emails: number;
    calls: number;
    comments: number;
    campaigns: number;
    /** Campaign sequences still due to send; they stop with the project. */
    queued_sequences: number;
    contacts: number;
    members: number;
    incoming_messages: number;
  };
  /** A mailbox row exists (sending or incoming settings were saved). */
  mailbox: boolean;
}
export interface ProjectDeletionResult {
  deleted: true;
  name: string;
  /** Path of the safety snapshot, relative to the server's data directory. */
  snapshot: string;
  /** Rows removed, per table. */
  removed: Record<string, number>;
}

import type { EmailFile } from '../shared/email';
import { api } from './api';

/** Mirrors the server's limits so a file that cannot be sent is refused before it uploads. */
export const emailFileLimits = {
  perFile: 10 * 1024 * 1024,
  perMessage: 20 * 1024 * 1024,
  count: 10,
};
export const attachmentAccept =
  '.pdf,.docx,.xlsx,.pptx,.csv,.txt,.png,.jpg,.jpeg,application/pdf,text/csv,text/plain,image/png,image/jpeg';
export function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
export async function uploadEmailFile(
  projectId: number,
  file: File,
  kind: 'attachment' | 'image',
): Promise<EmailFile> {
  if (file.size > emailFileLimits.perFile)
    throw new Error(file.name + ' is larger than 10 MB, the most one file can be.');
  const data = new FormData();
  data.set('kind', kind);
  data.set('file', file);
  return api<EmailFile>('/projects/' + projectId + '/email/files', { method: 'POST', body: data });
}
export const fileUrl = (projectId: number, id: number) =>
  '/api/projects/' + projectId + '/email/files/' + id;

import type { EmailSettings } from './types';

/**
 * What a project's sending mailbox still lacks, in the words the settings form uses. It mirrors
 * the server's own test (getEmailConfig().configured: host, sender address and a saved password),
 * so "Not configured" can always say why instead of leaving the user to guess which box is empty.
 */
export function sendingGaps(
  settings: Pick<EmailSettings, 'host' | 'from_email' | 'has_password'>,
): string[] {
  const gaps: string[] = [];
  if (!settings.host) gaps.push('SMTP host missing');
  if (!settings.from_email) gaps.push('Sender address missing');
  if (!settings.has_password) gaps.push('Password missing');
  return gaps;
}

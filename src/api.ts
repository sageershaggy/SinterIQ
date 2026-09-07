import type { User } from '../shared/types';
let csrfToken = '';
export interface Session {
  user: User | null;
  csrf_token: string;
  setup_required: boolean;
}
export function setSession(session: Session) {
  csrfToken = session.csrf_token;
}
export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-Requested-With', 'Innovista');
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch('/api' + url, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  const data = await response
    .json()
    .catch(() => ({ error: 'The server returned an unreadable response.' }));
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith('/auth/'))
      window.dispatchEvent(new Event('innovista:session-expired'));
    throw new Error(data.error || 'The request failed. Please retry.');
  }
  return data as T;
}
export const json = (body: unknown) => JSON.stringify(body);
export const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
export const label = (value: string) =>
  value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
export const safeHref = (value: string) => {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
};

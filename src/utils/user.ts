// Centralized access to the current user, previously re-parsed from
// localStorage with inline try/catch in ~7 places.

interface StoredUser {
  name?: string;
  role?: string;
}

function readStoredUser(): StoredUser {
  try {
    const stored = localStorage.getItem('sinteriq_user');
    const parsed = stored ? JSON.parse(stored) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getCurrentUserName(fallback = 'Unknown'): string {
  return readStoredUser().name || fallback;
}

export function getCurrentUserRole(): string {
  return readStoredUser().role || '';
}

/** Mirror of the server-side admin predicate (server.ts isAdminUser). */
export function isAdminUser(): boolean {
  const name = getCurrentUserName('').toLowerCase();
  return name.includes('sageer') || name.includes('admin');
}

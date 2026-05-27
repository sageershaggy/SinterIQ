import { StrictMode, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import AppRoot from './AppRoot.tsx';
import LoginScreen from './LoginScreen.tsx';
import ToastContainer from './Toast.tsx';
import './index.css';

// Install a global fetch wrapper that:
//   1. Attaches X-User-Name from localStorage to every /api/* request (legacy
//      backward-compat — server now prefers the session cookie).
//   2. Detects 401 responses on /api/* and forces a logout so the UI doesn't
//      silently fail in a half-authenticated state after the session expires.
const originalFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const isApiCall = typeof url === 'string' && (url.startsWith('/api/') || url.startsWith('http://localhost:3000/api/'));

  let resolvedInit = init;
  if (isApiCall) {
    try {
      const stored = localStorage.getItem('sinteriq_user');
      const name = stored ? JSON.parse(stored)?.name : null;
      if (name) {
        const headers = new Headers(init?.headers);
        if (!headers.has('X-User-Name')) headers.set('X-User-Name', name);
        resolvedInit = { ...init, headers };
      }
    } catch {}
  }

  const response = await originalFetch(input, resolvedInit);

  // Session expired mid-flight — bounce to LoginScreen.
  // Excludes /api/auth/me (probing endpoint, expected to 401) and the login
  // endpoint itself (caller handles errors).
  if (isApiCall && response.status === 401 && typeof url === 'string'
      && !url.includes('/api/auth/me')
      && !url.includes('/api/auth/login')) {
    const logout = (window as any).sinteriqLogout;
    if (typeof logout === 'function') logout();
  }

  return response;
}) as typeof window.fetch;

function App() {
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Server is the source of truth — verify the session cookie before showing
  // AppRoot. localStorage alone can be forged or stale, so we always
  // round-trip /api/auth/me on boot.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (cancelled) return;
        if (res.ok) {
          const payload = await res.json().catch(() => null);
          if (payload?.user?.name) {
            setCurrentUser(payload.user.name);
            // Keep localStorage mirror in sync for the X-User-Name header.
            localStorage.setItem('sinteriq_user', JSON.stringify({
              name: payload.user.name,
              role: payload.user.role || '',
              loginAt: new Date().toISOString(),
            }));
          }
        } else {
          // Stale session — clear local mirror.
          localStorage.removeItem('sinteriq_user');
        }
      } catch {
        // Network failure on boot — fall back to localStorage so offline
        // editing of the UI still works during dev.
        const stored = localStorage.getItem('sinteriq_user');
        if (stored && !cancelled) {
          try {
            const parsed = JSON.parse(stored);
            if (parsed?.name) setCurrentUser(parsed.name);
          } catch {}
        }
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleLogout = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem('sinteriq_user');
    setCurrentUser(null);
  };

  // Expose logout globally so AppRoot's sidebar can call it without prop drilling.
  // Simpler than threading the callback through every consumer.
  (window as any).sinteriqLogout = handleLogout;

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-8 h-8 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (!currentUser) {
    return (
      <>
        <LoginScreen onLogin={(name) => setCurrentUser(name)} />
        <ToastContainer />
      </>
    );
  }

  return (
    <>
      <AppRoot />
      <ToastContainer />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

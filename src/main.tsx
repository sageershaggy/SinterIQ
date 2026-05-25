import { StrictMode, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import AppRoot from './AppRoot.tsx';
import LoginScreen from './LoginScreen.tsx';
import ToastContainer from './Toast.tsx';
import './index.css';

// Install a global fetch wrapper that auto-attaches X-User-Name from localStorage
// to every /api/* request. The backend uses this to record created_by, updated_by,
// disqualified_by, etc. — replaces the previous hardcoded "Sageer A. Shaikh".
const originalFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (typeof url === 'string' && (url.startsWith('/api/') || url.startsWith('http://localhost:3000/api/'))) {
    try {
      const stored = localStorage.getItem('sinteriq_user');
      const name = stored ? JSON.parse(stored)?.name : null;
      if (name) {
        const headers = new Headers(init?.headers);
        if (!headers.has('X-User-Name')) headers.set('X-User-Name', name);
        return originalFetch(input, { ...init, headers });
      }
    } catch {
      // fall through to original fetch
    }
  }
  return originalFetch(input, init);
}) as typeof window.fetch;

function App() {
  const [currentUser, setCurrentUser] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('sinteriq_user');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed?.name) setCurrentUser(parsed.name);
      } catch (e) {}
    }
  }, []);

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

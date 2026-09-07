import { StrictMode, useEffect, useState, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, setSession, type Session } from './api';
import { Brand, Spinner, Alert } from './ui';
import { Login } from './Login';
import App from './App';
import './index.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="boot">
        <Brand />
        <Alert>The workspace could not be displayed. Your saved data is safe.</Alert>
        <button className="button primary" onClick={() => location.reload()}>
          Reload workspace
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Root() {
  const [session, updateSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const loaded = (s: Session) => {
    setSession(s);
    updateSession(s);
  };
  const boot = () => {
    setError('');
    api<Session>('/auth/me')
      .then(loaded)
      .catch(() => setError('Cannot connect to the server. Check the connection and retry.'));
  };
  useEffect(() => {
    boot();
    const expired = () => loaded({ user: null, csrf_token: '', setup_required: false });
    window.addEventListener('innovista:session-expired', expired);
    return () => window.removeEventListener('innovista:session-expired', expired);
  }, []);
  if (error)
    return (
      <div className="boot">
        <Brand />
        <Alert>{error}</Alert>
        <button className="button" onClick={boot}>
          Retry connection
        </button>
      </div>
    );
  if (!session)
    return (
      <div className="boot">
        <Brand />
        <Spinner text="Opening your research workspace" />
      </div>
    );
  if (!session.user) return <Login onLogin={loaded} />;
  return (
    <App
      user={session.user}
      onLogout={async () => {
        await api('/auth/logout', { method: 'POST' });
        loaded({ user: null, csrf_token: '', setup_required: false });
      }}
    />
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);

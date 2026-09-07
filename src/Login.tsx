import { useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Fingerprint, ScanLine } from 'lucide-react';
import { api, json, type Session } from './api';
import { Brand, Alert, Spinner } from './ui';

export function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      onLogin(
        await api<Session>('/auth/login', {
          method: 'POST',
          body: json(data),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <section className="login-story">
        <Brand />
        <div>
          <span className="eyebrow light">THE RESEARCH WORKSPACE</span>
          <h1>
            Better context.
            <br />
            Clearer decisions.
          </h1>
          <p>Turn what you know about your business into research you can act on.</p>
          <div className="login-features">
            <span>
              <BookOpen />
              Train with your knowledge
            </span>
            <span>
              <ScanLine />
              Qualify with evidence
            </span>
            <span>
              <Fingerprint />
              Keep every decision traceable
            </span>
          </div>
        </div>
        <small>Innovista Research AI · Your research, in context.</small>
      </section>
      <section className="login-form">
        <div className="login-mobile-brand">
          <Brand />
        </div>
        <span className="eyebrow">LET’S GET TO WORK</span>
        <h2>Sign in</h2>
        <p className="muted">Welcome to Innovista Research AI.</p>
        <form onSubmit={submit}>
          <label>
            Username
            <input name="username" required maxLength={60} autoComplete="username" autoFocus />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              maxLength={128}
              autoComplete="current-password"
            />
          </label>
          {error && <Alert>{error}</Alert>}
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Spinner text="Please wait…" />
            ) : (
              <>
                Sign in
                <ArrowRight size={17} />
              </>
            )}
          </button>
        </form>
        <p className="fine-print">
          Your session is protected. Project access is shared with your workspace team.
        </p>
      </section>
    </div>
  );
}

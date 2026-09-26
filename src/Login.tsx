import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRight, BookOpen, Fingerprint, ScanLine, ShieldCheck, Users } from 'lucide-react';
import { api, json, type Session } from './api';
import { Brand, Alert, Spinner } from './ui';
import './Login.css';

/** Administrator, or Guest for team members (the researcher role). Checked by the server. */
type Portal = 'admin' | 'guest';
const portals: Array<{ id: Portal; label: string; hint: string; icon: typeof ShieldCheck }> = [
  {
    id: 'admin',
    label: 'Administrator',
    hint: 'For workspace administrators: projects, team access and mailboxes.',
    icon: ShieldCheck,
  },
  {
    id: 'guest',
    label: 'Guest',
    hint: 'For team members researching the projects assigned to them.',
    icon: Users,
  },
];
const PORTAL_KEY = 'innovista:sign-in-portal';
function rememberedPortal(): Portal {
  try {
    return localStorage.getItem(PORTAL_KEY) === 'guest' ? 'guest' : 'admin';
  } catch {
    return 'admin';
  }
}

export function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [portal, setPortal] = useState<Portal>(rememberedPortal),
    [remember, setRemember] = useState(false);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();
  const tabId = (id: Portal) => baseId + '-tab-' + id;
  const panelId = baseId + '-panel';
  const current = portals.find((item) => item.id === portal)!;
  function choose(next: Portal, focus = false) {
    setPortal(next);
    setError('');
    try {
      localStorage.setItem(PORTAL_KEY, next);
    } catch {
      // Private windows and blocked storage simply do not remember the tab.
    }
    if (focus) tabs.current[portals.findIndex((item) => item.id === next)]?.focus();
  }
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const index = portals.findIndex((item) => item.id === portal);
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (index + 1) % portals.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (index - 1 + portals.length) % portals.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? portals.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    choose(portals[next].id, true);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      onLogin(
        await api<Session>('/auth/login', {
          method: 'POST',
          body: json({
            username: data.get('username'),
            password: data.get('password'),
            portal,
            remember,
          }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // The server names the right tab when an account used the other door; offer the switch.
  const suggested = /Guest tab/.test(error)
    ? 'guest'
    : /Administrator tab/.test(error)
      ? 'admin'
      : null;
  return (
    <div className="login-page">
      <section className="login-story">
        <Brand />
        <div className="login-story-main">
          <span className="eyebrow light">INNOVISTA RESEARCH AI</span>
          <h1>
            Better context.
            <br />
            Clearer decisions.
          </h1>
          <p>Turn what you know about your business into research you can act on.</p>
          <div className="login-features">
            <span>
              <BookOpen aria-hidden="true" />
              Train with your knowledge
            </span>
            <span>
              <ScanLine aria-hidden="true" />
              Qualify with evidence
            </span>
            <span>
              <Fingerprint aria-hidden="true" />
              Keep every decision traceable
            </span>
          </div>
        </div>
        <small>Your research, in context.</small>
      </section>
      <section className="login-form">
        <div className="login-card">
          <div className="login-mobile-brand">
            <Brand />
          </div>
          <div className="login-card-head">
            <span className="eyebrow">LET’S GET TO WORK</span>
            <h2>Sign in</h2>
            <p className="muted">Welcome to Innovista Research AI.</p>
          </div>
          <div className="login-portals" role="tablist" aria-label="Sign in as">
            {portals.map((item, index) => (
              <button
                key={item.id}
                ref={(element) => {
                  tabs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={tabId(item.id)}
                aria-selected={portal === item.id}
                aria-controls={panelId}
                tabIndex={portal === item.id ? 0 : -1}
                onClick={() => choose(item.id)}
                onKeyDown={onTabKey}
              >
                <item.icon size={16} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </div>
          <form onSubmit={submit} role="tabpanel" id={panelId} aria-labelledby={tabId(portal)}>
            <p className="login-portal-hint">{current.hint}</p>
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
            <div className="login-remember">
              <label>
                <input
                  type="checkbox"
                  name="remember"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                Keep me signed in for 30 days
              </label>
              <small>Leave this off on a shared computer: you are signed out after 12 hours.</small>
            </div>
            {error && (
              <Alert>
                {error}
                {suggested && suggested !== portal && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => choose(suggested, true)}
                    >
                      Switch to {suggested === 'guest' ? 'Guest' : 'Administrator'}
                    </button>
                  </>
                )}
              </Alert>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? (
                <Spinner text="Please wait…" />
              ) : (
                <>
                  Sign in as {portal === 'guest' ? 'guest' : 'administrator'}
                  <ArrowRight size={17} aria-hidden="true" />
                </>
              )}
            </button>
          </form>
          <p className="fine-print">
            Your session is protected. Project access is shared with your workspace team.
          </p>
        </div>
      </section>
    </div>
  );
}

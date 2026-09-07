import { useEffect, useState, type FormEvent } from 'react';
import {
  BookOpen,
  CheckCircle2,
  FolderPlus,
  KeyRound,
  LockKeyhole,
  Plus,
  Save,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { Account, Project, Settings as AiSettings, User } from '../shared/types';
import { api, json, setSession, type Session } from './api';
import { Alert, Badge, Modal, Spinner } from './ui';

export default function Settings({
  user,
  projects,
  notify,
  onCreateProject,
}: {
  user: User;
  projects: Project[];
  notify: (message: string) => void;
  onCreateProject: () => void;
}) {
  const [settings, setSettings] = useState<AiSettings | null>(null),
    [key, setKey] = useState(''),
    [clearKey, setClearKey] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]),
    [adding, setAdding] = useState(false),
    [assigning, setAssigning] = useState<Account | null>(null);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const loadUsers = () => api<typeof accounts>('/users').then(setAccounts);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      user.role === 'admin' ? api<AiSettings>('/settings/llm') : Promise.resolve(null),
      user.role === 'admin' ? api<typeof accounts>('/users') : Promise.resolve([]),
    ])
      .then(([data, users]) => {
        if (!cancelled) {
          setSettings(data);
          setAccounts(users);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy('settings');
    setError('');
    try {
      const result = await api<AiSettings>('/settings/llm', {
        method: 'PUT',
        body: json({
          provider: settings.provider,
          model: settings.model,
          base_url: settings.base_url,
          api_key: key,
          clear_api_key: clearKey,
        }),
      });
      setSettings(result);
      setKey('');
      setClearKey(false);
      notify('AI settings saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WORKSPACE CONTROLS</span>
          <h1>A sound foundation.</h1>
          <p>
            {user.role === 'admin'
              ? 'Manage your research projects, AI provider, account and team.'
              : 'Manage your account security.'}
          </p>
        </div>
        <Badge value="ready">{user.role === 'admin' ? 'Administrator' : 'Researcher'}</Badge>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="settings-layout">
        <div>
          {user.role === 'admin' && (
            <section className="panel">
              <div className="section-title">
                <h2>
                  <FolderPlus size={20} />
                  Workspace administration
                </h2>
              </div>
              <p className="muted">
                Create a research project for each business, such as Sintertechnik. Each project has
                its own training documents, websites and leads within your team workspace.
              </p>
              <div className="form-actions">
                <button className="button primary" onClick={onCreateProject}>
                  <Plus size={16} />
                  Create research project
                </button>
              </div>
            </section>
          )}
          <section className="panel" hidden={user.role !== 'admin'}>
            <div className="section-title">
              <h2>
                <KeyRound size={20} />
                AI provider
              </h2>
              {settings && (
                <Badge value={settings.has_api_key ? 'ready' : 'draft'}>
                  {settings.has_api_key ? 'Key configured' : 'Setup required'}
                </Badge>
              )}
            </div>
            <p className="muted">
              Training analysis and qualification use this provider. Project source text and lead
              evidence are sent when an analysis runs.
            </p>
            {!settings ? (
              <Spinner text="Loading configuration…" />
            ) : (
              <form className="form-stack" onSubmit={save}>
                <label>
                  Provider
                  <select
                    value={settings.provider}
                    onChange={(e) => {
                      const provider = e.target.value as AiSettings['provider'];
                      setSettings({
                        ...settings,
                        provider,
                        model: provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4.1-mini',
                        base_url: 'https://api.openai.com/v1',
                      });
                      setKey('');
                    }}
                  >
                    <option value="gemini">Google Gemini</option>
                    <option value="openai_compatible">OpenAI-compatible provider</option>
                  </select>
                </label>
                <label>
                  Model ID
                  <input
                    value={settings.model}
                    onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                    required
                    maxLength={200}
                  />
                </label>
                {settings.provider === 'openai_compatible' && (
                  <label>
                    API base URL
                    <input
                      type="url"
                      value={settings.base_url}
                      onChange={(e) => setSettings({ ...settings, base_url: e.target.value })}
                      required
                      maxLength={2000}
                      placeholder="https://api.openai.com/v1"
                    />
                    <small>Public HTTPS endpoints only.</small>
                  </label>
                )}
                <label>
                  API key
                  <input
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    maxLength={1000}
                    autoComplete="off"
                    placeholder={
                      settings.has_api_key
                        ? 'Saved key ' + settings.api_key_preview + ' · leave blank to keep'
                        : 'Paste your provider API key'
                    }
                  />
                  <small>
                    {settings.has_api_key
                      ? 'Loaded from ' + settings.source + '. Saved keys are encrypted at rest.'
                      : 'A provider key is required for AI analysis.'}
                  </small>
                </label>
                {settings.source === 'database' && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={clearKey}
                      onChange={(e) => setClearKey(e.target.checked)}
                    />
                    Clear saved key on save
                  </label>
                )}
                {clearKey && (
                  <p className="fine-print">
                    A server environment key will be used if one is configured.
                  </p>
                )}
                <div className="form-actions">
                  <button className="button primary" disabled={!!busy}>
                    {busy === 'settings' ? (
                      <Spinner />
                    ) : (
                      <>
                        <Save size={16} />
                        Save configuration
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}
          </section>
          <section className="panel">
            <div className="section-title">
              <h2>
                <LockKeyhole size={19} />
                Your password
              </h2>
            </div>
            <form
              className="form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = Object.fromEntries(new FormData(form));
                setBusy('password');
                setError('');
                try {
                  const session = await api<Session>('/auth/password', {
                    method: 'POST',
                    body: json(data),
                  });
                  setSession(session);
                  form.reset();
                  notify('Password updated. Other sessions have been signed out.');
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy('');
                }
              }}
            >
              <label>
                Current password
                <input
                  type="password"
                  name="current_password"
                  required
                  maxLength={128}
                  autoComplete="current-password"
                />
              </label>
              <label>
                New password
                <input
                  type="password"
                  name="password"
                  required
                  minLength={15}
                  maxLength={128}
                  autoComplete="new-password"
                />
                <small>At least 15 characters. Other sessions will be signed out.</small>
              </label>
              <div className="form-actions">
                <button className="button secondary" disabled={!!busy}>
                  {busy === 'password' ? <Spinner /> : 'Update password'}
                </button>
              </div>
            </form>
          </section>
        </div>
        <div>
          <section className="panel" hidden={user.role !== 'admin'}>
            <div className="section-title">
              <h2>
                <Users size={19} />
                Research team
              </h2>
              <button className="button secondary" onClick={() => setAdding(true)}>
                <Plus size={15} />
                Add member
              </button>
            </div>
            <p className="muted">
              A researcher reaches only the projects assigned to them. Administrators reach every
              project and also manage provider settings, project creation and team access.
            </p>
            <div className="team-list">
              {accounts.map((account) => (
                <div className="team-member" key={account.id}>
                  <span className="user-avatar">{account.name[0]}</span>
                  <div>
                    <strong>
                      {account.name}
                      {account.id === user.id && <small> (you)</small>}
                    </strong>
                    <small>
                      @{account.username} · {account.role} ·{' '}
                      {account.active ? 'Active' : 'Inactive'}
                    </small>
                    {account.role === 'admin' ? (
                      <small className="assignment-summary">Every project (administrator)</small>
                    ) : (
                      <small className="assignment-summary">
                        {account.project_ids.length
                          ? projects
                              .filter((p) => account.project_ids.includes(p.id))
                              .map((p) => p.name)
                              .join(', ')
                          : 'No projects assigned yet'}
                      </small>
                    )}
                  </div>
                  {account.role !== 'admin' && (
                    <button className="text-button" onClick={() => setAssigning(account)}>
                      <FolderPlus size={15} />
                      Assign projects
                    </button>
                  )}
                  {account.id !== user.id && (
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={async () => {
                        setBusy('users');
                        setError('');
                        try {
                          await api('/users/' + account.id, {
                            method: 'PATCH',
                            body: json({ active: !account.active }),
                          });
                          await loadUsers();
                          notify(
                            account.active
                              ? 'Access removed and sessions revoked.'
                              : 'Team member activated.',
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy('');
                        }
                      }}
                    >
                      {account.active ? 'Deactivate' : 'Activate'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="panel security-panel">
            <ShieldCheck size={26} />
            <h3>Research with accountability.</h3>
            <p>
              Every published training version, qualification and human review keeps its author and
              date.
            </p>
            <ul>
              <li>Protected sign-in and expiring sessions</li>
              <li>Encrypted provider keys</li>
              <li>Source evidence retained with each analysis</li>
              <li>Project context kept separate</li>
            </ul>
          </section>
        </div>
      </div>
      {adding && (
        <Modal title="Add a team member" onClose={() => setAdding(false)}>
          <NewUser
            onClose={() => setAdding(false)}
            onCreated={() => {
              setAdding(false);
              void loadUsers().catch((e) => setError(e.message));
              notify('Team member created.');
            }}
          />
        </Modal>
      )}
      {assigning && (
        <Modal title={'Projects for ' + assigning.name} onClose={() => setAssigning(null)}>
          <AssignProjects
            account={assigning}
            projects={projects}
            onClose={() => setAssigning(null)}
            onSaved={() => {
              setAssigning(null);
              void loadUsers().catch((e) => setError(e.message));
              notify('Project access updated.');
            }}
          />
        </Modal>
      )}
    </>
  );
}
function AssignProjects({
  account,
  projects,
  onClose,
  onSaved,
}: {
  account: Account;
  projects: Project[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<number[]>(account.project_ids);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const toggle = (id: number) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  return (
    <form
      className="form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await api('/users/' + account.id + '/projects', {
            method: 'PUT',
            body: json({ project_ids: selected }),
          });
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <Alert>{error}</Alert>}
      <p className="muted">
        {account.name} can open, research and review only the projects selected here. Removing a
        project takes effect immediately.
      </p>
      {projects.length === 0 ? (
        <p className="muted">Create a research project first.</p>
      ) : (
        <div className="assignment-list">
          {projects.map((project) => (
            <label className="checkbox-label" key={project.id}>
              <input
                type="checkbox"
                checked={selected.includes(project.id)}
                onChange={() => toggle(project.id)}
              />
              <span>
                <strong>{project.name}</strong>
                <small>
                  {project.lead_count} leads · {project.source_count} sources
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={busy}>
          {busy ? <Spinner text="Saving…" /> : 'Save project access'}
        </button>
      </div>
    </form>
  );
}
function NewUser({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.currentTarget));
        setBusy(true);
        setError('');
        try {
          await api('/users', { method: 'POST', body: json(data) });
          onCreated();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Full name
        <input name="name" required maxLength={120} autoFocus />
      </label>
      <label>
        Username
        <input
          name="username"
          required
          minLength={3}
          maxLength={60}
          pattern="[a-zA-Z0-9._-]+"
          autoComplete="off"
        />
      </label>
      <label>
        Initial password
        <input
          name="password"
          type="password"
          required
          minLength={15}
          maxLength={128}
          autoComplete="new-password"
        />
      </label>
      <label>
        Role
        <select name="role">
          <option value="researcher">Researcher</option>
          <option value="admin">Administrator</option>
        </select>
      </label>
      {error && <Alert>{error}</Alert>}
      <div className="form-actions">
        <button className="button secondary" type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={busy}>
          {busy ? <Spinner /> : 'Create team member'}
        </button>
      </div>
    </form>
  );
}

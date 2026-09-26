import { useEffect, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  FolderPlus,
  LockKeyhole,
  Mail,
  Plus,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { Account, Project, User } from '../shared/types';
import { api, json, setSession, type Session } from './api';
import { Alert, Badge, Modal, Spinner } from './ui';
import { initials } from './AccountMenu';
import { AiProviderSettings } from './AiProviderSettings';

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
  const [accounts, setAccounts] = useState<Account[]>([]),
    [adding, setAdding] = useState(false),
    [assigning, setAssigning] = useState<Account | null>(null),
    // Held only until the administrator closes the dialog: the server will not show it again.
    [issued, setIssued] = useState<{ name: string; password: string } | null>(null);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const loadUsers = () => api<typeof accounts>('/users').then(setAccounts);
  useEffect(() => {
    let cancelled = false;
    (user.role === 'admin' ? api<typeof accounts>('/users') : Promise.resolve([]))
      .then((users) => {
        if (!cancelled) setAccounts(users);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
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
          {user.role === 'admin' && (
            <section className="panel">
              <div className="section-title">
                <h2>
                  <Mail size={20} />
                  Project mailboxes
                </h2>
              </div>
              <p className="muted">
                Email is not configured here any more. Every project has its own mailbox, so its
                sending account, incoming replies and message history stay inside that project. Open
                a project and choose Mailbox to connect it.
              </p>
            </section>
          )}
          {user.role === 'admin' && <AiProviderSettings notify={notify} />}
          <section className="panel">
            <div className="section-title">
              <h2>
                <LockKeyhole size={19} />
                Your account
              </h2>
            </div>
            {/* The signed-in profile, also shown in the account menu at the top right. */}
            <div className="account-profile settings-profile">
              <span className="account-avatar large" aria-hidden="true">
                {initials(user.name)}
              </span>
              <div>
                <strong>{user.name}</strong>
                <small>
                  @{user.username} · {user.role === 'admin' ? 'Administrator' : 'Researcher'}
                </small>
              </div>
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
                  {account.id !== user.id && account.active && (
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={async () => {
                        setBusy('users');
                        setError('');
                        try {
                          const result = await api<{ name: string; password: string }>(
                            '/users/' + account.id + '/password',
                            { method: 'POST' },
                          );
                          setIssued({ name: result.name, password: result.password });
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy('');
                        }
                      }}
                    >
                      <LockKeyhole size={15} />
                      Reset password
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
                          const result = await api<{ released: number }>('/users/' + account.id, {
                            method: 'PATCH',
                            body: json({ active: !account.active }),
                          });
                          await loadUsers();
                          notify(
                            account.active
                              ? 'Access removed and sessions revoked.' + released(result.released)
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
            onSaved={(count) => {
              setAssigning(null);
              void loadUsers().catch((e) => setError(e.message));
              notify('Project access updated.' + released(count));
            }}
          />
        </Modal>
      )}
      {issued && (
        <Modal title={'New password for ' + issued.name} onClose={() => setIssued(null)}>
          <div className="form-stack">
            <label>
              Password
              <input value={issued.password} readOnly onFocus={(e) => e.target.select()} />
              <small>
                Hand it to {issued.name} yourself and ask them to change it. It cannot be shown
                again — if it is lost, reset the password once more. Their other sessions are signed
                out.
              </small>
            </label>
            <div className="form-actions">
              <button className="button primary" onClick={() => setIssued(null)}>
                <CheckCircle2 size={16} />
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
/** Revoked access takes the calling assignments with it, so say how many leads came back. */
const released = (count: number) =>
  count ? ' ' + count + ' assigned lead(s) returned to the calling pool.' : '';
function AssignProjects({
  account,
  projects,
  onClose,
  onSaved,
}: {
  account: Account;
  projects: Project[];
  onClose: () => void;
  onSaved: (count: number) => void;
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
          const result = await api<{ released: number }>('/users/' + account.id + '/projects', {
            method: 'PUT',
            body: json({ project_ids: selected }),
          });
          onSaved(result.released);
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

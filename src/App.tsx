import { useEffect, useState, lazy, Suspense, type FormEvent } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  FlaskConical,
  FolderOpen,
  History,
  LayoutGrid,
  LogOut,
  Plus,
  ScanLine,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  Menu,
} from 'lucide-react';
import type { Project, User } from '../shared/types';
import { api, date, json } from './api';
import { Alert, Badge, Brand, Empty, ExternalLink, Modal, Spinner } from './ui';
const Training = lazy(() => import('./Training'));
const Leads = lazy(() => import('./Leads'));
const Settings = lazy(() => import('./Settings'));
type View = 'projects' | 'overview' | 'training' | 'leads' | 'review' | 'activity' | 'settings';
export default function App({ user, onLogout }: { user: User; onLogout: () => Promise<void> }) {
  const [projects, setProjects] = useState<Project[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [view, setView] = useState<View>('projects'),
    [selected, setSelected] = useState<number | null>(null);
  const [newProject, setNewProject] = useState(false),
    [editProject, setEditProject] = useState(false),
    [menu, setMenu] = useState(false);
  const [refresh, setRefresh] = useState(0),
    [notice, setNotice] = useState('');
  const project = projects.find((p) => p.id === selected);
  const reload = () => setRefresh((value) => value + 1);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view, selected]);
  useEffect(() => {
    let cancelled = false;
    api<Project[]>('/projects')
      .then((items) => {
        if (!cancelled) {
          setProjects(items);
          setError('');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  function open(p: Project) {
    setSelected(p.id);
    setView('overview');
    setMenu(false);
  }
  function navigate(next: View) {
    setView(next);
    setMenu(false);
  }
  const ready = project && project.revision === project.trained_revision;
  const nav = [
    { id: 'overview', label: 'Project overview', icon: LayoutGrid },
    { id: 'training', label: 'Training library', icon: BookOpen },
    { id: 'leads', label: 'Lead research', icon: ScanLine },
    { id: 'review', label: 'Review queue', icon: ShieldCheck },
    { id: 'activity', label: 'Research history', icon: History },
  ] as const;
  const headings: Record<View, string> = {
    projects: 'Your workspace',
    overview: 'Project overview',
    training: 'Training library',
    leads: 'Lead research',
    review: 'Review queue',
    activity: 'Research history',
    settings: 'Workspace settings',
  };
  return (
    <div className="app-shell">
      {menu && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={'sidebar ' + (menu ? 'sidebar-open' : '')}>
        <Brand />
        <div className="workspace-label">
          <span className="workspace-avatar">IR</span>
          <div>
            Research workspace<small>Team workspace</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <span className="nav-caption">WORKSPACE</span>
        <nav aria-label="Workspace">
          <button
            className={'nav-item ' + (view === 'projects' ? 'active' : '')}
            onClick={() => navigate('projects')}
          >
            <FolderOpen size={18} />
            All projects<span className="nav-count">{projects.length}</span>
          </button>
        </nav>
        <div className="nav-divider" />
        <div className="nav-caption">PROJECTS</div>
        <div className="project-nav">
          {projects.map((p) => (
            <button
              key={p.id}
              className={
                'nav-item project-nav-item ' +
                (p.id === selected && view !== 'projects' ? 'selected-project' : '')
              }
              onClick={() => open(p)}
            >
              <span className="project-dot" />
              {p.name}
              {selected === p.id && <ChevronDown size={14} />}
            </button>
          ))}
        </div>
        {project && (
          <nav className="sub-nav" aria-label="Project">
            {nav.map((item) => (
              <button
                key={item.id}
                className={'nav-item ' + (view === item.id ? 'active' : '')}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={17} />
                {item.label}
                {item.id === 'review' && project.review_count > 0 && (
                  <span className="nav-count">{project.review_count}</span>
                )}
              </button>
            ))}
          </nav>
        )}
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Sparkles size={19} />
            <strong>
              Good research starts
              <br />
              with good context.
            </strong>
            <p>Give each project the knowledge it needs to qualify with confidence.</p>
          </div>
          {
            <button
              className={'nav-item ' + (view === 'settings' ? 'active' : '')}
              onClick={() => navigate('settings')}
            >
              <SettingsIcon size={17} />
              Workspace settings
            </button>
          }
          <div className="user-card">
            <span className="user-avatar">
              {user.name
                .split(' ')
                .map((n) => n[0])
                .slice(0, 2)
                .join('')}
            </span>
            <div>
              <strong>{user.name}</strong>
              <small>{user.role === 'admin' ? 'Administrator' : 'Researcher'}</small>
            </div>
            <button
              aria-label="Sign out"
              title="Sign out"
              onClick={() => onLogout().catch((e) => setError(e.message))}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMenu(true)}
            >
              <Menu size={21} />
            </button>
            <span>Workspace</span>
            <span className="crumb-slash">/</span>
            {project && view !== 'projects' && view !== 'settings' && (
              <>
                <button onClick={() => navigate('overview')}>{project.name}</button>
                <span className="crumb-slash">/</span>
              </>
            )}
            <strong>{headings[view]}</strong>
          </div>
          <div className="topbar-right">
            <span className="private-label">
              <ShieldCheck size={14} />
              Team workspace
            </span>
            <span className="top-avatar">{user.name[0]}</span>
          </div>
        </header>
        <main className="main-content" id="main-content">
          {error && (
            <Alert>
              {error}{' '}
              <button className="text-button" onClick={reload}>
                Retry
              </button>
            </Alert>
          )}
          {loading ? (
            <Spinner text="Loading projects…" />
          ) : (
            <Suspense fallback={<Spinner text="Opening workspace…" />}>
              {view === 'projects' && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">RESEARCH, WITH CONTEXT</span>
                      <h1>
                        Your research projects
                        <span className="heading-dot">.</span>
                      </h1>
                      <p>A dedicated space for every business. A clear reason behind every lead.</p>
                    </div>
                    {user.role === 'admin' && (
                      <button className="button primary" onClick={() => setNewProject(true)}>
                        <Plus size={16} />
                        New project
                      </button>
                    )}
                  </div>
                  <div className="stat-grid">
                    <Stat
                      label="Projects"
                      value={projects.length}
                      detail={user.role === 'admin' ? 'In this workspace' : 'Assigned to you'}
                      icon={<FolderOpen />}
                    />
                    <Stat
                      label="Total leads"
                      value={projects.reduce((total, p) => total + p.lead_count, 0)}
                      detail="Across your projects"
                      icon={<Users />}
                    />
                    <Stat
                      label="Qualified leads"
                      value={projects.reduce((total, p) => total + p.qualified_count, 0)}
                      detail="Against current training"
                      icon={<Check />}
                    />
                    <Stat
                      label="Awaiting review"
                      value={projects.reduce((total, p) => total + p.review_count, 0)}
                      detail="Unreviewed, uncertain or outdated"
                      icon={<ShieldCheck />}
                    />
                  </div>
                  <div className="section-title">
                    <h2>
                      Project library <span>{projects.length}</span>
                    </h2>
                    <span className="muted">Your knowledge, organized by business</span>
                  </div>
                  {projects.length === 0 ? (
                    <Empty
                      icon={<FolderOpen size={26} />}
                      title={
                        user.role === 'admin'
                          ? 'No projects yet'
                          : 'No projects are assigned to you'
                      }
                      action={
                        user.role === 'admin' ? (
                          <button className="button primary" onClick={() => setNewProject(true)}>
                            <Plus size={16} />
                            New project
                          </button>
                        ) : undefined
                      }
                    >
                      {user.role === 'admin'
                        ? 'Create a project, add its training sources, then assign researchers to it in Workspace settings.'
                        : 'An administrator assigns projects to your account in Workspace settings.'}
                    </Empty>
                  ) : (
                    <div className="project-grid">
                      {projects.map((p) => (
                        <ProjectCard key={p.id} project={p} onOpen={() => open(p)} />
                      ))}
                    </div>
                  )}
                </>
              )}
              {project && view === 'overview' && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">
                        PROJECT / {String(project.id).padStart(2, '0')}
                      </span>
                      <h1>
                        {project.name}
                        <span className="heading-dot">.</span>
                      </h1>
                      <p>
                        {project.description || 'Build the context for your next research project.'}
                      </p>
                    </div>
                    <button className="button secondary" onClick={() => setEditProject(true)}>
                      <SettingsIcon size={16} />
                      Project settings
                    </button>
                  </div>
                  <div className="project-meta">
                    <ExternalLink url={project.website} />
                    <span>Created {date(project.created_at)}</span>
                    <Badge value={ready ? 'ready' : 'draft'}>
                      {ready
                        ? 'Training v' + project.active_version + ' ready'
                        : 'Training needs review'}
                    </Badge>
                  </div>
                  {project.preserved_lead_count > 0 && (
                    <section className="preserved-research-banner">
                      <History size={22} />
                      <div>
                        <h3>Your existing research is here.</h3>
                        <p>
                          {project.preserved_lead_count} company profiles ·{' '}
                          {project.preserved_contact_count} saved contacts ·{' '}
                          {project.preserved_activity_count} earlier research records. Open a lead
                          to see its previous details and reasoning.
                        </p>
                      </div>
                      <button className="button secondary" onClick={() => navigate('leads')}>
                        Explore existing research
                        <ArrowRight size={16} />
                      </button>
                    </section>
                  )}
                  <div className="stat-grid">
                    <Stat
                      label="Total leads"
                      value={project.lead_count}
                      detail="In this project"
                      icon={<Users />}
                    />
                    <Stat
                      label="Qualified leads"
                      value={project.qualified_count}
                      detail="Against current training"
                      icon={<Check />}
                    />
                    <Stat
                      label="Awaiting research"
                      value={project.review_count}
                      detail="Unreviewed, uncertain or outdated"
                      icon={<ScanLine />}
                    />
                    <Stat
                      label="Knowledge sources"
                      value={project.source_count}
                      detail="Documents, websites and notes"
                      icon={<BookOpen />}
                    />
                  </div>
                  <section className="overview-callout">
                    <div className="callout-icon">
                      <FlaskConical size={28} />
                    </div>
                    <div>
                      <span className="eyebrow">
                        {ready ? 'READY TO RESEARCH' : 'BUILD YOUR FOUNDATION'}
                      </span>
                      <h2>
                        {ready
                          ? 'Your training is ready. Put it to work.'
                          : 'Great qualification begins with your knowledge.'}
                      </h2>
                      <p>
                        {ready
                          ? 'Every lead will be evaluated against training v' +
                            project.active_version +
                            ', with evidence and a clear rationale.'
                          : 'Review the source library, refine your qualification rules, and publish an approved training version.'}
                      </p>
                    </div>
                    <button
                      className="button primary"
                      onClick={() => navigate(ready ? 'leads' : 'training')}
                    >
                      {ready ? 'Research leads' : 'Review training'}
                      <ArrowRight size={17} />
                    </button>
                  </section>
                  <Activity projectId={project.id} compact refresh={refresh} />
                </>
              )}
              {project && view === 'training' && (
                <Training
                  key={project.id}
                  project={project}
                  onChange={reload}
                  onEditProject={() => setEditProject(true)}
                  notify={setNotice}
                />
              )}
              {project && (view === 'leads' || view === 'review') && (
                <Leads
                  key={project.id + view}
                  project={project}
                  queue={view === 'review'}
                  onChange={reload}
                  onTraining={() => navigate('training')}
                  notify={setNotice}
                />
              )}
              {project && view === 'activity' && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">THE RESEARCH RECORD</span>
                      <h1>Every step, accounted for.</h1>
                      <p>Training changes, analysis and human decisions for {project.name}.</p>
                    </div>
                  </div>
                  <Activity projectId={project.id} refresh={refresh} />
                </>
              )}
              {view === 'settings' && (
                <Settings
                  user={user}
                  projects={projects}
                  notify={setNotice}
                  onCreateProject={() => setNewProject(true)}
                />
              )}
            </Suspense>
          )}
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          {notice}
          <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {((newProject && user.role === 'admin') || (editProject && project)) && (
        <ProjectForm
          project={editProject ? project : undefined}
          onClose={() => {
            setNewProject(false);
            setEditProject(false);
          }}
          onSaved={(p) => {
            reload();
            open(p);
            setNewProject(false);
            setEditProject(false);
            setNotice(
              editProject
                ? 'Project updated. Review and publish the training again.'
                : 'Project created. Add your training sources to begin.',
            );
          }}
        />
      )}
    </div>
  );
}
function ProjectCard({ project: p, onOpen }: { project: Project; onOpen: () => void }) {
  const ready = p.revision === p.trained_revision;
  return (
    <article className="project-card">
      <div className="project-card-top">
        <span className={'project-monogram ' + (p.id === 1 ? 'ceramic-monogram' : '')}>
          {p.name.slice(0, 2).toUpperCase()}
        </span>
        <Badge value={ready ? 'ready' : 'draft'}>
          {ready ? 'Ready for research' : 'Training draft'}
        </Badge>
      </div>
      <h3>
        <button onClick={onOpen}>{p.name}</button>
      </h3>
      <p>{p.description || 'Your next research project starts here.'}</p>
      {p.preserved_lead_count > 0 && (
        <p className="project-preserved-label">
          <History size={15} />
          Existing research · {p.preserved_contact_count} saved contacts
        </p>
      )}
      <div className="project-card-stats">
        <div>
          <strong>{p.lead_count}</strong>
          <span>Leads</span>
        </div>
        <div>
          <strong>{p.source_count}</strong>
          <span>Sources</span>
        </div>
        <div>
          <strong>{p.active_version ? 'v' + p.active_version : '—'}</strong>
          <span>Training</span>
        </div>
      </div>
      <footer>
        <span>
          <span className="small-dot" />
          {ready ? 'Training published' : 'Ready to build your context'}
        </span>
        <button onClick={onOpen} aria-label={'Open ' + p.name}>
          <ArrowUpRight size={21} />
        </button>
      </footer>
    </article>
  );
}
function Stat({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: number;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="stat">
      <span>
        {label}
        {icon}
      </span>
      <strong>{value.toLocaleString()}</strong>
      <small>{detail}</small>
    </div>
  );
}
function ProjectForm({
  project,
  onClose,
  onSaved,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError('');
    try {
      const result = await api<Project>(project ? '/projects/' + project.id : '/projects', {
        method: project ? 'PUT' : 'POST',
        body: json({
          ...data,
          ...(project ? { revision: project.revision } : {}),
        }),
      });
      onSaved(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={project ? 'Project settings' : 'Create a research project'} onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        <p className="muted">
          Each project has its own training library, qualification rules and leads.
        </p>
        <label>
          Project name
          <input
            name="name"
            required
            maxLength={120}
            defaultValue={project?.name}
            placeholder="e.g. Novista Leads"
            autoFocus
          />
        </label>
        <label>
          Business website
          <input
            name="website"
            type="url"
            maxLength={2000}
            defaultValue={project?.website}
            placeholder="https://example.com"
          />
        </label>
        <label>
          Research objective
          <textarea
            name="description"
            rows={4}
            maxLength={4000}
            defaultValue={project?.description}
            placeholder="What does this business do, and who are you researching?"
          />
        </label>
        {error && <Alert>{error}</Alert>}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : project ? 'Save project' : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Activity({
  projectId,
  compact,
  refresh,
}: {
  projectId: number;
  compact?: boolean;
  refresh: number;
}) {
  const [items, setItems] = useState<
      Array<{
        id: number;
        action: string;
        detail: string;
        actor: string;
        created_at: string;
      }>
    >([]),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<typeof items>('/projects/' + projectId + '/activity')
      .then((data) => {
        if (!cancelled) {
          setItems(data);
          setError('');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refresh]);
  return (
    <section className="panel activity-panel">
      <div className="section-title">
        <h2>{compact ? 'Recent research activity' : 'Project activity'}</h2>
        <History size={18} />
      </div>
      {error && <Alert>{error}</Alert>}
      {!items.length && !error ? (
        <Empty icon={<History />} title="A fresh research record">
          Your project activity will appear here.
        </Empty>
      ) : (
        <div className="activity-list">
          {items.slice(0, compact ? 5 : 100).map((item) => (
            <div className="activity-item" key={item.id}>
              <span className="activity-icon">
                {item.action.includes('training') ? <BookOpen size={16} /> : <ScanLine size={16} />}
              </span>
              <div>
                <strong>{item.action.replaceAll('.', ' ').replaceAll('_', ' ')}</strong>
                <p>{item.detail}</p>
                <small>
                  {item.actor} · {date(item.created_at)}
                </small>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

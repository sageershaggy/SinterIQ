import { useEffect, useState, lazy, Suspense, type FormEvent } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  FolderOpen,
  History,
  LayoutGrid,
  Plus,
  ScanLine,
  Settings as SettingsIcon,
  ShieldCheck,
  Users,
  X,
  Menu,
  GitBranch,
  Mail,
  PhoneCall,
} from 'lucide-react';
import type { Project, User } from '../shared/types';
import { api, date, json } from './api';
import { Alert, Badge, Brand, Empty, ExternalLink, Modal, Spinner } from './ui';
import { Notifications } from './Notifications';
import { AccountMenu } from './AccountMenu';
import { HeaderQuote } from './Shell';
import { readRoute, type View } from './navigation';
const Training = lazy(() => import('./Training'));
const Leads = lazy(() => import('./Leads'));
const Funnels = lazy(() => import('./Funnels'));
const Settings = lazy(() => import('./Settings'));
const Mailbox = lazy(() => import('./Mailbox'));
const Calls = lazy(() => import('./Calls'));
const ResearchLog = lazy(() => import('./ResearchLog'));
export default function App({ user, onLogout }: { user: User; onLogout: () => Promise<void> }) {
  const [projects, setProjects] = useState<Project[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [route, setRoute] = useState(readRoute);
  const [view, setView] = useState<View>(route.view),
    [selected, setSelected] = useState<number | null>(route.projectId),
    [expanded, setExpanded] = useState<number[]>([]),
    [projectsOpen, setProjectsOpen] = useState(true);
  const [newProject, setNewProject] = useState(false),
    [editProject, setEditProject] = useState(false),
    [menu, setMenu] = useState(false);
  const [refresh, setRefresh] = useState(0),
    [notice, setNotice] = useState('');
  const project = projects.find((p) => p.id === selected);
  const reload = () => setRefresh((value) => value + 1);
  useEffect(() => {
    const sync = () => {
      const next = readRoute();
      setRoute(next);
      setView(next.view);
      setSelected(next.projectId);
      if (next.projectId) {
        setExpanded((ids) => (ids.includes(next.projectId!) ? ids : [...ids, next.projectId!]));
        setProjectsOpen(true);
      }
      setMenu(false);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view, selected, route.leadId]);
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
  /** Opening a project selects it and expands its section, leaving others as they were. */
  function open(p: Project) {
    window.location.hash = `projects/${p.id}/overview`;
    setSelected(p.id);
    setView('overview');
    setExpanded((ids) => (ids.includes(p.id) ? ids : [...ids, p.id]));
    setMenu(false);
  }
  /** Expansion is independent of selection, so several projects can be open at once. */
  function toggleExpanded(id: number) {
    setExpanded((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]));
  }
  function navigate(next: View) {
    window.location.hash =
      next === 'projects' || next === 'settings' ? next : `projects/${selected}/${next}`;
    setView(next);
    setMenu(false);
  }
  /** Jump straight to a section of a project that is not the active one. */
  function navigateTo(p: Project, next: View) {
    window.location.hash = `projects/${p.id}/${next}`;
    setSelected(p.id);
    setView(next);
    setMenu(false);
  }
  const ready = project && project.revision === project.trained_revision;
  // Every mailbox route is administrator-only, so a researcher is never offered a screen
  // that would answer 403.
  const nav = (
    [
      { id: 'overview', label: 'Project overview', icon: LayoutGrid },
      { id: 'training', label: 'Training library', icon: BookOpen },
      { id: 'leads', label: 'Lead research', icon: ScanLine },
      { id: 'review', label: 'Review queue', icon: ShieldCheck },
      { id: 'calls', label: 'Calls', icon: PhoneCall },
      { id: 'funnels', label: 'Email funnels', icon: GitBranch },
      { id: 'mailbox', label: 'Mailbox', icon: Mail },
      { id: 'activity', label: 'Research history', icon: History },
    ] as const
  ).filter((item) => item.id !== 'mailbox' || user.role === 'admin');
  const headings: Record<View, string> = {
    projects: 'Your workspace',
    overview: 'Project overview',
    training: 'Training library',
    leads: 'Lead research',
    review: 'Review queue',
    funnels: 'Email funnels',
    activity: 'Research history',
    settings: 'Workspace settings',
    mailbox: 'Project mailbox',
    calls: 'Calls',
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
        {/* A plain line, not a control: there is one workspace, so nothing to switch. */}
        <p className="workspace-line">
          <strong>Research workspace</strong> <span>Team workspace</span>
        </p>
        <span className="nav-caption">WORKSPACE</span>
        <nav aria-label="Workspace">
          {/* "All projects" opens its page and drops down every project beneath it. */}
          <div className={'all-projects-row' + (view === 'projects' ? ' is-active' : '')}>
            <button
              className={'nav-item ' + (view === 'projects' ? 'active' : '')}
              onClick={() => {
                navigate('projects');
                setProjectsOpen(true);
              }}
            >
              <FolderOpen size={18} />
              All projects<span className="nav-count">{projects.length}</span>
            </button>
            <button
              className="project-nav-toggle"
              aria-expanded={projectsOpen}
              aria-controls="sidebar-projects"
              aria-label={(projectsOpen ? 'Hide' : 'Show') + ' the list of projects'}
              onClick={() => setProjectsOpen((value) => !value)}
            >
              <ChevronDown size={14} className={projectsOpen ? 'is-open' : ''} />
            </button>
          </div>
        </nav>
        <div
          className="project-nav sidebar-projects"
          id="sidebar-projects"
          hidden={!projectsOpen}
          aria-label="Projects"
          role="group"
        >
          {!projects.length && !loading && (
            <p className="sidebar-projects-empty">No projects yet</p>
          )}
          {projects.map((p) => {
            // Each project owns its own section, rendered inside its group rather than
            // after the list, and expands independently of which project is active.
            const isOpen = expanded.includes(p.id);
            const isActive = p.id === selected && view !== 'projects';
            return (
              <div key={p.id} className="project-nav-group">
                <div className={'project-nav-item ' + (isActive ? 'selected-project' : '')}>
                  <button className="project-nav-name" onClick={() => open(p)}>
                    <span className="project-dot" />
                    {p.name}
                  </button>
                  <button
                    className="project-nav-toggle"
                    aria-expanded={isOpen}
                    aria-label={(isOpen ? 'Collapse ' : 'Expand ') + p.name}
                    onClick={() => toggleExpanded(p.id)}
                  >
                    <ChevronDown size={14} className={isOpen ? 'is-open' : ''} />
                  </button>
                </div>
                {isOpen && (
                  <nav className="sub-nav" aria-label={p.name}>
                    {nav.map((item) => (
                      <button
                        key={item.id}
                        className={'nav-item ' + (isActive && view === item.id ? 'active' : '')}
                        onClick={() => navigateTo(p, item.id)}
                      >
                        <item.icon size={17} />
                        {item.label}
                        {item.id === 'review' && p.review_count > 0 && (
                          <span className="nav-count">{p.review_count}</span>
                        )}
                      </button>
                    ))}
                  </nav>
                )}
              </div>
            );
          })}
        </div>
        {/* Workspace settings, the profile and sign-out moved to the account menu in the header;
            the quote moved to the header line. The sidebar is navigation only. */}
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
          {view !== 'settings' && <HeaderQuote />}
          <div className="topbar-right">
            <Notifications refresh={refresh} />
            <AccountMenu
              user={user}
              active={view === 'settings'}
              onSettings={() => navigate('settings')}
              onLogout={() => onLogout().catch((e) => setError(e.message))}
            />
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
              {selected && !project && view !== 'projects' && view !== 'settings' && (
                <Alert>
                  This project is unavailable.{' '}
                  <button className="text-button" onClick={() => navigate('projects')}>
                    Return to projects
                  </button>
                </Alert>
              )}
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
                  {/* No workspace totals here: each project card carries its own numbers. */}
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
                    <div className="heading-actions">
                      <button className="button secondary" onClick={() => setEditProject(true)}>
                        <SettingsIcon size={16} />
                        Project settings
                      </button>
                      <button
                        className="button primary"
                        onClick={() => navigate(ready ? 'leads' : 'training')}
                      >
                        {ready ? 'Research leads' : 'Review training'}
                        <ArrowRight size={16} />
                      </button>
                    </div>
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
                  {/* Ready training needs no announcement: the badge above says it and the
                      header offers the next step. Only a missing prerequisite earns a line. */}
                  {!ready && (
                    <div className="inline-notice">
                      <BookOpen size={20} />
                      <span>
                        <strong>Training comes first.</strong> Review the sources and rules, then
                        publish a version to start qualifying leads.
                      </span>
                    </div>
                  )}
                  <Activity
                    projectId={project.id}
                    compact
                    refresh={refresh}
                    onViewAll={() => navigate('activity')}
                  />
                </>
              )}
              {project &&
                view === 'mailbox' &&
                (user.role === 'admin' ? (
                  <Mailbox key={project.id} project={project} notify={setNotice} />
                ) : (
                  <Alert>
                    The mailbox for {project.name} is managed by administrators. Replies matched to
                    a company are available on that company’s Email tab.
                  </Alert>
                ))}
              {project && view === 'calls' && (
                <Calls key={project.id} project={project} user={user} notify={setNotice} />
              )}
              {project && view === 'funnels' && (
                <Funnels
                  key={project.id}
                  project={project}
                  user={user}
                  notify={setNotice}
                  onSettings={() => navigate('mailbox')}
                />
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
                  detailId={route.leadId}
                  detailTab={route.tab}
                  queue={view === 'review'}
                  onChange={reload}
                  onTraining={() => navigate('training')}
                  notify={setNotice}
                />
              )}
              {project && view === 'activity' && (
                <ResearchLog
                  key={project.id}
                  project={project}
                  refresh={refresh}
                  activity={<Activity projectId={project.id} refresh={refresh} />}
                />
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
/** Plain words for the audit actions a project log actually contains. */
const activityLabels: Record<string, string> = {
  'training.published': 'Training published',
  'training.rubric_saved': 'Draft rules saved',
  'training.analyzed': 'Training sources analyzed',
  'training.feedback_added': 'Training feedback added',
  'source.added': 'Source added',
  'source.removed': 'Source removed',
  'source.capture_pending': 'Website capture queued',
  'project.created': 'Project created',
  'project.updated': 'Project settings changed',
  'lead.created': 'Lead added',
  'lead.updated': 'Lead edited',
  'lead.qualified': 'Lead analyzed',
  'lead.reviewed': 'Lead reviewed',
  'lead.researched': 'Missing details researched',
  'lead.email_sent': 'Email sent',
  'lead.call_logged': 'Call logged',
  'lead.status_changed': 'Lead status changed',
  'lead.comment_added': 'Comment added',
  'lead.comment_edited': 'Comment edited',
  'lead.comment_deleted': 'Comment deleted',
  'lead.contact_removed': 'Contact removed',
  'leads.imported': 'Leads imported',
  'leads.deleted': 'Leads deleted',
  'leads.assigned': 'Leads assigned for calling',
  'leads.unassigned': 'Leads returned to the pool',
  'leads.assignments_released': 'Calling assignments released',
  'funnel.created': 'Campaign created',
  'funnel.enrolled': 'Leads added to a campaign',
  'email.template_created': 'Email template saved',
  'settings.email_updated': 'Mailbox settings changed',
  'settings.email_tested': 'Mailbox test sent',
  'mailbox.incoming_settings': 'Incoming mail settings changed',
};
function activityLabel(action: string) {
  const words = action.replaceAll('.', ' ').replaceAll('_', ' ');
  return activityLabels[action] || words.charAt(0).toUpperCase() + words.slice(1);
}
function activityIcon(action: string) {
  if (action.startsWith('training') || action.startsWith('source')) return <BookOpen size={15} />;
  if (/^(funnel|email|mailbox|settings\.email)/.test(action) || action === 'lead.email_sent')
    return <Mail size={15} />;
  if (action.startsWith('lead')) return <Users size={15} />;
  return <ScanLine size={15} />;
}
/** "12 min ago" reads faster than a date when most of a day's work happened today. */
function relativeTime(value: string) {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' h ago';
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return days + ' days ago';
  return date(value);
}
function Activity({
  projectId,
  compact,
  refresh,
  onViewAll,
}: {
  projectId: number;
  compact?: boolean;
  refresh: number;
  /** The overview shows a summary; this leads to the full, ungrouped record. */
  onViewAll?: () => void;
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
  // Saving a draft three times in a row is one thing that happened, not three: in the overview
  // summary, consecutive entries with the same action, person and detail collapse into one row
  // with a count. The history page is an audit record, so there every entry keeps its own row.
  type Group = { first: (typeof items)[number]; count: number };
  const groups: Group[] = !compact
    ? items.map((item) => ({ first: item, count: 1 }))
    : items.reduce<Group[]>((all, item) => {
        const last = all[all.length - 1];
        if (
          last &&
          last.first.action === item.action &&
          last.first.actor === item.actor &&
          last.first.detail === item.detail
        )
          last.count++;
        else all.push({ first: item, count: 1 });
        return all;
      }, []);
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
        <div className={'activity-list' + (compact ? ' is-compact' : '')}>
          {groups.slice(0, compact ? 6 : 100).map(({ first, count }) => (
            <div className="activity-item" key={first.id}>
              <span className="activity-icon">{activityIcon(first.action)}</span>
              <div className="activity-text">
                <strong>
                  {activityLabel(first.action)}
                  {count > 1 && <span className="activity-count">×{count}</span>}
                </strong>
                {first.detail && <p title={first.detail}>{first.detail}</p>}
              </div>
              <small className="activity-meta" title={new Date(first.created_at).toLocaleString()}>
                <span>{first.actor}</span>
                <span>{relativeTime(first.created_at)}</span>
              </small>
            </div>
          ))}
        </div>
      )}
      {compact && onViewAll && items.length > 0 && (
        <button type="button" className="text-button activity-all" onClick={onViewAll}>
          View full history
          <ArrowRight size={14} />
        </button>
      )}
    </section>
  );
}

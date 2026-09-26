import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, FolderOpen, History, Ellipsis, Plus, Search, Trash2, X } from 'lucide-react';
import type { Project, User } from '../shared/types';
import { Badge, Empty } from './ui';
import './ProjectLibrary.css';

/** "Innovista Research" → IR; a one-word name keeps its first two letters (Sintertechnik → SI). */
const monogram = (name: string) => {
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.trim().slice(0, 2)).toUpperCase();
};

/**
 * "Your research projects": a searchable grid of project cards. Every card has the same
 * structure (and, in a row, the same height): the name and a two-line description, three
 * aligned numbers, then the training status and the way in. Administrators get a menu on each
 * card for the one destructive action a project has.
 */
export function ProjectLibrary({
  projects,
  user,
  onOpen,
  onCreate,
  onDelete,
}: {
  projects: Project[];
  user: User;
  onOpen: (project: Project) => void;
  onCreate: () => void;
  onDelete: (project: Project) => void;
}) {
  const [query, setQuery] = useState('');
  const admin = user.role === 'admin';
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = projects.filter((p) => {
    const haystack = (p.name + ' ' + p.description).toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  return (
    <section className="plib" aria-labelledby="plib-title">
      <div className="plib-toolbar">
        <h2 id="plib-title">
          Project library <span>{projects.length}</span>
        </h2>
        {projects.length > 0 && (
          <label className="plib-search">
            <Search size={15} aria-hidden="true" />
            <span className="visually-hidden">Search projects</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects"
              maxLength={120}
            />
            {query && (
              <button
                type="button"
                className="plib-search-clear"
                aria-label="Clear the search"
                onClick={() => setQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </label>
        )}
      </div>
      {projects.length === 0 ? (
        <Empty
          icon={<FolderOpen size={26} />}
          title={admin ? 'No projects yet' : 'No projects are assigned to you'}
          action={
            admin ? (
              <button className="button primary" onClick={onCreate}>
                <Plus size={16} />
                New project
              </button>
            ) : undefined
          }
        >
          {admin
            ? 'Create a project, add its training sources, then assign researchers to it in Workspace settings.'
            : 'An administrator assigns projects to your account in Workspace settings.'}
        </Empty>
      ) : shown.length === 0 ? (
        <div className="plib-no-match" role="status">
          <p>
            No project matches “{query.trim()}”. Search looks at project names and descriptions.
          </p>
          <button type="button" className="text-button" onClick={() => setQuery('')}>
            Show all projects
          </button>
        </div>
      ) : (
        <>
          {words.length > 0 && (
            <p className="plib-count" role="status">
              {shown.length} of {projects.length} projects
            </p>
          )}
          <div className="plib-grid">
            {shown.map((p) => (
              <ProjectTile
                key={p.id}
                project={p}
                onOpen={() => onOpen(p)}
                onDelete={admin ? () => onDelete(p) : undefined}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ProjectTile({
  project: p,
  onOpen,
  onDelete,
}: {
  project: Project;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  const ready = p.revision === p.trained_revision;
  const training = p.active_version ? 'v' + p.active_version : '—';
  const titleId = useId();
  return (
    <article className="plib-card" aria-labelledby={titleId}>
      <header className="plib-card-head">
        <span className={'plib-monogram' + (p.is_starter ? ' is-starter' : '')} aria-hidden="true">
          {monogram(p.name)}
        </span>
        <div className="plib-card-flags">
          <Badge value={ready ? 'ready' : 'draft'}>
            {ready ? 'Ready for research' : 'Training draft'}
          </Badge>
          {onDelete && <CardMenu name={p.name} onOpen={onOpen} onDelete={onDelete} />}
        </div>
      </header>
      <div className="plib-card-body">
        <h3 id={titleId}>
          <button type="button" onClick={onOpen} title={p.name}>
            {p.name}
          </button>
        </h3>
        {p.description ? (
          <p className="plib-desc" title={p.description}>
            {p.description}
          </p>
        ) : (
          <p className="plib-desc is-empty">
            No description yet. Add the research objective in Project settings.
          </p>
        )}
        {p.preserved_lead_count > 0 && (
          <p className="plib-preserved">
            <History size={14} aria-hidden="true" />
            Existing research · {p.preserved_contact_count.toLocaleString()} saved contacts
          </p>
        )}
      </div>
      <dl className="plib-stats">
        <div>
          <dt>Leads</dt>
          <dd>{p.lead_count.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>{p.source_count.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Training</dt>
          <dd>{training}</dd>
        </div>
      </dl>
      <footer className="plib-card-foot">
        <span className={'plib-status' + (ready ? ' is-ready' : '')}>
          <span className="plib-dot" aria-hidden="true" />
          {ready ? 'Training published' : 'Training not yet published'}
        </span>
        <button type="button" className="plib-open" onClick={onOpen}>
          Open project
          <ArrowRight size={15} aria-hidden="true" />
          <span className="visually-hidden">: {p.name}</span>
        </button>
      </footer>
    </article>
  );
}

/** The ⋯ menu on a card: administrators only. */
function CardMenu({
  name,
  onOpen,
  onDelete,
}: {
  name: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const items = () => [
      ...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    ];
    items()[0]?.focus();
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      } else if (event.key === 'Tab') setOpen(false);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const list = items();
        const index = list.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? list.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
        list[next]?.focus();
      }
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div className="plib-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="plib-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={'More actions for ' + name}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={18} />
      </button>
      {open && (
        <div className="plib-menu-list" id={menuId} role="menu" aria-label={name}>
          <button type="button" role="menuitem" onClick={choose(onOpen)}>
            <ArrowRight size={15} aria-hidden="true" />
            Open project
          </button>
          <button type="button" role="menuitem" className="is-danger" onClick={choose(onDelete)}>
            <Trash2 size={15} aria-hidden="true" />
            Delete project…
          </button>
        </div>
      )}
    </div>
  );
}

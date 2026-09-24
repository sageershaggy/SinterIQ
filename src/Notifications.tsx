import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Bell,
  BookOpen,
  CheckCheck,
  FileUp,
  Globe,
  Mail,
  PhoneCall,
  ScanLine,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import type { NotificationFeed, NotificationItem } from '../shared/notifications';
import { api, date, json } from './api';
import { leadLink, type LeadTab } from './navigation';
import { Alert } from './ui';
import './Notifications.css';

/** Where a lead notification opens. */
const leadTab = (kind: string): LeadTab =>
  kind === 'qualification'
    ? 'reasoning'
    : kind === 'assignment' || kind === 'call'
      ? 'calls'
      : kind === 'email' || kind === 'outcome'
        ? 'email'
        : 'overview';
/** Project updates open the screen they are about. */
function href(item: NotificationItem) {
  if (item.scope === 'lead' && item.lead_id)
    return leadLink(item.project_id, item.lead_id, leadTab(item.kind));
  const view = item.kind.startsWith('training')
    ? 'training'
    : item.kind === 'leads_imported'
      ? 'leads'
      : 'overview';
  return `#projects/${item.project_id}/${view}`;
}
function icon(kind: string): ReactNode {
  if (kind === 'training_draft') return <Sparkles size={15} />;
  if (kind.startsWith('training')) return <BookOpen size={15} />;
  if (kind === 'leads_imported') return <FileUp size={15} />;
  if (kind === 'research') return <Globe size={15} />;
  if (kind === 'email' || kind === 'outcome') return <Mail size={15} />;
  if (kind === 'assignment' || kind === 'call') return <PhoneCall size={15} />;
  if (kind === 'created') return <UserPlus size={15} />;
  return <ScanLine size={15} />;
}

export function Notifications({ refresh }: { refresh: number }) {
  const [items, setItems] = useState<NotificationItem[]>([]),
    [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false),
    [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  async function load() {
    const request = ++sequence.current;
    try {
      const result = await api<NotificationFeed>('/notifications');
      if (request === sequence.current) {
        setItems(result.items);
        setUnread(result.unread);
        setError('');
      }
    } catch (e) {
      if (request === sequence.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    return () => {
      clearInterval(timer);
      sequence.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    void load();
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        root.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  async function post(url: string, body: object = {}) {
    try {
      await api(url, { method: 'POST', body: json(body) });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  /** Reading a row reads every identical notification it stands for. */
  const markRead = (item: NotificationItem) =>
    post(
      item.scope === 'project'
        ? `/notifications/project/${item.id}/read`
        : `/notifications/${item.id}/read`,
    );
  /** Up to the newest row of each kind on screen, so anything arriving meanwhile stays new. */
  function markAll() {
    const newest = (scope: NotificationItem['scope']) =>
      Math.max(0, ...items.filter((item) => item.scope === scope).map((item) => item.id));
    const lead = newest('lead'),
      project = newest('project');
    void post('/notifications/read', {
      ...(lead ? { through_id: lead } : {}),
      ...(project ? { through_project_id: project } : {}),
    });
  }
  return (
    <div className="notifications" ref={root}>
      <button
        className="icon-button notification-bell"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        aria-controls="notifications-panel"
        onClick={() => setOpen(!open)}
      >
        <Bell size={19} />
        {unread > 0 && <span className="notification-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <section
          id="notifications-panel"
          className="notification-panel"
          aria-label="Recent notifications"
        >
          <div className="section-title">
            <h3>
              Updates <span className="muted">{unread} unread</span>
            </h3>
            <button className="text-button" disabled={!unread || !items.length} onClick={markAll}>
              <CheckCheck size={15} />
              Mark all read
            </button>
          </div>
          {error && (
            <Alert>
              {error}{' '}
              <button className="text-button" onClick={() => void load()}>
                Retry
              </button>
            </Alert>
          )}
          {!items.length && (
            <p className="muted">
              Training, imports, research, assignments and email updates will appear here.
            </p>
          )}
          <div className="notification-list">
            {items.map((item) => (
              <a
                key={item.scope + item.id}
                className={'notification-item ' + (item.unread ? 'is-unread' : '')}
                href={href(item)}
                onClick={() => {
                  void markRead(item);
                  setOpen(false);
                }}
              >
                <span className="notification-dot" />
                <span className="notification-icon" aria-hidden="true">
                  {icon(item.kind)}
                </span>
                <div>
                  <strong>
                    {item.title}
                    {item.count > 1 && (
                      <span
                        className="notification-repeat"
                        title={`${item.count} identical updates since ${date(item.first_at)}`}
                      >
                        ×{item.count}
                      </span>
                    )}
                  </strong>
                  <small>
                    {item.project_name} · {date(item.created_at)}
                    {item.count > 1 && item.unread > 0 && item.unread < item.count
                      ? ` · ${item.unread} new`
                      : ''}
                  </small>
                </div>
                <ArrowUpRight size={16} />
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, ArrowUpRight } from 'lucide-react';
import { api, date, json } from './api';
import { leadLink, type LeadTab } from './navigation';
import { Alert } from './ui';

interface Notification {
  id: number;
  project_id: number;
  lead_id: number;
  kind: string;
  title: string;
  project_name: string;
  created_at: string;
  read_at: string | null;
}
export function Notifications({ refresh }: { refresh: number }) {
  const [items, setItems] = useState<Notification[]>([]),
    [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false),
    [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  async function load() {
    const request = ++sequence.current;
    try {
      const result = await api<{ items: Notification[]; unread: number }>('/notifications');
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
  const targetTab = (kind: string): LeadTab =>
    kind === 'qualification'
      ? 'reasoning'
      : kind === 'assignment' || kind === 'call'
        ? 'calls'
        : kind === 'email' || kind === 'outcome'
          ? 'email'
          : 'overview';
  async function markRead(id: number, all = false) {
    try {
      await api(all ? '/notifications/read' : `/notifications/${id}/read`, {
        method: 'POST',
        body: json(all ? { through_id: id } : {}),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
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
            <button
              className="text-button"
              disabled={!unread || !items.length}
              onClick={() => void markRead(items[0].id, true)}
            >
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
            <p className="muted">Assignments, research and email updates will appear here.</p>
          )}
          <div className="notification-list">
            {items.map((item) => (
              <a
                key={item.id}
                className={'notification-item ' + (!item.read_at ? 'is-unread' : '')}
                href={leadLink(item.project_id, item.lead_id, targetTab(item.kind))}
                onClick={() => {
                  void markRead(item.id);
                  setOpen(false);
                }}
              >
                <span className="notification-dot" />
                <div>
                  <strong>{item.title}</strong>
                  <small>
                    {item.project_name} · {date(item.created_at)}
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

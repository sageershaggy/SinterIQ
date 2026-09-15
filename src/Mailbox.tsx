import { useEffect, useState } from 'react';
import {
  Inbox,
  Send,
  Clock3,
  FileEdit,
  RefreshCw,
  Settings,
  ArrowUpRight,
  Mail,
} from 'lucide-react';
import type { MailFolder, MailPage, MailRow } from '../shared/mailbox';
import type { Lead, Project } from '../shared/types';
import { api, json, label } from './api';
import { Alert, Badge, Empty, Spinner } from './ui';
import { leadLink } from './navigation';
import { ReplyForm } from './IncomingReplies';

const folders = [
  { id: 'inbox', title: 'Inbox', icon: Inbox },
  { id: 'outbox', title: 'Outbox', icon: Clock3 },
  { id: 'sent', title: 'Sent', icon: Send },
  { id: 'drafts', title: 'My drafts', icon: FileEdit },
] as const;
export default function Mailbox({
  projects,
  notify,
}: {
  projects: Project[];
  notify: (message: string) => void;
}) {
  const [folder, setFolder] = useState<MailFolder>('inbox'),
    [query, setQuery] = useState('');
  const [page, setPage] = useState(1),
    [data, setData] = useState<MailPage | null>(null);
  const [selected, setSelected] = useState<MailRow | null>(null),
    [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api<MailPage>(`/mailbox?folder=${folder}&page=${page}&q=${encodeURIComponent(query)}`)
        .then((result) => {
          if (!cancelled) {
            setData(result);
            setError('');
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [folder, page, query, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setRefresh((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  async function open(row: MailRow) {
    setSelected(row);
    setError('');
    if (row.kind === 'incoming' && row.status === 'UNREAD') {
      try {
        await api('/mailbox/incoming/' + row.id + '/read', { method: 'POST' });
        setSelected((current) =>
          current?.kind === 'incoming' && current.id === row.id
            ? { ...current, status: 'READ' }
            : current,
        );
        setRefresh((n) => n + 1);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }
  const companyHref =
    selected?.project_id && selected.lead_id
      ? leadLink(
          selected.project_id,
          selected.lead_id,
          selected.kind === 'queue' ? 'campaigns' : 'email',
        )
      : '';
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR SHARED CONVERSATIONS</span>
          <h1>
            Mailbox<span className="heading-dot">.</span>
          </h1>
          <p>Incoming messages, scheduled follow-ups and sent emails, connected to each company.</p>
        </div>
        <div className="mail-heading-actions">
          <a className="button secondary" href="#settings">
            <Settings size={15} /> Configure email
          </a>
          <button
            className="button primary"
            disabled={busy || !data?.incoming.enabled}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const result = await api<{ received: number }>('/mailbox/sync', { method: 'POST' });
                notify(`Inbox synced · ${result.received} new messages`);
                setRefresh((n) => n + 1);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={15} /> {busy ? 'Syncing…' : 'Sync inbox'}
          </button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {data && (
        <div className="mail-connection-strip">
          <span>
            <span className={'status-dot ' + (data.outgoing_configured ? 'connected' : '')} />{' '}
            Sending {data.outgoing_configured ? 'configured' : 'needs setup'}
          </span>
          <span>
            <span
              className={
                'status-dot ' +
                (data.incoming.enabled && data.incoming.last_sync && !data.incoming.last_error
                  ? 'connected'
                  : '')
              }
            />{' '}
            Incoming{' '}
            {data.incoming.last_error
              ? 'needs attention'
              : data.incoming.last_sync
                ? 'last synced ' + new Date(data.incoming.last_sync).toLocaleTimeString()
                : data.incoming.enabled
                  ? 'awaiting first sync'
                  : 'needs setup'}
          </span>
        </div>
      )}
      {data?.incoming.last_error && <Alert>{data.incoming.last_error}</Alert>}
      <section className="mail-center">
        <nav className="mail-folders" aria-label="Mailbox folders">
          {folders.map((item) => (
            <button
              key={item.id}
              aria-pressed={folder === item.id}
              className={folder === item.id ? 'active' : ''}
              onClick={() => {
                setFolder(item.id);
                setPage(1);
                setSelected(null);
                setData(null);
              }}
            >
              <item.icon size={17} />
              {item.title}
              <span>{data?.counts[item.id] ?? '–'}</span>
            </button>
          ))}
        </nav>
        <div className="mail-content">
          <div className="mail-list-toolbar">
            <label className="visually-hidden" htmlFor="mail-search">
              Search mailbox
            </label>
            <input
              id="mail-search"
              type="search"
              placeholder="Search company, subject or email…"
              value={query}
              maxLength={200}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
                setSelected(null);
              }}
            />
            <span className="muted">{data?.total ?? 0} messages</span>
          </div>
          {folder === 'outbox' && (
            <p className="mail-folder-hint">
              Scheduled campaigns and delivery attempts needing attention. An unknown delivery is
              never retried automatically.
            </p>
          )}
          {folder === 'drafts' && (
            <p className="mail-folder-hint">
              Your private saved drafts. Open a company to continue designing or send.
            </p>
          )}
          <div className={'mail-split ' + (selected ? 'has-message' : '')}>
            <div className="mail-list" aria-label={label(folder) + ' messages'} aria-busy={loading}>
              {loading && !data ? (
                <Spinner text="Loading messages…" />
              ) : data?.items.length ? (
                data.items.map((row) => (
                  <button
                    className={
                      'mail-list-item ' +
                      (selected?.id === row.id && selected.kind === row.kind ? 'selected' : '') +
                      (row.status === 'UNREAD' ? ' unread' : '')
                    }
                    key={row.kind + row.id}
                    onClick={() => open(row)}
                  >
                    <span className="mail-item-top">
                      <strong>{row.company || row.address || 'Unknown sender'}</strong>
                      <time>
                        {new Date(row.timestamp).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </time>
                    </span>
                    <span className="mail-subject">{row.subject || 'Untitled draft'}</span>
                    <span className="mail-item-bottom">
                      <span>{row.address}</span>
                      <span>{label(row.status)}</span>
                    </span>
                  </button>
                ))
              ) : (
                <Empty
                  icon={<Inbox size={25} />}
                  title={
                    query
                      ? 'No matching messages'
                      : folder === 'inbox' && !data?.incoming.enabled
                        ? 'Connect your inbox'
                        : 'No messages here yet'
                  }
                >
                  {folder === 'inbox'
                    ? 'Configure incoming mail in Workspace settings, then sync your inbox.'
                    : 'Emails and campaigns from your leads will appear here.'}
                </Empty>
              )}
              <div className="mail-pagination">
                <button
                  className="button secondary small"
                  disabled={page === 1 || loading}
                  onClick={() => {
                    setPage((n) => n - 1);
                    setSelected(null);
                  }}
                >
                  Previous
                </button>
                <span>Page {page}</span>
                <button
                  className="button secondary small"
                  disabled={!data || page * 30 >= data.total || loading}
                  onClick={() => {
                    setPage((n) => n + 1);
                    setSelected(null);
                  }}
                >
                  Next
                </button>
              </div>
            </div>
            <article className="mail-reader" aria-label="Message details">
              {!selected ? (
                <div className="mail-reader-empty">
                  <Mail size={32} />
                  <h3>Your conversations, in one place</h3>
                  <p>Choose a message to read it or open its company.</p>
                </div>
              ) : (
                <>
                  <div className="mail-reader-actions">
                    <button className="text-button" onClick={() => setSelected(null)}>
                      Back to messages
                    </button>
                    <Badge value={selected.status === 'SENT' ? 'ready' : 'draft'}>
                      {label(selected.status)}
                    </Badge>
                  </div>
                  <h2>{selected.subject || 'Untitled draft'}</h2>
                  <p className="muted">
                    {selected.kind === 'incoming' ? 'From' : 'To'}: {selected.address}
                    <br />
                    {new Date(selected.timestamp).toLocaleString()}
                  </p>
                  {companyHref && (
                    <a className="button secondary small" href={companyHref}>
                      <ArrowUpRight size={14} />
                      {selected.kind === 'draft'
                        ? 'Continue draft'
                        : selected.kind === 'queue'
                          ? 'Open campaign'
                          : 'Open company & templates'}
                    </a>
                  )}
                  <div className="mail-message-body preserve-text">
                    {selected.body ||
                      (selected.kind === 'queue'
                        ? 'This campaign message is waiting for its scheduled send time and an active campaign.'
                        : selected.kind === 'draft'
                          ? 'Open the draft to see its designed preview and continue editing.'
                          : 'No text preview available.')}
                  </div>
                  {selected.notice && <Alert>{selected.notice}</Alert>}
                  {selected.kind === 'incoming' &&
                    (selected.project_id && selected.lead_id ? (
                      <ReplyForm
                        key={selected.id}
                        base={`/projects/${selected.project_id}/leads/${selected.lead_id}`}
                        message={{
                          id: selected.id,
                          from_email: selected.address,
                          subject: selected.subject,
                        }}
                        onSent={() => {
                          setRefresh((n) => n + 1);
                          notify('Reply sent.');
                        }}
                      />
                    ) : (
                      <LinkMessage
                        key={selected.id}
                        message={selected}
                        projects={projects}
                        onLinked={() => {
                          setSelected(null);
                          setRefresh((n) => n + 1);
                          notify('Message linked to the company.');
                        }}
                      />
                    ))}
                </>
              )}
            </article>
          </div>
        </div>
      </section>
    </>
  );
}

function LinkMessage({
  message,
  projects,
  onLinked,
}: {
  message: MailRow;
  projects: Project[];
  onLinked: () => void;
}) {
  const [projectId, setProjectId] = useState(''),
    [query, setQuery] = useState(''),
    [leadId, setLeadId] = useState('');
  const [leads, setLeads] = useState<Lead[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setLeads([]);
    setLeadId('');
    if (!projectId) return;
    const timer = setTimeout(() => {
      api<{ leads: Lead[] }>(
        `/projects/${projectId}/leads?search=${encodeURIComponent(query)}&page_size=50`,
      )
        .then((result) => {
          if (!cancelled) setLeads(result.leads);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, query]);
  return (
    <form
      className="mail-link-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await api(`/mailbox/incoming/${message.id}/link`, {
            method: 'POST',
            body: json({ project_id: Number(projectId), lead_id: Number(leadId) }),
          });
          onLinked();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Link this conversation</h3>
      <p className="muted">
        Choose its company to share it with that project’s team and reply. Linking records a
        response and stops applicable scheduled follow-ups.
      </p>
      {error && <Alert>{error}</Alert>}
      <label>
        Project
        <select required value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Choose project</option>
          {projects.map((project) => (
            <option value={project.id} key={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {projectId && (
        <>
          <label>
            Find company
            <input
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search companies…"
            />
          </label>
          <label>
            Company
            <select value={leadId} required onChange={(e) => setLeadId(e.target.value)}>
              <option value="">Choose company</option>
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.name}
                </option>
              ))}
            </select>
          </label>
          <small className="muted">
            Showing up to 50 matches. Refine the search to find another company.
          </small>
        </>
      )}
      <button className="button primary" disabled={!leadId || busy}>
        {busy ? 'Linking…' : 'Link to company'}
      </button>
    </form>
  );
}

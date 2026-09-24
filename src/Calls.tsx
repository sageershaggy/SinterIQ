import { useEffect, useState } from 'react';
import { CalendarClock, Mail, Phone, PhoneCall, Search } from 'lucide-react';
import type { Project, User } from '../shared/types';
import type { CallQueue, CallQueueRow, CallStage } from '../shared/calls';
import { api, date } from './api';
import { leadLink } from './navigation';
import { Alert, Empty, Modal, Spinner } from './ui';
import { CallStatusBadge, CallStatusForm, formatDay, today } from './CallStatus';
import './Calls.css';

type Focus = 'ALL' | CallStage | 'DUE';
const focusLabels: Record<Focus, string> = {
  ALL: 'Assigned for calling',
  NO_CALL_YET: 'Not called yet',
  DUE: 'Due today or overdue',
  PENDING: 'No answer yet',
  FOLLOW_UP_REQUIRED: 'Follow-up required',
  COMPLETED: 'Completed',
};

/**
 * Every lead assigned for calling in a project (Suggestions 2, lines 26–27). Assigning a lead is
 * what puts it here. Researchers start from their own calls, administrators from the whole
 * team; either can look at anyone's. A status saved here is a new entry in the lead's call
 * history and never changes the qualification.
 */
export default function Calls({
  project,
  user,
  notify,
}: {
  project: Project;
  user: User;
  notify: (text: string) => void;
}) {
  const [assignee, setAssignee] = useState(user.role === 'admin' ? 'all' : 'me');
  const [queue, setQueue] = useState<CallQueue | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  const [focus, setFocus] = useState<Focus>('ALL'),
    [search, setSearch] = useState(''),
    [updating, setUpdating] = useState<CallQueueRow | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<CallQueue>('/projects/' + project.id + '/calls?assignee=' + encodeURIComponent(assignee))
      .then((data) => {
        if (!cancelled) {
          setQueue(data);
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
  }, [project.id, assignee, refresh]);

  const day = today();
  const rows = queue?.rows || [];
  const isDue = (row: CallQueueRow) => !!row.next_action_at && row.next_action_at <= day;
  const matches = (row: CallQueueRow, value: Focus) =>
    value === 'ALL' || (value === 'DUE' ? isDue(row) : row.call_stage === value);
  const needle = search.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      matches(row, focus) &&
      (!needle ||
        [row.name, row.contact_name, row.contact_email, row.contact_phone, row.city, row.country]
          .join(' ')
          .toLowerCase()
          .includes(needle)),
  );
  const mine = assignee === 'me' || assignee === String(user.id);
  return (
    <div className="calls-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">CALLING</span>
          <h1>
            Calls<span className="heading-dot">.</span>
          </h1>
          <p>
            Every lead assigned for calling in {project.name}, who has it and what happens next. A
            status saved here goes into the lead’s call history; it never changes the qualification.
          </p>
        </div>
      </div>
      <div className="calls-summary" role="group" aria-label="Show calls">
        {(['ALL', 'NO_CALL_YET', 'DUE', 'PENDING', 'FOLLOW_UP_REQUIRED', 'COMPLETED'] as const).map(
          (value) => (
            <button
              key={value}
              type="button"
              className={
                'calls-summary-item' +
                (focus === value ? ' is-active' : '') +
                (value === 'DUE' ? ' is-due' : '')
              }
              aria-pressed={focus === value}
              onClick={() => setFocus(value)}
            >
              <strong>{rows.filter((row) => matches(row, value)).length}</strong>
              <span>{focusLabels[value]}</span>
            </button>
          ),
        )}
      </div>
      <section className="calls-panel">
        <div className="calls-toolbar">
          <label className="search-input calls-search">
            <Search size={15} />
            <span className="visually-hidden">Search calls</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search company, contact, phone or place"
            />
          </label>
          <label className="calls-person">
            Assigned to
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="me">Me</option>
              <option value="all">Everyone</option>
              {(queue?.people || [])
                .filter((person) => person.id !== user.id)
                .map((person) => (
                  <option key={person.id} value={String(person.id)}>
                    {person.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {error && <Alert>{error}</Alert>}
        {loading && !queue ? (
          <div className="table-loading">
            <Spinner text="Loading calls…" />
          </div>
        ) : !rows.length ? (
          <Empty
            icon={<PhoneCall size={26} />}
            title={mine ? 'No calls assigned to you' : 'No calls assigned'}
          >
            A lead appears here as soon as it is assigned for calling. Assign qualified leads from
            Lead research.
          </Empty>
        ) : !visible.length ? (
          <p className="calls-none">
            No calls match.{' '}
            <button
              className="text-button"
              onClick={() => {
                setFocus('ALL');
                setSearch('');
              }}
            >
              Show all
            </button>
          </p>
        ) : (
          <div className="table-scroll">
            <table className="calls-table">
              <thead>
                <tr>
                  <th>Company & contact</th>
                  <th>Phone & email</th>
                  <th>Location</th>
                  <th>Assigned to</th>
                  <th>Call status</th>
                  <th>Next action</th>
                  <th>Last call</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.lead_id}>
                    <td data-label="Company" className="calls-company-cell">
                      <a
                        className="calls-company"
                        href={leadLink(project.id, row.lead_id, 'calls')}
                      >
                        {row.name}
                      </a>
                      <span className="table-subtext">
                        {row.contact_name || 'No contact name'}
                        {row.contact_role ? ' · ' + row.contact_role : ''}
                      </span>
                    </td>
                    <td data-label="Phone & email">
                      <span className="calls-channels">
                        {row.contact_phone ? (
                          <a
                            className="calls-channel"
                            href={'tel:' + row.contact_phone.replace(/[^+\d]/g, '')}
                          >
                            <Phone size={13} />
                            {row.contact_phone}
                          </a>
                        ) : (
                          <span className="calls-missing">No phone</span>
                        )}
                        {row.contact_email ? (
                          <a className="calls-channel" href={'mailto:' + row.contact_email}>
                            <Mail size={13} />
                            {row.contact_email}
                          </a>
                        ) : (
                          <span className="calls-missing">No email</span>
                        )}
                      </span>
                    </td>
                    <td data-label="Location">
                      {[row.city, row.country].filter(Boolean).join(', ') || (
                        <span className="calls-missing">Unknown</span>
                      )}
                    </td>
                    <td data-label="Assigned to">{row.assigned_to_name || '—'}</td>
                    <td data-label="Call status">
                      <span className="calls-status">
                        <CallStatusBadge outcome={row.call_status} />
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setUpdating(row)}
                          aria-label={'Update call status for ' + row.name}
                        >
                          Update status
                        </button>
                      </span>
                    </td>
                    <td data-label="Next action">
                      <span className="calls-next">{row.next_action}</span>
                      {row.next_action_at && (
                        <span
                          className={
                            'calls-when' +
                            (row.next_action_at < day
                              ? ' is-overdue'
                              : row.next_action_at === day
                                ? ' is-today'
                                : '')
                          }
                        >
                          <CalendarClock size={12} />
                          {row.next_action_at < day
                            ? 'Overdue · '
                            : row.next_action_at === day
                              ? 'Today · '
                              : ''}
                          {formatDay(row.next_action_at)}
                        </span>
                      )}
                    </td>
                    <td data-label="Last call">
                      {row.last_call_at ? (
                        <>
                          {date(row.last_call_at)}
                          <span className="table-subtext">
                            {row.last_call_by} · {row.call_count}{' '}
                            {row.call_count === 1 ? 'call' : 'calls'}
                          </span>
                        </>
                      ) : (
                        <span className="calls-missing">Never</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {queue?.truncated && (
          <p className="fine-print calls-footnote">
            Showing the first 500 assigned leads. Narrow the list by person to see the rest.
          </p>
        )}
      </section>
      {updating && (
        <Modal title="Update call status" onClose={() => setUpdating(null)}>
          <div className="calls-update">
            <div className="calls-update-lead">
              <strong>{updating.name}</strong>
              <span>
                {[updating.contact_name, updating.contact_phone].filter(Boolean).join(' · ') ||
                  'No contact details on record'}
              </span>
              <span>
                Now: <CallStatusBadge outcome={updating.call_status} />
              </span>
            </div>
            <CallStatusForm
              projectId={project.id}
              leadId={updating.lead_id}
              initial={updating.call_status}
              autoFocus
              onCancel={() => setUpdating(null)}
              onSaved={(row) => {
                setQueue(
                  (current) =>
                    current && {
                      ...current,
                      rows: current.rows.map((item) => (item.lead_id === row.lead_id ? row : item)),
                    },
                );
                setUpdating(null);
                notify('Call status saved to the call history of ' + updating.name + '.');
                // Re-read in the background so the order reflects the new next action.
                setRefresh((n) => n + 1);
              }}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown } from 'lucide-react';
import type { Lead, Project } from '../shared/types';
import { api, date, json } from './api';
import { Alert, Modal, Spinner } from './ui';
import './ArchiveControls.css';
import './ArchiveMenu.css';

/**
 * Archiving, never deleting: a lead scoring below 50 or a company that has closed is set aside
 * with its reason, hidden from the default lists, never emailed, and can be restored. Deleting
 * stays a separate, deliberate action.
 */
type Reason = 'SCORE_BELOW_50' | 'COMPANY_CLOSED' | 'OTHER';
const reasons: Array<{ value: Reason; label: string; hint: string }> = [
  { value: 'SCORE_BELOW_50', label: 'Score below 50', hint: 'Not a fit for outreach right now.' },
  {
    value: 'COMPANY_CLOSED',
    label: 'Company closed',
    hint: 'Closed, dormant or no longer trading.',
  },
  { value: 'OTHER', label: 'Another reason', hint: 'Say why, so the team knows later.' },
];

/** Says, on the lead page, that this lead is archived and why. */
export function ArchivedNotice({ lead }: { lead: Lead }) {
  if (!lead.archived_at) return null;
  return (
    <div className="archived-banner" role="status">
      <Archive size={16} />
      <span>
        <strong>Archived · {lead.archived_reason}</strong>
        <small>
          {lead.archived_by ? lead.archived_by + ' · ' : ''}
          {date(lead.archived_at)}. Hidden from the lead lists and never emailed while archived.
          Restore it to work with it again.
        </small>
      </span>
    </div>
  );
}

/** The lead page's Archive button, or Restore once it is archived. */
export function LeadArchiveButton({
  base,
  lead,
  onChange,
  notify,
}: {
  base: string;
  lead: Lead;
  onChange: () => void;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState<Reason>(
      lead.score !== null && lead.score < 50 ? 'SCORE_BELOW_50' : 'COMPANY_CLOSED',
    ),
    [note, setNote] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function call(path: string, body: object, message: string) {
    setBusy(true);
    setError('');
    try {
      await api(base + path, { method: 'POST', body: json(body) });
      setOpen(false);
      onChange();
      notify(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (lead.archived_at)
    return (
      <>
        <button
          type="button"
          className="button secondary archive-action"
          disabled={busy}
          title={error || 'Put this lead back in the lead lists'}
          onClick={() => void call('/restore', {}, lead.name + ' restored to the lead list.')}
        >
          <ArchiveRestore size={15} />
          Restore
        </button>
        {error && <Alert>{error}</Alert>}
      </>
    );
  return (
    <>
      <button
        type="button"
        className="button secondary archive-action"
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        <Archive size={15} />
        Archive
      </button>
      {open && (
        <Modal title={'Archive ' + lead.name} onClose={() => !busy && setOpen(false)}>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void call(
                '/archive',
                { reason, note },
                lead.name + ' archived. Restore it any time from Archived leads.',
              );
            }}
          >
            <p className="muted">
              Nothing is deleted. The lead leaves the default lists, any sequence still due to reach
              it stops, and you can restore it later.
            </p>
            <div className="archive-reasons" role="radiogroup" aria-label="Reason">
              {reasons.map((option) => (
                <label key={option.value} className="archive-reason">
                  <input
                    type="radio"
                    name="archive-reason"
                    checked={reason === option.value}
                    onChange={() => setReason(option.value)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.hint}</small>
                  </span>
                </label>
              ))}
            </div>
            {reason === 'OTHER' && (
              <label>
                Reason
                <input
                  autoFocus
                  required
                  minLength={3}
                  maxLength={300}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            )}
            {error && <Alert>{error}</Alert>}
            <div className="form-actions">
              <button type="button" className="button secondary" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? <Spinner text="Archiving…" /> : 'Archive lead'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

/**
 * The lead list's one Archive control: a menu offering to archive everything below 50 (after
 * showing the exact leads) and the archived shelf, where leads are restored.
 */
export function ArchiveTools({
  project,
  onChange,
  notify,
}: {
  project: Project;
  onChange: () => void;
  notify: (message: string) => void;
}) {
  const base = '/projects/' + project.id;
  const [view, setView] = useState<'shelf' | 'bulk' | null>(null);
  const [menu, setMenu] = useState(false),
    [archivedCount, setArchivedCount] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null),
    buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    let cancelled = false;
    // The shelf's size, fresh each time the menu opens: a lead archived from its own page
    // since the last look must count.
    api<{ total: number }>(base + '/archive')
      .then((data) => !cancelled && setArchivedCount(data.total))
      .catch(() => undefined);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [
        ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
      ];
      if (!items.length) return;
      event.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
      items[(next + items.length) % items.length].focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      cancelled = true;
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [menu, base]);
  const choose = (next: 'shelf' | 'bulk') => {
    setMenu(false);
    setView(next);
  };
  const [shelf, setShelf] = useState<{
    leads: Array<{
      id: number;
      name: string;
      score: number | null;
      archived_at: string;
      archived_reason: string;
    }>;
    total: number;
  } | null>(null);
  const [bulk, setBulk] = useState<{
    count: number;
    leads: Array<{ id: number; name: string; score: number }>;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!view) return;
    let cancelled = false;
    setError('');
    const load =
      view === 'shelf'
        ? api<NonNullable<typeof shelf>>(base + '/archive').then(
            (data) => !cancelled && setShelf(data),
          )
        : api<NonNullable<typeof bulk>>(base + '/archive/below-50').then(
            (data) => !cancelled && setBulk(data),
          );
    load.catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [view, refresh, base]);
  return (
    <>
      <div className="archive-menu" ref={menuRef}>
        <button
          ref={buttonRef}
          type="button"
          className="button secondary"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((open) => !open)}
        >
          <Archive size={16} aria-hidden="true" />
          Archive
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={'archive-menu-caret' + (menu ? ' is-open' : '')}
          />
        </button>
        {menu && (
          <div className="archive-menu-list" role="menu" aria-label="Archive">
            <button type="button" role="menuitem" onClick={() => choose('bulk')}>
              <Archive size={15} aria-hidden="true" />
              Archive leads below 50…
            </button>
            <button type="button" role="menuitem" onClick={() => choose('shelf')}>
              <ArchiveRestore size={15} aria-hidden="true" />
              <span>
                View archived leads
                {archivedCount !== null && (
                  <span className="archive-menu-count"> ({archivedCount.toLocaleString()})</span>
                )}
              </span>
            </button>
          </div>
        )}
      </div>
      {view === 'shelf' && (
        <Modal title="Archived leads" wide onClose={() => setView(null)}>
          <div className="form-stack">
            <p className="muted">
              Archived leads are hidden from the lists and never emailed. Restoring puts a lead back
              exactly as it was.
            </p>
            {error && <Alert>{error}</Alert>}
            {!shelf ? (
              <Spinner />
            ) : !shelf.leads.length ? (
              <p className="muted">Nothing is archived in {project.name}.</p>
            ) : (
              <ul className="archive-list">
                {shelf.leads.map((lead) => (
                  <li key={lead.id}>
                    <span>
                      <a href={'#projects/' + project.id + '/leads/' + lead.id + '/overview'}>
                        <strong>{lead.name}</strong>
                      </a>
                      <small>
                        {lead.archived_reason} · {date(lead.archived_at)}
                        {lead.score !== null ? ' · fit ' + lead.score : ''}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api(base + '/leads/' + lead.id + '/restore', {
                            method: 'POST',
                            body: json({}),
                          });
                          setRefresh((n) => n + 1);
                          onChange();
                          notify(lead.name + ' restored to the lead list.');
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <ArchiveRestore size={14} />
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {shelf && shelf.total > shelf.leads.length && (
              <small className="muted">Showing the {shelf.leads.length} most recent.</small>
            )}
          </div>
        </Modal>
      )}
      {view === 'bulk' && (
        <Modal title="Archive leads scoring below 50" onClose={() => !busy && setView(null)}>
          <div className="form-stack">
            {error && <Alert>{error}</Alert>}
            {!bulk ? (
              <Spinner />
            ) : !bulk.count ? (
              <p className="muted">No analysed lead in {project.name} scores below 50.</p>
            ) : (
              <>
                <p>
                  <strong>
                    {bulk.count} lead{bulk.count === 1 ? '' : 's'}
                  </strong>{' '}
                  scored below 50 on their latest analysis. They will be archived with the reason
                  “Score below 50”: hidden from the lists, never emailed, and restorable. Nothing is
                  deleted.
                </p>
                <ul className="archive-list compact">
                  {bulk.leads.map((lead) => (
                    <li key={lead.id}>
                      <span>{lead.name}</span>
                      <small>fit {lead.score}</small>
                    </li>
                  ))}
                </ul>
                {bulk.count > bulk.leads.length && (
                  <small className="muted">…and {bulk.count - bulk.leads.length} more.</small>
                )}
              </>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setView(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || !bulk?.count}
                onClick={async () => {
                  if (!bulk) return;
                  setBusy(true);
                  setError('');
                  try {
                    const result = await api<{ archived: number }>(base + '/archive/below-50', {
                      method: 'POST',
                      body: json({ confirm: true, expected: bulk.count }),
                    });
                    setView(null);
                    onChange();
                    notify(
                      result.archived + ' lead' + (result.archived === 1 ? '' : 's') + ' archived.',
                    );
                  } catch (e) {
                    setError((e as Error).message);
                    setRefresh((n) => n + 1);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Spinner text="Archiving…" /> : 'Archive ' + (bulk?.count || '') + ' leads'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

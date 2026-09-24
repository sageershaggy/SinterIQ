import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, LogOut, Settings as SettingsIcon, ShieldCheck } from 'lucide-react';
import type { User } from '../shared/types';
import './AccountMenu.css';

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';

/**
 * The signed-in account, top right. Workspace settings, the profile and signing out live here
 * rather than at the foot of the sidebar, so the sidebar holds only navigation.
 */
export function AccountMenu({
  user,
  active,
  onSettings,
  onLogout,
}: {
  user: User;
  /** The settings page is open, so the trigger shows where you are. */
  active: boolean;
  onSettings: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const role = user.role === 'admin' ? 'Administrator' : 'Researcher';
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
    <div className="account-menu" ref={root}>
      <button
        ref={trigger}
        className={'account-trigger' + (active ? ' is-active' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account and workspace settings for ${user.name}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="account-trigger-label">
          <ShieldCheck size={14} aria-hidden="true" />
          Team workspace
        </span>
        <span className="account-avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
        <ChevronDown size={14} className={open ? 'is-open' : ''} aria-hidden="true" />
      </button>
      {open && (
        <div className="account-dropdown" id={menuId} role="menu" aria-label="Account">
          <div className="account-profile" role="none">
            <span className="account-avatar large" aria-hidden="true">
              {initials(user.name)}
            </span>
            <div>
              <strong>{user.name}</strong>
              <small>
                @{user.username} · {role}
              </small>
            </div>
          </div>
          <p className="account-workspace" role="none">
            Research workspace · Team workspace
          </p>
          <button
            role="menuitem"
            className={active ? 'is-current' : ''}
            aria-current={active ? 'page' : undefined}
            onClick={choose(onSettings)}
          >
            <SettingsIcon size={16} aria-hidden="true" />
            Workspace settings
          </button>
          <button role="menuitem" className="account-signout" onClick={choose(onLogout)}>
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

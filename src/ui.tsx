import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { X, ArrowUpRight, LoaderCircle, AlertCircle } from 'lucide-react';
import { label, safeHref } from './api';

export function Brand() {
  return (
    <div className="brand">
      <img src="/branding/innovista.svg" width="38" height="38" alt="" />
      <div>
        <strong>innovista</strong>
        <small>RESEARCH AI</small>
      </div>
    </div>
  );
}
/**
 * A textarea that grows with what is in it, up to a ceiling. Long lists of rules were read
 * through a scrollbar inside the page's own scroll, with every line after the fourth cut off
 * mid-sentence; past the ceiling it scrolls again, so one enormous paste cannot push the
 * rest of the form off the screen.
 */
export function GrowingTextarea({
  maxHeight = 560,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { maxHeight?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Overflow is left to the browser rather than forced hidden: at the fitted height no
  // scrollbar is drawn anyway, and if someone drags the box smaller the text stays reachable.
  const fit = () => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = Math.min(element.scrollHeight + 2, maxHeight) + 'px';
  };
  // Layout, not a plain effect: measuring after paint would show one frame at the old height.
  useLayoutEffect(fit, [props.value, maxHeight]);
  useEffect(() => {
    // Text rewraps whenever the box gets narrower or wider, which a window resize does not
    // cover (a sidebar opening does it too). Only width is watched: fitting changes the
    // height, and reacting to that would loop.
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <textarea ref={ref} {...props} />;
}
export function Spinner({ text = 'Loading…' }: { text?: string }) {
  return (
    <span className="loading" role="status">
      <LoaderCircle size={17} className="spin" />
      {text}
    </span>
  );
}
export function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="alert" role="alert">
      <AlertCircle size={18} />
      <span>{children}</span>
    </div>
  );
}
export function Badge({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <span className={'badge badge-' + value.toLowerCase()}>
      <i />
      {children || label(value)}
    </span>
  );
}
export function ExternalLink({ url, children }: { url: string; children?: ReactNode }) {
  const href = safeHref(url);
  return href ? (
    <a className="external-link" href={href} target="_blank" rel="noreferrer">
      {children || new URL(href).hostname.replace(/^www\./, '')}
      <ArrowUpRight size={13} />
    </a>
  ) : (
    <span className="muted">No website</span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select')?.focus();
    const cancel = (event: Event) => {
      event.preventDefault();
      closeRef.current();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog ref={ref} className={'modal ' + (wide ? 'modal-wide' : '')} aria-labelledby={titleId}>
      <header>
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog">
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

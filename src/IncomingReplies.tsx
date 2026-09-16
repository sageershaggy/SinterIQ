import { useEffect, useState, type FormEvent } from 'react';
import { Reply, RefreshCw, Send } from 'lucide-react';
import type { IncomingMessage } from '../shared/mailbox';
import { api, json } from './api';
import { Alert, Spinner } from './ui';

export function ReplyForm({
  base,
  message,
  onSent,
}: {
  base: string;
  message: { id: number; from_email: string; subject: string };
  onSent: () => void;
}) {
  const [opened, setOpened] = useState(false),
    [body, setBody] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(base + '/email', {
        method: 'POST',
        body: json({
          to: message.from_email,
          subject: ('Re: ' + message.subject.replace(/^re:\s*/i, '')).slice(0, 200),
          body,
          reply_to_message_id: message.id,
        }),
      });
      setSent(true);
      setOpened(false);
      setBody('');
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mail-reply">
      {sent && <p role="status">Reply sent and added to this lead’s email history.</p>}
      {error && <Alert>{error}</Alert>}
      {!opened ? (
        <button
          className="button secondary"
          disabled={!message.from_email}
          onClick={() => {
            setOpened(true);
            setSent(false);
          }}
        >
          <Reply size={15} /> Reply
        </button>
      ) : (
        <form onSubmit={send}>
          <label>
            Reply to
            <input value={message.from_email} readOnly />
          </label>
          <label>
            Your reply
            <textarea
              rows={6}
              required
              minLength={20}
              maxLength={20000}
              value={body}
              disabled={busy}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <p className="muted">
            Sends through this project's mailbox. Recipient limits and opt-outs still apply.
          </p>
          <div className="form-actions">
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => setOpened(false)}
            >
              Close reply
            </button>
            <button className="button primary" disabled={busy || body.trim().length < 20}>
              <Send size={15} />
              {busy ? 'Sending…' : 'Send reply'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function IncomingReplies({ base, onSent }: { base: string; onSent: () => void }) {
  const [messages, setMessages] = useState<IncomingMessage[]>([]),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  const [more, setMore] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api<IncomingMessage[]>(base + '/incoming')
      .then((items) => {
        if (!cancelled) {
          setMessages(items);
          setMore(items.length === 30);
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
  }, [base, refresh]);
  return (
    <section className="incoming-replies">
      <div className="section-title">
        <h3>Incoming replies</h3>
        <button className="button secondary small" onClick={() => setRefresh((n) => n + 1)}>
          <RefreshCw size={14} /> Refresh replies
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {loading ? (
        <Spinner text="Loading replies…" />
      ) : (
        !messages.length && (
          <p className="muted">
            No linked incoming messages yet. An administrator connects this project's inbox on its
            Mailbox screen.
          </p>
        )
      )}
      {messages.map((message) => (
        <details className="mail-thread" key={message.id}>
          <summary>
            <strong>{message.subject}</strong>
            <span>
              {message.from_name || message.from_email} ·{' '}
              {new Date(message.received_at).toLocaleString()}
            </span>
          </summary>
          <p className="preserve-text">{message.body}</p>
          {message.notice && <p className="muted">{message.notice}</p>}
          <ReplyForm base={base} message={message} onSent={onSent} />
        </details>
      ))}
      {more && (
        <button
          className="button secondary"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            setError('');
            try {
              const items = await api<IncomingMessage[]>(
                base + '/incoming?before=' + messages.at(-1)!.id,
              );
              setMessages((current) => [...current, ...items]);
              setMore(items.length === 30);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setLoading(false);
            }
          }}
        >
          Older replies
        </button>
      )}
    </section>
  );
}

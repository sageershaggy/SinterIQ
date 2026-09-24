import { useEffect, useState } from 'react';
import { Image as ImageIcon, Paperclip } from 'lucide-react';
import type { EmailMessage } from '../shared/types';
import { api, date } from './api';
import { Badge } from './ui';
import { fileUrl, formatSize } from './emailFiles';
import './EmailTab.css';

interface SentFile {
  id: number;
  filename: string;
  size: number;
  disposition: 'attachment' | 'inline';
}

/** Everything sent to this lead, newest first, with the files each message carried. */
export function EmailHistory({ base, emails }: { base: string; emails: EmailMessage[] }) {
  const projectId = Number(base.split('/leads/')[0].split('/').pop());
  const [files, setFiles] = useState<Record<number, SentFile[]>>({});
  const newest = emails[0]?.id;
  useEffect(() => {
    let cancelled = false;
    if (!emails.length) return;
    api<Record<number, SentFile[]>>(base + '/email/files')
      .then((result) => {
        if (!cancelled) setFiles(result);
      })
      .catch(() => {
        // The history itself is still worth showing without its file list.
      });
    return () => {
      cancelled = true;
    };
  }, [base, newest]);
  return (
    <section className="email-history">
      <h3>Outgoing email history</h3>
      {emails.length ? (
        emails.map((message) => (
          <div className="human-review-history" key={message.id}>
            <div>
              <Badge value={message.status === 'SENT' ? 'QUALIFIED' : 'NEEDS_REVIEW'}>
                {message.status === 'SENT' ? 'Sent' : 'Delivery not confirmed'}
              </Badge>
              <small>
                {message.to_email} · {message.created_by} · {date(message.created_at)}
              </small>
            </div>
            <p>
              <strong>{message.subject}</strong>
            </p>
            <p className="preserve-text">{message.body}</p>
            {files[message.id]?.length > 0 && (
              <ul className="email-history-files">
                {files[message.id].map((file) => (
                  <li key={file.id}>
                    {file.disposition === 'inline' ? (
                      <ImageIcon size={13} />
                    ) : (
                      <Paperclip size={13} />
                    )}
                    <a href={fileUrl(projectId, file.id)} target="_blank" rel="noreferrer">
                      {file.filename}
                    </a>
                    <small>
                      {formatSize(file.size)}
                      {file.disposition === 'inline' ? ' · in the message' : ''}
                    </small>
                  </li>
                ))}
              </ul>
            )}
            {message.error && <p className="muted">{message.error}</p>}
          </div>
        ))
      ) : (
        <p className="muted">No emails sent to this lead yet.</p>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import type { CriteriaTemplate } from '../shared/types';
import { api } from './api';
import { Alert, Modal, Spinner } from './ui';
import './CriteriaTemplates.css';

/**
 * Picks one of the qualification criteria documents shipped with the app and adds it to the
 * project's source library. It lands as an ordinary training document: Train AI reads it into
 * draft rules, and publishing stays a separate, explicit step.
 */
export function CriteriaTemplatePicker({
  busy,
  error,
  onClose,
  onAdd,
}: {
  busy: boolean;
  error: string;
  onClose: () => void;
  onAdd: (template: string) => void;
}) {
  const [templates, setTemplates] = useState<CriteriaTemplate[] | null>(null),
    [loadError, setLoadError] = useState(''),
    [chosen, setChosen] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<CriteriaTemplate[]>('/criteria-templates')
      .then((list) => {
        if (cancelled) return;
        setTemplates(list);
        setChosen(list[0]?.id || '');
      })
      .catch((e) => {
        if (!cancelled) setLoadError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <Modal title="Add a qualification criteria document" onClose={onClose}>
      <div className="form-stack">
        <p className="muted">
          Start from written criteria instead of a blank page. The document is added to the source
          library like an upload; run Train AI to turn it into draft rules, then review and
          publish.
        </p>
        {(loadError || error) && <Alert>{loadError || error}</Alert>}
        {!templates ? (
          !loadError && <Spinner text="Loading criteria documents…" />
        ) : !templates.length ? (
          <p>No criteria documents are installed on this server.</p>
        ) : (
          <div className="criteria-template-list" role="radiogroup" aria-label="Criteria documents">
            {templates.map((template) => (
              <label
                key={template.id}
                className={'criteria-template' + (chosen === template.id ? ' is-chosen' : '')}
              >
                <input
                  type="radio"
                  name="criteria-template"
                  value={template.id}
                  checked={chosen === template.id}
                  onChange={() => setChosen(template.id)}
                />
                <span>
                  <strong>{template.title}</strong>
                  {template.summary && <small>{template.summary}</small>}
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy || !chosen}
            onClick={() => onAdd(chosen)}
          >
            {busy ? (
              <Spinner text="Adding…" />
            ) : (
              <>
                <ClipboardList size={16} />
                Add to library
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

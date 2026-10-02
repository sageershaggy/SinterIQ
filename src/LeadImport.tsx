import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Download, FileText, ScanLine, Sparkles, Upload } from 'lucide-react';
import { api, json } from './api';
import { Alert, Modal, Spinner } from './ui';
import { csvCell } from '../shared/csv';
import {
  notScreened,
  screenBatchSize,
  type ImportPreview,
  type ImportProblem,
  type ImportRowsResult,
  type PreviewRow,
  type ScreenVerdict,
} from '../shared/lead-import';
import './LeadImport.css';

/** Verdicts by file line, so a row keeps its verdict whichever batch it was screened in. */
type Verdicts = Record<number, ScreenVerdict>;
/** off: never screened · running · stopped: some rows were left unscreened · done. */
type ScreenState = 'off' | 'running' | 'stopped' | 'done';

const number = (count: number) => count.toLocaleString('en-US');
const plural = (count: number, one: string, many = one + 's') =>
  number(count) + ' ' + (count === 1 ? one : many);
/** Lists stay readable on a phone; the CSV download carries every row. */
const listLimit = 300;

/** Where each previewed row stands. Duplicates are always their own group: never screened. */
function groupRows(preview: ImportPreview, verdicts: Verdicts, screened: boolean) {
  const groups = {
    ready: [] as PreviewRow[],
    pass: [] as PreviewRow[],
    unclear: [] as PreviewRow[],
    rejected: [] as PreviewRow[],
    unscreened: [] as PreviewRow[],
    duplicate: [] as PreviewRow[],
  };
  for (const row of preview.rows) {
    const verdict = verdicts[row.row]?.verdict;
    if (row.duplicate || verdict === 'DUPLICATE') groups.duplicate.push(row);
    else if (!screened) groups.ready.push(row);
    else if (!verdict) groups.unscreened.push(row);
    else if (verdict === 'PASS') groups.pass.push(row);
    else if (verdict === 'REJECT') groups.rejected.push(row);
    else groups.unclear.push(row);
  }
  return groups;
}
const verdictLabel = (verdict: ScreenVerdict | undefined) =>
  !verdict
    ? notScreened
    : verdict.verdict === 'REJECT'
      ? 'Rejected'
      : verdict.verdict === 'PASS'
        ? 'Passes'
        : 'Not enough information';

/**
 * The rows the screen left out, as the file had them plus the verdict and its reason, so they
 * can be fixed and uploaded in the next batch. Built here because the server never stored them.
 */
function downloadLeftOut(
  filename: string,
  preview: ImportPreview,
  rows: PreviewRow[],
  verdicts: Verdicts,
) {
  const lines = [
    [...preview.columns, 'screen_verdict', 'screen_reason'],
    ...rows.map((row) => [
      ...row.cells,
      verdictLabel(verdicts[row.row]),
      verdicts[row.row]?.reason || notScreened,
    ]),
  ].map((cells) => cells.map(csvCell).join(','));
  const url = URL.createObjectURL(
    new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/\.[^.]+$/, '') + '-rejected-rows.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ImportModal({
  projectId,
  onClose,
  onImported,
  onQualify,
}: {
  projectId: number;
  onClose: () => void;
  onImported: (text: string) => void;
  /** Starts the detailed qualification on the leads this import created. */
  onQualify: (leadIds: number[]) => Promise<void>;
}) {
  const base = '/projects/' + projectId + '/leads/import';
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const [screenOn, setScreenOn] = useState(false),
    [screenState, setScreenState] = useState<ScreenState>('off'),
    [verdicts, setVerdicts] = useState<Verdicts>({}),
    [progress, setProgress] = useState({ done: 0, upTo: 0, total: 0 }),
    [stopping, setStopping] = useState(false);
  const [include, setInclude] = useState({
    pass: true,
    unclear: false,
    rejected: false,
    unscreened: false,
  });
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'update'>('skip');
  const [result, setResult] = useState<(ImportRowsResult & { summary: string }) | null>(null);
  const stop = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      // Closing the dialog stops screening after the batch in flight; nothing else is spent.
      mounted.current = false;
      stop.current = true;
    };
  }, []);

  const screened = screenState !== 'off';
  const groups = preview && groupRows(preview, verdicts, screened);
  const chosen = !groups
    ? []
    : screened
      ? [
          ...(include.pass ? groups.pass : []),
          ...(include.unclear ? groups.unclear : []),
          ...(include.rejected ? groups.rejected : []),
          ...(include.unscreened ? groups.unscreened : []),
        ]
      : groups.ready;
  const leftOut = {
    rejected: groups && screened && !include.rejected ? groups.rejected : [],
    unclear: groups && screened && !include.unclear ? groups.unclear : [],
    unscreened: groups && screened && !include.unscreened ? groups.unscreened : [],
  };
  const leftOutRows = [...leftOut.rejected, ...leftOut.unclear, ...leftOut.unscreened].sort(
    (a, b) => a.row - b.row,
  );

  async function read(next: File) {
    setFile(next);
    setPreview(null);
    setResult(null);
    setVerdicts({});
    setScreenState('off');
    setError('');
    setBusy('Reading file…');
    try {
      const data = new FormData();
      data.set('file', next);
      const loaded = await api<ImportPreview>(base + '/preview', { method: 'POST', body: data });
      if (!mounted.current) return;
      setPreview(loaded);
      setScreenOn(loaded.screening.available);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy('');
    }
  }
  /** Screens in batches the server accepts, so progress shows and Stop answers within a batch. */
  async function screen(rows: PreviewRow[]) {
    stop.current = false;
    setStopping(false);
    setError('');
    setScreenState('running');
    let done = 0;
    for (let start = 0; start < rows.length; start += screenBatchSize) {
      if (stop.current || !mounted.current) break;
      const batch = rows.slice(start, start + screenBatchSize);
      setProgress({ done, upTo: done + batch.length, total: rows.length });
      try {
        const answer = await api<{ verdicts: ScreenVerdict[] }>(base + '/screen', {
          method: 'POST',
          body: json({ rows: batch.map((row) => row.lead) }),
        });
        if (!mounted.current) return;
        setVerdicts((current) => {
          const next = { ...current };
          for (const verdict of answer.verdicts)
            if (batch[verdict.index]) next[batch[verdict.index].row] = verdict;
          return next;
        });
        done += batch.length;
      } catch (e) {
        // A refused batch (a rate limit, a provider error) stops the pass; what was screened stays.
        if (mounted.current) setError((e as Error).message);
        break;
      }
    }
    if (!mounted.current) return;
    setStopping(false);
    setScreenState(done < rows.length ? 'stopped' : 'done');
  }
  async function importChosen() {
    if (!preview || !groups) return;
    setBusy('Importing…');
    setError('');
    try {
      // Rows already in the project go along: the server skips or updates them by its own
      // matching, exactly as a file import does, and reports them back.
      const rows = [...chosen, ...groups.duplicate].sort((a, b) => a.row - b.row);
      const imported = await api<ImportRowsResult>(base + '/rows', {
        method: 'POST',
        body: json({
          leads: rows.map((row) => row.lead),
          on_duplicate: onDuplicate,
          ...(screened
            ? {
                screened: {
                  rejected: leftOut.rejected.length,
                  unclear: leftOut.unclear.length + leftOut.unscreened.length,
                },
              }
            : {}),
        }),
      });
      if (!mounted.current) return;
      const kept = [number(imported.created) + ' imported'];
      if (imported.updated) kept.push(number(imported.updated) + ' updated');
      if (imported.skipped) kept.push(number(imported.skipped) + ' already in this project');
      const out = [
        leftOut.rejected.length ? number(leftOut.rejected.length) + ' rejected' : '',
        leftOut.unclear.length ? number(leftOut.unclear.length) + ' not enough information' : '',
        leftOut.unscreened.length ? number(leftOut.unscreened.length) + ' not screened' : '',
      ].filter(Boolean);
      const summary = [...kept, ...out].join(' · ') + (out.length ? ' (not imported)' : '');
      setResult({ ...imported, summary });
      onImported(summary + '.');
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy('');
    }
  }
  async function qualify(ids: number[]) {
    setBusy('Starting…');
    setError('');
    try {
      await onQualify(ids);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy('');
    }
  }

  const toScreen = groups ? groups.ready.length : 0;
  const reasonOf = (row: PreviewRow) =>
    row.duplicate
      ? 'Matches ' + row.duplicate.name + ' in this project.'
      : verdicts[row.row]?.reason || '';
  const downloadButton = leftOutRows.length > 0 && preview && file && (
    <button
      className="text-button"
      type="button"
      onClick={() => downloadLeftOut(file.name, preview, leftOutRows, verdicts)}
    >
      <Download size={15} />
      Download rejected rows (CSV)
    </button>
  );

  return (
    <Modal title="Import research leads" onClose={onClose}>
      <div className="form-stack lead-import">
        {!preview && (
          <>
            <p className="muted">
              Import up to 5,000 leads from CSV, TSV, plain text, JSON or Excel (.xlsx). The file is
              checked first and nothing is saved until you choose what to import. A lead already in
              this project is matched on company name or website domain.
            </p>
            <div className="csv-example">
              <strong>CSV column headers</strong>
              <code>
                name,website,country,city,industry,employee_count,contact_name,contact_role,contact_email,contact_phone,notes
              </code>
              <small>
                Only the company name is required. Common export headings are recognised too —
                Company Name, Company Website, Company Size, Full Name, Job Title, Emails, Phone
                Numbers, Locality. A row with no company name is reported and skipped, because a
                lead is a company.
              </small>
            </div>
            <a className="text-button" href="/branding/leads-template.csv" download>
              <Download size={15} />
              Download CSV template
            </a>
            <label className="upload-zone">
              <Upload size={27} />
              <strong>{file?.name || 'Choose a CSV file'}</strong>
              <small>CSV · TSV · TXT · JSON · XLSX — up to 4 MB, 5,000 rows</small>
              <input
                type="file"
                accept=".csv,.tsv,.txt,.json,.xlsx,text/csv,application/json"
                disabled={Boolean(busy)}
                onChange={(e) => {
                  const next = e.target.files?.[0];
                  if (next) void read(next);
                }}
              />
            </label>
          </>
        )}

        {preview && groups && file && !result && (
          <>
            <div className="import-file">
              <FileText size={17} />
              <span>
                <strong>{file.name}</strong>
                <small>{plural(preview.total, 'row')} read</small>
              </span>
              {screenState !== 'running' && !busy && (
                <label className="text-button import-file-change">
                  Choose another file
                  <input
                    type="file"
                    accept=".csv,.tsv,.txt,.json,.xlsx,text/csv,application/json"
                    onChange={(e) => {
                      const next = e.target.files?.[0];
                      if (next) void read(next);
                    }}
                  />
                </label>
              )}
            </div>
            <ProblemList
              summary={plural(preview.problems.length, 'row') + ' cannot be imported'}
              items={preview.problems}
            />
            <ProblemList
              summary={
                plural(preview.warnings.length, 'row has', 'rows have') +
                ' no usable website; it will be left blank'
              }
              items={preview.warnings}
            />

            {screenState === 'off' && (
              <ImportGroup
                tone="ready"
                title="Ready to import"
                rows={groups.ready}
                reasonOf={reasonOf}
              />
            )}

            {screenState === 'running' && (
              <div className="import-progress" role="status">
                <div className="import-progress-line">
                  <ScanLine size={16} />
                  <strong>
                    Screening {number(progress.upTo)} of {number(progress.total)}…
                  </strong>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={stopping}
                    onClick={() => {
                      stop.current = true;
                      setStopping(true);
                    }}
                  >
                    {stopping ? 'Stopping…' : 'Stop'}
                  </button>
                </div>
                <div className="import-progress-bar">
                  <span
                    style={{ width: (progress.done / Math.max(progress.total, 1)) * 100 + '%' }}
                  />
                </div>
                <small>
                  {groups.pass.length} pass · {groups.rejected.length} rejected ·{' '}
                  {groups.unclear.length} not enough information so far
                </small>
              </div>
            )}

            {(screenState === 'stopped' || screenState === 'done') && (
              <>
                <p className="import-screen-status">
                  {screenState === 'done'
                    ? 'Quick screen finished. Choose what to import.'
                    : 'Quick screen stopped. ' +
                      plural(groups.unscreened.length, 'row was', 'rows were') +
                      ' not screened.'}
                  {screenState === 'stopped' && (
                    <button
                      className="text-button"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => void screen(groups.unscreened)}
                    >
                      Screen the rest
                    </button>
                  )}
                </p>
                <ImportGroup
                  tone="pass"
                  title="Passes"
                  hint="Likely fit, from what the row says."
                  rows={groups.pass}
                  reasonOf={reasonOf}
                  verdicts={verdicts}
                  checked={include.pass}
                  onCheck={(pass) => setInclude({ ...include, pass })}
                />
                <ImportGroup
                  tone="unclear"
                  title="Not enough information"
                  hint="The row is too thin to judge. Tick to import these and let the detailed qualification decide."
                  rows={groups.unclear}
                  reasonOf={reasonOf}
                  verdicts={verdicts}
                  checked={include.unclear}
                  onCheck={(unclear) => setInclude({ ...include, unclear })}
                />
                {groups.unscreened.length > 0 && (
                  <ImportGroup
                    tone="unclear"
                    title="Not screened"
                    hint="Screening stopped before these rows."
                    rows={groups.unscreened}
                    reasonOf={() => notScreened}
                    checked={include.unscreened}
                    onCheck={(unscreened) => setInclude({ ...include, unscreened })}
                  />
                )}
                <ImportGroup
                  tone="rejected"
                  title="Rejected"
                  hint="The row itself matches an exclusion or misses a must-have."
                  rows={groups.rejected}
                  reasonOf={reasonOf}
                  verdicts={verdicts}
                >
                  {groups.rejected.length > 0 && (
                    <label className="checkbox-label import-also">
                      <input
                        type="checkbox"
                        checked={include.rejected}
                        onChange={(e) => setInclude({ ...include, rejected: e.target.checked })}
                      />
                      Also import rejected rows
                    </label>
                  )}
                </ImportGroup>
              </>
            )}

            {groups.duplicate.length > 0 && screenState !== 'running' && (
              <ImportGroup
                tone="duplicate"
                title="Already in this project"
                hint="Matched on company name or website domain. Never sent to the AI."
                rows={groups.duplicate}
                reasonOf={reasonOf}
              >
                <select
                  value={onDuplicate}
                  aria-label="When a company is already in this project"
                  disabled={Boolean(busy)}
                  onChange={(e) => setOnDuplicate(e.target.value as 'skip' | 'update')}
                >
                  <option value="skip">Skip them and keep what is already there</option>
                  <option value="update">Update them with the details in this file</option>
                </select>
              </ImportGroup>
            )}
            {screenState === 'off' && (
              <label className="import-screen-option">
                <input
                  type="checkbox"
                  checked={screenOn}
                  disabled={!preview.screening.available}
                  onChange={(e) => setScreenOn(e.target.checked)}
                />
                <span>
                  <strong>Quick-screen rows against the training before importing</strong>
                  <small>
                    {preview.screening.available
                      ? 'A fast AI check of what each row says — no websites are opened. Rows that fail are not imported. The detailed, evidence-backed qualification still runs afterwards.'
                      : preview.screening.reason}
                  </small>
                </span>
              </label>
            )}
            {screenState !== 'running' && downloadButton}
          </>
        )}

        {result && (
          <>
            <div className="import-result">
              <CheckCircle2 size={19} />
              <strong>{result.summary}</strong>
              <ProblemList
                summary={plural(preview!.problems.length, 'row') + ' could not be imported'}
                items={preview!.problems}
              />
              {result.duplicates.length > 0 && (
                <details>
                  <summary>Companies left unchanged</summary>
                  <ul>
                    {result.duplicates.slice(0, listLimit).map((name, i) => (
                      <li key={i}>{name}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            {downloadButton}
            {result.created_ids.length > 0 && (
              <div className="import-next">
                <Sparkles size={18} />
                <span>
                  <strong>
                    Next: run the detailed AI qualification on the{' '}
                    {plural(result.created_ids.length, 'imported lead')}
                  </strong>
                  <small>
                    It reads each company&apos;s own website and checks every rule, so it takes
                    longer and costs more than the quick screen.
                  </small>
                </span>
                <button
                  className="button primary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void qualify(result.created_ids)}
                >
                  {busy ? <Spinner text={busy} /> : 'Qualify imported leads'}
                </button>
              </div>
            )}
          </>
        )}

        {busy && !result && <Spinner text={busy} />}
        {error && <Alert>{error}</Alert>}
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </button>
          {preview && !result && screenState === 'off' && screenOn && (
            <button
              className="button primary"
              type="button"
              disabled={Boolean(busy) || !toScreen}
              onClick={() => void screen(groups!.ready)}
            >
              Quick-screen {plural(toScreen, 'row')}
            </button>
          )}
          {preview &&
            !result &&
            screenState !== 'running' &&
            !(screenState === 'off' && screenOn) && (
              <button
                className="button primary"
                type="button"
                disabled={
                  Boolean(busy) ||
                  (!chosen.length && !(onDuplicate === 'update' && groups!.duplicate.length))
                }
                onClick={() => void importChosen()}
              >
                {chosen.length || onDuplicate !== 'update' || !groups!.duplicate.length
                  ? 'Import ' + plural(chosen.length, 'lead')
                  : 'Update ' + plural(groups!.duplicate.length, 'existing lead')}
              </button>
            )}
        </div>
      </div>
    </Modal>
  );
}

/** One group of rows: its count, what it means, its choice, and the rows with their reasons. */
function ImportGroup({
  tone,
  title,
  hint,
  rows,
  reasonOf,
  verdicts,
  checked,
  onCheck,
  children,
}: {
  tone: 'ready' | 'pass' | 'unclear' | 'rejected' | 'duplicate';
  title: string;
  hint?: string;
  rows: PreviewRow[];
  reasonOf: (row: PreviewRow) => string;
  verdicts?: Verdicts;
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  children?: ReactNode;
}) {
  const heading = (
    <>
      <strong>{title}</strong>
      <span className="import-group-count">{number(rows.length)}</span>
    </>
  );
  return (
    <section className={'import-group is-' + tone}>
      {onCheck ? (
        <label className="import-group-head">
          <input
            type="checkbox"
            checked={Boolean(checked)}
            disabled={!rows.length}
            onChange={(e) => onCheck(e.target.checked)}
          />
          {heading}
        </label>
      ) : (
        <div className="import-group-head">{heading}</div>
      )}
      {hint && <small>{hint}</small>}
      {children}
      {rows.length > 0 && (
        <details>
          <summary>Show {plural(rows.length, 'row')}</summary>
          <ul className="import-rows">
            {rows.slice(0, listLimit).map((row) => {
              const rule = verdicts?.[row.row]?.rule;
              const reason = reasonOf(row);
              return (
                <li key={row.row}>
                  <span>
                    <strong>Row {row.row}</strong> · {row.lead.name}
                  </span>
                  {reason && <span className="import-row-reason">{reason}</span>}
                  {rule && !reason.includes(rule) && <small>Rule: {rule}</small>}
                </li>
              );
            })}
            {rows.length > listLimit && (
              <li className="muted">…and {number(rows.length - listLimit)} more.</li>
            )}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Rows that cannot be imported, or that lose something on the way in, with the reason. */
function ProblemList({ summary, items }: { summary: string; items: ImportProblem[] }) {
  if (!items.length) return null;
  return (
    <details className="import-problems">
      <summary>{summary}</summary>
      <ul>
        {items.slice(0, listLimit).map((item, i) => (
          <li key={i}>
            <strong>Row {item.row}</strong>
            {item.name === '(no company)' ? '' : ' · ' + item.name} — {item.reason}
          </li>
        ))}
        {items.length > listLimit && <li>…and {number(items.length - listLimit)} more.</li>}
      </ul>
    </details>
  );
}

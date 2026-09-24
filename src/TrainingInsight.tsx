import { useId } from 'react';
import { AlertTriangle, CheckCircle2, FileWarning } from 'lucide-react';
import type { Rubric, Source } from '../shared/types';
import type { SourceUpload, TrainingGraph } from '../shared/research';
import { date } from './api';
import './TrainingInsight.css';

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Whether a source is part of the published version, compared by content fingerprint: the
 * published snapshot keeps the text it was approved with, so a match means exactly this text.
 */
export function SourceStatus({
  source,
  upload,
  publishedHashes,
  activeVersion,
}: {
  source: Source;
  upload?: SourceUpload;
  publishedHashes: Set<string> | null;
  activeVersion: number | null;
}) {
  const count = upload?.words || words(source.content);
  const published = publishedHashes?.has(source.sha256);
  return (
    <span className="source-status">
      <span className="source-status-read">
        <CheckCircle2 size={13} />
        {source.kind === 'document'
          ? 'Uploaded and read'
          : source.kind === 'website'
            ? 'Captured and read'
            : 'Saved'}
      </span>
      <span>
        {source.content.length.toLocaleString()} characters · {count.toLocaleString()} words
      </span>
      {activeVersion && publishedHashes && (
        <span className={'source-status-version' + (published ? ' is-published' : '')}>
          {published ? 'In published v' + activeVersion : 'New since v' + activeVersion}
        </span>
      )}
    </span>
  );
}

/** Uploads that did not make it into the library, with the reason, so none fails silently. */
export function UploadProblems({ uploads, sources }: { uploads: SourceUpload[]; sources: Source[] }) {
  // A failure that was later uploaded successfully under the same name is no longer a problem.
  const failed = uploads
    .filter((item) => item.status === 'FAILED')
    .filter((item) => !sources.some((source) => source.filename === item.filename))
    .slice(0, 8);
  if (!failed.length) return null;
  return (
    <div className="upload-problems" role="status">
      <strong>
        <FileWarning size={15} />
        {failed.length === 1 ? 'One upload was not read' : failed.length + ' uploads were not read'}
      </strong>
      <ul>
        {failed.map((item) => (
          <li key={item.id}>
            <span className="upload-problem-name">{item.filename}</span>
            <span>{item.reason}</span>
            <small>
              {date(item.created_at)} · {item.created_by} · not in the library
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The editor's rules, in the shape the diff and the graph read. */
export interface DraftRules {
  summary: string;
  criteria: string[];
  exclusions: string[];
}
const norm = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
function listDiff(published: string[], draft: string[]) {
  const before = new Set(published.map(norm));
  const after = new Set(draft.map(norm));
  return {
    added: draft.filter((item) => !before.has(norm(item))),
    removed: published.filter((item) => !after.has(norm(item))),
    kept: draft.filter((item) => before.has(norm(item))).length,
  };
}
/**
 * What the draft in the editor changes against the published version, rule by rule. Shown
 * after Train AI and whenever the draft differs, so publishing is a decision about known
 * changes rather than a leap.
 */
export function TrainingDiff({
  published,
  version,
  draft,
}: {
  published: Rubric;
  version: number;
  draft: DraftRules;
}) {
  const criteria = listDiff(published.criteria, draft.criteria);
  const exclusions = listDiff(published.exclusions, draft.exclusions);
  const summaryChanged = norm(published.summary) !== norm(draft.summary);
  const changes =
    criteria.added.length +
    criteria.removed.length +
    exclusions.added.length +
    exclusions.removed.length +
    (summaryChanged ? 1 : 0);
  if (!changes) return null;
  const section = (title: string, diff: ReturnType<typeof listDiff>) =>
    diff.added.length || diff.removed.length ? (
      <div className="diff-section">
        <h4>
          {title} <small>{diff.kept} unchanged</small>
        </h4>
        <ul>
          {diff.added.map((item) => (
            <li key={'+' + item} className="diff-added">
              <span aria-hidden="true">+</span>
              <span className="visually-hidden">Added: </span>
              {item}
            </li>
          ))}
          {diff.removed.map((item) => (
            <li key={'-' + item} className="diff-removed">
              <span aria-hidden="true">−</span>
              <span className="visually-hidden">Removed: </span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <section className="training-diff" aria-label={'Changes against published v' + version}>
      <div className="training-diff-head">
        <strong>Changes against published v{version}</strong>
        <span>
          {changes} change{changes === 1 ? '' : 's'} · not in use until you approve and publish
        </span>
      </div>
      {summaryChanged && <p className="diff-note">The business context and ideal customer text changed.</p>}
      {section('Positive criteria', criteria)}
      {section('Exclusion rules', exclusions)}
    </section>
  );
}

const stop = new Set(
  'about above after again against among because before being below between both could does doing during each every from further have having into itself more most other ought over same should some such than that their theirs them then there these they this those through under until very were what when where which while whom with would your yours company companies business businesses lead leads rule rules must also only'.split(
    ' ',
  ),
);
/** The words that make a rule this rule, for finding which sources talk about it. */
function keywords(rule: string) {
  return [
    ...new Set(
      rule
        .toLowerCase()
        .replace(/[^a-z0-9äöüß]+/g, ' ')
        .split(' ')
        .filter((word) => word.length >= 5 && !stop.has(word)),
    ),
  ];
}
/** A source is linked to a rule when it uses enough of the rule's own key words. */
export function linkedSources(rule: string, sources: Source[]) {
  const wanted = keywords(rule);
  if (!wanted.length) return [];
  return sources.filter((source) => {
    const text = source.content.toLowerCase();
    const hits = wanted.filter((word) => text.includes(word)).length;
    return hits >= Math.min(2, wanted.length) && hits / wanted.length >= 0.34;
  });
}
const clip = (text: string, length: number) =>
  text.length > length ? text.slice(0, length - 1).trimEnd() + '…' : text;

/**
 * Sources → rules → lead outcomes, drawn inline. A line from a source to a rule means the
 * source uses the rule's key words; the bar beside a rule is how the leads qualified against
 * the published version came out on it. The same data is available as a table.
 */
export function TrainingGraphView({
  sources,
  draft,
  graph,
}: {
  sources: Source[];
  draft: DraftRules;
  graph: TrainingGraph | null;
}) {
  const titleId = useId();
  const descId = useId();
  const rules = [
    ...draft.criteria.map((text, index) => ({ kind: 'criterion' as const, text, code: 'C' + (index + 1) })),
    ...draft.exclusions.map((text, index) => ({ kind: 'exclusion' as const, text, code: 'X' + (index + 1) })),
  ].map((rule) => ({
    ...rule,
    links: linkedSources(rule.text, sources).map((source) => source.id),
    outcome: graph?.rules.find((item) => item.kind === rule.kind && norm(item.text) === norm(rule.text)),
  }));
  const evaluated = graph?.leads_evaluated || 0;
  const row = 48;
  const top = 44;
  const height = top + Math.max(rules.length, sources.length, 1) * row + 12;
  const sourceY = (index: number) => top + index * row + row / 2;
  const ruleY = (index: number) => top + index * row + row / 2;
  const unlinked = rules.filter((rule) => !rule.links.length).length;
  const description =
    sources.length +
    ' sources, ' +
    draft.criteria.length +
    ' criteria and ' +
    draft.exclusions.length +
    ' exclusions. ' +
    (evaluated
      ? evaluated + ' leads evaluated against published version ' + graph?.version + '.'
      : 'No leads have been evaluated against the published version yet.');
  return (
    <div className="training-graph">
      <div className="training-graph-summary">
        <span>
          <strong>{evaluated}</strong> lead{evaluated === 1 ? '' : 's'} evaluated
          {graph?.version ? ' on published v' + graph.version : ''}
        </span>
        {!!evaluated && graph && (
          <span>
            {graph.decisions.QUALIFIED} qualified · {graph.decisions.NEEDS_REVIEW} need review ·{' '}
            {graph.decisions.NOT_A_TARGET} not a target
          </span>
        )}
        <span className="graph-legend" aria-hidden="true">
          <i className="is-meets" /> Meets <i className="is-not" /> Does not meet{' '}
          <i className="is-unable" /> Unable to verify
        </span>
      </div>
      <div className="training-graph-canvas">
        <svg
          viewBox={'0 0 960 ' + height}
          role="img"
          aria-labelledby={titleId + ' ' + descId}
          preserveAspectRatio="xMinYMin meet"
        >
          <title id={titleId}>Training graph: sources, rules and lead outcomes</title>
          <desc id={descId}>{description}</desc>
          <text x="0" y="20" className="graph-heading">SOURCES</text>
          <text x="300" y="20" className="graph-heading">RULES</text>
          <text x="690" y="20" className="graph-heading">LEAD OUTCOMES</text>
          {rules.map((rule, ruleIndex) =>
            rule.links.map((sourceId) => {
              const sourceIndex = sources.findIndex((source) => source.id === sourceId);
              const y1 = sourceY(sourceIndex);
              const y2 = ruleY(ruleIndex);
              return (
                <path
                  key={rule.code + '-' + sourceId}
                  d={`M 210 ${y1} C 255 ${y1}, 255 ${y2}, 300 ${y2}`}
                  className={'graph-edge' + (rule.kind === 'exclusion' ? ' is-exclusion' : '')}
                />
              );
            }),
          )}
          {sources.map((source, index) => (
            <g key={source.id} transform={`translate(0 ${sourceY(index) - 17})`}>
              <rect width="210" height="34" rx="7" className={'graph-node is-source is-' + source.kind} />
              <text x="10" y="15" className="graph-label">
                {clip(source.title, 30)}
              </text>
              <text x="10" y="27" className="graph-sub">
                {source.kind === 'website' ? 'Website' : source.kind === 'document' ? 'Document' : 'Notes'} ·{' '}
                {source.content.length.toLocaleString()} chars
              </text>
              <title>{source.title}</title>
            </g>
          ))}
          {rules.map((rule, index) => {
            const y = ruleY(index);
            const outcome = rule.outcome;
            const total = outcome ? outcome.meets + outcome.does_not_meet + outcome.unable : 0;
            const scale = (value: number) => (total ? (value / total) * 190 : 0);
            return (
              <g key={rule.code}>
                <g transform={`translate(300 ${y - 17})`}>
                  <rect
                    width="370"
                    height="34"
                    rx="7"
                    className={'graph-node is-rule' + (rule.kind === 'exclusion' ? ' is-exclusion' : '')}
                  />
                  <text x="10" y="21" className="graph-label">
                    <tspan className="graph-code">{rule.code}</tspan> {clip(rule.text, 52)}
                  </text>
                  <title>{rule.text}</title>
                </g>
                <g transform={`translate(690 ${y - 9})`}>
                  {total ? (
                    <>
                      <rect width={scale(outcome!.meets)} height="18" className="graph-bar is-meets" />
                      <rect x={scale(outcome!.meets)} width={scale(outcome!.does_not_meet)} height="18" className="graph-bar is-not" />
                      <rect
                        x={scale(outcome!.meets) + scale(outcome!.does_not_meet)}
                        width={scale(outcome!.unable)}
                        height="18"
                        className="graph-bar is-unable"
                      />
                      <text x="198" y="13" className="graph-sub">
                        {outcome!.meets} · {outcome!.does_not_meet} · {outcome!.unable}
                      </text>
                      <title>
                        {rule.code}: {outcome!.meets} meet, {outcome!.does_not_meet} do not meet,{' '}
                        {outcome!.unable} unable to verify
                      </title>
                    </>
                  ) : (
                    <text x="0" y="13" className="graph-sub">
                      {evaluated ? 'New rule · not evaluated yet' : 'No leads evaluated yet'}
                    </text>
                  )}
                </g>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="fine-print">
        A line joins a source to a rule when the source uses that rule’s key words.
        {unlinked > 0 &&
          ' ' +
            unlinked +
            (unlinked === 1 ? ' rule is' : ' rules are') +
            ' not clearly grounded in any source: check it came from your documents.'}{' '}
        Bars count each lead’s latest analysis on the published version.
      </p>
      <details className="graph-table">
        <summary>Show the graph as a table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Linked sources</th>
              <th scope="col">Meets</th>
              <th scope="col">Does not meet</th>
              <th scope="col">Unable to verify</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.code}>
                <th scope="row">
                  {rule.code} · {rule.text}
                </th>
                <td>
                  {rule.links.length
                    ? rule.links
                        .map((id) => sources.find((source) => source.id === id)?.title)
                        .join(', ')
                    : '—'}
                </td>
                <td>{rule.outcome?.meets ?? '—'}</td>
                <td>{rule.outcome?.does_not_meet ?? '—'}</td>
                <td>{rule.outcome?.unable ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Shown when Train AI finished, above the draft it produced. */
export function TrainedNotice({ version }: { version: number | null }) {
  return (
    <div className="trained-notice" role="status">
      <AlertTriangle size={17} />
      <span>
        <strong>Train AI prepared a new draft.</strong> Review the changes
        {version ? ' against published v' + version : ''} and the graph, then save and publish it.
        Nothing is used for qualification until you approve it.
      </span>
    </div>
  );
}

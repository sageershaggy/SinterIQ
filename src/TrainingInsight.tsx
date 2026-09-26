import { useId, useState, type CSSProperties } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, FileWarning } from 'lucide-react';
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
type GraphRule = {
  kind: 'criterion' | 'exclusion';
  text: string;
  code: string;
  /** Ids of the sources that use this rule's key words. */
  links: number[];
  outcome?: TrainingGraph['rules'][number];
};

/** Rules shown before "Show all": enough to read the shape, short enough to stay on one screen. */
const PREVIEW_RULES = 6;
/**
 * Up to this many sources are drawn as cards and numbered on every rule. A longer library shows
 * one card fewer plus a "+N more" card, and each rule counts its sources ("k of n") instead.
 */
const DRAWN_SOURCES = 6;
/** Fixed sizes the connector drawing is computed from (kept in step with TrainingInsight.css). */
const SOURCE_CARD = 46;
const SOURCE_GAP = 6;
const SOURCE_TOP = 30;
const CONNECTOR_WIDTH = 44;

const kindLabel = (kind: Source['kind']) =>
  kind === 'website' ? 'Website' : kind === 'document' ? 'Document' : 'Notes';

/**
 * One bundled line per source into the rules, never one per rule: each source's own line says
 * whether any rule uses it, and the numbered markers on each rule say which ones do.
 */
function Connectors({ grounds }: { grounds: number[] }) {
  const count = grounds.length;
  if (!count) return null;
  const height = SOURCE_TOP + count * SOURCE_CARD + (count - 1) * SOURCE_GAP;
  const centre = (index: number) =>
    SOURCE_TOP + index * (SOURCE_CARD + SOURCE_GAP) + SOURCE_CARD / 2;
  const target = (centre(0) + centre(count - 1)) / 2;
  const end = CONNECTOR_WIDTH - 6;
  return (
    <svg
      className="tg-connectors"
      width={CONNECTOR_WIDTH}
      height={height}
      viewBox={`0 0 ${CONNECTOR_WIDTH} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      {grounds.map((used, index) => {
        const y = centre(index);
        return (
          <path
            key={index}
            d={`M 0 ${y} C ${end / 2} ${y}, ${end / 2} ${target}, ${end} ${target}`}
            className={'tg-connector' + (used ? '' : ' is-unused')}
          />
        );
      })}
      <path
        d={`M ${end} ${target - 4} L ${CONNECTOR_WIDTH} ${target} L ${end} ${target + 4} Z`}
        className="tg-arrow"
      />
    </svg>
  );
}

/** How the leads on the published version came out on one rule, as a bar and three counts. */
function RuleOutcome({ rule, evaluated }: { rule: GraphRule; evaluated: number }) {
  const outcome = rule.outcome;
  const total = outcome ? outcome.meets + outcome.does_not_meet + outcome.unable : 0;
  if (!outcome || !total)
    return (
      <span className="tg-outcome is-pending">
        {evaluated ? 'New rule · not evaluated yet' : 'Not evaluated yet'}
      </span>
    );
  const meets = rule.kind === 'exclusion' ? 'meet (excluded)' : 'meet';
  return (
    <span className="tg-outcome">
      <span
        className="tg-bar"
        role="img"
        aria-label={`${outcome.meets} ${meets}, ${outcome.does_not_meet} do not meet, ${outcome.unable} unable to verify`}
      >
        <i className="is-meets" style={{ flexGrow: outcome.meets }} />
        <i className="is-not" style={{ flexGrow: outcome.does_not_meet }} />
        <i className="is-unable" style={{ flexGrow: outcome.unable }} />
      </span>
      <span className="tg-counts" aria-hidden="true">
        <b className="is-meets">{outcome.meets}</b>
        <b className="is-not">{outcome.does_not_meet}</b>
        <b className="is-unable">{outcome.unable}</b>
      </span>
    </span>
  );
}

function RuleRow({
  rule,
  sources,
  evaluated,
}: {
  rule: GraphRule;
  sources: Source[];
  evaluated: number;
}) {
  const linked = sources.filter((source) => rule.links.includes(source.id));
  const markers = sources.length <= DRAWN_SOURCES;
  return (
    <li
      className={
        'tg-rule' +
        (rule.kind === 'exclusion' ? ' is-exclusion' : '') +
        (linked.length ? '' : ' is-ungrounded')
      }
    >
      <span className="tg-code">{rule.code}</span>
      <span className="tg-text" title={rule.text}>
        {rule.text}
      </span>
      <span
        className="tg-links"
        title={
          linked.length
            ? 'Uses the key words of: ' + linked.map((source) => source.title).join(', ')
            : 'Not clearly grounded in any source'
        }
      >
        <span className="visually-hidden">
          {linked.length
            ? 'Sources: ' + linked.map((source) => source.title).join(', ') + '.'
            : 'Not clearly grounded in any source.'}
        </span>
        {markers ? (
          sources.map((source, index) => (
            <i
              key={source.id}
              className={rule.links.includes(source.id) ? 'is-on' : ''}
              aria-hidden="true"
            >
              {index + 1}
            </i>
          ))
        ) : (
          <small aria-hidden="true">
            {linked.length} of {sources.length}
          </small>
        )}
      </span>
      {evaluated > 0 && <RuleOutcome rule={rule} evaluated={evaluated} />}
    </li>
  );
}

/**
 * Sources → rules → lead outcomes, as a compact summary that fits on one screen: the sources
 * with one bundled connector each, the rules as a list (numbered markers say which sources use
 * each rule's key words) and, beside each rule, how the leads qualified on the published
 * version came out on it. The first few rules show until "Show all"; the same data is
 * available in full as a table.
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
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const build = (kind: GraphRule['kind'], prefix: string) => (text: string, index: number) => ({
    kind,
    text,
    code: prefix + (index + 1),
    links: linkedSources(text, sources).map((source) => source.id),
    outcome: graph?.rules.find((item) => item.kind === kind && norm(item.text) === norm(text)),
  });
  const criteria: GraphRule[] = draft.criteria.map(build('criterion', 'C'));
  const exclusions: GraphRule[] = draft.exclusions.map(build('exclusion', 'X'));
  const rules = [...criteria, ...exclusions];
  const evaluated = graph?.leads_evaluated || 0;
  // Collapsed, both groups stay represented: up to two exclusions, criteria for the rest.
  const exclusionsShown = expanded
    ? exclusions.length
    : Math.min(exclusions.length, Math.max(2, PREVIEW_RULES - criteria.length));
  const criteriaShown = expanded
    ? criteria.length
    : Math.min(criteria.length, PREVIEW_RULES - exclusionsShown);
  const hidden = rules.length - criteriaShown - exclusionsShown;
  const drawn = sources.length > DRAWN_SOURCES ? sources.slice(0, DRAWN_SOURCES - 1) : sources;
  const more = sources.length - drawn.length;
  const grounds = (source: Source) => rules.filter((rule) => rule.links.includes(source.id)).length;
  const unlinked = rules.filter((rule) => !rule.links.length).length;
  const group = (title: string, note: string, list: GraphRule[], shown: number, kind: string) =>
    list.length ? (
      <div className={'tg-group is-' + kind}>
        <h3 className="tg-group-title">
          {title} <span>{list.length}</span>
          <small>{note}</small>
        </h3>
        <ol className="tg-rule-list">
          {list.slice(0, shown).map((rule) => (
            <RuleRow key={rule.code} rule={rule} sources={sources} evaluated={evaluated} />
          ))}
        </ol>
      </div>
    ) : null;
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
        {!!evaluated && (
          <span className="graph-legend" aria-hidden="true">
            <span>
              <i className="is-meets" /> Meets
            </span>
            <span>
              <i className="is-not" /> Does not meet
            </span>
            <span>
              <i className="is-unable" /> Unable to verify
            </span>
            {!!exclusions.length && (
              <span>
                <i className="is-excluded" /> Exclusion met
              </span>
            )}
          </span>
        )}
      </div>
      <div className="tg-flow">
        <section className="tg-sources" aria-label="Sources">
          <h3 className="tg-heading">
            Sources <span>{sources.length}</span>
          </h3>
          {sources.length ? (
            <ol className="tg-source-list">
              {drawn.map((source, index) => {
                const used = grounds(source);
                return (
                  <li
                    key={source.id}
                    className={'tg-source' + (used ? '' : ' is-unused')}
                    title={source.title}
                  >
                    <span className="tg-marker" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="tg-source-text">
                      <strong>{source.title}</strong>
                      <small>
                        {kindLabel(source.kind)} ·{' '}
                        {used
                          ? 'used by ' + used + (used === 1 ? ' rule' : ' rules')
                          : 'no rule uses it'}
                      </small>
                    </span>
                  </li>
                );
              })}
              {more > 0 && (
                <li className="tg-source is-more">
                  <span className="tg-source-text">
                    <strong>
                      +{more} more source{more === 1 ? '' : 's'}
                    </strong>
                    <small>All of them are in the library above</small>
                  </span>
                </li>
              )}
            </ol>
          ) : (
            <p className="tg-empty">No sources in the library yet.</p>
          )}
        </section>
        <Connectors grounds={[...drawn.map(grounds), ...(more > 0 ? [1] : [])]} />
        <section
          className={'tg-rules' + (evaluated ? ' is-evaluated' : '')}
          aria-label="Rules and lead outcomes"
          id={listId}
          // One width for the markers column in every row and the column heading above it.
          style={
            {
              '--tg-links':
                Math.max(58, sources.length <= DRAWN_SOURCES ? sources.length * 21 : 0) + 'px',
            } as CSSProperties
          }
        >
          <div className="tg-columns" aria-hidden="true">
            <span>Rule</span>
            <span>Sources</span>
            {!!evaluated && <span>Lead outcomes</span>}
          </div>
          {!evaluated && !!rules.length && (
            <p className="tg-no-leads">
              No leads evaluated on{' '}
              {graph?.version ? 'published v' + graph.version : 'this version'} yet. Each rule’s
              Meets / Does not meet / Unable to verify counts appear here once leads are qualified.
            </p>
          )}
          {group('Criteria', 'Each one met raises the score', criteria, criteriaShown, 'criteria')}
          {group(
            'Exclusions',
            'One met disqualifies the lead',
            exclusions,
            exclusionsShown,
            'exclusions',
          )}
          {!rules.length && <p className="tg-empty">No rules in the editor yet.</p>}
          {(hidden > 0 || expanded) && (
            <button
              type="button"
              className="text-button tg-toggle"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {expanded ? 'Show fewer rules' : 'Show all ' + rules.length + ' rules'}
            </button>
          )}
        </section>
      </div>
      <p className="fine-print">
        The numbers beside a rule are the sources that use its key words.
        {unlinked > 0 &&
          (unlinked === 1
            ? ' One rule is not clearly grounded in any source: check it came from your documents.'
            : ' ' +
              unlinked +
              ' rules are not clearly grounded in any source: check they came from your documents.')}
        {!!evaluated && ' Bars count each lead’s latest analysis on the published version.'}
      </p>
      <details className="graph-table">
        <summary>Show the graph as a table</summary>
        {/* Scrolls inside its own box on a phone instead of widening the page. */}
        <div className="graph-table-scroll">
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
        </div>
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

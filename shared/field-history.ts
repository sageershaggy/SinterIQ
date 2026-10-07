/**
 * Where each company detail on a lead came from (server/field-history.ts).
 *
 * Every write of one of these fields records the value it replaced, the new value and who set it:
 * the list import, a person (the lead form), or research (the company's own website). That is
 * what lets research replace an imported value while a typed one stays, and what keeps the
 * original imported value retrievable after research has replaced it on the card.
 */

/** Who set a value: the list import, a person typing it, or research on the company website. */
export type FieldOrigin = 'import' | 'person' | 'research';

/**
 * The company details whose changes are kept. Contact details are left out on purpose: they are
 * personal data, and erasing a contact must not leave the old value behind in a history table.
 */
export const trackedFields = ['website', 'country', 'city', 'industry', 'employee_count'] as const;
export type TrackedField = (typeof trackedFields)[number];

/** One recorded change of a company detail. Append-only; deleted with the lead. */
export interface FieldChange {
  id: number;
  field: TrackedField;
  previous_value: string;
  new_value: string;
  origin: FieldOrigin;
  /** For research: the sentence on the company's page that states the value. */
  evidence: string;
  /** For research: the page that sentence is on. */
  source_url: string;
  changed_at: string;
  changed_by: string;
}

/** What the Company card shows about one field, read from its history. */
export interface FieldProvenance {
  /** Who set the value the record holds now; null when it predates the history. */
  origin: FieldOrigin | null;
  /**
   * The value research replaced, with who had set it (null: it came with the record before the
   * history was kept). Absent when research filled a blank or never changed the field.
   */
  original: { value: string; origin: FieldOrigin | null } | null;
  /** The recorded change that set the current value, if the history has it. */
  change: FieldChange | null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Reads one field's history against the value the record holds now. The current origin is the
 * latest change's, as long as that change produced the current value. When research set it, the
 * value research replaced is found by walking back past research changes to the import or edit
 * before them (or, for a record older than the history, the first research change's previous value).
 */
export function fieldProvenance(
  history: FieldChange[],
  field: TrackedField,
  current: string,
): FieldProvenance {
  const rows = history.filter((row) => row.field === field).sort((a, b) => b.id - a.id);
  const latest = rows[0];
  if (!latest || !same(latest.new_value, current) || !current.trim())
    return { origin: null, original: null, change: null };
  if (latest.origin !== 'research')
    return { origin: latest.origin, original: null, change: latest };
  let index = 0;
  while (index < rows.length && rows[index].origin === 'research') index++;
  const before = rows[index];
  const original = before
    ? { value: before.new_value, origin: before.origin }
    : { value: rows[index - 1].previous_value, origin: null };
  return {
    origin: 'research',
    original: original.value.trim() && !same(original.value, current) ? original : null,
    change: latest,
  };
}

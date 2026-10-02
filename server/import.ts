import { parse } from 'csv-parse/sync';
import yauzl from 'yauzl';
import { HttpError } from './validation';
import { personalDetail } from './enrich';
import type { ListData } from '../shared/lead-import';

export const importLimits = { rows: 5000, bytes: 4_000_000 };
export const supportedImports = ['.csv', '.tsv', '.txt', '.json', '.xlsx'] as const;

/** Header text -> canonical field. Covers the exports people actually have to hand. */
const columnAliases: Record<string, string[]> = {
  name: ['name', 'company_name', 'company', 'organisation', 'organization', 'account_name'],
  website: ['website', 'company_website', 'url', 'domain', 'web'],
  country: ['country', 'company_country'],
  city: ['city', 'locality', 'town', 'company_city'],
  industry: ['industry', 'company_industry', 'sector', 'industry_2'],
  employee_count: ['employee_count', 'employees', 'company_size', 'headcount', 'size'],
  contact_name: ['contact_name', 'contact_person', 'full_name', 'person_name', 'contact'],
  contact_role: ['contact_role', 'job_title', 'title', 'role', 'position'],
  contact_email: ['contact_email', 'email', 'emails', 'email_address', 'work_email'],
  contact_phone: ['contact_phone', 'phone', 'phones', 'phone_numbers', 'mobile', 'telephone'],
  notes: ['notes', 'description', 'note', 'comment', 'summary'],
};
const normalizeHeader = (header: string) =>
  header
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
/** First non-empty value among the aliases for a field. */
function pick(row: Record<string, string>, field: string) {
  for (const alias of columnAliases[field]) {
    const value = row[alias];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
/** A multi-value cell ("a@x.com,b@x.com") contributes only its first entry. */
const firstOf = (value: string) => value.split(/[,;|]/)[0].trim();

/** Every header an alias reads. Those columns are lead fields, so never list data. */
const aliasHeaders = new Set(Object.values(columnAliases).flat());
/** How much of a list's other columns one lead keeps (leads.list_data). */
export const listDataLimits = { columns: 25, label: 60, value: 300, total: 4000 };
/**
 * Headers that name a person or a way to reach one. Such a column is left out whatever it holds:
 * list data is about the company, and a contact is only ever kept from the company's own site.
 */
const personalHeader =
  /(?:^|_)(?:e_?mails?|mail|phones?|mobile|cell|tel|telephone|fax|whatsapp|linkedin|twitter|facebook|instagram|xing|(?:first|last|full|given|family|sur|fore)_?name|persons?|people|contacts?|attendees?|speakers?|owners?|founders?|ceo|salutation|gender|birthday|birth_?date|dob)(?:_|$)/;
/**
 * Dates and amounts are not contact details, though their digits can run as long as a phone
 * number's ("2026-03-15", "€12.500.000"), so they are set aside before personalDetail looks.
 */
const datesAndAmounts = new RegExp(
  [
    String.raw`\b(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b`,
    String.raw`\b(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|[12]\d|3[01])[-/.](?:19|20)?\d{2}\b`,
    String.raw`(?:[$€£¥]|\b(?:usd|eur|gbp|chf|aed|sar)\b)\s?\d[\d.,]*`,
    String.raw`\d[\d.,]*\s?(?:[$€£¥]|(?:usd|eur|gbp|chf|aed|sar|million|mio|mn|bn|m|k)\b)`,
  ].join('|'),
  'gi',
);
/** An email address, a phone-like run of digits or a personal profile link. */
const personalValue = (value: string) =>
  personalDetail.test(value.replace(datesAndAmounts, ' ')) || /linkedin\.com\/in\//i.test(value);
/** A normalized header as people read it: "funding_round" → "Funding round". */
function columnLabel(key: string) {
  const words = key.replace(/_/g, ' ');
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, listDataLimits.label);
}
/**
 * The list data a row keeps: each non-empty column that is not a lead field, under a readable
 * label. Labels come from the normalized header rather than the file's own spelling, so the same
 * column merges into the same entry whether the list arrives as CSV, JSON or Excel, and however
 * its export capitalised it. This is the one rule whichever route the data comes through — a file
 * read here, or rows the import dialog sends back — so nothing personal and nothing past the
 * limits is ever stored: a column whose header names a person or a way to reach one is left out,
 * and so is any value holding an email address, a phone-like number or a profile link.
 */
export function listData(entries: Record<string, unknown>): ListData {
  const kept: ListData = {};
  // The stored JSON's length: braces, then each entry's quoted label and value, colon and comma.
  let size = 2;
  for (const [header, raw] of Object.entries(entries)) {
    if (Object.keys(kept).length >= listDataLimits.columns) break;
    const key = normalizeHeader(header);
    if (!key || aliasHeaders.has(key) || personalHeader.test(key)) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const value = String(raw)
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!value || personalValue(value)) continue;
    const label = columnLabel(key);
    if (Object.hasOwn(kept, label)) continue;
    const text =
      value.length > listDataLimits.value
        ? value.slice(0, listDataLimits.value - 1).trimEnd() + '…'
        : value;
    const added = JSON.stringify(label).length + JSON.stringify(text).length + 2;
    if (size + added > listDataLimits.total) continue;
    kept[label] = text;
    size += added;
  }
  return kept;
}
/** leads.list_data as stored (server/list-data-schema.ts); anything unreadable is none. */
export function storedListData(value: unknown): ListData {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function decodeUtf8(buffer: Buffer, what: string) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new HttpError(400, what + ' must be saved as UTF-8. Re-export it with UTF-8 encoding.');
  }
}
function parseDelimited(buffer: Buffer, delimiter: string[]) {
  try {
    return parse(decodeUtf8(buffer, 'The file'), {
      columns: (headers: string[]) => headers.map(normalizeHeader),
      delimiter,
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 100000,
    }) as Record<string, string>[];
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      'The file could not be read as a table. Check that the first line is a header row and that quotes are balanced.',
    );
  }
}
function parseJson(buffer: Buffer) {
  let data: unknown;
  try {
    data = JSON.parse(decodeUtf8(buffer, 'The JSON file'));
  } catch {
    throw new HttpError(400, 'That file is not valid JSON.');
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { leads?: unknown })?.leads)
      ? (data as { leads: unknown[] }).leads
      : Array.isArray((data as { records?: unknown })?.records)
        ? (data as { records: unknown[] }).records
        : null;
  if (!list)
    throw new HttpError(
      400,
      'The JSON must be an array of objects, or an object with a "leads" or "records" array.',
    );
  return list.map((entry) => {
    const row: Record<string, string> = {};
    if (entry && typeof entry === 'object')
      for (const [key, value] of Object.entries(entry as Record<string, unknown>))
        row[normalizeHeader(key)] =
          value === null || value === undefined || typeof value === 'object' ? '' : String(value);
    return row;
  });
}

const unescapeXml = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
/** Column reference ("BC12") to a zero-based column index. */
function columnIndex(reference: string) {
  let index = 0;
  for (const character of reference.replace(/\d+$/, ''))
    index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}
function readZipEntries(buffer: Buffer, wanted: (name: string) => boolean) {
  return new Promise<{ files: Record<string, string>; names: string[] }>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(new HttpError(400, 'That file is not a readable workbook.'));
      const found: Record<string, string> = {};
      const names: string[] = [];
      let total = 0,
        entries = 0;
      zip.on('error', () => reject(new HttpError(400, 'That workbook could not be read.')));
      zip.on('entry', (entry) => {
        total += entry.uncompressedSize;
        entries++;
        // Same bounds as document uploads: no zip bombs, no encrypted archives.
        if (total > 60_000_000 || entries > 2000 || entry.generalPurposeBitFlag & 1) {
          zip.close();
          return reject(new HttpError(413, 'That workbook exceeds the supported size.'));
        }
        names.push(entry.fileName);
        if (!wanted(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream)
            return reject(new HttpError(400, 'That workbook could not be read.'));
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 40_000_000) {
              stream.destroy();
              return reject(new HttpError(413, 'That worksheet is too large to import.'));
            }
            chunks.push(chunk);
          });
          stream.on('error', () => reject(new HttpError(400, 'That workbook could not be read.')));
          stream.on('end', () => {
            found[entry.fileName] = Buffer.concat(chunks).toString('utf8');
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve({ files: found, names }));
      zip.readEntry();
    });
  });
}
/** A relationship target ("worksheets/sheet4.xml") as a part name inside the archive. */
function partName(target: string) {
  const cleaned = target.replace(/^\.\//, '');
  if (cleaned.startsWith('/')) return cleaned.slice(1);
  // Workbook relationship targets are relative to the workbook's own directory.
  const segments: string[] = [];
  for (const segment of ('xl/' + cleaned).split('/'))
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(segment);
  return segments.join('/');
}
/**
 * The part holding the workbook's first worksheet. It is only called sheet1.xml in a
 * workbook nobody has touched: Excel keeps a part's original name when sheets are added,
 * renamed or reordered, so the ordered <sheet> list in xl/workbook.xml has to be resolved
 * through the workbook relationships. Where those parts are missing or unreadable, the
 * lowest-numbered worksheet is the best guess left.
 */
function firstWorksheet(workbook: string | undefined, rels: string | undefined, names: string[]) {
  const sheetNumber = (name: string) =>
    Number(/(\d+)\.xml$/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const worksheets = names
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b) || a.localeCompare(b));
  // Any prefix, because a generator may bind the relationship namespace under its own name.
  const relationship = /<(?:\w+:)?sheet\s[^>]*?\b\w+:id="([^"]+)"/.exec(workbook || '')?.[1];
  // Matched by scanning rather than by a built regex: the archive is untrusted, and an id
  // interpolated into a pattern is an id that can rewrite the pattern.
  const target = relationship
    ? [...(rels || '').matchAll(/<(?:\w+:)?Relationship\s[^>]*?>/g)].find(
        (match) => /\bId="([^"]*)"/.exec(match[0])?.[1] === relationship,
      )?.[0]
    : undefined;
  const resolved = target && partName(unescapeXml(/\bTarget="([^"]*)"/.exec(target)?.[1] || ''));
  return resolved && worksheets.includes(resolved) ? resolved : worksheets[0];
}
/**
 * Reads the first worksheet of an XLSX. Parsed here rather than through a spreadsheet
 * library so the untrusted archive stays under the same bounds as document uploads.
 */
export async function parseWorkbook(buffer: Buffer) {
  if (!buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    throw new HttpError(400, 'That file is not a valid .xlsx workbook.');
  // Which part is the first worksheet is only known once the workbook index has been read,
  // so the archive is walked again for that one part rather than held in memory wholesale.
  const index = await readZipEntries(
    buffer,
    (name) =>
      name === 'xl/sharedStrings.xml' ||
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels',
  );
  const part = firstWorksheet(
    index.files['xl/workbook.xml'],
    index.files['xl/_rels/workbook.xml.rels'],
    index.names,
  );
  const sheet = part ? (await readZipEntries(buffer, (name) => name === part)).files[part] : '';
  if (!sheet) throw new HttpError(400, 'That workbook has no readable first worksheet.');
  const shared = [
    ...(index.files['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((match) =>
    unescapeXml(
      [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((piece) => piece[1]).join(''),
    ),
  );
  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1];
      const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1];
      const type = /t="([^"]+)"/.exec(attributes)?.[1];
      const raw = /<(?:v|t)[^>]*>([\s\S]*?)<\/(?:v|t)>/.exec(cellMatch[2])?.[1] ?? '';
      let value =
        type === 's' ? (shared[Number(raw)] ?? '') : type === 'inlineStr' ? raw : unescapeXml(raw);
      if (type === 'inlineStr')
        value = unescapeXml(
          [...cellMatch[2].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((p) => p[1]).join(''),
        );
      cells[reference ? columnIndex(reference) : cells.length] = value;
    }
    rows.push([...cells].map((cell) => (cell ?? '').trim()));
    if (rows.length > importLimits.rows + 1) break;
  }
  if (!rows.length) throw new HttpError(400, 'That worksheet is empty.');
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) row[header] = cells[index] ?? '';
    });
    return row;
  });
}

/** Turns any supported upload into normalized rows keyed by canonical field name. */
export async function readImportRows(filename: string, buffer: Buffer) {
  const extension = (/\.[a-z0-9]+$/i.exec(filename)?.[0] || '').toLowerCase();
  if (!supportedImports.includes(extension as (typeof supportedImports)[number]))
    throw new HttpError(
      400,
      'Supported lead files are CSV, TSV, plain text, JSON and Excel (.xlsx). Save your file as one of those and try again.',
    );
  if (buffer.length > importLimits.bytes)
    throw new HttpError(413, 'Lead files must be smaller than 4 MB.');
  const raw =
    extension === '.json'
      ? parseJson(buffer)
      : extension === '.xlsx'
        ? await parseWorkbook(buffer)
        : parseDelimited(buffer, extension === '.tsv' ? ['\t'] : [',', ';', '\t', '|']);
  if (!raw.length) throw new HttpError(400, 'That file has a header row but no data rows.');
  if (raw.length > importLimits.rows)
    throw new HttpError(
      400,
      'Import up to ' +
        importLimits.rows.toLocaleString('en-US') +
        ' leads at a time. This file has ' +
        raw.length.toLocaleString('en-US') +
        ' rows — split it and import in batches.',
    );
  return raw;
}

export interface RowProblem {
  row: number;
  name: string;
  reason: string;
}
/**
 * Maps and validates rows. Invalid rows become reported problems instead of failing the
 * whole file, so one bad row in a large export cannot block every good one. The columns no
 * alias reads travel with each row as its list_data (listData) instead of being dropped: an
 * exhibitor list's event or a funding export's round is often the very fact a rule asks about.
 */
export function mapImportRows<T>(
  rows: Record<string, string>[],
  validate: (
    candidate: Record<string, unknown>,
  ) => { ok: true; value: T; warning?: string } | { ok: false; reason: string },
) {
  const leads: T[] = [];
  /** The file line each lead came from, so a preview can point back at the row. */
  const lines: number[] = [];
  const problems: RowProblem[] = [];
  /** Rows that imported, but with something unusable dropped along the way. */
  const warnings: RowProblem[] = [];
  rows.forEach((row, index) => {
    let website = pick(row, 'website');
    if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
    const candidate = {
      name: pick(row, 'name'),
      website,
      country: pick(row, 'country'),
      city: pick(row, 'city'),
      industry: pick(row, 'industry'),
      employee_count: pick(row, 'employee_count'),
      contact_name: pick(row, 'contact_name'),
      contact_role: pick(row, 'contact_role'),
      contact_email: firstOf(pick(row, 'contact_email')),
      contact_phone: firstOf(pick(row, 'contact_phone')),
      notes: pick(row, 'notes'),
      list_data: listData(row),
    };
    // Header row is line 1, so the first data row is line 2.
    const line = index + 2;
    if (!candidate.name) {
      problems.push({
        row: line,
        name: candidate.contact_name || '(no company)',
        reason: 'No company name. This row has no Company Name / Name column value.',
      });
      return;
    }
    const result = validate(candidate);
    if (!result.ok) {
      problems.push({ row: line, name: candidate.name, reason: result.reason });
      return;
    }
    leads.push(result.value);
    lines.push(line);
    if (result.warning) warnings.push({ row: line, name: candidate.name, reason: result.warning });
  });
  return { leads, lines, problems, warnings };
}

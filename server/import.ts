import { parse } from 'csv-parse/sync';
import yauzl from 'yauzl';
import { HttpError } from './validation';

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
  return new Promise<Record<string, string>>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(new HttpError(400, 'That file is not a readable workbook.'));
      const found: Record<string, string> = {};
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
      zip.on('end', () => resolve(found));
      zip.readEntry();
    });
  });
}
/**
 * Reads the first worksheet of an XLSX. Parsed here rather than through a spreadsheet
 * library so the untrusted archive stays under the same bounds as document uploads.
 */
export async function parseWorkbook(buffer: Buffer) {
  if (!buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    throw new HttpError(400, 'That file is not a valid .xlsx workbook.');
  const files = await readZipEntries(
    buffer,
    (name) => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet1\.xml$/.test(name),
  );
  const sheet = files['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new HttpError(400, 'That workbook has no readable first worksheet.');
  const shared = [...(files['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (match) =>
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
 * whole file, so one bad row in a large export cannot block every good one.
 */
export function mapImportRows<T>(
  rows: Record<string, string>[],
  validate: (
    candidate: Record<string, string>,
  ) => { ok: true; value: T; warning?: string } | { ok: false; reason: string },
) {
  const leads: T[] = [];
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
    if (result.warning) warnings.push({ row: line, name: candidate.name, reason: result.warning });
  });
  return { leads, problems, warnings };
}

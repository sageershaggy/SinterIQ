import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { HttpError } from './validation';
import { parseWorkbook } from './import';

/** Flattens a spreadsheet or delimited file into readable lines for training context. */
function tableToText(rows: Record<string, string>[]) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return rows
    .map((row) =>
      headers
        .map((header) => (row[header] ?? '').trim())
        .filter(Boolean)
        .map((value, index) => headers[index] + ': ' + value)
        .join(' · '),
    )
    .filter(Boolean)
    .join('\n');
}

export async function extractDocument(file: Express.Multer.File): Promise<string> {
  const extension = path.extname(file.originalname).toLowerCase();
  if (!['.txt', '.md', '.pdf', '.docx', '.csv', '.tsv', '.xlsx'].includes(extension))
    throw new HttpError(
      400,
      'Supported documents: PDF, DOCX, Excel (.xlsx), CSV, TSV, Markdown and plain text.',
    );
  if (file.size > 5_000_000) throw new HttpError(413, 'Documents must be smaller than 5 MB.');
  let text: string;
  if (extension === '.xlsx') {
    // Read through the same bounded archive path the lead importer uses.
    text = tableToText(await parseWorkbook(file.buffer));
  } else if (extension === '.csv' || extension === '.tsv') {
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } catch {
      throw new HttpError(400, 'CSV and TSV files must use UTF-8 encoding.');
    }
    try {
      text = tableToText(
        parse(decoded, {
          columns: (headers: string[]) => headers.map((h) => h.trim()),
          delimiter: extension === '.tsv' ? ['\t'] : [',', ';', '\t', '|'],
          bom: true,
          trim: true,
          skip_empty_lines: true,
          relax_column_count: true,
          max_record_size: 100000,
        }) as Record<string, string>[],
      );
    } catch {
      throw new HttpError(400, 'That table could not be read. Check the header row and quoting.');
    }
  } else if (extension === '.txt' || extension === '.md') {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } catch {
      throw new HttpError(400, 'Text documents must use UTF-8 encoding.');
    }
    if (/\x00/.test(text)) throw new HttpError(400, 'The file contains binary data.');
  } else {
    if (extension === '.pdf' && !file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new HttpError(400, 'Invalid PDF file.');
    if (
      extension === '.docx' &&
      !file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    )
      throw new HttpError(400, 'Invalid DOCX file.');
    text = await new Promise<string>((resolve, reject) => {
      const worker = fork(fileURLToPath(new URL('./document-worker.ts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx', '--max-old-space-size=384'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const timer = setTimeout(() => {
        worker.kill();
        reject(new HttpError(422, 'Document processing timed out. Try a smaller file.'));
      }, 15000);
      worker.once('message', (message: { text?: string; error?: string }) => {
        clearTimeout(timer);
        if (message.error) reject(new HttpError(422, message.error));
        else resolve(message.text || '');
        worker.kill();
      });
      worker.once('error', () => {
        clearTimeout(timer);
        reject(new HttpError(422, 'Document processing failed.'));
      });
      worker.once('exit', () => {
        clearTimeout(timer);
        reject(new HttpError(422, 'Document processing stopped before extraction completed.'));
      });
      worker.send({ extension, data: file.buffer.toString('base64') });
    });
  }
  text = text.replace(/\r\n/g, '\n').trim();
  if (text.length < 40)
    throw new HttpError(
      422,
      'At least 40 characters of readable text are required. Scanned PDFs need OCR before upload.',
    );
  if (text.length > 60000)
    throw new HttpError(
      413,
      'The document exceeds 60,000 characters. Split it into smaller sources.',
    );
  return text;
}

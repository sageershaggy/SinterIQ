// Shared CSV export — single source of truth for BOM, quote-escaping, and the
// blob download dance that was previously copy-pasted across every tab.

type Cell = string | number | null | undefined;

/**
 * Build a UTF-8 (BOM-prefixed, Excel-friendly) CSV from headers + rows and
 * trigger a browser download.
 */
export function downloadCsv(headers: Cell[], rows: Cell[][], filename: string): void {
  const escape = (v: Cell) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const bom = '﻿';
  const csv = bom + [headers, ...rows].map((r) => r.map(escape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Collapse newlines/tabs/repeated whitespace so a value stays in one CSV cell. */
export function oneLine(value: Cell): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

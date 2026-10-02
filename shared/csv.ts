/**
 * One CSV cell, quoted, with a leading formula character neutralized. A value that starts with
 * =, +, - or @ (or a tab or line break) is read as a formula by a spreadsheet, so a company
 * name taken from someone else's export could otherwise run in the reader's spreadsheet. The
 * server's lead export and the import dialog's rejected-rows download both write through here.
 */
export function csvCell(value: unknown) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

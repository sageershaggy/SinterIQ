import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkbook } from '../server/import';
import { HttpError } from '../server/validation';

/** Minimal stored-entry ZIP writer, so the XLSX fixtures need no extra dependency. */
function zipArchive(files: Record<string, string>) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buffer: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const entries: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    const entry = Buffer.concat([local, filename, data]);
    entries.push(entry);
    centrals.push(Buffer.concat([central, filename]));
    offset += entry.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, directory, end]);
}
/** One header row plus one company row, as Excel writes inline strings. */
function worksheet(company: string, website: string) {
  const cell = (reference: string, value: string) =>
    '<c r="' + reference + '" t="inlineStr"><is><t>' + value + '</t></is></c>';
  return (
    '<?xml version="1.0"?><worksheet><sheetData>' +
    '<row r="1">' +
    cell('A1', 'Company Name') +
    cell('B1', 'Company Website') +
    '</row><row r="2">' +
    cell('A2', company) +
    cell('B2', website) +
    '</row></sheetData></worksheet>'
  );
}
const contentTypes = '<?xml version="1.0"?><Types/>';
/** workbook.xml holds the sheet ORDER; the part each one lives in comes from the rels. */
function workbookIndex(sheets: { name: string; id: string }[]) {
  return (
    '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets
      .map(
        (sheet, index) =>
          '<sheet name="' +
          sheet.name +
          '" sheetId="' +
          (index + 1) +
          '" r:id="' +
          sheet.id +
          '"/>',
      )
      .join('') +
    '</sheets></workbook>'
  );
}
function workbookRels(targets: Record<string, string>) {
  return (
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    Object.entries(targets)
      .map(
        ([id, target]) =>
          '<Relationship Id="' +
          id +
          '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="' +
          target +
          '"/>',
      )
      .join('') +
    '</Relationships>'
  );
}

test('a workbook whose first worksheet is not sheet1.xml still imports', async () => {
  // Excel keeps a part's original name after sheets are added, renamed or reordered, so a
  // perfectly valid workbook can arrive with its only worksheet in sheet4.xml.
  const rows = await parseWorkbook(
    zipArchive({
      '[Content_Types].xml': contentTypes,
      'xl/workbook.xml': workbookIndex([{ name: 'Leads', id: 'rId7' }]),
      'xl/_rels/workbook.xml.rels': workbookRels({ rId7: 'worksheets/sheet4.xml' }),
      'xl/worksheets/sheet4.xml': worksheet('Epsilon Engineering', 'epsilon-eng.com'),
    }),
  );
  assert.deepEqual(rows, [
    { company_name: 'Epsilon Engineering', company_website: 'epsilon-eng.com' },
  ]);
});

test('the first sheet is the one workbook.xml lists first, not the lowest-numbered file', async () => {
  const archive = zipArchive({
    '[Content_Types].xml': contentTypes,
    // The leads sheet was dragged to the front; its part is still sheet3.xml.
    'xl/workbook.xml': workbookIndex([
      { name: 'Leads', id: 'rId3' },
      { name: 'Notes', id: 'rId1' },
      { name: 'Totals', id: 'rId2' },
    ]),
    'xl/_rels/workbook.xml.rels': workbookRels({
      rId1: 'worksheets/sheet1.xml',
      rId2: 'worksheets/sheet2.xml',
      rId3: 'worksheets/sheet3.xml',
    }),
    'xl/worksheets/sheet1.xml': worksheet('Wrong Sheet Ltd', 'wrong.example'),
    'xl/worksheets/sheet2.xml': worksheet('Also Wrong Ltd', 'also-wrong.example'),
    'xl/worksheets/sheet3.xml': worksheet('Zeta Machining', 'zeta-machining.com'),
  });
  const rows = await parseWorkbook(archive);
  assert.deepEqual(rows, [
    { company_name: 'Zeta Machining', company_website: 'zeta-machining.com' },
  ]);
});

test('an absolute relationship target resolves, and shared strings still apply', async () => {
  const sheet =
    '<?xml version="1.0"?><worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>240</v></c></row>' +
    '</sheetData></worksheet>';
  const rows = await parseWorkbook(
    zipArchive({
      '[Content_Types].xml': contentTypes,
      'xl/workbook.xml': workbookIndex([{ name: 'Leads', id: 'rId11' }]),
      'xl/_rels/workbook.xml.rels': workbookRels({ rId11: '/xl/worksheets/leads.xml' }),
      'xl/sharedStrings.xml':
        '<sst><si><t>Company Name</t></si><si><t>Company Size</t></si>' +
        '<si><t>Theta Castings &amp; Co</t></si></sst>',
      'xl/worksheets/leads.xml': sheet,
    }),
  );
  assert.deepEqual(rows, [{ company_name: 'Theta Castings & Co', company_size: '240' }]);
});

test('an unreadable workbook index falls back to the lowest-numbered worksheet', async () => {
  const rows = await parseWorkbook(
    zipArchive({
      '[Content_Types].xml': contentTypes,
      'xl/workbook.xml': '<?xml version="1.0"?><workbook><sheets',
      'xl/worksheets/sheet10.xml': worksheet('Tenth Sheet Ltd', 'tenth.example'),
      'xl/worksheets/sheet2.xml': worksheet('Iota Forging', 'iota-forging.com'),
    }),
  );
  assert.deepEqual(rows, [{ company_name: 'Iota Forging', company_website: 'iota-forging.com' }]);
});

test('a plain sheet1.xml workbook with no index keeps working', async () => {
  const rows = await parseWorkbook(
    zipArchive({
      '[Content_Types].xml': contentTypes,
      'xl/worksheets/sheet1.xml': worksheet('Alpha Pumps', 'alpha-pumps.com'),
    }),
  );
  assert.deepEqual(rows, [{ company_name: 'Alpha Pumps', company_website: 'alpha-pumps.com' }]);
});

test('a workbook with no worksheet part at all is still refused the same way', async () => {
  const archive = zipArchive({
    '[Content_Types].xml': contentTypes,
    'xl/workbook.xml': workbookIndex([{ name: 'Leads', id: 'rId1' }]),
    'xl/_rels/workbook.xml.rels': workbookRels({ rId1: 'worksheets/sheet1.xml' }),
    'xl/sharedStrings.xml': '<sst><si><t>Company Name</t></si></sst>',
  });
  await assert.rejects(parseWorkbook(archive), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    assert.equal(error.message, 'That workbook has no readable first worksheet.');
    return true;
  });
});

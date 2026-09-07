import mammoth from 'mammoth';
import yauzl from 'yauzl';

async function inspectZip(buffer: Buffer) {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(new Error('Invalid document archive.'));
      let size = 0,
        entries = 0,
        hasDocument = false;
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        size += entry.uncompressedSize;
        entries++;
        if (size > 20_000_000 || entries > 2000 || entry.generalPurposeBitFlag & 1) {
          zip.close();
          return reject(new Error('Document archive exceeds limits or is encrypted.'));
        }
        if (entry.fileName === 'word/document.xml') hasDocument = true;
        zip.readEntry();
      });
      zip.on('end', () => (hasDocument ? resolve() : reject(new Error('Not a DOCX document.'))));
      zip.readEntry();
    });
  });
}
process.once('message', async (message: { extension: string; data: string }) => {
  try {
    const buffer = Buffer.from(message.data, 'base64');
    let text: string;
    if (message.extension === '.pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const info = await parser.getInfo();
        if (info.total > 100) throw new Error('Too many pages.');
        const result = await parser.getText();
        text = result.text;
      } finally {
        await parser.destroy();
      }
    } else {
      await inspectZip(buffer);
      text = (await mammoth.extractRawText({ buffer })).value;
    }
    if (text.length > 60000)
      throw new Error('Extracted text exceeds 60,000 characters. Split the document.');
    process.send?.({ text });
  } catch {
    process.send?.({
      error:
        'This document could not be read. Use a text-based PDF, DOCX, Markdown or text file under the size limit.',
    });
  } finally {
    process.disconnect();
  }
});

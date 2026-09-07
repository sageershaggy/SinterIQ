import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { isPublicIp, checkedUrl, publicRequest, researchLinks } from '../server/network';
import { openDatabase, hash } from '../server/database';
import { secretStore } from '../server/secrets';
import { extractDocument } from '../server/documents';
import { createApp } from '../server/app';
import request from 'supertest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('server-side administrator provisioning creates a working unique login and refuses to replace it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-admin-test-'));
  const { app, db } = createApp({ dataDir: directory });
  const run = promisify(execFile);
  const options = {
    env: { ...process.env, INNOVISTA_TEST: 'true', INNOVISTA_DATA_DIR: directory },
  };
  try {
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', 'scripts/init-admin.ts', 'test-admin', 'Test Administrator'],
      options,
    );
    const password = stdout.match(/Password: ([A-Za-z0-9_-]{24})/)?.[1];
    assert.ok(password);
    const login = await request(app)
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'test-admin', password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'admin');
    const before = db.prepare('SELECT password_hash FROM accounts').get();
    await assert.rejects(
      run(process.execPath, ['--import', 'tsx', 'scripts/init-admin.ts'], options),
      /setup is already complete/,
    );
    assert.deepEqual(db.prepare('SELECT password_hash FROM accounts').get(), before);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number }).count,
      1,
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('research follows relevant links actually present on the company website', () => {
  const html =
    '<a href="/about-us">About</a><a href="https://evil.example/products">Other site</a><a href="javascript:alert(1)">No</a><a href="/products#pumps">Products</a><a href="/company">Company</a>';
  assert.deepEqual(researchLinks(html, 'https://example.com/'), [
    'https://example.com/about-us',
    'https://example.com/products',
  ]);
});

test('website validation blocks loopback, metadata, reserved, mapped IPv6, credentials and unsupported protocols', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.0.1',
    '172.16.0.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '198.18.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])
    assert.equal(isPublicIp(address), false, address);
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
  for (const url of [
    'http://127.0.0.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://[::ffff:127.0.0.1]',
    'http://localhost',
    'http://foo.local',
    'http://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'ftp://example.com',
    'https://example.com:8443',
    'https://user:pass@example.com',
  ])
    assert.throws(() => checkedUrl(url), url);
  await assert.rejects(publicRequest('https://127.0.0.1'));
  assert.equal(checkedUrl('https://example.com/products').pathname, '/products');
});
test('legacy migration preserves original bytes, migrates every company and runs only once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-migration-'));
  try {
    const oldPath = path.join(dir, 'legacy.db');
    const old = new Database(oldPath);
    old.exec(
      'CREATE TABLE companies (id INTEGER PRIMARY KEY,company_name TEXT,website TEXT,country TEXT,industry TEXT,lead_status TEXT,qualification_notes TEXT,main_products TEXT); CREATE TABLE contacts (id INTEGER PRIMARY KEY,company_id INTEGER,full_name TEXT); CREATE TABLE orders (id INTEGER PRIMARY KEY,order_value_eur REAL);',
    );
    old
      .prepare('INSERT INTO companies VALUES (?,?,?,?,?,?,?,?)')
      .run(
        42,
        'Müller GmbH',
        'www.example.com',
        'Germany',
        'Pumps',
        'QUALIFIED',
        'Old qualification reasoning.',
        'Industrial pumps',
      );
    old.prepare('INSERT INTO contacts VALUES (?,?,?)').run(1, 42, 'Preserved Contact');
    old.prepare('INSERT INTO orders VALUES (?,?)').run(1, 5000);
    old.close();
    const originalHash = hash(fs.readFileSync(oldPath));
    const first = openDatabase(path.join(dir, 'new'), oldPath);
    const lead = first.db.prepare('SELECT * FROM leads').get() as Record<string, unknown>;
    assert.equal(lead.name, 'Müller GmbH');
    assert.equal(lead.status, 'UNREVIEWED');
    assert.equal(lead.legacy_id, 42);
    assert.equal(lead.notes, 'Products: Industrial pumps');
    assert.equal(
      JSON.parse(String(lead.legacy_json)).qualification_notes,
      'Old qualification reasoning.',
    );
    assert.equal(lead.project_id, 1);
    const project = first.db.prepare('SELECT * FROM projects').get() as Record<string, unknown>;
    assert.equal(project.name, 'Sintertechnik');
    assert.equal(project.active_version, null);
    const contact = first.db.prepare('SELECT * FROM preserved_research').get() as {
      data_json: string;
      lead_id: number;
      project_id: number;
    };
    assert.equal(JSON.parse(contact.data_json).full_name, 'Preserved Contact');
    assert.equal(contact.lead_id, lead.id);
    assert.equal(contact.project_id, project.id);
    first.db.close();
    const second = openDatabase(path.join(dir, 'new'), oldPath);
    assert.equal((second.db.prepare('SELECT COUNT(*) n FROM leads').get() as { n: number }).n, 1);
    assert.equal(
      (second.db.prepare('SELECT COUNT(*) n FROM preserved_research').get() as { n: number }).n,
      1,
    );
    assert.equal(
      (second.db.prepare('SELECT revision FROM leads').get() as { revision: number }).revision,
      lead.revision,
    );
    second.db.close();
    assert.equal(hash(fs.readFileSync(oldPath)), originalHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('restoring research into an existing installation preserves edits and snapshots and invalidates earlier qualifications only once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-restore-'));
  const oldPath = path.join(dir, 'legacy.db');
  try {
    const old = new Database(oldPath);
    old.exec(`CREATE TABLE companies (id INTEGER PRIMARY KEY,company_name TEXT,qualification_notes TEXT);
      CREATE TABLE contacts (id INTEGER PRIMARY KEY,company_id INTEGER,full_name TEXT,unknown_original_field TEXT);
      CREATE TABLE activities (id INTEGER PRIMARY KEY,company_id INTEGER,subject TEXT,activity_date TEXT);
      CREATE TABLE notes (id INTEGER PRIMARY KEY,company_id INTEGER,message TEXT);
      CREATE TABLE research_history (id INTEGER PRIMARY KEY,saved_to_company_id INTEGER,results_json TEXT);
      INSERT INTO companies VALUES(42,'Original company','Historical reasoning');
      INSERT INTO contacts VALUES(1,42,'Saved person','Preserve this too');
      INSERT INTO activities VALUES(1,42,'Original research','2024-01-01');
      INSERT INTO notes VALUES(1,42,'Original note');
      INSERT INTO research_history VALUES(1,42,'{"finding":"Saved research result"}');
      INSERT INTO research_history VALUES(2,NULL,'{"finding":"Unlinked project research"}');`);
    old.close();
    const originalBytes = hash(fs.readFileSync(oldPath));
    const first = openDatabase(path.join(dir, 'active'), oldPath);
    const originalCompany = first.db.prepare('SELECT legacy_json FROM leads').get();
    // Model an already-upgraded database from before research-record restoration existed.
    first.db.exec(
      "DROP TABLE preserved_research; DELETE FROM meta WHERE key IN ('preserved_research_v1','starter_project_id'); UPDATE leads SET name='User edited company',notes='Current user notes',revision=8,status='QUALIFIED',latest_run_id=7; UPDATE projects SET description='Current project objective',revision=5;",
    );
    first.db.close();
    const upgraded = openDatabase(path.join(dir, 'active'), oldPath);
    const lead = upgraded.db.prepare('SELECT * FROM leads').get() as Record<string, unknown>;
    assert.equal(lead.name, 'User edited company');
    assert.equal(lead.notes, 'Current user notes');
    assert.equal(lead.revision, 9);
    assert.equal(lead.status, 'QUALIFIED');
    assert.equal(lead.latest_run_id, 7);
    assert.deepEqual(upgraded.db.prepare('SELECT legacy_json FROM leads').get(), originalCompany);
    assert.equal(
      (upgraded.db.prepare('SELECT COUNT(*) n FROM preserved_research').get() as { n: number }).n,
      5,
    );
    assert.equal(
      (
        upgraded.db
          .prepare('SELECT COUNT(*) n FROM preserved_research WHERE lead_id IS NULL')
          .get() as { n: number }
      ).n,
      1,
    );
    const contact = upgraded.db
      .prepare("SELECT data_json FROM preserved_research WHERE kind='contacts'")
      .get() as { data_json: string };
    assert.equal(JSON.parse(contact.data_json).unknown_original_field, 'Preserve this too');
    assert.equal(
      (upgraded.db.prepare('SELECT description FROM projects').get() as { description: string })
        .description,
      'Current project objective',
    );
    upgraded.db.close();
    const again = openDatabase(path.join(dir, 'active'), oldPath);
    assert.equal(
      (again.db.prepare('SELECT revision FROM leads').get() as { revision: number }).revision,
      9,
    );
    assert.equal(
      (again.db.prepare('SELECT COUNT(*) n FROM preserved_research').get() as { n: number }).n,
      5,
    );
    again.db.close();
    assert.equal(hash(fs.readFileSync(oldPath)), originalBytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('encryption round trips and refuses lost/corrupt master keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-secrets-'));
  try {
    const secrets = secretStore(dir);
    const encrypted = secrets.encrypt('very-private-api-key');
    assert.notEqual(encrypted, 'very-private-api-key');
    assert.equal(secrets.decrypt(encrypted), 'very-private-api-key');
    const opened = openDatabase(dir);
    opened.db.close();
    fs.unlinkSync(path.join(dir, '.innovista-encryption-key'));
    assert.throws(() => openDatabase(dir), /Encryption key missing/);
    fs.writeFileSync(path.join(dir, '.innovista-encryption-key'), 'invalid');
    assert.throws(() => secretStore(dir), /Invalid encryption key file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('production requires an HTTPS origin and setup token; cookies and headers are hardened', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-production-'));
  const original = process.env.INNOVISTA_SETUP_TOKEN;
  process.env.INNOVISTA_SETUP_TOKEN = 'test-bootstrap-token-with-enough-entropy';
  const { app, db } = createApp({
    dataDir: dir,
    production: true,
    origin: 'https://research.example.com',
  });
  try {
    const setup = (body: object) =>
      request(app)
        .post('/api/auth/setup')
        .set('Host', 'research.example.com')
        .set('Origin', 'https://research.example.com')
        .set('X-Requested-With', 'Innovista')
        .send(body);
    const input = {
      name: 'Production Test',
      username: 'production-test',
      password: 'very-long-new-password',
    };
    assert.equal((await setup(input)).status, 403);
    const response = await setup({
      ...input,
      setup_token: process.env.INNOVISTA_SETUP_TOKEN,
    });
    assert.equal(response.status, 201);
    assert.match(response.headers['set-cookie'][0], /Secure/);
    assert.match(response.headers['set-cookie'][0], /HttpOnly/);
    assert.match(response.headers['content-security-policy'], /script-src 'self';/);
    assert.ok(
      !response.headers['content-security-policy'].includes("script-src 'self' 'unsafe-inline'"),
    );
    assert.match(response.headers['strict-transport-security'], /max-age/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-powered-by'], undefined);
  } finally {
    db.close();
    if (original === undefined) delete process.env.INNOVISTA_SETUP_TOKEN;
    else process.env.INNOVISTA_SETUP_TOKEN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const b of buffer) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files: Record<string, string>) {
  const entries: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name),
      data = Buffer.from(value),
      crc = crc32(data);
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
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, directory, end]);
}
test('DOCX documents are extracted in a bounded worker and non-document archives are rejected', async () => {
  const text =
    'This company designs precision industrial pumps with an experienced in-house engineering team.';
  const buffer = zip({
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' +
      text +
      '</w:t></w:r></w:p></w:body></w:document>',
  });
  const file = {
    originalname: 'training.docx',
    buffer,
    size: buffer.length,
  } as Express.Multer.File;
  assert.ok((await extractDocument(file)).includes(text));
  const bad = zip({ 'unrelated.xml': '<test />' });
  await assert.rejects(
    extractDocument({ ...file, buffer: bad, size: bad.length }),
    /could not be read/,
  );
});
test('a real text PDF is extracted and encrypted/invalid PDF data is rejected', async () => {
  const text =
    'Research training: qualify manufacturers with engineering teams and industrial pump applications.';
  const stream = 'BT /F1 12 Tf 40 100 Td (' + text + ') Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += i + 1 + ' 0 obj\n' + object + '\nendobj\n';
  });
  const start = Buffer.byteLength(pdf);
  pdf +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' +
    start +
    '\n%%EOF';
  const buffer = Buffer.from(pdf);
  assert.ok(
    (
      await extractDocument({
        originalname: 'training.pdf',
        buffer,
        size: buffer.length,
      } as Express.Multer.File)
    ).includes('qualify manufacturers'),
  );
  const invalid = Buffer.from('%PDF-invalid');
  await assert.rejects(
    extractDocument({
      originalname: 'invalid.pdf',
      buffer: invalid,
      size: invalid.length,
    } as Express.Multer.File),
  );
});

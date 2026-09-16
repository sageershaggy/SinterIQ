import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const execute = promisify(execFile);
const KEY_FILENAME = '.innovista-encryption-key';
const KEY_FIXTURE = 'ab'.repeat(32);
const SET_NAME = /^innovista-backup-\d{8}T\d{6}Z$/;
const uploaded = Buffer.from('%PDF-1.4 disposable training document fixture');

const temporary = (label: string) => fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-' + label));

/**
 * A running installation, complete with an uploaded document as a BLOB and the encryption key.
 * The returned connection is deliberately left open: the point of the script is that it can copy
 * the database while the server is still using it.
 */
function liveWorkspace(directory: string) {
  const db = new Database(path.join(directory, 'innovista.db'));
  db.pragma('journal_mode = WAL');
  // Nothing is ever checkpointed here, so every row stays in innovista.db-wal and innovista.db
  // keeps its 4 KB header -- the exact state of the real data directory, and the reason a plain
  // file copy of innovista.db is worthless. Turning the checkpoint off makes that deterministic
  // instead of depending on how much happened to be flushed.
  db.pragma('wal_autocheckpoint = 0');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE leads (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, title TEXT NOT NULL, original BLOB);
  `);
  db.prepare('INSERT INTO projects (id, name) VALUES (1, ?)').run('Sintertechnik');
  const lead = db.prepare('INSERT INTO leads (project_id, name) VALUES (1, ?)');
  for (let index = 0; index < 40; index++) lead.run('Disposable Lead ' + index);
  db.prepare('INSERT INTO sources (title, original) VALUES (?, ?)').run('Handbook', uploaded);
  fs.writeFileSync(path.join(directory, KEY_FILENAME), KEY_FIXTURE, { mode: 0o600 });
  return db;
}

async function backup(destination: string, dataDir: string, extra: string[] = [], remove = false) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    INNOVISTA_TEST: 'true',
    INNOVISTA_DATA_DIR: dataDir,
  };
  // The script accepts a master key from the environment; drop any the developer has configured so
  // the missing-key case is actually reached.
  if (remove) {
    delete env.INNOVISTA_ENCRYPTION_KEY;
    delete env.SINTERIQ_ENCRYPTION_KEY;
  }
  const argv = ['--import', 'tsx', 'scripts/backup.ts', destination, ...extra];
  try {
    const { stdout, stderr } = await execute(process.execPath, argv, { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

const setsIn = (destination: string) =>
  fs
    .readdirSync(destination)
    .filter((name) => SET_NAME.test(name))
    .sort();

test('a backup of the live database contains the rows that a plain file copy of innovista.db loses', async () => {
  const live = temporary('backup-live-');
  const destination = temporary('backup-destination-');
  const db = liveWorkspace(live);
  let copy: Database.Database | undefined;
  let naive: Database.Database | undefined;
  try {
    const source = path.join(live, 'innovista.db');
    assert.ok(fs.existsSync(source + '-wal'));
    const before = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');

    const result = await backup(destination, live);
    assert.equal(result.code, 0, result.stderr);

    const sets = setsIn(destination);
    assert.equal(sets.length, 1);
    const set = path.join(destination, sets[0]);
    // One consistent file plus the key, with no -wal/-shm siblings that would have to travel with
    // it and no chance of restoring half of a pair.
    assert.deepEqual(fs.readdirSync(set).sort(), [KEY_FILENAME, 'innovista.db']);
    assert.equal(fs.readFileSync(path.join(set, KEY_FILENAME), 'utf8'), KEY_FIXTURE);

    copy = new Database(path.join(set, 'innovista.db'), { readonly: true, fileMustExist: true });
    assert.equal(
      (copy.prepare('SELECT COUNT(*) AS count FROM leads').get() as { count: number }).count,
      40,
    );
    assert.equal(
      (copy.prepare('SELECT name FROM projects WHERE id=1').get() as { name: string }).name,
      'Sintertechnik',
    );
    assert.deepEqual(
      (copy.prepare('SELECT original FROM sources').get() as { original: Buffer }).original,
      uploaded,
    );
    assert.deepEqual(copy.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    assert.match(result.stdout, /integrity_check: ok/);

    // The failure this replaces: the same database copied the documented manual way.
    const naiveFile = path.join(destination, 'naive.db');
    fs.copyFileSync(source, naiveFile);
    naive = new Database(naiveFile, { readonly: true });
    assert.deepEqual(naive.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), []);
    assert.throws(() => naive?.prepare('SELECT COUNT(*) FROM leads').get(), /no such table: leads/);

    // Read-only throughout: the live files are untouched and the server can carry on writing.
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), before);
    assert.ok(fs.existsSync(source + '-wal'));
    db.prepare('INSERT INTO leads (project_id, name) VALUES (1, ?)').run('Added afterwards');
  } finally {
    copy?.close();
    naive?.close();
    if (db.open) db.close();
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('the backup states that it carries the key which decrypts every stored password', async () => {
  const live = temporary('backup-warning-');
  const destination = temporary('backup-warning-destination-');
  const db = liveWorkspace(live);
  try {
    const result = await backup(destination, live);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /WARNING: this backup contains \.innovista-encryption-key/);
    assert.match(result.stdout, /decrypts every project mailbox/);
    assert.match(result.stdout, /Store it encrypted and off this host/);
    assert.match(result.stdout, new RegExp('Wrote .*' + SET_NAME.source.slice(1, -1)));
  } finally {
    if (db.open) db.close();
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('a corrupt database fails loudly instead of leaving a backup that looks successful', async () => {
  const live = temporary('backup-corrupt-');
  const destination = temporary('backup-corrupt-destination-');
  try {
    fs.writeFileSync(
      path.join(live, 'innovista.db'),
      'not a database at all, just text\n'.repeat(80),
    );
    fs.writeFileSync(path.join(live, KEY_FILENAME), KEY_FIXTURE);
    const result = await backup(destination, live);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Backup failed/);
    assert.match(result.stderr, /not a database/);
    assert.doesNotMatch(result.stdout, /integrity_check: ok/);
    // No half-written set survives to be counted by retention or restored by mistake.
    assert.deepEqual(setsIn(destination), []);
  } finally {
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('an unreadable database and a missing encryption key both exit non-zero', async () => {
  const live = temporary('backup-missing-');
  const destination = temporary('backup-missing-destination-');
  const db = liveWorkspace(live);
  try {
    const absent = await backup(destination, path.join(live, 'no-such-directory'));
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /No database at/);
    assert.deepEqual(setsIn(destination), []);

    fs.rmSync(path.join(live, KEY_FILENAME));
    const keyless = await backup(destination, live, [], true);
    assert.equal(keyless.code, 1);
    assert.match(keyless.stderr, /no master key in the environment/);
    // A copy nobody could decrypt is not a backup, so it is not left behind either.
    assert.deepEqual(setsIn(destination), []);
  } finally {
    if (db.open) db.close();
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('retention keeps the newest backups, removes the rest and reports both', async () => {
  const live = temporary('backup-retention-');
  const byDefault = temporary('backup-retention-default-');
  const explicit = temporary('backup-retention-explicit-');
  const db = liveWorkspace(live);
  try {
    const older = [
      'innovista-backup-20250101T000000Z',
      'innovista-backup-20250202T000000Z',
      'innovista-backup-20250303T000000Z',
      'innovista-backup-20250404T000000Z',
      'innovista-backup-20250505T000000Z',
      'innovista-backup-20250606T000000Z',
      'innovista-backup-20250707T000000Z',
    ];
    for (const destination of [byDefault, explicit]) {
      for (const name of older) fs.mkdirSync(path.join(destination, name));
      fs.mkdirSync(path.join(destination, 'operator-tarballs'));
    }

    const standard = await backup(byDefault, live);
    assert.equal(standard.code, 0, standard.stderr);
    const kept = setsIn(byDefault);
    assert.equal(kept.length, 7);
    assert.deepEqual(kept.slice(0, 6), older.slice(1));
    assert.match(kept[6], SET_NAME);
    assert.match(standard.stdout, /Removed .*innovista-backup-20250101T000000Z/);
    assert.match(standard.stdout, /Retention: keeping the newest 7, 7 now held, 1 removed\./);

    const trimmed = await backup(explicit, live, ['--keep=2']);
    assert.equal(trimmed.code, 0, trimmed.stderr);
    const survivors = setsIn(explicit);
    assert.equal(survivors.length, 2);
    assert.equal(survivors[0], 'innovista-backup-20250707T000000Z');
    assert.match(survivors[1], SET_NAME);
    assert.match(trimmed.stdout, /Retention: keeping the newest 2, 2 now held, 6 removed\./);
    // Retention only ever deletes names this script wrote.
    for (const destination of [byDefault, explicit])
      assert.ok(fs.existsSync(path.join(destination, 'operator-tarballs')));
  } finally {
    if (db.open) db.close();
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(byDefault, { recursive: true, force: true });
    fs.rmSync(explicit, { recursive: true, force: true });
  }
});

test('a scheduler sees a non-zero exit for an unusable command line, and nothing is written', async () => {
  const live = temporary('backup-usage-');
  const db = liveWorkspace(live);
  try {
    const missing = await backup('', live);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /A destination directory is required/);
    assert.match(missing.stderr, /Usage: npx tsx scripts\/backup\.ts/);

    const destination = path.join(live, 'unused');
    for (const argument of ['--keep=0', '--keep', '--keep=daily', '--force']) {
      const rejected = await backup(destination, live, [argument]);
      assert.equal(rejected.code, 2, argument);
      assert.match(rejected.stderr, /Usage: npx tsx scripts\/backup\.ts/);
    }
    assert.ok(!fs.existsSync(destination));
  } finally {
    if (db.open) db.close();
    fs.rmSync(live, { recursive: true, force: true });
  }
});

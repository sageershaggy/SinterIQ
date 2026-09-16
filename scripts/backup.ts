import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvironment } from '../server/env';

const USAGE = 'Usage: npx tsx scripts/backup.ts <destination-directory> [--keep=<n>]';
const KEY_FILENAME = '.innovista-encryption-key';
const DEFAULT_KEEP = 7;
// Sets carry a sortable UTC stamp so retention can order them by name. Modification times are not
// trusted: copying a backup to another host or filesystem routinely rewrites them.
const SET_NAME = /^innovista-backup-\d{8}T\d{6}Z$/;

class BackupFailure extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
const fail = (message: string): never => {
  throw new BackupFailure(message);
};
const reject = (message: string): never => {
  throw new BackupFailure(message + '\n' + USAGE, 2);
};

// Set once the set directory exists, so a failure can delete a half-written backup.
let partial = '';

function parseArguments(argv: string[]) {
  let destination = '';
  let keep = DEFAULT_KEEP;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--keep' || argument.startsWith('--keep=')) {
      const value = argument === '--keep' ? argv[++index] : argument.slice('--keep='.length);
      if (!/^\d+$/.test(String(value)) || Number(value) < 1)
        reject('--keep needs a whole number of backups to keep, at least 1.');
      keep = Number(value);
    } else if (argument.startsWith('-')) reject('Unknown option ' + argument + '.');
    else if (destination) reject('Give exactly one destination directory.');
    else destination = argument;
  }
  if (!destination) reject('A destination directory is required.');
  return { destination: path.resolve(destination), keep };
}

function copyDatabase(source: string, target: string) {
  // The live database runs in WAL mode, so its newest committed rows sit in innovista.db-wal and
  // not yet in innovista.db. Copying the .db file alone therefore yields a stale database, or in a
  // freshly started installation one with no tables at all -- which is exactly what the 4 KB
  // innovista.db beside the 1.1 MB innovista.db-wal on this host would produce. VACUUM INTO asks
  // SQLite to write one consistent file that already contains everything the WAL holds, including
  // every uploaded training document stored as a BLOB, while the server keeps serving. The
  // connection is read-only so this pass can never write to live data, and the result has no
  // -wal/-shm siblings that would have to be kept together.
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try {
    live.prepare('VACUUM INTO ?').run(target);
  } finally {
    live.close();
  }
}

function verifyCopy(copy: string) {
  const verify = new Database(copy, { readonly: true, fileMustExist: true });
  let report: string;
  try {
    const rows = verify.pragma('integrity_check') as { integrity_check: string }[];
    report = rows.map((row) => row.integrity_check).join('; ');
  } finally {
    verify.close();
  }
  // Checked on the copy, never on the source: a backup that cannot be read back is not a backup,
  // and reporting success here is how a corrupt file survives until the day it is needed.
  if (report !== 'ok') fail('integrity_check on the copy reported: ' + report);
}

function run() {
  loadEnvironment();
  const { destination, keep } = parseArguments(process.argv.slice(2));
  const dataDir = path.resolve(process.env.INNOVISTA_DATA_DIR || 'data');
  const source = path.join(dataDir, 'innovista.db');
  if (!fs.existsSync(source))
    fail('No database at ' + source + '. Point INNOVISTA_DATA_DIR at the live data directory.');

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const setDir = path.join(destination, 'innovista-backup-' + stamp);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  // Not recursive: a second run inside the same second must fail rather than overwrite the first.
  fs.mkdirSync(setDir, { mode: 0o700 });
  partial = setDir;

  const copy = path.join(setDir, 'innovista.db');
  copyDatabase(source, copy);
  verifyCopy(copy);

  const keyFile = path.join(dataDir, KEY_FILENAME);
  const keyCopied = fs.existsSync(keyFile);
  if (keyCopied) {
    fs.copyFileSync(keyFile, path.join(setDir, KEY_FILENAME));
    fs.chmodSync(path.join(setDir, KEY_FILENAME), 0o600);
  } else if (!process.env.INNOVISTA_ENCRYPTION_KEY && !process.env.SINTERIQ_ENCRYPTION_KEY)
    fail(
      'No ' +
        KEY_FILENAME +
        ' in ' +
        dataDir +
        ' and no master key in the environment: every stored password in this copy would be unreadable after a restore.',
    );

  console.log('Wrote ' + setDir);
  for (const entry of fs.readdirSync(setDir).sort())
    console.log('  ' + entry + ' (' + fs.statSync(path.join(setDir, entry)).size + ' bytes)');
  console.log('  integrity_check: ok');

  const sets = fs
    .readdirSync(destination, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SET_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  // Only names this script writes are candidates, so anything else kept in the destination -- an
  // older manual tar, an unrelated directory -- is never deleted by retention.
  const expired = sets.slice(keep);
  for (const name of expired) {
    fs.rmSync(path.join(destination, name), { recursive: true, force: true });
    console.log('Removed ' + path.join(destination, name));
  }
  console.log(
    'Retention: keeping the newest ' +
      keep +
      ', ' +
      (sets.length - expired.length) +
      ' now held, ' +
      expired.length +
      ' removed.',
  );

  if ((destination + path.sep).startsWith(dataDir + path.sep))
    console.log(
      'WARNING: this destination is inside the live data directory, so the backup dies with it.',
    );
  console.log('');
  if (keyCopied)
    console.log(
      'WARNING: this backup contains ' +
        KEY_FILENAME +
        ', the key that decrypts every project mailbox\n' +
        'SMTP/IMAP password and the AI provider key held in the copied database. Anyone who can read\n' +
        'this directory can read those credentials. Store it encrypted and off this host.',
    );
  else
    console.log(
      'WARNING: the master key comes from the environment and is deliberately not in this backup, so\n' +
        'keep it with the deployment -- a restore without it cannot read a single stored password. The\n' +
        'copied database still holds all research and uploaded documents: store it encrypted and off\n' +
        'this host.',
    );
}

try {
  run();
} catch (error) {
  // A half-written set must never survive: retention counts sets, and an operator restoring under
  // pressure must not find a truncated copy where a verified one belongs.
  if (partial) fs.rmSync(partial, { recursive: true, force: true });
  const usage = error instanceof BackupFailure && error.exitCode === 2;
  console.error(
    (usage ? '' : 'Backup failed: ') +
      (error instanceof Error ? error.message : String(error)) +
      (usage ? '' : '\nNothing was written. Earlier backups in the destination are untouched.'),
  );
  process.exitCode = error instanceof BackupFailure ? error.exitCode : 1;
}

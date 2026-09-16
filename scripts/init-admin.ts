import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { loadEnvironment } from '../server/env';
import {
  createInitialAdministrator,
  generatedPassword,
  resetAccountPassword,
} from '../server/auth';
import { audit } from '../server/database';
import { HttpError } from '../server/validation';

loadEnvironment();
const file = path.resolve(process.env.INNOVISTA_DATA_DIR || 'data', 'innovista.db');
if (!fs.existsSync(file)) {
  console.error('Start the app once to initialize its database, then run npm run admin:init.');
  process.exit(1);
}
const db = new Database(file, { fileMustExist: true });
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
/**
 * Recovery, not a second way in. An account has no email address, so an administrator who has
 * forgotten their password needs another administrator to issue a new one — and the last
 * administrator has nobody to ask. This path costs shell access to the server and its database,
 * and it hands out the same kind of unique generated password the app does.
 */
function administratorToRecover(username: string) {
  const administrators = db
    .prepare("SELECT id,name,username,active FROM accounts WHERE role='admin' ORDER BY id")
    .all() as Array<{ id: number; name: string; username: string; active: number }>;
  if (!administrators.length)
    throw new HttpError(404, 'No administrator exists yet. Run npm run admin:init to create one.');
  const wanted = username.trim().toLowerCase();
  const account = wanted
    ? administrators.find((row) => row.username === wanted)
    : administrators.length === 1
      ? administrators[0]
      : undefined;
  if (!account)
    throw new HttpError(
      404,
      wanted
        ? 'No administrator account is named ' + wanted + '.'
        : 'This workspace has ' +
            administrators.length +
            ' administrators, so name the one to recover: npm run admin:init -- --reset <username>. Any other administrator can also reset it in Workspace settings.',
    );
  return account;
}
try {
  if (process.argv[2] === '--reset') {
    const account = administratorToRecover(process.argv[3] || '');
    if (!account.active) {
      // Being deactivated locks an administrator out just as thoroughly as forgetting a password.
      db.prepare('UPDATE accounts SET active=1 WHERE id=?').run(account.id);
      audit(db, null, 'Server operator', 'account.access_changed', account.id + ': true');
      console.log('That account was inactive and has been reactivated.');
    }
    const password = await resetAccountPassword(db, account, 'Server operator');
    console.log('Administrator password reset. Save it now; the password is shown only once.');
    console.log('Username: ' + account.username);
    console.log('Password: ' + password);
    console.log(
      'Every session for that account was signed out. Change the password in Workspace settings after signing in.',
    );
  } else {
    const password = generatedPassword();
    const user = await createInitialAdministrator(db, {
      username: process.argv[2] || 'admin',
      name: process.argv[3] || 'Workspace Administrator',
      password,
    });
    console.log('Administrator created. Save these credentials; the password is shown only once.');
    console.log('Username: ' + user.username);
    console.log('Password: ' + password);
    console.log('You can change your password in Workspace settings after signing in.');
  }
} catch (error) {
  console.error(
    error instanceof HttpError
      ? error.message
      : 'Administrator initialization failed. Check the username and database access.',
  );
  process.exitCode = 1;
} finally {
  db.close();
}

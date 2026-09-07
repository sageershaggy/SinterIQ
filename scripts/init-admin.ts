import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { loadEnvironment } from '../server/env';
import { createInitialAdministrator } from '../server/auth';
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
try {
  const password = crypto.randomBytes(18).toString('base64url');
  const user = await createInitialAdministrator(db, {
    username: process.argv[2] || 'admin',
    name: process.argv[3] || 'Workspace Administrator',
    password,
  });
  console.log('Administrator created. Save these credentials; the password is shown only once.');
  console.log('Username: ' + user.username);
  console.log('Password: ' + password);
  console.log('You can change your password in Workspace settings after signing in.');
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

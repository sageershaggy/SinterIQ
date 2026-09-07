import fs from 'node:fs';
import path from 'node:path';

export function loadEnvironment() {
  for (const filename of ['.env.local', '.env']) {
    const file = path.resolve(filename);
    if (!fs.existsSync(file)) continue;
    const parsed =
      process.env.INNOVISTA_TEST === 'true' ? {} : parseNodeEnv(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed))
      if (value !== undefined && process.env[key] === undefined) process.env[key] = value;
  }
}
import { parseEnv as parseNodeEnv } from 'node:util';

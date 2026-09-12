import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Rubric } from '../shared/types';
import { decryptWithKey, secretStore } from './secrets';
import { preserveLegacyResearch } from './legacy';

export const now = () => new Date().toISOString();
export const hash = (value: string | Buffer) =>
  crypto.createHash('sha256').update(value).digest('hex');
export function nameKey(name: string) {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/\b(gmbh|co|kg|ag|ltd|limited|inc|llc|mbh)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}
export function websiteKey(website: string) {
  try {
    return new URL(website).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
export type DB = Database.Database;
export type Secrets = ReturnType<typeof secretStore>;
export function openDatabase(dataDir: string, legacyPath?: string) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secrets = secretStore(dataDir);
  const db = new Database(path.join(dataDir, 'innovista.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','researcher')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
      csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1, trained_revision INTEGER, active_version INTEGER,
      rubric_json TEXT NOT NULL DEFAULT '{"summary":"","criteria":[],"exclusions":[],"questions":[]}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL CHECK(kind IN ('document','website','note')), title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
      original BLOB, mime TEXT NOT NULL DEFAULT 'text/plain', sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sources_project ON sources(project_id);
    CREATE TABLE IF NOT EXISTS training_versions (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), version INTEGER NOT NULL,
      revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
      UNIQUE(project_id, version)
    );
    CREATE TABLE IF NOT EXISTS training_analyses (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
      result_json TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      name_key TEXT NOT NULL, website TEXT NOT NULL DEFAULT '', website_key TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '', industry TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'UNREVIEWED', score INTEGER, confidence INTEGER,
      latest_run_id INTEGER, training_version INTEGER, qualified_revision INTEGER, reviewed INTEGER NOT NULL DEFAULT 0,
      legacy_id INTEGER UNIQUE, legacy_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS leads_project_name ON leads(project_id, name_key);
    CREATE INDEX IF NOT EXISTS leads_project_website ON leads(project_id, website_key);
    CREATE INDEX IF NOT EXISTS leads_project_status ON leads(project_id, status);
    CREATE TABLE IF NOT EXISTS qualification_runs (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), lead_id INTEGER NOT NULL REFERENCES leads(id),
      training_version INTEGER NOT NULL, lead_revision INTEGER NOT NULL, result_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
      FOREIGN KEY(project_id, training_version) REFERENCES training_versions(project_id, version)
    );
    CREATE INDEX IF NOT EXISTS runs_lead ON qualification_runs(lead_id);
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES qualification_runs(id),
      decision TEXT NOT NULL, notes TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id), actor TEXT NOT NULL,
      action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_members (
      project_id INTEGER NOT NULL REFERENCES projects(id), account_id INTEGER NOT NULL REFERENCES accounts(id),
      assigned_by TEXT NOT NULL, assigned_at TEXT NOT NULL, PRIMARY KEY (project_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS project_members_account ON project_members(account_id);
    CREATE TABLE IF NOT EXISTS lead_feedback (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id), run_id INTEGER REFERENCES qualification_runs(id),
      verdict TEXT NOT NULL CHECK(verdict IN ('CORRECT','INCORRECT')),
      expected_decision TEXT, notes TEXT NOT NULL, applied_version INTEGER,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lead_feedback_project ON lead_feedback(project_id, applied_version);
    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      outcome TEXT NOT NULL CHECK(outcome IN ('CONNECTED','NO_ANSWER','CALLBACK','NOT_INTERESTED','WRONG_CONTACT','MEETING_BOOKED')),
      notes TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS call_logs_lead ON call_logs(lead_id);
    CREATE TABLE IF NOT EXISTS email_messages (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('SENT','FAILED')), error TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_messages_lead ON email_messages(lead_id);
  `);
  // Additive columns for installations created before contact capture and calling existed.
  for (const [table, column, definition] of [
    ['leads', 'contact_name', "TEXT NOT NULL DEFAULT ''"],
    ['leads', 'contact_role', "TEXT NOT NULL DEFAULT ''"],
    ['leads', 'city', "TEXT NOT NULL DEFAULT ''"],
    ['leads', 'employee_count', "TEXT NOT NULL DEFAULT ''"],
    ['leads', 'contact_email', "TEXT NOT NULL DEFAULT ''"],
    ['leads', 'contact_phone', "TEXT NOT NULL DEFAULT ''"],
    ['leads', 'assigned_to', 'INTEGER REFERENCES accounts(id)'],
    ['leads', 'assigned_at', 'TEXT'],
  ] as const)
    if (
      !(
        db.prepare('SELECT * FROM pragma_table_info(?)').all(table) as Array<{ name: string }>
      ).some((info) => info.name === column)
    )
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  if (!db.prepare("SELECT 1 FROM meta WHERE key='initialized'").get())
    initialize(db, secrets, legacyPath);
  preserveLegacyResearch(db, legacyPath);
  return { db, secrets };
}

const seedRubric: Rubric = {
  summary:
    'Qualify prospects for Sintertechnik ceramic bearings, hybrid bearings and ceramic components. Assess the specific legal entity and its engineering authority. Bearing traders that resell bearings can be valid channel partners; bearing manufacturers are competitors. Treat unknown facts as research gaps, never infer exclusions solely from names or legal suffixes.',
  criteria: [
    'Manufactures products or production equipment that use bearings, or is a technical bearing trader/reseller with a credible channel opportunity.',
    'Has engineering, R&D or mechanical specification authority at the entity being reviewed.',
    'Has a relevant corrosive, hygienic, high-temperature, high-speed, vacuum or cryogenic application.',
    'Fits the ideal addressable size of 20–2000 employees, with repeat-project or industry multiplier potential.',
  ],
  exclusions: [
    'Rule 1/2: Manufactures bearings as a primary product or is a subsidiary of a bearing competitor.',
    'Rule 3: Pure nontechnical wholesaler, retailer, mail-order, rental or trade-and-installation business. Technical bearing resellers are exempt.',
    'Rule 4/5: Utility, software, pure service, MRO-only or site operator without mechanical design authority.',
    'Rule 6/7: Global enterprise or regional sales branch without local specification authority; identify a plausible parent separately.',
    'Rule 8/9: EPC/integrator using only third-party equipment or small craft end-user without relevant design authority.',
  ],
  questions: [
    'Review the migrated rules and examples. Confirm territory and how to treat borderline cases before publishing.',
  ],
};

function initialize(db: DB, secrets: Secrets, legacyPath?: string) {
  const legacy =
    legacyPath && fs.existsSync(legacyPath)
      ? new Database(legacyPath, { readonly: true, fileMustExist: true })
      : null;
  try {
    db.transaction(() => {
      const created = now();
      const projectId = Number(
        db
          .prepare(
            'INSERT INTO projects (name,description,website,rubric_json,created_at,updated_at) VALUES (?,?,?,?,?,?)',
          )
          .run(
            'Sintertechnik',
            'Precision ceramics, hybrid bearings and engineering-led prospect research.',
            'https://www.sintertechnik.com/',
            JSON.stringify(seedRubric),
            created,
            created,
          ).lastInsertRowid,
      );
      const training = fs.readFileSync(
        new URL('../docs/sintertechnik-training.md', import.meta.url),
        'utf8',
      );
      db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run(
        'starter_project_id',
        String(projectId),
      );
      db.prepare(
        'INSERT INTO sources (project_id,kind,title,content,filename,sha256,created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(
        projectId,
        'document',
        'Sintertechnik · qualification handbook',
        training,
        'sintertechnik-training.md',
        hash(training),
        created,
      );
      let count = 0;
      if (
        legacy?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companies'").get()
      ) {
        const insert = db.prepare(
          'INSERT INTO leads (project_id,name,name_key,website,website_key,country,industry,notes,legacy_id,legacy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        );
        for (const row of legacy.prepare('SELECT * FROM companies').iterate() as Iterable<
          Record<string, unknown>
        >) {
          const name = String(row.company_name || 'Unnamed legacy lead');
          let website = String(row.website || '').trim();
          if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
          try {
            const u = new URL(website);
            if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) website = '';
          } catch {
            website = '';
          }
          const notes = [
            ['Products', row.main_products],
            ['Business role', row.business_role],
            ['Company type', row.company_type],
            ['Employees', row.employee_count],
            ['Revenue EUR', row.revenue_eur],
            ['Corporate parent', row.corporate_parent],
            ['City', row.city],
          ]
            .filter(([, value]) => value !== null && value !== undefined && value !== '')
            .map(([label, value]) => label + ': ' + value)
            .join('\n')
            .slice(0, 10000);
          insert.run(
            projectId,
            name,
            nameKey(name),
            website,
            websiteKey(website),
            String(row.country || ''),
            String(row.industry || ''),
            notes,
            Number(row.id),
            JSON.stringify(row),
            String(row.created_at || created),
            created,
          );
          count++;
        }
      }
      if (
        legacy
          ?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'")
          .get()
      ) {
        const old = Object.fromEntries(
          (
            legacy.prepare('SELECT setting_key,setting_value FROM app_settings').all() as Array<{
              setting_key: string;
              setting_value: string;
            }>
          ).map((r) => [r.setting_key, r.setting_value]),
        );
        const upsert = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
        for (const [oldKey, key] of Object.entries({
          'llm.provider_type': 'provider',
          'llm.model': 'model',
          'llm.base_url': 'base_url',
        })) {
          if (old[oldKey]) upsert.run(key, old[oldKey]);
        }
        if (old['llm.api_key']) {
          try {
            // These names belong to the previous system and must not be renamed: they identify
            // the key file and variable that actually exist next to the old database.
            const envKey = process.env.SINTERIQ_ENCRYPTION_KEY;
            const keyFile = path.join(path.dirname(legacyPath!), '.sinteriq-encryption-key');
            const rawKey =
              envKey || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
            const key = Buffer.from(rawKey, /^[a-f0-9]{64}$/i.test(rawKey) ? 'hex' : 'base64');
            upsert.run('api_key', secrets.encrypt(decryptWithKey(old['llm.api_key'], key)));
          } catch {
            audit(
              db,
              projectId,
              'Migration',
              'settings.key_not_migrated',
              'The old key could not be decrypted. Re-enter it in Settings; the original database is preserved.',
            );
          }
        }
      }
      audit(
        db,
        projectId,
        'Migration',
        'project.created',
        count +
          ' legacy leads imported. Previous decisions are retained as legacy context and require qualification against approved training.',
      );
      db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('initialized', created);
    })();
  } finally {
    legacy?.close();
  }
}

export function audit(
  db: DB,
  projectId: number | null,
  actor: string,
  action: string,
  detail: string,
) {
  db.prepare(
    'INSERT INTO audit_events (project_id,actor,action,detail,created_at) VALUES (?,?,?,?,?)',
  ).run(projectId, actor, action, detail, now());
}

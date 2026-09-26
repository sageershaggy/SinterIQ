import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from '../server/app';
import { remainingSends } from '../server/outreach';
import type { Generate } from '../server/ai';
import type { DB } from '../server/database';
import type { Project } from '../shared/types';
import type { ProjectDeletionSummary } from '../shared/project-deletion';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;
const noAi: Generate = async () => {
  throw new Error('Project deletion must never call a provider.');
};
const researcherPassword = 'Disposable-delete-researcher-2026';
type Agent = ReturnType<typeof request.agent>;
const call = (
  agent: Agent,
  method: 'get' | 'post' | 'put' | 'delete',
  url: string,
  csrf: string,
  body?: object,
) => {
  const pending = agent[method]('/api' + url)
    .set('X-Requested-With', 'Innovista')
    .set('X-CSRF-Token', csrf);
  return body === undefined ? pending : pending.send(body);
};

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-delete-'));
  const { app, db } = createApp({ dataDir: directory, generate: noAi });
  const agent = request.agent(app);
  const setup = await call(agent, 'post', '/auth/setup', '', {
    name: 'Delete QA',
    username: 'delete-qa',
    password: 'Disposable-delete-QA-2026',
  });
  assert.equal(setup.status, 201, setup.text);
  const csrf = setup.body.csrf_token as string;
  const admin = (method: 'get' | 'post' | 'put' | 'delete', url: string, body?: object) =>
    call(agent, method, url, csrf, body);
  return {
    app,
    db,
    admin,
    directory,
    dispose() {
      db.close();
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('innovista-delete-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

/**
 * One of everything a project can hold, written straight to the database: the point is what the
 * deletion removes, not how each record is normally made. `tag` keeps unique values apart.
 */
function seed(db: DB, projectId: number, accountId: number, tag: string) {
  const at = new Date().toISOString();
  const insert = (sql: string, ...values: unknown[]) =>
    Number(db.prepare(sql).run(...values).lastInsertRowid);
  const lead = insert(
    'INSERT INTO leads (project_id,name,name_key,contact_email,assigned_to,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    projectId,
    'Lead ' + tag,
    'lead' + tag,
    'primary-' + tag + '@example.com',
    accountId,
    at,
    at,
  );
  const archived = insert(
    "INSERT INTO leads (project_id,name,name_key,archived_at,archived_reason,created_at,updated_at) VALUES (?,?,?,?,'Company closed',?,?)",
    projectId,
    'Archived lead ' + tag,
    'archived' + tag,
    at,
    at,
    at,
  );
  const source = insert(
    "INSERT INTO sources (project_id,kind,title,content,sha256,created_at) VALUES (?,'note','Notes ' || ?,'Disposable training note for the deletion test.',?,?)",
    projectId,
    tag,
    'sha-' + tag,
    at,
  );
  insert(
    "INSERT INTO source_uploads (project_id,source_id,filename,size,status,created_at,created_by) VALUES (?,?,'notes.md',10,'READ',?,'QA')",
    projectId,
    source,
    at,
  );
  insert(
    "INSERT INTO training_versions (project_id,version,revision,snapshot_json,created_at,created_by) VALUES (?,1,1,'{}',?,'QA')",
    projectId,
    at,
  );
  insert(
    "INSERT INTO training_analyses (project_id,revision,result_json,model,created_at,created_by) VALUES (?,1,'{}','fixture',?,'QA')",
    projectId,
    at,
  );
  const run = insert(
    "INSERT INTO qualification_runs (project_id,lead_id,training_version,lead_revision,result_json,evidence_json,provider,model,created_at,created_by) VALUES (?,?,1,1,'{}','[]','fixture','fixture',?,'QA')",
    projectId,
    lead,
    at,
  );
  db.prepare('UPDATE leads SET latest_run_id=? WHERE id=?').run(run, lead);
  insert(
    "INSERT INTO reviews (run_id,decision,notes,created_by,created_at) VALUES (?,'QUALIFIED','Reviewed in the deletion test.','QA',?)",
    run,
    at,
  );
  insert(
    "INSERT INTO lead_feedback (project_id,lead_id,run_id,verdict,notes,created_by,created_at) VALUES (?,?,?,'CORRECT','Feedback in the deletion test.','QA',?)",
    projectId,
    lead,
    run,
    at,
  );
  insert(
    "INSERT INTO call_logs (project_id,lead_id,outcome,notes,created_by,created_at) VALUES (?,?,'CALLBACK','Call back next week.','QA',?)",
    projectId,
    lead,
    at,
  );
  insert(
    "INSERT INTO lead_comments (project_id,lead_id,author_id,author,body,created_at) VALUES (?,?,?,'QA','A comment.',?)",
    projectId,
    lead,
    accountId,
    at,
  );
  insert(
    "INSERT INTO lead_status_events (project_id,lead_id,from_status,to_status,created_by_id,created_by,created_at) VALUES (?,?,'NEW','CONTACTED',?,'QA',?)",
    projectId,
    lead,
    accountId,
    at,
  );
  const contact = insert(
    "INSERT INTO lead_contacts (project_id,lead_id,name,name_key,role_category,email,source_url,evidence,created_at,created_by) VALUES (?,?,'Pat ' || ?,'pat' || ?,'purchasing',?,'https://example.com','Pat runs purchasing.',?,'QA')",
    projectId,
    lead,
    tag,
    tag,
    'pat-' + tag + '@example.com',
    at,
  );
  insert(
    "INSERT INTO lead_research_citations (project_id,lead_id,field,value,evidence,source_url,created_at,created_by) VALUES (?,?,'industry','Pumps','We make pumps.','https://example.com',?,'QA')",
    projectId,
    lead,
    at,
  );
  insert(
    "INSERT INTO lead_research_runs (project_id,lead_id,origin,lead_revision,result_revision,summary_json,created_at,created_by) VALUES (?,?,'manual',1,1,'{}',?,'QA')",
    projectId,
    lead,
    at,
  );
  insert(
    "INSERT INTO research_log_passes (project_id,lead_id,website,discovered,tried_json,applied_json,notes_json,refused_count,created_at,created_by) VALUES (?,?,'https://example.com',1,'[]','[]','[]',0,?,'QA')",
    projectId,
    lead,
    at,
  );
  insert(
    "INSERT INTO preserved_research (project_id,lead_id,kind,legacy_id,data_json,imported_at) VALUES (?,?,'notes',?,'{}',?)",
    projectId,
    lead,
    projectId * 1000,
    at,
  );
  insert(
    "INSERT INTO outreach_events (project_id,lead_id,outcome,notes,created_by,created_at) VALUES (?,?,'REPLIED','They replied.','QA',?)",
    projectId,
    lead,
    at,
  );
  // Mail: a sent message with an attachment, its delivery ledger row, and a legacy sent message
  // from before the ledger existed. All of them count toward the three-email limit.
  const recipient = 'primary-' + tag + '@example.com';
  const message = insert(
    "INSERT INTO email_messages (project_id,lead_id,to_email,subject,body,status,created_by,created_at) VALUES (?,?,?,'Hello','Body','SENT','QA',?)",
    projectId,
    lead,
    recipient,
    at,
  );
  const file = insert(
    "INSERT INTO email_files (project_id,kind,filename,content_type,size,sha256,data,account_id,created_by,created_at) VALUES (?,'attachment','brochure.pdf','application/pdf',3,'f',x'2d2d2d',?,'QA',?)",
    projectId,
    accountId,
    at,
  );
  insert(
    "INSERT INTO email_message_files (message_id,file_id,disposition) VALUES (?,?,'attachment')",
    message,
    file,
  );
  insert(
    "INSERT INTO email_deliveries (delivery_key,project_id,lead_id,recipient,status,message_id,started_at) VALUES (?,?,?,?,'SENT',?,?)",
    'manual-' + tag,
    projectId,
    lead,
    recipient,
    message,
    Date.now(),
  );
  insert(
    "INSERT INTO email_messages (project_id,lead_id,to_email,subject,body,status,created_by,created_at) VALUES (?,?,?,'Legacy','Body','SENT','QA',?)",
    projectId,
    lead,
    recipient,
    at,
  );
  const bounced = 'bounced-' + tag + '@example.com';
  insert(
    "INSERT INTO email_suppressions (recipient,reason,created_at) VALUES (?,'Email bounced.',?)",
    bounced,
    at,
  );
  insert(
    "INSERT INTO email_bounces (recipient,project_id,lead_id,source,created_at) VALUES (?,?,?,'SMTP',?)",
    bounced,
    projectId,
    lead,
    at,
  );
  insert(
    'INSERT INTO unsubscribe_tokens (token_hash,recipient) VALUES (?,?)',
    'token-' + tag,
    recipient,
  );
  // A running campaign with a queued sequence, drafts and templates.
  const funnel = insert(
    "INSERT INTO funnels (project_id,name,steps_json,status,created_at,created_by) VALUES (?,'Campaign ' || ?,'[]','ACTIVE',?,'QA')",
    projectId,
    tag,
    at,
  );
  insert(
    "INSERT INTO funnel_enrollments (project_id,funnel_id,lead_id,recipient,lead_revision,training_version,account_id,created_by,status,next_send_at,created_at,updated_at,contact_id) VALUES (?,?,?,?,1,1,?,'QA','QUEUED',?,?,?,?)",
    projectId,
    funnel,
    lead,
    'pat-' + tag + '@example.com',
    accountId,
    Date.now(),
    at,
    at,
    contact,
  );
  insert(
    "INSERT INTO email_drafts (project_id,lead_id,account_id,revision,document_json,updated_at) VALUES (?,?,?,1,'{}',?)",
    projectId,
    lead,
    accountId,
    at,
  );
  insert(
    "INSERT INTO project_email_templates (project_id,name,category,description,subject,preview_text,blocks_json,created_by,created_at) VALUES (?,'Intro','intro','','Hello','','[]','QA',?)",
    projectId,
    at,
  );
  // The mailbox: settings, the inbox cursor and received mail, linked and unlinked.
  db.prepare(
    "INSERT OR REPLACE INTO project_mailboxes (project_id,smtp_host,from_email,imap_host,imap_enabled) VALUES (?,'smtp.example.com',?,'imap.example.com',1)",
  ).run(projectId, 'sender-' + tag + '@example.com');
  insert(
    "INSERT INTO project_mailbox_cursors (project_id,uid_validity,last_uid) VALUES (?,'1',10)",
    projectId,
  );
  const received = (uid: number, linked: boolean) =>
    insert(
      "INSERT INTO incoming_messages (account_key,uid_validity,uid,internet_message_id,references_json,from_email,from_name,to_email,subject,body,received_at,project_id,lead_id,mailbox_project_id,created_at) VALUES (?,'1',?,'','[]',?,'','','Re: Hello','Thanks',?,?,?,?,?)",
      'inbox-' + tag,
      uid,
      recipient,
      at,
      linked ? projectId : null,
      linked ? lead : null,
      projectId,
      at,
    );
  received(1, true);
  received(2, false);
  // Updates feeds.
  insert(
    "INSERT INTO notifications (account_id,project_id,lead_id,kind,title,created_at) VALUES (?,?,?,'email','New reply',?)",
    accountId,
    projectId,
    lead,
    at,
  );
  insert(
    "INSERT INTO project_notifications (account_id,project_id,kind,title,created_at) VALUES (?,?,'training_published','Training v1 published',?)",
    accountId,
    projectId,
    at,
  );
  db.prepare(
    'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run('funnel_last_tick:' + projectId, String(Date.now()));
  return { lead, archived, recipient, bounced };
}

/** Every table and column that names a project, from the live schema. */
function projectReferences(db: DB) {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  const references: Array<[string, string]> = [];
  for (const table of tables) {
    if (table === 'projects') continue;
    const columns = (
      db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>
    ).map((column) => column.name);
    if (columns.includes('project_id')) references.push([table, 'project_id']);
    for (const key of db
      .prepare('SELECT "table" parent,"from" source FROM pragma_foreign_key_list(?)')
      .all(table) as Array<{ parent: string; source: string }>)
      if (key.parent === 'projects' && key.source !== 'project_id')
        references.push([table, key.source]);
  }
  return references;
}
const countRows = (db: DB, table: string, column: string, id: number) =>
  (
    db.prepare('SELECT COUNT(*) n FROM "' + table + '" WHERE "' + column + '"=?').get(id) as {
      n: number;
    }
  ).n;

test('an administrator deletes a project and every row it owned, and nothing else', async () => {
  const f = await fixture();
  try {
    // Two projects of our own; the starter project the database opens with is the one deleted,
    // so its meta marker is covered as well.
    const starter = Number(
      (
        f.db.prepare("SELECT value FROM meta WHERE key='starter_project_id'").get() as {
          value: string;
        }
      ).value,
    );
    const kept = (await f.admin('post', '/projects', { name: 'Kept project' })).body as Project;
    const researcher = await f.admin('post', '/users', {
      name: 'Delete Researcher',
      username: 'delete-researcher',
      password: researcherPassword,
      role: 'researcher',
    });
    assert.equal(researcher.status, 201, researcher.text);
    assert.equal(
      (
        await f.admin('put', '/users/' + researcher.body.id + '/projects', {
          project_ids: [starter, kept.id],
        })
      ).status,
      200,
    );
    // A few ordinary API writes, so the project's own audit trail and a real lead exist too.
    const apiLead = await f.admin('post', '/projects/' + starter + '/leads', { name: 'API lead' });
    assert.equal(apiLead.status, 201, apiLead.text);
    const doomed = seed(f.db, starter, researcher.body.id, 'doomed');
    const survivor = seed(f.db, kept.id, researcher.body.id, 'kept');
    // Mail the deleted project's inbox received, but that was linked (before mailboxes were per
    // project) to the kept project's lead, stays with that lead: only its pointer to the deleted
    // inbox is cleared.
    const crossLinked = Number(
      f.db
        .prepare(
          "INSERT INTO incoming_messages (account_key,uid_validity,uid,internet_message_id,references_json,from_email,from_name,to_email,subject,body,received_at,project_id,lead_id,mailbox_project_id,created_at) VALUES ('legacy','1',99,'','[]','x@example.com','','','Re','Hi',?,?,?,?,?)",
        )
        .run(new Date().toISOString(), kept.id, survivor.lead, starter, new Date().toISOString())
        .lastInsertRowid,
    );
    const references = projectReferences(f.db);
    const keptCounts = references.map(([table, column]) => countRows(f.db, table, column, kept.id));
    const sendsLeft = remainingSends(f.db, doomed.recipient);
    assert.equal(sendsLeft, 1, 'two sent messages count against the doomed recipient');
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);

    // The dialog's summary counts what is about to go.
    const summary = await f.admin('get', '/projects/' + starter + '/deletion-summary');
    assert.equal(summary.status, 200, summary.text);
    const counts = (summary.body as ProjectDeletionSummary).counts;
    assert.equal(counts.leads, 3);
    assert.equal(counts.archived_leads, 1);
    assert.equal(counts.runs, 1);
    assert.equal(counts.emails, 2);
    assert.equal(counts.queued_sequences, 1);
    assert.equal(counts.members, 1);
    assert.equal(counts.incoming_messages, 2);
    assert.equal((summary.body as ProjectDeletionSummary).mailbox, true);

    const deleted = await f.admin('delete', '/projects/' + starter, {
      confirm_name: 'Sintertechnik',
    });
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.body.name, 'Sintertechnik');
    assert.equal(deleted.body.removed.leads, 3);

    // Every row that named the deleted project is gone...
    assert.equal(f.db.prepare('SELECT 1 FROM projects WHERE id=?').get(starter), undefined);
    for (const [table, column] of references)
      if (table !== 'email_deliveries' && table !== 'email_bounces')
        assert.equal(countRows(f.db, table, column, starter), 0, table + '.' + column);
    // ...including the rows that only reach it through another table.
    for (const table of ['reviews', 'email_message_files'])
      assert.equal(
        (f.db.prepare('SELECT COUNT(*) n FROM ' + table).get() as { n: number }).n,
        1,
        table + ' keeps only the other project’s row',
      );
    assert.equal(
      f.db.prepare('SELECT 1 FROM leads WHERE id IN (?,?)').get(doomed.lead, doomed.archived),
      undefined,
    );
    // ...the other project is untouched...
    assert.deepEqual(
      references.map(([table, column]) => countRows(f.db, table, column, kept.id)),
      keptCounts,
    );
    assert.deepEqual(
      f.db
        .prepare('SELECT project_id,lead_id,mailbox_project_id FROM incoming_messages WHERE id=?')
        .get(crossLinked),
      { project_id: kept.id, lead_id: survivor.lead, mailbox_project_id: null },
    );
    assert.equal((await f.admin('get', '/projects/' + kept.id)).status, 200);
    // ...nothing dangles...
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    // ...the workspace-wide mail history survives, detached from ids a new project could reuse...
    assert.equal(remainingSends(f.db, doomed.recipient), sendsLeft);
    assert.ok(
      f.db.prepare('SELECT 1 FROM email_suppressions WHERE recipient=?').get(doomed.bounced),
    );
    assert.ok(
      f.db.prepare('SELECT 1 FROM unsubscribe_tokens WHERE recipient=?').get(doomed.recipient),
    );
    assert.deepEqual(
      f.db
        .prepare(
          'SELECT DISTINCT project_id,lead_id,message_id FROM email_deliveries WHERE recipient=?',
        )
        .all(doomed.recipient),
      [{ project_id: 0, lead_id: 0, message_id: null }],
    );
    assert.deepEqual(
      f.db
        .prepare('SELECT project_id,lead_id FROM email_bounces WHERE recipient=?')
        .get(doomed.bounced),
      { project_id: null, lead_id: null },
    );
    // ...meta no longer points at it, and the other project's pacing slot is its own...
    assert.equal(
      f.db.prepare("SELECT 1 FROM meta WHERE key='starter_project_id'").get(),
      undefined,
    );
    assert.equal(
      f.db.prepare('SELECT 1 FROM meta WHERE key=?').get('funnel_last_tick:' + starter),
      undefined,
    );
    assert.ok(f.db.prepare('SELECT 1 FROM meta WHERE key=?').get('funnel_last_tick:' + kept.id));
    // ...the researcher no longer reaches it...
    assert.equal(
      (
        f.db
          .prepare('SELECT COUNT(*) n FROM project_members WHERE account_id=?')
          .get(researcher.body.id) as { n: number }
      ).n,
      1,
    );
    // ...there is a workspace-level record of it...
    const record = f.db
      .prepare("SELECT project_id,actor,detail FROM audit_events WHERE action='project.deleted'")
      .all() as Array<{ project_id: number | null; actor: string; detail: string }>;
    assert.equal(record.length, 1);
    assert.equal(record[0].project_id, null);
    assert.equal(record[0].actor, 'Delete QA');
    assert.match(record[0].detail, /^Project Sintertechnik deleted, with 3 leads/);
    // ...and the snapshot taken first still holds all of it.
    assert.match(deleted.body.snapshot, /^backups\/before-delete-project-\d+-\d{8}T\d{9}Z\.db$/);
    const snapshot = path.join(f.directory, deleted.body.snapshot);
    assert.ok(fs.existsSync(snapshot));
    const copy = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
      assert.ok(copy.prepare('SELECT 1 FROM projects WHERE id=?').get(starter));
      assert.equal(
        (
          copy.prepare('SELECT COUNT(*) n FROM leads WHERE project_id=?').get(starter) as {
            n: number;
          }
        ).n,
        3,
      );
    } finally {
      copy.close();
    }
    // Deleting it again is a missing project.
    assert.equal(
      (await f.admin('delete', '/projects/' + starter, { confirm_name: 'Sintertechnik' })).status,
      404,
    );
  } finally {
    f.dispose();
  }
});

test('deletion is refused without the typed name, without CSRF, to researchers, and while mail is sending', async () => {
  const f = await fixture();
  try {
    const project = (await f.admin('post', '/projects', { name: 'Guarded project' }))
      .body as Project;
    const created = await f.admin('post', '/users', {
      name: 'Guard Researcher',
      username: 'guard-researcher',
      password: researcherPassword,
      role: 'researcher',
    });
    assert.equal(created.status, 201, created.text);
    await f.admin('put', '/users/' + created.body.id + '/projects', { project_ids: [project.id] });
    const exists = () => Boolean(f.db.prepare('SELECT 1 FROM projects WHERE id=?').get(project.id));
    const snapshots = () =>
      fs.existsSync(path.join(f.directory, 'backups'))
        ? fs.readdirSync(path.join(f.directory, 'backups')).length
        : 0;

    // No confirmation, a wrong one, or one that differs in case: refused, and no snapshot taken.
    for (const body of [{}, { confirm_name: 'Guarded' }, { confirm_name: 'guarded project' }]) {
      const refused = await f.admin('delete', '/projects/' + project.id, body);
      assert.equal(refused.status, 400, refused.text);
    }
    assert.ok(exists());
    assert.equal(snapshots(), 0);
    // Unknown project.
    assert.equal(
      (await f.admin('delete', '/projects/9999', { confirm_name: 'Guarded project' })).status,
      404,
    );
    assert.equal((await f.admin('get', '/projects/9999/deletion-summary')).status, 404);
    // Without the CSRF token.
    const agent = request.agent(f.app);
    const login = await agent
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'delete-qa', password: 'Disposable-delete-QA-2026' });
    assert.equal(login.status, 200, login.text);
    const noCsrf = await agent
      .delete('/api/projects/' + project.id)
      .set('X-Requested-With', 'Innovista')
      .send({ confirm_name: 'Guarded project' });
    assert.equal(noCsrf.status, 403, noCsrf.text);
    assert.ok(exists());
    // A researcher, even one assigned to the project, cannot delete it or read its summary.
    const researcher = request.agent(f.app);
    const signedIn = await researcher
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'guard-researcher', password: researcherPassword });
    assert.equal(signedIn.status, 200, signedIn.text);
    const csrf = signedIn.body.csrf_token as string;
    const forbidden = await call(researcher, 'delete', '/projects/' + project.id, csrf, {
      confirm_name: 'Guarded project',
    });
    assert.equal(forbidden.status, 403, forbidden.text);
    assert.equal(
      (await call(researcher, 'get', '/projects/' + project.id + '/deletion-summary', csrf)).status,
      403,
    );
    assert.ok(exists());
    // A message half-sent must finish before its history can go.
    const lead = await f.admin('post', '/projects/' + project.id + '/leads', { name: 'Busy lead' });
    f.db
      .prepare(
        "INSERT INTO email_deliveries (delivery_key,project_id,lead_id,recipient,status,started_at) VALUES ('busy',?,?,'busy@example.com','SENDING',?)",
      )
      .run(project.id, lead.body.id, Date.now());
    const busy = await f.admin('delete', '/projects/' + project.id, {
      confirm_name: 'Guarded project',
    });
    assert.equal(busy.status, 409, busy.text);
    assert.ok(exists());
    assert.equal(snapshots(), 0);
    f.db.prepare("UPDATE email_deliveries SET status='SENT' WHERE delivery_key='busy'").run();
    // With the exact name, it goes.
    const done = await f.admin('delete', '/projects/' + project.id, {
      confirm_name: ' Guarded project ',
    });
    assert.equal(done.status, 200, done.text);
    assert.ok(!exists());
    assert.equal(snapshots(), 1);
  } finally {
    f.dispose();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from '../server/app';
import type { Generate } from '../server/ai';
import type { CallQueue, CallQueueRow } from '../shared/calls';
import type { LeadCrm } from '../shared/crm';
import type { Lead, Project } from '../shared/types';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;
/** Calling and comments never reach a model; a call would be a bug, not a fixture gap. */
const noAi: Generate = async () => {
  throw new Error('This suite must never call a provider.');
};
const password = 'Disposable-caller-password-2026';
type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; csrf: string };
const send = (session: Session, method: 'post' | 'put' | 'delete', url: string, body?: object) => {
  const call = session.agent[method]('/api' + url)
    .set('X-Requested-With', 'Innovista')
    .set('X-CSRF-Token', session.csrf);
  return body === undefined ? call : call.send(body);
};

/**
 * An administrator, two projects, a researcher on the first project, a second researcher on the
 * first project and an outsider who only has the second project.
 */
async function fixture(dataDir?: string) {
  const directory = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-calls-'));
  const { app, db } = createApp({ dataDir: directory, generate: noAi });
  const admin: Session = { agent: request.agent(app), csrf: '' };
  const setup = await send(admin, 'post', '/auth/setup', {
    name: 'Calling Admin',
    username: 'calling-admin',
    password: 'Disposable-calling-admin-2026',
  });
  assert.equal(setup.status, 201, setup.text);
  admin.csrf = setup.body.csrf_token;
  const project = async (name: string) => {
    const created = await send(admin, 'post', '/projects', { name });
    assert.equal(created.status, 201, created.text);
    return created.body as Project;
  };
  const main = await project('Calling Project');
  const other = await project('Other Project');
  const person = async (username: string, name: string, projectIds: number[]) => {
    const created = await send(admin, 'post', '/users', {
      name,
      username,
      password,
      role: 'researcher',
    });
    assert.equal(created.status, 201, created.text);
    const granted = await send(admin, 'put', '/users/' + created.body.id + '/projects', {
      project_ids: projectIds,
    });
    assert.equal(granted.status, 200, granted.text);
    const agent = request.agent(app);
    const login = await agent
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username, password });
    assert.equal(login.status, 200, login.text);
    return { id: created.body.id as number, name, agent, csrf: login.body.csrf_token as string };
  };
  const caller = await person('main-caller', 'Main Caller', [main.id]);
  const colleague = await person('main-colleague', 'Main Colleague', [main.id]);
  const outsider = await person('outsider', 'Outside Researcher', [other.id]);
  const lead = async (target: Project, body: object) => {
    const created = await send(admin, 'post', '/projects/' + target.id + '/leads', body);
    assert.equal(created.status, 201, created.text);
    return created.body as Lead;
  };
  const assign = async (target: Project, item: Lead, accountId: number | null) => {
    const response = await send(
      admin,
      'put',
      '/projects/' + target.id + '/leads/' + item.id + '/assignment',
      { account_id: accountId },
    );
    assert.equal(response.status, 200, response.text);
  };
  return {
    app,
    db,
    directory,
    admin,
    main,
    other,
    caller,
    colleague,
    outsider,
    lead,
    assign,
    detail: async (session: Session, target: Project, item: Lead) => {
      const response = await session.agent.get('/api/projects/' + target.id + '/leads/' + item.id);
      assert.equal(response.status, 200, response.text);
      return response.body as Lead & LeadCrm;
    },
    dispose(keep = false) {
      db.close();
      if (keep) return;
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('innovista-calls-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

test('the Calls page lists every assigned lead, defaults researchers to their own and administrators to everyone', async () => {
  const f = await fixture();
  try {
    const base = '/api/projects/' + f.main.id + '/calls';
    const mine = await f.lead(f.main, {
      name: 'Researcher Pumps GmbH',
      contact_name: 'Ada Lovelace',
      contact_role: 'Purchasing',
      contact_phone: '+49 711 123456',
      contact_email: 'ada@researcher-pumps.example',
      city: 'Stuttgart',
      country: 'DE',
    });
    const admins = await f.lead(f.main, { name: 'Administrator Valves Ltd' });
    const pool = await f.lead(f.main, { name: 'Unassigned Seals AG' });
    await f.assign(f.main, mine, f.caller.id);
    await f.assign(f.main, admins, 1);

    // A researcher starts from "assigned to me".
    const own = (await f.caller.agent.get(base)).body as CallQueue;
    assert.equal(own.assignee, 'me');
    assert.deepEqual(
      own.rows.map((row) => row.name),
      ['Researcher Pumps GmbH'],
    );
    const row = own.rows[0];
    assert.equal(row.contact_name, 'Ada Lovelace');
    assert.equal(row.contact_phone, '+49 711 123456');
    assert.equal(row.contact_email, 'ada@researcher-pumps.example');
    assert.equal(row.city, 'Stuttgart');
    assert.equal(row.country, 'DE');
    assert.equal(row.assigned_to_name, 'Main Caller');
    assert.equal(row.call_status, null);
    assert.equal(row.call_stage, 'NO_CALL_YET');
    assert.equal(row.next_action, 'Make the first call');
    assert.equal(row.last_call_at, null);
    assert.equal(row.call_count, 0);
    // ...and can still look at the whole team's list.
    const team = (await f.caller.agent.get(base + '?assignee=all')).body as CallQueue;
    assert.deepEqual(team.rows.map((r) => r.name).sort(), [
      'Administrator Valves Ltd',
      'Researcher Pumps GmbH',
    ]);

    // An administrator starts from everyone, with a person filter.
    const everyone = (await f.admin.agent.get(base)).body as CallQueue;
    assert.equal(everyone.assignee, 'all');
    assert.equal(everyone.rows.length, 2);
    assert.ok(!everyone.rows.some((r) => r.name === 'Unassigned Seals AG'));
    assert.deepEqual(everyone.people.map((p) => p.name).sort(), [
      'Calling Admin',
      'Main Caller',
      'Main Colleague',
    ]);
    const filtered = (await f.admin.agent.get(base + '?assignee=' + f.caller.id)).body as CallQueue;
    assert.deepEqual(
      filtered.rows.map((r) => r.lead_id),
      [mine.id],
    );
    assert.equal((await f.admin.agent.get(base + '?assignee=someone')).status, 400);

    // Assigning a lead is all it takes to put it on the page.
    await f.assign(f.main, pool, f.caller.id);
    const after = (await f.caller.agent.get(base)).body as CallQueue;
    assert.deepEqual(after.rows.map((r) => r.name).sort(), [
      'Researcher Pumps GmbH',
      'Unassigned Seals AG',
    ]);
    // Returning it to the pool takes it off again.
    await f.assign(f.main, pool, null);
    assert.equal(((await f.caller.agent.get(base)).body as CallQueue).rows.length, 1);
  } finally {
    f.dispose();
  }
});

test('a manual call status is saved to the call history, dated only for a call back or follow-up', async () => {
  const f = await fixture();
  try {
    const item = await f.lead(f.main, { name: 'Status Update Pumps' });
    await f.assign(f.main, item, f.caller.id);
    const url = '/projects/' + f.main.id + '/leads/' + item.id + '/call-status';
    const saved = await send(f.caller, 'post', url, {
      outcome: 'CALLBACK',
      notes: 'Asked to call again on Monday.',
      next_action_at: '2026-10-05',
    });
    assert.equal(saved.status, 201, saved.text);
    const row = saved.body as CallQueueRow;
    assert.equal(row.call_status, 'CALLBACK');
    assert.equal(row.call_stage, 'FOLLOW_UP_REQUIRED');
    assert.equal(row.next_action, 'Call back');
    assert.equal(row.next_action_at, '2026-10-05');
    assert.equal(row.last_call_by, 'Main Caller');
    assert.equal(row.call_count, 1);
    assert.ok(row.last_call_at);

    // Notes are optional for a status update; the status is the record.
    const quick = await send(f.caller, 'post', url, { outcome: 'INTERESTED' });
    assert.equal(quick.status, 201, quick.text);
    assert.equal(quick.body.call_status, 'INTERESTED');
    assert.equal(quick.body.call_stage, 'COMPLETED');
    assert.equal(quick.body.next_action_at, null);

    // Only a call back or a follow-up carries a date, and it has to be a real one.
    const dated = await send(f.caller, 'post', url, {
      outcome: 'INTERESTED',
      next_action_at: '2026-10-05',
    });
    assert.equal(dated.status, 400, dated.text);
    assert.match(dated.body.error, /call back or a follow-up/);
    const impossible = await send(f.caller, 'post', url, {
      outcome: 'FOLLOW_UP',
      next_action_at: '2026-02-30',
    });
    assert.equal(impossible.status, 400, impossible.text);
    assert.equal((await send(f.caller, 'post', url, { outcome: 'CALLED' })).status, 400);

    // Every status the Calls page offers is accepted, and the lead's Calls tab can log them too.
    for (const outcome of ['CONNECTED', 'NO_ANSWER', 'NOT_INTERESTED', 'FOLLOW_UP'])
      assert.equal((await send(f.caller, 'post', url, { outcome })).status, 201, outcome);
    const logged = await send(
      f.caller,
      'post',
      '/projects/' + f.main.id + '/leads/' + item.id + '/calls',
      {
        outcome: 'FOLLOW_UP',
        notes: 'Send the brochure, then follow up.',
        next_action_at: '2026-10-09',
      },
    );
    assert.equal(logged.status, 201, logged.text);

    // All of it is in the lead's call history, newest first, and nothing earlier was rewritten.
    const detail = await f.detail(f.admin, f.main, item);
    assert.deepEqual(
      detail.calls!.map((call) => call.outcome),
      [
        'FOLLOW_UP',
        'FOLLOW_UP',
        'NOT_INTERESTED',
        'NO_ANSWER',
        'CONNECTED',
        'INTERESTED',
        'CALLBACK',
      ],
    );
    assert.equal(detail.calls![0].next_action_at, '2026-10-09');
    assert.equal(detail.calls![6].notes, 'Asked to call again on Monday.');
    assert.equal(detail.calls![6].next_action_at, '2026-10-05');
    const queue = (await f.admin.agent.get('/api/projects/' + f.main.id + '/calls'))
      .body as CallQueue;
    assert.equal(queue.rows[0].call_status, 'FOLLOW_UP');
    assert.equal(queue.rows[0].next_action_at, '2026-10-09');
    assert.equal(queue.rows[0].call_count, 7);
    const audit = f.db
      .prepare("SELECT detail FROM audit_events WHERE action='lead.call_logged' ORDER BY id")
      .all() as Array<{ detail: string }>;
    assert.equal(
      audit[0].detail,
      'Status Update Pumps: Call back requested (next action 2026-10-05)',
    );
  } finally {
    f.dispose();
  }
});

test('calls, statuses and comments never change the qualification, fit score, decision or revision', async () => {
  const f = await fixture();
  try {
    const item = await f.lead(f.main, { name: 'Qualified Bearings Buyer' });
    await f.assign(f.main, item, f.caller.id);
    // A lead with a real qualification history: a published version, a run and a review.
    f.db
      .prepare(
        'INSERT INTO training_versions (project_id,version,revision,snapshot_json,created_at,created_by) VALUES (?,?,?,?,?,?)',
      )
      .run(f.main.id, 1, 1, '{}', '2026-09-01T00:00:00.000Z', 'Calling Admin');
    const run = Number(
      f.db
        .prepare(
          'INSERT INTO qualification_runs (project_id,lead_id,training_version,lead_revision,result_json,evidence_json,provider,model,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          f.main.id,
          item.id,
          1,
          3,
          JSON.stringify({ decision: 'QUALIFIED', score: 86, summary: 'Fits.' }),
          '[]',
          'fixture',
          'fixture',
          '2026-09-01T00:00:00.000Z',
          'Calling Admin',
        ).lastInsertRowid,
    );
    f.db
      .prepare(
        'INSERT INTO reviews (run_id,decision,notes,created_by,created_at) VALUES (?,?,?,?,?)',
      )
      .run(run, 'QUALIFIED', 'Confirmed by a person.', 'Calling Admin', '2026-09-02T00:00:00.000Z');
    f.db
      .prepare(
        "UPDATE leads SET status='QUALIFIED',score=86,confidence=77,latest_run_id=?,training_version=1,revision=3,qualified_revision=3,reviewed=1 WHERE id=?",
      )
      .run(run, item.id);
    // Current against the published training, so a stale flag would be a real change.
    f.db
      .prepare('UPDATE projects SET active_version=1,trained_revision=revision WHERE id=?')
      .run(f.main.id);
    const snapshot = () => {
      const { updated_at: _ignored, ...row } = f.db
        .prepare('SELECT * FROM leads WHERE id=?')
        .get(item.id) as Record<string, unknown>;
      return JSON.stringify({
        row,
        runs: f.db.prepare('SELECT * FROM qualification_runs WHERE lead_id=?').all(item.id),
        reviews: f.db.prepare('SELECT * FROM reviews WHERE run_id=?').all(run),
      });
    };
    const before = snapshot();
    const leadUrl = '/projects/' + f.main.id + '/leads/' + item.id;
    assert.equal(
      (await send(f.caller, 'post', leadUrl + '/call-status', { outcome: 'NOT_INTERESTED' }))
        .status,
      201,
    );
    assert.equal(
      (
        await send(f.caller, 'post', leadUrl + '/calls', {
          outcome: 'CALLBACK',
          notes: 'Asked us to call back.',
          next_action_at: '2026-11-02',
        })
      ).status,
      201,
    );
    for (const [from, status] of [
      ['NEW', 'LOST'],
      ['LOST', 'NOT_INTERESTED'],
      ['NOT_INTERESTED', 'WON'],
    ])
      assert.equal(
        (await send(f.caller, 'put', leadUrl + '/pipeline-status', { from, status })).status,
        200,
      );
    const comment = await send(f.caller, 'post', leadUrl + '/comments', {
      body: 'Not interested this year; the decision stays with the research.',
    });
    assert.equal(comment.status, 201);
    assert.equal(snapshot(), before);
    const detail = await f.detail(f.admin, f.main, item);
    assert.equal(detail.status, 'QUALIFIED');
    assert.equal(detail.score, 86);
    assert.equal(detail.stale, false);
    assert.equal(detail.pipeline_status, 'WON');
  } finally {
    f.dispose();
  }
});

test('the manual lead status records who moved it, when, and from what, and refuses a stale change', async () => {
  const f = await fixture();
  try {
    const item = await f.lead(f.main, { name: 'Pipeline Pumps' });
    const url = '/projects/' + f.main.id + '/leads/' + item.id + '/pipeline-status';
    const fresh = await f.detail(f.caller, f.main, item);
    assert.equal(fresh.pipeline_status, 'NEW');
    assert.deepEqual(fresh.pipeline_changes, []);

    const contacted = await send(f.admin, 'put', url, { from: 'NEW', status: 'CONTACTED' });
    assert.equal(contacted.status, 200, contacted.text);
    assert.equal((contacted.body as LeadCrm).pipeline_status, 'CONTACTED');
    // A second person still looking at "New" is told rather than silently overwritten.
    const stale = await send(f.caller, 'put', url, { from: 'NEW', status: 'INTERESTED' });
    assert.equal(stale.status, 409, stale.text);
    assert.match(stale.body.error, /Contacted/);
    const same = await send(f.caller, 'put', url, { from: 'CONTACTED', status: 'CONTACTED' });
    assert.equal(same.status, 400, same.text);
    assert.equal(
      (await send(f.caller, 'put', url, { from: 'CONTACTED', status: 'ARCHIVED' })).status,
      400,
    );
    assert.equal(
      (await send(f.caller, 'put', url, { status: 'INTERESTED' })).status,
      400,
      'the status the person saw is required',
    );
    const meeting = await send(f.caller, 'put', url, {
      from: 'CONTACTED',
      status: 'MEETING_BOOKED',
    });
    assert.equal(meeting.status, 200, meeting.text);

    const crm = (await f.caller.agent.get('/api' + url.replace('/pipeline-status', '/crm')))
      .body as LeadCrm;
    assert.equal(crm.pipeline_status, 'MEETING_BOOKED');
    assert.deepEqual(
      crm.pipeline_changes.map((c) => [c.from_status, c.to_status, c.created_by]),
      [
        ['CONTACTED', 'MEETING_BOOKED', 'Main Caller'],
        ['NEW', 'CONTACTED', 'Calling Admin'],
      ],
    );
    assert.ok(crm.pipeline_changes.every((c) => c.created_at));
    const audit = f.db
      .prepare(
        "SELECT actor,detail FROM audit_events WHERE action='lead.status_changed' ORDER BY id",
      )
      .all();
    assert.deepEqual(audit, [
      { actor: 'Calling Admin', detail: 'Pipeline Pumps: New → Contacted' },
      { actor: 'Main Caller', detail: 'Pipeline Pumps: Contacted → Meeting booked' },
    ]);
  } finally {
    f.dispose();
  }
});

test('comments: authors edit and delete their own, administrators may delete any, nobody edits another', async () => {
  const f = await fixture();
  try {
    const item = await f.lead(f.main, { name: 'Commented Pumps' });
    const second = await f.lead(f.main, { name: 'Another Lead' });
    const url = '/projects/' + f.main.id + '/leads/' + item.id + '/comments';
    const added = await send(f.caller, 'post', url, { body: 'Spoke to the plant manager.' });
    assert.equal(added.status, 201, added.text);
    const mine = (added.body as LeadCrm).comments[0];
    assert.equal(mine.author, 'Main Caller');
    assert.equal(mine.body, 'Spoke to the plant manager.');
    assert.equal(mine.updated_at, null);
    assert.equal(mine.can_edit, true);
    assert.equal(mine.can_delete, true);
    assert.ok(mine.created_at);
    assert.equal((await send(f.caller, 'post', url, { body: '   ' })).status, 400);

    // Everyone on the project reads it; only the flags differ.
    const asAdmin = (await f.detail(f.admin, f.main, item)).comments![0];
    assert.equal(asAdmin.can_edit, false);
    assert.equal(asAdmin.can_delete, true);
    const asColleague = (await f.detail(f.colleague, f.main, item)).comments![0];
    assert.equal(asColleague.can_edit, false);
    assert.equal(asColleague.can_delete, false);

    // Nobody edits another person's words, an administrator included.
    assert.equal(
      (await send(f.admin, 'put', url + '/' + mine.id, { body: 'Rewritten.' })).status,
      403,
    );
    assert.equal(
      (await send(f.colleague, 'put', url + '/' + mine.id, { body: 'Rewritten.' })).status,
      403,
    );
    assert.equal((await send(f.colleague, 'delete', url + '/' + mine.id)).status, 403);
    // A comment is only found through its own lead.
    const elsewhere = '/projects/' + f.main.id + '/leads/' + second.id + '/comments/' + mine.id;
    assert.equal((await send(f.caller, 'put', elsewhere, { body: 'Moved?' })).status, 404);
    assert.equal((await send(f.caller, 'delete', elsewhere)).status, 404);

    const edited = await send(f.caller, 'put', url + '/' + mine.id, {
      body: 'Spoke to the plant manager; send pricing.',
    });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.body.comments[0].body, 'Spoke to the plant manager; send pricing.');
    assert.ok(edited.body.comments[0].updated_at);

    const colleagues = await send(f.colleague, 'post', url, { body: 'I know their buyer.' });
    assert.equal(colleagues.status, 201);
    const theirs = (colleagues.body as LeadCrm).comments[0];
    // An administrator may remove anyone's comment.
    const removed = await send(f.admin, 'delete', url + '/' + theirs.id);
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(
      (removed.body as LeadCrm).comments.map((c) => c.id),
      [mine.id],
    );
    // An author may remove their own.
    const own = await send(f.caller, 'delete', url + '/' + mine.id);
    assert.equal(own.status, 200, own.text);
    assert.deepEqual((own.body as LeadCrm).comments, []);
    assert.equal((await send(f.caller, 'delete', url + '/' + mine.id)).status, 404);

    // The log says that it happened, never what the deleted comment said.
    const history = JSON.stringify(f.db.prepare('SELECT * FROM audit_events').all());
    assert.match(history, /lead\.comment_added/);
    assert.match(history, /lead\.comment_deleted/);
    assert.ok(!history.includes('plant manager'));
    assert.ok(!history.includes('their buyer'));
  } finally {
    f.dispose();
  }
});

test('project membership is the boundary: every calling and CRM route answers 404 outside it', async () => {
  const f = await fixture();
  try {
    const item = await f.lead(f.main, { name: 'Members Only Pumps' });
    await f.assign(f.main, item, f.caller.id);
    const theirs = await f.lead(f.other, { name: 'Outsider Project Lead' });
    const comment = await send(
      f.caller,
      'post',
      '/projects/' + f.main.id + '/leads/' + item.id + '/comments',
      { body: 'Members only.' },
    );
    const commentId = (comment.body as LeadCrm).comments[0].id;
    const lead = '/projects/' + f.main.id + '/leads/' + item.id;
    const reads = ['/projects/' + f.main.id + '/calls', lead + '/crm', lead];
    for (const url of reads) {
      const response = await f.outsider.agent.get('/api' + url);
      assert.equal(response.status, 404, url);
    }
    const writes: Array<['post' | 'put' | 'delete', string, object | undefined]> = [
      ['post', lead + '/call-status', { outcome: 'CONNECTED' }],
      ['put', lead + '/pipeline-status', { from: 'NEW', status: 'CONTACTED' }],
      ['post', lead + '/comments', { body: 'Probing.' }],
      ['put', lead + '/comments/' + commentId, { body: 'Probing.' }],
      ['delete', lead + '/comments/' + commentId, undefined],
    ];
    for (const [method, url, body] of writes) {
      const response = await send(f.outsider, method, url, body);
      assert.equal(response.status, 404, method + ' ' + url);
    }
    // A lead is never reached through another project's ID, even by someone in both.
    const crossed = '/projects/' + f.other.id + '/leads/' + item.id;
    assert.equal((await f.admin.agent.get('/api' + crossed + '/crm')).status, 404);
    assert.equal(
      (await send(f.admin, 'post', crossed + '/call-status', { outcome: 'CONNECTED' })).status,
      404,
    );
    assert.equal(
      (await send(f.admin, 'put', crossed + '/pipeline-status', { from: 'NEW', status: 'WON' }))
        .status,
      404,
    );
    assert.equal(
      (await send(f.admin, 'post', crossed + '/comments', { body: 'Crossed.' })).status,
      404,
    );
    // The outsider's own project works, and shows none of the other project's calls.
    const own = await f.outsider.agent.get('/api/projects/' + f.other.id + '/calls?assignee=all');
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(own.body.rows, []);
    assert.ok(!own.text.includes('Members Only Pumps'));
    assert.equal(theirs.project_id, f.other.id);
    // Nothing the outsider tried was recorded.
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM call_logs').get() as { n: number }).n, 0);
    assert.equal(
      (f.db.prepare('SELECT COUNT(*) n FROM lead_status_events').get() as { n: number }).n,
      0,
    );
    assert.equal(
      (f.db.prepare('SELECT COUNT(*) n FROM lead_comments').get() as { n: number }).n,
      1,
    );
  } finally {
    f.dispose();
  }
});

test('deleting a lead deletes its status history and comments with it', async () => {
  const f = await fixture();
  try {
    const count = (table: string, id: number) =>
      (
        f.db.prepare('SELECT COUNT(*) n FROM ' + table + ' WHERE lead_id=?').get(id) as {
          n: number;
        }
      ).n;
    const one = await f.lead(f.main, { name: 'Deleted Alone' });
    const bulk = await f.lead(f.main, { name: 'Deleted In Bulk' });
    const kept = await f.lead(f.main, { name: 'Kept Lead' });
    for (const item of [one, bulk, kept]) {
      const lead = '/projects/' + f.main.id + '/leads/' + item.id;
      assert.equal(
        (
          await send(f.admin, 'put', lead + '/pipeline-status', {
            from: 'NEW',
            status: 'CONTACTED',
          })
        ).status,
        200,
      );
      assert.equal(
        (await send(f.admin, 'post', lead + '/comments', { body: 'Noted.' })).status,
        201,
      );
      assert.equal(
        (await send(f.admin, 'post', lead + '/call-status', { outcome: 'NO_ANSWER' })).status,
        201,
      );
    }
    const removed = await f.admin.agent
      .delete('/api/projects/' + f.main.id + '/leads/' + one.id)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', f.admin.csrf);
    assert.equal(removed.status, 200, removed.text);
    const bulkRemoved = await send(f.admin, 'post', '/projects/' + f.main.id + '/leads/delete', {
      ids: [bulk.id],
    });
    assert.equal(bulkRemoved.status, 200, bulkRemoved.text);
    for (const item of [one, bulk])
      for (const table of ['lead_status_events', 'lead_comments', 'call_logs'])
        assert.equal(count(table, item.id), 0, table + ' for ' + item.name);
    for (const table of ['lead_status_events', 'lead_comments', 'call_logs'])
      assert.equal(count(table, kept.id), 1, table + ' for the kept lead');
  } finally {
    f.dispose();
  }
});

test('an existing call log is widened in place: old entries keep their ids and the new statuses fit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-calls-'));
  const f = await fixture(directory);
  const item = await f.lead(f.main, { name: 'Legacy Caller Ltd' });
  f.dispose(true);
  // Put the call log back the way installations before this change have it, with two entries.
  const raw = new Database(path.join(directory, 'innovista.db'));
  raw.exec(`
    DROP TABLE call_logs;
    CREATE TABLE call_logs (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      outcome TEXT NOT NULL CHECK(outcome IN ('CONNECTED','NO_ANSWER','CALLBACK','NOT_INTERESTED','WRONG_CONTACT','MEETING_BOOKED')),
      notes TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX call_logs_lead ON call_logs(lead_id);
  `);
  const insert = raw.prepare(
    'INSERT INTO call_logs (id,project_id,lead_id,outcome,notes,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
  );
  insert.run(
    11,
    f.main.id,
    item.id,
    'MEETING_BOOKED',
    'Booked a visit.',
    'Old Caller',
    '2026-01-01',
  );
  insert.run(
    12,
    f.main.id,
    item.id,
    'WRONG_CONTACT',
    'Reception only.',
    'Old Caller',
    '2026-01-02',
  );
  assert.throws(() => insert.run(13, f.main.id, item.id, 'FOLLOW_UP', 'x', 'x', 'x'), /CHECK/);
  raw.close();

  // Reopening the workspace widens the table without losing or renumbering anything.
  const reopened = createApp({ dataDir: directory, generate: noAi });
  try {
    const rows = reopened.db
      .prepare('SELECT id,outcome,notes,next_action_at FROM call_logs ORDER BY id')
      .all();
    assert.deepEqual(rows, [
      { id: 11, outcome: 'MEETING_BOOKED', notes: 'Booked a visit.', next_action_at: null },
      { id: 12, outcome: 'WRONG_CONTACT', notes: 'Reception only.', next_action_at: null },
    ]);
    reopened.db
      .prepare(
        'INSERT INTO call_logs (project_id,lead_id,outcome,notes,next_action_at,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        f.main.id,
        item.id,
        'FOLLOW_UP',
        'New status.',
        '2026-10-01',
        'New Caller',
        '2026-09-24',
      );
    assert.throws(
      () =>
        reopened.db
          .prepare(
            'INSERT INTO call_logs (project_id,lead_id,outcome,notes,created_by,created_at) VALUES (?,?,?,?,?,?)',
          )
          .run(f.main.id, item.id, 'MADE_UP', 'x', 'x', 'x'),
      /CHECK/,
    );
    assert.ok(
      reopened.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='call_logs_lead'")
        .get(),
      'the index survives the rebuild',
    );
    assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    reopened.db.close();
  }
  // A third open finds nothing to do and changes nothing.
  const again = createApp({ dataDir: directory, generate: noAi });
  try {
    const n = (again.db.prepare('SELECT COUNT(*) n FROM call_logs').get() as { n: number }).n;
    assert.equal(n, 3);
  } finally {
    again.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

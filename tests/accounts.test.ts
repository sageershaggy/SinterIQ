import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server/app';
import type { Generate } from '../server/ai';
import type { Lead, Project } from '../shared/types';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;
/** Account administration never reaches a model; a call would be a bug, not a fixture gap. */
const noAi: Generate = async () => {
  throw new Error('This suite must never call a provider.');
};
const researcherPassword = 'Disposable-researcher-2026';
type Agent = ReturnType<typeof request.agent>;
const send = (
  agent: Agent,
  method: 'post' | 'put' | 'patch',
  url: string,
  csrf: string,
  body?: object,
) => {
  const call = agent[method]('/api' + url)
    .set('X-Requested-With', 'Innovista')
    .set('X-CSRF-Token', csrf);
  return body === undefined ? call : call.send(body);
};
/** An administrator, two projects and their leads: enough to watch access being taken away. */
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-accounts-'));
  const { app, db } = createApp({ dataDir: directory, generate: noAi });
  const agent = request.agent(app);
  let csrf = '';
  const setup = await send(agent, 'post', '/auth/setup', csrf, {
    name: 'Accounts QA',
    username: 'accounts-qa',
    password: 'Disposable-accounts-QA-2026',
  });
  assert.equal(setup.status, 201, setup.text);
  csrf = setup.body.csrf_token;
  const admin = (method: 'post' | 'put' | 'patch', url: string, body?: object) =>
    send(agent, method, url, csrf, body);
  async function addProject(name: string) {
    const created = await admin('post', '/projects', { name });
    assert.equal(created.status, 201, created.text);
    return created.body as Project;
  }
  async function addLead(project: Project, name: string) {
    const created = await admin('post', '/projects/' + project.id + '/leads', { name });
    assert.equal(created.status, 201, created.text);
    return created.body as Lead;
  }
  /** A researcher account plus a signed-in agent of its own, to watch a session disappear. */
  async function addResearcher(username: string, name: string, projectIds: number[]) {
    const created = await admin('post', '/users', {
      name,
      username,
      password: researcherPassword,
      role: 'researcher',
    });
    assert.equal(created.status, 201, created.text);
    const id = created.body.id as number;
    const granted = await admin('put', '/users/' + id + '/projects', { project_ids: projectIds });
    assert.equal(granted.status, 200, granted.text);
    return { id, name, username, session: await signIn(app, username, researcherPassword) };
  }
  return {
    app,
    db,
    agent,
    admin,
    directory,
    addProject,
    addLead,
    addResearcher,
    get csrf() {
      return csrf;
    },
    assignment(project: Project, lead: Lead, accountId: number | null) {
      return admin('put', '/projects/' + project.id + '/leads/' + lead.id + '/assignment', {
        account_id: accountId,
      });
    },
    assignedTo(lead: Lead) {
      return db.prepare('SELECT assigned_to,assigned_at FROM leads WHERE id=?').get(lead.id) as {
        assigned_to: number | null;
        assigned_at: string | null;
      };
    },
    events(action: string) {
      return db
        .prepare('SELECT actor,detail FROM audit_events WHERE action=? ORDER BY id')
        .all(action) as Array<{ actor: string; detail: string }>;
    },
    /** Every recorded word, so a leaked secret has nowhere in the history to hide. */
    history() {
      return JSON.stringify(db.prepare('SELECT * FROM audit_events').all());
    },
    dispose() {
      db.close();
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('innovista-accounts-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}
async function signIn(
  app: Parameters<typeof request.agent>[0],
  username: string,
  password: string,
) {
  const agent = request.agent(app);
  const login = await agent
    .post('/api/auth/login')
    .set('X-Requested-With', 'Innovista')
    .send({ username, password });
  assert.equal(login.status, 200, login.text);
  return { agent, csrf: login.body.csrf_token as string };
}

test('an administrator issues a forgotten password once, and every old session of that account is gone', async () => {
  const f = await fixture();
  try {
    const researcher = await f.addResearcher('forgetful', 'Forgetful Researcher', []);
    // Two sessions: a reset closes the account everywhere, not just on the last computer used.
    const second = await signIn(f.app, 'forgetful', researcherPassword);
    assert.equal((await researcher.session.agent.get('/api/auth/me')).body.user.id, researcher.id);
    assert.equal((await second.agent.get('/api/auth/me')).body.user.id, researcher.id);
    // A researcher cannot reset anyone, including the administrator who can reset them.
    const forbidden = await researcher.session.agent
      .post('/api/users/1/password')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', researcher.session.csrf);
    assert.equal(forbidden.status, 403, forbidden.text);
    // A caller-supplied password is refused outright: only the server may choose one.
    const chosen = await f.admin('post', '/users/' + researcher.id + '/password', {
      password: 'Planted-by-the-administrator-2026',
    });
    assert.equal(chosen.status, 400, chosen.text);
    assert.ok(!chosen.text.includes('Planted-by-the-administrator-2026'));
    const reset = await f.admin('post', '/users/' + researcher.id + '/password');
    assert.equal(reset.status, 200, reset.text);
    const password = reset.body.password as string;
    assert.match(password, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(reset.body.name, 'Forgetful Researcher');
    assert.notEqual(password, researcherPassword);
    // Both sessions are revoked before the password is handed over.
    assert.equal((await researcher.session.agent.get('/api/auth/me')).body.user, null);
    assert.equal((await second.agent.get('/api/auth/me')).body.user, null);
    // The issued password works, and the forgotten one does not.
    const signedIn = await signIn(f.app, 'forgetful', password);
    assert.equal((await signedIn.agent.get('/api/auth/me')).body.user.id, researcher.id);
    const old = await request
      .agent(f.app)
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'forgetful', password: researcherPassword });
    assert.equal(old.status, 401);
    // The reset is on the record, and the record does not carry the password.
    const events = f.events('account.password_reset');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'Accounts QA');
    assert.match(events[0].detail, /Forgetful Researcher/);
    assert.ok(!f.history().includes(password));
    assert.ok(
      !(
        f.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(researcher.id) as {
          password_hash: string;
        }
      ).password_hash.includes(password),
    );
    // An administrator changes their own password with the current one, not by issuing a new one.
    assert.equal((await f.admin('post', '/users/1/password')).status, 400);
  } finally {
    f.dispose();
  }
});

test('a new password is refused for an inactive account and for an account that does not exist', async () => {
  const f = await fixture();
  try {
    const researcher = await f.addResearcher('departed', 'Departed Researcher', []);
    assert.equal(
      (await f.admin('patch', '/users/' + researcher.id, { active: false })).status,
      200,
    );
    const before = f.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(researcher.id);
    const refused = await f.admin('post', '/users/' + researcher.id + '/password');
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.body.error, /Activate this account/);
    assert.deepEqual(
      f.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(researcher.id),
      before,
    );
    assert.deepEqual(f.events('account.password_reset'), []);
    assert.equal((await f.admin('post', '/users/9999/password')).status, 404);
    // Reactivating is the deliberate first step, and then the reset works.
    assert.equal((await f.admin('patch', '/users/' + researcher.id, { active: true })).status, 200);
    const reset = await f.admin('post', '/users/' + researcher.id + '/password');
    assert.equal(reset.status, 200, reset.text);
    const signedIn = await signIn(f.app, 'departed', reset.body.password);
    assert.equal((await signedIn.agent.get('/api/auth/me')).body.user.id, researcher.id);
  } finally {
    f.dispose();
  }
});

test('revoking project access releases that project’s calling assignments and leaves the others alone', async () => {
  const f = await fixture();
  try {
    const kept = await f.addProject('Kept project');
    const revoked = await f.addProject('Revoked project');
    const keptLead = await f.addLead(kept, 'Lead that stays assigned');
    const revokedLead = await f.addLead(revoked, 'Lead that must come back');
    const colleagueLead = await f.addLead(revoked, "A colleague's lead");
    const caller = await f.addResearcher('caller', 'Calling Researcher', [kept.id, revoked.id]);
    const colleague = await f.addResearcher('colleague', 'Other Researcher', [revoked.id]);
    assert.equal((await f.assignment(kept, keptLead, caller.id)).status, 200);
    assert.equal((await f.assignment(revoked, revokedLead, caller.id)).status, 200);
    assert.equal((await f.assignment(revoked, colleagueLead, colleague.id)).status, 200);
    // A call already logged is history: releasing the assignment must not disturb it.
    const call = await f.admin(
      'post',
      '/projects/' + revoked.id + '/leads/' + revokedLead.id + '/calls',
      {
        outcome: 'CALLBACK',
        notes: 'Asked us to call again next week.',
      },
    );
    assert.equal(call.status, 201, call.text);
    const removal = await f.admin('put', '/users/' + caller.id + '/projects', {
      project_ids: [kept.id],
    });
    assert.equal(removal.status, 200, removal.text);
    assert.equal(removal.body.released, 1);
    assert.deepEqual(f.assignedTo(revokedLead), { assigned_to: null, assigned_at: null });
    assert.equal(f.assignedTo(keptLead).assigned_to, caller.id);
    assert.equal(f.assignedTo(colleagueLead).assigned_to, colleague.id);
    const events = f.events('leads.assignments_released');
    assert.equal(events.length, 1);
    assert.match(events[0].detail, /Calling Researcher: 1 lead/);
    assert.equal(events[0].actor, 'Accounts QA');
    assert.equal(
      (
        f.db
          .prepare('SELECT COUNT(*) AS count FROM call_logs WHERE lead_id=?')
          .get(revokedLead.id) as { count: number }
      ).count,
      1,
    );
    // Granting access again releases nothing, because nothing was taken away.
    const regranted = await f.admin('put', '/users/' + caller.id + '/projects', {
      project_ids: [kept.id, revoked.id],
    });
    assert.equal(regranted.status, 200, regranted.text);
    assert.equal(regranted.body.released, 0);
    assert.equal(f.events('leads.assignments_released').length, 1);
    assert.equal(f.assignedTo(keptLead).assigned_to, caller.id);
    // An administrator reaches every project by role, so removing their membership rows takes no
    // access away and their own assignment survives it.
    assert.equal(
      (await f.admin('put', '/users/1/projects', { project_ids: [revoked.id] })).status,
      200,
    );
    assert.equal((await f.assignment(revoked, revokedLead, 1)).status, 200);
    const admin = await f.admin('put', '/users/1/projects', { project_ids: [] });
    assert.equal(admin.body.released, 0);
    assert.equal(f.assignedTo(revokedLead).assigned_to, 1);
  } finally {
    f.dispose();
  }
});

test('deactivating an account releases its assignments in every project and nobody else’s', async () => {
  const f = await fixture();
  try {
    const first = await f.addProject('First project');
    const second = await f.addProject('Second project');
    const firstLead = await f.addLead(first, 'Lead in the first project');
    const secondLead = await f.addLead(second, 'Lead in the second project');
    const colleagueLead = await f.addLead(first, "A colleague's lead");
    const leaving = await f.addResearcher('leaving', 'Leaving Researcher', [first.id, second.id]);
    const colleague = await f.addResearcher('staying', 'Staying Researcher', [first.id]);
    assert.equal((await f.assignment(first, firstLead, leaving.id)).status, 200);
    assert.equal((await f.assignment(second, secondLead, leaving.id)).status, 200);
    assert.equal((await f.assignment(first, colleagueLead, colleague.id)).status, 200);
    const deactivated = await f.admin('patch', '/users/' + leaving.id, { active: false });
    assert.equal(deactivated.status, 200, deactivated.text);
    assert.equal(deactivated.body.released, 2);
    assert.deepEqual(f.assignedTo(firstLead), { assigned_to: null, assigned_at: null });
    assert.deepEqual(f.assignedTo(secondLead), { assigned_to: null, assigned_at: null });
    assert.equal(f.assignedTo(colleagueLead).assigned_to, colleague.id);
    const events = f.events('leads.assignments_released');
    assert.equal(events.length, 1);
    assert.match(events[0].detail, /Leaving Researcher: 2 lead/);
    // Reactivation is not a re-assignment: the leads stay in the pool.
    assert.equal((await f.admin('patch', '/users/' + leaving.id, { active: true })).status, 200);
    assert.equal(f.assignedTo(firstLead).assigned_to, null);
    assert.equal(f.events('leads.assignments_released').length, 1);
  } finally {
    f.dispose();
  }
});

test('an operator at the server recovers a locked-out administrator, and only a named one', async () => {
  const f = await fixture();
  const run = promisify(execFile);
  const shell = (...args: string[]) =>
    run(process.execPath, ['--import', 'tsx', 'scripts/init-admin.ts', ...args], {
      env: { ...process.env, INNOVISTA_TEST: 'true', INNOVISTA_DATA_DIR: f.directory },
    });
  try {
    // The sole administrator has nobody to ask, so shell access to the database is the way back.
    const recovered = await shell('--reset');
    const password = recovered.stdout.match(/Password: ([A-Za-z0-9_-]{24})/)?.[1];
    assert.ok(password, recovered.stdout);
    assert.match(recovered.stdout, /Username: accounts-qa/);
    // The administrator's own session went with the reset.
    assert.equal((await f.agent.get('/api/auth/me')).body.user, null);
    const signedIn = await signIn(f.app, 'accounts-qa', password);
    assert.equal((await signedIn.agent.get('/api/auth/me')).body.user.role, 'admin');
    const events = f.events('account.password_reset');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'Server operator');
    assert.ok(!f.history().includes(password));
    // With a second administrator the tool refuses to guess, and a researcher is not a candidate.
    const second = await send(signedIn.agent, 'post', '/users', signedIn.csrf, {
      name: 'Second Administrator',
      username: 'second-admin',
      password: researcherPassword,
      role: 'admin',
    });
    assert.equal(second.status, 201, second.text);
    await assert.rejects(shell('--reset'), /name the one to recover/);
    await assert.rejects(shell('--reset', 'accounts-qa-typo'), /No administrator account is named/);
    // A deactivated administrator is locked out just as thoroughly, and comes back active.
    assert.equal(
      (
        await send(signedIn.agent, 'patch', '/users/' + second.body.id, signedIn.csrf, {
          active: false,
        })
      ).status,
      200,
    );
    const reactivated = await shell('--reset', 'second-admin');
    assert.match(reactivated.stdout, /reactivated/);
    const back = await signIn(
      f.app,
      'second-admin',
      reactivated.stdout.match(/Password: ([A-Za-z0-9_-]{24})/)![1],
    );
    assert.equal((await back.agent.get('/api/auth/me')).body.user.role, 'admin');
  } finally {
    f.dispose();
  }
});

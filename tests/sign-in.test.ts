import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import type { Generate } from '../server/ai';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;
const noAi: Generate = async () => {
  throw new Error('Signing in must never call a provider.');
};
const adminPassword = 'Disposable-sign-in-admin-2026';
const researcherPassword = 'Disposable-sign-in-guest-2026';
const HOUR = 60 * 60_000;

/** A workspace with one administrator and one researcher (the Guest door). */
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-sign-in-'));
  const { app, db } = createApp({ dataDir: directory, generate: noAi });
  const agent = request.agent(app);
  const setup = await agent
    .post('/api/auth/setup')
    .set('X-Requested-With', 'Innovista')
    .send({ name: 'Sign-in Admin', username: 'sign-in-admin', password: adminPassword });
  assert.equal(setup.status, 201, setup.text);
  const created = await agent
    .post('/api/users')
    .set('X-Requested-With', 'Innovista')
    .set('X-CSRF-Token', setup.body.csrf_token)
    .send({
      name: 'Guest Researcher',
      username: 'guest-researcher',
      password: researcherPassword,
      role: 'researcher',
    });
  assert.equal(created.status, 201, created.text);
  const login = (body: object) => {
    const fresh = request.agent(app);
    return fresh
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send(body)
      .then(async (response) => ({
        response,
        me: (await fresh.get('/api/auth/me')).body as { user: { role: string } | null },
      }));
  };
  return {
    db,
    login,
    sessions: () => (db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n,
    dispose() {
      db.close();
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('innovista-sign-in-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}
const cookieMaxAge = (response: request.Response) => {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] || []);
  const session = cookies.find((cookie) => cookie.startsWith('innovista_session='));
  assert.ok(session, 'a session cookie is set');
  return Number(/Max-Age=(\d+)/.exec(session)?.[1]);
};

test('each portal admits only its own role, and a wrong door creates no session', async () => {
  const f = await fixture();
  try {
    const before = f.sessions();
    // An administrator through the Guest door is told which door is theirs, and stays signed out.
    const adminAsGuest = await f.login({
      username: 'sign-in-admin',
      password: adminPassword,
      portal: 'guest',
    });
    assert.equal(adminAsGuest.response.status, 403, adminAsGuest.response.text);
    assert.match(adminAsGuest.response.body.error, /Administrator tab/);
    assert.equal(adminAsGuest.response.headers['set-cookie'], undefined);
    assert.equal(adminAsGuest.me.user, null);
    // A team member through the Administrator door, likewise.
    const guestAsAdmin = await f.login({
      username: 'guest-researcher',
      password: researcherPassword,
      portal: 'admin',
    });
    assert.equal(guestAsAdmin.response.status, 403, guestAsAdmin.response.text);
    assert.match(guestAsAdmin.response.body.error, /Guest tab/);
    assert.equal(guestAsAdmin.me.user, null);
    assert.equal(f.sessions(), before);
    // Before the password is proven, the door reveals nothing: a wrong password and an unknown
    // account both get the same answer as they always did, whichever tab was used.
    for (const body of [
      { username: 'sign-in-admin', password: 'not-the-password-2026', portal: 'guest' },
      { username: 'guest-researcher', password: 'not-the-password-2026', portal: 'admin' },
      { username: 'nobody-here', password: 'not-the-password-2026', portal: 'admin' },
    ]) {
      const refused = await f.login(body);
      assert.equal(refused.response.status, 401, refused.response.text);
      assert.equal(refused.response.body.error, 'Invalid username or password.');
    }
    assert.equal(f.sessions(), before);
    // The right doors work.
    const admin = await f.login({
      username: 'sign-in-admin',
      password: adminPassword,
      portal: 'admin',
    });
    assert.equal(admin.response.status, 200, admin.response.text);
    assert.equal(admin.me.user?.role, 'admin');
    const guest = await f.login({
      username: 'guest-researcher',
      password: researcherPassword,
      portal: 'guest',
    });
    assert.equal(guest.response.status, 200, guest.response.text);
    assert.equal(guest.me.user?.role, 'researcher');
    // An unknown door is a malformed request, not a way around the check.
    const odd = await f.login({
      username: 'sign-in-admin',
      password: adminPassword,
      portal: 'owner',
    });
    assert.equal(odd.response.status, 400, odd.response.text);
  } finally {
    f.dispose();
  }
});

test('"Keep me signed in" makes the session last 30 days; otherwise it lasts 12 hours', async () => {
  const f = await fixture();
  try {
    const expiry = () =>
      (
        f.db.prepare('SELECT expires_at FROM sessions ORDER BY rowid DESC LIMIT 1').get() as {
          expires_at: number;
        }
      ).expires_at;
    const started = Date.now();
    const short = await f.login({
      username: 'guest-researcher',
      password: researcherPassword,
      portal: 'guest',
    });
    assert.equal(short.response.status, 200, short.response.text);
    assert.equal(cookieMaxAge(short.response), 12 * 60 * 60);
    assert.ok(Math.abs(expiry() - (started + 12 * HOUR)) < 60_000);
    const long = await f.login({
      username: 'guest-researcher',
      password: researcherPassword,
      portal: 'guest',
      remember: true,
    });
    assert.equal(long.response.status, 200, long.response.text);
    assert.equal(cookieMaxAge(long.response), 30 * 24 * 60 * 60);
    assert.ok(Math.abs(expiry() - (started + 30 * 24 * HOUR)) < 60_000);
    assert.equal(long.me.user?.role, 'researcher');
    // "remember" must be a real yes/no, not any truthy string.
    const odd = await f.login({
      username: 'guest-researcher',
      password: researcherPassword,
      remember: 'yes',
    });
    assert.equal(odd.response.status, 400, odd.response.text);
  } finally {
    f.dispose();
  }
});

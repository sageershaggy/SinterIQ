import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app';
import type { AiConfig } from '../server/ai';
import type { ListModels, ModelListing } from '../server/ai-settings';
import { presetsForKey, type ProviderDetection } from '../shared/ai-providers';
import type { Settings } from '../shared/types';

process.env.GEMINI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.INNOVISTA_SETUP_TOKEN;

const geminiKey = 'AIza' + 'A'.repeat(35);
const openRouterKey = 'sk-or-v1-' + 'b'.repeat(64);
const plainSk = 'sk-' + 'c'.repeat(32);

function fixture(listings: Record<string, ModelListing> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innovista-ai-settings-'));
  const calls: Array<{ provider: string; base_url: string; api_key: string }> = [];
  const used: AiConfig[] = [];
  const state = { fail: '' };
  const list: ListModels = async (target) => {
    calls.push(target);
    const key = target.provider === 'gemini' ? 'gemini' : target.base_url;
    return listings[key] || { ok: false, status: 401, reason: 'Invalid API key' };
  };
  const { app, db } = createApp({
    dataDir: dir,
    listModels: list,
    generate: async (config) => {
      used.push(config);
      if (state.fail) throw Object.assign(new Error(state.fail), {});
      return { ok: true };
    },
    fetchWebsite: async (url) => ({ url, content: '', truncated: false, links: [] }),
  });
  const agent = request.agent(app);
  let csrf = '';
  const send = (method: 'post' | 'put', url: string, body: object = {}) =>
    agent[method]('/api' + url)
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', csrf)
      .send(body);
  return {
    app,
    db,
    calls,
    used,
    state,
    get: (url: string) => agent.get('/api' + url),
    post: (url: string, body: object = {}) => send('post', url, body),
    put: (url: string, body: object) => send('put', url, body),
    async setup() {
      const response = await send('post', '/auth/setup', {
        name: 'Test Administrator',
        username: 'test-admin',
        password: 'A-long-test-password-2026',
      });
      assert.equal(response.status, 201, response.text);
      csrf = response.body.csrf_token;
    },
    dispose() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a key format points to its provider, and an ambiguous sk- key to both candidates', () => {
  assert.deepEqual(presetsForKey(geminiKey), ['gemini']);
  assert.deepEqual(presetsForKey('  ' + openRouterKey + '\n'), ['openrouter']);
  assert.deepEqual(presetsForKey('gsk_' + 'd'.repeat(40)), ['groq']);
  assert.deepEqual(presetsForKey('hf_' + 'e'.repeat(30)), ['huggingface']);
  assert.deepEqual(presetsForKey('sk-proj-' + 'f'.repeat(40)), ['openai']);
  assert.deepEqual(presetsForKey(plainSk), ['deepseek', 'openai']);
  assert.deepEqual(presetsForKey('sk-ant-api03-' + 'g'.repeat(40)), []);
  assert.deepEqual(presetsForKey('not a key'), []);
});

test('a pasted key is saved without the spaces and line breaks the paste added', async () => {
  const f = fixture();
  try {
    await f.setup();
    const saved = await f.put('/settings/llm', {
      provider: 'gemini',
      preset: 'gemini',
      model: 'gemini-2.5-flash',
      api_key: '  ' + geminiKey.slice(0, 20) + '\n' + geminiKey.slice(20) + '  ',
    });
    assert.equal(saved.status, 200, saved.text);
    const settings = saved.body as Settings;
    assert.equal(settings.api_key_preview, '••••' + geminiKey.slice(-4));
    assert.equal(settings.preset, 'gemini');
    assert.equal(JSON.stringify(settings).includes(geminiKey), false);
    // The key the provider receives is exactly the one that was meant.
    assert.equal((await f.post('/settings/llm/test', { mode: 'chat' })).status, 200);
    assert.equal(f.used.at(-1)!.api_key, geminiKey);
  } finally {
    f.dispose();
  }
});

test('a listed provider always uses its own endpoint, and a saved key never goes to another', async () => {
  const f = fixture();
  try {
    await f.setup();
    const saved = await f.put('/settings/llm', {
      provider: 'openai_compatible',
      preset: 'openrouter',
      model: 'google/gemini-2.5-flash',
      base_url: 'https://evil.example/v1',
      api_key: openRouterKey,
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.preset, 'openrouter');
    assert.equal(saved.body.base_url, 'https://openrouter.ai/api/v1');
    assert.equal((await f.get('/settings/llm')).body.preset, 'openrouter');

    // Switching provider without a new key is refused, naming the provider the key belongs to.
    const switched = await f.put('/settings/llm', {
      provider: 'openai_compatible',
      preset: 'groq',
      model: 'llama-3.3-70b-versatile',
    });
    assert.equal(switched.status, 400);
    assert.match(switched.body.error, /Groq.*OpenRouter/);
    // Nor can a connection test aim the saved key at another host.
    const aimed = await f.post('/settings/llm/test', {
      mode: 'chat',
      provider: 'openai_compatible',
      base_url: 'https://api.groq.com/openai/v1',
    });
    assert.equal(aimed.status, 400);
    assert.equal(f.used.length, 0);
  } finally {
    f.dispose();
  }
});

test('checking the saved setup records a connection status that a later change clears', async () => {
  const f = fixture();
  try {
    await f.setup();
    const put = (model: string, api_key = '') =>
      f.put('/settings/llm', { provider: 'gemini', preset: 'gemini', model, api_key });
    assert.equal((await put('gemini-2.5-flash', geminiKey)).body.status, null);

    const ok = await f.post('/settings/llm/test', { mode: 'chat' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.status.ok, true);
    const shown = (await f.get('/settings/llm')).body as Settings;
    assert.equal(shown.status!.ok, true);
    assert.equal(shown.status!.model, 'gemini-2.5-flash');
    assert.equal(typeof shown.status!.latency_ms, 'number');

    // A different model is a different setup: the old check no longer describes it.
    assert.equal((await put('gemini-2.5-pro')).body.status, null);

    f.state.fail = 'Gemini rejected the API key (API_KEY_INVALID).';
    const failed = await f.post('/settings/llm/test', { mode: 'chat' });
    assert.notEqual(failed.status, 200);
    const after = (await f.get('/settings/llm')).body as Settings;
    assert.equal(after.status!.ok, false);
    assert.match(after.status!.message, /rejected the API key|could not be reached/);

    // Testing a typed key that is not saved never overwrites the saved setup's status.
    f.state.fail = '';
    assert.equal(
      (await f.post('/settings/llm/test', { mode: 'chat', api_key: geminiKey })).status,
      200,
    );
    assert.equal(((await f.get('/settings/llm')).body as Settings).status!.ok, false);
  } finally {
    f.dispose();
  }
});

test('a pasted key is recognised, its models listed and a recommended one chosen', async () => {
  const f = fixture({
    'https://openrouter.ai/api/v1': {
      ok: true,
      models: [
        'openai/text-embedding-3-small',
        'meta-llama/llama-3.3-70b-instruct',
        'google/gemini-2.5-flash',
        'openai/dall-e-3',
      ],
    },
    'https://api.openai.com/v1': { ok: true, models: ['gpt-4.1-mini', 'whisper-1', 'gpt-4o'] },
  });
  try {
    await f.setup();
    const found = await f.post('/settings/llm/detect', { api_key: ' ' + openRouterKey + ' ' });
    assert.equal(found.status, 200, found.text);
    const detection = found.body as ProviderDetection;
    assert.equal(detection.preset, 'openrouter');
    assert.equal(detection.base_url, 'https://openrouter.ai/api/v1');
    assert.equal(detection.recommended, 'google/gemini-2.5-flash');
    assert.equal(detection.verified, true);
    // Embedding and image models cannot qualify a lead, so they are not offered.
    assert.deepEqual(
      detection.models.map((model) => [model.id, model.open]),
      [
        ['google/gemini-2.5-flash', false],
        ['meta-llama/llama-3.3-70b-instruct', true],
      ],
    );
    assert.equal(JSON.stringify(found.body).includes(openRouterKey), false);
    assert.deepEqual(f.calls.map((call) => call.base_url), ['https://openrouter.ai/api/v1']);

    // A plain sk- key is tried on DeepSeek, refused there, then accepted by OpenAI.
    const ambiguous = await f.post('/settings/llm/detect', { api_key: plainSk });
    assert.equal(ambiguous.status, 200, ambiguous.text);
    assert.equal(ambiguous.body.preset, 'openai');
    assert.equal(ambiguous.body.recommended, 'gpt-4.1-mini');
    assert.deepEqual(
      f.calls.slice(1).map((call) => call.base_url),
      ['https://api.deepseek.com/v1', 'https://api.openai.com/v1'],
    );

    // Formats that match nothing say what to do, and Anthropic keys say why.
    const unknown = await f.post('/settings/llm/detect', { api_key: 'x'.repeat(24) });
    assert.equal(unknown.status, 422);
    const claude = await f.post('/settings/llm/detect', { api_key: 'sk-ant-api03-' + 'h'.repeat(40) });
    assert.equal(claude.status, 422);
    assert.match(claude.body.error, /Anthropic/);

    // A key every candidate refuses is reported, not saved.
    const refused = await f.post('/settings/llm/detect', { api_key: 'gsk_' + 'i'.repeat(40) });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Groq refused this key/);
  } finally {
    f.dispose();
  }
});

test('a provider that does not list models is offered its recommended models unverified', async () => {
  const f = fixture({ 'https://router.huggingface.co/v1': { ok: false, status: 404, reason: '' } });
  try {
    await f.setup();
    const found = await f.post('/settings/llm/detect', { api_key: 'hf_' + 'j'.repeat(30) });
    assert.equal(found.status, 200, found.text);
    assert.equal(found.body.preset, 'huggingface');
    assert.equal(found.body.verified, false);
    assert.equal(found.body.recommended, 'meta-llama/Llama-3.3-70B-Instruct');
  } finally {
    f.dispose();
  }
});

test('the saved key is only ever checked against the provider it was saved for', async () => {
  const f = fixture({ gemini: { ok: true, models: ['gemini-2.5-flash', 'text-embedding-004'] } });
  try {
    await f.setup();
    await f.put('/settings/llm', {
      provider: 'gemini',
      preset: 'gemini',
      model: 'gemini-2.5-flash',
      api_key: geminiKey,
    });
    const own = await f.post('/settings/llm/detect', {});
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(own.body.models.map((model: { id: string }) => model.id), ['gemini-2.5-flash']);
    assert.equal(f.calls.at(-1)!.api_key, geminiKey);
    const elsewhere = await f.post('/settings/llm/detect', { preset: 'openrouter' });
    assert.equal(elsewhere.status, 400);
    assert.equal(f.calls.length, 1);
  } finally {
    f.dispose();
  }
});

test('only administrators can detect keys', async () => {
  const f = fixture();
  try {
    await f.setup();
    const created = await f.post('/users', {
      name: 'Plain Researcher',
      username: 'plain-researcher',
      password: 'Disposable-researcher-2026',
      role: 'researcher',
    });
    assert.equal(created.status, 201, created.text);
    const other = request.agent(f.app);
    const login = await other
      .post('/api/auth/login')
      .set('X-Requested-With', 'Innovista')
      .send({ username: 'plain-researcher', password: 'Disposable-researcher-2026' });
    assert.equal(login.status, 200, login.text);
    const refused = await other
      .post('/api/settings/llm/detect')
      .set('X-Requested-With', 'Innovista')
      .set('X-CSRF-Token', login.body.csrf_token)
      .send({ api_key: geminiKey });
    assert.equal(refused.status, 403);
    assert.equal(f.calls.length, 0);
  } finally {
    f.dispose();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import contextWordsBackend, { createApiHandler } from './api.mjs';

const saved = { baseUrl: 'https://provider.test/v1', model: 'fast-model', apiKey: 'test-only-secret' };
const messages = [{ role: 'user', content: 'Return JSON.' }];

function completion(value = { ok: true }) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
}

async function fixture(context, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'context-words-backend-'));
  let server;
  let baseUrl;
  async function start() {
    const handler = createApiHandler({ dataDirectory: directory, ...options });
    server = http.createServer((request, response) => {
      void handler(request, response).then(handled => {
        if (!handled) { response.statusCode = 404; response.end(); }
      }).catch(error => { response.statusCode = 500; response.end(error.message); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    const finished = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await finished;
  }
  context.after(async () => { await stop(); await fs.rm(directory, { recursive: true, force: true }); });
  await start();
  return {
    directory,
    async request(route, payload, method = 'POST', headers = {}) {
      return fetch(baseUrl + route, {
        method, headers: { 'Content-Type': 'application/json', ...headers },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    },
    get baseUrl() { return baseUrl; },
    async restart() { await stop(); await start(); },
  };
}

test('settings persist across restart, hide the key and keep it when only the model changes', async context => {
  const app = await fixture(context);
  const initial = await (await app.request('/api/settings', undefined, 'GET')).json();
  assert.equal(initial.configured, false);
  const write = await app.request('/api/settings', saved, 'PUT');
  assert.equal(write.status, 200);
  assert.deepEqual(await write.json(), { baseUrl: saved.baseUrl, model: saved.model, configured: true });
  const changed = await app.request('/api/settings', { ...saved, model: 'another-model', apiKey: '' }, 'PUT');
  assert.equal(changed.status, 200);
  await app.restart();
  const restored = await (await app.request('/api/settings', undefined, 'GET')).json();
  assert.deepEqual(restored, { baseUrl: saved.baseUrl, model: 'another-model', configured: true });
  const onDisk = JSON.parse(await fs.readFile(path.join(app.directory, 'settings.json'), 'utf8'));
  assert.equal(onDisk.apiKey, saved.apiKey);
  assert.ok(!(await fs.readdir(app.directory)).some(name => name.endsWith('.tmp')));
});

test('the development server never serves settings through static or raw file URLs', async context => {
  const { createServer } = await import('vite');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'context-words-private-'));
  const dataDirectory = path.join(directory, 'private-config');
  const server = await createServer({
    configFile: false,
    root: directory,
    plugins: [contextWordsBackend({ dataDirectory })],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  context.after(async () => { await server.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await server.listen();
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const write = await fetch(baseUrl + '/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saved),
  });
  assert.equal(write.status, 200);
  for (const route of [
    '/private-config/settings.json',
    '/private-config/settings.json?raw',
    `/@fs/${dataDirectory.replace(/\\/g, '/')}/settings.json`,
    `/@fs/${dataDirectory.replace(/\\/g, '/')}/settings.json?raw`,
  ]) {
    const response = await fetch(baseUrl + route);
    assert.equal(response.status, 403, route);
    assert.ok(!(await response.text()).includes(saved.apiKey));
  }
});

test('the production preview serves the app and restores settings after a restart', async context => {
  const { preview } = await import('vite');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'context-words-preview-'));
  const dataDirectory = path.join(directory, 'private-config');
  await fs.mkdir(path.join(directory, 'dist'));
  await fs.writeFile(path.join(directory, 'dist', 'index.html'), '<main>Context Words</main>');
  let server;
  async function start() {
    server = await preview({
      configFile: false,
      root: directory,
      plugins: [contextWordsBackend({ dataDirectory, fetchImpl: async () => completion() })],
      preview: { host: '127.0.0.1', port: 0 },
      logLevel: 'silent',
    });
    return `http://127.0.0.1:${server.httpServer.address().port}`;
  }
  async function stop() {
    const finished = new Promise(resolve => server.httpServer.close(resolve));
    server.httpServer.closeAllConnections();
    await finished;
  }
  context.after(async () => { await stop(); await fs.rm(directory, { recursive: true, force: true }); });
  let baseUrl = await start();
  assert.ok((await (await fetch(baseUrl + '/')).text()).includes('Context Words'));
  const write = await fetch(baseUrl + '/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saved),
  });
  assert.equal(write.status, 200);
  await stop();
  baseUrl = await start();
  const restored = await (await fetch(baseUrl + '/api/settings')).json();
  assert.deepEqual(restored, { baseUrl: saved.baseUrl, model: saved.model, configured: true });
  const generated = await fetch(baseUrl + '/api/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }),
  });
  assert.equal(generated.status, 200);
  const staticResponse = await fetch(baseUrl + '/private-config/settings.json');
  assert.ok(!(await staticResponse.text()).includes(saved.apiKey));
});

test('model requests use saved settings instead of browser credentials and connection tests do not persist drafts', async context => {
  const calls = [];
  const app = await fixture(context, { fetchImpl: async (endpoint, init) => { calls.push({ endpoint, init }); return completion(); } });
  await app.request('/api/settings', saved, 'PUT');
  const generated = await app.request('/api/chat/completions', { messages, model: 'browser-model', apiKey: 'browser-key', baseUrl: 'https://other.test' });
  assert.equal(generated.status, 200);
  assert.equal(calls[0].endpoint, saved.baseUrl + '/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + saved.apiKey);
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: saved.model, messages });
  assert.equal(calls[0].init.redirect, 'error');
  const tested = await app.request('/api/settings/test', { settings: { ...saved, model: 'draft-model', apiKey: '' } });
  assert.equal(tested.status, 200);
  assert.equal(JSON.parse(calls[1].init.body).model, 'draft-model');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ' + saved.apiKey);
  assert.equal((await (await app.request('/api/settings', undefined, 'GET')).json()).model, saved.model);
});

test('enables DeepSeek reasoning by default without sending provider-specific options to other models', async context => {
  const calls = [];
  const app = await fixture(context, { fetchImpl: async (endpoint, init) => {
    calls.push({ endpoint, body: JSON.parse(init.body) });
    return completion();
  } });
  await app.request('/api/settings', { ...saved, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, 'PUT');
  assert.equal((await app.request('/api/chat/completions', { messages })).status, 200);
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled' });
  await app.request('/api/settings', { ...saved, model: 'generic-model' }, 'PUT');
  assert.equal((await app.request('/api/chat/completions', { messages })).status, 200);
  assert.equal('thinking' in calls[1].body, false);
  const test = await app.request('/api/settings/test', { settings: { ...saved, model: 'deepseek-flash', apiKey: '' } });
  assert.equal(test.status, 200);
  assert.deepEqual(calls[2].body.thinking, { type: 'enabled' });
});

test('reports an actionable error when a DeepSeek endpoint rejects enabled thinking', async context => {
  const app = await fixture(context, { fetchImpl: async () => new Response(
    JSON.stringify({ error: { message: 'unsupported parameter: thinking' } }), { status: 400 }),
  });
  await app.request('/api/settings', { ...saved, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, 'PUT');
  const response = await app.request('/api/chat/completions', { messages });
  assert.equal(response.status, 400);
  const error = await response.json();
  assert.equal(error.error.kind, 'config');
  assert.match(error.error.message, /不支持开启思考/);
});

test('rejects foreign origins, cross-site browser requests, hostile hosts and non-JSON writes', async context => {
  let calls = 0;
  const app = await fixture(context, { fetchImpl: async () => { calls += 1; return completion(); } });
  await app.request('/api/settings', saved, 'PUT');
  for (const headers of [
    { Origin: 'https://evil.test' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    const response = await app.request('/api/settings/test', { settings: saved }, 'POST', headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  const hostileHost = await new Promise((resolve, reject) => {
    const request = http.request(app.baseUrl + '/api/settings/test', {
      method: 'POST', headers: { Host: 'evil.test', 'Content-Type': 'application/json' },
    }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end(JSON.stringify({ settings: saved }));
  });
  assert.equal(hostileHost, 403);
  const form = await app.request('/api/settings/test', { settings: saved }, 'POST', { 'Content-Type': 'text/plain' });
  assert.equal(form.status, 415);
  assert.equal(calls, 0);
});

test('requires an explicit new key when changing provider address and never reuses the saved key for another service', async context => {
  let calls = 0;
  const app = await fixture(context, { fetchImpl: async () => { calls += 1; return completion(); } });
  await app.request('/api/settings', saved, 'PUT');
  const changed = { ...saved, baseUrl: 'https://other.test/v1', apiKey: '' };
  assert.equal((await app.request('/api/settings', changed, 'PUT')).status, 400);
  assert.equal((await app.request('/api/settings/test', { settings: changed })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await (await app.request('/api/settings', undefined, 'GET')).json()).baseUrl, saved.baseUrl);
});

test('validates settings, missing configuration and chat payloads before contacting a provider', async context => {
  const app = await fixture(context, { fetchImpl: async () => { throw new Error('should not call'); } });
  const missing = await app.request('/api/chat/completions', { messages });
  assert.equal((await missing.json()).error.kind, 'config');
  for (const baseUrl of ['file:///etc/passwd', 'https://name:password@provider.test', 'https://provider.test/?key=secret']) {
    assert.equal((await app.request('/api/settings', { ...saved, baseUrl }, 'PUT')).status, 400);
  }
  await app.request('/api/settings', saved, 'PUT');
  const invalid = await app.request('/api/chat/completions', { messages: [{ role: 'invalid', content: 'text' }] });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.kind, 'format');
});

test('preserves provider status but redacts the stored key from provider error text', async context => {
  const app = await fixture(context, { fetchImpl: async () =>
    new Response(JSON.stringify({ error: { message: 'Rejected credential ' + saved.apiKey } }), { status: 401 }) });
  await app.request('/api/settings', saved, 'PUT');
  const response = await app.request('/api/chat/completions', { messages });
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.ok(!text.includes(saved.apiKey));
  assert.ok(text.includes('[已隐藏]'));
});

test('returns explicit network failures and aborts requests that exceed the backend timeout', async context => {
  let aborted = false;
  const app = await fixture(context, {
    requestTimeout: 20,
    fetchImpl: (_endpoint, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }),
  });
  await app.request('/api/settings', saved, 'PUT');
  const response = await app.request('/api/chat/completions', { messages });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.kind, 'timeout');
  assert.equal(aborted, true);
  const offline = await fixture(context, { fetchImpl: async () => { throw new Error('network'); } });
  await offline.request('/api/settings', saved, 'PUT');
  assert.equal((await (await offline.request('/api/chat/completions', { messages })).json()).error.kind, 'network');
});

test('client cancellation aborts the provider request without continuing generation', async context => {
  let started;
  let finished;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const cancelledPromise = new Promise(resolve => { finished = resolve; });
  const app = await fixture(context, { fetchImpl: (_endpoint, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { finished(); reject(new Error('cancelled')); }, { once: true });
    started();
  }) });
  await app.request('/api/settings', saved, 'PUT');
  const controller = new AbortController();
  const request = fetch(app.baseUrl + '/api/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }), signal: controller.signal,
  });
  await startedPromise;
  const rejection = assert.rejects(request);
  controller.abort();
  await rejection;
  await cancelledPromise;
});

test('reports corrupted backend configuration instead of silently discarding it', async context => {
  const app = await fixture(context);
  await fs.writeFile(path.join(app.directory, 'settings.json'), '{invalid');
  const response = await app.request('/api/settings', undefined, 'GET');
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.kind, 'storage');
});

function library(id = 'original') {
  return {
    version: 1, id, name: '词库 ' + id, sourceText: 'bank\tn. 银行',
    senses: [{ id: 'sense-bank', word: 'bank', partOfSpeech: 'n.', meaning: '银行', sourceLine: 1, sourceText: 'bank\tn. 银行', origin: 'import' }],
    readingOptions: { targetCount: 20, expectedWordCount: 400 }, archivedSessions: [],
    updatedAt: '2026-10-10T00:00:00.000Z', screening: { unknownSenseIds: ['sense-bank'], updatedAt: '2026-10-10T00:00:00.000Z' },
    session: {
      id: 'session', phase: 'coverage', remainingSenseIds: [], coveredSenseIds: ['sense-bank'], accumulatedUnknownIds: [],
      reviewSenseIds: [], reviewPendingIds: [], reviewUnknownIds: [], currentUnknownIds: ['sense-bank'], reviewRound: 0,
      currentArticleId: 'article', preparedArticle: { id: 'prepared', body: 'A second bank.' },
      articles: [{ id: 'article', body: 'I visited the bank.', targetSenseIds: ['sense-bank'] }],
    },
  };
}

const collection = libraries => ({ version: 1, libraries, activeLibraryId: libraries[0]?.id ?? null });

test('libraries, screening, article history, queues and drafts persist across restarts and ports with file backups', async context => {
  const app = await fixture(context);
  const initial = await (await app.request('/api/libraries', undefined, 'GET')).json();
  assert.equal(initial.revision, 0);
  const original = collection([library()]);
  assert.equal((await app.request('/api/libraries', { collection: original, revision: 0 }, 'PUT')).status, 200);
  const draft = { version: 1, name: 'draft', sourceText: 'bank\tn. 银行', encoding: 'auto', preview: { senses: library().senses, issues: [], duplicateCount: 0 }, checkpoint: null, reviewSenseIds: [], refined: false };
  assert.equal((await app.request('/api/import-draft', { draft }, 'PUT')).status, 200);
  const changed = structuredClone(original);
  changed.libraries[0].session.currentUnknownIds = [];
  assert.equal((await app.request('/api/libraries', { collection: changed, revision: 1 }, 'PUT')).status, 200);
  await app.restart();
  assert.deepEqual((await (await app.request('/api/libraries', undefined, 'GET')).json()).collection, changed);
  assert.deepEqual((await (await app.request('/api/import-draft', undefined, 'GET')).json()).draft, draft);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.directory, 'libraries.json.bak'), 'utf8')).collection, original);
  await app.request('/api/import-draft', { draft: null }, 'PUT');
  await app.restart();
  assert.equal((await (await app.request('/api/import-draft', undefined, 'GET')).json()).draft, null);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.directory, 'import-draft.json.bak'), 'utf8')), draft);
});

test('stale and concurrent library writes never overwrite newer data, including separate handler instances', async context => {
  const app = await fixture(context);
  const writes = await Promise.all(['first', 'second'].map(id => app.request('/api/libraries', { collection: collection([library(id)]), revision: 0 }, 'PUT')));
  assert.deepEqual(writes.map(response => response.status).sort(), [200, 409]);
  const latest = await (await app.request('/api/libraries', undefined, 'GET')).json();
  assert.equal(latest.revision, 1);
  const other = createApiHandler({ dataDirectory: app.directory });
  const otherServer = http.createServer((request, response) => { void other(request, response); });
  await new Promise(resolve => otherServer.listen(0, '127.0.0.1', resolve));
  context.after(async () => { const closed = new Promise(resolve => otherServer.close(resolve)); otherServer.closeAllConnections(); await closed; });
  const responses = await Promise.all([
    app.request('/api/libraries', { collection: latest.collection, revision: 1 }, 'PUT'),
    fetch(`http://127.0.0.1:${otherServer.address().port}/api/libraries`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collection: collection([library('other')]), revision: 1 }) }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
});

test('migration merges origins once, preserves conflicting progress as a copy and retains an immutable source backup', async context => {
  const app = await fixture(context);
  const original = collection([library()]);
  const draft = { version: 1, name: 'old import', sourceText: '', encoding: 'auto', preview: { senses: [], issues: [], duplicateCount: 0 }, checkpoint: null, reviewSenseIds: [], refined: false };
  const payload = { sourceId: 'browser-5174', collection: original, draft };
  assert.equal((await app.request('/api/libraries/migrate', payload)).status, 200);
  const first = await (await app.request('/api/libraries', undefined, 'GET')).json();
  const changed = structuredClone(original);
  changed.libraries[0].session.currentUnknownIds = [];
  await app.request('/api/libraries', { collection: changed, revision: first.revision }, 'PUT');
  await app.request('/api/libraries/migrate', payload);
  assert.deepEqual((await (await app.request('/api/libraries', undefined, 'GET')).json()).collection, changed);
  const branch = { ...library('branch'), branch: { parentLibraryId: 'original', parentLibraryName: '词库 original', createdAt: '2026-10-10T00:00:00.000Z' } };
  await app.request('/api/libraries/migrate', { ...payload, sourceId: 'browser-5173', collection: collection([library(), branch]) });
  const merged = await (await app.request('/api/libraries', undefined, 'GET')).json();
  assert.equal(merged.collection.libraries.length, 3);
  assert.deepEqual(merged.collection.libraries[0], changed.libraries[0]);
  assert.match(merged.collection.libraries[1].name, /迁移副本/);
  assert.equal(merged.collection.libraries[2].branch.parentLibraryId, merged.collection.libraries[1].id);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.directory, 'migrations', 'browser-5174.json'), 'utf8')), payload);
  assert.deepEqual((await (await app.request('/api/import-draft', undefined, 'GET')).json()).draft, draft);
  await app.request('/api/libraries', { collection: collection([]), revision: merged.revision }, 'PUT');
  await app.restart();
  await app.request('/api/libraries/migrate', payload);
  assert.deepEqual((await (await app.request('/api/libraries', undefined, 'GET')).json()).collection, collection([]));
});

test('malformed data and unreadable or unwritable storage do not replace existing libraries', async context => {
  const app = await fixture(context);
  await app.request('/api/libraries', { collection: collection([library()]), revision: 0 }, 'PUT');
  const file = path.join(app.directory, 'libraries.json');
  const before = await fs.readFile(file, 'utf8');
  assert.equal((await app.request('/api/libraries', { collection: { version: 1, libraries: [{}], activeLibraryId: null }, revision: 1 }, 'PUT')).status, 400);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.mkdir(path.join(app.directory, 'libraries.json.bak'));
  assert.equal((await app.request('/api/libraries', { collection: collection([]), revision: 1 }, 'PUT')).status, 500);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.writeFile(file, '{invalid');
  assert.equal((await app.request('/api/libraries', undefined, 'GET')).status, 500);
  assert.equal((await app.request('/api/libraries', { collection: collection([]), revision: 1 }, 'PUT')).status, 500);
  assert.equal(await fs.readFile(file, 'utf8'), '{invalid');
});

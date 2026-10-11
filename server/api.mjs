import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createLibraryStore, StorageError } from './libraryStore.mjs';

const defaultSettings = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: '' };
const defaultDirectory = fileURLToPath(new URL('../data/', import.meta.url));

class BackendError extends Error {
  constructor(status, kind, message) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

function normalizedBaseUrl(value) {
  if (typeof value !== 'string') throw new BackendError(400, 'config', '请填写有效的 Base URL。');
  const baseUrl = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new BackendError(400, 'config', 'Base URL 必须是完整 HTTP 或 HTTPS 地址，且不能包含账号、查询参数或片段。');
  }
  return baseUrl;
}

function publicSettings(settings) {
  return { baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.apiKey) };
}

function providerPayload(settings, messages) {
  const hostname = new URL(settings.baseUrl).hostname.toLowerCase();
  const deepseek = /^(?:[^/]+\/)?deepseek(?:[-/]|$)/i.test(settings.model)
    || hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com');
  return { model: settings.model, messages, ...(deepseek ? { thinking: { type: 'enabled' } } : {}) };
}

function sameOrigin(request) {
  try {
    const local = new URL(`http://${request.headers.host}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)) return false;
    const site = request.headers['sec-fetch-site'];
    if (site && !['same-origin', 'none'].includes(site)) return false;
    const origin = request.headers.origin;
    return !origin || origin === `${request.socket.encrypted ? 'https' : 'http'}://${local.host}`;
  } catch {
    return false;
  }
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(value));
}

async function readBody(request, limit = 2_000_000) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new BackendError(415, 'format', '请求必须使用 application/json。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new BackendError(413, 'format', '请求内容过大。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new BackendError(400, 'format', '请求不是有效 JSON 对象。');
  }
}

function resolveSettings(incoming, current) {
  const baseUrl = normalizedBaseUrl(incoming.baseUrl);
  const model = typeof incoming.model === 'string' ? incoming.model.trim() : '';
  const suppliedKey = typeof incoming.apiKey === 'string' ? incoming.apiKey.trim() : '';
  if (!suppliedKey && baseUrl !== current.baseUrl) {
    throw new BackendError(400, 'config', '更改服务地址时请重新填写 API Key，避免把已有 Key 发送给其他服务。');
  }
  const apiKey = suppliedKey || current.apiKey;
  if (!model || !apiKey) throw new BackendError(400, 'config', '请填写模型名和 API Key。');
  return { baseUrl, model, apiKey };
}

export function createApiHandler(options = {}) {
  const directory = path.resolve(options.dataDirectory || process.env.CONTEXT_WORDS_DATA_DIR || defaultDirectory);
  const settingsPath = path.join(directory, 'settings.json');
  const libraryStore = createLibraryStore(directory);
  const providerFetch = options.fetchImpl || globalThis.fetch;
  const requestTimeout = options.requestTimeout ?? 150_000;
  let saveQueue = Promise.resolve();

  async function loadSettings() {
    await saveQueue.catch(() => undefined);
    let content;
    try {
      content = await fs.readFile(settingsPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { ...defaultSettings };
      throw new BackendError(500, 'storage', '无法读取后端配置文件，请检查 data 目录权限。');
    }
    try {
      const value = JSON.parse(content);
      if (typeof value.model !== 'string' || typeof value.apiKey !== 'string') throw new Error();
      return { baseUrl: normalizedBaseUrl(value.baseUrl), model: value.model.trim(), apiKey: value.apiKey };
    } catch {
      throw new BackendError(500, 'storage', '后端配置文件格式错误，请检查 data/settings.json。');
    }
  }

  async function saveSettings(settings) {
    const pending = saveQueue.catch(() => undefined).then(async () => {
      const temporary = path.join(directory, `settings-${randomUUID()}.tmp`);
      try {
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, settingsPath);
      } catch {
        await fs.unlink(temporary).catch(() => undefined);
        throw new BackendError(500, 'storage', '无法保存后端配置，请检查 data 目录权限。');
      }
    });
    saveQueue = pending;
    await pending;
  }

  async function callProvider(request, response, settings, messages) {
    if (!Array.isArray(messages) || !messages.length || messages.some(message =>
      !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
      throw new BackendError(400, 'format', '模型请求需要有效的 messages。');
    }
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', cancel);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeout);
    try {
      const endpoint = settings.baseUrl.endsWith('/chat/completions') ? settings.baseUrl : `${settings.baseUrl}/chat/completions`;
      const upstream = await providerFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify(providerPayload(settings, messages)),
        signal: controller.signal,
        redirect: 'error',
      });
      const content = await upstream.text();
      if (!upstream.ok) {
        let detail = '';
        try {
          const value = JSON.parse(content);
          if (typeof value.error?.message === 'string') detail = value.error.message.split(settings.apiKey).join('[已隐藏]').slice(0, 300);
        } catch {}
        if ([400, 422].includes(upstream.status) && /thinking/i.test(detail)
          && /unsupported|not supported|unknown|unrecognized|invalid|不支持|未知|无效/i.test(detail)) {
          throw new BackendError(400, 'config', `模型服务不支持开启思考的 thinking 参数，请使用支持该参数的 DeepSeek 接口或调整模型。${detail}`);
        }
        json(response, upstream.status, { error: { message: detail || `模型服务返回 HTTP ${upstream.status}。` } });
      } else {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(content);
      }
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof BackendError) throw error;
      if (timedOut) throw new BackendError(504, 'timeout', `后端等待模型响应超过 ${requestTimeout / 1000} 秒，请重试。`);
      throw new BackendError(502, 'network', '后端无法连接模型服务，请检查服务地址和本机网络。');
    } finally {
      clearTimeout(timer);
      response.off('close', cancel);
    }
  }

  return async function handle(request, response) {
    const route = new URL(request.url || '/', 'http://localhost').pathname;
    if (!route.startsWith('/api/')) return false;
    if (!sameOrigin(request)) {
      json(response, 403, { error: { kind: 'auth', message: '后端只允许本机应用的同源请求。' } });
      return true;
    }
    try {
      if (request.method === 'GET' && route === '/api/libraries') {
        json(response, 200, await libraryStore.loadLibraries());
      } else if (request.method === 'PUT' && route === '/api/libraries') {
        const payload = await readBody(request, 100_000_000);
        json(response, 200, await libraryStore.saveLibraries(payload.collection, payload.revision));
      } else if (request.method === 'POST' && route === '/api/libraries/migrate') {
        json(response, 200, await libraryStore.migrate(await readBody(request, 100_000_000)));
      } else if (request.method === 'GET' && route === '/api/import-draft') {
        json(response, 200, { draft: await libraryStore.loadDraft() });
      } else if (request.method === 'PUT' && route === '/api/import-draft') {
        const payload = await readBody(request, 100_000_000);
        json(response, 200, { draft: await libraryStore.saveDraft(payload.draft) });
      } else if (request.method === 'GET' && route === '/api/settings') {
        json(response, 200, publicSettings(await loadSettings()));
      } else if (request.method === 'PUT' && route === '/api/settings') {
        const incoming = await readBody(request);
        const settings = resolveSettings(incoming, await loadSettings());
        await saveSettings(settings);
        json(response, 200, publicSettings(settings));
      } else if (request.method === 'POST' && route === '/api/settings/test') {
        const incoming = await readBody(request);
        const settings = resolveSettings(incoming.settings || {}, await loadSettings());
        await callProvider(request, response, settings, [
          { role: 'system', content: 'Return only valid JSON without commentary.' },
          { role: 'user', content: 'Connection test. Return exactly {"ok":true}.' },
        ]);
      } else if (request.method === 'POST' && route === '/api/chat/completions') {
        const payload = await readBody(request);
        const settings = await loadSettings();
        if (!settings.apiKey || !settings.model) throw new BackendError(400, 'config', '后端尚未配置模型，请先保存 API 设置。');
        await callProvider(request, response, settings, payload.messages);
      } else {
        json(response, 404, { error: { kind: 'config', message: '未知 API 路径。' } });
      }
    } catch (error) {
      const expected = error instanceof BackendError || error instanceof StorageError;
      json(response, expected ? error.status : 500, {
        error: { kind: expected ? error.kind : 'server', message: expected ? error.message : '后端请求失败。' },
      });
    }
    return true;
  };
}

export default function contextWordsBackend(options = {}) {
  const directory = path.resolve(options.dataDirectory || process.env.CONTEXT_WORDS_DATA_DIR || defaultDirectory);
  const handle = createApiHandler({ ...options, dataDirectory: directory });
  const install = server => {
    server.middlewares.use((request, response, next) => {
      void handle(request, response).then(handled => { if (!handled) next(); }).catch(next);
    });
  };
  return {
    name: 'context-words-backend',
    config: () => ({
      server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', `${directory.replace(/\\/g, '/')}/**`] } },
    }),
    configureServer: install,
    configurePreviewServer: install,
  };
}

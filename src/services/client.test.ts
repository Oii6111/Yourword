import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSettings } from '../domain/types';
import { chatJson, testConnection } from './client';
import { clearRequestLogs, getRequestLogs } from './requestLogs';

const settings: ApiSettings = { baseUrl: 'https://example.test/v1/', apiKey: 'test-key', model: 'test-model' };

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function abortingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

beforeEach(() => {
  clearRequestLogs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chatJson', () => {
  it('uses the backend proxy without sending credentials or provider settings during generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('```json\n{"answer":42}\n```'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(chatJson(settings, [{ role: 'user', content: 'Question' }])).resolves.toEqual({ answer: 42 });
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('/api/chat/completions');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ messages: [{ role: 'user', content: 'Question' }] });
    expect(init.body).not.toContain('test-key');
  });

  it('tests a draft configuration through the backend and can reuse a saved key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    await testConnection({ ...settings, baseUrl: 'http://localhost:8000/v1/chat/completions', apiKey: '' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/settings/test');
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).settings).toEqual({ baseUrl: 'http://localhost:8000/v1/chat/completions', model: 'test-model', apiKey: '' });
  });

  it.each([
    [completion('not JSON'), 'format'],
    [new Response('not JSON'), 'format'],
    [new Response('{"choices":[]}'), 'format'],
    [new Response('{"error":{"message":"invalid key"}}', { status: 401 }), 'auth'],
    [new Response('{"error":{"message":"model not found"}}', { status: 404 }), 'model'],
    [new Response('{"error":{"message":"unknown model"}}', { status: 400 }), 'model'],
    [new Response('Unavailable', { status: 503 }), 'server'],
  ])('classifies invalid and unsuccessful response %#', async (response, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(chatJson(settings, [])).rejects.toMatchObject({ kind });
    expect(getRequestLogs()).toHaveLength(1);
    expect(getRequestLogs()[0]).toMatchObject({ state: 'error', httpStatus: response.status, errorKind: kind });
  });

  it('reports an unavailable local backend when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(chatJson(settings, [])).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('本机后端') });
  });

  it('preserves backend configuration, network and timeout error classifications', async () => {
    for (const kind of ['config', 'network', 'timeout']) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { kind, message: '后端错误' } }), { status: 502 })));
      await expect(chatJson(settings, [])).rejects.toMatchObject({ kind, message: '后端错误' });
    }
  });

  it('rejects invalid settings before making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(chatJson({ ...settings, baseUrl: 'not-a-url' }, [])).rejects.toMatchObject({ kind: 'config' });
    await expect(chatJson({ ...settings, model: '' }, [])).rejects.toMatchObject({ kind: 'config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels an in-flight request without classifying it as a network failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(abortingFetch));
    const controller = new AbortController();
    const request = chatJson(settings, [], controller.signal);
    const assertion = expect(request).rejects.toMatchObject({ kind: 'cancelled' });
    controller.abort();
    await assertion;
    expect(getRequestLogs()[0]).toMatchObject({ state: 'error', errorKind: 'cancelled' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fetch when already cancelled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(chatJson(settings, [], controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps waiting past 90 seconds and records the stage when the 150-second timeout fires', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(abortingFetch));
    const request = chatJson(settings, [], undefined, { operation: '文章创作', targetCount: 50, targetWordCount: 1000 });
    expect(getRequestLogs()[0]).toMatchObject({ state: 'pending', waitingFor: 'headers', operation: '文章创作' });
    const assertion = expect(request).rejects.toMatchObject({ kind: 'timeout', message: expect.stringContaining('文章创作') });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(getRequestLogs()[0]).toMatchObject({ state: 'pending', waitingFor: 'headers' });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(getRequestLogs()[0]).toMatchObject({
      state: 'error', waitingFor: 'headers', errorKind: 'timeout', durationMs: 150_000,
      operation: '文章创作', targetCount: 50, targetWordCount: 1000,
    });
    expect(getRequestLogs()[0].httpStatus).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains HTTP status when headers arrive but the response body times out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const response = new Response('', { status: 200 });
      vi.spyOn(response, 'text').mockImplementation(() => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));
      return Promise.resolve(response);
    }));
    const assertion = expect(chatJson(settings, [], undefined, { operation: '文章创作' })).rejects.toMatchObject({
      kind: 'timeout', message: expect.stringContaining('HTTP 200'),
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(getRequestLogs()[0]).toMatchObject({ state: 'pending', waitingFor: 'body', httpStatus: 200 });
    await vi.advanceTimersByTimeAsync(149_999);
    await assertion;
    expect(getRequestLogs()[0]).toMatchObject({ state: 'error', waitingFor: 'body', errorKind: 'timeout', httpStatus: 200, durationMs: 150_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records successful request metadata without credentials, URL paths, prompts, or response content', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem, removeItem: vi.fn() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion('{"private-response":"response-secret"}')));
    await chatJson({ ...settings, baseUrl: 'https://example.test/private-api/chat/completions?token=url-secret', apiKey: 'credential-secret' }, [
      { role: 'user', content: 'prompt-secret' },
    ], undefined, { operation: '文章创作', targetCount: 2, targetWordCount: 100 });
    expect(getRequestLogs()[0]).toMatchObject({
      operation: '文章创作', model: 'test-model', endpointOrigin: 'https://example.test', state: 'success',
      waitingFor: 'complete', httpStatus: 200, targetCount: 2, targetWordCount: 100,
    });
    expect(getRequestLogs()[0].durationMs).toBeGreaterThanOrEqual(0);
    const storedLogs = setItem.mock.calls.filter(call => call[0] === 'context-words-request-logs').at(-1)?.[1];
    expect(storedLogs).toBeDefined();
    for (const sensitive of ['credential-secret', 'private-api', 'url-secret', 'prompt-secret', 'response-secret']) {
      expect(JSON.stringify(getRequestLogs())).not.toContain(sensitive);
      expect(storedLogs).not.toContain(sensitive);
    }
  });

  it('keeps service error details out of stored request logs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"provider-detail-secret"}}', { status: 503 })));
    await expect(chatJson(settings, [])).rejects.toMatchObject({ kind: 'server' });
    expect(getRequestLogs()[0]).toMatchObject({ httpStatus: 503, errorKind: 'server', state: 'error' });
    expect(JSON.stringify(getRequestLogs())).not.toContain('provider-detail-secret');
  });

  it('still completes requests when browser storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError'); }),
      setItem: vi.fn(() => { throw new DOMException('Full', 'QuotaExceededError'); }),
      removeItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError'); }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion('{"ok":true}')));
    await expect(chatJson(settings, [])).resolves.toEqual({ ok: true });
    expect(getRequestLogs()[0]).toMatchObject({ state: 'success' });
  });

  it('requires connection tests to follow the requested JSON contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion('{"ok":false}')));
    await expect(testConnection(settings)).rejects.toMatchObject({ kind: 'format' });
  });
});

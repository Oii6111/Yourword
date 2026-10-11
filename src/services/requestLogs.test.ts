import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = { baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'test-model' };

beforeEach(() => {
  vi.resetModules();
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => stored.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
    removeItem: vi.fn((key: string) => stored.delete(key)),
  });
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })))));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('request logs', () => {
  it('restores completed diagnostics after module reload and clears persisted history', async () => {
    const { chatJson } = await import('./client');
    const logs = await import('./requestLogs');
    await chatJson(settings, [], undefined, { operation: '连接测试' });
    const completed = logs.getRequestLogs();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ operation: '连接测试', state: 'success' });
    vi.resetModules();
    const restored = await import('./requestLogs');
    expect(restored.getRequestLogs()).toEqual(completed);
    restored.clearRequestLogs();
    expect(restored.getRequestLogs()).toEqual([]);
    vi.resetModules();
    expect((await import('./requestLogs')).getRequestLogs()).toEqual([]);
  });

  it('keeps only the newest 30 requests and notifies subscribed views', async () => {
    const { chatJson } = await import('./client');
    const logs = await import('./requestLogs');
    const subscriber = vi.fn();
    const unsubscribe = logs.subscribeRequestLogs(subscriber);
    for (let targetCount = 0; targetCount < 31; targetCount += 1) {
      await chatJson(settings, [], undefined, { operation: '文章创作', targetCount });
    }
    expect(logs.getRequestLogs()).toHaveLength(30);
    expect(logs.getRequestLogs().map(log => log.targetCount)).not.toContain(0);
    expect(logs.getRequestLogs().map(log => log.targetCount)).toContain(30);
    expect(subscriber).toHaveBeenCalled();
    unsubscribe();
    subscriber.mockClear();
    logs.clearRequestLogs();
    expect(subscriber).not.toHaveBeenCalled();
    vi.resetModules();
    expect((await import('./requestLogs')).getRequestLogs()).toEqual([]);
  });

  it('does not block requests when UUID generation is unavailable in an HTTP browser', async () => {
    vi.stubGlobal('crypto', undefined);
    const { chatJson } = await import('./client');
    await expect(chatJson(settings, [])).resolves.toEqual({ ok: true });
    const logs = await import('./requestLogs');
    expect(logs.getRequestLogs()[0]).toMatchObject({ state: 'success', id: expect.any(String) });
  });

  it('drops invalid optional field types when restoring otherwise valid logs', async () => {
    const { chatJson } = await import('./client');
    await chatJson(settings, []);
    const saved = JSON.parse(localStorage.getItem('context-words-request-logs')!);
    saved[0].httpStatus = 999;
    saved[0].errorKind = { invalid: true };
    saved[0].targetCount = { invalid: true };
    saved[0].targetWordCount = -100;
    localStorage.setItem('context-words-request-logs', JSON.stringify(saved));
    vi.resetModules();
    const logs = await import('./requestLogs');
    expect(logs.getRequestLogs()).toHaveLength(1);
    expect(logs.getRequestLogs()[0]).toMatchObject({
      state: 'success', httpStatus: undefined, errorKind: undefined,
      targetCount: undefined, targetWordCount: undefined,
    });
  });

  it('ignores malformed persisted history', async () => {
    localStorage.setItem('context-words-request-logs', '{broken-json');
    expect((await import('./requestLogs')).getRequestLogs()).toEqual([]);
  });

  it('restores an unfinished request as interrupted instead of leaving it in progress', async () => {
    const logs = await import('./requestLogs');
    const id = logs.startRequestLog({ operation: '文章创作', model: 'test-model', endpointOrigin: 'https://example.test', targetCount: 50, targetWordCount: 1000 });
    expect(logs.getRequestLogs()[0]).toMatchObject({ id, state: 'pending', waitingFor: 'headers' });
    vi.resetModules();
    const restored = await import('./requestLogs');
    expect(restored.getRequestLogs()[0]).toMatchObject({
      id, state: 'error', errorKind: 'interrupted', waitingFor: 'headers', targetCount: 50, targetWordCount: 1000,
    });
  });
});

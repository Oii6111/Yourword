import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearImportDraft, exportBrowserBackup, importBrowserBackup, loadImportDraft, loadLibraries, loadSettings, saveImportDraft, saveLibraries, saveSettings } from './storage';
import { createSession } from './session';
import { parseVocabulary } from './import';
import { createBranchLibrary } from './libraries';
import type { Article, ImportDraft, Workspace } from './types';

function workspace(name: string): Workspace {
  return { version: 1, name, sourceText: '', senses: [], session: createSession([]), updatedAt: '2026-10-09T00:00:00.000Z' };
}

async function seedBrowser(value: unknown, key = 'current'): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('context-words', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(value, key);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onabort = transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  });
  let stored = { collection: { version: 1, libraries: [], activeLibraryId: null } as import('./types').LibraryCollection, revision: 0, migratedSourceIds: [] as string[] };
  let storedDraft: ImportDraft | null = null;
  vi.stubGlobal('fetch', vi.fn(async (route: string, init?: RequestInit) => {
    const payload = init?.body ? JSON.parse(init.body as string) : null;
    if (route === '/api/libraries/migrate') {
      if (!stored.migratedSourceIds.includes(payload.sourceId)) {
        stored = { collection: payload.collection, revision: stored.revision + 1, migratedSourceIds: [...stored.migratedSourceIds, payload.sourceId] };
        storedDraft ??= payload.draft;
      }
      return new Response(JSON.stringify(stored));
    }
    if (route === '/api/libraries') {
      if (payload) {
        if (payload.revision !== stored.revision) return new Response('{"error":{"message":"conflict"}}', { status: 409 });
        stored = { ...stored, collection: payload.collection, revision: stored.revision + 1 };
      }
      return new Response(JSON.stringify(stored));
    }
    if (route === '/api/import-draft') {
      if (payload) storedDraft = payload.draft;
      return new Response(JSON.stringify({ draft: storedDraft }));
    }
    throw new Error('Unexpected route: ' + route);
  }));
  await loadLibraries();
});

afterEach(() => vi.unstubAllGlobals());

describe('library collection storage', () => {
  it('迁移旧词库并保存稳定编号与默认阅读设置', async () => {
    await seedBrowser(workspace('legacy'));
    const migrated = await loadLibraries();
    expect(migrated.libraries).toHaveLength(1);
    expect(migrated.libraries[0]).toMatchObject({ name: 'legacy', id: expect.any(String), readingOptions: { targetCount: 20, expectedWordCount: 400 }, archivedSessions: [] });
    expect(migrated.activeLibraryId).toBe(migrated.libraries[0].id);
    expect(await loadLibraries()).toEqual(migrated);
    expect(JSON.parse(await exportBrowserBackup()).collection.libraries[0].name).toBe('legacy');
  });

  it('将旧长度上限迁移为预期长度并保留阅读进度', async () => {
    const original = {
      ...workspace('旧设置'),
      readingOptions: { targetCount: 5, maxWordCount: 120 },
    };
    await seedBrowser(original);
    const migrated = await loadLibraries();
    expect(migrated.libraries[0].readingOptions).toEqual({ targetCount: 5, expectedWordCount: 120 });
    expect(migrated.libraries[0].session).toEqual(original.session);
    expect(await loadLibraries()).toEqual(migrated);
  });

  it('独立恢复各词库设置、当前会话、历史和预生成文章', async () => {
    const first = { ...workspace('first'), id: 'first', readingOptions: { targetCount: 5, expectedWordCount: 200 }, archivedSessions: [createSession([])] };
    const second = { ...workspace('second'), id: 'second', readingOptions: { targetCount: 12, expectedWordCount: 350 }, archivedSessions: [] };
    const prepared: Article = {
      id: 'prepared', title: 'Next', body: 'next', theme: 'test', targetSenseIds: ['next'],
      occurrences: [{ senseId: 'next', start: 0, end: 4, surface: 'next' }],
      wordCount: 1, targetWordCount: 100, createdAt: '2026-10-09T00:00:00.000Z',
    };
    first.session!.currentUnknownIds = ['first-only'];
    first.session!.preparedArticle = prepared;
    second.session!.reviewRound = 3;
    const collection = { version: 1 as const, libraries: [first, second], activeLibraryId: second.id };
    const pendingSave = saveLibraries(collection);
    first.name = 'changed after save';
    await pendingSave;
    const restored = await loadLibraries();
    expect(restored.activeLibraryId).toBe('second');
    expect(restored.libraries[0]).toMatchObject({ name: 'first', readingOptions: { targetCount: 5, expectedWordCount: 200 }, session: { currentUnknownIds: ['first-only'] } });
    expect(restored.libraries[0].archivedSessions).toHaveLength(1);
    expect(restored.libraries[0].session?.preparedArticle).toEqual(prepared);
    expect(restored.libraries[1]).toMatchObject({ name: 'second', readingOptions: { targetCount: 12, expectedWordCount: 350 }, session: { reviewRound: 3, currentUnknownIds: [] } });
  });

  it('刷新恢复生词筛选与分支来源，并在删除原词库后保留独立分支', async () => {
    const parent: Workspace = {
      ...workspace('基础词库'),
      id: 'parent',
      senses: parseVocabulary('bank\tn. 银行\nbank\tn. 河岸').senses,
    };
    const createdAt = '2026-10-09T12:34:56.000Z';
    parent.screening = { unknownSenseIds: [parent.senses[1].id], updatedAt: createdAt };
    const branch = createBranchLibrary(parent, parent.screening.unknownSenseIds, createdAt);
    const expectedScreening = structuredClone(parent.screening);
    const pendingSave = saveLibraries({ version: 1, libraries: [parent, branch], activeLibraryId: branch.id! });
    parent.screening.unknownSenseIds.push(parent.senses[0].id);
    await pendingSave;
    const restored = await loadLibraries();
    expect(restored.libraries[0].screening).toEqual(expectedScreening);
    expect(restored.libraries[1]).toMatchObject({
      branch: { parentLibraryId: 'parent', parentLibraryName: '基础词库', createdAt },
      senses: [{ id: parent.senses[0].id, meaning: '银行' }, { id: parent.senses[1].id, meaning: '河岸' }],
      session: null,
      archivedSessions: [],
    });
    const savedBranch = restored.libraries[1];
    await saveLibraries({ version: 1, libraries: [savedBranch], activeLibraryId: savedBranch.id! });
    expect(await loadLibraries()).toEqual({ version: 1, libraries: [savedBranch], activeLibraryId: savedBranch.id });
    expect(savedBranch.branch?.parentLibraryName).toBe('基础词库');
  });

  it('清理筛选记录中失效和重复的词义编号，同时保留同词不同义', async () => {
    const original: Workspace = {
      ...workspace('bank'),
      id: 'bank',
      senses: parseVocabulary('bank\tn. 银行\nbank\tn. 河岸').senses,
      screening: { unknownSenseIds: ['import-2-1', 'missing', 'import-1-1', 'import-2-1'], updatedAt: '2026-10-09T12:34:56.000Z' },
    };
    await saveLibraries({ version: 1, libraries: [original], activeLibraryId: original.id! });
    expect((await loadLibraries()).libraries[0].screening?.unknownSenseIds).toEqual(['import-2-1', 'import-1-1']);
    expect(original.screening?.unknownSenseIds).toEqual(['import-2-1', 'missing', 'import-1-1', 'import-2-1']);
    original.senses.splice(1, 1);
    await saveLibraries({ version: 1, libraries: [original], activeLibraryId: original.id! });
    expect((await loadLibraries()).libraries[0].screening?.unknownSenseIds).toEqual(['import-1-1']);
  });

  it('拒绝格式无效的筛选和分支来源记录，不覆盖已有词库', async () => {
    const original = { ...workspace('valid'), id: 'valid' };
    await saveLibraries({ version: 1, libraries: [original], activeLibraryId: original.id });
    for (const screening of [null, { unknownSenseIds: [1], updatedAt: '2026-10-09T12:34:56.000Z' }, { unknownSenseIds: [], updatedAt: 'invalid' }]) {
      const invalid = { ...original, screening } as unknown as Workspace;
      await expect(saveLibraries({ version: 1, libraries: [invalid], activeLibraryId: original.id })).rejects.toThrow('筛选记录格式无效');
    }
    for (const branch of [null, { parentLibraryId: '', parentLibraryName: 'parent', createdAt: '2026-10-09T12:34:56.000Z' }, { parentLibraryId: 'parent', parentLibraryName: 'parent', createdAt: 'invalid' }]) {
      const invalid = { ...original, branch } as unknown as Workspace;
      await expect(saveLibraries({ version: 1, libraries: [invalid], activeLibraryId: original.id })).rejects.toThrow('来源记录格式无效');
    }
    expect((await loadLibraries()).libraries[0].name).toBe('valid');
  });

  it('空集合及删除全部词库后不会重新导入旧 current 数据', async () => {
    await seedBrowser(workspace('old'));
    await loadLibraries();
    await saveLibraries({ version: 1, libraries: [], activeLibraryId: null });
    expect(await loadLibraries()).toEqual({ version: 1, libraries: [], activeLibraryId: null });
  });

  it('保存按提交顺序快照，并在存储失败后恢复', async () => {
    expect(await loadLibraries()).toEqual({ version: 1, libraries: [], activeLibraryId: null });
    vi.stubGlobal('indexedDB', undefined);
    const backend = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(saveLibraries({ version: 1, libraries: [], activeLibraryId: null })).rejects.toThrow('offline');
    vi.stubGlobal('fetch', backend);
    const first = { ...workspace('first'), id: 'first' };
    const second = { ...workspace('second'), id: 'second' };
    const firstSave = saveLibraries({ version: 1, libraries: [first], activeLibraryId: first.id });
    const secondSave = saveLibraries({ version: 1, libraries: [second], activeLibraryId: second.id });
    await Promise.all([firstSave, secondSave]);
    expect((await loadLibraries()).libraries.map((library) => library.name)).toEqual(['second']);
  });

  it('backend libraries remain available without IndexedDB and new progress is never written to the browser', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await loadLibraries();
    await saveLibraries({ version: 1, libraries: [{ ...workspace('backend only'), id: 'backend' }], activeLibraryId: 'backend' });
    expect((await loadLibraries()).libraries[0].name).toBe('backend only');
    vi.stubGlobal('indexedDB', new IDBFactory());
    await expect(exportBrowserBackup()).rejects.toThrow('没有旧词库');
  });

  it('retains the original browser collection and draft when migration fails, then retries safely', async () => {
    await seedBrowser({ version: 1, libraries: [{ ...workspace('original'), id: 'original' }], activeLibraryId: 'original' }, 'libraries');
    const backend = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (route: string, init?: RequestInit) => route.endsWith('/migrate')
      ? new Response('{"error":{"message":"disk full"}}', { status: 500 }) : backend(route, init)));
    await expect(loadLibraries()).rejects.toThrow('disk full');
    const backup = await exportBrowserBackup();
    expect(JSON.parse(backup).collection.libraries[0].name).toBe('original');
    await expect(saveLibraries({ version: 1, libraries: [], activeLibraryId: null })).rejects.toThrow('尚未成功读取');
    vi.stubGlobal('fetch', backend);
    expect((await loadLibraries()).libraries[0].name).toBe('original');
    await saveLibraries({ version: 1, libraries: [], activeLibraryId: null });
    expect((await loadLibraries()).libraries).toHaveLength(0);
    expect(JSON.parse(await exportBrowserBackup()).sourceId).toBe(JSON.parse(backup).sourceId);
  });

  it('imports exported browser backups without requiring the same browser origin', async () => {
    await seedBrowser(workspace('legacy backup'));
    const backup = await exportBrowserBackup();
    vi.stubGlobal('indexedDB', new IDBFactory());
    expect((await importBrowserBackup(backup)).libraries[0].name).toBe('legacy backup');
    expect((await loadLibraries()).libraries[0].name).toBe('legacy backup');
  });
});

describe('API settings', () => {
  const configured = { baseUrl: 'https://example.com/v1', model: 'custom', configured: true };

  it('reads and saves backend settings without returning or persisting the key in the browser', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(configured))));
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadSettings()).toEqual({ ...configured, apiKey: '' });
    expect(await saveSettings({ ...configured, apiKey: 'local-key' })).toEqual({ ...configured, apiKey: '' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/settings');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(localStorage.getItem('context-words-api-settings')).toBeNull();
  });

  it('migrates legacy settings only after a successful backend save', async () => {
    const previous = { baseUrl: configured.baseUrl, apiKey: 'migration-key', model: configured.model };
    localStorage.setItem('context-words-api-settings', JSON.stringify(previous));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...configured, configured: false })))
      .mockResolvedValueOnce(new Response(JSON.stringify(configured)));
    vi.stubGlobal('fetch', fetchMock);
    const first = loadSettings();
    const second = loadSettings();
    expect(await first).toEqual({ ...configured, apiKey: '' });
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(previous);
    expect(localStorage.getItem('context-words-api-settings')).toBeNull();
  });

  it('keeps legacy settings when backend migration fails and reports the failure', async () => {
    const previous = JSON.stringify({ baseUrl: configured.baseUrl, model: configured.model, apiKey: 'migration-key' });
    localStorage.setItem('context-words-api-settings', previous);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...configured, configured: false })))
      .mockResolvedValueOnce(new Response('{"error":{"message":"disk full"}}', { status: 500 })));
    await expect(loadSettings()).rejects.toThrow('disk full');
    expect(localStorage.getItem('context-words-api-settings')).toBe(previous);
  });

  it('does not replace existing backend settings with legacy browser values', async () => {
    localStorage.setItem('context-words-api-settings', '{"apiKey":"old-key"}');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(configured)));
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadSettings()).toEqual({ ...configured, apiKey: '' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('context-words-api-settings')).toBeNull();
  });

  it('reports unavailable backend or invalid responses without silently resetting settings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(loadSettings()).rejects.toThrow('无法读取');
    await expect(saveSettings({ baseUrl: '', apiKey: '', model: '' })).rejects.toThrow('无法保存');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"apiKey":"must-not-be-returned"}')));
    await expect(loadSettings()).rejects.toThrow('格式无效');
  });
});

describe('import draft storage', () => {
  function draft(): ImportDraft {
    return { version: 1, name: 'import.txt', sourceText: 'bank\tn. 银行；岸', encoding: 'auto', preview: { senses: [], issues: [], duplicateCount: 0 }, checkpoint: { sources: [], entries: [] }, reviewSenseIds: [], refined: false };
  }

  it('restores paused imports independently from the active learning session', async () => {
    expect(await loadImportDraft()).toBeNull();
    await seedBrowser(workspace('old learning session'));
    await loadLibraries();
    const original = draft();
    await saveImportDraft(original);
    expect(await loadImportDraft()).toEqual(original);
    expect((await loadLibraries()).libraries[0].name).toBe('old learning session');
    await clearImportDraft();
    expect(await loadImportDraft()).toBeNull();
    expect((await loadLibraries()).libraries[0].name).toBe('old learning session');
  });

  it('snapshots draft edits and keeps the latest update in submission order', async () => {
    const first = draft();
    const second = { ...draft(), name: 'latest import.txt', reviewSenseIds: ['manual-review'] };
    const firstSave = saveImportDraft(first);
    const secondSave = saveImportDraft(second);
    second.reviewSenseIds.push('changed after save');
    await Promise.all([firstSave, secondSave]);
    expect(await loadImportDraft()).toMatchObject({ name: 'latest import.txt', reviewSenseIds: ['manual-review'] });
  });

  it('reports failed draft storage rather than claiming the checkpoint was saved', async () => {
    const backend = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('disk full')));
    await expect(saveImportDraft(draft())).rejects.toThrow('disk full');
    vi.stubGlobal('fetch', backend);
    await saveImportDraft(draft());
    expect(await loadImportDraft()).not.toBeNull();
  });
});

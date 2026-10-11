import type { ApiSettings, ImportDraft, LibraryCollection, Workspace } from './types';

const databaseName = 'context-words';
const storeName = 'workspace';
const legacySettingsKey = 'context-words-api-settings';
let saveQueue: Promise<void> = Promise.resolve();
let settingsLoad: Promise<ApiSettings> | null = null;
let librariesLoad: Promise<LibraryCollection> | null = null;
let libraryRevision: number | null = null;

interface BackendLibraries {
  collection: LibraryCollection;
  revision: number;
  migratedSourceIds: string[];
}

async function backendRequest(route: string, payload?: unknown): Promise<unknown> {
  try {
    const response = await fetch(route, payload === undefined ? { cache: 'no-store' } : {
      method: route.endsWith('/migrate') ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error?.message || `HTTP ${response.status}`);
    return value;
  } catch (error) {
    throw failure('本机后端数据读写失败，请保持服务运行后重试', error);
  }
}

function backendLibraries(value: unknown): BackendLibraries {
  const result = value as BackendLibraries;
  if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0
    || !Array.isArray(result.migratedSourceIds) || result.migratedSourceIds.some(id => typeof id !== 'string')) {
    throw failure('后端词库响应格式无效');
  }
  return { ...result, collection: validateLibraries(result.collection) };
}

function failure(message: string, error?: unknown): Error {
  return new Error(`${message}${error instanceof Error ? `：${error.message}` : ''}`);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(failure('当前浏览器不支持本地学习记录存储'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(databaseName, 1);
    } catch (error) {
      reject(failure('无法打开本地学习记录', error));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
    };
    request.onerror = () => reject(failure('无法打开本地学习记录', request.error));
    request.onblocked = () => reject(failure('本地存储被其他页面占用，请关闭其他学习页面后重试'));
    request.onsuccess = () => resolve(request.result);
  });
}

function validateWorkspace(value: unknown): Workspace {
  const workspace = value as Workspace;
  if (!workspace || workspace.version !== 1 || typeof workspace.name !== 'string'
    || typeof workspace.sourceText !== 'string' || !Array.isArray(workspace.senses)
    || typeof workspace.updatedAt !== 'string' || !(workspace.session === null || typeof workspace.session === 'object')) {
    throw failure('本地学习记录格式无效');
  }
  if (workspace.session) {
    const session = workspace.session;
    if (!['coverage', 'review', 'complete'].includes(session.phase)
      || !Array.isArray(session.remainingSenseIds) || !Array.isArray(session.coveredSenseIds)
      || !Array.isArray(session.accumulatedUnknownIds) || !Array.isArray(session.reviewSenseIds)
      || !Array.isArray(session.currentUnknownIds) || !Array.isArray(session.articles)) {
      throw failure('本地学习进度格式无效');
    }
    session.reviewPendingIds ??= session.reviewSenseIds.filter((senseId) => !session.articles
      .find((article) => article.id === session.currentArticleId)?.targetSenseIds.includes(senseId));
    session.reviewUnknownIds ??= [];
  }
  return workspace;
}

function normalizeWorkspace(value: Workspace): Workspace {
  const workspace = validateWorkspace(structuredClone(value));
  if (typeof workspace.id !== 'string' || !workspace.id) workspace.id = crypto.randomUUID();
  const previousOptions = workspace.readingOptions as (typeof workspace.readingOptions & { maxWordCount?: number });
  workspace.readingOptions = {
    targetCount: previousOptions?.targetCount ?? 20,
    expectedWordCount: previousOptions?.expectedWordCount ?? previousOptions?.maxWordCount ?? 400,
  };
  if (!Number.isInteger(workspace.readingOptions.targetCount) || workspace.readingOptions.targetCount < 1
    || !Number.isSafeInteger(workspace.readingOptions.expectedWordCount) || workspace.readingOptions.expectedWordCount < 1) {
    throw failure('词库阅读设置格式无效');
  }
  workspace.archivedSessions ??= [];
  if (!Array.isArray(workspace.archivedSessions)) throw failure('词库学习历史格式无效');
  if (workspace.screening !== undefined) {
    const screening = workspace.screening;
    if (!screening || !Array.isArray(screening.unknownSenseIds)
      || screening.unknownSenseIds.some((senseId) => typeof senseId !== 'string')
      || typeof screening.updatedAt !== 'string' || Number.isNaN(Date.parse(screening.updatedAt))) {
      throw failure('词库生词筛选记录格式无效');
    }
    const senseIds = new Set(workspace.senses.map((sense) => sense.id));
    screening.unknownSenseIds = [...new Set(screening.unknownSenseIds.filter((senseId) => senseIds.has(senseId)))];
  }
  if (workspace.branch !== undefined) {
    const branch = workspace.branch;
    if (!branch || typeof branch.parentLibraryId !== 'string' || !branch.parentLibraryId
      || typeof branch.parentLibraryName !== 'string' || !branch.parentLibraryName
      || typeof branch.createdAt !== 'string' || Number.isNaN(Date.parse(branch.createdAt))) {
      throw failure('生词分支来源记录格式无效');
    }
  }
  return workspace;
}

function validateLibraries(value: unknown): LibraryCollection {
  const collection = value as LibraryCollection;
  if (!collection || collection.version !== 1 || !Array.isArray(collection.libraries)) {
    throw failure('本地词库集合格式无效');
  }
  const libraries = collection.libraries.map(normalizeWorkspace);
  const ids = new Set<string>();
  for (const library of libraries) {
    if (!library.id || ids.has(library.id)) library.id = crypto.randomUUID();
    ids.add(library.id);
  }
  return {
    version: 1,
    libraries,
    activeLibraryId: collection.activeLibraryId && ids.has(collection.activeLibraryId)
      ? collection.activeLibraryId
      : libraries[0]?.id ?? null,
  };
}

async function readBrowserData(): Promise<{ sourceId: string; collection: LibraryCollection; draft: ImportDraft | null } | null> {
  if (!globalThis.indexedDB) return null;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const requests = ['libraries', 'current', 'import-draft'].map(key => store.get(key));
    let result: { sourceId: string; collection: LibraryCollection; draft: ImportDraft | null } | null = null;
    let rawSnapshot = '';
    let remaining = requests.length;
    for (const request of requests) request.onsuccess = () => {
      if (--remaining) return;
      try {
        const legacy = requests[1].result;
        const collection = requests[0].result !== undefined ? validateLibraries(requests[0].result)
          : validateLibraries({ version: 1, libraries: legacy === undefined ? [] : [legacy], activeLibraryId: legacy?.id ?? null });
        const draft = requests[2].result === undefined ? null : validateDraft(requests[2].result);
        if (!collection.libraries.length && !draft) return;
        rawSnapshot = JSON.stringify({ origin: globalThis.location?.origin ?? 'unknown',
          libraries: requests[0].result ?? null, current: requests[0].result === undefined ? legacy ?? null : null,
          draft: requests[2].result ?? null });
        result = { sourceId: '', collection, draft };
      } catch (error) { transaction.abort(); reject(error); }
    };
    transaction.oncomplete = () => {
      database.close();
      if (!result) { resolve(null); return; }
      const snapshot = result;
      void crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawSnapshot)).then(hash => {
        snapshot.sourceId = 'browser-' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
        resolve(snapshot);
      }).catch(reject);
    };
    transaction.onerror = transaction.onabort = () => { database.close(); reject(failure('读取旧浏览器数据失败，原数据保留', transaction.error)); };
  });
}

async function loadAndMigrateLibraries(): Promise<LibraryCollection> {
  libraryRevision = null;
  let result = backendLibraries(await backendRequest('/api/libraries'));
  const legacy = await readBrowserData();
  if (legacy && !result.migratedSourceIds.includes(legacy.sourceId)) {
    result = backendLibraries(await backendRequest('/api/libraries/migrate', legacy));
  }
  libraryRevision = result.revision;
  return result.collection;
}

export async function loadLibraries(): Promise<LibraryCollection> {
  await saveQueue.catch(() => undefined);
  if (!librariesLoad) librariesLoad = loadAndMigrateLibraries().finally(() => { librariesLoad = null; });
  return librariesLoad;
}

export async function exportBrowserBackup(): Promise<string> {
  const legacy = await readBrowserData();
  if (!legacy) throw failure('当前浏览器地址下没有旧词库或导入草稿，请打开原来使用的地址');
  return JSON.stringify(legacy, null, 2);
}

export async function importBrowserBackup(text: string): Promise<LibraryCollection> {
  const value = JSON.parse(text) as { sourceId: string; collection: unknown; draft: unknown };
  if (!value || typeof value.sourceId !== 'string') throw failure('迁移备份格式无效');
  const payload = {
    sourceId: value.sourceId,
    collection: validateLibraries(value.collection),
    draft: value.draft === null ? null : validateDraft(value.draft),
  };
  const pending = saveQueue.catch(() => undefined).then(async () => {
    const result = backendLibraries(await backendRequest('/api/libraries/migrate', payload));
    libraryRevision = result.revision;
    return result.collection;
  });
  saveQueue = pending.then(() => undefined);
  return pending;
}

export async function saveLibraries(collection: LibraryCollection): Promise<void> {
  const snapshot = validateLibraries(collection);
  const pendingSave = saveQueue.catch(() => undefined).then(async () => {
    if (libraryRevision === null) throw failure('词库尚未成功读取或迁移，请重新加载后保存；原文件保留');
    const result = backendLibraries(await backendRequest('/api/libraries', { collection: snapshot, revision: libraryRevision }));
    libraryRevision = result.revision;
  });
  saveQueue = pendingSave;
  await pendingSave;
}

function publicSettings(value: unknown): ApiSettings {
  const settings = value as Partial<ApiSettings> | null;
  if (!settings || typeof settings.baseUrl !== 'string' || typeof settings.model !== 'string' || typeof settings.configured !== 'boolean') {
    throw new Error('设置格式无效');
  }
  return { baseUrl: settings.baseUrl, model: settings.model, configured: settings.configured, apiKey: '' };
}

async function readBackendSettings(): Promise<ApiSettings> {
  const response = await fetch('/api/settings', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return publicSettings(await response.json());
}

async function loadAndMigrateSettings(): Promise<ApiSettings> {
  try {
    let settings = await readBackendSettings();
    let legacy: string | null = null;
    try { legacy = globalThis.localStorage?.getItem(legacySettingsKey) ?? null; } catch {}
    if (legacy !== null) {
      if (!settings.configured) {
        const previous = JSON.parse(legacy) as ApiSettings;
        if (!previous || typeof previous.baseUrl !== 'string' || typeof previous.apiKey !== 'string' || typeof previous.model !== 'string') {
          throw new Error('旧浏览器配置无效，请在设置页重新保存');
        }
        if (previous.apiKey.trim() && previous.model.trim()) settings = await saveSettings(previous);
        else return settings;
      }
      globalThis.localStorage.removeItem(legacySettingsKey);
    }
    return settings;
  } catch (error) {
    throw failure('无法读取或迁移后端 API 设置', error);
  }
}

export function loadSettings(): Promise<ApiSettings> {
  if (!settingsLoad) settingsLoad = loadAndMigrateSettings().finally(() => { settingsLoad = null; });
  return settingsLoad;
}

export async function saveSettings(settings: ApiSettings): Promise<ApiSettings> {
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(payload?.error?.message || `HTTP ${response.status}`);
    }
    const saved = publicSettings(await response.json());
    try { globalThis.localStorage?.removeItem(legacySettingsKey); } catch {}
    return saved;
  } catch (error) {
    throw failure('无法保存后端 API 设置', error);
  }
}

function validateDraft(value: unknown): ImportDraft {
  const draft = value as ImportDraft;
  if (!draft || draft.version !== 1 || typeof draft.name !== 'string' || typeof draft.sourceText !== 'string'
    || !['auto', 'utf-8', 'gb18030'].includes(draft.encoding) || typeof draft.refined !== 'boolean'
    || !draft.preview || !Array.isArray(draft.preview.senses) || !Array.isArray(draft.preview.issues)
    || !Array.isArray(draft.reviewSenseIds) || !(draft.checkpoint === null || (Array.isArray(draft.checkpoint?.sources) && Array.isArray(draft.checkpoint?.entries)))) {
    throw failure('本地导入草稿格式无效');
  }
  return draft;
}

export async function loadImportDraft(): Promise<ImportDraft | null> {
  await loadLibraries();
  const result = await backendRequest('/api/import-draft') as { draft: unknown };
  return result.draft === null ? null : validateDraft(result.draft);
}

async function writeImportDraft(draft: ImportDraft | null): Promise<void> {
  if (libraryRevision === null) throw failure('数据尚未成功读取或迁移，请重新加载后保存；原草稿保留');
  await backendRequest('/api/import-draft', { draft });
}

export async function saveImportDraft(draft: ImportDraft): Promise<void> {
  const snapshot = validateDraft(structuredClone(draft));
  const pendingSave = saveQueue.catch(() => undefined).then(() => writeImportDraft(snapshot));
  saveQueue = pendingSave;
  await pendingSave;
}

export async function clearImportDraft(): Promise<void> {
  const pendingSave = saveQueue.catch(() => undefined).then(() => writeImportDraft(null));
  saveQueue = pendingSave;
  await pendingSave;
}

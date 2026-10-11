import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class StorageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.kind = 'storage';
  }
}

const emptyCollection = () => ({ version: 1, libraries: [], activeLibraryId: null });
const stringList = value => Array.isArray(value) && value.every(item => typeof item === 'string');

function validSession(session) {
  return session === null || Boolean(session && ['coverage', 'review', 'complete'].includes(session.phase)
    && ['remainingSenseIds', 'coveredSenseIds', 'accumulatedUnknownIds', 'reviewSenseIds', 'currentUnknownIds']
      .every(key => stringList(session[key])) && Array.isArray(session.articles));
}

function validSense(sense) {
  return sense && ['id', 'word', 'meaning', 'partOfSpeech', 'sourceText'].every(key => typeof sense[key] === 'string')
    && ['import', 'lookup'].includes(sense.origin) && Number.isInteger(sense.sourceLine);
}

function validateCollection(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.libraries)) throw new StorageError(400, '词库集合格式无效。');
  const ids = new Set();
  for (const library of value.libraries) {
    if (!library || library.version !== 1 || typeof library.id !== 'string' || !library.id || ids.has(library.id)
      || typeof library.name !== 'string' || typeof library.sourceText !== 'string'
      || typeof library.updatedAt !== 'string' || !Array.isArray(library.senses) || !library.senses.every(validSense)
      || !validSession(library.session) || !Array.isArray(library.archivedSessions) || !library.archivedSessions.every(validSession)
      || !Number.isInteger(library.readingOptions?.targetCount) || library.readingOptions.targetCount < 1
      || !Number.isSafeInteger(library.readingOptions?.expectedWordCount) || library.readingOptions.expectedWordCount < 1) {
      throw new StorageError(400, '词库或学习进度格式无效，原文件未修改。');
    }
    if (library.screening !== undefined && (!stringList(library.screening?.unknownSenseIds)
      || typeof library.screening.updatedAt !== 'string' || Number.isNaN(Date.parse(library.screening.updatedAt)))) {
      throw new StorageError(400, '词库筛选记录格式无效。');
    }
    if (library.branch !== undefined && (!library.branch || !library.branch.parentLibraryId || !library.branch.parentLibraryName
      || typeof library.branch.createdAt !== 'string' || Number.isNaN(Date.parse(library.branch.createdAt)))) {
      throw new StorageError(400, '生词分支来源记录格式无效。');
    }
    ids.add(library.id);
  }
  if (value.activeLibraryId !== null && !ids.has(value.activeLibraryId)) throw new StorageError(400, '当前词库编号无效。');
  return { version: 1, libraries: value.libraries, activeLibraryId: value.activeLibraryId };
}

function validateDraft(value) {
  if (value !== null && (!value || value.version !== 1 || typeof value.name !== 'string' || typeof value.sourceText !== 'string'
    || !['auto', 'utf-8', 'gb18030'].includes(value.encoding) || typeof value.refined !== 'boolean'
    || !Array.isArray(value.preview?.senses) || !value.preview.senses.every(validSense) || !Array.isArray(value.preview.issues)
    || !stringList(value.reviewSenseIds) || !(value.checkpoint === null
      || (Array.isArray(value.checkpoint?.sources) && Array.isArray(value.checkpoint?.entries))))) {
    throw new StorageError(400, '导入草稿格式无效。');
  }
  return value;
}

export function createLibraryStore(directory) {
  const librariesPath = path.join(directory, 'libraries.json');
  const draftPath = path.join(directory, 'import-draft.json');
  const lockPath = path.join(directory, 'library-storage.lock');

  async function read(file, fallback, validate) {
    let content;
    try { content = await fs.readFile(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw new StorageError(500, `无法读取 ${path.basename(file)}，请检查 data 目录权限。`);
    }
    try { return validate(JSON.parse(content)); }
    catch { throw new StorageError(500, `${path.basename(file)} 格式损坏，原文件已保留；请检查同目录的 .bak 备份。`); }
  }

  async function loadLibraries() {
    return read(librariesPath, { collection: emptyCollection(), revision: 0, migratedSourceIds: [] }, value => {
      if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !stringList(value.migratedSourceIds)) throw new Error();
      return { ...value, collection: validateCollection(value.collection) };
    });
  }

  const loadDraft = () => read(draftPath, null, validateDraft);

  async function atomicWrite(file, value, backup = true) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const backupTemporary = `${file}.${randomUUID()}.bak.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
      if (backup) {
        try {
          await fs.copyFile(file, backupTemporary);
          await fs.rename(backupTemporary, `${file}.bak`);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await fs.rename(temporary, file);
    } catch {
      throw new StorageError(500, '无法保存学习数据，原文件未替换；请检查 data 目录权限和磁盘空间。');
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
      await fs.unlink(backupTemporary).catch(() => undefined);
    }
  }

  async function writeLocked(operation) {
    try { await fs.mkdir(directory, { recursive: true }); }
    catch { throw new StorageError(500, '无法创建 data 目录。'); }
    for (let attempt = 0; attempt < 150; attempt++) {
      let lock;
      try { lock = await fs.open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw new StorageError(500, '无法锁定学习数据文件。');
        try {
          const owner = Number(await fs.readFile(lockPath, 'utf8'));
          if (Number.isSafeInteger(owner) && owner > 0) {
            try { process.kill(owner, 0); }
            catch (failure) { if (failure.code === 'ESRCH') await fs.unlink(lockPath); }
          }
        } catch {}
        await delay(20);
        continue;
      }
      try {
        await lock.writeFile(String(process.pid));
        return await operation();
      } finally {
        await lock.close();
        await fs.unlink(lockPath).catch(() => undefined);
      }
    }
    throw new StorageError(503, '学习数据正在保存，请稍后重试。');
  }

  async function saveLibraries(value, revision) {
    const collection = validateCollection(value);
    return writeLocked(async () => {
      const current = await loadLibraries();
      if (!Number.isSafeInteger(revision) || revision !== current.revision) {
        throw new StorageError(409, '词库已在另一个页面更新，本次未覆盖文件。请保留当前页面内容并刷新后重试。');
      }
      const next = { ...current, collection, revision: current.revision + 1 };
      await atomicWrite(librariesPath, next);
      return next;
    });
  }

  async function saveDraft(value) {
    const draft = validateDraft(value);
    return writeLocked(async () => {
      await loadDraft();
      await atomicWrite(draftPath, draft);
      return draft;
    });
  }

  async function migrate({ sourceId, collection: incoming, draft = null }) {
    if (typeof sourceId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(sourceId)) throw new StorageError(400, '迁移来源编号无效。');
    const collection = validateCollection(incoming);
    validateDraft(draft);
    return writeLocked(async () => {
      const current = await loadLibraries();
      if (current.migratedSourceIds.includes(sourceId)) return current;
      const currentDraft = await loadDraft();
      await atomicWrite(path.join(directory, 'migrations', `${sourceId}.json`), { sourceId, collection, draft }, false);
      const libraries = [...current.collection.libraries];
      const remappedIds = new Map();
      const additions = [];
      for (const library of collection.libraries) {
        const existing = libraries.find(item => item.id === library.id);
        if (existing && JSON.stringify(existing) === JSON.stringify(library)) continue;
        const copy = structuredClone(library);
        if (existing) {
          copy.id = randomUUID();
          copy.name += '（浏览器迁移副本）';
          remappedIds.set(library.id, copy.id);
        }
        additions.push(copy);
      }
      for (const library of additions) {
        if (library.branch && remappedIds.has(library.branch.parentLibraryId)) {
          library.branch.parentLibraryId = remappedIds.get(library.branch.parentLibraryId);
        }
      }
      libraries.push(...additions);
      if (draft && currentDraft === null) await atomicWrite(draftPath, draft);
      const next = {
        collection: { version: 1, libraries, activeLibraryId: current.collection.activeLibraryId
          ?? remappedIds.get(collection.activeLibraryId) ?? collection.activeLibraryId },
        revision: current.revision + 1,
        migratedSourceIds: [...current.migratedSourceIds, sourceId],
      };
      await atomicWrite(librariesPath, next);
      return next;
    });
  }

  return { loadLibraries, saveLibraries, loadDraft, saveDraft, migrate };
}

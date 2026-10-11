import type { Workspace } from './types';
import { expandScreeningSenseIds } from './screening';

function localTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function createBranchLibrary(
  parent: Workspace,
  selectedSenseIds: string[],
  createdAt = new Date().toISOString(),
): Workspace {
  if (typeof parent.id !== 'string' || !parent.id.trim()) throw new Error('请先保存原词库，再创建生词分支');
  const createdDate = new Date(createdAt);
  if (Number.isNaN(createdDate.getTime())) throw new Error('生词分支创建时间无效');
  const selectedIds = new Set(expandScreeningSenseIds(parent.senses, selectedSenseIds));
  const includedIds = new Set<string>();
  const senses = parent.senses.filter((sense) => {
    if (sense.origin !== 'import' || !selectedIds.has(sense.id) || includedIds.has(sense.id)) return false;
    includedIds.add(sense.id);
    return true;
  }).map((sense) => ({ ...sense }));
  if (!senses.length) throw new Error('请至少标记一个不认识的单词');
  const parentName = parent.name.trim() || '未命名词库';
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: `${parentName} · 生词 ${localTimestamp(createdDate)}`,
    sourceText: senses.map((sense) => `${sense.word}\t${[sense.partOfSpeech, sense.meaning].filter(Boolean).join(' ')}`).join('\n'),
    senses,
    session: null,
    archivedSessions: [],
    updatedAt: createdAt,
    ...(parent.readingOptions ? { readingOptions: { ...parent.readingOptions } } : {}),
    branch: {
      parentLibraryId: parent.id,
      parentLibraryName: parentName,
      createdAt,
    },
  };
}

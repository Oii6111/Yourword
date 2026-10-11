import { describe, expect, it } from 'vitest';
import { parseVocabulary } from './import';
import { createBranchLibrary } from './libraries';
import { createSession } from './session';
import type { Workspace } from './types';

const createdAt = '2026-10-09T12:34:56.000Z';

function parentLibrary(): Workspace {
  const senses = parseVocabulary('bank\tn. 银行\nbank\tn. 河岸\nbright\tadj. 明亮的\nhello\t你好').senses;
  return {
    version: 1,
    id: 'parent-library',
    name: '基础词库',
    sourceText: senses.map((sense) => sense.sourceText).join('\n'),
    senses,
    session: createSession(senses),
    readingOptions: { targetCount: 12, expectedWordCount: 300 },
    archivedSessions: [createSession(senses)],
    screening: { unknownSenseIds: senses.slice(0, 2).map((sense) => sense.id), updatedAt: createdAt },
    updatedAt: createdAt,
  };
}

describe('dated vocabulary branches', () => {
  it('选择同一单词任一词义即包含全部词义，排除无效编号并去重', () => {
    const parent = parentLibrary();
    const first = parent.senses[0].id;
    const second = parent.senses[1].id;
    parent.senses.push({ ...parent.senses[0] });
    const branch = createBranchLibrary(parent, [second, second, 'deleted-sense'], createdAt);
    expect(branch.id).toEqual(expect.any(String));
    expect(branch.id).not.toBe(parent.id);
    expect(branch.senses.map((sense) => sense.id)).toEqual([first, second]);
    expect(branch.senses.map((sense) => sense.meaning)).toEqual(['银行', '河岸']);
    expect(branch.session).toBeNull();
    expect(branch.archivedSessions).toEqual([]);
    expect(branch.screening).toBeUndefined();
    expect(branch.branch).toEqual({ parentLibraryId: parent.id, parentLibraryName: parent.name, createdAt });
    expect(branch.updatedAt).toBe(createdAt);
  });

  it('按本地时间命名分支，包含日期和秒', () => {
    const parent = parentLibrary();
    const branch = createBranchLibrary(parent, [parent.senses[0].id], createdAt);
    const date = new Date(createdAt);
    const pad = (value: number) => String(value).padStart(2, '0');
    expect(branch.name).toBe(`基础词库 · 生词 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`);
  });

  it('分支词义、阅读设置和来源信息不随原词库修改而变化', () => {
    const parent = parentLibrary();
    const original = structuredClone(parent);
    const branch = createBranchLibrary(parent, [parent.senses[0].id], createdAt);
    expect(parent).toEqual(original);
    parent.senses[0].meaning = '被修改的释义';
    parent.senses.splice(0);
    parent.readingOptions!.targetCount = 3;
    parent.name = '新名称';
    expect(branch.senses[0].meaning).toBe('银行');
    expect(branch.readingOptions).toEqual({ targetCount: 12, expectedWordCount: 300 });
    expect(branch.branch?.parentLibraryName).toBe('基础词库');
    branch.senses[0].meaning = '分支编辑';
    expect(original.senses[0].meaning).toBe('银行');
  });

  it('分支原文序列化选中单词全部词义且不包含其他单词', () => {
    const parent = parentLibrary();
    parent.senses[0].sourceText = 'bank\tn. 银行；河岸';
    const branch = createBranchLibrary(parent, [parent.senses[0].id, parent.senses[3].id], createdAt);
    expect(branch.sourceText).toBe('bank\tn. 银行\nbank\tn. 河岸\nhello\t你好');
    expect(parseVocabulary(branch.sourceText).senses.map(({ word, partOfSpeech, meaning }) => ({ word, partOfSpeech, meaning })))
      .toEqual([
        { word: 'bank', partOfSpeech: 'n.', meaning: '银行' },
        { word: 'bank', partOfSpeech: 'n.', meaning: '河岸' },
        { word: 'hello', partOfSpeech: '', meaning: '你好' },
      ]);
  });

  it('分支只包含导入单词，保持阅读查义词独立', () => {
    const parent = parentLibrary();
    parent.senses.push({ ...parent.senses[0], id: 'lookup-bank', origin: 'lookup', meaning: '阅读中的银行' });
    const branch = createBranchLibrary(parent, [parent.senses[0].id, 'lookup-bank'], createdAt);
    expect(branch.senses.map((sense) => sense.id)).toEqual(parent.senses.slice(0, 2).map((sense) => sense.id));
    expect(() => createBranchLibrary(parent, ['lookup-bank'], createdAt)).toThrow('至少标记');
  });

  it('拒绝空或全部已删除的选择、未保存的原词库和无效创建时间', () => {
    const parent = parentLibrary();
    expect(() => createBranchLibrary(parent, [], createdAt)).toThrow('至少标记');
    expect(() => createBranchLibrary(parent, ['deleted-sense'], createdAt)).toThrow('至少标记');
    expect(() => createBranchLibrary({ ...parent, id: undefined }, [parent.senses[0].id], createdAt)).toThrow('先保存');
    expect(() => createBranchLibrary({ ...parent, id: ' ' }, [parent.senses[0].id], createdAt)).toThrow('先保存');
    expect(() => createBranchLibrary(parent, [parent.senses[0].id], 'invalid')).toThrow('创建时间无效');
  });

  it('原词库名称为空时仍提供有效的分支来源名称', () => {
    const parent = parentLibrary();
    parent.name = ' ';
    const branch = createBranchLibrary(parent, [parent.senses[0].id], createdAt);
    expect(branch.name).toMatch(/^未命名词库 · 生词 /);
    expect(branch.branch?.parentLibraryName).toBe('未命名词库');
  });
});

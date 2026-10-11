import { describe, expect, it } from 'vitest';
import { applyScreeningPageSelection, expandScreeningSenseIds, groupScreeningWords } from './screening';
import type { Sense } from './types';

function makeSense(id: string, word: string, meaning: string, origin: Sense['origin'] = 'import'): Sense {
  return { id, word, meaning, origin, partOfSpeech: 'n.', sourceLine: 1, sourceText: `${word}\t${meaning}` };
}

describe('word-based vocabulary screening', () => {
  it('同一单词合并词义并保留首次拼写、单词顺序和稳定词义编号', () => {
    const senses = [
      makeSense('bank-money', 'Bank', '银行'),
      makeSense('bright-light', 'bright', '明亮的'),
      makeSense('bank-river', ' bank ', '河岸'),
      makeSense('bright-smart', 'BRIGHT', '聪明的'),
    ];
    const original = structuredClone(senses);
    expect(groupScreeningWords(senses)).toEqual([
      { id: 'bank', word: 'Bank', senses: [senses[0], senses[2]] },
      { id: 'bright', word: 'bright', senses: [senses[1], senses[3]] },
    ]);
    expect(senses).toEqual(original);
  });

  it('合并直撇号和弯撇号的拼写但不合并其他不同单词', () => {
    const senses = [
      makeSense('cant-curly', 'Can’t', '不能'),
      makeSense('cant-straight', "can't", '无法'),
      makeSense('cant-left-curly', 'CAN‘T', '不可以'),
      makeSense('cant-noun', 'cant', '隐语'),
    ];
    const words = groupScreeningWords(senses);
    expect(words.map(({ id, word }) => ({ id, word }))).toEqual([
      { id: "can't", word: 'Can’t' },
      { id: 'cant', word: 'cant' },
    ]);
    expect(words[0].senses.map((sense) => sense.id)).toEqual(['cant-curly', 'cant-straight', 'cant-left-curly']);
  });

  it('排除阅读查义词并对重复词义编号去重', () => {
    const bank = makeSense('bank-money', 'bank', '银行');
    const senses = [
      makeSense('lookup-first', 'bank', '查义结果', 'lookup'),
      bank,
      { ...bank },
      makeSense('bank-river', 'bank', '河岸'),
      makeSense('lookup-only', 'morning', '早晨', 'lookup'),
      makeSense('bank-money', 'other', '重复编号'),
    ];
    expect(groupScreeningWords(senses)).toEqual([
      { id: 'bank', word: 'bank', senses: [bank, senses[3]] },
    ]);
  });

  it('旧标记选中任一词义即展开该单词全部导入词义，结果保持原词库顺序', () => {
    const senses = [
      makeSense('bank-money', 'Bank', '银行'),
      makeSense('bright-light', 'bright', '明亮的'),
      makeSense('bank-river', 'bank', '河岸'),
      makeSense('bright-smart', 'BRIGHT', '聪明的'),
      makeSense('bank-lookup', 'bank', '阅读中的银行', 'lookup'),
      makeSense('unselected', 'hello', '你好'),
    ];
    expect(expandScreeningSenseIds(senses, ['bright-smart', 'bank-river', 'bank-river', 'stale-id']))
      .toEqual(['bank-money', 'bright-light', 'bank-river', 'bright-smart']);
    expect(expandScreeningSenseIds(senses, ['bank-lookup', 'stale-id'])).toEqual([]);
    expect(expandScreeningSenseIds(senses, [])).toEqual([]);
  });

  it('展开选择时合并撇号变体并去重编号，查义对象不会抢占导入编号', () => {
    const senses = [
      makeSense('cant-first', "can't", '不能', 'lookup'),
      makeSense('cant-first', 'Can’t', '不能'),
      makeSense('cant-second', "CAN'T", '无法'),
      makeSense('cant-first', 'Can’t', '不能'),
    ];
    expect(expandScreeningSenseIds(senses, ['cant-second'])).toEqual(['cant-first', 'cant-second']);
  });

  it('正选只更新当前页并把所选单词展开为全部词义', () => {
    const senses = [
      makeSense('bank-money', 'Bank', '银行'),
      makeSense('hello', 'hello', '你好'),
      makeSense('bank-river', 'bank', '河岸'),
      makeSense('bright', 'bright', '明亮的'),
    ];
    expect(applyScreeningPageSelection(senses, ['hello', 'bright'], ['bank', 'bright'], ['bank'], 'unknown'))
      .toEqual(['bank-money', 'hello', 'bank-river']);
  });

  it('反选只把当前页未标记认识的词列入生词，其他页保留原状态', () => {
    const senses = [
      makeSense('bank-money', 'bank', '银行'),
      makeSense('hello', 'hello', '你好'),
      makeSense('bank-river', 'Bank', '河岸'),
      makeSense('bright', 'bright', '明亮的'),
      makeSense('outside-known', 'outside', '外部'),
    ];
    expect(applyScreeningPageSelection(
      senses,
      ['hello', 'bright'],
      ['bank', 'bright'],
      ['bright', 'hello', 'outside'],
      'known',
    )).toEqual(['bank-money', 'hello', 'bank-river']);
  });

  it('空选与全选按当前模式处理当前页，不影响其他页', () => {
    const senses = [
      makeSense('bank', 'bank', '银行'),
      makeSense('hello', 'hello', '你好'),
      makeSense('bright', 'bright', '明亮的'),
    ];
    const current = ['hello'];
    const page = ['bank', 'bright'];
    expect(applyScreeningPageSelection(senses, current, page, [], 'unknown')).toEqual(['hello']);
    expect(applyScreeningPageSelection(senses, current, page, page, 'unknown')).toEqual(['bank', 'hello', 'bright']);
    expect(applyScreeningPageSelection(senses, current, page, [], 'known')).toEqual(['bank', 'hello', 'bright']);
    expect(applyScreeningPageSelection(senses, current, page, page, 'known')).toEqual(['hello']);
  });

  it('忽略失效编号、阅读查义和不在当前页的选择，并去重', () => {
    const bank = makeSense('bank-money', 'Bank', '银行');
    const senses = [
      bank,
      { ...bank },
      makeSense('bank-river', 'bank', '河岸'),
      makeSense('hello', 'hello', '你好'),
      makeSense('lookup-morning', 'morning', '早晨', 'lookup'),
    ];
    const original = structuredClone(senses);
    expect(applyScreeningPageSelection(
      senses,
      ['hello', 'hello', 'lookup-morning', 'stale-sense'],
      ['bank', 'bank', 'morning', 'stale-word'],
      ['bank', 'bank', 'morning', 'stale-word', 'hello'],
      'unknown',
    )).toEqual(['bank-money', 'bank-river', 'hello']);
    expect(applyScreeningPageSelection(senses, ['hello'], [], ['bank'], 'known')).toEqual(['hello']);
    expect(senses).toEqual(original);
  });
});

import { describe, expect, it } from 'vitest';
import { decodeVocabulary, parseVocabulary } from './import';

describe('parseVocabulary', () => {
  it('按词性分组并保留分号及中文逗号，供智能义项整理', () => {
    const parsed = parseVocabulary('revolt\tn. 反抗；造反，起义 v. 起义；反抗');
    expect(parsed.issues).toEqual([]);
    expect(parsed.senses.map(({ word, partOfSpeech, meaning }) => ({ word, partOfSpeech, meaning }))).toEqual([
      { word: 'revolt', partOfSpeech: 'n.', meaning: '反抗；造反，起义' },
      { word: 'revolt', partOfSpeech: 'v.', meaning: '起义；反抗' },
    ]);
  });

  it('支持短语、apostrophe、无词性和 Windows 换行', () => {
    const parsed = parseVocabulary('\uFEFFgive up\t放弃\r\ncan’t\t不能\r\nchildren\'s\t孩子们的\r\n\r\n');
    expect(parsed.issues).toEqual([]);
    expect(parsed.senses.map((sense) => sense.word)).toEqual(['give up', 'can’t', "children's"]);
    expect(parsed.senses[0].partOfSpeech).toBe('');
    expect(parsed.senses[2].sourceLine).toBe(3);
  });

  it('忽略空行、去重条目，并准确报告错误行', () => {
    const parsed = parseVocabulary('bank\tn. 银行\nBank\tn. 银行\n\nmissing separator\nriver\t\nhello123\t你好\ngood\tadj. 好 v.');
    expect(parsed.senses).toHaveLength(1);
    expect(parsed.duplicateCount).toBe(1);
    expect(parsed.issues.map((issue) => issue.line)).toEqual([4, 5, 6, 7]);
    expect(parsed.senses[0].sourceText).toBe('bank\tn. 银行');
  });

  it('不会合并同一拼写的不同词性或不同释义', () => {
    const parsed = parseVocabulary('bank\tn. 银行\nbank\tn. 岸\nbank\tv. 存入银行');
    expect(parsed.senses).toHaveLength(3);
    expect(new Set(parsed.senses.map((sense) => sense.id)).size).toBe(3);
  });
});

describe('decodeVocabulary', () => {
  it('严格读取 UTF-8，自动识别 GB18030，并去除 BOM', () => {
    expect(decodeVocabulary(new TextEncoder().encode('\uFEFFword\t中文').buffer)).toBe('word\t中文');
    const chinese = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]).buffer;
    expect(decodeVocabulary(chinese)).toBe('中文');
    expect(decodeVocabulary(chinese, 'gb18030')).toBe('中文');
    expect(() => decodeVocabulary(chinese, 'utf-8')).toThrow();
  });
});

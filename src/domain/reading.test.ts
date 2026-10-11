import { describe, expect, it } from 'vitest';
import { contextForToken, tokenizeArticle } from './reading';
import type { Article } from './types';

function makeArticle(body: string, occurrences: Article['occurrences'] = []): Article {
  return {
    id: 'article-1', title: 'A short walk', body, theme: '日常生活',
    targetSenseIds: [...new Set(occurrences.map((occurrence) => occurrence.senseId))],
    occurrences, wordCount: 10, targetWordCount: 100, createdAt: '2026-10-09T00:00:00Z',
  };
}

describe('tokenizeArticle', () => {
  it('retains lookup sense IDs without treating ordinary words as article targets', () => {
    const article = makeArticle('bank morning', [
      { senseId: 'bank-finance', start: 0, end: 4, surface: 'bank' },
      { senseId: 'lookup-morning', start: 5, end: 12, surface: 'morning' },
    ]);
    article.targetSenseIds = ['bank-finance'];
    const tokens = tokenizeArticle(article);
    expect(tokens[0]).toMatchObject({ kind: 'target', senseId: 'bank-finance' });
    expect(tokens[2]).toMatchObject({ kind: 'word', senseId: 'lookup-morning' });
    expect(tokens.map((token) => token.text).join('')).toBe(article.body);
  });

  it('keeps identical spellings associated with their annotated senses', () => {
    const article = makeArticle('The bank faces a river bank.', [
      { senseId: 'bank-finance', start: 4, end: 8, surface: 'bank' },
      { senseId: 'bank-river', start: 23, end: 27, surface: 'bank' },
    ]);
    expect(tokenizeArticle(article).filter((token) => token.kind === 'target').map((token) => token.senseId))
      .toEqual(['bank-finance', 'bank-river']);
  });

  it('preserves punctuation, paragraphs, apostrophes, and original offsets', () => {
    const article = makeArticle("Don't hurry.\n\nA well-known bank is nearby!", [
      { senseId: 'bank-finance', start: 27, end: 31, surface: 'bank' },
    ]);
    const tokens = tokenizeArticle(article);
    expect(tokens.map((token) => token.text).join('')).toBe(article.body);
    for (const token of tokens) expect(article.body.slice(token.start, token.end)).toBe(token.text);
    expect(tokens.filter((token) => token.kind === 'word').map((token) => token.text)).toContain("Don't");
    expect(tokens.filter((token) => token.kind === 'word').map((token) => token.text)).toContain('well-known');
    expect(tokens.some((token) => token.text.includes('\n\n'))).toBe(true);
  });

  it('does not lose text when persisted annotations overlap or are invalid', () => {
    const article = makeArticle('bank!', [
      { senseId: 'first', start: 0, end: 4, surface: 'bank' },
      { senseId: 'overlap', start: 1, end: 4, surface: 'ank' },
      { senseId: 'outside', start: 9, end: 11, surface: 'xx' },
    ]);
    const tokens = tokenizeArticle(article);
    expect(tokens.map((token) => token.text).join('')).toBe('bank!');
    expect(tokens.filter((token) => token.kind === 'target')).toHaveLength(1);
  });

  it('handles targets at both ends and repeated occurrences of a sense', () => {
    const article = makeArticle('Bank, bank', [
      { senseId: 'same', start: 0, end: 4, surface: 'Bank' },
      { senseId: 'same', start: 6, end: 10, surface: 'bank' },
    ]);
    expect(tokenizeArticle(article).filter((token) => token.kind === 'target').map((token) => token.senseId))
      .toEqual(['same', 'same']);
  });
});

describe('contextForToken', () => {
  it('includes surrounding sentences to disambiguate the selected word', () => {
    const body = 'We went fishing. The bank was muddy. We sat near the water. Then we went home.';
    expect(contextForToken(body, 21, 25)).toBe('We went fishing. The bank was muddy. We sat near the water.');
  });

  it('keeps long context bounded while retaining the clicked word', () => {
    const body = `${'before '.repeat(100)}bank${' after'.repeat(100)}`;
    const context = contextForToken(body, 700, 704);
    expect(context.length).toBeLessThanOrEqual(804);
    expect(context).toContain('bank');
  });
});

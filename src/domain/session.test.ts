import { describe, expect, it } from 'vitest';
import { acceptArticle, createSession, finishArticle, getCurrentArticle, getPrefetchTargets, selectNextTargets, setPreparedArticle, toggleUnknown } from './session';
import type { Article, LearningSession, Sense } from './types';

function sensesFor(count: number): Sense[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `sense-${index}`,
    word: `word-${index}`,
    partOfSpeech: 'n.',
    meaning: `释义 ${index}`,
    sourceLine: index + 1,
    sourceText: '',
    origin: 'import' as const,
  }));
}

function articleFor(targets: Sense[], id: string): Article {
  let body = '';
  const occurrences = targets.map((sense) => {
    const start = body.length;
    body += `${sense.word} `;
    return { senseId: sense.id, start, end: start + sense.word.length, surface: sense.word };
  });
  return {
    id, title: 'Article', body, theme: 'test', targetSenseIds: targets.map((sense) => sense.id), occurrences,
    wordCount: targets.length, targetWordCount: 1000, createdAt: '2026-10-09T00:00:00.000Z',
  };
}

function markUnknown(session: LearningSession, ids: string[]): LearningSession {
  return ids.reduce((current, senseId) => toggleUnknown(current, senseId), session);
}

describe('learning session', () => {
  it('打乱初次队列，并将同一词的不同义项留给后续批次', () => {
    const senses = sensesFor(3);
    senses[0].word = 'bank';
    senses[1].word = 'Bank';
    const session = createSession(senses, () => 0);
    expect(session.remainingSenseIds).toEqual(['sense-1', 'sense-2', 'sense-0']);
    expect(selectNextTargets(session, senses).map((sense) => sense.id)).toEqual(['sense-1', 'sense-2']);
    expect(createSession([]).phase).toBe('complete');
  });

  it('不接受漏义项或原文位置失真的文章，也不改变原状态', () => {
    const senses = sensesFor(2);
    const session = createSession(senses, () => 0.99);
    const article = articleFor(senses, 'first');
    expect(() => acceptArticle(session, { ...article, occurrences: article.occurrences.slice(0, 1) })).toThrow('未覆盖');
    expect(() => acceptArticle(session, {
      ...article, occurrences: [{ ...article.occurrences[0], surface: 'incorrect' }, article.occurrences[1]],
    })).toThrow('不匹配');
    expect(session.remainingSenseIds).toHaveLength(2);
    expect(session.articles).toEqual([]);
  });

  it('累计初次各篇生词，全部初次覆盖后才开始复习', () => {
    const senses = sensesFor(3);
    let session = createSession(senses, () => 0.99);
    session = acceptArticle(session, articleFor(senses.slice(0, 2), 'first'));
    session = toggleUnknown(session, 'sense-0');
    expect(() => toggleUnknown(session, 'sense-2')).toThrow();
    expect(() => acceptArticle(session, articleFor(senses.slice(2), 'second'))).toThrow('先完成');
    session = finishArticle(session);
    expect(session.phase).toBe('coverage');
    expect(session.accumulatedUnknownIds).toEqual(['sense-0']);
    session = acceptArticle(session, articleFor(senses.slice(2), 'second'));
    session = finishArticle(toggleUnknown(session, 'sense-2'));
    expect(session.phase).toBe('review');
    expect(session.reviewRound).toBe(1);
    expect(session.reviewPendingIds).toEqual(['sense-0', 'sense-2']);
    expect(session.coveredSenseIds).toEqual(['sense-0', 'sense-1', 'sense-2']);
    expect(session.currentArticleId).toBeNull();
  });

  it('复习超过 50 个义项时跨批累计生词，整轮完成才收敛', () => {
    const senses = sensesFor(55);
    let session = createSession(senses, () => 0.99);
    session = acceptArticle(session, articleFor(senses, 'coverage'));
    session = finishArticle(markUnknown(session, senses.map((sense) => sense.id)));
    const firstBatch = selectNextTargets(session, senses);
    expect(firstBatch).toHaveLength(50);
    session = finishArticle(toggleUnknown(acceptArticle(session, articleFor(firstBatch, 'review-1a')), firstBatch[0].id));
    expect(session.reviewRound).toBe(1);
    expect(session.reviewPendingIds).toEqual(senses.slice(50).map((sense) => sense.id));
    expect(session.reviewUnknownIds).toEqual(['sense-0']);
    const secondBatch = selectNextTargets(session, senses);
    session = finishArticle(toggleUnknown(acceptArticle(session, articleFor(secondBatch, 'review-1b')), secondBatch[0].id));
    expect(session.reviewRound).toBe(2);
    expect(session.reviewPendingIds).toEqual(['sense-0', 'sense-50']);
    expect(session.reviewUnknownIds).toEqual([]);
    session = finishArticle(acceptArticle(session, articleFor(selectNextTargets(session, senses), 'review-2')));
    expect(session.phase).toBe('complete');
    expect(session.reviewSenseIds).toEqual([]);
  });

  it('重复点击取消生词标记，完成文章后不会重复提交', () => {
    const senses = sensesFor(1);
    let session = acceptArticle(createSession(senses), articleFor(senses, 'first'));
    session = toggleUnknown(toggleUnknown(session, senses[0].id), senses[0].id);
    expect(session.currentUnknownIds).toEqual([]);
    expect(getCurrentArticle(session)?.id).toBe('first');
    session = finishArticle(session);
    expect(session.phase).toBe('complete');
    expect(getCurrentArticle(session)).toBeNull();
    expect(finishArticle(session)).toBe(session);
  });

  it('允许将当前文章的新查词义项加入后续复习', () => {
    const senses = sensesFor(1);
    let session = acceptArticle(createSession(senses), articleFor(senses, 'first'));
    const current = getCurrentArticle(session)!;
    session = { ...session, articles: [{ ...current, occurrences: [...current.occurrences, { ...current.occurrences[0], senseId: 'lookup' }] }] };
    session = finishArticle(toggleUnknown(session, 'lookup'));
    expect(session.reviewPendingIds).toEqual(['lookup']);
  });

  it('预生成只选择本轮未覆盖目标，不改变当前覆盖、历史和标记', () => {
    const senses = sensesFor(3);
    const initial = createSession(senses, () => 0.99);
    expect(getPrefetchTargets(initial, senses, 1)).toEqual([]);
    let session = acceptArticle(initial, articleFor(senses.slice(0, 1), 'current'));
    session = toggleUnknown(session, senses[0].id);
    const targets = getPrefetchTargets(session, senses, 1);
    expect(targets.map((sense) => sense.id)).toEqual(['sense-1']);
    const prepared = articleFor(targets, 'next');
    const snapshot = structuredClone(session);
    session = setPreparedArticle(session, prepared);
    expect(session).toEqual({ ...snapshot, preparedArticle: prepared });
    expect(() => setPreparedArticle(session, articleFor(senses.slice(0, 1), 'invalid'))).toThrow('不属于');
    session = finishArticle(session);
    expect(session.preparedArticle?.id).toBe('next');
    session = acceptArticle(session, session.preparedArticle!);
    expect(session.preparedArticle).toBeNull();
    expect(session.articles.map((article) => article.id)).toEqual(['current', 'next']);
    expect(session.coveredSenseIds).toEqual(['sense-0', 'sense-1']);
  });

  it('文章历史保存各轮总量、覆盖量及该篇最终生词标记', () => {
    const senses = sensesFor(3);
    let session = acceptArticle(createSession(senses, () => 0.99), articleFor(senses.slice(0, 2), 'coverage-1'));
    expect(getCurrentArticle(session)).toMatchObject({ phase: 'coverage', reviewRound: 0, roundTotal: 3, roundCovered: 2 });
    session = finishArticle(toggleUnknown(session, 'sense-0'));
    expect(session.articles[0]).toMatchObject({ unknownSenseIds: ['sense-0'], finishedAt: expect.any(String) });
    session = finishArticle(toggleUnknown(acceptArticle(session, articleFor(senses.slice(2), 'coverage-2')), 'sense-2'), () => 0);
    expect(session.reviewPendingIds).toEqual(['sense-2', 'sense-0']);
    session = acceptArticle(session, articleFor(selectNextTargets(session, senses, 1), 'review-1a'));
    expect(getCurrentArticle(session)).toMatchObject({ phase: 'review', reviewRound: 1, roundTotal: 2, roundCovered: 1 });
    session = finishArticle(toggleUnknown(session, 'sense-2'));
    session = acceptArticle(session, articleFor(selectNextTargets(session, senses, 1), 'review-1b'));
    expect(getCurrentArticle(session)).toMatchObject({ phase: 'review', reviewRound: 1, roundTotal: 2, roundCovered: 2 });
    expect(getPrefetchTargets(session, senses)).toEqual([]);
    session = finishArticle(session, () => 0);
    session = acceptArticle(session, articleFor(selectNextTargets(session, senses), 'review-2'));
    expect(getCurrentArticle(session)).toMatchObject({ phase: 'review', reviewRound: 2, roundTotal: 1, roundCovered: 1 });
    expect(session.articles[0].unknownSenseIds).toEqual(['sense-0']);
  });
});

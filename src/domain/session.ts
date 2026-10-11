import type { Article, LearningSession, Sense } from './types';

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function shuffle(ids: string[], random: () => number): string[] {
  const result = [...ids];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机数必须在 0 至 1 之间。');
    const swapIndex = Math.floor(value * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function createSession(senses: Sense[], random: () => number = Math.random): LearningSession {
  const remainingSenseIds = shuffle(unique(senses.map((sense) => sense.id)), random);
  return {
    id: crypto.randomUUID(),
    phase: remainingSenseIds.length ? 'coverage' : 'complete',
    remainingSenseIds,
    coveredSenseIds: [],
    accumulatedUnknownIds: [],
    reviewSenseIds: [],
    reviewPendingIds: [],
    reviewUnknownIds: [],
    reviewRound: 0,
    currentUnknownIds: [],
    articles: [],
    currentArticleId: null,
    preparedArticle: null,
  };
}

export function getCurrentArticle(session: LearningSession): Article | null {
  return session.articles.find((article) => article.id === session.currentArticleId) ?? null;
}

export function selectNextTargets(session: LearningSession, senses: Sense[], limit = 50): Sense[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('每批义项数量必须为正整数。');
  if (session.phase === 'complete') return [];
  const pendingIds = session.phase === 'coverage' ? session.remainingSenseIds : session.reviewPendingIds;
  const sensesById = new Map(senses.map((sense) => [sense.id, sense]));
  const selected: Sense[] = [];
  const selectedWords = new Set<string>();
  for (const senseId of pendingIds) {
    const sense = sensesById.get(senseId);
    if (!sense) throw new Error(`学习队列中的义项不存在：${senseId}`);
    const normalizedWord = sense.word.toLowerCase().replace(/’/g, "'");
    if (selectedWords.has(normalizedWord)) continue;
    selectedWords.add(normalizedWord);
    selected.push(sense);
    if (selected.length === limit) break;
  }
  return selected;
}

export function getPrefetchTargets(session: LearningSession, senses: Sense[], limit = 50): Sense[] {
  return session.currentArticleId ? selectNextTargets(session, senses, limit) : [];
}

function validateArticle(session: LearningSession, article: Article): string[] {
  if (session.phase === 'complete') throw new Error('学习已完成，请先开始新的学习任务。');
  if (!article.id || session.articles.some((existing) => existing.id === article.id)) throw new Error('文章编号重复或为空。');
  if (!article.body.trim() || !article.targetSenseIds.length) throw new Error('文章或目标义项为空。');
  const targetIds = unique(article.targetSenseIds);
  if (targetIds.length !== article.targetSenseIds.length) throw new Error('文章目标义项重复。');
  const pendingIds = session.phase === 'coverage' ? session.remainingSenseIds : session.reviewPendingIds;
  if (targetIds.some((senseId) => !pendingIds.includes(senseId))) throw new Error('文章包含不属于当前学习队列的目标义项。');
  for (const occurrence of article.occurrences) {
    if (!occurrence.senseId || !Number.isInteger(occurrence.start) || !Number.isInteger(occurrence.end)
      || occurrence.start < 0 || occurrence.end <= occurrence.start || occurrence.end > article.body.length
      || article.body.slice(occurrence.start, occurrence.end) !== occurrence.surface) {
      throw new Error('文章词语注解与原文不匹配。');
    }
  }
  if (targetIds.some((senseId) => !article.occurrences.some((occurrence) => occurrence.senseId === senseId))) {
    throw new Error('文章未覆盖全部目标义项，不能推进学习队列。');
  }
  return targetIds;
}

export function setPreparedArticle(session: LearningSession, article: Article): LearningSession {
  validateArticle(session, article);
  return { ...session, preparedArticle: article };
}

export function acceptArticle(session: LearningSession, article: Article): LearningSession {
  if (session.currentArticleId) throw new Error('请先完成当前文章。');
  const targetIds = validateArticle(session, article);
  const targetSet = new Set(targetIds);
  const roundTotal = session.phase === 'coverage'
    ? session.coveredSenseIds.length + session.remainingSenseIds.length
    : session.reviewSenseIds.length;
  const roundCovered = session.phase === 'coverage'
    ? unique([...session.coveredSenseIds, ...targetIds]).length
    : roundTotal - session.reviewPendingIds.length + targetIds.length;
  const accepted = {
    ...article,
    phase: session.phase as 'coverage' | 'review',
    reviewRound: session.reviewRound,
    roundTotal,
    roundCovered,
    unknownSenseIds: [],
  };
  return {
    ...session,
    remainingSenseIds: session.phase === 'coverage' ? session.remainingSenseIds.filter((senseId) => !targetSet.has(senseId)) : session.remainingSenseIds,
    coveredSenseIds: session.phase === 'coverage' ? unique([...session.coveredSenseIds, ...targetIds]) : session.coveredSenseIds,
    reviewPendingIds: session.phase === 'review' ? session.reviewPendingIds.filter((senseId) => !targetSet.has(senseId)) : session.reviewPendingIds,
    articles: [...session.articles, accepted],
    currentArticleId: article.id,
    currentUnknownIds: [],
    preparedArticle: null,
  };
}

export function toggleUnknown(session: LearningSession, senseId: string): LearningSession {
  const article = getCurrentArticle(session);
  if (!article || !article.occurrences.some((occurrence) => occurrence.senseId === senseId)) {
    throw new Error('只能标记当前文章中已注解的义项。');
  }
  return {
    ...session,
    currentUnknownIds: session.currentUnknownIds.includes(senseId)
      ? session.currentUnknownIds.filter((unknownId) => unknownId !== senseId)
      : [...session.currentUnknownIds, senseId],
  };
}

export function finishArticle(session: LearningSession, random?: () => number): LearningSession {
  const article = getCurrentArticle(session);
  if (!article) return session;
  const finished = {
    ...session,
    articles: session.articles.map((existing) => existing.id === article.id
      ? { ...existing, unknownSenseIds: [...session.currentUnknownIds], finishedAt: new Date().toISOString() }
      : existing),
    currentArticleId: null,
    currentUnknownIds: [],
  };
  if (session.phase === 'coverage') {
    const accumulatedUnknownIds = unique([...session.accumulatedUnknownIds, ...session.currentUnknownIds]);
    if (session.remainingSenseIds.length) return { ...finished, accumulatedUnknownIds };
    return {
      ...finished,
      accumulatedUnknownIds,
      phase: accumulatedUnknownIds.length ? 'review' : 'complete',
      reviewSenseIds: accumulatedUnknownIds,
      reviewPendingIds: random ? shuffle(accumulatedUnknownIds, random) : accumulatedUnknownIds,
      reviewUnknownIds: [],
      reviewRound: accumulatedUnknownIds.length ? 1 : 0,
      preparedArticle: null,
    };
  }
  if (session.phase === 'review') {
    const reviewUnknownIds = unique([...session.reviewUnknownIds, ...session.currentUnknownIds]);
    if (session.reviewPendingIds.length) return { ...finished, reviewUnknownIds };
    return {
      ...finished,
      phase: reviewUnknownIds.length ? 'review' : 'complete',
      reviewSenseIds: reviewUnknownIds,
      reviewPendingIds: random ? shuffle(reviewUnknownIds, random) : reviewUnknownIds,
      reviewUnknownIds: [],
      reviewRound: reviewUnknownIds.length ? session.reviewRound + 1 : session.reviewRound,
      preparedArticle: null,
    };
  }
  return finished;
}

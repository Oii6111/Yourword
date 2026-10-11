import type { Article } from './types';

export interface ReadingToken {
  text: string;
  start: number;
  end: number;
  kind: 'text' | 'word' | 'target';
  senseId?: string;
}

export function tokenizeArticle(article: Article): ReadingToken[] {
  const tokens: ReadingToken[] = [];
  const targetSenseIds = new Set(article.targetSenseIds);
  const appendText = (start: number, end: number) => {
    const text = article.body.slice(start, end);
    const words = /[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*/g;
    let cursor = start;
    for (const match of text.matchAll(words)) {
      const wordStart = start + match.index;
      if (wordStart > cursor) {
        tokens.push({ text: article.body.slice(cursor, wordStart), start: cursor, end: wordStart, kind: 'text' });
      }
      const wordEnd = wordStart + match[0].length;
      tokens.push({ text: match[0], start: wordStart, end: wordEnd, kind: 'word' });
      cursor = wordEnd;
    }
    if (cursor < end) {
      tokens.push({ text: article.body.slice(cursor, end), start: cursor, end, kind: 'text' });
    }
  };

  let cursor = 0;
  const occurrences = [...article.occurrences].sort((first, second) => first.start - second.start);
  for (const occurrence of occurrences) {
    if (!Number.isInteger(occurrence.start) || !Number.isInteger(occurrence.end)
      || occurrence.start < cursor || occurrence.end <= occurrence.start
      || occurrence.end > article.body.length
      || article.body.slice(occurrence.start, occurrence.end) !== occurrence.surface) {
      continue;
    }
    appendText(cursor, occurrence.start);
    tokens.push({
      text: occurrence.surface,
      start: occurrence.start,
      end: occurrence.end,
      kind: targetSenseIds.has(occurrence.senseId) ? 'target' : 'word',
      senseId: occurrence.senseId,
    });
    cursor = occurrence.end;
  }
  appendText(cursor, article.body.length);
  return tokens;
}

export function contextForToken(body: string, start: number, end: number): string {
  const boundaries = [0];
  for (const match of body.matchAll(/[.!?](?:["'”’])?(?=\s|$)|\n\s*\n/g)) {
    boundaries.push(match.index + match[0].length);
  }
  if (boundaries[boundaries.length - 1] !== body.length) boundaries.push(body.length);
  const sentenceIndex = Math.max(0, boundaries.findIndex((boundary) => boundary > start) - 1);
  const contextStart = Math.max(boundaries[Math.max(0, sentenceIndex - 1)], start - 400);
  const contextEnd = Math.min(boundaries[Math.min(boundaries.length - 1, sentenceIndex + 2)], end + 400);
  return body.slice(contextStart, contextEnd).trim();
}

import type { Sense } from './types';

export interface ScreeningWord {
  id: string;
  word: string;
  senses: Sense[];
}

export function groupScreeningWords(senses: Sense[]): ScreeningWord[] {
  const words = new Map<string, ScreeningWord>();
  const includedSenseIds = new Set<string>();
  for (const sense of senses) {
    if (sense.origin !== 'import' || includedSenseIds.has(sense.id)) continue;
    includedSenseIds.add(sense.id);
    const wordId = sense.word.trim().toLowerCase().replace(/[‘’]/g, "'");
    const existingWord = words.get(wordId);
    if (existingWord) existingWord.senses.push(sense);
    else words.set(wordId, { id: wordId, word: sense.word, senses: [sense] });
  }
  return [...words.values()];
}

export function expandScreeningSenseIds(senses: Sense[], selectedSenseIds: string[]): string[] {
  const selectedIds = new Set(selectedSenseIds);
  const includedIds = new Set(
    groupScreeningWords(senses)
      .filter((word) => word.senses.some((sense) => selectedIds.has(sense.id)))
      .flatMap((word) => word.senses.map((sense) => sense.id)),
  );
  const expandedIds: string[] = [];
  for (const sense of senses) {
    if (sense.origin !== 'import' || !includedIds.delete(sense.id)) continue;
    expandedIds.push(sense.id);
  }
  return expandedIds;
}

export function applyScreeningPageSelection(
  senses: Sense[],
  currentUnknownSenseIds: string[],
  pageWordIds: string[],
  selectedWordIds: string[],
  mode: 'unknown' | 'known',
): string[] {
  const unknownSenseIds = new Set(currentUnknownSenseIds);
  const pageIds = new Set(pageWordIds);
  const selectedIds = new Set(selectedWordIds);
  for (const word of groupScreeningWords(senses)) {
    if (!pageIds.has(word.id)) continue;
    const isUnknown = mode === 'unknown' ? selectedIds.has(word.id) : !selectedIds.has(word.id);
    for (const sense of word.senses) {
      if (isUnknown) unknownSenseIds.add(sense.id);
      else unknownSenseIds.delete(sense.id);
    }
  }
  return expandScreeningSenseIds(senses, [...unknownSenseIds]);
}

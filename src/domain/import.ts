import type { ParsedVocabulary, Sense } from './types';

const partOfSpeechPattern = /\b(n|vt|vi|v|adj|adv|pron|prep|conj|interj|int|art|num|det|aux|modal|phr|abbr)\./gi;
const wordPattern = /^[a-z]+(?:['’\-][a-z]+)*['’]?(?:\s+[a-z]+(?:['’\-][a-z]+)*['’]?)*$/i;

export function decodeVocabulary(
  buffer: ArrayBuffer,
  encoding: 'auto' | 'utf-8' | 'gb18030' = 'auto',
): string {
  if (encoding !== 'auto') {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  }
}

function splitPartOfSpeech(meaning: string): { partOfSpeech: string; meaning: string }[] {
  const matches = [...meaning.matchAll(partOfSpeechPattern)];
  if (matches.length === 0) return [{ partOfSpeech: '', meaning }];

  const groups: { partOfSpeech: string; meaning: string }[] = [];
  const prefix = meaning.slice(0, matches[0].index).trim().replace(/[;；]+$/, '').trim();
  if (prefix) groups.push({ partOfSpeech: '', meaning: prefix });

  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? meaning.length;
    groups.push({
      partOfSpeech: `${match[1].toLowerCase()}.`,
      meaning: meaning.slice(start, end).trim().replace(/[;；]+$/, '').trim(),
    });
  });
  return groups;
}

export function parseVocabulary(text: string): ParsedVocabulary {
  const result: ParsedVocabulary = { senses: [], issues: [], duplicateCount: 0 };
  const knownEntries = new Set<string>();

  text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).forEach((sourceText, index) => {
    if (!sourceText.trim()) return;
    const sourceLine = index + 1;
    const separatorIndex = sourceText.indexOf('\t');
    if (separatorIndex < 0) {
      result.issues.push({ line: sourceLine, text: sourceText, message: '缺少 Tab 分隔符，应为“英文词或短语<Tab>中文释义”。' });
      return;
    }

    const word = sourceText.slice(0, separatorIndex).trim().replace(/\s+/g, ' ');
    const meaning = sourceText.slice(separatorIndex + 1).trim().replace(/\t+/g, ' ');
    if (!wordPattern.test(word)) {
      result.issues.push({ line: sourceLine, text: sourceText, message: '英文词或短语格式无效。' });
      return;
    }
    if (!meaning) {
      result.issues.push({ line: sourceLine, text: sourceText, message: '缺少中文释义。' });
      return;
    }

    const groups = splitPartOfSpeech(meaning);
    if (groups.some((group) => !group.meaning)) {
      result.issues.push({ line: sourceLine, text: sourceText, message: '词性标记后缺少释义，请检查该行。' });
      return;
    }

    groups.forEach((group, groupIndex) => {
      const key = JSON.stringify([word.toLowerCase().replace(/’/g, "'"), group.partOfSpeech, group.meaning.replace(/\s+/g, ' ')]);
      if (knownEntries.has(key)) {
        result.duplicateCount += 1;
        return;
      }
      knownEntries.add(key);
      const sense: Sense = {
        id: `import-${sourceLine}-${groupIndex + 1}`,
        word,
        partOfSpeech: group.partOfSpeech,
        meaning: group.meaning,
        sourceLine,
        sourceText,
        origin: 'import',
      };
      result.senses.push(sense);
    });
  });
  return result;
}

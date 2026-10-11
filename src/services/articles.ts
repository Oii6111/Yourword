import type { ApiSettings, Article, ArticleOccurrence, ChatMessage, ProgressReporter, ReadingOptions, Sense } from '../domain/types';
import { ApiError, chatJson } from './client';

const writingInstructions = [
  '你是英文阅读材料作者。先在内部分析所有目标词的指定词义及词性，按自然语义关系、常见搭配和适合的场景分组，再决定需要多少段内容及每段长度，不要输出规划或推理。',
  '写作优先级：逻辑自洽、自然易懂与准确词义优先，然后完整覆盖全部目标词义，再考虑篇幅参考。不要为了覆盖词表强行把无关词放进同一个故事。',
  '如果一组词适合共同场景，尽量把它们组成较长且连贯的段落或短文，让读者能理解背景、人物动机、事件发展和结果；适当补充必要细节与过渡，不要只拼接孤立句子。没有自然联系的词应另写独立短文、段落或完整句组。难以组段的词可以单独造自然的完整句子。',
  '不同片段可以有各自的主题，无须串联成统一故事，也没有固定片段数量。每个独立片段须自行交代场景和人物，不能依赖上一片段才能理解。片段之间用两个换行分隔；需要时可加简短英文小标题。',
  '段内人物、地点、时间和指代必须清楚一致，事件须有合理因果和自然过渡，不要突然引入无关人物或情节，不要靠奇怪比喻或牵强转折把词硬连起来。输出前内部检查段内逻辑及全部词义覆盖，有牵强拼接就重新分组。',
  '每个指定词义必须至少出现一次，语境须表达该含义；同词不同义分别安排清楚的语境。优先用给定词原形，避免不规则变形，可以使用其他普通英文词汇。目标词每次出现都要注解，且只能以给定义项出现。',
  'expectedWordCount 只是预期长度参考，没有最小或最大词数限制。为使语境充分、连贯，可以写得更长；不要刻意压缩成难懂短句，也不要为了凑长度填充重复内容。实际篇幅和片段数量由词义组合及逻辑需要决定。',
  '不要列词表、添加中文释义或声称覆盖。仅输出有效 JSON：{"title":"整组阅读材料的英文标题","body":"英文短文、段落或句组，各独立片段用两个换行分隔","annotations":[{"senseId":"目标 ID","surface":"原文精确词形（大小写一致）","quote":"包含该位置的原文完整句子或片段","occurrence":1}]}。occurrence 是这个精确 surface 在整个 body 中按单词边界从左到右出现的 1-based 序号，不是它在 quote 或单独片段中的序号。不允许重叠注解。',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ').trim();
}

function formsOf(word: string): Set<string> {
  const canonical = normalized(word);
  const forms = new Set([canonical]);
  if (!/^[a-z]+$/.test(canonical)) return forms;
  forms.add(`${canonical}s`);
  forms.add(`${canonical}ed`);
  forms.add(`${canonical}ing`);
  if (/(s|x|z|ch|sh|o)$/.test(canonical)) forms.add(`${canonical}es`);
  if (/[^aeiou]y$/.test(canonical)) {
    forms.add(`${canonical.slice(0, -1)}ies`);
    forms.add(`${canonical.slice(0, -1)}ied`);
  }
  if (canonical.endsWith('e')) {
    forms.add(`${canonical}d`);
    forms.add(`${canonical.slice(0, -1)}ing`);
  }
  if (canonical.endsWith('ie')) forms.add(`${canonical.slice(0, -2)}ying`);
  return forms;
}

function isBoundary(body: string, start: number, end: number): boolean {
  const wordCharacter = /[a-zA-Z’'\-]/;
  return (start === 0 || !wordCharacter.test(body[start - 1]))
    && (end === body.length || !wordCharacter.test(body[end]));
}

function findOccurrences(body: string, surface: string, ignoreCase = false): number[] {
  const searchableBody = ignoreCase ? body.toLowerCase() : body;
  const searchableSurface = ignoreCase ? surface.toLowerCase() : surface;
  const positions: number[] = [];
  let position = searchableBody.indexOf(searchableSurface);
  while (position !== -1) {
    if (isBoundary(body, position, position + surface.length)) positions.push(position);
    position = searchableBody.indexOf(searchableSurface, position + Math.max(1, surface.length));
  }
  return positions;
}

function containsQuote(body: string, quote: string, start: number, end: number): boolean {
  let quoteStart = body.indexOf(quote);
  while (quoteStart !== -1) {
    if (quoteStart <= start && quoteStart + quote.length >= end) return true;
    quoteStart = body.indexOf(quote, quoteStart + 1);
  }
  return false;
}

function invalid(message: string): never {
  throw new ApiError('format', `文章校验未通过：${message}`);
}

function validateArticle(value: unknown, targets: Sense[], theme: string, targetWordCount: number): Article {
  if (!isRecord(value) || typeof value.body !== 'string' || !value.body.trim()
    || typeof value.title !== 'string' || !value.title.trim() || !Array.isArray(value.annotations)) {
    return invalid('响应需包含 title、body 和 annotations。');
  }
  const body = value.body;
  const wordCount = body.match(/[a-zA-Z]+(?:[’'\-][a-zA-Z]+)*/g)?.length ?? 0;
  const targetById = new Map(targets.map(sense => [sense.id, sense]));
  const occurrences: ArticleOccurrence[] = [];
  for (const annotation of value.annotations) {
    if (!isRecord(annotation) || typeof annotation.senseId !== 'string' || !targetById.has(annotation.senseId)
      || typeof annotation.surface !== 'string' || !annotation.surface.trim()
      || annotation.surface.trim() !== annotation.surface || typeof annotation.quote !== 'string' || !annotation.quote.trim()
      || !Number.isInteger(annotation.occurrence) || (annotation.occurrence as number) < 1) {
      return invalid('注解包含未知 ID、空片段或无效出现序号。');
    }
    const sense = targetById.get(annotation.senseId)!;
    if (!formsOf(sense.word).has(normalized(annotation.surface))) {
      return invalid(`“${annotation.surface}”与目标词“${sense.word}”的词形不匹配；请优先使用原形。`);
    }
    const positions = findOccurrences(body, annotation.surface);
    const start = positions[(annotation.occurrence as number) - 1];
    if (start === undefined) return invalid(`无法定位“${annotation.surface}”的第 ${annotation.occurrence} 次出现。`);
    const end = start + annotation.surface.length;
    if (!containsQuote(body, annotation.quote, start, end)) {
      return invalid(`“${annotation.surface}”的 quote 不是包含该位置的原文片段。`);
    }
    if (occurrences.some(occurrence => start < occurrence.end && end > occurrence.start)) {
      return invalid('注解出现位置重复或重叠。');
    }
    occurrences.push({ senseId: annotation.senseId, start, end, surface: annotation.surface });
  }
  for (const sense of targets) {
    if (!occurrences.some(occurrence => occurrence.senseId === sense.id)) {
      return invalid(`遗漏目标义项“${sense.word}：${sense.meaning}”（${sense.id}）。`);
    }
    for (const form of formsOf(sense.word)) {
      for (const start of findOccurrences(body, form, true)) {
        const end = start + form.length;
        const hasAnnotation = occurrences.some(occurrence => occurrence.start === start && occurrence.end === end
          && normalized(targetById.get(occurrence.senseId)!.word) === normalized(sense.word));
        const belongsToPhrase = occurrences.some(occurrence => occurrence.start <= start && occurrence.end >= end
          && occurrence.end - occurrence.start > form.length
          && /\s/.test(targetById.get(occurrence.senseId)!.word));
        if (!hasAnnotation && !belongsToPhrase) {
          return invalid(`目标词“${sense.word}”有未注解的出现位置 ${start}，每次出现都需绑定当前词义。`);
        }
      }
    }
  }
  return {
    id: crypto.randomUUID(),
    title: value.title.trim(),
    body,
    theme,
    targetSenseIds: targets.map(sense => sense.id),
    occurrences: occurrences.sort((left, right) => left.start - right.start),
    wordCount,
    targetWordCount,
    createdAt: new Date().toISOString(),
  };
}

async function verifyMeanings(article: Article, targets: Sense[], settings: ApiSettings, signal?: AbortSignal, repaired = false): Promise<string[]> {
  const targetById = new Map(targets.map(sense => [sense.id, sense]));
  const result = await chatJson<unknown>(settings, [
    {
      role: 'system',
      content: '你是独立英文词义审核员，为词汇学习检查语境，不做苛刻的文学或写作评分。根据全文判断每个注解是否使用指定中文义项及词性，接受同义表达、合理引申和正常语法变化，不要求英文逐字对应中文解释。每个词义至少有一处正确使用即可证明覆盖；其他表达轻微生硬、信息不够明确或你无法确定时，只给 warning，不判错误。status 分三类：correct 表示语境与指定词义相符；warning 表示基本合理但轻微生硬、含糊或无法确定，需提醒用户查看；incorrect 仅用于明确使用其他词义、词性明显错误或含义与目标矛盾。不要仅因为不够自然、缺少更多细节或拿不准就标 incorrect。不能只确认拼写出现或采用作者的自述。每个 annotationIndex 必须恰好出现一次。仅输出 JSON：{"checks":[{"annotationIndex":0,"senseId":"原 ID","status":"correct","reason":"简短理由"}]}。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        readingStructure: 'body 可以包含多篇独立短文、段落或句组。不同片段各自成立，不要求主题相同或跨片段情节衔接；只在当前片段语境中审核指定词义。',
        body: article.body,
        annotations: article.occurrences.map((occurrence, annotationIndex) => ({
          annotationIndex,
          ...occurrence,
          word: targetById.get(occurrence.senseId)!.word,
          partOfSpeech: targetById.get(occurrence.senseId)!.partOfSpeech,
          meaning: targetById.get(occurrence.senseId)!.meaning,
          context: `${article.body.slice(Math.max(0, occurrence.start - 200), occurrence.start)}⟦${article.body.slice(occurrence.start, occurrence.end)}⟧${article.body.slice(occurrence.end, occurrence.end + 200)}`,
        })),
      }),
    },
  ], signal, { operation: repaired ? '修复后词义验证' : '词义验证', targetCount: targets.length, targetWordCount: article.targetWordCount });
  if (!isRecord(result) || !Array.isArray(result.checks)) return invalid('词义审核缺少 checks。');
  const checked = new Set<number>();
  const warnings: string[] = [];
  const covered = new Set<string>();
  const incorrect: string[] = [];
  for (const check of result.checks) {
    if (!isRecord(check) || !Number.isInteger(check.annotationIndex)) return invalid('词义审核含无效注解序号。');
    const annotationIndex = check.annotationIndex as number;
    const occurrence = article.occurrences[annotationIndex];
    if (!occurrence || check.senseId !== occurrence.senseId || checked.has(annotationIndex)) return invalid('词义审核包含未知、重复或不匹配的注解。');
    checked.add(annotationIndex);
    const status = check.status ?? (check.correct === true ? 'correct' : check.correct === false ? 'incorrect' : undefined);
    if (!['correct', 'warning', 'incorrect'].includes(status as string)) return invalid('词义审核含无效判定状态。');
    const sense = targetById.get(occurrence.senseId)!;
    const detail = `“${sense.word}：${sense.meaning}”${typeof check.reason === 'string' && check.reason.trim() ? '：' + check.reason.trim() : ''}`;
    if (status === 'incorrect') incorrect.push(detail);
    else {
      covered.add(occurrence.senseId);
      if (status === 'warning') warnings.push(detail);
    }
  }
  if (checked.size !== article.occurrences.length) return invalid('词义审核遗漏了注解。');
  if (incorrect.length) return invalid('语境不正确：' + incorrect.join('；'));
  if (targets.some(sense => !covered.has(sense.id))) return invalid('词义审核遗漏了目标词义。');
  return [...new Set(warnings)];
}

export async function generateArticle(
  targets: Sense[],
  settings: ApiSettings,
  signal?: AbortSignal,
  onProgress?: ProgressReporter,
  options?: ReadingOptions,
): Promise<Article> {
  if (targets.length === 0 || targets.length > 50 || new Set(targets.map(sense => sense.id)).size !== targets.length
    || targets.some(sense => !sense.id.trim() || !sense.word.trim() || !sense.meaning.trim())) {
    throw new ApiError('config', '每篇文章需要 1–50 个不同的目标词义。');
  }
  if (options && (!Number.isInteger(options.targetCount) || options.targetCount < 1 || options.targetCount > 50
    || !Number.isSafeInteger(options.expectedWordCount) || options.expectedWordCount < 1)) {
    throw new ApiError('config', '每篇覆盖词义数量需为 1–50，预期长度需为正整数。');
  }
  const targetWordCount = options?.expectedWordCount ?? Math.min(1000, Math.max(100, 20 * targets.length));
  const theme = '自主分组语境';
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: writingInstructions,
    },
    {
      role: 'user',
      content: JSON.stringify({
        expectedWordCount: targetWordCount,
        targets: targets.map(sense => ({ senseId: sense.id, word: sense.word, partOfSpeech: sense.partOfSpeech, meaning: sense.meaning })),
      }),
    },
  ];
  let candidate: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      onProgress?.(attempt === 0 ? '正在创作文章…' : '正在修复文章与词义覆盖…');
      candidate = await chatJson<unknown>(settings, messages, signal, {
        operation: attempt === 0 ? '文章创作' : '文章修复', targetCount: targets.length, targetWordCount,
      });
      const article = validateArticle(candidate, targets, theme, targetWordCount);
      onProgress?.('正在独立验证每个词义的语境…');
      const verificationWarnings = await verifyMeanings(article, targets, settings, signal, attempt > 0);
      return { ...article, verificationWarnings };
    } catch (error) {
      if (!(error instanceof ApiError) || error.kind !== 'format') throw error;
      if (attempt === 1) throw new ApiError('format', `${error.message} 已尝试修复一次；请重试，原文章、队列和标记保持不变。`);
      if (candidate !== undefined) messages.push({ role: 'assistant', content: JSON.stringify(candidate) });
      messages.push({
        role: 'user',
        content: `校验失败：${error.message}\n请修复并重新输出完整阅读材料 JSON，保留全部指定词义并准确标注。优先保证每个片段逻辑自洽、自然易懂；可以重新按语义分组，写多段独立短文或句组，不必把无关词硬塞进同一故事。相关词尽量组成较长的连贯段落，必要时补充场景与因果细节，不要只追求最少词数。预期长度仅供参考，片段间用两个换行分隔，occurrence 仍按整个 body 计数。`,
      });
      candidate = undefined;
    }
  }
  throw new ApiError('format', '文章生成失败，请重试。');
}

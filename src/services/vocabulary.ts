import type { ApiSettings, ProgressReporter, RefinementCheckpoint, RefinementEntry, Sense } from '../domain/types';
import { ApiError, chatJson } from './client';

const batchSize = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function definitionText(value: string): string {
  return value.normalize('NFKC').replace(/[\p{P}\s]/gu, '');
}

interface BatchResult {
  valid: Map<string, string[]>;
  problems: Map<string, string>;
}

function validateBatch(value: unknown, sources: Sense[]): BatchResult {
  const valid = new Map<string, string[]>();
  const problems = new Map<string, string>();
  const byId = new Map(sources.map(source => [source.id, source]));
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { valid, problems: new Map(sources.map(source => [source.id, '模型响应缺少 items 数组。'])) };
  }
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.sourceId !== 'string' || !byId.has(item.sourceId)) continue;
    const source = byId.get(item.sourceId)!;
    if (seen.has(source.id)) {
      valid.delete(source.id);
      problems.set(source.id, '模型重复返回了同一个词条。');
      continue;
    }
    seen.add(source.id);
    if (!Array.isArray(item.meanings) || !item.meanings.length || item.meanings.some(meaning => typeof meaning !== 'string' || !meaning.trim())) {
      problems.set(source.id, '模型返回了空的词义。');
      continue;
    }
    const meanings = (item.meanings as string[]).map(meaning => meaning.trim());
    if (meanings.map(definitionText).join('') !== definitionText(source.meaning)) {
      problems.set(source.id, '模型改写、遗漏或新增了原释义，已保留原文，请检查并手动拆分。');
      continue;
    }
    valid.set(source.id, meanings);
  }
  for (const source of sources) {
    if (!valid.has(source.id) && !problems.has(source.id)) problems.set(source.id, '模型遗漏了这个词条。');
  }
  return { valid, problems };
}

const refinementPrompt = '你是英文词库编辑。每条输入已经按单词及词性分开。仅使用输入的中文释义，将真正不同的含义拆成独立义项，将同一含义的近义解释合并；不能补充词典里的其他含义，不能改变词性。比如 bank 的“银行；岸”拆成两义，“造反，起义”可以合为一义。必须保留所有原文字词和先后顺序，只能拆分或合并原有释义片段，不能改写、删减、摘要或添加解释；可以整理分隔标点。重复的原文解释也必须保留。按原文顺序返回义项。仅输出 JSON：{"items":[{"sourceId":"输入 ID","meanings":["中文独立义项"]}]}。每条输入必须恰好返回一项，不得新增 sourceId。';

async function requestBatch(sources: Sense[], settings: ApiSettings, signal?: AbortSignal, repair?: Map<string, string>): Promise<BatchResult> {
  try {
    const result = await chatJson<unknown>(settings, [
      { role: 'system', content: refinementPrompt + (repair ? ' 上次有词条未通过校验，这是针对这些词条的一次修复，请按提供的错误原因重新处理。' : '') },
      { role: 'user', content: JSON.stringify(sources.map(source => ({ sourceId: source.id, word: source.word, partOfSpeech: source.partOfSpeech, meaning: source.meaning, ...(repair ? { previousError: repair.get(source.id) } : {}) }))) },
    ], signal, { operation: repair ? '词义拆分重试' : '词义拆分', targetCount: sources.length });
    return validateBatch(result, sources);
  } catch (error) {
    if (!(error instanceof ApiError) || error.kind !== 'format') throw error;
    return { valid: new Map(), problems: new Map(sources.map(source => [source.id, error.message])) };
  }
}

export interface RefinementOptions {
  checkpoint?: RefinementCheckpoint | null;
  onCheckpoint?: (checkpoint: RefinementCheckpoint) => void | Promise<void>;
}

export function refinementPreview(checkpoint: RefinementCheckpoint): Sense[] {
  const entries = new Map(checkpoint.entries.map(entry => [entry.sourceId, entry]));
  return checkpoint.sources.flatMap(source => entries.get(source.id)?.senses ?? [source]);
}

export async function refineSenses(
  senses: Sense[],
  settings: ApiSettings,
  signal?: AbortSignal,
  onProgress?: ProgressReporter,
  options: RefinementOptions = {},
): Promise<Sense[]> {
  const sourceSnapshot = JSON.stringify(senses);
  if (new Set(senses.map(source => source.id)).size !== senses.length) throw new ApiError('config', '词库含重复词条编号，请重新导入。');
  if (options.checkpoint && JSON.stringify(options.checkpoint.sources) !== sourceSnapshot) throw new ApiError('config', '整理进度与当前词库不匹配，请重新导入。');
  const sources = structuredClone(senses);
  const entries = new Map<string, RefinementEntry>();
  for (const entry of options.checkpoint?.entries ?? []) {
    if (!sources.some(source => source.id === entry.sourceId) || entries.has(entry.sourceId) || !entry.senses.length) throw new ApiError('config', '整理进度格式无效，请重新导入。');
    entries.set(entry.sourceId, structuredClone(entry));
  }
  const checkCancellation = () => {
    if (signal?.aborted) throw new ApiError('cancelled', '已暂停词义整理，完成的进度已保留，可继续拆分剩余词条。');
  };
  const saveCheckpoint = async () => {
    await options.onCheckpoint?.({ sources, entries: sources.flatMap(source => entries.has(source.id) ? [entries.get(source.id)!] : []) });
  };
  const storeValid = (batch: Sense[], result: BatchResult) => {
    for (const source of batch) {
      const meanings = result.valid.get(source.id);
      if (meanings) entries.set(source.id, { sourceId: source.id, senses: meanings.map(meaning => ({ ...source, id: crypto.randomUUID(), meaning })) });
    }
  };
  checkCancellation();
  await saveCheckpoint();
  const pending = sources.filter(source => !entries.has(source.id));
  const totalBatches = Math.ceil(sources.length / batchSize);
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    checkCancellation();
    const batch = pending.slice(offset, offset + batchSize);
    onProgress?.(`整理词义 ${Math.min(totalBatches, Math.floor(entries.size / batchSize) + 1)} / ${totalBatches} 批 · 已处理 ${entries.size} / ${sources.length} 条…`);
    const first = await requestBatch(batch, settings, signal);
    checkCancellation();
    storeValid(batch, first);
    await saveCheckpoint();
    const failed = batch.filter(source => first.problems.has(source.id));
    if (failed.length) {
      onProgress?.(`重试 ${failed.length} 个问题词条 · 已处理 ${entries.size} / ${sources.length} 条…`);
      const repair = await requestBatch(failed, settings, signal, first.problems);
      checkCancellation();
      storeValid(failed, repair);
      for (const source of failed) {
        if (!repair.valid.has(source.id)) entries.set(source.id, {
          sourceId: source.id,
          senses: [{ ...source }],
          issue: repair.problems.get(source.id) ?? first.problems.get(source.id),
        });
      }
      await saveCheckpoint();
    }
  }
  checkCancellation();
  return refinementPreview({ sources, entries: [...entries.values()] });
}
export async function lookupSense(
  word: string,
  context: string,
  settings: ApiSettings,
  signal?: AbortSignal,
): Promise<Sense> {
  if (!word.trim() || !context.trim()) throw new ApiError('config', '查义需要单词和所在上下文。');
  const result = await chatJson<unknown>(settings, [
    {
      role: 'system',
      content: '你是英文阅读教师。解释用户点击的单词在给定上下文中使用的唯一义项，以简洁中文释义回答，并返回该义项的英文词典原形和词性。不列出其他含义，不按单词拼写关联其他词义；若上下文不充分，不要猜测，返回 {"error":"原因"}。只输出 JSON：{"word":"英文原形","partOfSpeech":"如 n. / v. / adj.","meaning":"当前语境的中文释义"}。',
    },
    { role: 'user', content: JSON.stringify({ word: word.trim(), context }) },
  ], signal, { operation: '语境查义', targetCount: 1 });
  if (!isRecord(result) || typeof result.word !== 'string' || !result.word.trim()
    || typeof result.partOfSpeech !== 'string' || !result.partOfSpeech.trim()
    || typeof result.meaning !== 'string' || !result.meaning.trim()) {
    throw new ApiError('format', '无法确认这个词在当前语境中的词义，请重试。');
  }
  if (!/^[a-zA-Z]+(?:[ ’'\-][a-zA-Z]+)*$/.test(result.word.trim())) {
    throw new ApiError('format', '模型返回的英文原形无效，请重试。');
  }
  return {
    id: crypto.randomUUID(),
    word: result.word.trim().toLowerCase(),
    partOfSpeech: result.partOfSpeech.trim(),
    meaning: result.meaning.trim(),
    sourceLine: 0,
    sourceText: context,
    origin: 'lookup',
  };
}

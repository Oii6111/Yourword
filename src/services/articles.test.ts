import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSettings, Sense } from '../domain/types';
import { generateArticle } from './articles';
import { clearRequestLogs, getRequestLogs } from './requestLogs';

const settings: ApiSettings = { baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'test-model' };
const bank: Sense = { id: 'bank-river', word: 'bank', partOfSpeech: 'n.', meaning: '岸', sourceLine: 1, sourceText: 'bank\tn. 岸', origin: 'import' };
const filler = 'We walked slowly and enjoyed the peaceful afternoon. '.repeat(10);

function candidate(sentence = 'The bank beside the river was muddy.', annotations?: unknown[]) {
  return {
    title: 'A quiet afternoon',
    body: `${sentence} ${filler}`,
    annotations: annotations ?? [{ senseId: bank.id, surface: 'bank', quote: sentence, occurrence: 1 }],
  };
}

function completion(value: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
}

function checks(correct = true, senseId = bank.id) {
  return { checks: [{ annotationIndex: 0, senseId, correct, reason: correct ? '明确表示河岸' : '这里表示金融机构' }] };
}

beforeEach(() => {
  clearRequestLogs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('generateArticle', () => {
  it('checks coverage locally and independently verifies the annotated meaning', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(candidate())).mockResolvedValueOnce(completion(checks()));
    const progress = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const article = await generateArticle([bank], settings, undefined, progress);
    expect(article.targetSenseIds).toEqual([bank.id]);
    expect(article.occurrences).toEqual([{ senseId: bank.id, start: 4, end: 8, surface: 'bank' }]);
    expect(article.body.slice(article.occurrences[0].start, article.occurrences[0].end)).toBe('bank');
    expect(article.wordCount).toBe(87);
    expect(article.targetWordCount).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(getRequestLogs()).toHaveLength(2);
    expect(getRequestLogs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: '文章创作', targetCount: 1, targetWordCount: 100, state: 'success' }),
      expect.objectContaining({ operation: '词义验证', targetCount: 1, targetWordCount: 100, state: 'success' }),
    ]));
    const verification = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(JSON.parse(verification.messages[1].content).annotations[0]).toMatchObject({ senseId: bank.id, meaning: '岸', context: expect.stringContaining('⟦bank⟧') });
  });

  it.each([
    { name: 'a short article with the default expectation', expectedWordCount: undefined, fillerWords: 0 },
    { name: 'a short article below an explicit expectation', expectedWordCount: 500, fillerWords: 0 },
    { name: 'an article above an explicit expectation', expectedWordCount: 10, fillerWords: 80 },
    { name: 'an article longer than the former 1000 word cap', expectedWordCount: 100, fillerWords: 1200 },
    { name: 'an expectation above the former 2000 word input limit', expectedWordCount: 3000, fillerWords: 0 },
  ])('accepts $name without repairing length', async ({ expectedWordCount, fillerWords }) => {
    const sentence = 'The bank beside the river was muddy.';
    const body = `${sentence} ${'quiet '.repeat(fillerWords)}`.trim();
    const articleCandidate = {
      title: 'A quiet afternoon',
      body,
      annotations: [{ senseId: bank.id, surface: 'bank', quote: sentence, occurrence: 1 }],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(articleCandidate)).mockResolvedValueOnce(completion(checks()));
    vi.stubGlobal('fetch', fetchMock);
    const options = expectedWordCount === undefined ? undefined : { targetCount: 1, expectedWordCount };
    const article = await generateArticle([bank], settings, undefined, undefined, options);
    expect(article.targetWordCount).toBe(expectedWordCount ?? 100);
    expect(article.wordCount).toBe(7 + fillerWords);
    expect(article.body).toBe(body);
    expect(article.targetSenseIds).toEqual([bank.id]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getRequestLogs().map(log => log.operation)).toEqual(expect.arrayContaining(['文章创作', '词义验证']));
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    const prompt = JSON.parse(request.messages[1].content);
    expect(prompt).toMatchObject({ expectedWordCount: expectedWordCount ?? 100 });
    expect(prompt).not.toHaveProperty('targetWordCount');
    expect(prompt).not.toHaveProperty('minimumWordCount');
    expect(prompt).not.toHaveProperty('maximumWordCount');
    expect(request.messages[0].content).toContain('逻辑自洽、自然易懂');
    expect(request.messages[0].content).toContain('先在内部分析');
    expect(request.messages[0].content).toContain('没有固定片段数量');
    expect(request.messages[0].content).not.toContain('尽可能用最少的英文总词数');
    expect(prompt).not.toHaveProperty('theme');
    expect(request.messages[0].content).toContain('只是预期长度参考');
  });

  it.each([
    { targetCount: 0, expectedWordCount: 120 },
    { targetCount: 51, expectedWordCount: 120 },
    { targetCount: 1, expectedWordCount: 0 },
    { targetCount: 1, expectedWordCount: -1 },
    { targetCount: 1, expectedWordCount: 1.5 },
    { targetCount: 1, expectedWordCount: Infinity },
    { targetCount: 1, expectedWordCount: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects reading options with an invalid count or expectation %#', async options => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateArticle([bank], settings, undefined, undefined, options))
      .rejects.toMatchObject({ kind: 'config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('repairs missing coverage once, without accepting the first article', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion(candidate(undefined, [])))
      .mockResolvedValueOnce(completion(candidate()))
      .mockResolvedValueOnce(completion(checks()));
    vi.stubGlobal('fetch', fetchMock);
    const source = structuredClone(bank);
    await expect(generateArticle([bank], settings)).resolves.toMatchObject({ targetSenseIds: [bank.id] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bank).toEqual(source);
    const repairRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(repairRequest.messages.at(-1).content).toContain('遗漏目标义项');
    expect(repairRequest.messages.at(-1).content).toContain('逻辑自洽、自然易懂');
    expect(repairRequest.messages.at(-1).content).toContain('多段独立短文或句组');
    expect(repairRequest.messages.at(-1).content).not.toContain('满足篇幅');
    expect(JSON.parse(repairRequest.messages.at(-2).content)).toEqual(candidate(undefined, []));
  });

  it('repairs incorrect semantic use and independently verifies the replacement', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion(candidate('The bank approved our application for a loan.')))
      .mockResolvedValueOnce(completion(checks(false)))
      .mockResolvedValueOnce(completion(candidate()))
      .mockResolvedValueOnce(completion(checks()));
    vi.stubGlobal('fetch', fetchMock);
    const article = await generateArticle([bank], settings);
    expect(article.body).toContain('river');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).messages.at(-1).content).toContain('语境不正确');
    expect(getRequestLogs()).toHaveLength(4);
    expect(getRequestLogs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: '文章创作' }),
      expect.objectContaining({ operation: '词义验证' }),
      expect.objectContaining({ operation: '文章修复' }),
      expect.objectContaining({ operation: '修复后词义验证' }),
    ]));
  });

  it.each(['表达稍显生硬', '信息不足，无法确定'])('keeps a warning readable without repair: %s', async reason => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion(candidate()))
      .mockResolvedValueOnce(completion({ checks: [{ annotationIndex: 0, senseId: bank.id, status: 'warning', reason }] }));
    vi.stubGlobal('fetch', fetchMock);
    const article = await generateArticle([bank], settings);
    expect(article.verificationWarnings).toEqual([expect.stringContaining(reason)]);
    expect(article.targetSenseIds).toEqual([bank.id]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts a correct use and a less clear repeated use of the same sense', async () => {
    const sentence = 'The bank beside the river was muddy.';
    const articleCandidate = candidate(`${sentence} ${sentence}`, [
      { senseId: bank.id, surface: 'bank', quote: sentence, occurrence: 1 },
      { senseId: bank.id, surface: 'bank', quote: sentence, occurrence: 2 },
    ]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion(articleCandidate))
      .mockResolvedValueOnce(completion({ checks: [
        { annotationIndex: 0, senseId: bank.id, status: 'correct', reason: '河岸语境明确' },
        { annotationIndex: 1, senseId: bank.id, status: 'warning', reason: '重复表达略显生硬' },
      ] }));
    vi.stubGlobal('fetch', fetchMock);
    const article = await generateArticle([bank], settings);
    expect(article.occurrences).toHaveLength(2);
    expect(article.verificationWarnings).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still repairs an explicitly incorrect repeated use even when another use is correct', async () => {
    const sentences = ['The bank beside the river was muddy.', 'The bank approved a loan.'];
    const articleCandidate = candidate(sentences.join(' '), sentences.map((quote, index) => ({
      senseId: bank.id, surface: 'bank', quote, occurrence: index + 1,
    })));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion(articleCandidate))
      .mockResolvedValueOnce(completion({ checks: [
        { annotationIndex: 0, senseId: bank.id, status: 'correct' },
        { annotationIndex: 1, senseId: bank.id, status: 'incorrect', reason: '明确表示金融机构' },
      ] }))
      .mockResolvedValueOnce(completion(candidate()))
      .mockResolvedValueOnce(completion({ checks: [{ annotationIndex: 0, senseId: bank.id, status: 'correct' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const article = await generateArticle([bank], settings);
    expect(article.body).not.toContain('loan');
    expect(article.verificationWarnings).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('fails after exactly one unsuccessful repair', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => completion(candidate(undefined, [])));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateArticle([bank], settings)).rejects.toMatchObject({ kind: 'format', message: expect.stringContaining('已尝试修复一次') });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    candidate(undefined, [{ senseId: 'unknown', surface: 'bank', quote: 'The bank beside the river was muddy.', occurrence: 1 }]),
    candidate(undefined, [{ senseId: bank.id, surface: 'bank', quote: 'This is an invented quote.', occurrence: 1 }]),
    candidate(undefined, [{ senseId: bank.id, surface: 'bank', quote: 'The bank beside the river was muddy.', occurrence: 2 }]),
    candidate('The banker beside the river was muddy.'),
    candidate(undefined, [
      { senseId: bank.id, surface: 'bank', quote: 'The bank beside the river was muddy.', occurrence: 1 },
      { senseId: bank.id, surface: 'bank', quote: 'The bank beside the river was muddy.', occurrence: 1 },
    ]),
  ])('rejects invalid positions, overlap, unknown IDs, and boundary matches %#', async invalidCandidate => {
    const fetchMock = vi.fn().mockImplementation(async () => completion(invalidCandidate));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateArticle([bank], settings)).rejects.toMatchObject({ kind: 'format' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires every occurrence of a target spelling to be annotated', async () => {
    const invalidCandidate = candidate('The bank beside the river was muddy. We stopped by the bank.');
    invalidCandidate.annotations = [{ senseId: bank.id, surface: 'bank', quote: 'The bank beside the river was muddy.', occurrence: 1 }];
    const fetchMock = vi.fn().mockImplementation(async () => completion(invalidCandidate));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateArticle([bank], settings)).rejects.toMatchObject({ message: expect.stringContaining('未注解') });
  });

  it('resolves repeated identical quotes using the exact surface occurrence number', async () => {
    const sentence = 'The bank beside the river was muddy.';
    const articleCandidate = candidate(`${sentence} ${sentence}`, [
      { senseId: bank.id, surface: 'bank', quote: sentence, occurrence: 1 },
      { senseId: bank.id, surface: 'bank', quote: sentence, occurrence: 2 },
    ]);
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(articleCandidate)).mockResolvedValueOnce(completion({ checks: [
      { annotationIndex: 0, senseId: bank.id, correct: true },
      { annotationIndex: 1, senseId: bank.id, correct: true },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const article = await generateArticle([bank], settings);
    expect(article.occurrences.map(occurrence => occurrence.start)).toEqual([4, sentence.length + 5]);
  });

  it('covers a phrase and its standalone component without requiring overlapping annotations', async () => {
    const phrase = { ...bank, id: 'take-care', word: 'take care', partOfSpeech: 'phr.', meaning: '小心' };
    const care = { ...bank, id: 'care', word: 'care', partOfSpeech: 'n.', meaning: '关心' };
    const sentence = 'Please take care on the path. Her care for the children was clear.';
    const articleCandidate = candidate(sentence, [
      { senseId: phrase.id, surface: 'take care', quote: 'Please take care on the path.', occurrence: 1 },
      { senseId: care.id, surface: 'care', quote: 'Her care for the children was clear.', occurrence: 2 },
    ]);
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(articleCandidate)).mockResolvedValueOnce(completion({ checks: [
      { annotationIndex: 0, senseId: phrase.id, correct: true },
      { annotationIndex: 1, senseId: care.id, correct: true },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const article = await generateArticle([phrase, care], settings);
    expect(article.occurrences.map(occurrence => occurrence.senseId)).toEqual([phrase.id, care.id]);
    expect(article.body.slice(article.occurrences[1].start, article.occurrences[1].end)).toBe('care');
  });

  it('does not count a component inside a phrase as coverage for its standalone meaning', async () => {
    const phrase = { ...bank, id: 'take-care', word: 'take care', partOfSpeech: 'phr.', meaning: '小心' };
    const care = { ...bank, id: 'care', word: 'care', partOfSpeech: 'n.', meaning: '关心' };
    const articleCandidate = candidate('Please take care on the path.', [
      { senseId: phrase.id, surface: 'take care', quote: 'Please take care on the path.', occurrence: 1 },
    ]);
    const fetchMock = vi.fn().mockImplementation(async () => completion(articleCandidate));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateArticle([phrase, care], settings)).rejects.toMatchObject({ kind: 'format', message: expect.stringContaining('遗漏目标义项') });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps different meanings of the same spelling attached to their own positions', async () => {
    const financialBank = { ...bank, id: 'bank-financial', meaning: '银行' };
    const sentence = 'The bank approved the loan.\n\nThen we walked beside the river bank.';
    const articleCandidate = candidate(sentence, [
      { senseId: financialBank.id, surface: 'bank', quote: 'The bank approved the loan.', occurrence: 1 },
      { senseId: bank.id, surface: 'bank', quote: 'Then we walked beside the river bank.', occurrence: 2 },
    ]);
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(articleCandidate)).mockResolvedValueOnce(completion({ checks: [
      { annotationIndex: 0, senseId: financialBank.id, correct: true },
      { annotationIndex: 1, senseId: bank.id, correct: true },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const article = await generateArticle([bank, financialBank], settings);
    expect(article.occurrences.map(occurrence => occurrence.senseId)).toEqual([financialBank.id, bank.id]);
    expect(article.occurrences.map(occurrence => article.body.slice(occurrence.start, occurrence.end))).toEqual(['bank', 'bank']);
  });

  it('preserves independent passages for unrelated targets without requiring one shared story', async () => {
    const telescope = { ...bank, id: 'telescope', word: 'telescope', meaning: '望远镜' };
    const riverPassage = 'After the rain, we checked the river bank for signs of flooding. The water had fallen, so the nearby homes were safe.';
    const astronomyPassage = 'At the observatory, Maya adjusted the telescope to see Saturn. Its rings came into focus, and she recorded what she saw.';
    const body = riverPassage + '\n\n' + astronomyPassage;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion({ title: 'Two Everyday Discoveries', body, annotations: [
        { senseId: bank.id, surface: 'bank', quote: riverPassage, occurrence: 1 },
        { senseId: telescope.id, surface: 'telescope', quote: astronomyPassage, occurrence: 1 },
      ] }))
      .mockResolvedValueOnce(completion({ checks: [
        { annotationIndex: 0, senseId: bank.id, status: 'correct' },
        { annotationIndex: 1, senseId: telescope.id, status: 'correct' },
      ] }));
    vi.stubGlobal('fetch', fetchMock);
    const article = await generateArticle([bank, telescope], settings);
    expect(article.body).toBe(body);
    expect(article.targetSenseIds).toEqual([bank.id, telescope.id]);
    expect(article.occurrences[1].start).toBe(body.indexOf('telescope'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const verification = JSON.parse(JSON.parse(fetchMock.mock.calls[1][1].body).messages[1].content);
    expect(verification.readingStructure).toContain('不要求主题相同');
  });

  it.each([
    { checks: [] },
    { checks: [{ annotationIndex: 0, senseId: bank.id, correct: 'uncertain' }] },
    { checks: [{ annotationIndex: 0, senseId: bank.id, status: 'unknown' }] },
    { checks: [{ annotationIndex: 0, senseId: 'wrong', correct: true }] },
    { checks: [{ annotationIndex: 0, senseId: bank.id, correct: true }, { annotationIndex: 0, senseId: bank.id, correct: true }] },
  ])('does not accept missing, uncertain, or mismatched semantic verification %#', async invalidChecks => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion(candidate()))
      .mockResolvedValueOnce(completion(invalidChecks))
      .mockResolvedValueOnce(completion(candidate()))
      .mockResolvedValueOnce(completion(invalidChecks));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateArticle([bank], settings)).rejects.toMatchObject({ kind: 'format' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('repairs malformed model JSON', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] })))
      .mockResolvedValueOnce(completion(candidate()))
      .mockResolvedValueOnce(completion(checks()));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateArticle([bank], settings)).resolves.toMatchObject({ targetSenseIds: [bank.id] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry authentication or network failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateArticle([bank], settings)).rejects.toMatchObject({ kind: 'auth' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(generateArticle([bank], settings)).rejects.toMatchObject({ kind: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not start a generation request with an empty target set or cancelled signal', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateArticle([], settings)).rejects.toMatchObject({ kind: 'config' });
    const controller = new AbortController();
    controller.abort();
    await expect(generateArticle([bank], settings, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiSettings, RefinementCheckpoint, Sense } from '../domain/types';
import { lookupSense, refineSenses, refinementPreview } from './vocabulary';

const settings: ApiSettings = { baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'test-model' };
const bank: Sense = { id: 'bank-source', word: 'bank', partOfSpeech: 'n.', meaning: '银行；岸', sourceLine: 3, sourceText: 'bank\tn. 银行；岸', origin: 'import' };
const decision: Sense = { ...bank, id: 'decision-source', word: 'decision', meaning: '决定；决心' };

function completion(value: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
}
function sources(count: number): Sense[] {
  return Array.from({ length: count }, (_, index) => ({ ...bank, id: `source-${index}` }));
}
function correct(items: Sense[]) {
  return { items: items.map(source => ({ sourceId: source.id, meanings: source.meaning === bank.meaning ? ['银行', '岸'] : [source.meaning] })) };
}
function checkpointRecorder() {
  const snapshots: RefinementCheckpoint[] = [];
  return { snapshots, onCheckpoint: (checkpoint: RefinementCheckpoint) => { snapshots.push(structuredClone(checkpoint)); } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('refineSenses', () => {
  it('splits meanings with new stable checkpoint IDs and preserves original metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => completion(correct([bank]))));
    const recorder = checkpointRecorder();
    const result = await refineSenses([bank], settings, undefined, undefined, recorder);
    expect(result.map(sense => sense.meaning)).toEqual(['银行', '岸']);
    expect(new Set(result.map(sense => sense.id)).size).toBe(2);
    expect(result[0]).toMatchObject({ word: bank.word, sourceLine: 3, sourceText: bank.sourceText, partOfSpeech: 'n.', origin: 'import' });
    expect(refinementPreview(recorder.snapshots.at(-1)!)).toEqual(result);
    expect(bank.meaning).toBe('银行；岸');
  });

  it.each([
    { items: [] },
    { items: [{ sourceId: 'unknown', meanings: ['银行'] }] },
    { items: [{ sourceId: bank.id, meanings: [] }] },
    { items: [{ sourceId: bank.id, meanings: [''] }] },
    { items: [{ sourceId: bank.id, meanings: ['银行'] }, { sourceId: bank.id, meanings: ['岸'] }] },
  ])('retries malformed results once then flags the unchanged original %#', async value => {
    const fetchMock = vi.fn().mockImplementation(async () => completion(value));
    vi.stubGlobal('fetch', fetchMock);
    const recorder = checkpointRecorder();
    expect(await refineSenses([bank], settings, undefined, undefined, recorder)).toEqual([bank]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recorder.snapshots.at(-1)?.entries[0].issue).toBeTruthy();
  });

  it.each([
    { meanings: ['银行'] },
    { meanings: ['银行', '岸', '倾斜'] },
    { meanings: ['金融机构', '河边'] },
    { meanings: ['岸', '银行'] },
  ])('rejects changed meanings without stopping the vocabulary %#', async ({ meanings }) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => completion({ items: [{ sourceId: bank.id, meanings }] })));
    const recorder = checkpointRecorder();
    expect(await refineSenses([bank], settings, undefined, undefined, recorder)).toEqual([bank]);
    expect(recorder.snapshots.at(-1)?.entries[0].issue).toContain('改写、遗漏或新增');
  });

  it('retries only the problem word while retaining the other verified results', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion({ items: [...correct([bank]).items, { sourceId: decision.id, meanings: ['决策'] }] }))
      .mockResolvedValueOnce(completion(correct([decision])));
    vi.stubGlobal('fetch', fetchMock);
    const recorder = checkpointRecorder();
    const result = await refineSenses([bank, decision], settings, undefined, undefined, recorder);
    expect(result.map(sense => sense.meaning)).toEqual(['银行', '岸', '决定；决心']);
    const retryTargets = JSON.parse(JSON.parse(fetchMock.mock.calls[1][1].body).messages[1].content);
    expect(retryTargets.map((item: { sourceId: string }) => item.sourceId)).toEqual([decision.id]);
    expect(retryTargets[0].previousError).toContain('改写');
    expect(recorder.snapshots.at(-1)?.entries.every(entry => !entry.issue)).toBe(true);
  });

  it('continues later batches after an unrepaired word and preserves its original', async () => {
    const input = [...sources(20), decision];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion({ items: [{ sourceId: input[0].id, meanings: ['金融机构'] }, ...correct(input.slice(1, 20)).items] }))
      .mockResolvedValueOnce(completion({ items: [] }))
      .mockResolvedValueOnce(completion(correct([decision])));
    vi.stubGlobal('fetch', fetchMock);
    const recorder = checkpointRecorder();
    const result = await refineSenses(input, settings, undefined, undefined, recorder);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result[0]).toEqual(input[0]);
    expect(result.at(-1)).toMatchObject({ word: 'decision', meaning: '决定；决心' });
    expect(recorder.snapshots.at(-1)?.entries).toHaveLength(21);
    expect(recorder.snapshots.at(-1)?.entries.filter(entry => entry.issue)).toHaveLength(1);
  });

  it('persists successful batches before a network failure and resumes without repeating them', async () => {
    const input = sources(21);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(completion(correct(input.slice(0, 20))))
      .mockRejectedValueOnce(new TypeError('network unavailable')));
    const recorder = checkpointRecorder();
    await expect(refineSenses(input, settings, undefined, undefined, recorder)).rejects.toMatchObject({ kind: 'network' });
    const saved = recorder.snapshots.at(-1)!;
    expect(saved.entries).toHaveLength(20);
    const ids = saved.entries.flatMap(entry => entry.senses.map(sense => sense.id));
    const resumeMock = vi.fn().mockResolvedValueOnce(completion(correct(input.slice(20))));
    vi.stubGlobal('fetch', resumeMock);
    const result = await refineSenses(input, settings, undefined, undefined, { checkpoint: saved });
    expect(result.slice(0, 40).map(sense => sense.id)).toEqual(ids);
    expect(resumeMock).toHaveBeenCalledTimes(1);
    const resumedInput = JSON.parse(JSON.parse(resumeMock.mock.calls[0][1].body).messages[1].content);
    expect(resumedInput.map((item: { sourceId: string }) => item.sourceId)).toEqual(['source-20']);
  });

  it('keeps good entries from a partially invalid batch when repair fails authentication', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(completion({ items: [...correct([bank]).items, { sourceId: decision.id, meanings: ['决策'] }] }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 })));
    const recorder = checkpointRecorder();
    await expect(refineSenses([bank, decision], settings, undefined, undefined, recorder)).rejects.toMatchObject({ kind: 'auth' });
    expect(recorder.snapshots.at(-1)?.entries.map(entry => entry.sourceId)).toEqual([bank.id]);
  });

  it('retains completed work on cancellation and makes no further API calls', async () => {
    const input = sources(21);
    const controller = new AbortController();
    const recorder = checkpointRecorder();
    const fetchMock = vi.fn().mockImplementation(async () => completion(correct(input.slice(0, 20))));
    vi.stubGlobal('fetch', fetchMock);
    await expect(refineSenses(input, settings, controller.signal, undefined, { onCheckpoint: checkpoint => {
      recorder.onCheckpoint(checkpoint);
      if (checkpoint.entries.length === 20) controller.abort();
    } })).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorder.snapshots.at(-1)?.entries).toHaveLength(20);
  });

  it('does not call the API when already cancelled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(refineSenses([bank], settings, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not repeat completed or manually flagged entries on resume', async () => {
    const saved: RefinementCheckpoint = { sources: [bank], entries: [{ sourceId: bank.id, senses: [bank], issue: '需人工检查' }] };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await refineSenses([bank], settings, undefined, undefined, { checkpoint: saved })).toEqual([bank]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a checkpoint belonging to a different vocabulary', async () => {
    await expect(refineSenses([decision], settings, undefined, undefined, { checkpoint: { sources: [bank], entries: [] } })).rejects.toMatchObject({ kind: 'config' });
  });

  it('treats invalid JSON as a local format failure rather than aborting the run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{broken' } }] }))));
    const recorder = checkpointRecorder();
    expect(await refineSenses([bank], settings, undefined, undefined, recorder)).toEqual([bank]);
    expect(recorder.snapshots.at(-1)?.entries[0].issue).toContain('JSON');
  });

  it('allows synonymous punctuation and repeated original explanations', async () => {
    const revolt = { ...bank, id: 'revolt-source', word: 'revolt', meaning: '造反，起义' };
    const repeated = { ...decision, meaning: '决定；决定' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(completion({ items: [{ sourceId: revolt.id, meanings: ['造反、起义'] }, { sourceId: repeated.id, meanings: ['决定', '决定'] }] })));
    expect((await refineSenses([revolt, repeated], settings)).map(sense => sense.meaning)).toEqual(['造反、起义', '决定', '决定']);
  });

  it('stops if checkpoint storage fails instead of continuing unsaved', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(refineSenses([bank], settings, undefined, undefined, { onCheckpoint: () => { throw new Error('storage quota'); } })).rejects.toThrow('storage quota');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
describe('lookupSense', () => {
  it('creates a new contextual sense instead of reusing the same spelling ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion({ word: 'bank', partOfSpeech: 'n.', meaning: '河岸' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await lookupSense('bank', 'They sat on the bank of the river.', settings);
    expect(result).toMatchObject({ word: 'bank', meaning: '河岸', origin: 'lookup', sourceLine: 0, sourceText: 'They sat on the bank of the river.' });
    expect(result.id).not.toBe(bank.id);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(JSON.parse(body.messages[1].content)).toEqual({ word: 'bank', context: 'They sat on the bank of the river.' });
  });

  it('fails rather than inventing a sense if the model says the context is uncertain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion({ error: '上下文不足' })));
    await expect(lookupSense('bank', 'bank', settings)).rejects.toMatchObject({ kind: 'format' });
  });
});

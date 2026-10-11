import { expect, test, type Page } from '@playwright/test';
import type { ImportDraft, LibraryCollection } from '../src/domain/types';

interface MockTarget {
  senseId: string;
  word: string;
  partOfSpeech: string;
  meaning: string;
}

interface MockControl {
  failGeneration: boolean;
  lateTarget?: boolean;
  refinementRequests?: string[][];
  generatedTargets?: MockTarget[][];
  failGenerationNumbers?: number[];
  holdGenerationNumber?: number;
  releaseGeneration?: () => void;
  generationLimits?: { expectedWordCount: number }[];
  generatedWordCount?: number;
  verificationWarning?: string;
}

test.beforeEach(async ({ context }) => {
  let stored = { collection: { version: 1, libraries: [], activeLibraryId: null } as LibraryCollection, revision: 0, migratedSourceIds: [] as string[] };
  let draft: ImportDraft | null = null;
  await context.route('**/api/libraries{,/migrate}', async route => {
    const payload = route.request().method() === 'GET' ? null : route.request().postDataJSON();
    if (route.request().url().endsWith('/migrate')) {
      if (!stored.migratedSourceIds.includes(payload.sourceId)) {
        stored = { collection: payload.collection, revision: stored.revision + 1, migratedSourceIds: [...stored.migratedSourceIds, payload.sourceId] };
        draft ??= payload.draft;
      }
    } else if (payload) {
      stored = { ...stored, collection: payload.collection, revision: stored.revision + 1 };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(stored) });
  });
  await context.route('**/api/import-draft', async route => {
    if (route.request().method() === 'PUT') draft = route.request().postDataJSON().draft;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ draft }) });
  });
  let settings = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', configured: false };
  await context.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT') {
      const incoming = route.request().postDataJSON();
      settings = { baseUrl: incoming.baseUrl, model: incoming.model, configured: true };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(settings) });
  });
});

async function readImportDraft(page: Page): Promise<ImportDraft | undefined> {
  return page.evaluate(async () => (await (await fetch('/api/import-draft')).json()).draft ?? undefined);
}

async function configure(page: Page) {
  await page.getByRole('button', { name: '连接设置', exact: false }).click();
  await page.getByLabel('Base URL', { exact: true }).fill('https://mock.example/v1');
  await page.getByLabel('模型名', { exact: true }).fill('mock-model');
  await page.getByLabel('API Key', { exact: true }).fill('test-only-key');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('API 设置已保存到本机后端，重开浏览器或重启服务后仍可使用。', { exact: true })).toBeVisible();
}

async function readLibraries(page: Page): Promise<LibraryCollection> {
  return page.evaluate(async () => (await (await fetch('/api/libraries')).json()).collection);
}

test('real backend persists screening across fresh browsers and rejects stale writes', async ({ page, context, browser }) => {
  await context.unroute('**/api/libraries{,/migrate}');
  await context.unroute('**/api/import-draft');
  await page.goto('/#/library');
  await page.getByLabel('词库名称', { exact: true }).fill('后端持久化验收');
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行\nriver\tn. 河流');
  await page.getByRole('button', { name: '保存并快速筛词', exact: true }).click();
  await page.getByRole('button', { name: 'bank，标记不认识', exact: true }).click();
  await expect.poll(async () => (await readLibraries(page)).libraries.find(item => item.name === '后端持久化验收')?.screening?.unknownSenseIds.length).toBe(1);
  const original = await readLibraries(page);
  const fresh = await browser.newContext();
  try {
    const reopened = await fresh.newPage();
    await reopened.goto('http://127.0.0.1:5175/#/library');
    expect(await readLibraries(reopened)).toEqual(original);
    await expect(reopened.locator('.library-card')).toHaveCount(original.libraries.length);
    const storage = await reopened.evaluate(() => new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open('context-words', 1);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('workspace', 'readonly');
        const read = transaction.objectStore('workspace').get('libraries');
        transaction.oncomplete = () => { database.close(); resolve(read.result); };
        transaction.onabort = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    }));
    expect(storage).toBeUndefined();
    const conflict = await reopened.evaluate(async () => {
      const stored = await (await fetch('/api/libraries')).json();
      const update = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collection: stored.collection, revision: stored.revision }) };
      const first = await fetch('/api/libraries', update);
      const second = await fetch('/api/libraries', update);
      return [first.status, second.status];
    });
    expect(conflict).toEqual([200, 409]);
  } finally { await fresh.close(); }
});

async function saveAndStart(page: Page, options?: { targetCount: number; expectedWordCount: number }) {
  await page.getByRole('button', { name: '保存词库', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '词库已保存。' })).toBeVisible();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '阅读', exact: false }).click();
  if (options) {
    await page.getByLabel('每篇覆盖词义数量', { exact: true }).fill(String(options.targetCount));
    await page.getByLabel('预期长度（英文词）', { exact: true }).fill(String(options.expectedWordCount));
  }
  await page.getByRole('button', { name: '开始第一篇文章', exact: true }).click();
}

async function mockApi(page: Page, control: MockControl) {
  let generationNumber = 0;
  await page.route('**/api/chat/completions', async (route) => {
    const request = route.request().postDataJSON();
    const system = request.messages[0].content as string;
    const input = JSON.parse(request.messages[1].content);
    let output: unknown;
    if (system.includes('词库编辑')) {
      control.refinementRequests?.push(input.map((item: { sourceId: string }) => item.sourceId));
      output = { items: input.map((item: { sourceId: string; meaning: string }) => ({ sourceId: item.sourceId, meanings: item.meaning === '银行；岸' ? ['银行', '岸'] : [item.meaning] })) };
    } else if (system.includes('词义审核员')) {
      output = { checks: input.annotations.map((item: { annotationIndex: number; senseId: string }) => ({ annotationIndex: item.annotationIndex, senseId: item.senseId, status: control.verificationWarning ? 'warning' : 'correct', reason: control.verificationWarning ?? 'test fixture' })) };
    } else if (system.includes('阅读教师')) {
      output = { word: 'morning', partOfSpeech: 'n.', meaning: '早晨' };
    } else {
      generationNumber += 1;
      control.generatedTargets?.push(input.targets);
      control.generationLimits?.push({ expectedWordCount: input.expectedWordCount });
      expect(input).not.toHaveProperty('minimumWordCount');
      expect(input).not.toHaveProperty('maximumWordCount');
      expect(input).not.toHaveProperty('targetWordCount');
      if (generationNumber === control.holdGenerationNumber) await new Promise<void>(resolve => { control.releaseGeneration = resolve; });
      if (control.failGeneration || control.failGenerationNumbers?.includes(generationNumber)) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'mock unavailable' } }) });
        return;
      }
      const sentences = input.targets.map((target: { meaning: string }) => target.meaning === '银行' ? 'I visited the bank to deposit some money.'
        : target.meaning === '岸' ? 'We sat on the bank beside the river.'
        : target.meaning === '把钱存入银行' ? 'Our friends bank their savings before starting the journey.'
        : 'The morning brought fresh light to our village.');
      const filler = 'We walked through the quiet village and found a small garden where our friends shared their plans for a pleasant journey together.';
      const extra = input.targets.some((target: { word: string }) => target.word === 'morning') ? '' : ' The morning sunlight warmed our small village.';
      const content = sentences.join(' ') + extra;
      const contentLength = content.match(/[a-zA-Z]+(?:[’'\-][a-zA-Z]+)*/g)?.length ?? 0;
      const wordGoal = control.generatedWordCount ?? input.expectedWordCount;
      const fillerWords = Array(100).fill(filler).join(' ').split(/\s+/).slice(0, Math.max(0, wordGoal - contentLength)).join(' ');
      const body = control.lateTarget ? fillerWords + '\n\n' + content : content + '\n\n' + fillerWords;
      output = { title: 'A Quiet Discovery', body, annotations: input.targets.map((target: { senseId: string; word: string }, index: number) => ({ senseId: target.senseId, surface: target.word, quote: sentences[index], occurrence: 1 })) };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }) });
  });
}

test('backend settings restore without persisting the API key in browser storage', async ({ page, context }) => {
  await page.goto('/');
  await configure(page);
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => localStorage.getItem('context-words-api-settings'))).toBeNull();
  const reopened = await context.newPage();
  await reopened.goto('/#/settings');
  await expect(reopened.getByLabel('Base URL', { exact: true })).toHaveValue('https://mock.example/v1');
  await expect(reopened.getByLabel('模型名', { exact: true })).toHaveValue('mock-model');
  await expect(reopened.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(reopened.getByText('API Key 已保存在后端。', { exact: false })).toBeVisible();
  await reopened.getByLabel('模型名', { exact: true }).fill('second-model');
  await reopened.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(reopened.getByText('API 设置已保存到本机后端，重开浏览器或重启服务后仍可使用。', { exact: true })).toBeVisible();
  await reopened.reload();
  await expect(reopened.getByLabel('模型名', { exact: true })).toHaveValue('second-model');
  expect(await reopened.evaluate(() => localStorage.getItem('context-words-api-settings'))).toBeNull();
});

test('local word senses can start after draft refresh without AI splitting', async ({ page }) => {
  const control: MockControl = { failGeneration: false, refinementRequests: [], generatedTargets: [] };
  await mockApi(page, control);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行 v. 把钱存入银行\nbank\tn. 岸');
  await expect(page.getByLabel('中文释义', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('button', { name: '保存词库', exact: true })).toBeEnabled();
  await expect.poll(async () => (await readImportDraft(page))?.preview.senses.length).toBe(3);
  const draft = await readImportDraft(page);
  expect(draft?.refined).toBe(false);
  expect(draft?.preview.senses.map(sense => [sense.partOfSpeech, sense.meaning])).toEqual([
    ['n.', '银行'], ['v.', '把钱存入银行'], ['n.', '岸'],
  ]);
  await page.reload();
  await expect(page.getByLabel('中文释义', { exact: true })).toHaveCount(3);
  await saveAndStart(page);
  await expect(page.getByLabel('英文文章', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/read$/);
  expect(control.refinementRequests).toEqual([]);
  expect(control.generatedTargets!.length).toBeGreaterThanOrEqual(1);
  expect(control.generatedTargets?.[0]).toHaveLength(1);
  const target = control.generatedTargets?.[0][0];
  expect(draft?.preview.senses.map(sense => ({
    senseId: sense.id, word: sense.word, partOfSpeech: sense.partOfSpeech, meaning: sense.meaning,
  }))).toContainEqual(target);
});

test('reading page opens definitions only on click and restores article navigation after refresh', async ({ page }) => {
  const control: MockControl = { failGeneration: false, generatedTargets: [] };
  await mockApi(page, control);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行');
  await saveAndStart(page);
  await expect(page).toHaveURL(/#\/read$/);
  const article = page.getByLabel('英文文章', { exact: true });
  const body = await article.innerText();
  const bank = page.locator('.target-word').filter({ hasText: /^bank$/ }).first();
  await bank.hover();
  await expect(page.getByLabel('当前词义', { exact: true })).toHaveCount(0);
  await bank.focus();
  await expect(page.getByLabel('当前词义', { exact: true })).toHaveCount(0);
  await expect(page.locator('.unknown-chip')).toHaveCount(0);
  await expect(bank).toHaveAttribute('aria-pressed', 'false');
  await bank.click();
  await expect(page.locator('.sense-definition')).toContainText('银行');
  await expect(page.getByText('已加入本轮生词', { exact: true })).toBeVisible();
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  await expect(bank).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '认识了，取消标记', exact: true }).click();
  await expect(page.locator('.unknown-chip')).toHaveCount(0);
  await expect(bank).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(bank).toBeFocused();
  await expect(page.getByLabel('当前词义', { exact: true })).toHaveCount(0);
  await bank.click();
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  await page.reload();
  await expect(page).toHaveURL(/#\/read$/);
  await expect(article).toHaveText(body);
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  await page.getByRole('button', { name: '阅读设置与历史', exact: false }).click();
  await expect(page).toHaveURL(/#\/learn$/);
  await expect(article).toHaveCount(0);
  await page.locator('.article-preview').getByRole('button', { name: '继续阅读', exact: false }).click();
  await expect(page).toHaveURL(/#\/read$/);
  await expect(article).toHaveText(body);
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  expect(control.generatedTargets!.length).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect(page.locator('.learn-heading .eyebrow')).toContainText('ROUND 1');
  await expect(page).toHaveURL(/#\/read$/);
  expect(control.generatedTargets).toHaveLength(2);
  expect(control.generatedTargets?.[1]).toEqual(control.generatedTargets?.[0]);
  await expect(page.locator('.unknown-chip')).toHaveCount(0);
});

test('clicking outside the definition card dismisses it without changing word marks', async ({ page }) => {
  await mockApi(page, { failGeneration: false });
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行');
  await saveAndStart(page);
  const bank = page.locator('.target-word').filter({ hasText: /^bank$/ }).first();
  const card = page.getByLabel('当前词义', { exact: true });
  await bank.click();
  await expect(card).toBeVisible();
  await page.locator('.sense-definition').click();
  await expect(card).toBeVisible();
  await page.locator('.theme-label').click();
  await expect(card).toHaveCount(0);
  await expect(bank).toHaveAttribute('aria-pressed', 'true');
  await bank.click();
  await expect(card).toBeVisible();
  await expect(bank).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.theme-label').click();
  await expect(card).toHaveCount(0);
  await expect(bank).toHaveAttribute('aria-pressed', 'false');
});

test('ordinary lookup words never gain target underlines when marking, cancelling, or restoring', async ({ page }) => {
  await mockApi(page, { failGeneration: false });
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行');
  await saveAndStart(page);
  const morning = page.locator('.article-body .word-token').filter({ hasText: /^morning$/ }).first();
  await expect(morning).not.toHaveClass(/target-word/);
  await morning.hover();
  await expect(page.getByLabel('当前词义', { exact: true })).toHaveCount(0);
  await morning.click();
  await expect(morning).toHaveAttribute('aria-pressed', 'true');
  await expect(morning).toHaveClass(/unknown-word/);
  await expect(morning).not.toHaveClass(/target-word/);
  await morning.click();
  await expect(morning).toHaveAttribute('aria-pressed', 'false');
  await expect(morning).not.toHaveClass(/unknown-word|target-word/);
  await expect(page.locator('.unknown-chip')).toHaveCount(0);
  await page.reload();
  await expect(morning).not.toHaveClass(/unknown-word|target-word/);
  await morning.click();
  await expect(morning).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sense-definition')).toContainText('早晨');
  await expect(morning).not.toHaveClass(/target-word/);
  await page.getByRole('button', { name: '认识了，取消标记', exact: true }).click();
  await expect(morning).not.toHaveClass(/unknown-word|target-word/);
  await expect(page.locator('.target-word').filter({ hasText: /^bank$/ }).first()).toBeVisible();
});

test('article failure diagnostics survive refresh and can be cleared', async ({ page }) => {
  await mockApi(page, { failGeneration: true });
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行');
  await saveAndStart(page);
  await expect(page.locator('.notice.error').filter({ hasText: 'HTTP 503' })).toBeVisible();
  await page.getByRole('button', { name: '连接设置', exact: false }).click();
  const panel = page.locator('.request-log-panel');
  await panel.locator('summary').click();
  const entry = panel.locator('.request-log-list > li');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('文章创作');
  await expect(entry).toContainText('失败');
  await expect(entry).toContainText('HTTP 503');
  await expect(entry).toContainText('mock-model');
  expect(await page.evaluate(() => localStorage.getItem('context-words-request-logs'))).not.toContain('test-only-key');
  await page.reload();
  await page.getByRole('button', { name: '连接设置', exact: false }).click();
  await panel.locator('summary').click();
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('HTTP 503');
  await panel.getByRole('button', { name: '清空日志', exact: true }).click();
  await expect(panel).toContainText('暂无记录');
  await page.reload();
  await page.getByRole('button', { name: '连接设置', exact: false }).click();
  await panel.locator('summary').click();
  await expect(panel).toContainText('暂无记录');
});

test('paused AI splitting can be skipped while preserving preview senses and clearing review gates', async ({ page }) => {
  const control: MockControl = { failGeneration: false, refinementRequests: [], generatedTargets: [] };
  await mockApi(page, control);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行；岸 v. 把钱存入银行');
  await expect.poll(async () => (await readImportDraft(page))?.preview.senses.length).toBe(2);
  const localDraft = (await readImportDraft(page))!;
  const noun = localDraft.preview.senses[0];
  const verb = localDraft.preview.senses[1];
  const splitSenses = [
    { ...noun, id: noun.id + '-bank', meaning: '银行' },
    { ...noun, id: noun.id + '-river', meaning: '岸' },
  ];
  const pausedDraft: ImportDraft = {
    ...localDraft,
    preview: { ...localDraft.preview, senses: [...splitSenses, verb] },
    checkpoint: {
      sources: localDraft.preview.senses,
      entries: [{ sourceId: noun.id, senses: splitSenses, issue: '需要人工确认' }],
    },
    reviewSenseIds: [splitSenses[0].id],
    refined: false,
  };
  await page.evaluate(async draft => {
    await fetch('/api/import-draft', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft }) });
  }, pausedDraft);
  await page.reload();
  await expect(page.locator('.refinement-summary')).toContainText('已处理 1 / 2 条');
  await expect(page.getByLabel('中文释义', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('button', { name: '保存词库', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '跳过 AI 拆分，使用当前词义', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存词库', exact: true })).toBeEnabled();
  await expect.poll(async () => {
    const draft = await readImportDraft(page);
    return { checkpoint: draft?.checkpoint, reviewSenseIds: draft?.reviewSenseIds, refined: draft?.refined };
  }).toEqual({ checkpoint: null, reviewSenseIds: [], refined: false });
  expect((await readImportDraft(page))?.preview.senses).toEqual(pausedDraft.preview.senses);
  await page.reload();
  await expect(page.getByLabel('中文释义', { exact: true })).toHaveCount(3);
  await saveAndStart(page);
  await expect(page.getByLabel('英文文章', { exact: true })).toBeVisible();
  expect(control.refinementRequests).toEqual([]);
  expect(control.generatedTargets!.length).toBeGreaterThanOrEqual(1);
  const target = control.generatedTargets?.[0][0];
  expect(pausedDraft.preview.senses.map(sense => ({
    senseId: sense.id, word: sense.word, partOfSpeech: sense.partOfSpeech, meaning: sense.meaning,
  }))).toContainEqual(target);
});

test('polysemy coverage, unknown lookup, failed generation, refresh, and shrinking reviews', async ({ page }) => {
  const control: MockControl = { failGeneration: false, failGenerationNumbers: [2], generatedTargets: [] };
  await mockApi(page, control);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行；岸');
  await page.getByRole('button', { name: '智能拆分词义', exact: true }).click();
  await expect(page.getByLabel('中文释义', { exact: true })).toHaveCount(2);
  await saveAndStart(page);
  await expect(page.getByLabel('英文文章', { exact: true })).toBeVisible();
  await expect(page.locator('.next-status')).toContainText('下一篇准备失败');
  const bank = page.locator('.target-word').filter({ hasText: /^bank$/ }).first();
  await bank.click();
  await expect(page.getByText('已加入本轮生词', { exact: true })).toBeVisible();
  const firstMeaning = await page.locator('.sense-definition').innerText();
  await page.screenshot({ path: 'test-results/desktop-reader.png', fullPage: true });
  control.failGeneration = true;
  await page.reload();
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  control.failGeneration = true;
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect(page.locator('.notice.error').filter({ hasText: 'HTTP 503' })).toBeVisible();
  await expect(page.getByLabel('英文文章')).toBeVisible();
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  control.failGeneration = false;
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect(page.locator('.unknown-chip')).toHaveCount(0);
  await page.locator('.target-word').filter({ hasText: /^bank$/ }).first().click();
  await expect(page.locator('.sense-definition')).not.toHaveText(firstMeaning);
  await page.getByRole('button', { name: '认识了，取消标记', exact: true }).click();
  await page.locator('.article-body .word-token').filter({ hasText: /^morning$/ }).first().click();
  await expect(page.locator('.sense-definition')).toContainText('早晨');
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect(page.locator('.learn-heading .eyebrow')).toContainText('ROUND 1');
  await expect(page.getByLabel('英文文章')).toBeVisible();
  await expect(page.locator('.target-word')).toHaveCount(2);
  await page.locator('.target-word').filter({ hasText: /^bank$/ }).first().click();
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect(page.locator('.learn-heading .eyebrow')).toContainText('ROUND 2');
  await expect(page.locator('.target-word')).toHaveCount(1);
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect(page.getByRole('heading', { name: '这一轮没有生词了' })).toBeVisible();
  await expect(page).toHaveURL(/#\/learn$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: '这一轮没有生词了' })).toBeVisible();
});

test('multiple imported libraries retain independent reading settings and marked progress', async ({ page }) => {
  const control: MockControl = { failGeneration: false, generatedTargets: [] };
  await mockApi(page, control);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('词库名称', { exact: true }).fill('河岸与银行');
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行\nbank\tn. 岸');
  await page.getByRole('button', { name: '保存词库', exact: true }).click();
  await expect(page.locator('.library-card')).toHaveCount(1);
  expect(control.generatedTargets).toEqual([]);
  await page.getByLabel('词库名称', { exact: true }).fill('清晨词库');
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('morning\tn. 早晨');
  await page.getByRole('button', { name: '保存词库', exact: true }).click();
  await expect(page.locator('.library-card')).toHaveCount(2);
  expect(control.generatedTargets).toEqual([]);
  const saved = await readLibraries(page);
  const bankLibrary = saved.libraries.find(library => library.name === '河岸与银行')!;
  const morningLibrary = saved.libraries.find(library => library.name === '清晨词库')!;
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '阅读', exact: false }).click();
  await page.getByLabel('每篇覆盖词义数量', { exact: true }).fill('2');
  await page.getByLabel('预期长度（英文词）', { exact: true }).fill('120');
  await page.getByRole('button', { name: '开始第一篇文章', exact: true }).click();
  await expect(page.locator('.target-word').first()).toHaveText('morning');
  await page.locator('.target-word').first().click();
  const morningBody = await page.getByLabel('英文文章', { exact: true }).innerText();
  await page.getByRole('button', { name: '阅读设置与历史', exact: false }).click();
  await page.getByRole('combobox', { name: '选择词库', exact: true }).selectOption(bankLibrary.id!);
  await expect(page.getByLabel('每篇覆盖词义数量', { exact: true })).toHaveValue('20');
  await expect(page.locator('.history-item')).toHaveCount(0);
  await page.getByLabel('每篇覆盖词义数量', { exact: true }).fill('1');
  await page.getByLabel('预期长度（英文词）', { exact: true }).fill('100');
  await page.getByRole('button', { name: '开始第一篇文章', exact: true }).click();
  await expect(page.locator('.target-word').first()).toHaveText('bank');
  await page.locator('.target-word').first().click();
  await expect(page.locator('.next-status')).toContainText('下一篇已准备好');
  const bankBody = await page.getByLabel('英文文章', { exact: true }).innerText();
  await page.reload();
  await expect(page.getByLabel('英文文章', { exact: true })).toHaveText(bankBody);
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  await page.getByRole('button', { name: '阅读设置与历史', exact: false }).click();
  await page.getByRole('combobox', { name: '选择词库', exact: true }).selectOption(morningLibrary.id!);
  await expect(page.getByLabel('每篇覆盖词义数量', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('预期长度（英文词）', { exact: true })).toHaveValue('120');
  await page.locator('.article-preview').getByRole('button', { name: '继续阅读', exact: false }).click();
  await expect(page.getByLabel('英文文章', { exact: true })).toHaveText(morningBody);
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '阅读设置与历史', exact: false }).click();
  await page.screenshot({ path: 'test-results/mobile-reading-settings.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await expect(page.locator('.library-card')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/mobile-library-cards.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('semantic warnings allow reading without repair and persist for historical review', async ({ page }) => {
  const control: MockControl = { failGeneration: false, generatedTargets: [], verificationWarning: '表达略显生硬，但含义基本合理' };
  await mockApi(page, control);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 岸');
  await saveAndStart(page);
  await expect(page.getByLabel('英文文章', { exact: true })).toBeVisible();
  await page.getByText('词义提示（1 条，不影响阅读）', { exact: true }).click();
  await expect(page.getByText('“bank：岸”：表达略显生硬，但含义基本合理', { exact: true })).toBeVisible();
  expect(control.generatedTargets).toHaveLength(1);
  await page.reload();
  await expect(page.getByText('词义提示（1 条，不影响阅读）', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect(page).toHaveURL(/#\/learn$/);
  await page.locator('.history-item').first().click();
  await expect(page.locator('.reading-progress')).toContainText('历史回顾');
  await page.getByText('词义提示（1 条，不影响阅读）', { exact: true }).click();
  await expect(page.getByText('“bank：岸”：表达略显生硬，但含义基本合理', { exact: true })).toBeVisible();
  expect(control.generatedTargets).toHaveLength(1);
});

test('expected article length is a persisted preference and longer covered articles remain readable without repair', async ({ page }) => {
  const control: MockControl = { failGeneration: false, generatedTargets: [], generationLimits: [], generatedWordCount: 87 };
  await mockApi(page, control);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行');
  await saveAndStart(page, { targetCount: 1, expectedWordCount: 20 });
  await expect(page.getByLabel('英文文章', { exact: true })).toBeVisible();
  await expect(page.locator('.target-word').first()).toHaveText('bank');
  await expect(page.locator('.notice.error')).toHaveCount(0);
  expect(control.generatedTargets).toHaveLength(1);
  expect(control.generationLimits).toEqual([{ expectedWordCount: 20 }]);
  const library = (await readLibraries(page)).libraries[0];
  expect(library.session!.articles[0].wordCount).toBe(87);
  expect(library.readingOptions).toEqual({ targetCount: 1, expectedWordCount: 20 });
  await page.reload();
  await expect(page.getByLabel('英文文章', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '阅读设置与历史', exact: false }).click();
  const expectedLength = page.getByLabel('预期长度（英文词）', { exact: true });
  await expect(expectedLength).toHaveValue('20');
  await expect(expectedLength).toHaveAttribute('min', '1');
  expect(await expectedLength.getAttribute('max')).toBeNull();
  expect(control.generatedTargets).toHaveLength(1);
});

test('background preparation preserves toggles and coverage, restores its cache, and retains read-only history', async ({ page }) => {
  const control: MockControl = { failGeneration: false, generatedTargets: [], generationLimits: [], holdGenerationNumber: 2 };
  await mockApi(page, control);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行\nbank\tn. 岸\nbank\tv. 把钱存入银行');
  await saveAndStart(page, { targetCount: 1, expectedWordCount: 100 });
  await expect(page.getByLabel('英文文章', { exact: true })).toBeVisible();
  await expect.poll(() => Boolean(control.releaseGeneration)).toBe(true);
  await expect(page.locator('.task-banner')).toHaveCount(0);
  const target = page.locator('.target-word').first();
  await expect(target).toBeEnabled();
  await target.click();
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  await target.click();
  await expect(target).toHaveAttribute('aria-pressed', 'false');
  await target.click();
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  await expect(page.locator('.reading-progress')).toContainText('已覆盖 1 / 3');
  const firstArticleId = (await readLibraries(page)).libraries[0].session!.currentArticleId;
  control.releaseGeneration!();
  await expect(page.locator('.next-status')).toContainText('下一篇已准备好');
  await expect.poll(async () => (await readLibraries(page)).libraries[0].session?.preparedArticle?.id).toBeTruthy();
  const cached = (await readLibraries(page)).libraries[0].session!.preparedArticle!;
  const cachedTarget = cached.targetSenseIds[0];
  expect((await readLibraries(page)).libraries[0].session!.articles).toHaveLength(1);
  expect(control.generatedTargets).toHaveLength(2);
  expect(control.generationLimits).toEqual([{ expectedWordCount: 100 }, { expectedWordCount: 100 }]);
  await page.reload();
  await expect(page.locator('.next-status')).toContainText('下一篇已准备好');
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  expect(control.generatedTargets).toHaveLength(2);
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect.poll(async () => (await readLibraries(page)).libraries[0].session?.currentArticleId).toBe(cached.id);
  await expect(page.locator('.reading-progress')).toContainText('已覆盖 2 / 3');
  await expect(page.locator('.unknown-chip')).toHaveCount(0);
  expect(control.generatedTargets!.filter(targets => targets.some(item => item.senseId === cachedTarget))).toHaveLength(1);
  await page.getByRole('button', { name: '阅读设置与历史', exact: false }).click();
  await expect(page.locator('.history-item')).toHaveCount(2);
  await page.locator('.history-item').last().click();
  await expect(page.locator('.reading-progress')).toContainText('历史回顾');
  await expect(page.locator('.reading-progress')).toContainText('已覆盖 1 / 3');
  await expect(page.getByRole('button', { name: '读完，下一篇', exact: false })).toHaveCount(0);
  const historyTarget = page.locator('.target-word').first();
  await expect(historyTarget).toHaveAttribute('aria-pressed', 'true');
  await historyTarget.click();
  await historyTarget.click();
  await expect(historyTarget).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sense-definition')).toBeVisible();
  const restored = (await readLibraries(page)).libraries[0].session!;
  expect(restored.currentArticleId).toBe(cached.id);
  expect(restored.articles.find(article => article.id === firstArticleId)?.unknownSenseIds).toHaveLength(1);
  await page.locator('.reader-footer').getByRole('button', { name: '返回当前阅读', exact: false }).click();
  await expect(page.locator('.reading-progress')).not.toContainText('历史回顾');
  await expect(page.locator('.unknown-chip')).toHaveCount(0);
});

test('cancelling next-article wait preserves the current article and unknown marks, then allows retry', async ({ page }) => {
  const control: MockControl = { failGeneration: false, generatedTargets: [], holdGenerationNumber: 2 };
  await mockApi(page, control);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行\nbank\tn. 岸');
  await saveAndStart(page, { targetCount: 1, expectedWordCount: 100 });
  await expect(page.getByLabel('英文文章', { exact: true })).toBeVisible();
  await expect.poll(() => Boolean(control.releaseGeneration)).toBe(true);
  await page.locator('.target-word').first().click();
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  await expect.poll(async () => (await readLibraries(page)).libraries[0].session?.currentUnknownIds.length).toBe(1);
  const snapshot = structuredClone((await readLibraries(page)).libraries[0].session!);
  const body = await page.getByLabel('英文文章', { exact: true }).innerText();
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect(page.locator('.task-banner')).toContainText('下一篇正在准备');
  await page.locator('.task-banner').getByRole('button', { name: '取消', exact: true }).click();
  control.releaseGeneration!();
  await expect(page.locator('.task-banner')).toHaveCount(0);
  await expect(page.getByLabel('英文文章', { exact: true })).toHaveText(body);
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  await expect(page.locator('.reading-progress')).toContainText('已覆盖 1 / 2');
  const cancelled = (await readLibraries(page)).libraries[0].session!;
  expect(cancelled.currentArticleId).toBe(snapshot.currentArticleId);
  expect(cancelled.currentUnknownIds).toEqual(snapshot.currentUnknownIds);
  expect(cancelled.coveredSenseIds).toEqual(snapshot.coveredSenseIds);
  expect(cancelled.articles).toHaveLength(1);
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect(page.locator('.reading-progress')).toContainText('已覆盖 2 / 2');
  await expect(page.locator('.unknown-chip')).toHaveCount(0);
  const retried = (await readLibraries(page)).libraries[0].session!;
  expect(retried.articles).toHaveLength(2);
  expect(retried.articles[0].unknownSenseIds).toEqual(snapshot.currentUnknownIds);
});

test('saved libraries support renaming, export and explicit deletion without losing another library', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('词库名称', { exact: true }).fill('first');
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行');
  await page.getByRole('button', { name: '保存词库', exact: true }).click();
  await expect(page.locator('.library-card')).toHaveCount(1);
  await page.getByLabel('词库名称', { exact: true }).fill('second');
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('morning\tn. 早晨');
  await page.getByRole('button', { name: '保存词库', exact: true }).click();
  await expect(page.locator('.library-card')).toHaveCount(2);
  await page.getByLabel('词库名称：first', { exact: true }).fill('renamed');
  await expect.poll(async () => (await readLibraries(page)).libraries[0].name).toBe('renamed');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.library-card').first().getByRole('button', { name: '导出 TXT', exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('renamed.txt');
  await page.locator('.library-card').first().getByRole('button', { name: '删除词库', exact: true }).click();
  await expect(page.locator('.library-card')).toHaveCount(2);
  await page.getByRole('button', { name: '保留词库', exact: true }).click();
  await expect(page.locator('.library-card')).toHaveCount(2);
  await page.locator('.library-card').first().getByRole('button', { name: '删除词库', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.locator('.library-card')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.library-card')).toHaveCount(1);
  await expect(page.getByLabel('词库名称：second', { exact: true })).toHaveValue('second');
});

test('word screening groups meanings, restores marks and creates dated independent branches for reading', async ({ page }) => {
  const control: MockControl = { failGeneration: false, generatedTargets: [], refinementRequests: [] };
  await mockApi(page, control);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('词库名称', { exact: true }).fill('核心词库');
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行\nbank\tn. 岸\nmorning\tn. 早晨');
  await page.getByRole('button', { name: '保存并快速筛词', exact: true }).click();
  await expect(page).toHaveURL(/#\/screen\//);
  await expect(page.locator('.screening-word')).toHaveCount(2);
  await expect(page.locator('.screening-summary')).toContainText('词库共 2 个单词');
  const createBranch = page.getByRole('button', { name: '创建生词分支词库', exact: true });
  const bank = page.getByRole('button', { name: /^bank，(?:标记不认识|取消标记)$/ });
  await expect(createBranch).toBeDisabled();
  await page.getByRole('button', { name: 'bank，查看释义', exact: true }).click();
  const definition = page.getByRole('dialog', { name: 'bank的释义', exact: true });
  await expect(definition.locator('.screening-meaning')).toHaveText(['银行', '岸']);
  await expect(bank).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await bank.click();
  await expect(bank).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.screening-selected-count')).toHaveText('1');
  await bank.click();
  await expect(createBranch).toBeDisabled();
  await bank.click();
  await expect.poll(async () => (await readLibraries(page)).libraries[0].screening?.unknownSenseIds.length).toBe(2);
  await page.reload();
  await expect(bank).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.screening-selected-count')).toHaveText('1');
  await createBranch.click();
  await expect(page.locator('.library-card')).toHaveCount(2);
  const first = await readLibraries(page);
  const parent = first.libraries.find(item => !item.branch)!;
  const branch = first.libraries.find(item => item.branch)!;
  expect(branch.branch).toMatchObject({ parentLibraryId: parent.id, parentLibraryName: '核心词库', createdAt: expect.any(String) });
  expect(branch.senses.map(sense => sense.meaning)).toEqual(['银行', '岸']);
  expect(branch.senses.map(sense => sense.id)).toEqual(parent.senses.filter(sense => sense.word === 'bank').map(sense => sense.id));
  expect(branch.name).toMatch(/核心词库 · 生词 \d{4}/);
  expect(parent.session).toBeNull();
  expect(control.generatedTargets).toEqual([]);
  expect(control.refinementRequests).toEqual([]);
  await page.locator('.library-card').filter({ has: page.getByLabel('词库名称：核心词库', { exact: true }) }).getByRole('button', { name: '快速筛词', exact: true }).click();
  await page.getByRole('button', { name: 'morning，标记不认识', exact: true }).click();
  await createBranch.click();
  await expect(page.locator('.library-card')).toHaveCount(3);
  const second = await readLibraries(page);
  const newer = second.libraries.find(item => item.branch && item.id !== branch.id)!;
  expect(newer.name).not.toBe(branch.name);
  expect(newer.senses.map(sense => sense.meaning)).toEqual(['银行', '岸', '早晨']);
  expect(second.libraries.find(item => item.id === branch.id)?.senses.map(sense => sense.meaning)).toEqual(['银行', '岸']);
  await page.reload();
  await expect(page.locator('.branch-library-info')).toHaveCount(2);
  await expect(page.locator('.library-card').nth(1)).toHaveAttribute('data-library-id', newer.id!);
  await page.locator(`.library-card[data-library-id="${branch.id}"]`).getByRole('button', { name: '去阅读', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '选择词库', exact: true })).toHaveValue(branch.id!);
  await page.getByRole('button', { name: '开始第一篇文章', exact: true }).click();
  await expect(page.getByLabel('英文文章', { exact: true })).toBeVisible();
  expect(control.generatedTargets?.[0]).toHaveLength(1);
  expect(['银行', '岸']).toContain(control.generatedTargets?.[0][0].meaning);
  await page.getByRole('button', { name: '读完，下一篇', exact: false }).click();
  await expect(page.locator('.reading-progress')).toContainText('已覆盖 2 / 2');
  expect(control.generatedTargets?.slice(0, 2).map(targets => targets[0].meaning).sort()).toEqual(['岸', '银行']);
  expect((await readLibraries(page)).libraries.find(item => item.id === parent.id)?.session).toBeNull();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '词库', exact: false }).click();
  await page.locator(`.library-card[data-library-id="${parent.id}"]`).getByRole('button', { name: '删除词库', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.locator('.library-card')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.library-card')).toHaveCount(2);
  await expect(page.locator('.branch-library-info').first()).toContainText('核心词库');
  expect((await readLibraries(page)).libraries.find(item => item.id === branch.id)?.session?.articles).toHaveLength(2);
});

test('desktop screening replaces word pages and shuffling keeps selected words', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/library');
  const words = Array.from({ length: 320 }, (_, index) => `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}\tn. 释义 ${index}`);
  await page.getByLabel('TXT 词库内容', { exact: true }).fill(words.join('\n'));
  await page.getByRole('button', { name: '保存并快速筛词', exact: true }).click();
  await expect(page.locator('.screening-word')).toHaveCount(300);
  const pagination = page.getByRole('navigation', { name: '筛词分页', exact: true });
  await expect(pagination).toContainText('第 1 / 2 页');
  await expect(pagination.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /显示全部词义|再显示/ })).toHaveCount(0);
  const first = page.getByRole('button', { name: /^wordaa，(?:标记不认识|取消标记)$/ });
  await first.click();
  await pagination.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.screening-word')).toHaveCount(20);
  await expect(first).toHaveCount(0);
  await expect(pagination).toContainText('第 2 / 2 页');
  await expect(pagination.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await pagination.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.locator('.screening-word')).toHaveCount(300);
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '刷新布局', exact: true }).click();
  await page.getByLabel('搜索词库单词', { exact: true }).fill('wordaa');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await first.click({ button: 'right' });
  const definition = page.locator('.screening-definition-popup');
  await expect(definition).toBeVisible();
  await definition.locator('.screening-meaning').click();
  await expect(definition).toBeVisible();
  await page.locator('#screening-title').click();
  await expect(definition).toHaveCount(0);
  await page.getByRole('button', { name: 'wordaa，查看释义', exact: true }).click();
  await expect(definition).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(definition).toHaveCount(0);
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('搜索词库单词', { exact: true }).fill('');
  await expect(page.locator('.screening-word')).toHaveCount(300);
  const panel = await page.locator('.screening-panel').boundingBox();
  expect(panel!.width).toBeGreaterThan(1400);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/desktop-screening.png' });
});

test('large mobile screening pages words and preserves marks from off-page searches', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/library');
  const words = Array.from({ length: 420 }, (_, index) => `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}\tn. 释义 ${index}`);
  await page.getByLabel('TXT 词库内容', { exact: true }).fill(words.join('\n'));
  await page.getByRole('button', { name: '保存并快速筛词', exact: true }).click();
  await expect(page.locator('.screening-word')).toHaveCount(300);
  const first = page.getByRole('button', { name: /^wordaa，(?:标记不认识|取消标记)$/ });
  const pagination = page.getByRole('navigation', { name: '筛词分页', exact: true });
  await first.click({ button: 'right' });
  await expect(page.locator('.screening-panel')).toContainText('释义 0');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await pagination.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.screening-word')).toHaveCount(120);
  await expect(first).toHaveCount(0);
  await expect(page.locator('.screening-definition-popup')).toHaveCount(0);
  await expect(pagination.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await pagination.getByRole('button', { name: '上一页', exact: true }).click();
  await page.getByLabel('搜索词库单词', { exact: true }).fill('wordpd');
  await expect(page.locator('.screening-word')).toHaveCount(1);
  await page.locator('.screening-word').click();
  await page.getByLabel('搜索词库单词', { exact: true }).fill('');
  await page.getByLabel('只看已标记', { exact: true }).check();
  await expect(page.locator('.screening-word')).toHaveCount(1);
  await page.getByLabel('只看已标记', { exact: true }).uncheck();
  await expect(page.locator('.screening-word')).toHaveCount(300);
  await pagination.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.screening-word')).toHaveCount(120);
  const marked = page.getByRole('button', { name: /^wordpd，(?:标记不认识|取消标记)$/ });
  await expect(marked).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByLabel('显示中文释义', { exact: true }).check();
  await expect(page.locator('.screening-meaning')).toHaveCount(120);
  await expect.poll(async () => (await readLibraries(page)).libraries[0].screening?.unknownSenseIds.length).toBe(1);
  await page.reload();
  await expect(page.locator('.screening-word')).toHaveCount(300);
  await pagination.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(marked).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '清空标记', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建生词分支词库', exact: true })).toBeDisabled();
  await page.locator('#screening-title').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/mobile-screening.png' });
});

test('legacy screening marks restore as a whole word and branches keep every imported meaning', async ({ page }) => {
  await page.goto('/#/library');
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('Bank\tn. 银行 v. 把钱存入银行\nbank\tn. 岸\nmorning\tn. 早晨');
  await page.getByRole('button', { name: '保存并快速筛词', exact: true }).click();
  await expect(page.locator('.screening-word')).toHaveCount(2);
  await expect.poll(async () => (await readLibraries(page)).libraries[0].senses.length).toBe(4);
  await page.evaluate(async () => {
    const stored = await (await fetch('/api/libraries')).json();
    const collection = stored.collection as LibraryCollection;
    collection.libraries[0].screening = {
      unknownSenseIds: [collection.libraries[0].senses.find(sense => sense.meaning === '岸')!.id],
      updatedAt: new Date().toISOString(),
    };
    await fetch('/api/libraries', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collection, revision: stored.revision }) });
  });
  await page.reload();
  const bank = page.getByRole('button', { name: /^bank，(?:标记不认识|取消标记)$/i });
  await expect(bank).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.screening-selected-count')).toHaveText('1');
  await page.getByLabel('搜索词库单词', { exact: true }).fill('把钱存入银行');
  await expect(page.locator('.screening-word')).toHaveCount(1);
  await bank.click({ button: 'right' });
  await expect(page.locator('.screening-definition-popup .screening-meaning')).toHaveText(['银行', '把钱存入银行', '岸']);
  await page.getByRole('button', { name: '创建生词分支词库', exact: true }).click();
  await expect(page.locator('.library-card')).toHaveCount(2);
  const collection = await readLibraries(page);
  const branch = collection.libraries.find(library => library.branch)!;
  expect(branch.senses.map(sense => sense.meaning)).toEqual(['银行', '把钱存入银行', '岸']);
  const parent = collection.libraries.find(library => !library.branch)!;
  await page.locator(`.library-card[data-library-id="${parent.id}"]`).getByRole('button', { name: '快速筛词', exact: true }).click();
  await bank.click();
  await expect(page.locator('.screening-selected-count')).toHaveText('0');
  await expect.poll(async () => (await readLibraries(page)).libraries.find(library => !library.branch)?.screening?.unknownSenseIds.length).toBe(0);
});

test('screening pagination resets on page size and queries and clamps when selected results shrink', async ({ page }) => {
  await page.goto('/#/library');
  const words = Array.from({ length: 125 }, (_, index) => `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}\tn. 释义 ${index}`);
  await page.getByLabel('TXT 词库内容', { exact: true }).fill(words.join('\n'));
  await page.getByRole('button', { name: '保存并快速筛词', exact: true }).click();
  const pagination = page.getByRole('navigation', { name: '筛词分页', exact: true });
  const pageSize = page.getByRole('combobox', { name: '每页单词数', exact: true });
  const pageNumber = page.getByRole('combobox', { name: '跳转页码', exact: true });
  await pageSize.selectOption('50');
  await expect(page.locator('.screening-word')).toHaveCount(50);
  await expect(pagination).toContainText('第 1 / 3 页');
  await pageNumber.selectOption('3');
  await expect(page.locator('.screening-word')).toHaveCount(25);
  await expect(page.getByRole('button', { name: 'wordaa，标记不认识', exact: true })).toHaveCount(0);
  await expect(pagination.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await pageSize.selectOption('100');
  await expect(pageNumber).toHaveValue('1');
  await expect(page.locator('.screening-word')).toHaveCount(100);
  await pageNumber.selectOption('2');
  await page.getByLabel('搜索词库单词', { exact: true }).fill('wordaa');
  await expect(pageNumber).toHaveValue('1');
  await expect(page.locator('.screening-word')).toHaveCount(1);
  await expect(pagination.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
  await expect(pagination.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await page.getByLabel('搜索词库单词', { exact: true }).fill('');
  await pageSize.selectOption('50');
  for (const word of await page.locator('.screening-word').all()) await word.click();
  await pageNumber.selectOption('3');
  await page.locator('.screening-word').first().click();
  await expect(page.locator('.screening-selected-count')).toHaveText('51');
  await page.getByLabel('只看已标记', { exact: true }).check();
  await expect(pageNumber).toHaveValue('1');
  await expect(page.locator('.screening-word')).toHaveCount(50);
  await pagination.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.screening-word')).toHaveCount(1);
  await page.locator('.screening-word').click();
  await expect(pageNumber).toHaveValue('1');
  await expect(page.locator('.screening-word')).toHaveCount(50);
  await expect(pagination).toContainText('第 1 / 1 页');
  await expect(page.locator('.screening-selected-count')).toHaveText('50');
  await page.getByLabel('搜索词库单词', { exact: true }).fill('no-match');
  await expect(page.locator('.screening-word')).toHaveCount(0);
  await expect(pagination).toContainText('第 1 / 1 页');
  await expect(pagination.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
  await expect(pagination.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await page.getByLabel('搜索词库单词', { exact: true }).fill('');
  await expect(page.locator('.screening-word')).toHaveCount(50);
});

test('inverse screening saves only the current page and keeps all meanings in the unknown branch', async ({ page }) => {
  await page.goto('/#/library');
  const entries = Array.from({ length: 59 }, (_, index) => `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}\tn. 释义 ${index}`);
  entries.splice(50, 0, 'bank\tn. 银行\nbank\tn. 岸');
  await page.getByLabel('TXT 词库内容', { exact: true }).fill(entries.join('\n'));
  await page.getByRole('button', { name: '保存并快速筛词', exact: true }).click();
  const mode = page.getByRole('combobox', { name: '本页标记方式', exact: true });
  const pagination = page.getByRole('navigation', { name: '筛词分页', exact: true });
  const createBranch = page.getByRole('button', { name: '创建生词分支词库', exact: true });
  await page.getByRole('combobox', { name: '每页单词数', exact: true }).selectOption('50');
  await page.getByRole('button', { name: 'wordaa，标记不认识', exact: true }).click();
  await expect.poll(async () => (await readLibraries(page)).libraries[0].screening?.unknownSenseIds.length).toBe(1);
  await pagination.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.screening-word')).toHaveCount(10);
  const secondPageWords = await page.locator('.screening-word strong').allTextContents();
  const knownWord = secondPageWords.find(word => word !== 'bank')!;
  await mode.selectOption('known');
  await expect(page.locator('.screening-word[aria-pressed="true"]')).toHaveCount(0);
  await expect(createBranch).toBeDisabled();
  expect((await readLibraries(page)).libraries[0].screening?.unknownSenseIds).toHaveLength(1);
  await page.getByRole('button', { name: `${knownWord}，标记认识`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${knownWord}，取消认识标记`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.screening-entry.known')).toHaveCount(1);
  await page.getByRole('button', { name: 'bank，查看释义', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'bank的释义', exact: true }).locator('.screening-meaning')).toHaveText(['银行', '岸']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'bank，标记认识', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect((await readLibraries(page)).libraries[0].screening?.unknownSenseIds).toHaveLength(1);
  await page.getByRole('button', { name: '保存本页筛选', exact: true }).click();
  const unknownWords = new Set(['wordaa', ...secondPageWords.filter(word => word !== knownWord)]);
  await expect.poll(async () => {
    const library = (await readLibraries(page)).libraries[0];
    return [...(library.screening?.unknownSenseIds ?? [])].sort();
  }).toEqual((await readLibraries(page)).libraries[0].senses.filter(sense => unknownWords.has(sense.word)).map(sense => sense.id).sort());
  await expect(createBranch).toBeEnabled();
  await pagination.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(mode).toHaveValue('unknown');
  await expect(page.getByRole('button', { name: 'wordaa，取消标记', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'wordab，标记不认识', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await pagination.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(mode).toHaveValue('known');
  await expect(page.getByRole('button', { name: `${knownWord}，取消认识标记`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'bank，标记认识', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect.poll(async () => {
    const library = (await readLibraries(page)).libraries[0];
    return new Set(library.senses.filter(sense => library.screening?.unknownSenseIds.includes(sense.id)).map(sense => sense.word)).size;
  }).toBe(10);
  await createBranch.click();
  await expect(page.locator('.library-card')).toHaveCount(2);
  const collection = await readLibraries(page);
  const parent = collection.libraries.find(library => !library.branch)!;
  const branch = collection.libraries.find(library => library.branch)!;
  expect(branch.senses.map(sense => sense.id).sort()).toEqual(parent.senses.filter(sense => unknownWords.has(sense.word)).map(sense => sense.id).sort());
  expect(branch.senses.filter(sense => sense.word === 'bank').map(sense => sense.meaning)).toEqual(['银行', '岸']);
  expect(branch.senses.some(sense => sense.word === knownWord)).toBe(false);
});

test('inverse page drafts survive navigation and abandoning or switching modes does not save them', async ({ page }) => {
  await page.goto('/#/library');
  const entries = Array.from({ length: 60 }, (_, index) => `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}\tn. 释义 ${index}`);
  await page.getByLabel('TXT 词库内容', { exact: true }).fill(entries.join('\n'));
  await page.getByRole('button', { name: '保存并快速筛词', exact: true }).click();
  await page.getByRole('combobox', { name: '每页单词数', exact: true }).selectOption('50');
  const mode = page.getByRole('combobox', { name: '本页标记方式', exact: true });
  const pagination = page.getByRole('navigation', { name: '筛词分页', exact: true });
  const createBranch = page.getByRole('button', { name: '创建生词分支词库', exact: true });
  await page.getByRole('button', { name: 'wordaa，标记不认识', exact: true }).click();
  await expect.poll(async () => (await readLibraries(page)).libraries[0].screening?.unknownSenseIds.length).toBe(1);
  const originalIds = (await readLibraries(page)).libraries[0].screening!.unknownSenseIds;
  await mode.selectOption('known');
  await expect(page.getByRole('button', { name: 'wordaa，标记认识', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'wordab，标记认识', exact: true }).click();
  await pagination.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(mode).toHaveValue('unknown');
  await expect(createBranch).toBeDisabled();
  await mode.selectOption('known');
  const knownOnSecondPage = page.locator('.screening-word').first();
  await knownOnSecondPage.click();
  await expect(knownOnSecondPage).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '放弃本页筛选', exact: true }).click();
  expect((await readLibraries(page)).libraries[0].screening?.unknownSenseIds).toEqual(originalIds);
  await expect(createBranch).toBeDisabled();
  await pagination.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(mode).toHaveValue('known');
  await expect(page.getByRole('button', { name: 'wordab，取消认识标记', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await mode.selectOption('unknown');
  await expect(page.getByRole('button', { name: 'wordaa，取消标记', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'wordab，标记不认识', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(createBranch).toBeEnabled();
  expect((await readLibraries(page)).libraries[0].screening?.unknownSenseIds).toEqual(originalIds);
  await page.getByRole('button', { name: 'wordab，标记不认识', exact: true }).click();
  await expect.poll(async () => (await readLibraries(page)).libraries[0].screening?.unknownSenseIds.length).toBe(2);
  await mode.selectOption('known');
  await page.getByRole('button', { name: '放弃本页筛选', exact: true }).click();
  await expect(createBranch).toBeEnabled();
  expect((await readLibraries(page)).libraries[0].screening?.unknownSenseIds).toHaveLength(2);
  await mode.selectOption('unknown');
  await mode.selectOption('known');
  await page.getByRole('button', { name: 'wordaa，标记认识', exact: true }).click();
  await page.getByLabel('搜索词库单词', { exact: true }).fill('no-match');
  await expect(page.locator('.screening-word')).toHaveCount(0);
  await expect(createBranch).toBeDisabled();
  await page.getByRole('button', { name: '放弃全部未保存反选', exact: true }).click();
  await expect(createBranch).toBeEnabled();
  expect((await readLibraries(page)).libraries[0].screening?.unknownSenseIds).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole('button', { name: 'wordaa，取消标记', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'wordab，取消标记', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('inverse screening confirms the displayed search subset without adding unseen words', async ({ page }) => {
  await page.goto('/#/library');
  await page.getByLabel('TXT 词库内容', { exact: true }).fill('bank\tn. 银行\nbank\tn. 岸\nmorning\tn. 早晨\nevening\tn. 傍晚\nsun\tn. 太阳');
  await page.getByRole('button', { name: '保存并快速筛词', exact: true }).click();
  await page.getByRole('button', { name: 'morning，标记不认识', exact: true }).click();
  await expect.poll(async () => (await readLibraries(page)).libraries[0].screening?.unknownSenseIds.length).toBe(1);
  await page.getByLabel('搜索词库单词', { exact: true }).fill('bank');
  await expect(page.locator('.screening-word')).toHaveCount(1);
  await page.getByRole('combobox', { name: '本页标记方式', exact: true }).selectOption('known');
  await page.getByRole('button', { name: '保存本页筛选', exact: true }).click();
  await expect.poll(async () => (await readLibraries(page)).libraries[0].screening?.unknownSenseIds.length).toBe(3);
  const library = (await readLibraries(page)).libraries[0];
  expect(library.senses.filter(sense => library.screening?.unknownSenseIds.includes(sense.id)).map(sense => sense.meaning)).toEqual(['银行', '岸', '早晨']);
  await page.getByLabel('搜索词库单词', { exact: true }).fill('');
  await expect(page.getByRole('combobox', { name: '本页标记方式', exact: true })).toHaveValue('unknown');
  await expect(page.getByRole('button', { name: 'bank，取消标记', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'evening，标记不认识', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'sun，标记不认识', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('mobile import and reading fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, { failGeneration: false, lateTarget: true });
  await page.goto('/');
  await page.screenshot({ path: 'test-results/mobile-welcome.png', fullPage: true });
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容').fill('bank\tn. 银行');
  await page.getByRole('button', { name: '智能拆分词义', exact: true }).click();
  await saveAndStart(page);
  await expect(page.getByLabel('英文文章')).toBeVisible();
  await expect(page).toHaveURL(/#\/read$/);
  const target = page.locator('.target-word').first();
  await target.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await target.click();
  const card = page.getByLabel('当前词义', { exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator('.sense-definition')).toContainText('银行');
  await expect(page.locator('.unknown-chip')).toHaveCount(1);
  const bounds = await card.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: 'test-results/mobile-reader.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a rewritten decision definition is isolated and requires review without stopping later batches', async ({ page }) => {
  const requestedWords: string[][] = [];
  await page.route('**/api/chat/completions', async route => {
    const request = route.request().postDataJSON();
    const input = JSON.parse(request.messages[1].content) as { sourceId: string; word: string; meaning: string }[];
    requestedWords.push(input.map(item => item.word));
    const result = { items: input.map(item => ({ sourceId: item.sourceId, meanings: item.word === 'decision' ? ['决策'] : ['银行', '岸'] })) };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }) });
  });
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  const text = ['decision\tn. 决定；决心', ...Array.from({ length: 20 }, (_, index) => 'word' + String.fromCharCode(97 + index) + '\tn. 银行；岸')].join('\n');
  await page.getByLabel('TXT 词库内容').fill(text);
  await page.getByRole('button', { name: '智能拆分词义', exact: true }).click();
  await expect(page.locator('.refinement-summary')).toContainText('已处理 21 / 21 条');
  await expect(page.locator('.refinement-summary')).toContainText('待确认 1 条');
  expect(requestedWords.map(batch => batch.length)).toEqual([20, 1, 1]);
  expect(requestedWords[1]).toEqual(['decision']);
  await expect(page.getByRole('button', { name: '保存词库', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '只看待确认', exact: true }).click();
  await expect(page.getByLabel('中文释义', { exact: true })).toHaveValue('决定；决心');
  await page.getByRole('button', { name: '按分号拆分', exact: true }).click();
  await expect(page.getByLabel('中文释义', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: '确认词义', exact: true }).first().click();
  await page.getByRole('button', { name: '确认词义', exact: true }).first().click();
  await expect(page.getByRole('button', { name: '保存词库', exact: true })).toBeEnabled();
  await expect.poll(async () => (await readImportDraft(page))?.reviewSenseIds.length ?? -1).toBe(0);
  await page.reload();
  await expect(page.locator('.refinement-summary')).toContainText('待确认 0 条');
  await expect(page.getByLabel('中文释义', { exact: true })).toHaveCount(42);
  expect(requestedWords).toHaveLength(3);
});

test('cancelled splitting resumes after refresh without calling completed vocabulary again', async ({ page }) => {
  const batches: string[][] = [];
  let releasePending: (() => void) | undefined;
  let blockOnce = true;
  await page.route('**/api/chat/completions', async route => {
    const request = route.request().postDataJSON();
    const input = JSON.parse(request.messages[1].content) as { sourceId: string; meaning: string }[];
    batches.push(input.map(item => item.sourceId));
    if (input.length === 1 && blockOnce) {
      blockOnce = false;
      await new Promise<void>(resolve => { releasePending = resolve; });
    }
    const result = { items: input.map(item => ({ sourceId: item.sourceId, meanings: [item.meaning] })) };
    try {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }) });
    } catch { /* Request may have been cancelled by the browser. */ }
  });
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: '词库', exact: false }).click();
  await page.getByLabel('TXT 词库内容').fill(Array.from({ length: 21 }, (_, index) => 'word' + String.fromCharCode(97 + index) + '\tn. 词义').join('\n'));
  await page.getByRole('button', { name: '智能拆分词义', exact: true }).click();
  await expect(page.locator('.refinement-summary')).toContainText('已处理 20 / 21 条');
  await expect.poll(() => Boolean(releasePending)).toBe(true);
  await page.locator('.task-banner').getByRole('button', { name: '取消', exact: true }).click();
  releasePending?.();
  await expect(page.getByRole('button', { name: '继续拆分剩余词条', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator('.refinement-summary')).toContainText('已处理 20 / 21 条');
  await page.getByRole('button', { name: '继续拆分剩余词条', exact: true }).click();
  await expect(page.locator('.refinement-summary')).toContainText('已处理 21 / 21 条');
  await expect(page.getByRole('button', { name: '保存词库', exact: true })).toBeEnabled();
  expect(batches.map(batch => batch.length)).toEqual([20, 1, 1]);
  expect(batches[2]).toEqual(['import-21-1']);
});

import { useEffect, useRef, useState } from 'react';
import Reader from './components/Reader';
import SettingsPanel from './components/SettingsPanel';
import { VocabularyScreening } from './components/VocabularyScreening';
import { createBranchLibrary } from './domain/libraries';
import { groupScreeningWords } from './domain/screening';
import { decodeVocabulary, parseVocabulary } from './domain/import';
import { createSession, finishArticle, getCurrentArticle, getPrefetchTargets, selectNextTargets, acceptArticle, setPreparedArticle, toggleUnknown } from './domain/session';
import { clearImportDraft, loadImportDraft, loadLibraries, loadSettings, saveImportDraft, saveLibraries, saveSettings } from './domain/storage';
import type { ApiSettings, ArticleOccurrence, ImportDraft, LearningSession, LibraryCollection, ReadingOptions, RefinementCheckpoint, Sense, Workspace } from './domain/types';
import { generateArticle } from './services/articles';
import { ApiError } from './services/client';
import { refineSenses, refinementPreview } from './services/vocabulary';

type Tab = 'learn' | 'library' | 'settings' | 'read' | 'screen';

function pageFromHash(): Tab {
  const page = window.location.hash.replace(/^#\/?/, '');
  if (page.startsWith('screen/')) return 'screen';
  return page === 'read' || page === 'library' || page === 'settings' ? page : 'learn';
}

function screeningIdFromHash(): string | null {
  const match = window.location.hash.match(/^#\/screen\/(.+)$/);
  try { return match ? decodeURIComponent(match[1]) : null; }
  catch { return null; }
}

const emptySettings: ApiSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
};

const now = () => new Date().toISOString();
const defaultReadingOptions: ReadingOptions = { targetCount: 20, expectedWordCount: 400 };

function App() {
  const [tab, updateTab] = useState<Tab>(pageFromHash);
  const [screeningLibraryId, setScreeningLibraryId] = useState<string | null>(screeningIdFromHash);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [libraries, setLibraries] = useState<LibraryCollection>({ version: 1, libraries: [], activeLibraryId: null });
  const [settings, setSettings] = useState<ApiSettings>(emptySettings);
  const [importText, setImportText] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ReturnType<typeof parseVocabulary> | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [loading, setLoading] = useState(true);
  const [storageReady, setStorageReady] = useState(false);
  const [encoding, setEncoding] = useState<'auto' | 'utf-8' | 'gb18030'>('auto');
  const [refined, setRefined] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewLimit, setPreviewLimit] = useState(100);
  const fileBufferRef = useRef<ArrayBuffer | null>(null);
  const workspaceRef = useRef<Workspace | null>(null);
  const taskRef = useRef(false);
  const importRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const prefetchRef = useRef<AbortController | null>(null);
  const prefetchBusyRef = useRef(false);
  const [prefetchStatus, setPrefetchStatus] = useState('');
  const [historyArticleId, setHistoryArticleId] = useState<string | null>(null);
  const [readingOptions, setReadingOptions] = useState<ReadingOptions>(defaultReadingOptions);
  const [deleteLibraryId, setDeleteLibraryId] = useState<string | null>(null);
  const [expandedLibraries, setExpandedLibraries] = useState<string[]>([]);
  const [libraryLimits, setLibraryLimits] = useState<Record<string, number>>({});
  const prefetchJobRef = useRef<Promise<void> | null>(null);
  const prefetchAttemptRef = useRef('');
  const [prefetchRevision, setPrefetchRevision] = useState(0);
  const librariesRef = useRef<LibraryCollection>({ version: 1, libraries: [], activeLibraryId: null });
  const [checkpoint, setCheckpoint] = useState<RefinementCheckpoint | null>(null);
  const [reviewSenseIds, setReviewSenseIds] = useState<string[]>([]);
  const [reviewOnly, setReviewOnly] = useState(false);
  const draftRef = useRef<ImportDraft | null>(null);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setTab = (next: Tab) => {
    updateTab(next);
    if (window.location.hash !== `#/${next}`) window.location.hash = `/${next}`;
  };

  useEffect(() => {
    const restorePage = () => {
      updateTab(pageFromHash());
      setScreeningLibraryId(screeningIdFromHash());
    };
    window.addEventListener('hashchange', restorePage);
    return () => window.removeEventListener('hashchange', restorePage);
  }, []);

  const applyDraft = (draft: ImportDraft, persist = true) => {
    draftRef.current = draft;
    setImportText(draft.sourceText);
    setFileName(draft.name);
    setEncoding(draft.encoding);
    setPreview(draft.preview);
    setCheckpoint(draft.checkpoint);
    setReviewSenseIds(draft.reviewSenseIds);
    setRefined(draft.refined);
    if (!persist) return;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      draftSaveTimer.current = null;
      const latest = draftRef.current;
      if (latest) void saveImportDraft(latest).catch((error: unknown) => setNotice({ tone: 'error', text: error instanceof Error ? error.message : '保存导入草稿失败。' }));
    }, 350);
  };

  const updateDraftPreview = (next: ReturnType<typeof parseVocabulary>, reviews = reviewSenseIds) => {
    if (!draftRef.current) return;
    applyDraft({ ...draftRef.current, preview: next, reviewSenseIds: reviews });
  };

  useEffect(() => {
    let active = true;
    Promise.allSettled([loadLibraries(), Promise.resolve().then(loadSettings), loadImportDraft()]).then(([librariesResult, settingsResult, draftResult]) => {
      if (!active) return;
      if (librariesResult.status === 'fulfilled') {
        setStorageReady(true);
        librariesRef.current = librariesResult.value;
        setLibraries(librariesResult.value);
        const selected = librariesResult.value.libraries.find(item => item.id === librariesResult.value.activeLibraryId) ?? librariesResult.value.libraries[0] ?? null;
        if (selected) {
          const collection = { ...librariesResult.value, activeLibraryId: selected.id ?? null };
          librariesRef.current = collection;
          setLibraries(collection);
          setWorkspace(selected);
          workspaceRef.current = selected;
          setReadingOptions(selected.readingOptions ?? defaultReadingOptions);
          if (!window.location.hash && selected.session && getCurrentArticle(selected.session)) setTab('read');
        }
      }
      if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value);
      if (draftResult.status === 'fulfilled' && draftResult.value) {
        applyDraft(draftResult.value, false);
        if ((librariesResult.status !== 'fulfilled' || !librariesResult.value.libraries.length) && (!window.location.hash || pageFromHash() === 'learn')) setTab('library');
      }
      const errors = [librariesResult, settingsResult, draftResult].filter((result) => result.status === 'rejected').map((result) => result.reason instanceof Error ? result.reason.message : '读取本机数据失败');
      if (errors.length) setNotice({ tone: 'error', text: errors.join('；') });
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; abortRef.current?.abort(); prefetchRef.current?.abort(); if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current); };
  }, []);

  const persistCollection = (nextCollection: LibraryCollection, nextWorkspace: Workspace | null = workspaceRef.current) => {
    librariesRef.current = nextCollection;
    setLibraries(nextCollection);
    if (nextWorkspace) {
      workspaceRef.current = nextWorkspace;
      setWorkspace(nextWorkspace);
    }
    void saveLibraries(nextCollection).catch((error) => setNotice({ tone: 'error', text: error instanceof Error ? error.message : '无法保存词库。' }));
  };

  const updateWorkspace = (next: Workspace) => {
    const id = next.id;
    if (!id) return;
    const nextCollection = { ...librariesRef.current, activeLibraryId: id, libraries: librariesRef.current.libraries.map(item => item.id === id ? next : item) };
    workspaceRef.current = next;
    persistCollection(nextCollection, next);
  };

  const commitWorkspace = async (next: Workspace) => {
    if (!next.id) throw new Error('词库编号缺失。');
    const nextCollection = { ...librariesRef.current, activeLibraryId: next.id, libraries: librariesRef.current.libraries.some(item => item.id === next.id)
      ? librariesRef.current.libraries.map(item => item.id === next.id ? next : item)
      : [...librariesRef.current.libraries, next] };
    await saveLibraries(nextCollection);
    librariesRef.current = nextCollection;
    setLibraries(nextCollection);
    workspaceRef.current = next;
    setWorkspace(next);
  };

  const installPreview = (text: string, name = fileName, selectedEncoding = encoding) => {
    applyDraft({ version: 1, name, sourceText: text, encoding: selectedEncoding, preview: parseVocabulary(text), checkpoint: null, reviewSenseIds: [], refined: false });
    setSelectedIds([]);
    setReviewOnly(false);
    setPreviewLimit(100);
  };

  const readFile = async (file: File) => {
    const requestId = ++importRef.current;
    try {
      const buffer = await file.arrayBuffer();
      if (requestId !== importRef.current) return;
      const text = decodeVocabulary(buffer, encoding);
      fileBufferRef.current = buffer;
      setFileName(file.name);
      installPreview(text, file.name);
      setTab('library');
      setNotice({ tone: 'info', text: `已读取 ${file.name}。检查本地识别的词义后保存词库，AI 拆分为可选操作。` });
    } catch (error) {
      if (requestId !== importRef.current) return;
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '文件读取失败，请检查编码。' });
    }
  };

  const previewText = (value: string) => {
    importRef.current += 1;
    fileBufferRef.current = null;
    installPreview(value, fileName);
  };

  const requireSettings = () => {
    if (!settings.configured || !settings.model) {
      setNotice({ tone: 'error', text: '请先在设置中填写 API Key 和模型名。' });
      setTab('settings');
      return false;
    }
    return true;
  };

  const handleTaskError = (error: unknown) => {
    if (abortRef.current?.signal.aborted) setNotice({ tone: 'info', text: '操作已暂停，已完成的词义整理和学习进度已保留。' });
    else setNotice({ tone: 'error', text: error instanceof Error ? error.message : '操作失败，请重试。' });
  };

  const organizeSenses = async () => {
    const draft = draftRef.current;
    if (!draft?.preview.senses.length || draft.refined || taskRef.current || !requireSettings()) return;
    taskRef.current = true;
    setBusy(true);
    setProgress('正在恢复整理进度…');
    setSelectedIds([]);
    try {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
      await refineSenses(draft.checkpoint?.sources ?? draft.preview.senses, settings, controller.signal, setProgress, {
        checkpoint: draft.checkpoint,
        onCheckpoint: async (nextCheckpoint) => {
          const nextDraft: ImportDraft = {
            ...draft,
            preview: { ...draft.preview, senses: refinementPreview(nextCheckpoint) },
            checkpoint: nextCheckpoint,
            reviewSenseIds: nextCheckpoint.entries.filter(entry => entry.issue).flatMap(entry => entry.senses.map(sense => sense.id)),
            refined: nextCheckpoint.entries.length === nextCheckpoint.sources.length,
          };
          applyDraft(nextDraft, false);
          await saveImportDraft(nextDraft);
        },
      });
      const reviews = draftRef.current?.reviewSenseIds.length ?? 0;
      setNotice(reviews
        ? { tone: 'info', text: `整理完成，${reviews} 个词义保留了原释义，需手动检查后确认。其余结果和进度已保存。` }
        : { tone: 'success', text: '词义整理完成，结果已保存。请检查并确认词库。' });
    } catch (error) {
      if (abortRef.current?.signal.aborted) handleTaskError(error);
      else setNotice({ tone: 'error', text: (error instanceof Error ? error.message : '整理失败。') + (error instanceof ApiError ? ' 已完成部分已保存，点击“继续拆分剩余词条”即可恢复。' : ' 本机保存未完成，请保持页面开启后重试，当前结果仍在页面中。') });
    } finally {
      setBusy(false);
      setProgress('');
      taskRef.current = false;
    }
  };
  const skipRefinement = () => {
    const draft = draftRef.current;
    if (!draft || taskRef.current) return;
    applyDraft({ ...draft, checkpoint: null, reviewSenseIds: [], refined: false });
    setReviewOnly(false);
    setSelectedIds([]);
    setNotice({ tone: 'info', text: '已跳过 AI 拆分，保留当前识别结果。检查词义后可直接确认并开始学习。' });
  };

  const startLibrary = async (screenAfterSave = false) => {
    if (!preview?.senses.length || (checkpoint && !refined) || taskRef.current) return;
    if (reviewSenseIds.length) {
      setNotice({ tone: 'error', text: '请先检查并确认待处理的词义，再保存词库。' });
      setReviewOnly(true);
      return;
    }
    if (preview.senses.some((sense) => !sense.word.trim() || !sense.meaning.trim())) {
      setNotice({ tone: 'error', text: '单词和中文释义不能为空，请修改后再保存。' });
      return;
    }
    taskRef.current = true;
    setBusy(true);
    try {
      const senses = preview.senses.map((sense) => ({ ...sense, word: sense.word.trim(), meaning: sense.meaning.trim(), partOfSpeech: sense.partOfSpeech.trim() }));
      cancelPrefetch();
      const next: Workspace = { version: 1, id: crypto.randomUUID(), name: fileName.trim() || '我的词库 ' + (librariesRef.current.libraries.length + 1), sourceText: importText, senses, session: null, readingOptions: { ...defaultReadingOptions }, archivedSessions: [], updatedAt: now() };
      await commitWorkspace(next);
      setReadingOptions(next.readingOptions!);
      setHistoryArticleId(null);
      draftRef.current = null;
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
      setPreview(null);
      setCheckpoint(null);
      setReviewSenseIds([]);
      setImportText('');
      setFileName('');
      setNotice({ tone: 'success', text: screenAfterSave ? '词库已保存。点击不认识的单词，再创建生词分支词库。' : '词库已保存。到阅读页选择词库、覆盖数量和篇幅，再开始第一篇。' });
      if (screenAfterSave) openScreening(next.id!);
      void clearImportDraft().catch((error: unknown) => setNotice({ tone: 'error', text: error instanceof Error ? error.message : '清除导入草稿失败，但词库已保存。' }));
    } catch (error) { handleTaskError(error); }
    finally { taskRef.current = false; setBusy(false); setProgress(''); }
  };

  const generateNext = async (baseWorkspace: Workspace, session: LearningSession) => {
    const options = baseWorkspace.readingOptions ?? defaultReadingOptions;
    const targets = selectNextTargets(session, baseWorkspace.senses, options.targetCount);
    if (targets.length === 0) throw new Error('没有可生成的目标词义，请检查学习队列。');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(`正在为 ${targets.length} 个词义编织语境…`);
      const generated = await generateArticle(targets, settings, controller.signal, setProgress, options);
      if (controller.signal.aborted) throw new Error('操作已取消');
      const accepted = acceptArticle(session, generated);
      const nextWorkspace = { ...baseWorkspace, session: accepted, updatedAt: now() };
      await commitWorkspace(nextWorkspace);
      setHistoryArticleId(null);
      setTab('read');
      setNotice({ tone: 'success', text: `文章已生成，覆盖 ${generated.targetSenseIds.length} 个词义。` });
  };

  const nextArticle = async () => {
    if (!workspaceRef.current?.session || taskRef.current) return;
    if (!requireSettings()) return;
    taskRef.current = true;
    setBusy(true);
    setProgress('正在保存本轮标记…');
    const nextController = new AbortController();
    abortRef.current = nextController;
    try {
      if (prefetchJobRef.current) {
        setProgress('下一篇正在准备，等待验证完成…');
        await prefetchJobRef.current;
      }
      if (nextController.signal.aborted) throw new ApiError('cancelled', '已取消，当前文章和标记保持不变。');
      const currentWorkspace = workspaceRef.current;
      if (!currentWorkspace?.session) return;
      const completedSession = getCurrentArticle(currentWorkspace.session) ? finishArticle(currentWorkspace.session, Math.random) : currentWorkspace.session;
      const saved = { ...currentWorkspace, session: completedSession, updatedAt: now() };
      if (completedSession.phase === 'complete') {
        await commitWorkspace(saved);
        setTab('learn');
        setNotice({ tone: 'success', text: '这一轮复习完成了。你可以重新开始一轮，或者导入新的词库。' });
        return;
      }
      if (completedSession.preparedArticle) {
        const accepted = acceptArticle(completedSession, completedSession.preparedArticle);
        await commitWorkspace({ ...saved, session: accepted });
        setHistoryArticleId(null);
        setTab('read');
        setNotice({ tone: 'success', text: '已打开提前生成的下一篇，上一篇标记已保存。' });
        return;
      }
      await generateNext(saved, completedSession);
    } catch (error) {
      handleTaskError(error);
    } finally {
      setBusy(false);
      setProgress('');
      taskRef.current = false;
    }
  };

  const markUnknown = (senseId: string) => {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace?.session || taskRef.current) return;
    const nextSession = toggleUnknown(currentWorkspace.session, senseId);
    updateWorkspace({ ...currentWorkspace, session: nextSession, updatedAt: now() });
  };

  const addLookup = (sense: Sense, occurrence: ArticleOccurrence) => {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace?.session || taskRef.current) return;
    const currentArticle = getCurrentArticle(currentWorkspace.session);
    if (!currentArticle || currentArticle.body.slice(occurrence.start, occurrence.end) !== occurrence.surface) return;
    const senses = currentWorkspace.senses.some((item) => item.id === sense.id) ? currentWorkspace.senses : [...currentWorkspace.senses, sense];
    const articles = currentWorkspace.session.articles.map((item) => item.id === currentArticle.id ? { ...item, occurrences: [...item.occurrences.filter((entry) => entry.start !== occurrence.start), occurrence].sort((left, right) => left.start - right.start) } : item);
    const sessionWithLookup = { ...currentWorkspace.session, articles };
    const nextSession = sessionWithLookup.currentUnknownIds.includes(sense.id) ? sessionWithLookup : toggleUnknown(sessionWithLookup, sense.id);
    updateWorkspace({ ...currentWorkspace, senses, session: nextSession, updatedAt: now() });
  };

  const editSense = (id: string, field: 'word' | 'partOfSpeech' | 'meaning', value: string) => {
    if (!preview || busy) return;
    updateDraftPreview({ ...preview, senses: preview.senses.map((sense) => sense.id === id ? { ...sense, [field]: value } : sense) });
  };

  const mergeSelected = () => {
    if (!preview || busy) return;
    const selected = preview.senses.filter((sense) => selectedIds.includes(sense.id));
    if (selected.length < 2) return;
    if (selected.some((sense) => sense.word.toLowerCase() !== selected[0].word.toLowerCase() || sense.partOfSpeech !== selected[0].partOfSpeech)) {
      setNotice({ tone: 'error', text: '只能合并同一个词、同一种词性的义项。' });
      return;
    }
    const merged = { ...selected[0], meaning: [...new Set(selected.map((sense) => sense.meaning.trim()))].join('；') };
    const reviews = reviewSenseIds.filter(id => !selectedIds.includes(id));
    if (selectedIds.some(id => reviewSenseIds.includes(id))) reviews.push(merged.id);
    updateDraftPreview({ ...preview, senses: preview.senses.map((sense) => sense.id === merged.id ? merged : sense).filter((sense) => sense.id === merged.id || !selectedIds.includes(sense.id)) }, reviews);
    setSelectedIds([]);
  };

  const changeEncoding = (value: 'auto' | 'utf-8' | 'gb18030') => {
    setEncoding(value);
    if (!fileBufferRef.current) { if (draftRef.current) applyDraft({ ...draftRef.current, encoding: value }); return; }
    try { installPreview(decodeVocabulary(fileBufferRef.current, value), fileName, value); }
    catch (error) { setNotice({ tone: 'error', text: error instanceof Error ? error.message : '编码不匹配。' }); }
  };

  const splitSense = (sense: Sense) => {
    if (!preview || busy) return;
    const meanings = sense.meaning.split(/[；;]/).map(value => value.trim()).filter(Boolean);
    if (meanings.length < 2) {
      setNotice({ tone: 'info', text: '可以先用分号分开不同含义，再点击“按分号拆分”；同义解释可保留在一起。' });
      return;
    }
    const pieces = meanings.map(meaning => ({ ...sense, id: crypto.randomUUID(), meaning }));
    const reviews = reviewSenseIds.filter(id => id !== sense.id);
    if (reviewSenseIds.includes(sense.id)) reviews.push(...pieces.map(piece => piece.id));
    updateDraftPreview({ ...preview, senses: preview.senses.flatMap(entry => entry.id === sense.id ? pieces : [entry]) }, reviews);
  };
  const restart = async () => {
    const current = workspaceRef.current;
    if (!current || taskRef.current || !requireSettings()) return;
    taskRef.current = true;
    setBusy(true);
    try {
      if (!Number.isInteger(readingOptions.targetCount) || readingOptions.targetCount < 1 || readingOptions.targetCount > 50
        || !Number.isSafeInteger(readingOptions.expectedWordCount) || readingOptions.expectedWordCount < 1) {
        throw new Error('每篇覆盖数量需为 1–50 个词义，预期长度需为正整数。');
      }
      cancelPrefetch();
      const archive = current.session ? {
        ...current.session,
        preparedArticle: null,
        articles: current.session.articles.map(item => item.id === current.session!.currentArticleId ? { ...item, unknownSenseIds: [...current.session!.currentUnknownIds] } : item),
      } : null;
      const archivedSessions = archive ? [...(current.archivedSessions ?? []), archive] : current.archivedSessions ?? [];
      const next = { ...current, readingOptions: { ...readingOptions }, archivedSessions };
      await generateNext(next, createSession(current.senses.filter(sense => sense.origin === 'import')));
    }
    catch (error) { handleTaskError(error); }
    finally { taskRef.current = false; setBusy(false); setProgress(''); }
  };

  function cancelPrefetch() {
    prefetchRef.current?.abort();
    prefetchRef.current = null;
    prefetchJobRef.current = null;
    prefetchBusyRef.current = false;
    prefetchAttemptRef.current = '';
    setPrefetchStatus('');
  }

  const retryPrefetch = () => {
    if (busy) return;
    cancelPrefetch();
    setPrefetchRevision(value => value + 1);
  };

  const selectLibrary = (id: string) => {
    if (taskRef.current || workspaceRef.current?.id === id) return;
    const selected = librariesRef.current.libraries.find(item => item.id === id);
    if (!selected) return;
    cancelPrefetch();
    setHistoryArticleId(null);
    setReadingOptions(selected.readingOptions ?? defaultReadingOptions);
    persistCollection({ ...librariesRef.current, activeLibraryId: id }, selected);
  };

  const deleteLibrary = async (id: string) => {
    if (taskRef.current) return;
    taskRef.current = true;
    setBusy(true);
    cancelPrefetch();
    const remaining = librariesRef.current.libraries.filter(item => item.id !== id);
    const selected = remaining.find(item => item.id === workspaceRef.current?.id) ?? remaining[0] ?? null;
    const next: LibraryCollection = { version: 1, libraries: remaining, activeLibraryId: selected?.id ?? null };
    try {
      await saveLibraries(next);
      librariesRef.current = next;
      setLibraries(next);
      workspaceRef.current = selected;
      setWorkspace(selected);
      setReadingOptions(selected?.readingOptions ?? defaultReadingOptions);
      setHistoryArticleId(null);
      setDeleteLibraryId(null);
    } catch (error) { handleTaskError(error); }
    finally { taskRef.current = false; setBusy(false); }
  };

  const renameLibrary = (id: string, name: string) => {
    const nextCollection = { ...librariesRef.current, libraries: librariesRef.current.libraries.map(item => item.id === id ? { ...item, name, updatedAt: now() } : item) };
    const active = nextCollection.libraries.find(item => item.id === nextCollection.activeLibraryId) ?? null;
    persistCollection(nextCollection, active);
  };

  const openScreening = (id: string) => {
    setNotice(null);
    setScreeningLibraryId(id);
    updateTab('screen');
    window.location.hash = '/screen/' + encodeURIComponent(id);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const saveScreening = (id: string, unknownSenseIds: string[]) => {
    if (taskRef.current) return;
    const timestamp = now();
    const nextCollection = {
      ...librariesRef.current,
      libraries: librariesRef.current.libraries.map(item => item.id === id
        ? { ...item, screening: { unknownSenseIds, updatedAt: timestamp }, updatedAt: timestamp } : item),
    };
    const active = nextCollection.libraries.find(item => item.id === nextCollection.activeLibraryId) ?? null;
    persistCollection(nextCollection, active);
  };

  const saveBranch = async (id: string) => {
    if (taskRef.current) return;
    const parent = librariesRef.current.libraries.find(item => item.id === id);
    if (!parent) return;
    taskRef.current = true;
    setBusy(true);
    setProgress('正在保存生词分支词库…');
    try {
      const branch = createBranchLibrary(parent, parent.screening?.unknownSenseIds ?? []);
      const baseName = branch.name;
      let duplicateNumber = 2;
      while (librariesRef.current.libraries.some(item => item.name === branch.name)) {
        branch.name = `${baseName}（${duplicateNumber}）`;
        duplicateNumber += 1;
      }
      cancelPrefetch();
      await commitWorkspace(branch);
      setReadingOptions(branch.readingOptions ?? defaultReadingOptions);
      setHistoryArticleId(null);
      setTab('library');
      setNotice({ tone: 'success', text: `已创建「${branch.name}」，包含 ${groupScreeningWords(branch.senses).length} 个生词（${branch.senses.length} 个词义）。到阅读页可选择这份分支词库生成文章。` });
    } catch (error) { handleTaskError(error); }
    finally { taskRef.current = false; setBusy(false); setProgress(''); }
  };

  const exportLibrary = (item: Workspace) => {
    const content = item.senses.filter(sense => sense.origin === 'import').map(sense => `${sense.word}\t${sense.partOfSpeech} ${sense.meaning}`).join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = (item.name.trim() || '词库') + '.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  const currentSession = workspace?.session ?? null;
  const article = currentSession ? getCurrentArticle(currentSession) : null;
  const history = [...(workspace?.archivedSessions ?? []), ...(currentSession ? [currentSession] : [])].flatMap(session => session.articles);
  const displayedArticle = historyArticleId ? history.find(item => item.id === historyArticleId) ?? article : article;
  const isHistory = Boolean(displayedArticle && displayedArticle.id !== article?.id);
  const currentPhaseLabel = currentSession?.phase === 'coverage' ? '首次覆盖' : currentSession?.phase === 'review' ? '生词复习' : '已完成';
  const coveredCount = currentSession?.coveredSenseIds.filter((id) => workspace?.senses.some((sense) => sense.id === id && sense.origin === 'import')).length ?? 0;
  const totalCount = workspace?.senses.filter((sense) => sense.origin === 'import').length ?? 0;
  const pending = currentSession?.phase === 'coverage' ? currentSession.remainingSenseIds.length : currentSession?.reviewPendingIds.length ?? 0;
  const unknownIds = currentSession?.currentUnknownIds ?? [];
  const roundTotal = currentSession?.phase === 'review' ? currentSession.reviewSenseIds.length : totalCount;
  const roundCovered = currentSession?.phase === 'review' ? roundTotal - currentSession.reviewPendingIds.length : coveredCount;
  const previewLocked = busy || Boolean(checkpoint && !refined);
  const canStartLibrary = Boolean(preview?.senses.length && (!checkpoint || refined) && !reviewSenseIds.length);
  const visibleSenses = (preview?.senses ?? []).filter(sense => !reviewOnly || reviewSenseIds.includes(sense.id));
  const screeningLibrary = libraries.libraries.find(item => item.id === screeningLibraryId);
  const orderedLibraries: Workspace[] = [];
  const visitedLibraries = new Set<string>();
  const appendLibrary = (item: Workspace) => {
    if (!item.id || visitedLibraries.has(item.id)) return;
    visitedLibraries.add(item.id);
    orderedLibraries.push(item);
    libraries.libraries.filter(child => child.branch?.parentLibraryId === item.id)
      .sort((first, second) => second.branch!.createdAt.localeCompare(first.branch!.createdAt))
      .forEach(appendLibrary);
  };
  libraries.libraries.filter(item => !item.branch || !libraries.libraries.some(parent => parent.id === item.branch!.parentLibraryId)).forEach(appendLibrary);
  libraries.libraries.forEach(appendLibrary);

  useEffect(() => {
    if (tab === 'read') window.scrollTo({ top: 0, behavior: 'auto' });
  }, [tab, displayedArticle?.id]);

  useEffect(() => {
    const current = workspaceRef.current;
    if (loading || busy || !settings.configured || !current?.session || !getCurrentArticle(current.session)) return;
    if (current.session.preparedArticle) { setPrefetchStatus('下一篇已准备好'); return; }
    const options = current.readingOptions ?? defaultReadingOptions;
    const key = [current.id, current.session.id, current.session.currentArticleId, settings.model, settings.baseUrl].join(':');
    if (prefetchAttemptRef.current === key || prefetchBusyRef.current) return;
    const targets = getPrefetchTargets(current.session, current.senses, options.targetCount);
    if (!targets.length) { setPrefetchStatus('本轮最后一篇；提交标记后再生成下一轮'); return; }
    prefetchAttemptRef.current = key;
    prefetchBusyRef.current = true;
    const controller = new AbortController();
    prefetchRef.current = controller;
    setPrefetchStatus('正在后台准备下一篇…');
    const job = (async () => {
      try {
        const generated = await generateArticle(targets, settings, controller.signal, message => {
          if (!controller.signal.aborted) setPrefetchStatus('下一篇：' + message);
        }, options);
        const latest = workspaceRef.current;
        if (controller.signal.aborted || latest?.id !== current.id || latest?.session?.id !== current.session!.id
          || latest.session.currentArticleId !== current.session!.currentArticleId) return;
        const updated = { ...latest, session: setPreparedArticle(latest.session, generated), updatedAt: now() };
        updateWorkspace(updated);
        setPrefetchStatus('下一篇已准备好');
      } catch (error) {
        if (!controller.signal.aborted) setPrefetchStatus('下一篇准备失败：' + (error instanceof Error ? error.message : '请稍后重试'));
      } finally {
        if (prefetchRef.current === controller) {
          prefetchBusyRef.current = false;
          prefetchRef.current = null;
          prefetchJobRef.current = null;
        }
      }
    })();
    prefetchJobRef.current = job;
  }, [loading, busy, workspace?.id, article?.id, settings.configured, settings.model, settings.baseUrl, prefetchRevision]);

  return (
    <div className={tab === 'screen' ? 'app-shell screening-mode' : tab === 'read' ? 'app-shell reading-mode' : 'app-shell'}>
      <header className="topbar">
        <button className="brand" onClick={() => setTab('learn')} aria-label="回到学习">
          <span className="brand-mark">文</span>
          <span><strong>悦读词</strong><small>YOURWORD</small></span>
        </button>
        <div className="topbar-meta">
          {workspace && <span className="workspace-pill"><i />{workspace.name}</span>}
          <button className="icon-button" aria-label="打开设置" onClick={() => setTab('settings')}>⚙</button>
        </div>
      </header>

      <main className={tab === 'screen' ? 'page-wrap screening-page-wrap' : tab === 'read' ? 'page-wrap reading-page-wrap' : 'page-wrap'}>
        <nav className="tabbar" aria-label="主导航">
          <button className={tab === 'learn' || tab === 'read' ? 'active' : ''} onClick={() => setTab('learn')}><span>◒</span>阅读</button>
          <button className={tab === 'library' || tab === 'screen' ? 'active' : ''} onClick={() => setTab('library')}><span>▤</span>词库</button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><span>⌘</span>连接设置</button>
        </nav>
        {!loading && !storageReady && <div className="notice error" role="alert">学习数据读取或迁移失败，已暂停词库编辑和阅读操作。请保留旧浏览器数据，检查后端服务后刷新重试。</div>}
        <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={loading || (!storageReady && tab !== 'settings')}>
        {tab === 'read' && <div className="reading-page-toolbar"><button className="secondary-button" onClick={() => { setHistoryArticleId(null); setTab('learn'); }}>← 阅读设置与历史</button>{isHistory && <button className="text-button" onClick={() => { setHistoryArticleId(null); if (!article) setTab('learn'); }}>返回当前阅读</button>}</div>}

        {notice && <div className={`notice ${notice.tone}`} role="status"><span>{notice.tone === 'error' ? '!' : notice.tone === 'success' ? '✓' : 'i'}</span>{notice.text}<button onClick={() => setNotice(null)} aria-label="关闭提示">×</button></div>}
        {busy && <div className="task-banner" role="status"><span className="spinner" />{progress || '正在处理中…'}<button onClick={() => { abortRef.current?.abort(); if (prefetchRef.current) { prefetchRef.current.abort(); setPrefetchStatus('下一篇准备已取消'); } }}>取消</button></div>}
        {loading && <div className="empty-state">正在恢复本机学习进度…</div>}

        {!loading && tab === 'library' && (
          <section className="library-page">
            <div className="page-heading"><div><p className="eyebrow">YOUR WORD BANK</p><h1>我的词库</h1><p>导入后快速标出生词，按时间保存分支词库，再到阅读页生成文章。</p></div><label className="upload-button">选择 TXT 文件<input disabled={busy} type="file" accept=".txt,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); event.target.value = ''; }} /></label></div>
            <div className="saved-libraries" aria-label="已保存词库">
              {orderedLibraries.map(item => <article className={`library-card panel${item.branch ? ' branch-library-card' : ''}`} key={item.id} data-library-id={item.id}>
                {item.branch && <p className="branch-library-info">生词分支 · 来源：{libraries.libraries.find(parent => parent.id === item.branch!.parentLibraryId)?.name ?? item.branch.parentLibraryName}<br /><time dateTime={item.branch.createdAt}>{new Date(item.branch.createdAt).toLocaleString('zh-CN', { hour12: false })}</time></p>}
                <label>词库名称<input aria-label={'词库名称：' + item.name} disabled={busy} value={item.name} onChange={event => renameLibrary(item.id!, event.target.value)} /></label>
                <p>{item.senses.filter(sense => sense.origin === 'import').length} 个独立词义 · {(item.archivedSessions ?? []).reduce((count, session) => count + session.articles.length, item.session?.articles.length ?? 0)} 篇文章</p>
                <details onToggle={event => { const open = event.currentTarget.open; setExpandedLibraries(previous => open ? [...new Set([...previous, item.id!])] : previous.filter(id => id !== item.id)); }}><summary>查看词库内容</summary>{expandedLibraries.includes(item.id!) && <div className="library-word-preview">{item.senses.filter(sense => sense.origin === 'import').slice(0, libraryLimits[item.id!] ?? 100).map(sense => <p key={sense.id}><strong>{sense.word}</strong> <small>{sense.partOfSpeech}</small> {sense.meaning}</p>)}{item.senses.length > (libraryLimits[item.id!] ?? 100) && <button className="text-button" onClick={() => setLibraryLimits(previous => ({ ...previous, [item.id!]: (previous[item.id!] ?? 100) + 100 }))}>显示更多词义</button>}</div>}</details>
                {Boolean(item.screening?.unknownSenseIds.length) && <p>快速筛词已标记 {groupScreeningWords(item.senses).filter(word => word.senses.some(sense => item.screening!.unknownSenseIds.includes(sense.id))).length} 个生词</p>}
                <div className="action-group"><button className="primary-button" disabled={busy || !item.senses.length} onClick={() => openScreening(item.id!)}>快速筛词</button><button className="secondary-button" disabled={busy} onClick={() => { selectLibrary(item.id!); setTab('learn'); }}>去阅读</button><button className="secondary-button" onClick={() => exportLibrary(item)}>导出 TXT</button><button className="text-button" disabled={busy} onClick={() => setDeleteLibraryId(item.id!)}>删除词库</button></div>
                {deleteLibraryId === item.id && <div className="delete-confirm" role="alert"><p>删除这份词库及其学习进度、文章历史？</p><button className="secondary-button" disabled={busy} onClick={() => void deleteLibrary(item.id!)}>确认删除</button><button className="text-button" onClick={() => setDeleteLibraryId(null)}>保留词库</button></div>}
              </article>)}
              {!libraries.libraries.length && <p className="muted">还没有保存的词库，先导入一份 TXT。</p>}
            </div>
            <h2 className="import-section-title">导入新词库</h2>
            <label className="import-name">词库名称<input disabled={busy} value={fileName} placeholder="例如：四级核心词汇" onChange={event => { setFileName(event.target.value); if (draftRef.current) applyDraft({ ...draftRef.current, name: event.target.value }); }} /></label>
            <div className="library-toolbar"><label>文件编码 <select disabled={busy} value={encoding} onChange={(event) => changeEncoding(event.target.value as 'auto' | 'utf-8' | 'gb18030')}><option value="auto">自动识别</option><option value="utf-8">UTF-8</option><option value="gb18030">GB18030 / GBK</option></select></label>{workspace && <span>当前词库：{workspace.name} · {totalCount} 个导入词义</span>}</div>
            <div className="import-grid">
              <div className="panel import-editor"><div className="panel-title"><span>01 / 原始词库</span><small>{fileName || '单词 + Tab + 中文释义'}</small></div><textarea disabled={busy} aria-label="TXT 词库内容" value={importText} onChange={(event) => previewText(event.target.value)} placeholder={'revolt\tn. 反抗；造反，起义 v. 起义；反抗\nbank\tn. 银行；岸'} spellCheck={false} /></div>
              <div className="panel import-preview"><div className="panel-title"><span>02 / {refined ? '独立词义' : '本地识别结果'}</span>{preview && <small>{preview.senses.length} 个对象 · 去重 {preview.duplicateCount}</small>}</div>{preview ? <>
                {checkpoint && <div className="refinement-summary" role="status">已处理 {checkpoint.entries.length} / {checkpoint.sources.length} 条 · 待确认 {reviewSenseIds.length} 条{!refined && <small>完成的结果已保存，可暂停或刷新后继续。</small>}</div>}
                <div className="preview-toolbar"><span>{refined ? '检查整理结果' : '检查词义后保存'}</span>{reviewSenseIds.length > 0 && <button onClick={() => setReviewOnly(value => !value)}>{reviewOnly ? '显示全部' : '只看待确认'}</button>}<button disabled={previewLocked || selectedIds.length < 2} onClick={mergeSelected}>合并选中</button><button disabled={previewLocked || !selectedIds.length} onClick={() => { updateDraftPreview({ ...preview, senses: preview.senses.filter(sense => !selectedIds.includes(sense.id)) }, reviewSenseIds.filter(id => !selectedIds.includes(id))); setSelectedIds([]); }}>删除选中</button></div>
                <div className="sense-list">{visibleSenses.slice(0, previewLimit).map((sense) => <div className={reviewSenseIds.includes(sense.id) ? "sense-preview-row needs-review" : "sense-preview-row"} key={sense.id}><div className="editable-sense">
                  <input type="checkbox" disabled={previewLocked} aria-label={'选择 ' + sense.word + ' ' + sense.meaning} checked={selectedIds.includes(sense.id)} onChange={() => setSelectedIds((ids) => ids.includes(sense.id) ? ids.filter((id) => id !== sense.id) : [...ids, sense.id])} />
                  <input className="sense-word" disabled={previewLocked} aria-label="单词" value={sense.word} onChange={(event) => editSense(sense.id, 'word', event.target.value)} />
                  <input className="sense-pos" disabled={previewLocked} aria-label="词性" value={sense.partOfSpeech} placeholder="词性" onChange={(event) => editSense(sense.id, 'partOfSpeech', event.target.value)} />
                  <input className="sense-meaning" disabled={previewLocked} aria-label="中文释义" value={sense.meaning} onChange={(event) => editSense(sense.id, 'meaning', event.target.value)} />
                </div>{reviewSenseIds.includes(sense.id) && <div className="sense-review-note"><span>保留了原释义，请检查不同含义是否需要拆开。</span><div><button disabled={previewLocked} onClick={() => splitSense(sense)}>按分号拆分</button><button disabled={previewLocked || !sense.meaning.trim()} onClick={() => updateDraftPreview(preview, reviewSenseIds.filter(id => id !== sense.id))}>确认词义</button></div></div>}</div>)}{visibleSenses.length > previewLimit && <button className="text-button" onClick={() => setPreviewLimit((value) => value + 100)}>显示更多（剩余 {visibleSenses.length - previewLimit}）</button>}{preview.issues.map((issue) => <div className="issue-row" key={`${issue.line}-${issue.message}`}>第 {issue.line} 行：{issue.message}<small>{issue.text}</small></div>)}</div>
              </> : <div className="empty-state"><span className="empty-icon">⌁</span><p>等一个词库，开启一段故事</p><small>粘贴 TXT 内容，或选择本机文件</small></div>}</div>
            </div>
            <div className="library-actions"><span className="muted">保存与筛词不调用模型。AI 拆分为可选操作，已有词库和进度会保留。</span><div className="action-group">{checkpoint && (!refined || reviewSenseIds.length > 0) && <button className="secondary-button" disabled={busy} onClick={skipRefinement}>跳过 AI 拆分，使用当前词义</button>}<button className="secondary-button" disabled={!preview?.senses.length || busy || refined} onClick={() => void organizeSenses()}>{refined ? '词义整理完成' : checkpoint ? '继续拆分剩余词条' : '智能拆分词义'}</button><button className="secondary-button" disabled={!canStartLibrary || busy} onClick={() => void startLibrary(true)}>保存并快速筛词</button><button className="primary-button" disabled={!canStartLibrary || busy} onClick={() => void startLibrary()}>保存词库</button></div></div>
          </section>
        )}

        {!loading && tab === 'screen' && (screeningLibrary
          ? <VocabularyScreening key={screeningLibrary.id} library={screeningLibrary} busy={busy} onChange={ids => saveScreening(screeningLibrary.id!, ids)} onCreate={() => void saveBranch(screeningLibrary.id!)} onClose={() => setTab('library')} />
          : <div className="panel article-empty"><h2>这份词库已不存在</h2><button className="secondary-button" onClick={() => setTab('library')}>返回词库</button></div>)}

        {!loading && tab === 'settings' && <SettingsPanel settings={settings} onSave={async (next) => { cancelPrefetch(); const saved = await saveSettings(next); setSettings(saved); setPrefetchRevision(value => value + 1); setNotice({ tone: 'success', text: '连接设置已保存到本机后端。' }); return saved; }} busy={busy} />}

        {!loading && tab === 'learn' && (
          <section className="learn-page">
            {!workspace && <div className="welcome-card"><div className="welcome-copy"><p className="eyebrow">READ YOUR WAY IN</p><h1>让词语在故事里<br /><i>变得有意义。</i></h1><p>导入你的词库，在文章中遇见每个词义。完成首次覆盖，再让生词一次次回到新语境里。</p><button className="primary-button" onClick={() => setTab('library')}>导入我的词库 <span>→</span></button></div><div className="welcome-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><span className="art-character">文</span><span className="art-word word-a">context</span><span className="art-word word-b">意味</span><span className="art-word word-c">story</span></div></div>}
            {workspace && <>
              <div className="page-heading"><div><p className="eyebrow">READ YOUR WAY IN</p><h1>在文章中遇见词语</h1><p>选择词库与每篇规模。随机抽取尚未覆盖的词义，读完全部后再复习生词。</p></div></div>
              <form className="reading-setup panel" onSubmit={event => { event.preventDefault(); void restart(); }}>
                <div className="reading-controls">
                  <label>选择词库<select value={workspace.id} disabled={busy} onChange={event => selectLibrary(event.target.value)}>{libraries.libraries.map(item => <option key={item.id} value={item.id}>{item.name || '未命名词库'} · {item.senses.filter(sense => sense.origin === 'import').length} 个词义</option>)}</select></label>
                  <label>每篇覆盖词义数量<input type="number" min="1" max="50" step="1" required disabled={busy} value={readingOptions.targetCount || ''} onChange={event => setReadingOptions(previous => ({ ...previous, targetCount: Number(event.target.value) }))} /></label>
                  <label>预期长度（英文词）<input type="number" min="1" step="1" required disabled={busy} value={readingOptions.expectedWordCount || ''} onChange={event => setReadingOptions(previous => ({ ...previous, expectedWordCount: Number(event.target.value) }))} /></label>
                </div>
                <p className="muted">每批最多 50 个独立词义。模型按词义关系自主分组，可生成多段短文或句组，优先保证逻辑自洽，相关词尽量组成连贯长段落。预期长度仅供参考。DeepSeek 已开启思考。</p>
                <div className="action-group"><button className="primary-button" type="submit" disabled={busy}>{currentSession ? '按此设置重新开始第一篇' : '开始第一篇文章'}</button>{article && <button className="secondary-button" type="button" disabled={busy} onClick={() => { setHistoryArticleId(null); setTab('read'); }}>继续当前进度 →</button>}</div>
                {currentSession && <p className="field-hint">重新开始会保留已有文章历史，并重新随机抽词。</p>}
              </form>
              {currentSession && <div className="learn-heading"><div><p className="eyebrow">{currentPhaseLabel}{currentSession.phase === 'review' ? ' · ROUND ' + currentSession.reviewRound : currentSession.phase === 'coverage' ? ' · 第 0 轮' : ''}</p><h2>{currentSession.phase === 'complete' ? '这一轮没有生词了' : workspace.name}</h2><p>本轮需覆盖 {roundTotal} 个词义 · 已覆盖 {roundCovered} 个 · 待覆盖 {pending} 个</p></div><div className="progress-card"><strong>{roundCovered}<small> / {roundTotal}</small></strong><span>本轮词义已验证覆盖</span><div className="progress-track"><i style={{ width: `${roundTotal ? Math.min(100, roundCovered / roundTotal * 100) : 0}%` }} /></div></div></div>}
              {article && <div className="article-preview panel"><p className="eyebrow">CURRENT ARTICLE · 当前文章</p><h2>{article.title}</h2><p className="muted">{article.wordCount} 词 · {article.targetSenseIds.length} 个目标词义 · 已标记 {unknownIds.length} 个生词义</p><p className="article-preview-excerpt" lang="en">{article.body.slice(0, 220)}{article.body.length > 220 ? '…' : ''}</p><p className="prefetch-note" role="status">{prefetchStatus}</p><button className="primary-button" onClick={() => { setHistoryArticleId(null); setTab('read'); }}>继续阅读 →</button></div>}
              {history.length > 0 && <section className="history-section" aria-label="历史文章"><h2>文章历史 <small>{history.length} 篇</small></h2><div className="history-list">{[...history].reverse().map(item => <button className="history-item panel" key={item.id} onClick={() => { setHistoryArticleId(item.id); setTab('read'); }}><span><strong>{item.title}</strong><small>{item.phase === 'review' ? '复习第 ' + item.reviewRound + ' 轮' : '首次覆盖 · 第 0 轮'} · {item.wordCount} 词 · 本篇 {item.targetSenseIds.length} 个词义</small><small>本轮覆盖 {item.roundCovered ?? item.targetSenseIds.length} / {item.roundTotal ?? totalCount} · {item.id === article?.id ? '正在阅读' : item.finishedAt ? '已读完' : '已生成'}</small></span><span aria-hidden="true">回顾 →</span></button>)}</div></section>}
            </>}
          </section>
        )}
        {!loading && tab === 'read' && (
          <section className="reading-page" aria-label="文章阅读页">
            {displayedArticle && workspace ? <>
              <div className="learn-heading reading-progress"><div><p className="eyebrow">{displayedArticle.phase === 'review' ? '生词复习 · ROUND ' + displayedArticle.reviewRound + ' · 第 ' + displayedArticle.reviewRound + ' 轮' : '首次覆盖 · 第 0 轮'}{isHistory ? ' · 历史回顾' : ''}</p><p>本轮需覆盖 {displayedArticle.roundTotal ?? roundTotal} 个词义 · 当前已覆盖 {isHistory ? displayedArticle.roundCovered ?? 0 : roundCovered} 个{!isHistory && ' · 待覆盖 ' + pending + ' 个'}</p></div><span>已覆盖 {isHistory ? displayedArticle.roundCovered ?? 0 : roundCovered} / {displayedArticle.roundTotal ?? roundTotal}</span></div>
              {!isHistory && (prefetchStatus.startsWith('下一篇准备失败') || prefetchStatus === '下一篇准备已取消') && <button className="secondary-button" disabled={busy} onClick={retryPrefetch}>重试准备下一篇</button>}
              <Reader article={displayedArticle} senses={workspace.senses} unknownIds={isHistory ? displayedArticle.unknownSenseIds ?? [] : unknownIds} busy={busy} settings={settings} onToggleUnknown={markUnknown} onAddLookup={addLookup} onNext={() => void nextArticle()} readOnly={isHistory} onReturn={() => { setHistoryArticleId(null); if (!article) setTab('learn'); }} nextStatus={isHistory ? undefined : prefetchStatus} />
            </> : <div className="article-empty panel"><h2>还没有可阅读的文章</h2><p>先导入词库并生成文章，再在这里阅读和标记生词。</p><button className="primary-button" onClick={() => setTab('library')}>导入词库</button></div>}
          </section>
        )}
        </fieldset>
      </main>
      <footer className="footer"><span>悦读词 / Yourword</span><span>词库与学习记录保存在本机后端</span></footer>
    </div>
  );
}

export default App;

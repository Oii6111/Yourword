import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { contextForToken, tokenizeArticle, type ReadingToken } from '../domain/reading';
import type { ApiSettings, Article, ArticleOccurrence, Sense } from '../domain/types';
import { lookupSense } from '../services/vocabulary';

interface ReaderProps {
  article: Article;
  senses: Sense[];
  unknownIds: string[];
  busy: boolean;
  settings: ApiSettings;
  onToggleUnknown: (senseId: string) => void;
  onAddLookup: (sense: Sense, occurrence: ArticleOccurrence) => void;
  onNext: () => void;
  readOnly?: boolean;
  onReturn?: () => void;
  nextStatus?: string;
}

interface WordSelection {
  token: ReadingToken;
  context: string;
  status: 'ready' | 'loading' | 'error';
  sense?: Sense;
  error?: string;
}

export default function Reader({ article, senses, unknownIds, busy, settings, onToggleUnknown, onAddLookup, onNext, readOnly = false, onReturn, nextStatus }: ReaderProps) {
  const [selection, setSelection] = useState<WordSelection | null>(null);
  const request = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const currentArticleId = useRef(article.id);
  const lookupCache = useRef(new Map<string, Sense>());
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const card = useRef<HTMLElement | null>(null);
  const [cardPosition, setCardPosition] = useState({ left: 16, top: 100 });
  currentArticleId.current = article.id;
  const tokens = useMemo(() => tokenizeArticle(article), [article]);
  const sensesById = useMemo(() => new Map(senses.map((sense) => [sense.id, sense])), [senses]);
  const unknownSet = useMemo(() => new Set(unknownIds), [unknownIds]);
  const unknownRef = useRef(new Set(unknownIds));
  unknownRef.current = new Set(unknownIds);
  const unknownSenses = unknownIds.map((senseId) => sensesById.get(senseId)).filter((sense): sense is Sense => Boolean(sense));
  const loadingLookup = selection?.status === 'loading';

  const cancelRequest = useCallback(() => {
    requestVersion.current += 1;
    request.current?.abort();
    request.current = null;
  }, []);

  const closeCard = useCallback(() => {
    cancelRequest();
    setSelection(null);
    selectedButton.current?.focus({ preventScroll: true });
  }, [cancelRequest]);

  useEffect(() => {
    cancelRequest();
    lookupCache.current.clear();
    setSelection(null);
    selectedButton.current = null;
    return cancelRequest;
  }, [article.id, readOnly, cancelRequest]);

  useEffect(() => {
    if (!selection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || card.current?.contains(event.target)) return;
      cancelRequest();
      setSelection(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeCard();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [selection, closeCard, cancelRequest]);

  useLayoutEffect(() => {
    if (!selection) return;
    const positionCard = () => {
      const anchor = selectedButton.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(320, window.innerWidth - 32);
      const height = card.current?.getBoundingClientRect().height ?? 280;
      const left = Math.max(16, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 16));
      const below = anchor.bottom + 10;
      const top = below + height <= window.innerHeight - 16 ? below : Math.max(16, anchor.top - height - 10);
      setCardPosition({ left, top });
    };
    positionCard();
    window.addEventListener('resize', positionCard);
    window.addEventListener('scroll', positionCard, true);
    return () => {
      window.removeEventListener('resize', positionCard);
      window.removeEventListener('scroll', positionCard, true);
    };
  }, [selection]);

  async function loadDefinition(token: ReadingToken, context: string) {
    if (readOnly) return;
    cancelRequest();
    const controller = new AbortController();
    request.current = controller;
    const version = requestVersion.current;
    const articleId = article.id;
    setSelection({ token, context, status: 'loading' });
    try {
      const sense = await lookupSense(token.text, context, settings, controller.signal);
      if (controller.signal.aborted || requestVersion.current !== version || currentArticleId.current !== articleId) return;
      lookupCache.current.set(`${token.start}:${token.end}`, sense);
      unknownRef.current.add(sense.id);
      onAddLookup(sense, { senseId: sense.id, start: token.start, end: token.end, surface: token.text });
      setSelection({ token, context, status: 'ready', sense });
    } catch (error) {
      if (controller.signal.aborted || requestVersion.current !== version || currentArticleId.current !== articleId) return;
      setSelection({ token, context, status: 'error', error: error instanceof Error ? error.message : '查义失败，请重试。' });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  function selectToken(token: ReadingToken, button: HTMLButtonElement) {
    if (!readOnly && busy) return;
    selectedButton.current = button;
    const context = contextForToken(article.body, token.start, token.end);
    const sense = token.senseId ? sensesById.get(token.senseId) : lookupCache.current.get(`${token.start}:${token.end}`);
    if (sense) {
      cancelRequest();
      if (!readOnly) {
        if (unknownRef.current.has(sense.id)) unknownRef.current.delete(sense.id);
        else unknownRef.current.add(sense.id);
        onToggleUnknown(sense.id);
      }
      setSelection({ token, context, status: 'ready', sense });
    } else if (readOnly) {
      setSelection({ token, context, status: 'ready' });
    } else {
      void loadDefinition(token, context);
    }
  }

  const selectedSense = selection?.sense;
  const selectedIsUnknown = selectedSense ? unknownSet.has(selectedSense.id) : false;

  function toggleMark(senseId: string) {
    if (readOnly || busy) return;
    if (unknownRef.current.has(senseId)) unknownRef.current.delete(senseId);
    else unknownRef.current.add(senseId);
    onToggleUnknown(senseId);
  }

  return (
    <section className="reader-panel" aria-labelledby="article-title">
      <div className="reader-heading">
        <div><p className="eyebrow">CONTEXT READING · 语境阅读</p><h2 id="article-title">{article.title}</h2></div>
        <span className="theme-label">{article.theme}</span>
      </div>
      <div className="article-meta"><span>{article.wordCount} 词</span><span>覆盖 {article.targetSenseIds.length} 个词义</span><span>预期约 {article.targetWordCount} 词</span></div>
      {Boolean(article.verificationWarnings?.length) && <details className="prefetch-note"><summary>词义提示（{article.verificationWarnings!.length} 条，不影响阅读）</summary><p>以下表达可能稍显生硬或含义不够明确，请结合语境判断。</p><ul>{article.verificationWarnings!.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
      <p className="reading-hint">{readOnly ? '这是历史文章。点击词语可查看当时保存的中文释义。' : '点击任意词查看本句词义，并自动标记为不认识。再次点击可取消标记。绿色下划线是目标词，橙色是本轮生词。'}</p>
      <div className="reader-layout">
        <div className="article-body" lang="en" aria-label="英文文章">
          {tokens.map((token) => token.kind === 'text' ? token.text : (
            <button key={`${token.start}:${token.end}`} type="button"
              className={`word-token${token.kind === 'target' ? ' target-word' : ''}${token.senseId && unknownSet.has(token.senseId) ? ' unknown-word' : ''}${selection?.token.start === token.start ? ' selected-word' : ''}`}
              disabled={!readOnly && busy} onClick={(event) => selectToken(token, event.currentTarget)}
              aria-controls={selection?.token.start === token.start ? 'word-sense-card' : undefined}
              aria-label={readOnly ? `${token.text}，查看历史释义` : token.senseId && unknownSet.has(token.senseId) ? `${token.text}，已标记不认识，再次点击取消标记并查看释义` : `${token.text}，查看释义并自动标记不认识`}
              aria-pressed={Boolean(token.senseId && unknownSet.has(token.senseId))}>
              {token.text}
            </button>
          ))}
        </div>
        {selection ? (
          <aside ref={card} id="word-sense-card" className="sense-card" style={cardPosition} aria-label="当前词义" aria-live="polite" aria-busy={loadingLookup}>
            <div className="sense-card-heading"><span className="eyebrow">IN THIS CONTEXT · 本句词义</span><button type="button" className="icon-button" onClick={closeCard} aria-label="关闭词义卡片">×</button></div>
            <h3>{selectedSense?.word ?? selection.token.text}</h3>
            {selection.status === 'loading' && <p className="status-message">正在理解这段语境…</p>}
            {selection.status === 'error' && <><p className="status-message error-message" role="alert">{selection.error}</p>{!readOnly && <button type="button" className="secondary-button" disabled={busy} onClick={() => void loadDefinition(selection.token, selection.context)}>重新查义</button>}</>}
            {selectedSense && <><p className="sense-definition"><span className="part-of-speech">{selectedSense.partOfSpeech || '词义'}</span> {selectedSense.meaning}</p>{!readOnly && <><p className="sense-state">{selectedIsUnknown ? '已加入本轮生词' : '已取消生词标记'}</p><button type="button" className={selectedIsUnknown ? 'secondary-button' : 'primary-button'} disabled={busy} onClick={() => toggleMark(selectedSense.id)}>{selectedIsUnknown ? '认识了，取消标记' : '标记为不认识'}</button></>}</>}
            {readOnly && !selectedSense && <p className="status-message">这处普通词没有保存的词义注解。</p>}
            <blockquote lang="en" className="sense-context">{selection.context}</blockquote><p className="card-hint">{readOnly ? '历史文章不会改变生词标记。按 Esc 可关闭。' : '只记录这个语境里的词义。按 Esc 可关闭。'}</p>
          </aside>
        ) : null}
      </div>
      <div className="unknown-list"><div className="unknown-list-heading"><h3>本篇生词</h3><span>{unknownSenses.length} 个词义</span></div>
        {unknownSenses.length > 0 ? <div className="unknown-chips">{unknownSenses.map((sense) => readOnly ? <span className="unknown-chip" key={sense.id}><strong>{sense.word}</strong><span>{sense.meaning}</span></span> : <button type="button" className="unknown-chip" key={sense.id} disabled={busy} onClick={() => toggleMark(sense.id)} aria-label={`取消 ${sense.word}：${sense.meaning} 的生词标记`}><strong>{sense.word}</strong><span>{sense.meaning}</span><span aria-hidden="true">×</span></button>)}</div> : <p className="muted">还没有标记生词。全部读懂了，就继续下一篇。</p>}
      </div>
      <div className="reader-footer">{readOnly ? <><p>这是历史文章，当前标记不会改变。</p><button type="button" className="secondary-button" onClick={onReturn}>返回当前阅读<span aria-hidden="true"> ↩</span></button></> : <><p>完成阅读后，当前标记会保存到下一轮复习。</p><button type="button" className="primary-button" disabled={busy || loadingLookup} onClick={onNext}>{busy ? '正在生成下一篇…' : '读完，下一篇'}<span aria-hidden="true"> →</span></button></>}{nextStatus && <span className="next-status" role="status">{nextStatus}</span>}</div>
    </section>
  );
}

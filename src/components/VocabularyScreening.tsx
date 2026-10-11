import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../domain/types';
import { applyScreeningPageSelection, expandScreeningSenseIds, groupScreeningWords } from '../domain/screening';

interface VocabularyScreeningProps {
  library: Workspace;
  busy: boolean;
  onChange: (unknownSenseIds: string[]) => void;
  onCreate: () => void;
  onClose: () => void;
}

interface DefinitionPopup {
  wordId: string;
  left: number;
  top: number;
}

type SelectionMode = 'unknown' | 'known';

export function VocabularyScreening({ library, busy, onChange, onCreate, onClose }: VocabularyScreeningProps) {
  const words = useMemo(() => groupScreeningWords(library.senses), [library.senses]);
  const [query, setQuery] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [showMeanings, setShowMeanings] = useState(false);
  const [pageSize, setPageSize] = useState(300);
  const [page, setPage] = useState(1);
  const [orderIds, setOrderIds] = useState<string[] | null>(null);
  const [pageModes, setPageModes] = useState<Record<string, SelectionMode>>({});
  const [knownDrafts, setKnownDrafts] = useState<Record<string, string[]>>({});
  const [popup, setPopup] = useState<DefinitionPopup | null>(null);
  const popupRef = useRef<HTMLElement | null>(null);
  const popupAnchor = useRef<HTMLElement | null>(null);
  const selectedIds = useMemo(() => new Set(expandScreeningSenseIds(library.senses, library.screening?.unknownSenseIds ?? [])), [library.senses, library.screening?.unknownSenseIds]);
  const wordsById = useMemo(() => new Map(words.map((word) => [word.id, word])), [words]);
  const orderedWords = useMemo(() => orderIds
    ? orderIds.flatMap((wordId) => { const word = wordsById.get(wordId); return word ? [word] : []; })
    : words, [orderIds, wordsById, words]);
  const filteredWords = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return orderedWords.filter((word) => (!selectedOnly || word.senses.some((sense) => selectedIds.has(sense.id)))
      && (!search || `${word.word} ${word.senses.map((sense) => `${sense.partOfSpeech} ${sense.meaning}`).join(' ')}`.toLocaleLowerCase().includes(search)));
  }, [orderedWords, query, selectedOnly, selectedIds]);
  const selectedCount = words.filter((word) => word.senses.some((sense) => selectedIds.has(sense.id))).length;
  const pageCount = Math.max(1, Math.ceil(filteredWords.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleWords = filteredWords.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const visibleWordIds = visibleWords.map((word) => word.id);
  const pageKey = JSON.stringify(visibleWordIds);
  const selectionMode = pageModes[pageKey] ?? 'unknown';
  const knownDraft = knownDrafts[pageKey];
  const hasPageDraft = knownDraft !== undefined;
  const knownSelectedIds = new Set(knownDraft ?? visibleWords.filter((word) => !word.senses.some((sense) => selectedIds.has(sense.id))).map((word) => word.id));
  const pendingPageCount = Object.keys(knownDrafts).length;
  const popupWord = popup ? wordsById.get(popup.wordId) : undefined;

  useEffect(() => {
    setPage((previous) => Math.min(previous, pageCount));
  }, [pageCount]);

  useEffect(() => {
    setPopup(null);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [currentPage, pageSize, query, selectedOnly]);

  useLayoutEffect(() => {
    if (!popup || !popupRef.current) return;
    const bounds = popupRef.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(popup.left, window.innerWidth - bounds.width - 12));
    const top = Math.max(12, Math.min(popup.top, window.innerHeight - bounds.height - 12));
    if (left !== popup.left || top !== popup.top) setPopup({ ...popup, left, top });
  }, [popup]);

  useEffect(() => {
    if (!popup) return;
    function closeOutside(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && (popupRef.current?.contains(target) || popupAnchor.current?.contains(target))) return;
      setPopup(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setPopup(null);
    }
    function closeOnScroll(event: Event) {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return;
      setPopup(null);
    }
    function closeOnResize() { setPopup(null); }
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [popup]);

  function toggleUnknown(wordId: string) {
    const word = wordsById.get(wordId);
    if (!word) return;
    const nextIds = new Set(selectedIds);
    const selected = word.senses.some((sense) => nextIds.has(sense.id));
    for (const sense of word.senses) {
      if (selected) nextIds.delete(sense.id);
      else nextIds.add(sense.id);
    }
    onChange(expandScreeningSenseIds(library.senses, [...nextIds]));
  }

  function changeSelectionMode(mode: SelectionMode) {
    setPopup(null);
    setPageModes((previous) => ({ ...previous, [pageKey]: mode }));
    setKnownDrafts((previous) => {
      const next = { ...previous };
      if (mode === 'known') next[pageKey] = [];
      else delete next[pageKey];
      return next;
    });
  }

  function toggleWord(wordId: string) {
    if (selectionMode === 'unknown') { toggleUnknown(wordId); return; }
    const next = new Set(knownSelectedIds);
    if (next.has(wordId)) next.delete(wordId);
    else next.add(wordId);
    setKnownDrafts((previous) => ({ ...previous, [pageKey]: [...next] }));
  }

  function discardPageDraft() {
    setKnownDrafts((previous) => {
      const next = { ...previous };
      delete next[pageKey];
      return next;
    });
  }

  function savePageSelection() {
    if (busy || !hasPageDraft) return;
    onChange(applyScreeningPageSelection(library.senses, [...selectedIds], visibleWordIds, [...knownSelectedIds], 'known'));
    discardPageDraft();
  }

  function openDefinition(wordId: string, anchor: HTMLElement, toggle = false) {
    if (toggle && popup?.wordId === wordId) { setPopup(null); return; }
    const bounds = anchor.getBoundingClientRect();
    popupAnchor.current = anchor;
    setPopup({ wordId, left: Math.max(12, Math.min(bounds.left, window.innerWidth - 292)), top: bounds.bottom + 9 });
  }

  function shuffleWords() {
    const nextIds = words.map((word) => word.id);
    for (let index = nextIds.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [nextIds[index], nextIds[swapIndex]] = [nextIds[swapIndex], nextIds[index]];
    }
    setOrderIds(nextIds);
    setPage(1);
    setPopup(null);
  }

  return (
    <section className="screening-panel" aria-labelledby="screening-title">
      <aside className="screening-control-panel">
        <div className="screening-heading">
          <div>
            <p className="eyebrow">VOCABULARY CHECK</p>
            <h2 id="screening-title">快速筛选生词</h2>
          </div>
          <button type="button" className="screening-return" onClick={onClose} disabled={busy}>返回词库</button>
        </div>
        <p className="screening-library-name">{library.name}</p>
        <div className="screening-toolbar">
          <label className="screening-selection-mode">本页标记方式<select value={selectionMode} disabled={busy || !visibleWords.length} onChange={(event) => changeSelectionMode(event.target.value as SelectionMode)}><option value="unknown">正选：标记不认识</option><option value="known">反选：标记认识</option></select></label>
          <label className="screening-search">
            <span>搜索词库单词</span>
            <input
              type="search"
              value={query}
              placeholder="搜索单词、词性或中文释义"
              onChange={(event) => { setQuery(event.target.value); setPage(1); setPopup(null); }}
            />
          </label>
          <div className="screening-filters">
            <label className="screening-check"><input type="checkbox" checked={showMeanings} onChange={(event) => { setShowMeanings(event.target.checked); setPopup(null); }} />显示中文释义</label>
            <label className="screening-check"><input type="checkbox" checked={selectedOnly} onChange={(event) => { setSelectedOnly(event.target.checked); setPage(1); setPopup(null); }} />只看已标记</label>
          </div>
          <div className="screening-small-actions">
            <button type="button" onClick={shuffleWords}>刷新布局</button>
            <button type="button" disabled={busy || (selectedCount === 0 && pendingPageCount === 0)} onClick={() => { setKnownDrafts({}); setPageModes({}); onChange([]); }}>清空标记</button>
          </div>
        </div>
        <div className="screening-summary" aria-live="polite">
          <span>词库共 <strong>{words.length}</strong> 个单词</span>
          <span>已标记 <strong className="screening-selected-count">{selectedCount}</strong> 个生词</span>
          <span>符合筛选 <strong>{filteredWords.length}</strong> 个 · 本页 {visibleWords.length} 个</span>
        </div>
        <nav className="screening-pagination" aria-label="筛词分页">
          <div className="screening-page-settings">
            <label>每页单词数<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option><option value={300}>300</option></select></label>
            <label>跳转页码<select value={currentPage} onChange={(event) => setPage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></label>
          </div>
          <div className="screening-page-buttons"><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>第 {currentPage} / {pageCount} 页</span><button type="button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
        </nav>
        {selectionMode === 'known' && <div className="screening-inverse-panel"><p>{hasPageDraft ? '本页反选待确认' : '本页反选已保存'} · 认识 {knownSelectedIds.size} 个 · 生词 {visibleWords.length - knownSelectedIds.size} 个</p><p>点击认识的词，保存本页后仅将本页其余词加入生词。</p><div><button type="button" disabled={busy || !hasPageDraft} onClick={savePageSelection}>保存本页筛选</button><button type="button" disabled={busy || !hasPageDraft} onClick={discardPageDraft}>放弃本页筛选</button></div></div>}
        {pendingPageCount > 0 && <div className="screening-draft-note" role="status"><p>有 {pendingPageCount} 页反选尚未保存，请保存或放弃后创建分支。</p><button type="button" disabled={busy} onClick={() => setKnownDrafts({})}>放弃全部未保存反选</button></div>}
        <button type="button" className="screening-create" aria-label="创建生词分支词库" disabled={busy || selectedCount === 0 || pendingPageCount > 0} onClick={onCreate}>创建生词分支词库{selectedCount > 0 ? `（${selectedCount}）` : ''}</button>
        <p className="screening-hint"><span>{selectionMode === 'known' ? '点击标记认识 / 再点取消' : '点击标记不认识 / 再点取消'}</span><span>右键或 ? 查看全部释义</span><span>同一单词只标记一次，分支保留全部词义</span></p>
        <p className="screening-save-note">正选标记自动保存，反选需确认本页。未提交的反选在离开筛词页后舍弃。<br />尚未筛选的其他页不会自动加入生词。</p>
      </aside>
      <div className="screening-grid">
        {visibleWords.map((word) => {
          const selected = selectionMode === 'known' ? knownSelectedIds.has(word.id) : word.senses.some((sense) => selectedIds.has(sense.id));
          const definitionOpen = popup?.wordId === word.id;
          const partOfSpeech = [...new Set(word.senses.map((sense) => sense.partOfSpeech).filter(Boolean))].join(' / ');
          return (
            <div key={word.id} className={`screening-entry${selected ? selectionMode === 'known' ? ' known' : ' selected' : ''}${showMeanings ? ' with-meaning' : ''}`}>
              <div className="screening-word-line">
                <button
                  type="button"
                  className="screening-word"
                  aria-pressed={selected}
                  aria-label={`${word.word}，${selectionMode === 'known' ? selected ? '取消认识标记' : '标记认识' : selected ? '取消标记' : '标记不认识'}`}
                  disabled={busy}
                  onClick={() => { setPopup(null); toggleWord(word.id); }}
                  onContextMenu={(event) => { event.preventDefault(); openDefinition(word.id, event.currentTarget); }}
                >
                  <strong>{word.word}</strong>
                  {partOfSpeech && <span className="screening-pos" aria-hidden="true">{partOfSpeech}</span>}
                </button>
                <button
                  type="button"
                  className="screening-meaning-button"
                  aria-label={`${word.word}，${definitionOpen ? '收起释义' : '查看释义'}`}
                  aria-expanded={definitionOpen}
                  aria-controls="screening-definition"
                  onClick={(event) => openDefinition(word.id, event.currentTarget, true)}
                >?</button>
              </div>
              {showMeanings && <p className="screening-meaning">{word.senses.map((sense) => `${sense.partOfSpeech} ${sense.meaning}`.trim()).join('；')}</p>}
            </div>
          );
        })}
      </div>
      {filteredWords.length === 0 && <p className="screening-empty">没有符合筛选条件的单词，可以修改搜索或关闭“只看已标记”。</p>}
      {popup && popupWord && (
        <aside
          id="screening-definition"
          className="screening-definition-popup"
          role="dialog"
          aria-label={`${popupWord.word}的释义`}
          ref={popupRef}
          style={{ left: popup.left, top: popup.top }}
        >
          <button type="button" className="screening-popup-close" aria-label="关闭释义" onClick={() => setPopup(null)}>×</button>
          <h3>{popupWord.word}</h3>
          {popupWord.senses.map((sense) => <div key={sense.id} className="screening-popup-sense">{sense.partOfSpeech && <span className="screening-popup-pos">{sense.partOfSpeech}</span>}<p className="screening-meaning">{sense.meaning}</p></div>)}
          <small>{popupWord.senses.some((sense) => selectedIds.has(sense.id)) ? '已标记不认识' : '尚未标记'} · 查看释义不改变标记</small>
        </aside>
      )}
    </section>
  );
}

export default VocabularyScreening;

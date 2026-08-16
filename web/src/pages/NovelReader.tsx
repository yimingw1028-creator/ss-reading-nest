import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  MessageCircleQuestion,
  PencilLine,
  Save,
  Send,
  Sparkles,
  X
} from "lucide-react";
import type { Quote, Reaction, ReadingSession } from "@ss/shared";
import { useHorizontalPaging } from "../hooks/useHorizontalPaging.js";
import { ReaderHeader } from "../components/ReaderHeader.js";
import { ReaderActions } from "../components/ReaderActions.js";
import { ReadingSyncStatus } from "../components/ReadingSyncStatus.js";

type SelectionMode = "thought" | "question" | null;

export function NovelReader(props: {
  session: ReadingSession;
  chunks: string[];
  savedQuotes: Quote[];
  savedReactions: Reaction[];
  onPosition: (index: number) => void;
  onSharePage: (currentText: string) => Promise<void> | void;
  onAskSelection: (selectedText: string, question: string) => Promise<void> | void;
  onSaveThought: (content: string, note: string) => Promise<unknown> | unknown;
  onSaveClearThought: (
    quoteId: string,
    clearThought: string
  ) => Promise<Quote | undefined> | Quote | undefined;
  onDeleteQuote?: (quoteId: string) => Promise<boolean> | boolean;
  onFinish: () => void;
  onBack: () => void;
  onFullscreen: () => void;
  fullscreenLabel?: string;
  immersive?: boolean;
  layoutRevision: number;
  actionInFlight: boolean;
  canRequestPip: boolean;
  onRequestPip: () => void;
  collapsed?: boolean;
  onExpand?: () => void;
  canCollapse?: boolean;
  onCollapse?: () => void;
  initialScrollTop: number;
  onScrollPosition: (scrollTop: number) => void;
}) {
  const index = Math.max(
    0,
    Math.min(props.chunks.length - 1, props.session.userCurrentPosition.index - 1)
  );
  const current = props.chunks[index] ?? "";
  const currentQuotes = useMemo(
    () =>
      props.savedQuotes.filter(
        (quote) =>
          quote.position.kind === props.session.userCurrentPosition.kind &&
          quote.position.index === index + 1
      ),
    [index, props.savedQuotes, props.session.userCurrentPosition.kind]
  );
  const currentThoughts = useMemo(
    () => currentQuotes.filter((quote) => quote.note),
    [currentQuotes]
  );
  const currentDiscussion = useMemo(
    () =>
      props.savedReactions.filter(
        (entry) =>
          entry.position.kind === props.session.userCurrentPosition.kind &&
          entry.position.index === index + 1
      ),
    [index, props.savedReactions, props.session.userCurrentPosition.kind]
  );
  const navigationEntries = useMemo(() => buildNavigationEntries(props.chunks), [props.chunks]);
  const currentClearThoughts = useMemo(
    () => currentThoughts.filter((quote) => quote.clearThought?.trim()).length,
    [currentThoughts]
  );
  const [selected, setSelected] = useState("");
  const [selectionMode, setSelectionMode] = useState<SelectionMode>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [thoughtsCardOpen, setThoughtsCardOpen] = useState(false);
  const [activeQuote, setActiveQuote] = useState<Quote | null>(null);
  const [clearThoughtDraft, setClearThoughtDraft] = useState("");
  const [clearThoughtEditing, setClearThoughtEditing] = useState(false);
  const [clearThoughtSaving, setClearThoughtSaving] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [jumpPage, setJumpPage] = useState(String(index + 1));
  const [jumpError, setJumpError] = useState("");
  const previous = () => props.onPosition(Math.max(1, index));
  const next = () => props.onPosition(Math.min(props.chunks.length, index + 2));
  const swipe = useHorizontalPaging(previous, next);
  const scrollRef = useRef<HTMLElement>(null);
  const articleRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = props.initialScrollTop;
  }, [index, props.layoutRevision]);

  useEffect(() => {
    clearSelection();
    setActiveQuote(null);
    setClearThoughtDraft("");
    setClearThoughtEditing(false);
    setThoughtsCardOpen(false);
  }, [index]);

  useEffect(() => {
    if (!navigationOpen) return;
    setJumpPage(String(index + 1));
    setJumpError("");
  }, [index, navigationOpen]);

  useEffect(() => {
    if (!navigationOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setNavigationOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [navigationOpen]);

  function clearSelection() {
    setSelected("");
    setSelectionMode(null);
    setDraft("");
    window.getSelection()?.removeAllRanges?.();
  }

  function captureSelection() {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (!text) return;
    if (
      selection?.anchorNode &&
      articleRef.current &&
      !articleRef.current.contains(selection.anchorNode)
    ) {
      return;
    }
    const existing = currentQuotes.find((quote) => normalizeQuote(quote.content) === text);
    setSelected(text);
    setSelectionMode(null);
    setDraft(existing?.note ?? "");
  }

  function openComposer(mode: Exclude<SelectionMode, null>, quote?: Quote) {
    if (quote) {
      setSelected(normalizeQuote(quote.content));
      setDraft(quote.note ?? "");
    } else if (mode === "question") {
      setDraft("");
    }
    setSelectionMode(mode);
  }

  function openQuoteDetail(quote: Quote) {
    setActiveQuote(quote);
    setClearThoughtDraft(quote.clearThought ?? "");
    setClearThoughtEditing(!quote.clearThought?.trim());
    setThoughtsCardOpen(false);
    setDeleteConfirming(false);
    clearSelection();
  }

  function openNavigation() {
    setJumpPage(String(index + 1));
    setJumpError("");
    setNavigationOpen(true);
  }

  function goToPage(page: number) {
    props.onPosition(page);
    setNavigationOpen(false);
  }

  function submitPageJump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizePageNumber(jumpPage);
    if (!normalized || !/^\d+$/.test(normalized)) {
      setJumpError("请输入有效页码。");
      return;
    }
    const page = Number(normalized);
    if (page < 1 || page > props.chunks.length) {
      setJumpError(`页码范围是 1 到 ${props.chunks.length}。`);
      return;
    }
    goToPage(page);
  }

  function editActiveThought() {
    if (!activeQuote) return;
    openComposer("thought", activeQuote);
    setActiveQuote(null);
  }

  async function submitThought() {
    if (!selected || !draft.trim() || submitting) return;
    setSubmitting(true);
    try {
      await props.onSaveThought(selected, draft.trim());
      clearSelection();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitQuestion() {
    if (!selected || !draft.trim() || submitting) return;
    setSubmitting(true);
    try {
      await props.onAskSelection(selected, draft.trim());
      clearSelection();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitClearThought() {
    if (!activeQuote || clearThoughtSaving) return;
    setClearThoughtSaving(true);
    try {
      const savedQuote = await props.onSaveClearThought(
        activeQuote.id,
        clearThoughtDraft.trim()
      );
      if (savedQuote) {
        setActiveQuote(savedQuote);
        setClearThoughtDraft(savedQuote.clearThought ?? "");
        setClearThoughtEditing(false);
      }
    } finally {
      setClearThoughtSaving(false);
    }
  }

  async function deleteClearThought() {
    if (!activeQuote || clearThoughtSaving) return;
    setClearThoughtSaving(true);
    try {
      const savedQuote = await props.onSaveClearThought(activeQuote.id, "");
      if (savedQuote) {
        setActiveQuote(savedQuote);
        setClearThoughtDraft("");
        setClearThoughtEditing(true);
      }
    } finally {
      setClearThoughtSaving(false);
    }
  }

  async function deleteActiveQuote() {
    if (!activeQuote || clearThoughtSaving) return;
    if (!deleteConfirming) {
      setDeleteConfirming(true);
      return;
    }
    setClearThoughtSaving(true);
    try {
      if (props.onDeleteQuote && await props.onDeleteQuote(activeQuote.id)) {
        setActiveQuote(null);
        setDeleteConfirming(false);
      }
    } finally {
      setClearThoughtSaving(false);
    }
  }

  if (props.collapsed) {
    return (
      <main className="reader-resume-shell" aria-label="已收起的小说阅读器">
        <button type="button" className="reader-resume-bar" onClick={props.onExpand}>
          <span className="reader-resume-mark" aria-hidden="true">书</span>
          <span className="reader-resume-copy">
            <strong>{props.session.title}</strong>
            <small>停在第 {index + 1} 页，共 {props.chunks.length} 页</small>
          </span>
          <span className="reader-resume-action">继续阅读</span>
        </button>
        {props.canRequestPip ? (
          <button type="button" className="reader-resume-pin" onClick={props.onRequestPip}>
            悬浮
          </button>
        ) : null}
      </main>
    );
  }

  return (
    <main
      className={`reader-shell reader-novel${props.immersive ? " reader-immersive" : ""}`}
    >
      <ReaderHeader
        title={props.session.title}
        progress={`第 ${index + 1} 页 / 共 ${props.chunks.length} 页`}
        fullscreenLabel={props.fullscreenLabel}
        onBack={props.onBack}
        onFullscreen={props.onFullscreen}
        canDock={props.canRequestPip}
        onDock={props.onRequestPip}
        canCollapse={props.canCollapse}
        onCollapse={props.onCollapse}
        onOpenNavigation={openNavigation}
      />
      <ReadingSyncStatus session={props.session} />
      <div className="reader-workspace novel-workspace">
        <div className="novel-reading-column">
          <section
            ref={scrollRef}
            className="reader-scroll novel-scroll"
            {...swipe}
            onScroll={(event) => props.onScrollPosition(event.currentTarget.scrollTop)}
            onMouseUp={captureSelection}
            onTouchEnd={(event) => {
              swipe.onTouchEnd(event);
              window.setTimeout(captureSelection, 0);
            }}
          >
          <article ref={articleRef} className="novel-paper">
            {current.split("\n").map((line, lineIndex) => (
              <p key={lineIndex}>{highlightLine(line, currentQuotes, openQuoteDetail)}</p>
            ))}
          </article>

          <div className="page-buttons">
            <button type="button" onClick={previous} disabled={index === 0}>
              <ChevronLeft className="page-button-icon" aria-hidden="true" strokeWidth={1.8} />
              <span>上一页</span>
            </button>
            <span>{index + 1} / {props.chunks.length}</span>
            <button type="button" onClick={next} disabled={index >= props.chunks.length - 1}>
              <span>下一页</span>
              <ChevronRight className="page-button-icon" aria-hidden="true" strokeWidth={1.8} />
            </button>
          </div>
          </section>

          {currentThoughts.length + currentDiscussion.length > 0 ? (
            <button
              type="button"
              className="page-thoughts-pin"
              aria-label={`打开本页共读记录：${currentThoughts.length + currentDiscussion.length} 条${
                currentClearThoughts > 0 ? `，清思 ${currentClearThoughts} 条` : ""
              }${
                currentDiscussion.length > 0 ? `，${currentDiscussion.length} 条回声` : ""
              }`}
              aria-haspopup="dialog"
              onClick={() => setThoughtsCardOpen(true)}
            >
              <Sparkles className="page-thoughts-icon" aria-hidden="true" strokeWidth={1.8} />
              <strong>{currentThoughts.length + currentDiscussion.length}</strong>
            </button>
          ) : null}

          {selected ? (
            <aside className="selection-panel" aria-label="选中文字操作">
            <div className="selection-panel-heading">
              <span>已选中</span>
              <button type="button" aria-label="关闭划线操作" onClick={clearSelection}>
                <X className="dialog-close-icon" aria-hidden="true" strokeWidth={1.8} />
              </button>
            </div>
            <blockquote>“{shorten(selected, 120)}”</blockquote>
            {selectionMode === null ? (
              <div className="selection-choice-row">
                <button type="button" onClick={() => openComposer("thought")}>
                  <PencilLine aria-hidden="true" strokeWidth={1.8} />
                  写想法
                </button>
                <button type="button" className="action-primary" onClick={() => openComposer("question")}>
                  <MessageCircleQuestion aria-hidden="true" strokeWidth={1.8} />
                  直接提问
                </button>
              </div>
            ) : (
              <div className="selection-composer">
                <label htmlFor="selection-draft">
                  {selectionMode === "thought" ? "我的想法" : "我想问星星"}
                </label>
                <textarea
                  id="selection-draft"
                  aria-label={selectionMode === "thought" ? "我的划线想法" : "针对划线的问题"}
                  value={draft}
                  autoFocus
                  placeholder={
                    selectionMode === "thought"
                      ? "把此刻的感受留在这句话旁边…"
                      : "我不太明白这里为什么…"
                  }
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="selection-choice-row selection-submit-row">
                  <button
                    type="button"
                    disabled={!draft.trim() || submitting}
                    onClick={() => void submitThought()}
                  >
                    <Save aria-hidden="true" strokeWidth={1.8} />
                    {submitting ? "正在处理…" : "存入本页想法"}
                  </button>
                  <button
                    type="button"
                    className="action-primary"
                    disabled={!draft.trim() || submitting}
                    onClick={() => void submitQuestion()}
                  >
                    <Send aria-hidden="true" strokeWidth={1.8} />
                    {submitting ? "正在处理…" : "立即问星星"}
                  </button>
                </div>
              </div>
            )}
            </aside>
          ) : null}

          {thoughtsCardOpen ? (
            <div className="thoughts-card-backdrop" role="presentation">
              <section
                className="thoughts-card"
                role="dialog"
                aria-modal="true"
                aria-label="本页想法"
              >
                <header className="thoughts-card-header">
                  <div>
                    <span>第 {index + 1} 页</span>
                    <strong>本页共读</strong>
                    <small>
                      {currentThoughts.length} 条意绪
                      {currentClearThoughts > 0 ? ` · ${currentClearThoughts} 条清思` : ""}
                      {currentDiscussion.length > 0 ? ` · ${currentDiscussion.length} 条回声` : ""}
                    </small>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭本页想法"
                    onClick={() => setThoughtsCardOpen(false)}
                  >
                    <X className="dialog-close-icon" aria-hidden="true" strokeWidth={1.8} />
                  </button>
                </header>
                <div className="thoughts-card-scroll">
                  {currentThoughts.map((quote, thoughtIndex) => (
                    <article key={quote.id} className="thoughts-card-entry">
                      <p className="thoughts-card-kicker">
                        {String(thoughtIndex + 1).padStart(2, "0")} · 原文
                      </p>
                      <blockquote>“{normalizeQuote(quote.content)}”</blockquote>
                      <div className="thoughts-card-section">
                        <strong>意绪</strong>
                        <p>{quote.note}</p>
                      </div>
                      <div className="thoughts-card-section thoughts-card-clear">
                        <strong>清思</strong>
                        <p>{quote.clearThought?.trim() || "还没有清思。"}</p>
                      </div>
                      <button
                        type="button"
                        className="thoughts-card-open"
                        onClick={() => openQuoteDetail(quote)}
                      >
                        打开这句
                      </button>
                    </article>
                  ))}
                  {currentDiscussion.map((entry, discussionIndex) => (
                    <article key={entry.id} className="thoughts-card-entry discussion-card-entry">
                      <p className="thoughts-card-kicker">
                        {String(currentThoughts.length + discussionIndex + 1).padStart(2, "0")}
                        {" · "}{entry.speaker === "assistant" ? "陆沉" : "阿雾"}
                        {entry.revisesId ? " · 修订" : " · 回声"}
                      </p>
                      <div className="thoughts-card-section">
                        <p>{entry.content}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </div>
          ) : null}
          {activeQuote ? (
            <div className="sheet-backdrop quote-detail-backdrop" role="presentation">
              <section
                className="bottom-sheet quote-detail-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="划线清思"
              >
                <div className="sheet-grip" />
                <header className="quote-detail-header">
                  <div>
                    <strong>这句划线</strong>
                    <span>{props.session.userCurrentPosition.label} · 意绪已保存</span>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭划线清思"
                    onClick={() => setActiveQuote(null)}
                  >
                    <X className="dialog-close-icon" aria-hidden="true" strokeWidth={1.8} />
                  </button>
                </header>
                <blockquote className="quote-detail-source">
                  “{normalizeQuote(activeQuote.content)}”
                </blockquote>
                <section className="quote-detail-section">
                  <div className="quote-detail-section-heading">
                    <strong>意绪</strong>
                    <button type="button" onClick={editActiveThought}>修改意绪</button>
                  </div>
                  <p>{activeQuote.note || "这里还没有写下第一反应。"}</p>
                </section>
                <section className="quote-detail-section quote-clear-thought">
                  <div className="quote-detail-section-heading">
                    <strong>清思</strong>
                    {activeQuote.clearThought?.trim() || clearThoughtDraft.trim() ? (
                      <span className="quote-detail-heading-actions">
                        <button
                          type="button"
                          onClick={() => setClearThoughtEditing((value) => !value)}
                        >
                          {clearThoughtEditing ? "阅读" : "编辑"}
                        </button>
                        <button
                          type="button"
                          className="danger-text-button"
                          disabled={clearThoughtSaving}
                          onClick={() => void deleteClearThought()}
                        >
                          删除清思
                        </button>
                      </span>
                    ) : null}
                  </div>
                  {clearThoughtEditing ? (
                    <textarea
                      value={clearThoughtDraft}
                      onChange={(event) => setClearThoughtDraft(event.target.value)}
                      placeholder="粘贴星星说得好的地方，或写下聊完之后真正想清楚的内容…"
                    />
                  ) : (
                    <p className="quote-clear-thought-body">
                      {clearThoughtDraft.trim() || "这里还没有清思。"}
                    </p>
                  )}
                </section>
                <section className="quote-detail-section quote-discussion">
                  <div className="quote-detail-section-heading">
                    <strong>共读回声</strong>
                    <span>
                      {currentDiscussion.filter((entry) => entry.quoteId === activeQuote.id).length} 条
                    </span>
                  </div>
                  {currentDiscussion.filter((entry) => entry.quoteId === activeQuote.id).length > 0 ? (
                    <div className="quote-discussion-list">
                      {currentDiscussion
                        .filter((entry) => entry.quoteId === activeQuote.id)
                        .map((entry) => (
                          <article key={entry.id} className="quote-discussion-entry">
                            <strong>{entry.speaker === "assistant" ? "陆沉" : "阿雾"}</strong>
                            {entry.revisesId ? <small>修订</small> : null}
                            <p>{entry.content}</p>
                          </article>
                        ))}
                    </div>
                  ) : (
                    <p>这句旁边还没有留下我们的回应。</p>
                  )}
                </section>
                <div className="quote-detail-actions">
                  {props.onDeleteQuote ? <button
                    type="button"
                    className={deleteConfirming ? "danger-button" : ""}
                    onClick={() => void deleteActiveQuote()}
                  >
                    {deleteConfirming ? "确认删除" : "删除记录"}
                  </button> : <button type="button" onClick={() => setActiveQuote(null)}>取消</button>}
                  {clearThoughtEditing ? (
                    <button
                      type="button"
                      className="action-primary"
                      disabled={clearThoughtSaving}
                      onClick={() => void submitClearThought()}
                    >
                      {clearThoughtSaving ? "正在保存…" : "保存清思"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="action-primary"
                      onClick={() => setClearThoughtEditing(true)}
                    >
                      编辑清思
                    </button>
                  )}
                </div>
              </section>
            </div>
          ) : null}
          {navigationOpen ? (
            <div
              className="toc-drawer-backdrop"
              role="presentation"
              onClick={() => setNavigationOpen(false)}
            >
              <section
                className="toc-drawer"
                role="dialog"
                aria-modal="true"
                aria-label="目录和跳页"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="sheet-grip" />
                <header className="toc-drawer-header">
                  <div>
                    <span>第 {index + 1} 页 / 共 {props.chunks.length} 页</span>
                    <strong>目录与跳页</strong>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭目录"
                    onClick={() => setNavigationOpen(false)}
                  >
                    <X className="dialog-close-icon" aria-hidden="true" strokeWidth={1.8} />
                  </button>
                </header>

                <form className="toc-jump-form" onSubmit={submitPageJump}>
                  <label htmlFor="reader-page-jump">跳到页码</label>
                  <div className="toc-jump-row">
                    <input
                      id="reader-page-jump"
                      inputMode="numeric"
                      pattern="[0-9０-９]*"
                      value={jumpPage}
                      aria-invalid={Boolean(jumpError)}
                      aria-describedby={jumpError ? "reader-page-jump-error" : undefined}
                      onChange={(event) => {
                        setJumpPage(event.target.value);
                        if (jumpError) setJumpError("");
                      }}
                    />
                    <button type="submit">
                      前往
                      <ArrowRight aria-hidden="true" strokeWidth={1.8} />
                    </button>
                  </div>
                  {jumpError ? (
                    <p id="reader-page-jump-error" className="toc-jump-error" role="alert">
                      {jumpError}
                    </p>
                  ) : null}
                </form>

                <section className="toc-section" aria-label="章节目录">
                  <div className="toc-section-heading">
                    <h2>章节目录</h2>
                    {navigationEntries.length > 0 ? <span>{navigationEntries.length} 处</span> : null}
                  </div>
                  {navigationEntries.length > 0 ? (
                    <ol className="toc-entry-list">
                      {navigationEntries.map((entry) => (
                        <li key={`${entry.page}-${entry.title}`}>
                          <button
                            type="button"
                            aria-label={`${entry.title}，第 ${entry.page} 页`}
                            aria-current={entry.page === index + 1 ? "page" : undefined}
                            onClick={() => goToPage(entry.page)}
                          >
                            <span>{entry.title}</span>
                            <small>
                              第 {entry.page} 页
                              <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                            </small>
                          </button>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="toc-empty">暂未识别到章节目录</p>
                  )}
                </section>
              </section>
            </div>
          ) : null}
        </div>
      </div>
      <ReaderActions
        primaryLabel="和星星共读"
        pageLabel={`${index + 1} / ${props.chunks.length}`}
        onPrimary={() => props.onSharePage(current)}
        primaryDisabled={props.actionInFlight}
        onPage={openNavigation}
        onFinish={props.onFinish}
      />
    </main>
  );
}

type NavigationEntry = {
  page: number;
  title: string;
};

function buildNavigationEntries(chunks: string[]): NavigationEntry[] {
  return chunks.flatMap((chunk, index) => {
    const title = findChunkHeading(chunk);
    return title ? [{ page: index + 1, title }] : [];
  });
}

function findChunkHeading(chunk: string) {
  const lines = chunk
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);

  for (const line of lines) {
    const markdownHeading = line.match(/^#{1,6}\s+(.{1,80})$/);
    if (markdownHeading?.[1]) return markdownHeading[1].trim();
    if (isReadableSectionHeading(line)) return line;
  }
  return "";
}

function isReadableSectionHeading(line: string) {
  return (
    /^第\s*[0-9０-９一二两三四五六七八九十百千万〇零]+\s*[章节卷回部篇集](?!.*[。！？!?]$).{0,50}$/.test(line) ||
    /^(序章|序言|前言|引子|楔子|尾声|后记)$/.test(line)
  );
}

function normalizePageNumber(value: string) {
  return value
    .trim()
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10));
}

function highlightLine(line: string, quotes: Quote[], onOpenQuote: (quote: Quote) => void) {
  const matches = [...new Set(quotes.map((quote) => normalizeQuote(quote.content)).filter(Boolean))]
    .filter((quote) => Array.from(quote).length >= 2)
    .filter((quote) => line.includes(quote))
    .sort((left, right) => right.length - left.length);
  if (matches.length === 0) return line;
  const pattern = new RegExp(`(${matches.map(escapeRegExp).join("|")})`, "g");
  return line.split(pattern).map((part, index) => {
    const quote = quotes.find((item) => normalizeQuote(item.content) === part);
    return quote ? (
      <mark
        key={`${index}-${part}`}
        className="quote-highlight"
        role="button"
        tabIndex={0}
        title={quote.note ?? "已保存的划线"}
        onClick={() => onOpenQuote(quote)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpenQuote(quote);
          }
        }}
      >
        {part}
      </mark>
    ) : (
      <Fragment key={`${index}-${part}`}>{part}</Fragment>
    );
  });
}

function normalizeQuote(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shorten(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

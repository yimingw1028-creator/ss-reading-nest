import { useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Ellipsis,
  FileUp,
  LoaderCircle,
  SlidersHorizontal
} from "lucide-react";
import type { ReadingPosition } from "@ss/shared";
import type { BookshelfItem } from "./Home.js";

type ArchiveKind = "thought" | "clarity" | "minutes" | "afterword";

export type ArchiveDeleteTarget = {
  source:
    | "quote"
    | "reaction"
    | "bookmark"
    | "annotation-comment"
    | "annotation-summary"
    | "checkpoint";
  recordId: string;
};

type ArchiveEntry = {
  id: string;
  kind: ArchiveKind;
  title: string;
  body: string;
  position?: ReadingPosition;
  deleteTarget?: ArchiveDeleteTarget;
};

const ARCHIVE_COPY: Record<
  ArchiveKind,
  { label: string; measure: string; description: string }
> = {
  thought: {
    label: "意绪",
    measure: "点",
    description: "你在原文旁留下的感受与判断"
  },
  clarity: {
    label: "清思",
    measure: "记",
    description: "你从陆沉回复里保存下来的片段"
  },
  minutes: {
    label: "纪要",
    measure: "篇",
    description: "章节或阶段共读后的简短整理"
  },
  afterword: {
    label: "阅后录",
    measure: "篇",
    description: "读完整本书后留下的回望"
  }
};

export function BookCover(props: {
  item: BookshelfItem;
  onBack: () => void;
  onRead: (item: BookshelfItem) => void;
  onReimport: (item: BookshelfItem) => void;
  onManage: (item: BookshelfItem) => void;
  onJump: (item: BookshelfItem, position: ReadingPosition) => void;
  onDeleteEntry?: (
    item: BookshelfItem,
    target: ArchiveDeleteTarget
  ) => Promise<boolean> | boolean;
}) {
  const archive = useMemo(() => buildBookArchive(props.item), [props.item]);
  const availableKinds = (Object.keys(ARCHIVE_COPY) as ArchiveKind[]).filter(
    (kind) => archive[kind].length > 0
  );
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [activeKind, setActiveKind] = useState<ArchiveKind | null>(
    availableKinds[0] ?? null
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const action = sourceAction(props.item);
  const entries = activeKind ? archive[activeKind] : [];
  const canRead = action.intent === "read";
  const fullTitle = props.item.session.title;
  const displayTitle = compactCoverTitle(fullTitle);
  const titleLength = Array.from(fullTitle.replace(/\s+/g, "")).length;
  const titleClass =
    titleLength > 54
      ? "cover-title-very-long"
      : titleLength > 30
        ? "cover-title-long"
        : "";
  const PrimaryActionIcon =
    action.intent === "read" ? BookOpen : action.intent === "reimport" ? FileUp : LoaderCircle;

  function openArchive(kind: ArchiveKind) {
    setActiveKind(kind);
    setArchiveOpen(true);
    setExpandedId(null);
  }

  return (
    <main className="cover-shell">
      <header className="cover-toolbar">
        <button type="button" className="cover-back" onClick={props.onBack} aria-label="返回书架">
          <ArrowLeft className="cover-toolbar-icon" aria-hidden="true" strokeWidth={1.8} />
        </button>
        <span>阿雾和陆沉的共读小巢</span>
        {availableKinds.length > 0 ? (
          <button
            type="button"
            className="cover-more"
            aria-label="查看书内记录"
            aria-expanded={archiveOpen}
            onClick={() => setArchiveOpen((value) => !value)}
          >
            <Ellipsis className="cover-toolbar-icon" aria-hidden="true" strokeWidth={1.8} />
          </button>
        ) : (
          <span className="cover-toolbar-spacer" />
        )}
      </header>

      <section className={`cover-stage ${titleClass} ${archiveOpen ? "archive-visible" : ""}`}>
        <div className="cover-book-area">
          <button
            type="button"
            className="cover-book"
            aria-label={`${action.button}《${props.item.session.title}》`}
            disabled={action.intent === "wait"}
            onClick={() =>
              canRead ? props.onRead(props.item) : props.onReimport(props.item)
            }
          >
            <span className="cover-book-edge" aria-hidden="true" />
            <span className="cover-book-kicker">阿雾和陆沉的共读小巢</span>
            <strong title={fullTitle}>{displayTitle}</strong>
            <span className="cover-book-rule" aria-hidden="true" />
            <small>{props.item.session.status === "completed" ? "阅毕" : "正在共读"}</small>
          </button>
          <p className="cover-tap-hint">点击封面{action.button}</p>
        </div>

        <div className="cover-details">
          <span className="cover-details-kicker">BOOK PROFILE</span>
          <h1 title={fullTitle}>{fullTitle}</h1>
          <p className="cover-progress">
            读到 {props.item.session.userCurrentPosition.label}
            {props.item.session.assistantSyncedPosition
              ? ` · 共读到 ${props.item.session.assistantSyncedPosition.label}`
              : ""}
          </p>

          {availableKinds.length > 0 ? (
            <div className="cover-memory-summary" aria-label="书内记录概览">
              {availableKinds.map((kind) => (
                <button type="button" key={kind} onClick={() => openArchive(kind)}>
                  <strong>{ARCHIVE_COPY[kind].label}</strong>
                  <span>
                    {archive[kind].length} {ARCHIVE_COPY[kind].measure}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="cover-empty-memory">还没有书内记录，先从喜欢的一句开始。</p>
          )}

          <div className={`cover-source-note ${props.item.sourceAvailability}`}>
            <strong>{action.status}</strong>
            <span>{action.hint}</span>
          </div>

          <div className="cover-actions">
            <button
              type="button"
              className={canRead ? "action-primary" : "library-quiet-action"}
              disabled={action.intent === "wait"}
              onClick={() =>
                canRead ? props.onRead(props.item) : props.onReimport(props.item)
              }
            >
              <PrimaryActionIcon
                className={`library-action-icon${action.intent === "wait" ? " reader-action-spinner" : ""}`}
                aria-hidden="true"
                strokeWidth={1.8}
              />
              <span>{action.button}</span>
            </button>
            <button
              type="button"
              className="library-quiet-action"
              onClick={() => props.onManage(props.item)}
            >
              <SlidersHorizontal className="library-action-icon" aria-hidden="true" strokeWidth={1.8} />
              <span>管理这本书</span>
            </button>
          </div>
        </div>
      </section>

      {archiveOpen && activeKind ? (
        <section className="book-archive" aria-label="书内记录">
          <div className="archive-tabs" role="tablist" aria-label="书内记录分类">
            {availableKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={activeKind === kind}
                onClick={() => {
                  setActiveKind(kind);
                  setExpandedId(null);
                }}
              >
                <strong>{ARCHIVE_COPY[kind].label}</strong>
                <span>
                  {archive[kind].length} {ARCHIVE_COPY[kind].measure}
                </span>
              </button>
            ))}
          </div>
          <div className="archive-heading">
            <div>
              <h2>{ARCHIVE_COPY[activeKind].label}</h2>
              <p>{ARCHIVE_COPY[activeKind].description}</p>
            </div>
            <small>单击展开 · 双击回到原页</small>
          </div>
          <div className="archive-list">
            {entries.map((entry) => {
              const expanded = expandedId === entry.id;
              return (
                <article className="archive-entry" key={entry.id}>
                  <button
                    type="button"
                    className="archive-entry-main"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId((current) => (current === entry.id ? null : entry.id))}
                    onDoubleClick={() => {
                      if (entry.position) props.onJump(props.item, entry.position);
                    }}
                  >
                    <span>{entry.position?.label ?? ARCHIVE_COPY[entry.kind].label}</span>
                    <strong>{entry.title}</strong>
                    {expanded ? <p>{entry.body}</p> : null}
                  </button>
                  {entry.deleteTarget && props.onDeleteEntry ? (
                    <button
                      type="button"
                      className={`archive-entry-delete${deletingId === entry.id ? " confirming" : ""}`}
                      aria-label={`删除${ARCHIVE_COPY[entry.kind].label}：${entry.title}`}
                      onClick={async () => {
                        if (deletingId !== entry.id) {
                          setDeletingId(entry.id);
                          return;
                        }
                        if (await props.onDeleteEntry!(props.item, entry.deleteTarget!)) {
                          setDeletingId(null);
                          setExpandedId(null);
                        }
                      }}
                    >
                      {deletingId === entry.id ? "确认" : "删除"}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </main>
  );
}

export function compactCoverTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized) return "未命名";

  const colonPrefix = normalized.split(/[：:]/, 1)[0]?.trim();
  if (colonPrefix && Array.from(colonPrefix).length <= 12) {
    return colonPrefix;
  }

  const bracketPrefix = normalized.split(/[（(]/, 1)[0]?.trim();
  if (bracketPrefix && Array.from(bracketPrefix).length <= 18) {
    return bracketPrefix;
  }

  const characters = Array.from(normalized);
  return characters.length > 18 ? `${characters.slice(0, 17).join("")}…` : normalized;
}

export function buildBookArchive(item: BookshelfItem): Record<ArchiveKind, ArchiveEntry[]> {
  const archive: Record<ArchiveKind, ArchiveEntry[]> = {
    thought: [],
    clarity: [],
    minutes: [],
    afterword: []
  };

  for (const quote of item.quotes) {
    const note = quote.note?.trim();
    if (!note) continue;
    const normalizedContent = quote.content.trim();
    if (/^陆沉(?:短评|清思)[：:]/.test(normalizedContent)) {
      archive.clarity.push({
        id: quote.id,
        deleteTarget: { source: "quote", recordId: quote.id },
        kind: "clarity",
        title: stripPrefix(normalizedContent, /^陆沉(?:短评|清思)[：:]\s*/),
        body: note,
        position: quote.position
      });
    } else if (/^纪要[：:]/.test(normalizedContent)) {
      archive.minutes.push({
        id: quote.id,
        deleteTarget: { source: "quote", recordId: quote.id },
        kind: "minutes",
        title: stripPrefix(normalizedContent, /^纪要[：:]\s*/),
        body: note,
        position: quote.position
      });
    } else if (/^阅后录[：:]/.test(normalizedContent)) {
      archive.afterword.push({
        id: quote.id,
        deleteTarget: { source: "quote", recordId: quote.id },
        kind: "afterword",
        title: stripPrefix(normalizedContent, /^阅后录[：:]\s*/),
        body: note
      });
    } else {
      archive.thought.push({
        id: quote.id,
        deleteTarget: { source: "quote", recordId: quote.id },
        kind: "thought",
        title: normalizedContent,
        body: note,
        position: quote.position
      });
    }
  }

  for (const reaction of item.reactions) {
    archive.thought.push({
      id: reaction.id,
      deleteTarget: { source: "reaction", recordId: reaction.id },
      kind: "thought",
      title: reaction.content,
      body: reaction.content,
      position: reaction.position
    });
  }

  const annotations = item.session.sourceManifest?.readingState?.annotations ?? [];
  for (const [index, annotation] of annotations.entries()) {
    const position: ReadingPosition = {
      kind: "paragraph",
      index: annotation.pageIndex,
      label: `第 ${annotation.pageIndex} 页`
    };
    if (annotation.comment?.trim()) {
      addUnique(archive.thought, {
        id: `annotation-thought-${index}`,
        deleteTarget: { source: "annotation-comment", recordId: annotation.createdAt },
        kind: "thought",
        title: annotation.text,
        body: annotation.comment.trim(),
        position
      });
    }
    if (annotation.assistantSummary?.trim()) {
      addUnique(archive.clarity, {
        id: `annotation-clarity-${index}`,
        deleteTarget: { source: "annotation-summary", recordId: annotation.createdAt },
        kind: "clarity",
        title: annotation.text,
        body: annotation.assistantSummary.trim(),
        position
      });
    }
  }

  const checkpoint = item.session.sourceManifest?.readingState?.checkpoint;
  if (checkpoint?.summary.trim()) {
    archive.minutes.push({
      id: `checkpoint-${checkpoint.updatedAt}`,
      deleteTarget: { source: "checkpoint", recordId: checkpoint.updatedAt },
      kind: "minutes",
      title: checkpoint.label,
      body: checkpoint.summary.trim(),
      position: {
        kind: "paragraph",
        index: checkpoint.pageIndex,
        label: checkpoint.label
      }
    });
  }

  for (const bookmark of item.bookmarks) {
    const label = bookmark.label?.trim();
    if (!label || label.length < 7 || /^读到|^看到|^第\s*\d+/.test(label)) continue;
    addUnique(archive.minutes, {
      id: bookmark.id,
      deleteTarget: { source: "bookmark", recordId: bookmark.id },
      kind: "minutes",
      title: bookmark.position.label,
      body: label,
      position: bookmark.position
    });
  }

  return archive;
}

function sourceAction(item: BookshelfItem): {
  status: string;
  hint: string;
  button: string;
  intent: "read" | "reimport" | "wait";
} {
  if (item.sourceAvailability === "available_local" || item.sourceAvailability === "unknown") {
    return {
      status: "可以继续阅读",
      hint: "正文已准备好，会从上次的位置打开。",
      button: "继续阅读",
      intent: "read"
    };
  }
  if (
    item.sourceAvailability === "available_cloud" ||
    item.sourceAvailability === "restoring_from_cloud"
  ) {
    return {
      status: "正在准备正文",
      hint: "云端正文恢复完成后就能继续。",
      button: "正在准备",
      intent: "wait"
    };
  }
  return {
    status: "正文需要重新导入",
    hint: "意绪、清思和阅读位置都还在，重新导入同一本书即可接上。",
    button: "重新导入正文",
    intent: "reimport"
  };
}

function stripPrefix(value: string, pattern: RegExp) {
  return value.replace(pattern, "").trim() || "保存下来的片段";
}

function addUnique(target: ArchiveEntry[], entry: ArchiveEntry) {
  const duplicate = target.some(
    (item) => item.body === entry.body && item.position?.index === entry.position?.index
  );
  if (!duplicate) target.push(entry);
}

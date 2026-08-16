import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { ArrowLeft, BookOpen, LoaderCircle } from "lucide-react";
import type {
  NovelLocalCache,
  Quote,
  ReadingPosition,
  ReadingRecord,
  ReadingSession,
  SessionBundle,
  SessionPreferences,
  SourceAvailability,
  SourceManifest
} from "@ss/shared";
import { DEFAULT_SESSION_PREFERENCES } from "@ss/shared";
import {
  askChatGpt,
  callTool,
  canCallTool,
  NO_HOST_MESSAGE,
  initialToolOutput,
  initialWidgetState,
  requestReaderFullscreen,
  requestReaderInline,
  requestReaderPip,
  saveReaderWidgetState,
  subscribeToolOutput,
  updateModelContext
} from "./bridge/host.js";
import { syncCurrentContext } from "./bridge/sync-current-context.js";
import { BookManagementSheet } from "./components/BookManagementSheet.js";
import { SyncChoiceSheet } from "./components/SyncChoiceSheet.js";
import { SyncProgressSheet } from "./components/SyncProgressSheet.js";
import { readEpub } from "./features/import/read-epub.js";
import { splitNovelText, splitNovelTextForVersion } from "./features/novel/split-text.js";
import { CloudSourceClient } from "./features/source-cloud/cloud-source-client.js";
import type { CloudUploadDiagnostics } from "./features/source-cloud/cloud-source-client.js";
import { getSourceAvailability } from "./features/source-identity/source-availability.js";
import { createNovelSourceManifest } from "./features/source-identity/source-manifest.js";
import { checkSourceSyncPermission } from "./features/source-identity/sync-guard.js";
import { buildSyncBatches } from "./features/reading-sync/build-batches.js";
import {
  buildBatchChatMessage,
  buildBatchUserNote,
  buildCurrentOnlyPrompt,
  buildFormalReadingPrompt,
  buildRecentOnlyPrompt
} from "./features/reading-sync/build-messages.js";
import {
  buildLiveReadingPrompt,
  buildReadingCommentPrompt
} from "./features/reading-comments/prompt-policy.js";
import {
  cancelSyncJob,
  getActiveBatch,
  markBatchConfirmed,
  markBatchFailed,
  markBatchSent
} from "./features/reading-sync/job-state.js";
import type { ReadingSyncJob } from "./features/reading-sync/types.js";
import { useLiveReading } from "./hooks/useLiveReading.js";
import { useReadingHostLayout } from "./hooks/useReadingHostLayout.js";
import { BookCover, type ArchiveDeleteTarget } from "./pages/BookCover.js";
import { Home, type BookshelfItem, type LibrarySkin } from "./pages/Home.js";
import { NovelReader } from "./pages/NovelReader.js";
import { IndexedDbReadingCache } from "./storage/indexeddb-cache.js";
import type { ToolCallResult } from "./types/openai.js";
import { createClientId } from "./utils/client-id.js";

type Screen = "home" | "cover" | "setup" | "novel";
type Overlay = "management" | null;
type ImportProgress = {
  stage:
    | "idle"
    | "reading"
    | "ready"
    | "segmenting"
    | "creating_session"
    | "uploading"
    | "saving_manifest"
    | "saving_cache"
    | "done"
    | "failed";
  fileName?: string;
  fileSize?: number;
  decodedTextLength?: number;
  sourceEndpointBasePresent?: boolean;
  uploadStatus?: string;
  sourceId?: string;
  sizeBytes?: number;
  paragraphCount?: number;
  sessionId?: string;
  indexedDbStatus?: "not_started" | "success" | "failure";
  screen?: Screen;
  message?: string;
};
type OpenOutput = {
  bookshelf?: Array<{
    id: string;
    title: string;
    type?: "novel";
    status?: "active" | "completed";
    currentPosition?: string;
    currentPositionIndex?: number;
    currentPositionTotal?: number;
    lastReadAt?: string;
    updatedAt?: string;
  }>;
  bookshelfSessions?: Array<SessionBundle & { cacheState?: string }>;
  recentSessions?: Array<SessionBundle & { cacheState?: string }>;
  readingRecords?: ReadingRecord[];
  sourceEndpointBase?: string;
};

type ActiveReadingRecordDraft = {
  operationId: string;
  sessionId: string;
  bookTitle: string;
  startedAt: string;
  startedAtMs: number;
  startPosition: ReadingPosition;
  endPosition: ReadingPosition;
  visitedPageIndexes: Set<number>;
};

const cache = new IndexedDbReadingCache();
const LIBRARY_SKIN_STORAGE_KEY = "reading-nest-library-skin";
type RestoredNovel = {
  session: ReadingSession;
  sourceAvailability: SourceAvailability;
  localCache: NovelLocalCache;
};
const cloudRestoreJobs = new Map<
  string,
  Promise<RestoredNovel>
>();
const cloudRestoredSources = new Map<string, NovelLocalCache>();
const MAX_NOVEL_FILE_SIZE = 5 * 1024 * 1024;
const MAX_EPUB_FILE_SIZE = 50 * 1024 * 1024;
const LARGE_NOVEL_TEXTAREA_PREVIEW_BYTES = 2 * 1024 * 1024;
const LARGE_NOVEL_TEXTAREA_PREVIEW_CHARS = 1200;

export function App() {
  const [openOutput, setOpenOutput] = useState<OpenOutput | undefined>(() =>
    normalizeOpenOutput(initialToolOutput<OpenOutput>())
  );
  const [bookshelfState, setBookshelfState] = useState<"loading" | "ready" | "failed">(() =>
    Array.isArray(openOutput?.bookshelfSessions ?? openOutput?.recentSessions) ? "ready" : "loading"
  );
  const sourceEndpointBase = openOutput?.sourceEndpointBase ?? deriveSourceEndpointBase();
  const cloudSourceClient = useMemo(
    () => new CloudSourceClient(sourceEndpointBase, undefined, callTool),
    [sourceEndpointBase]
  );
  const [restoredWidgetState] = useState(() => initialWidgetState());
  const [screen, setScreen] = useState<Screen>(() =>
    restoredWidgetState?.screen === "novel" && restoredWidgetState.sessionId ? "novel" : "home"
  );
  const [existingSession, setExistingSession] = useState<ReadingSession | null>(null);
  const [title, setTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [remembered, setRemembered] = useState(false);
  const [recent, setRecent] = useState<BookshelfItem[]>(
    () =>
      (openOutput?.bookshelfSessions ?? openOutput?.recentSessions ?? []).map(
        ({ cacheState: _cacheState, ...item }) => ({
          ...item,
          sourceAvailability: "unknown" as const
        })
      )
  );
  const [readingRecords, setReadingRecords] = useState<ReadingRecord[]>(() =>
    sortReadingRecords(openOutput?.readingRecords ?? [])
  );
  const [sessionBundle, setSessionBundle] = useState<SessionBundle | null>(null);
  const [selectedBook, setSelectedBook] = useState<BookshelfItem | null>(null);
  const [readerReturnScreen, setReaderReturnScreen] = useState<"home" | "cover">("home");
  const [chunks, setChunks] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [toast, setToast] = useState("");
  const [startReadingInFlight, setStartReadingInFlight] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress>({ stage: "idle" });
  const [readerImmersive, setReaderImmersive] = useState(
    restoredWidgetState?.immersive ?? false
  );
  const [librarySkin, setLibrarySkin] = useState<LibrarySkin>(readLibrarySkin);
  const [readerCollapsed, setReaderCollapsed] = useState(
    restoredWidgetState?.collapsed ?? false
  );
  const [syncRequestInFlight, setSyncRequestInFlight] = useState(false);
  const [managedBook, setManagedBook] = useState<BookshelfItem | null>(null);
  const [syncChoiceOpen, setSyncChoiceOpen] = useState(false);
  const [syncJob, setSyncJob] = useState<ReadingSyncJob | null>(null);
  const [sourceAvailability, setSourceAvailability] =
    useState<SourceAvailability>("unknown");
  const [readerScrollTop, setReaderScrollTop] = useState(restoredWidgetState?.scrollTop ?? 0);
  const restoreAttempted = useRef(false);
  const navigationRequestRef = useRef(0);
  const optimisticSessionIdsRef = useRef(new Set<string>());
  const bookshelfDataPresentRef = useRef(
    (openOutput?.bookshelfSessions ?? openOutput?.recentSessions ?? []).length > 0
  );
  const syncJobRef = useRef<ReadingSyncJob | null>(null);
  const activeReadingRecordRef = useRef<ActiveReadingRecordDraft | null>(null);
  const hostLayout = useReadingHostLayout();
  const changeLibrarySkin = useCallback((skin: LibrarySkin) => {
    setLibrarySkin(skin);
    try {
      window.localStorage.setItem(LIBRARY_SKIN_STORAGE_KEY, skin);
    } catch {
      // The host may disable storage; the current session can still switch skins.
    }
  }, []);

  useEffect(
    () =>
      subscribeToolOutput<OpenOutput>((output) => {
        setOpenOutput((current) => mergeOpenOutput(current, output, "partial"));
      }),
    []
  );

  const refreshNovelBookshelf = useCallback(async () => {
    setBookshelfState("loading");
    if (!bookshelfDataPresentRef.current && sourceEndpointBase !== "/source") {
      try {
        const output = await withTimeout(
          cloudSourceClient.loadBookshelf(),
          3_500,
          "bookshelf bootstrap timed out"
        );
        bookshelfDataPresentRef.current = true;
        setOpenOutput((current) => mergeOpenOutput(current, output, "authoritative"));
        setBookshelfState("ready");
        return;
      } catch {
        // Older clients may block direct fetches; the host tool bridge remains
        // the second recovery path.
      }
    }
    const tools = ["get_novel_bookshelf", "open_reading_nest"] as const;
    for (let attempt = 0; attempt < tools.length; attempt += 1) {
      const toolName = tools[attempt];
      if (!toolName) break;
      try {
        const result = await withTimeout(
          callTool(toolName, {}),
          3_500,
          `${toolName} timed out`
        );
        if ("unavailable" in result) {
          if (attempt === tools.length - 1) {
            setBookshelfState("ready");
            return;
          }
          continue;
        }
        const output = normalizeToolResultOutput(result);
        if (!output || !Array.isArray(output.bookshelfSessions)) {
          throw new Error("Missing bookshelf data");
        }
        setOpenOutput((current) => mergeOpenOutput(current, output, "authoritative"));
        setBookshelfState("ready");
        return;
      } catch {
        if (attempt === tools.length - 1) {
          setBookshelfState("failed");
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 120 * 2 ** attempt));
      }
    }
  }, [cloudSourceClient, sourceEndpointBase]);

  useEffect(() => {
    void refreshNovelBookshelf();
  }, [refreshNovelBookshelf]);

  useEffect(() => {
    const sessions = openOutput?.bookshelfSessions ?? openOutput?.recentSessions;
    if (!sessions) return;
    if (sessions.length > 0) bookshelfDataPresentRef.current = true;
    const incoming = sessions
      .filter((item) => item.session.type === "novel")
      .map(({ cacheState: _cacheState, ...item }) => ({
        ...item,
        sourceAvailability: "unknown" as const
      }));
    const incomingIds = new Set(incoming.map((item) => item.session.id));
    for (const sessionId of optimisticSessionIdsRef.current) {
      if (incomingIds.has(sessionId)) optimisticSessionIdsRef.current.delete(sessionId);
    }
    setRecent((current) =>
      mergeBookshelfSnapshot(current, incoming, optimisticSessionIdsRef.current)
    );
  }, [openOutput]);

  useEffect(() => {
    if (Array.isArray(openOutput?.readingRecords)) {
      setReadingRecords(sortReadingRecords(openOutput.readingRecords));
    }
  }, [openOutput?.readingRecords]);

  useEffect(() => {
    if (screen !== "novel" || !sessionBundle) return;
    updateActiveReadingRecord(sessionBundle.session);
  }, [
    screen,
    sessionBundle?.session.id,
    sessionBundle?.session.title,
    sessionBundle?.session.userCurrentPosition.index,
    sessionBundle?.session.userCurrentPosition.label,
    sessionBundle?.session.userCurrentPosition.total,
    chunks.length
  ]);

  useEffect(() => {
    const flush = () => {
      void finalizeActiveReadingRecord();
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, []);

  useEffect(() => {
    if (screen !== "novel") return;
    setReaderImmersive(hostLayout.displayMode === "fullscreen");
  }, [hostLayout.displayMode, screen]);

  useEffect(() => {
    if (screen !== "novel") return;
    setOverlay(null);
    setSyncChoiceOpen(false);
  }, [hostLayout.revision]);

  useEffect(() => {
    if (screen !== "home" && screen !== "cover") return;
    let cancelled = false;
    Promise.all(
      recent.map(async (item) => {
        const local = await cache.get(item.session.id).catch(() => null);
        let session = item.session;
        if (local && !session.sourceManifest) {
          await callTool("set_source_manifest", {
            sessionId: session.id,
            sourceManifest: local.metadata.sourceManifest
          }).catch(() => undefined);
          session = {
            ...session,
            sourceManifest: local.metadata.sourceManifest
          };
        }
        let sourceAvailability = getSourceAvailability(
          session.sourceManifest ?? null,
          local?.metadata.sourceManifest ?? null
        );
        if (sourceAvailability === "available_cloud") {
          setRecent((items) =>
            items.map((candidate) =>
              candidate.session.id === session.id
                ? { ...candidate, sourceAvailability: "restoring_from_cloud" }
                : candidate
            )
          );
          try {
            const restored = await restoreNovelFromCloudOnce(
              cloudSourceClient,
              sourceEndpointBase,
              session,
              5_000
            );
            session = restored.session;
            sourceAvailability = restored.sourceAvailability;
          } catch {
            sourceAvailability = "cloud_restore_failed";
          }
        }
        return {
          ...item,
          session,
          sourceAvailability
        };
      })
    ).then((items) => {
      if (!cancelled) {
        setRecent((current) =>
          items.filter((item) =>
            current.some((candidate) => candidate.session.id === item.session.id)
          )
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cloudSourceClient, recent.length, screen, sourceEndpointBase]);

  useEffect(() => {
    setSelectedBook((current) => {
      if (!current) return current;
      return recent.find((item) => item.session.id === current.session.id) ?? current;
    });
  }, [recent]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);



  const position = sessionBundle?.session.userCurrentPosition;

  useEffect(() => {
    if ((screen === "novel") && !sessionBundle) return;
    saveReaderWidgetState({
      screen,
      ...(sessionBundle ? { sessionId: sessionBundle.session.id } : {}),
      ...(position ? { positionIndex: position.index } : {}),
      ...(screen === "novel"
        ? {
            scrollTop: readerScrollTop,
            immersive: readerImmersive,
            collapsed: readerCollapsed
          }
        : {})
    });
  }, [
    screen,
    sessionBundle?.session.id,
    position?.index,
    readerScrollTop,
    readerImmersive,
    readerCollapsed
  ]);

  function begin() {
    navigationRequestRef.current += 1;
    setReaderCollapsed(false);
    setSessionBundle(null);
    setExistingSession(null);
    setTitle("");
    setSourceText("");
    setRemembered(true);
    setSourceAvailability("unknown");
    setScreen("setup");
  }

  function openBookCover(item: BookshelfItem) {
    navigationRequestRef.current += 1;
    setSelectedBook(item);
    setScreen("cover");
  }

  async function continueReading(item: BookshelfItem, targetPosition?: ReadingPosition) {
    const navigationRequest = ++navigationRequestRef.current;
    const requestIsCurrent = () => navigationRequestRef.current === navigationRequest;
    let nextItem = item;
    try {
      const result = await withTimeout(
        callTool("get_novel_bookshelf", {}),
        2_500,
        "bookshelf refresh timed out"
      );
      if (!requestIsCurrent()) return;
      const latest = Array.isArray(result.structuredContent?.bookshelfSessions)
        ? (result.structuredContent.bookshelfSessions as SessionBundle[]).find(
            (candidate) => candidate.session.id === item.session.id
          )
        : undefined;
      if (Array.isArray(result.structuredContent?.readingRecords)) {
        setReadingRecords(sortReadingRecords(result.structuredContent.readingRecords as ReadingRecord[]));
      }
      if (latest) {
        nextItem = {
          ...latest,
          sourceAvailability: item.sourceAvailability
        };
      }
    } catch {
      // The already loaded bookshelf remains a valid fallback when a refresh fails.
    }
    const storedLocal = await cache.get(item.session.id).catch(() => undefined);
    if (!requestIsCurrent()) return;
    const local =
      storedLocal ??
      cloudRestoredSources.get(cloudRestoreKey(sourceEndpointBase, nextItem.session));
    if (local && !nextItem.session.sourceManifest) {
      await callTool("set_source_manifest", {
        sessionId: nextItem.session.id,
        sourceManifest: local.metadata.sourceManifest
      }).catch(() => undefined);
      if (!requestIsCurrent()) return;
      nextItem = {
        ...nextItem,
        session: {
          ...nextItem.session,
          sourceManifest: local.metadata.sourceManifest
        }
      };
    }
    if (targetPosition) {
      nextItem = {
        ...nextItem,
        session: {
          ...nextItem.session,
          userCurrentPosition: targetPosition,
          updatedAt: new Date().toISOString()
        }
      };
      void callTool("update_reading_position", {
        sessionId: nextItem.session.id,
        userCurrentPosition: targetPosition
      });
    }
    setSelectedBook(nextItem);
    setSessionBundle(nextItem);
    const availability = getSourceAvailability(
      nextItem.session.sourceManifest ?? null,
      local === null ? null : local?.metadata.sourceManifest
    );
    setSourceAvailability(availability);
    if (local && "chunks" in local && (availability === "available_local" || availability === "unknown")) {
      setChunks(local.chunks);
      setSourceText(local.sourceText);
      setRemembered(true);
      setScreen("novel");
      return;
    }
    setExistingSession(nextItem.session);
    setTitle(nextItem.session.title);
    setRemembered(true);
    setScreen("setup");
    setToast(
      availability === "mismatch" || availability === "segmentation_mismatch"
        ? "当前设备的正文版本与原 session 不一致，已停止自动同步。请重新导入正确版本。"
        : `正文缓存已丢失。上次看到${nextItem.session.userCurrentPosition.label}，请重新粘贴正文继续。`
    );
  }

  function prepareReimport(item: BookshelfItem) {
    navigationRequestRef.current += 1;
    setSessionBundle(item);
    setSourceAvailability(item.sourceAvailability);
    setExistingSession(item.session);
    setTitle(item.session.title);
    setSourceText("");
    setRemembered(true);
    setScreen("setup");
    setToast(sourceReimportMessage(item.sourceAvailability));
  }

  async function openBookManagement(item: BookshelfItem) {
    setManagedBook(item);
    setOverlay("management");
  }

  async function openFullscreenReader() {
    if (!sessionBundle || !position) return;
    const saveFullscreenIntent = (immersive: boolean) =>
      saveReaderWidgetState({
        screen,
        sessionId: sessionBundle.session.id,
        positionIndex: position.index,
        scrollTop: readerScrollTop,
        immersive,
        collapsed: false
      });
    if (hostLayout.displayMode === "fullscreen") {
      saveFullscreenIntent(false);
      await requestReaderInline();
      return;
    }
    saveFullscreenIntent(true);
    setReaderCollapsed(false);
    const supported = await requestReaderFullscreen();
    if (!supported) {
      saveFullscreenIntent(false);
      setToast("无法进入全屏阅读，请重试。");
    }
  }

  function storeSyncJob(job: ReadingSyncJob) {
    syncJobRef.current = job;
    setSyncJob(job);
  }

  function clearSyncJobState() {
    syncJobRef.current = null;
    setSyncJob(null);
  }

  async function renameManagedBook(title: string) {
    if (!managedBook) return;
    try {
      const result = await callTool("rename_reading_session", {
        sessionId: managedBook.session.id,
        title
      });
      const session = result.structuredContent?.session as ReadingSession | undefined;
      if (!session) throw new Error("Missing renamed session");
      updateBookshelfSession(session);
      setManagedBook((current) => current ? { ...current, session } : current);
      setToast("书名已经改好啦。");
    } catch {
      setToast("书名没有保存成功，请重试。");
    }
  }

  async function setManagedBookStatus(status: "active" | "completed") {
    if (!managedBook) return;
    try {
      const result = await callTool("set_reading_session_status", {
        sessionId: managedBook.session.id,
        status
      });
      const session = result.structuredContent?.session as ReadingSession | undefined;
      if (!session) throw new Error("Missing updated session");
      updateBookshelfSession(session);
      setManagedBook((current) => current ? { ...current, session } : current);
      setToast(status === "completed" ? "已经标记为完成。" : "已经恢复为阅读中。");
    } catch {
      setToast("作品状态没有更新成功，请重试。");
    }
  }

  async function deleteManagedBook(options: {
    deleteCloudSource: boolean;
    deleteLocalCache: boolean;
  }) {
    if (!managedBook) return;
    const sessionId = managedBook.session.id;
    try {
      const result = await callTool("delete_reading_session", {
        sessionId,
        operationId: createClientId(),
        ...(options.deleteCloudSource ? { deleteCloudSource: true } : {})
      });
      const cloudSourceDeleteError = result.structuredContent?.cloudSourceDeleteError;
      optimisticSessionIdsRef.current.delete(sessionId);
      setRecent((items) => items.filter((item) => item.session.id !== sessionId));
      setReadingRecords((records) => records.filter((record) => record.sessionId !== sessionId));
      setOpenOutput((current) =>
        current
          ? {
              ...current,
              bookshelf: current.bookshelf?.filter((item) => item.id !== sessionId),
              bookshelfSessions: current.bookshelfSessions?.filter(
                (item) => item.session.id !== sessionId
              ),
              recentSessions: current.recentSessions?.filter(
                (item) => item.session.id !== sessionId
              ),
              readingRecords: current.readingRecords?.filter(
                (record) => record.sessionId !== sessionId
              )
            }
          : current
      );
      setSelectedBook((current) => current?.session.id === sessionId ? null : current);
      setManagedBook(null);
      setOverlay(null);
      navigationRequestRef.current += 1;
      setScreen("home");
      if (options.deleteLocalCache) {
        try {
          await cache.remove(sessionId);
          await cache.removeSyncJob(sessionId).catch(() => undefined);
          setToast(
            cloudSourceDeleteError
              ? "云端阅读数据已删除，但云端正文副本删除失败；本设备正文缓存已删除。"
              : options.deleteCloudSource
                ? "云端阅读数据、云端正文副本和本设备正文缓存都已删除。"
                : "云端阅读数据和本设备正文缓存都已删除。"
          );
        } catch {
          setToast(
            cloudSourceDeleteError
              ? "云端阅读数据已删除，但云端正文副本删除失败；本设备正文缓存清除失败。"
              : "云端阅读数据已删除，但本设备正文缓存清除失败。"
          );
        }
      } else {
        setToast(
          cloudSourceDeleteError
            ? "云端阅读数据已删除，但云端正文副本删除失败；本设备正文缓存仍保留。"
            : options.deleteCloudSource
              ? "云端阅读数据和云端正文副本已删除，本设备正文缓存仍保留。"
              : "云端阅读数据已删除，本设备正文缓存仍保留。"
        );
      }
    } catch {
      setToast("这本书没有删除成功，请重试。");
    }
  }

  function updateBookshelfSession(session: ReadingSession) {
    setRecent((items) =>
      items.map((item) =>
        item.session.id === session.id ? { ...item, session } : item
      )
    );
    setSessionBundle((current) =>
      current?.session.id === session.id ? { ...current, session } : current
    );
    setSelectedBook((current) =>
      current?.session.id === session.id ? { ...current, session } : current
    );
    setManagedBook((current) =>
      current?.session.id === session.id ? { ...current, session } : current
    );
  }

  async function importNovelFile(file: File | undefined) {
    if (!file) return;
    const isEpub = /\.epub$/i.test(file.name) || file.type === "application/epub+zip";
    const isText = /\.(txt|md|markdown)$/i.test(file.name);
    if (!isEpub && !isText) {
      setToast("目前支持 EPUB、TXT 和 Markdown 文档。");
      setImportProgress({
        stage: "failed",
        fileName: file.name,
        fileSize: file.size,
        sourceEndpointBasePresent: Boolean(sourceEndpointBase),
        screen,
        message: "不支持的文件格式"
      });
      return;
    }
    const sizeLimit = isEpub ? MAX_EPUB_FILE_SIZE : MAX_NOVEL_FILE_SIZE;
    if (file.size > sizeLimit) {
      setToast(isEpub ? "EPUB 超过 50 MB，请换一个较小版本。" : "文档超过 5 MB，请拆分后再导入。");
      setImportProgress({
        stage: "failed",
        fileName: file.name,
        fileSize: file.size,
        sourceEndpointBasePresent: Boolean(sourceEndpointBase),
        screen,
        message: `文件超过 ${isEpub ? "50" : "5"} MB`
      });
      return;
    }

    setImportProgress({
      stage: "reading",
      fileName: file.name,
      fileSize: file.size,
      sourceEndpointBasePresent: Boolean(sourceEndpointBase),
      screen,
      message: "正在读取文件"
    });
    try {
      const parsed = isEpub
        ? await readEpub(file)
        : { title: "", text: await readTextFile(file) };
      const result = parsed.text;
      if (!result.trim()) {
        setSourceText("");
        setToast("文档解析为空；如果 EPUB 带有加密，请换无加密版本或转成 TXT。");
        setImportProgress((current) => ({
          ...current,
          stage: "failed",
          decodedTextLength: result.length,
          screen,
          message: "解析为空"
        }));
        return;
      }
      setSourceText(result);
      setTitle(
        (current) =>
          current.trim() || parsed.title || file.name.replace(/\.(epub|txt|md|markdown)$/i, "")
      );
      setImportProgress((current) => ({
        ...current,
        stage: "ready",
        decodedTextLength: result.length,
        sourceEndpointBasePresent: Boolean(sourceEndpointBase),
        screen,
        message: file.size > LARGE_NOVEL_TEXTAREA_PREVIEW_BYTES ? "大文件已读取，准备分段" : "文档已读取"
      }));
      setToast(isEpub ? "EPUB 已导入并提取正文。" : "文档已导入，你仍然可以继续编辑正文。");
    } catch {
      setToast(
        isEpub
          ? "EPUB 读取失败；它可能带有加密或特殊压缩，可以先转成 TXT。"
          : "读取失败，请确认文件是 UTF-8 文本，或改用复制粘贴。"
      );
      setImportProgress((current) => ({
        ...current,
        stage: "failed",
        screen,
        message: isEpub ? "EPUB 解析失败" : "读取失败"
      }));
    }
  }

  async function startReading() {
    const navigationRequest = ++navigationRequestRef.current;
    const requestIsCurrent = () => navigationRequestRef.current === navigationRequest;
    if (!title.trim()) return setToast("请先填写作品名。");
    if (!sourceText.trim()) {
      setImportProgress((current) => ({
        ...current,
        stage: "failed",
        screen,
        message: "正文为空"
      }));
      return setToast("请先粘贴小说正文。");
    }
    let novelChunks: string[] = [];
      setImportProgress((current) => ({
        ...current,
        stage: "segmenting",
        decodedTextLength: sourceText.length,
        sourceEndpointBasePresent: Boolean(sourceEndpointBase),
        indexedDbStatus: "not_started",
        screen,
        message: "正在分段"
      }));
      await nextFrame();
      if (!requestIsCurrent()) return;
      novelChunks = splitNovelText(sourceText);
      if (novelChunks.length === 0) {
        setImportProgress((current) => ({
          ...current,
          stage: "failed",
          paragraphCount: 0,
          screen,
          message: "正文为空"
        }));
        return setToast("请先粘贴小说正文。");
      }
      setImportProgress((current) => ({
        ...current,
        paragraphCount: novelChunks.length,
        screen,
        message: "分段完成"
      }));
      await nextFrame();
      if (!requestIsCurrent()) return;

    let session = existingSession;
    const creatingNewSession = !session;
    if (!session) {
      setImportProgress((current) => ({
        ...current,
        stage: "creating_session",
        paragraphCount: novelChunks.length,
        screen,
        message: "正在创建阅读小窝"
      }));
      await nextFrame();
      if (!requestIsCurrent()) return;
      const result = await callTool("start_reading_session", { title: title.trim(), type: "novel" });
      if (!requestIsCurrent()) return;
      session = ensureSessionDefaults(
        result.structuredContent?.session as ReadingSession | undefined ??
          createLocalSession(title.trim())
      );
    }
    if (!session) throw new Error("Failed to create reading session");
    setImportProgress((current) => ({
      ...current,
      sessionId: session?.id,
      screen,
      message: "阅读小窝已创建"
    }));
    await nextFrame();
    if (!requestIsCurrent()) return;
    let sourceManifest = await createNovelSourceManifest({
      sourceId: session.sourceManifest?.sourceId ?? createClientId(),
      sourceKind: "pasted_text",
      title: title.trim(),
      sourceText
    });
    if (!requestIsCurrent()) return;
    const importedAvailability = session.sourceManifest
      ? getSourceAvailability(session.sourceManifest, sourceManifest)
      : "available_local";
    if (importedAvailability !== "available_local") {
      setSourceAvailability(importedAvailability);
      setToast("当前导入内容与原 session 不一致，已阻止套用旧进度。");
      return;
    }
    let cloudUploadFailed = false;
    let cloudUploadError = "";
    let cloudDiagnostics: CloudUploadDiagnostics | undefined;
    let serverSideCloudUploadOnly = false;
    const startUnavailable = !canCallTool();
    if (!startUnavailable) {
      const sessionId = session.id;
      setImportProgress((current) => ({
        ...current,
        stage: "uploading",
        sessionId,
        paragraphCount: novelChunks.length,
        sourceEndpointBasePresent: Boolean(sourceEndpointBase),
        uploadStatus: "started",
        screen,
        message: "正在上传云端正文"
      }));
      await nextFrame();
      if (!requestIsCurrent()) return;
      const upload = await cloudSourceClient.uploadNovelSource({
          sessionId,
          title: title.trim(),
          sourceText
        });
      if (!requestIsCurrent()) return;
      cloudDiagnostics = upload.diagnostics;
      if (upload.sourceManifest?.cloudSync.enabled) {
        sourceManifest = upload.sourceManifest;
        setImportProgress((current) => ({
          ...current,
          uploadStatus: "success",
          sourceId: sourceManifest.sourceId,
          sizeBytes: sourceManifest.cloudSync.sizeBytes,
          paragraphCount: sourceManifest.paragraphCount ?? novelChunks.length,
          screen,
          message: "云端正文已上传"
        }));
      } else if (upload.diagnostics.bridgeUploadStatus === "success") {
        serverSideCloudUploadOnly = true;
        setImportProgress((current) => ({
          ...current,
          uploadStatus: "success",
          screen,
          message: "云端正文已上传"
        }));
      } else {
        cloudUploadFailed = true;
        cloudUploadError = formatCloudUploadDiagnostics(upload.diagnostics);
        setImportProgress((current) => ({
          ...current,
          uploadStatus: upload.diagnostics.directUploadStatus,
          screen,
          message: "云端上传失败，继续创建本地阅读"
        }));
      }

    let setSourceManifestCalled = false;
    let setSourceManifestStatus: "not_called" | "success" | "failure" = "not_called";
    if (!serverSideCloudUploadOnly) {
      setSourceManifestCalled = true;
      try {
        setImportProgress((current) => ({
          ...current,
          stage: "saving_manifest",
          sessionId: session?.id,
          paragraphCount: sourceManifest.paragraphCount ?? current.paragraphCount,
          sourceId: sourceManifest.sourceId,
          screen,
          message: "正在保存正文信息"
        }));
        await nextFrame();
        if (!requestIsCurrent()) return;
        await callTool("set_source_manifest", {
          sessionId: session.id,
          sourceManifest
        });
        if (!requestIsCurrent()) return;
        setSourceManifestStatus = "success";
      } catch {
        setSourceManifestStatus = "failure";
      }
    }
    if (serverSideCloudUploadOnly) {
      const status = await callTool("get_cloud_source_status", { sessionId: session.id }).catch(() => undefined);
      if (!requestIsCurrent()) return;
      const cloudStatus =
        typeof status?.structuredContent?.status === "string"
          ? status.structuredContent.status
          : "unknown";
      cloudUploadFailed = cloudStatus !== "available";
      cloudUploadError = formatCloudUploadDiagnostics(cloudDiagnostics, {
        setSourceManifestCalled,
        setSourceManifestStatus,
        cloudStatus
      });
    } else if (cloudUploadFailed) {
      cloudUploadError = formatCloudUploadDiagnostics(cloudDiagnostics, {
        setSourceManifestCalled,
        setSourceManifestStatus
      });
    }
    } else {
      // No host tool capability (pure browser). Cloud upload and tool writes are
      // unavailable — surface accurate diagnostics without pretending a cloud
      // session was established. Local reading still proceeds below.
      cloudDiagnostics = {
        bridgeToolAvailable: false,
        bridgeUploadStarted: false,
        bridgeUploadStatus: "not_started",
        directUploadStarted: false,
        directUploadStatus: "not_started"
      };
    }
    session = { ...session, sourceManifest };
    if (creatingNewSession) optimisticSessionIdsRef.current.add(session.id);
    setSourceAvailability("available_local");
    const bundle: SessionBundle = {
      session,
      quotes: sessionBundle?.quotes ?? [],
      reactions: sessionBundle?.reactions ?? [],
      bookmarks: sessionBundle?.bookmarks ?? []
    };
    setSessionBundle(bundle);
    setRecent((items) => [
      { ...bundle, sourceAvailability: "available_local" },
      ...items.filter((item) => item.session.id !== session!.id)
    ]);

      setChunks(novelChunks);
      setRemembered(true);
      setScreen("novel");
      try {
        setImportProgress((current) => ({
          ...current,
          stage: "saving_cache",
          sessionId: session.id,
          paragraphCount: novelChunks.length,
          sourceId: sourceManifest.sourceId,
          indexedDbStatus: "not_started",
          screen: "novel",
          message: "正在保存本设备缓存"
        }));
        await nextFrame();
        await rememberNovel(session, sourceText, novelChunks, sourceManifest);
        if (!requestIsCurrent()) return;
        setImportProgress((current) => ({
          ...current,
          stage: "done",
          indexedDbStatus: "success",
          screen: "novel",
          message: "导入完成"
        }));
      } catch {
        setRemembered(false);
        setImportProgress((current) => ({
          ...current,
          stage: "done",
          indexedDbStatus: "failure",
          screen: "novel",
          message: "本设备缓存写入失败，已进入阅读页"
        }));
        setToast(
          cloudUploadFailed
            ? `云端同步失败：${cloudUploadError}；本设备正文缓存写入失败，当前仍可继续阅读，请保留原文。`
            : "本设备正文缓存写入失败，当前仍可继续阅读；关闭后可从云端恢复。"
        );
        return;
      }
      if (startUnavailable) {
        setToast("已进入本地阅读模式；星星陪读与云端同步需在 ChatGPT 内使用。");
      } else if (cloudUploadFailed) {
        setToast(`云端同步失败：${cloudUploadError}；已保留本设备正文。`);
      }

  }

  async function submitReadingSetup() {
    if (startReadingInFlight) return;
    setStartReadingInFlight(true);
    try {
      await startReading();
    } catch {
      setToast("创建阅读小窝失败，请重试；正文仍保留在当前页面。");
    } finally {
      setStartReadingInFlight(false);
    }
  }

  function updateActiveReadingRecord(session: ReadingSession) {
    const position = positionWithKnownTotal(session.userCurrentPosition, chunks.length);
    const current = activeReadingRecordRef.current;
    if (!current || current.sessionId !== session.id) {
      const startedAtMs = Date.now();
      activeReadingRecordRef.current = {
        operationId: createClientId(),
        sessionId: session.id,
        bookTitle: session.title,
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        startPosition: structuredClone(position),
        endPosition: structuredClone(position),
        visitedPageIndexes: new Set([position.index])
      };
      return;
    }
    current.bookTitle = session.title;
    current.endPosition = structuredClone(position);
    current.visitedPageIndexes.add(position.index);
  }

  async function finalizeActiveReadingRecord() {
    const draft = activeReadingRecordRef.current;
    if (!draft) return;
    activeReadingRecordRef.current = null;
    const endedAtMs = Date.now();
    const endedAt = new Date(endedAtMs).toISOString();
    const durationSeconds = Math.max(1, Math.round((endedAtMs - draft.startedAtMs) / 1000));
    const pagesRead = Math.max(1, draft.visitedPageIndexes.size);
    const optimisticRecord: ReadingRecord = {
      id: draft.operationId,
      sessionId: draft.sessionId,
      bookTitle: draft.bookTitle,
      startedAt: draft.startedAt,
      endedAt,
      durationSeconds,
      startPosition: structuredClone(draft.startPosition),
      endPosition: structuredClone(draft.endPosition),
      pagesRead,
      operationId: draft.operationId,
      createdAt: endedAt
    };
    upsertReadingRecord(optimisticRecord);

    try {
      const result = await callTool("save_reading_record", {
        sessionId: draft.sessionId,
        startedAt: draft.startedAt,
        endedAt,
        startPosition: draft.startPosition,
        endPosition: draft.endPosition,
        pagesRead,
        operationId: draft.operationId
      });
      if ("unavailable" in result) return;
      const record = result.structuredContent?.record as ReadingRecord | undefined;
      if (record) upsertReadingRecord(record);
    } catch {
      // Do not interrupt leaving the reader when the metadata write is unavailable.
    }
  }

  function upsertReadingRecord(record: ReadingRecord) {
    setReadingRecords((records) =>
      sortReadingRecords([
        record,
        ...records.filter(
          (item) =>
            item.id !== record.id &&
            (!record.operationId || item.operationId !== record.operationId)
        )
      ])
    );
  }

  async function changePosition(index: number) {
    if (!sessionBundle) return;
    setReaderScrollTop(0);
    const nextPosition = makePosition(index, chunks.length);
    const optimisticSession = {
      ...sessionBundle.session,
      userCurrentPosition: nextPosition,
      updatedAt: new Date().toISOString()
    };
    updateBookshelfSession(optimisticSession);
    setSessionBundle({
      ...sessionBundle,
      session: optimisticSession
    });
    const result = await callTool("update_reading_position", {
      sessionId: sessionBundle.session.id,
      userCurrentPosition: nextPosition
    });
    const savedSession = result.structuredContent?.session as ReadingSession | undefined;
    if (savedSession) updateBookshelfSession(savedSession);
  }

  async function lookAtNovel(
    currentText: string,
    selectedText: string,
    preferenceOverride?: Pick<SessionPreferences, "readingCommentMode" | "commentLength">
  ) {
    if (!sessionBundle) return;
    if (syncRequestInFlight) return;
    const permission = checkSourceSyncPermission({
      mode: "current_only",
      sourceAvailability,
      forceCurrentOnly: true
    });
    if (!permission.allowed) return;
    setSyncRequestInFlight(true);
    try {
      const sourceContext = getSourceContext(sessionBundle.session.sourceManifest);
      const operationId = createClientId();
      const activePreferences = preferenceOverride ?? sessionBundle.session.sessionPreferences;
      const policyPrompt = buildCurrentOnlyPrompt({
        sessionId: sessionBundle.session.id,
        title: sessionBundle.session.title,
        position: sessionBundle.session.userCurrentPosition.index,
        text: currentText,
        hasUnconfirmedGap:
          sessionBundle.session.userCurrentPosition.index >
          (sessionBundle.session.assistantSyncedPosition?.index ?? 0),
        mode: activePreferences.readingCommentMode,
        length: activePreferences.commentLength,
        operationId
      });
      const result = await callTool("send_current_context", {
        sessionId: sessionBundle.session.id,
        currentPosition: sessionBundle.session.userCurrentPosition,
        mode: "current_only",
        currentText,
        readingCommentMode: activePreferences.readingCommentMode,
        commentLength: activePreferences.commentLength,
        ...(selectedText ? { selectedText } : {}),
        ...(sourceContext ? { sourceContext } : {}),
        ...(permission.userNote ? { userNote: permission.userNote } : {})
      });
      if ("unavailable" in result) {
        setToast(NO_HOST_MESSAGE);
        return;
      }
      const context = result.structuredContent?.context as Record<string, unknown> | undefined;
      if (!context) {
        setToast("当前页同步失败，请再试一次。");
        return;
      }
      const fallbackPrompt = [
        policyPrompt,
        selectedText ? `我选中的句子：${selectedText}` : ""
      ].filter(Boolean).join("\n");
      const mode = await syncCurrentContext({
        context,
        messagePrompt: buildCurrentPageRequest({
          title: sessionBundle.session.title,
          page: sessionBundle.session.userCurrentPosition.index,
          hasSelectedText: Boolean(selectedText)
        }),
        fallbackMessagePrompt: fallbackPrompt,
        updateModelContext,
        sendMessage: askChatGpt,
        scrollToBottom: true
      });
      setToast(
        mode === "context"
          ? `已同步${sessionBundle.session.userCurrentPosition.label}，星星正在看这里。`
          : "已用兼容模式发送当前页。"
      );
    } finally {
      setSyncRequestInFlight(false);
    }
  }

  async function shareNovelPage(currentText: string) {
    if (!sessionBundle || syncRequestInFlight) return;
    const currentPosition = sessionBundle.session.userCurrentPosition;
    const savedThoughts = formatPageThoughts(
      sessionBundle.quotes.filter(
        (quote) =>
          quote.position.kind === currentPosition.kind &&
          quote.position.index === currentPosition.index &&
          quote.note
      )
    );
    const sourceContext = getSourceContext(sessionBundle.session.sourceManifest);
    const replyOperationId = createClientId();
    const prompt = [
      `我刚读完《${sessionBundle.session.title}》的第 ${currentPosition.index} 页，想和你一起聊聊。`,
      savedThoughts
        ? "请先读取我刚分享的这一页和保存的想法，直接回应我的想法，再聊你最有共鸣的 1-2 个点。"
        : "请先读取我刚分享的这一页，挑最有意思的 1-3 个点自然地和我聊。",
      "不要复述正文、逐条转抄想法，也不要概括前面的内容。",
      `形成回应后，先调用 save_shared_reading_reply，把同一份回应保存到 sessionId=${sessionBundle.session.id}、positionIndex=${currentPosition.index}，operationId=${replyOperationId}；保存后再在聊天里自然回复。`
    ].join("\n");
    setSyncRequestInFlight(true);
    try {
      const result = await callTool("send_current_context", {
        sessionId: sessionBundle.session.id,
        currentPosition,
        mode: "current_only",
        currentText,
        readingCommentMode: "light_chat",
        commentLength: "normal",
        ...(savedThoughts ? { userNote: savedThoughts.slice(0, 4_000) } : {}),
        ...(sourceContext ? { sourceContext } : {})
      });
      if ("unavailable" in result) {
        setToast(NO_HOST_MESSAGE);
        return;
      }
      const context = result.structuredContent?.context as Record<string, unknown> | undefined;
      if (!context) {
        setToast("这一页没有发送成功，请再试一次。");
        return;
      }
      await syncCurrentContext({
        context,
        messagePrompt: prompt,
        fallbackMessagePrompt: buildShareFallbackPrompt({
          prompt,
          currentText,
          savedThoughts
        }),
        updateModelContext,
        sendMessage: askChatGpt,
        scrollToBottom: true
      });
      setToast("这一页和你的想法已经发给星星。你可以继续往下读。");
    } finally {
      setSyncRequestInFlight(false);
    }
  }

  async function askAboutNovelSelection(selectedText: string, question: string) {
    if (!sessionBundle || syncRequestInFlight || !selectedText.trim() || !question.trim()) return;
    const savedQuote = await saveQuoteThought(selectedText, `提问：${question.trim()}`);
    const currentPosition = sessionBundle.session.userCurrentPosition;
    const sourceContext = getSourceContext(sessionBundle.session.sourceManifest);
    const replyOperationId = createClientId();
    const prompt = [
      `【只问这一句】我在《${sessionBundle.session.title}》第 ${currentPosition.index} 页划了一句话。`,
      `我的问题：${question.trim()}`,
      "请只围绕这句划线和这个问题回答，不要概括整页，也不要分析没有选中的内容。",
      savedQuote
        ? `形成回应后，先调用 save_shared_reading_reply，把同一份回应保存到 sessionId=${sessionBundle.session.id}、quoteId=${savedQuote.id}、operationId=${replyOperationId}；保存后再在聊天里自然回复。`
        : `形成回应后，先调用 save_shared_reading_reply，把同一份回应保存到 sessionId=${sessionBundle.session.id}、positionIndex=${currentPosition.index}、operationId=${replyOperationId}；保存后再在聊天里自然回复。`
    ].join("\n");
    setSyncRequestInFlight(true);
    try {
      const result = await callTool("send_current_context", {
        sessionId: sessionBundle.session.id,
        currentPosition,
        mode: "selected_text",
        selectedText: selectedText.trim(),
        userNote: question.trim(),
        readingCommentMode: "light_chat",
        commentLength: "normal",
        ...(sourceContext ? { sourceContext } : {})
      });
      if ("unavailable" in result) {
        setToast(NO_HOST_MESSAGE);
        return;
      }
      const context = result.structuredContent?.context as Record<string, unknown> | undefined;
      if (!context) {
        setToast("这句没有发送成功，请再试一次。");
        return;
      }
      await syncCurrentContext({
        context,
        messagePrompt: prompt,
        fallbackMessagePrompt: [
          prompt,
          `划线原文：“${selectedText.trim()}”`
        ].join("\n"),
        updateModelContext,
        sendMessage: askChatGpt,
        scrollToBottom: true
      });
      setToast("只把这句和你的问题发给了星星。");
    } finally {
      setSyncRequestInFlight(false);
    }
  }

  async function startFullCatchUp(prebuilt?: ReturnType<typeof buildSyncBatches>) {
    if (!sessionBundle) return;
    if (syncJobRef.current) return;
    if (!allowAutomaticSync("range_sync")) return;
    const userIndex = sessionBundle.session.userCurrentPosition.index;
    const assistantIndex = sessionBundle.session.assistantSyncedPosition?.index ?? 0;
    const batches =
      prebuilt ??
      buildSyncBatches({
        chunks,
        rangeStart: assistantIndex + 1,
        rangeEnd: userIndex,
        idFactory: (ordinal) => `${sessionBundle.session.id}-${Date.now()}-${ordinal}`
      });
    const job: ReadingSyncJob = {
      sessionId: sessionBundle.session.id,
      title: sessionBundle.session.title,
      type: "novel",
      mode: "range_sync",
      targetPosition: sessionBundle.session.userCurrentPosition,
      confirmedThrough: sessionBundle.session.assistantSyncedPosition,
      batches,
      activeBatchIndex: 0,
      createdAt: new Date().toISOString()
    };
    setSyncChoiceOpen(false);
    storeSyncJob(job);
    await cache.putSyncJob(job).catch(() => undefined);
    await sendSyncBatch(job);
  }

  async function sendSyncBatch(job: ReadingSyncJob) {
    const batch = getActiveBatch(job);
    if (!batch) return;
    const permission = checkSourceSyncPermission({
      mode: job.mode,
      sourceAvailability
    });
    if (!permission.allowed) {
      setToast(sourceSyncBlockedMessage(sourceAvailability));
      return;
    }
    const sourceContext = getSourceContext(sessionBundle?.session.sourceManifest);
    try {
      await callTool("send_current_context", {
        sessionId: job.sessionId,
        previousSyncedPosition: job.confirmedThrough,
        currentPosition: job.targetPosition,
        contextRange: { start: batch.rangeStart, end: batch.rangeEnd },
        includedText: batch.text,
        userNote: buildBatchUserNote(job, batch),
        ...(sourceContext ? { sourceContext } : {}),
        mode: "range_sync",
        batch: {
          id: batch.id,
          ordinal: batch.ordinal,
          total: batch.totalBatches,
          rangeStart: batch.rangeStart,
          rangeEnd: batch.rangeEnd,
          hasMore: !batch.isFinal
        }
      });
      await askChatGpt(buildBatchChatMessage(job, batch), { scrollToBottom: false });
      const sent = markBatchSent(job, batch.id);
      storeSyncJob(sent);
      await cache.putSyncJob(sent).catch(() => undefined);
    } catch {
      const failed = markBatchFailed(job, batch.id);
      storeSyncJob(failed);
      await cache.putSyncJob(failed).catch(() => undefined);
    }
  }

  async function confirmSyncBatch() {
    if (!syncJob || !sessionBundle) return;
    const batch = getActiveBatch(syncJob);
    if (!batch || batch.status !== "sent-awaiting-confirmation") return;
    const confirmedPosition = makePosition(batch.rangeEnd, chunks.length);
    if (syncJob.mode !== "recent_only") {
      await callTool("confirm_assistant_synced_position", {
        sessionId: syncJob.sessionId,
        confirmedPosition,
        batchId: batch.id,
        operationId: `confirm-${batch.id}`
      });
    }
    const confirmed = markBatchConfirmed(syncJob, batch.id);
    if (syncJob.mode !== "recent_only") {
      setSessionBundle({
        ...sessionBundle,
        session: {
          ...sessionBundle.session,
          assistantSyncedPosition: confirmedPosition,
          updatedAt: new Date().toISOString()
        }
      });
    }
    if (batch.isFinal) {
      if (confirmed.mode === "live_reading") {
        clearSyncJobState();
        await cache.removeSyncJob(syncJob.sessionId).catch(() => undefined);
        setToast(`已确认星星读到第 ${batch.rangeEnd} 页。`);
        return;
      }
      const formalMode = sessionBundle.session.sessionPreferences.readingCommentMode;
      const formalLength = sessionBundle.session.sessionPreferences.commentLength;
      const formalOperationId = `catch-up-comment-${batch.id}`;
      const prompt =
        confirmed.type === "novel"
          ? buildFormalReadingPrompt(confirmed, {
              mode: formalMode,
              length: formalLength,
              operationId: formalOperationId
            })
          : buildReadingCommentPrompt({
              sessionId: confirmed.sessionId,
              mode: formalMode,
              length: formalLength,
              title: confirmed.title,
              position: confirmed.targetPosition,
              syncedRange: {
                start: confirmed.batches[0]?.rangeStart ?? batch.rangeEnd,
                end: batch.rangeEnd
              },
              source: "catch_up_complete",
              operationId: formalOperationId
      });
      void askChatGpt(prompt, { scrollToBottom: false }).catch(() => {
        setToast("正式共读回应没有发送成功，请重试。");
      });
      clearSyncJobState();
      await cache.removeSyncJob(syncJob.sessionId).catch(() => undefined);
      setToast("星星追上你啦，可以正式陪读了。");
      return;
    }
    storeSyncJob(confirmed);
    await cache.putSyncJob(confirmed).catch(() => undefined);
    await sendSyncBatch(confirmed);
  }

  async function sendRecentNovelContext() {
    if (!sessionBundle) return;
    if (!allowAutomaticSync("recent_only")) return;
    const end = sessionBundle.session.userCurrentPosition.index;
    const start = Math.max(1, end - 4);
    const text = chunks
      .slice(start - 1, end)
      .map((chunk, offset) => `【第 ${start + offset} 页】\n${chunk}`)
      .join("\n\n");
    setSyncChoiceOpen(false);
    await askChatGpt(
      buildRecentOnlyPrompt({
        sessionId: sessionBundle.session.id,
        title: sessionBundle.session.title,
        rangeStart: start,
        rangeEnd: end,
        text,
        mode: sessionBundle.session.sessionPreferences.readingCommentMode,
        length: sessionBundle.session.sessionPreferences.commentLength,
        operationId: createClientId()
      }),
      { scrollToBottom: false }
    );
  }

  async function cancelCurrentSync() {
    setSyncChoiceOpen(false);
    if (!syncJob) return;
    const cancelled = cancelSyncJob(syncJob);
    clearSyncJobState();
    await cache.putSyncJob(cancelled).catch(() => undefined);
  }

  const sendLiveReading = useCallback(
    async (index: number) => {
      if (!sessionBundle || sessionBundle.session.type !== "novel" || syncJob) return;
      const session = sessionBundle.session;
      if (
        session.assistantSyncedPosition?.kind === session.userCurrentPosition.kind &&
        session.assistantSyncedPosition.index >= index
      ) {
        return;
      }
      const permission = checkSourceSyncPermission({
        mode: "live_reading",
        sourceAvailability
      });
      if (!permission.allowed) return;
      const mode = session.sessionPreferences.readingCommentMode;
      const length = session.sessionPreferences.commentLength;
      const operationId = buildLiveReadingOperationId(session.id, session.userCurrentPosition.kind, index, mode, length);
      const sourceContext = getSourceContext(session.sourceManifest);
      const start = Math.max(1, index - 1);
      const text = chunks
        .slice(start - 1, index)
        .map((chunk, offset) => `【第 ${start + offset} 页】\n${chunk}`)
        .join("\n\n");
      const batch = {
        id: operationId,
        ordinal: 1,
        totalBatches: 1,
        rangeStart: start,
        rangeEnd: index,
        characterCount: text.length,
        text,
        isFinal: true,
        oversizedParagraph: false,
        status: "pending" as const
      };
      const job: ReadingSyncJob = {
        sessionId: sessionBundle.session.id,
        title: session.title,
        type: "novel",
        mode: "live_reading",
        targetPosition: session.userCurrentPosition,
        confirmedThrough: session.assistantSyncedPosition,
        batches: [batch],
        activeBatchIndex: 0,
        createdAt: new Date().toISOString()
      };
      try {
        await callTool("send_current_context", {
          sessionId: job.sessionId,
          previousSyncedPosition: job.confirmedThrough,
          currentPosition: job.targetPosition,
          contextRange: { start, end: index },
          includedText: text,
          ...(sourceContext ? { sourceContext } : {}),
          mode: "live_reading",
          batch: {
            id: batch.id,
            ordinal: 1,
            total: 1,
            rangeStart: start,
            rangeEnd: index,
            hasMore: false
          }
        });
        await askChatGpt(
          buildLiveReadingPrompt({
            sessionId: sessionBundle.session.id,
            title: session.title,
            position: job.targetPosition,
            operationId: batch.id,
            requestedMode: mode,
            requestedLength: length
          }),
          { scrollToBottom: false }
        );
        const sent = markBatchSent(job, batch.id);
        storeSyncJob(sent);
        await cache.putSyncJob(sent).catch(() => undefined);
      } catch {
        setToast("这次实时跟读没有发送成功。");
      }
    },
    [chunks, sessionBundle, sourceAvailability, syncJob]
  );

  useLiveReading({
    enabled: false,
    userPositionIndex: sessionBundle?.session.userCurrentPosition.index ?? 1,
    isScrolling: false,
    hasPendingConfirmation: Boolean(syncJob),
    triggerKey: sessionBundle
      ? buildLiveReadingOperationId(
          sessionBundle.session.id,
          sessionBundle.session.userCurrentPosition.kind,
          sessionBundle.session.userCurrentPosition.index,
          sessionBundle.session.sessionPreferences.readingCommentMode,
          sessionBundle.session.sessionPreferences.commentLength
        )
      : undefined,
    hasUnconfirmedGap:
      Boolean(sessionBundle) &&
      (sessionBundle!.session.userCurrentPosition.index -
        (sessionBundle!.session.assistantSyncedPosition?.index ?? 0) >
        2),
    sourceVerified:
      sourceAvailability === "available_local" &&
      !(
        sessionBundle?.session.assistantSyncedPosition?.kind ===
          sessionBundle?.session.userCurrentPosition.kind &&
        (sessionBundle?.session.assistantSyncedPosition?.index ?? 0) >=
          (sessionBundle?.session.userCurrentPosition.index ?? 1)
      ),
    delayMs: 1_800,
    onStablePosition: sendLiveReading
  });

  function allowAutomaticSync(mode: "range_sync" | "recent_only" | "live_reading") {
    const permission = checkSourceSyncPermission({ mode, sourceAvailability });
    if (permission.allowed) return true;
    setToast(sourceSyncBlockedMessage(sourceAvailability));
    return false;
  }

  function appendSessionRecord(
    sessionId: string,
    patch: Partial<Pick<SessionBundle, "quotes" | "reactions" | "bookmarks">>
  ) {
    const applyPatch = <T extends SessionBundle | BookshelfItem>(bundle: T): T => ({
      ...bundle,
      ...(patch.quotes ? { quotes: [...bundle.quotes, ...patch.quotes] } : {}),
      ...(patch.reactions ? { reactions: [...bundle.reactions, ...patch.reactions] } : {}),
      ...(patch.bookmarks ? { bookmarks: [...bundle.bookmarks, ...patch.bookmarks] } : {})
    });
    setSessionBundle((current) =>
      current?.session.id === sessionId ? applyPatch(current) : current
    );
    setRecent((items) =>
      items.map((item) => (item.session.id === sessionId ? applyPatch(item) : item))
    );
    setManagedBook((current) =>
      current?.session.id === sessionId ? applyPatch(current) : current
    );
    setSelectedBook((current) =>
      current?.session.id === sessionId ? applyPatch(current) : current
    );
  }

  function replaceSessionQuote(sessionId: string, quote: Quote) {
    const replace = <T extends SessionBundle | BookshelfItem>(bundle: T): T => ({
      ...bundle,
      quotes: bundle.quotes.map((item) => (item.id === quote.id ? quote : item))
    });
    setSessionBundle((current) =>
      current?.session.id === sessionId ? replace(current) : current
    );
    setRecent((items) =>
      items.map((item) => (item.session.id === sessionId ? replace(item) : item))
    );
    setManagedBook((current) =>
      current?.session.id === sessionId ? replace(current) : current
    );
    setSelectedBook((current) =>
      current?.session.id === sessionId ? replace(current) : current
    );
  }

  function removeSessionQuote(sessionId: string, quoteId: string) {
    const remove = <T extends SessionBundle | BookshelfItem>(bundle: T): T => ({
      ...bundle,
      quotes: bundle.quotes.filter((item) => item.id !== quoteId)
    });
    setSessionBundle((current) =>
      current?.session.id === sessionId ? remove(current) : current
    );
    setRecent((items) =>
      items.map((item) => (item.session.id === sessionId ? remove(item) : item))
    );
    setManagedBook((current) =>
      current?.session.id === sessionId ? remove(current) : current
    );
    setSelectedBook((current) =>
      current?.session.id === sessionId ? remove(current) : current
    );
  }

  async function deleteQuoteRecord(sessionId: string, quoteId: string) {
    const result = await callTool("delete_quote", { sessionId, quoteId });
    if ("unavailable" in result || !result.structuredContent?.deleted) {
      setToast("这条记录没有删除成功，请再试一次。");
      return false;
    }
    removeSessionQuote(sessionId, quoteId);
    setToast("这条书内记录已经删除。");
    return true;
  }

  async function deleteArchiveEntry(
    item: BookshelfItem,
    target: ArchiveDeleteTarget
  ): Promise<boolean> {
    if (target.source === "quote") {
      return deleteQuoteRecord(item.session.id, target.recordId);
    }
    const result = await callTool("delete_book_archive_entry", {
      sessionId: item.session.id,
      source: target.source,
      recordId: target.recordId
    });
    if ("unavailable" in result || !result.structuredContent?.deleted) {
      setToast("这条记录没有删除成功，请再试一次。");
      return false;
    }
    if (target.source === "reaction" || target.source === "bookmark") {
      const remove = <T extends SessionBundle | BookshelfItem>(bundle: T): T => ({
        ...bundle,
        ...(target.source === "reaction"
          ? { reactions: bundle.reactions.filter((entry) => entry.id !== target.recordId) }
          : { bookmarks: bundle.bookmarks.filter((entry) => entry.id !== target.recordId) })
      });
      setRecent((items) =>
        items.map((entry) => entry.session.id === item.session.id ? remove(entry) : entry)
      );
      setSessionBundle((current) =>
        current?.session.id === item.session.id ? remove(current) : current
      );
      setSelectedBook((current) =>
        current?.session.id === item.session.id ? remove(current) : current
      );
      setManagedBook((current) =>
        current?.session.id === item.session.id ? remove(current) : current
      );
    } else {
      const session = result.structuredContent?.session as ReadingSession | undefined;
      if (session) updateBookshelfSession(session);
    }
    setToast("这条书内记录已经删除。");
    return true;
  }

  async function saveQuoteThought(content: string, note: string) {
    if (!sessionBundle || !content.trim() || !note.trim()) return undefined;
    const currentPosition = sessionBundle.session.userCurrentPosition;
    const normalizedContent = content.replace(/\s+/g, " ").trim();
    const existing = sessionBundle.quotes.find(
      (quote) =>
        quote.position.kind === currentPosition.kind &&
        quote.position.index === currentPosition.index &&
        quote.content.replace(/\s+/g, " ").trim() === normalizedContent
    );
    const result = existing
      ? await callTool("update_quote_note", {
          sessionId: sessionBundle.session.id,
          quoteId: existing.id,
          note: note.trim()
        })
      : await callTool("save_quote", {
          sessionId: sessionBundle.session.id,
          content: normalizedContent,
          note: note.trim(),
          position: currentPosition,
          operationId: createClientId()
        });
    if ("unavailable" in result) {
      setToast(NO_HOST_MESSAGE);
      return undefined;
    }
    const quote = result.structuredContent?.quote as Quote | undefined;
    if (!quote) {
      setToast("想法没有保存成功，请再试一次。");
      return undefined;
    }
    if (existing) replaceSessionQuote(sessionBundle.session.id, quote);
    else appendSessionRecord(sessionBundle.session.id, { quotes: [quote] });
    setToast(existing ? "这条想法已经修改。" : "想法已经留在这句旁边。");
    return quote;
  }

  async function saveQuoteClearThought(quoteId: string, clearThought: string) {
    if (!sessionBundle) return undefined;
    const result = await callTool("update_quote_note", {
      sessionId: sessionBundle.session.id,
      quoteId,
      clearThought
    });
    if ("unavailable" in result) {
      setToast(NO_HOST_MESSAGE);
      return undefined;
    }
    const quote = result.structuredContent?.quote as Quote | undefined;
    if (!quote) {
      setToast("清思没有保存成功，请再试一次。");
      return undefined;
    }
    replaceSessionQuote(sessionBundle.session.id, quote);
    setToast(quote.clearThought ? "清思已经收好。" : "清思已清空。");
    return quote;
  }

  async function finishToday() {
    if (!sessionBundle) return;
    const currentPosition = sessionBundle.session.userCurrentPosition;
    void finalizeActiveReadingRecord();
    const result = await callTool("finish_today_reading", {
      sessionId: sessionBundle.session.id,
      position: currentPosition,
      createBookmark: true,
      operationId: createClientId()
    });
    const savedSession = result.structuredContent?.session as ReadingSession | undefined;
    const bookmark = result.structuredContent?.bookmark as SessionBundle["bookmarks"][number] | undefined;
    if (savedSession) updateBookshelfSession(savedSession);
    if (bookmark && !sessionBundle.bookmarks.some((item) => item.id === bookmark.id)) {
      appendSessionRecord(sessionBundle.session.id, { bookmarks: [bookmark] });
    }
    saveReaderWidgetState({
      screen: "home",
      sessionId: sessionBundle.session.id,
      positionIndex: currentPosition.index,
      scrollTop: 0,
      immersive: false,
      collapsed: false
    });
    setReaderImmersive(false);
    setReaderCollapsed(false);
    setReaderScrollTop(0);
    setToast(`已经记住第 ${currentPosition.index} 页，下次会从这里继续。`);
    navigationRequestRef.current += 1;
    setScreen("home");
  }

  const readerProps = useMemo(() => ({
    onBack: () => {
      void finalizeActiveReadingRecord();
      navigationRequestRef.current += 1;
      setReaderImmersive(false);
      setReaderCollapsed(false);
      setScreen(readerReturnScreen);
    }
  }), [readerReturnScreen]);

  useEffect(() => {
    if (
      restoreAttempted.current ||
      !restoredWidgetState?.sessionId ||
      restoredWidgetState.screen !== "novel"
    ) return;
    const item = recent.find((candidate) => candidate.session.id === restoredWidgetState.sessionId);
    if (!item) return;
    restoreAttempted.current = true;
    setReaderScrollTop(restoredWidgetState.scrollTop ?? 0);
    void continueReading(item);
  }, [recent, restoredWidgetState]);

  useEffect(() => {
    if (screen !== "novel" || sessionBundle || !restoredWidgetState?.sessionId) return;
    const canDecideRestoreFailed =
      bookshelfState === "failed" ||
      (bookshelfState === "ready" &&
        recent.length > 0 &&
        !recent.some((candidate) => candidate.session.id === restoredWidgetState.sessionId));
    if (!canDecideRestoreFailed) return;
    restoreAttempted.current = true;
    setReaderImmersive(false);
    setReaderCollapsed(false);
    setScreen("home");
  }, [bookshelfState, recent, restoredWidgetState?.sessionId, screen, sessionBundle]);

  const usingLargeNovelPreview =
    sourceText.length > LARGE_NOVEL_TEXTAREA_PREVIEW_CHARS &&
    (importProgress.fileSize ?? 0) > LARGE_NOVEL_TEXTAREA_PREVIEW_BYTES;
  const sourceTextInputValue = usingLargeNovelPreview
    ? `${sourceText.slice(0, LARGE_NOVEL_TEXTAREA_PREVIEW_CHARS)}\n\n（大文件已读取，输入框只显示预览；进入阅读时会使用完整正文。）`
    : sourceText;

  const showHome = screen === "home" || (screen === "novel" && !sessionBundle);

  return (
    <div className={`app app-screen-${screen} library-theme-${librarySkin}`}>
      {showHome ? (
        <Home
          bookshelf={recent}
          readingRecords={readingRecords}
          loading={bookshelfState === "loading"}
          loadError={bookshelfState === "failed"}
          skin={librarySkin}
          onSkinChange={changeLibrarySkin}
          onRefresh={() => void refreshNovelBookshelf()}
          onNew={begin}
          onOpen={(item) => {
            setReaderCollapsed(false);
            openBookCover(item);
          }}
          onReimport={prepareReimport}
          onManage={(item) => void openBookManagement(item)}
          onExpand={() => void requestReaderFullscreen()}
        />
      ) : null}
      {screen === "cover" && selectedBook ? (
        <BookCover
          item={selectedBook}
          onBack={() => {
            navigationRequestRef.current += 1;
            setScreen("home");
          }}
          onRead={(item) => {
            setReaderCollapsed(false);
            setReaderReturnScreen("cover");
            void continueReading(item);
          }}
          onReimport={prepareReimport}
          onManage={(item) => void openBookManagement(item)}
          onJump={(item, targetPosition) => {
            setReaderCollapsed(false);
            setReaderReturnScreen("cover");
            void continueReading(item, targetPosition);
          }}
          onDeleteEntry={deleteArchiveEntry}
        />
      ) : null}
      {screen === "setup" ? (
        <main className="setup-shell">
          <button
            type="button"
            className="back-link"
            onClick={() => {
              navigationRequestRef.current += 1;
              setScreen("home");
            }}
          >
            <ArrowLeft className="library-action-icon" aria-hidden="true" strokeWidth={1.8} />
            <span>返回小窝</span>
          </button>
          <h1>小说共读</h1>
          <p>{existingSession ? `继续《${existingSession.title}》` : "准备好内容，我们就一起开始。"}</p>
          <label>作品名<input aria-label="作品名" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <div className="novel-source-field">
              <label htmlFor="novel-source-text">小说正文</label>
              <textarea
                id="novel-source-text"
                className="source-input"
                value={sourceTextInputValue}
                readOnly={usingLargeNovelPreview}
                onChange={(e) => {
                  setSourceText(e.target.value);
                  setImportProgress({ stage: "idle" });
                }}
                placeholder="粘贴 TXT 或 Markdown 文本"
              />
              {usingLargeNovelPreview ? (
                <p className="source-preview-note">
                  大文件已读取，正文不在输入框里完整展开，避免 iPad 卡住；进入阅读后会使用完整内容。
                </p>
              ) : null}
              <div className="source-import-row">
                <label className="source-import-button">
                  上传 EPUB / TXT / Markdown
                  <input
                    aria-label="上传 TXT / Markdown"
                    type="file"
                    accept=".epub,.txt,.md,.markdown,application/epub+zip,text/plain,text/markdown"
                    onChange={(event) => {
                      void importNovelFile(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </label>
                <span>支持 EPUB、TXT 和 Markdown；EPUB 会自动提取章节正文。</span>
              </div>
              <ImportProgressPanel progress={importProgress} />
            </div>
          <label className="remember-row"><input type="checkbox" checked={remembered} onChange={(e) => setRemembered(e.target.checked)} />在本设备记住这本书</label>
          <p className="privacy-note">
            正文会保存到你的私人云端，供手机和电脑续读；不会自动发给 ChatGPT。只有点“问星星”或“和星星一起看这页”时，选中句子或当前页才会发送。
          </p>
          <button
            className="action-primary wide-button"
            disabled={startReadingInFlight}
            onClick={() => void submitReadingSetup()}
          >
            {startReadingInFlight ? (
              <LoaderCircle
                className="library-action-icon reader-action-spinner"
                aria-hidden="true"
                strokeWidth={1.8}
              />
            ) : (
              <BookOpen className="library-action-icon" aria-hidden="true" strokeWidth={1.8} />
            )}
            <span>{startReadingInFlight ? "正在进入…" : "进入阅读小窝"}</span>
          </button>
        </main>
      ) : null}
      {screen === "novel" && sessionBundle ? (
        <NovelReader
          session={sessionBundle.session}
          chunks={chunks}
          savedQuotes={sessionBundle.quotes}
          savedReactions={sessionBundle.reactions}
          onPosition={changePosition}
          onSharePage={shareNovelPage}
          onAskSelection={askAboutNovelSelection}
          onSaveThought={saveQuoteThought}
          onSaveClearThought={saveQuoteClearThought}
          onDeleteQuote={(quoteId) => deleteQuoteRecord(sessionBundle.session.id, quoteId)}
          onFinish={finishToday}
          onFullscreen={() => void openFullscreenReader()}
          fullscreenLabel={hostLayout.displayMode === "fullscreen" ? "退出全屏" : "全屏阅读"}
          immersive={readerImmersive}
          layoutRevision={hostLayout.revision}
          actionInFlight={syncRequestInFlight}
          canRequestPip={hostLayout.canRequestPip && hostLayout.displayMode !== "pip"}
          onRequestPip={() => void requestReaderPip()}
          collapsed={readerCollapsed}
          onExpand={() => setReaderCollapsed(false)}
          canCollapse={hostLayout.layout === "compact" && hostLayout.displayMode === "inline"}
          onCollapse={() => setReaderCollapsed(true)}
          initialScrollTop={readerScrollTop}
          onScrollPosition={setReaderScrollTop}
          {...readerProps}
        />
      ) : null}
      {overlay === "management" && managedBook ? (
        <BookManagementSheet
          bundle={managedBook}
          onRename={(title) => void renameManagedBook(title)}
          onStatus={(status) => void setManagedBookStatus(status)}
          onDelete={(options) => void deleteManagedBook(options)}
          onClose={() => {
            setManagedBook(null);
            setOverlay(null);
          }}
        />
      ) : null}
      {syncChoiceOpen && sessionBundle ? (
        <SyncChoiceSheet
          assistantLabel={sessionBundle.session.assistantSyncedPosition?.label ?? "开头"}
          userLabel={sessionBundle.session.userCurrentPosition.label}
          recentLabel="补最近 5 页"
          onFull={() => void startFullCatchUp()}
          onCurrent={() => {
            setSyncChoiceOpen(false);
            void lookAtNovel(
              chunks[sessionBundle.session.userCurrentPosition.index - 1] ?? "",
              ""
            );
          }}
          onRecent={() => void sendRecentNovelContext()}
          onCancel={() => setSyncChoiceOpen(false)}
        />
      ) : null}
      {syncJob ? (
        <SyncProgressSheet
          job={syncJob}
          onConfirm={() => void confirmSyncBatch()}
          onRetry={() => void sendSyncBatch(syncJob)}
          onCancel={() => void cancelCurrentSync()}
        />
      ) : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}

function createLocalSession(title: string): ReadingSession {
  const now = new Date().toISOString();
  return {
    id: createClientId(),
    title,
    type: "novel",
    status: "active",
    userCurrentPosition: makePosition(1),
    assistantSyncedPosition: null,
    liveReadingEnabled: false,
    sessionPreferences: structuredClone(DEFAULT_SESSION_PREFERENCES),
    sourceManifest: null,
    createdAt: now,
    updatedAt: now,
    lastReadAt: now
  };
}

function formatCloudUploadDiagnostics(
  diagnostics: CloudUploadDiagnostics | undefined,
  extra: {
    setSourceManifestCalled?: boolean;
    setSourceManifestStatus?: "not_called" | "success" | "failure";
    cloudStatus?: string;
  } = {}
) {
  if (!diagnostics) return "云端正文请求失败";
  return [
    `bridgeToolAvailable=${diagnostics.bridgeToolAvailable ? "yes" : "no"}`,
    `bridgeUploadStarted=${diagnostics.bridgeUploadStarted ? "yes" : "no"}`,
    `bridgeUploadStatus=${diagnostics.bridgeUploadStatus}`,
    diagnostics.bridgeUploadError ? `bridgeUploadError=${diagnostics.bridgeUploadError}` : "",
    `returnedCloudSyncEnabled=${diagnostics.returnedCloudSyncEnabled ? "yes" : "no"}`,
    `directUploadStarted=${diagnostics.directUploadStarted ? "yes" : "no"}`,
    `directUploadStatus=${diagnostics.directUploadStatus}`,
    diagnostics.directUploadError ? `directUploadError=${diagnostics.directUploadError}` : "",
    `setSourceManifestCalled=${extra.setSourceManifestCalled ? "yes" : "no"}`,
    `setSourceManifestStatus=${extra.setSourceManifestStatus ?? "not_called"}`,
    extra.cloudStatus ? `cloudStatus=${extra.cloudStatus}` : ""
  ].filter(Boolean).join("；");
}

function ImportProgressPanel({ progress }: { progress: ImportProgress }) {
  if (progress.stage === "idle") return null;
  return (
    <section className="import-progress" aria-label="导入诊断">
      <strong>导入诊断</strong>
      <p>阶段：{importStageLabel(progress.stage)}</p>
      {progress.fileName ? <p>文件：{progress.fileName}</p> : null}
      {typeof progress.fileSize === "number" ? <p>File.size：{formatBytes(progress.fileSize)}</p> : null}
      {typeof progress.decodedTextLength === "number" ? <p>decodedTextLength：{progress.decodedTextLength}</p> : null}
      <p>sourceEndpointBase：{progress.sourceEndpointBasePresent ? "present" : "missing"}</p>
      {progress.uploadStatus ? <p>upload：{progress.uploadStatus}</p> : null}
      {progress.sourceId ? <p>sourceId：{progress.sourceId}</p> : null}
      {typeof progress.sizeBytes === "number" ? <p>sizeBytes：{progress.sizeBytes}</p> : null}
      {typeof progress.paragraphCount === "number" ? <p>paragraphCount：{progress.paragraphCount}</p> : null}
      {progress.sessionId ? <p>sessionId：{progress.sessionId}</p> : null}
      {progress.indexedDbStatus ? <p>IndexedDB：{progress.indexedDbStatus}</p> : null}
      {progress.screen ? <p>screen：{progress.screen}</p> : null}
      {progress.message ? <p>message：{progress.message}</p> : null}
    </section>
  );
}

function importStageLabel(stage: ImportProgress["stage"]) {
  const labels: Record<ImportProgress["stage"], string> = {
    idle: "等待",
    reading: "读取文件",
    ready: "读取完成",
    segmenting: "正在分段",
    creating_session: "创建 session",
    uploading: "上传云端",
    saving_manifest: "保存 manifest",
    saving_cache: "保存本机缓存",
    done: "完成",
    failed: "失败"
  };
  return labels[stage];
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    if (typeof window === "undefined") return resolve();
    window.setTimeout(resolve, 0);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Text file did not decode as a string"));
    reader.onerror = () => reject(reader.error ?? new Error("Text file read failed"));
    reader.readAsText(file, "UTF-8");
  });
}

function deriveSourceEndpointBase(): string {
  if (typeof window === "undefined") return "/source";
  const match = window.location.pathname.match(/\/mcp\/([^/]+)/);
  if (!match) return "/source";
  return `/source/${match[1]}`;
}

function buildLiveReadingOperationId(
  sessionId: string,
  positionKind: string,
  positionIndex: number,
  mode: string,
  length: string
): string {
  return `live-${sessionId}-${positionKind}-${positionIndex}-${mode}-${length}`;
}

function ensureSessionDefaults(session: ReadingSession): ReadingSession {
  return {
    ...session,
    sessionPreferences:
      session.sessionPreferences ?? structuredClone(DEFAULT_SESSION_PREFERENCES),
    sourceManifest: session.sourceManifest ?? null
  };
}

function mergeBookshelfSnapshot(
  current: BookshelfItem[],
  incoming: BookshelfItem[],
  protectedSessionIds: ReadonlySet<string>
): BookshelfItem[] {
  const incomingIds = new Set(incoming.map((item) => item.session.id));
  const currentById = new Map(current.map((item) => [item.session.id, item]));
  const protectedItems = current.filter(
    (item) => protectedSessionIds.has(item.session.id) && !incomingIds.has(item.session.id)
  );
  const mergedIncoming = incoming.map((item) => {
    const previous = currentById.get(item.session.id);
    if (!previous || item.sourceAvailability !== "unknown") return item;
    return { ...item, sourceAvailability: previous.sourceAvailability };
  });
  return [...protectedItems, ...mergedIncoming];
}

function mergeOpenOutput(
  current: OpenOutput | undefined,
  incoming: OpenOutput | undefined,
  mode: "partial" | "authoritative"
): OpenOutput | undefined {
  const next = normalizeOpenOutput(incoming);
  if (!next) return current;
  const previous = normalizeOpenOutput(current);
  if (!previous) return next;

  const merged: OpenOutput = {
    ...previous,
    ...next
  };
  if (mode === "partial") {
    merged.bookshelfSessions = preserveRicherSessions(
      previous.bookshelfSessions ?? previous.recentSessions,
      next.bookshelfSessions
    );
    merged.recentSessions = preserveRicherSessions(
      previous.recentSessions ?? previous.bookshelfSessions,
      next.recentSessions
    );
    if (
      previous.readingRecords &&
      previous.readingRecords.length > 0 &&
      (!next.readingRecords || next.readingRecords.length === 0)
    ) {
      merged.readingRecords = previous.readingRecords;
    }
  }
  return merged;
}

function preserveRicherSessions(
  previous:
    | Array<SessionBundle & { cacheState?: string }>
    | undefined,
  next:
    | Array<SessionBundle & { cacheState?: string }>
    | undefined
) {
  if (!previous || previous.length === 0) return next;
  if (!next || next.length === 0) return previous;
  const previousHasRichSession = previous.some((item) => item.cacheState !== "summary");
  const nextHasRichSession = next.some((item) => item.cacheState !== "summary");
  return previousHasRichSession && !nextHasRichSession ? previous : next;
}

function normalizeOpenOutput(output: OpenOutput | undefined): OpenOutput | undefined {
  if (
    !output ||
    Array.isArray(output.bookshelfSessions) ||
    Array.isArray(output.recentSessions) ||
    !Array.isArray(output.bookshelf)
  ) {
    return output;
  }

  const bookshelfSessions = output.bookshelf.map((item) => {
    const updatedAt = item.updatedAt ?? new Date(0).toISOString();
    const positionIndex =
      item.currentPositionIndex ?? parsePositionIndex(item.currentPosition) ?? 0;
    return {
      session: {
        id: item.id,
        title: item.title,
        type: item.type ?? ("novel" as const),
        status: item.status ?? ("active" as const),
        userCurrentPosition: {
          kind: "paragraph" as const,
          index: positionIndex,
          ...(item.currentPositionTotal !== undefined
            ? { total: item.currentPositionTotal }
            : {}),
          label: item.currentPosition ?? `第 ${positionIndex} 页`
        },
        assistantSyncedPosition: null,
        liveReadingEnabled: false,
        sessionPreferences: structuredClone(DEFAULT_SESSION_PREFERENCES),
        sourceManifest: null,
        createdAt: updatedAt,
        updatedAt,
        lastReadAt: item.lastReadAt ?? updatedAt
      },
      quotes: [],
      reactions: [],
      bookmarks: [],
      cacheState: "summary"
    };
  });
  return {
    ...output,
    bookshelfSessions,
    recentSessions: bookshelfSessions.slice(0, 10)
  };
}

function normalizeToolResultOutput(result: ToolCallResult): OpenOutput | undefined {
  const privateBookshelf = result._meta?.privateBookshelf;
  const output = {
    ...(result.structuredContent ?? {}),
    ...(privateBookshelf && typeof privateBookshelf === "object" ? privateBookshelf : {})
  };
  return normalizeOpenOutput(
    Object.keys(output).length > 0 ? (output as OpenOutput) : undefined
  );
}

function parsePositionIndex(label: string | undefined): number | undefined {
  const match = label?.match(/\d+/);
  if (!match) return undefined;
  const index = Number.parseInt(match[0], 10);
  return Number.isFinite(index) ? index : undefined;
}

function makePosition(index: number, total?: number): ReadingPosition {
  return {
    kind: "paragraph",
    index,
    ...(total ? { total } : {}),
    label: `第 ${index} 页`
  };
}

function positionWithKnownTotal(position: ReadingPosition, total: number): ReadingPosition {
  return {
    ...structuredClone(position),
    ...(total > 0 ? { total: position.total ?? total } : {})
  };
}

function sortReadingRecords(records: ReadingRecord[]): ReadingRecord[] {
  return [...records].sort((left, right) => right.endedAt.localeCompare(left.endedAt));
}

function readLibrarySkin(): LibrarySkin {
  try {
    const stored = window.localStorage.getItem(LIBRARY_SKIN_STORAGE_KEY);
    if (
      stored === "blue" ||
      stored === "pink" ||
      stored === "beige" ||
      stored === "green"
    ) {
      return stored;
    }
  } catch {
    // Storage is optional inside embedded hosts.
  }
  return "blue";
}

function formatPageThoughts(quotes: Quote[]) {
  return quotes
    .map(
      (quote, index) =>
        `想法 ${index + 1}\n划线：“${quote.content.replace(/\s+/g, " ").trim()}”\n我的想法：${quote.note}`
    )
    .join("\n\n");
}

function buildCurrentPageRequest(input: {
  title: string;
  page: number;
  hasSelectedText: boolean;
}) {
  return input.hasSelectedText
    ? `我正在读《${input.title}》第 ${input.page} 页，请只回应我选中的句子。`
    : `我正在读《${input.title}》第 ${input.page} 页，请直接和我聊这一页。`;
}

function buildShareFallbackPrompt(input: {
  prompt: string;
  currentText: string;
  savedThoughts: string;
}) {
  if (input.savedThoughts) {
    return [
      input.prompt,
      "【兼容模式共读资料：只用于理解，请不要复述】",
      input.savedThoughts.slice(0, 4_000)
    ].join("\n\n");
  }
  return [
    input.prompt,
    "【兼容模式本页节选：只用于理解，请不要复述】",
    compactReadingExcerpt(input.currentText)
  ].join("\n\n");
}

function compactReadingExcerpt(text: string, maxLength = 1_200) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}……`;
}

async function rememberNovel(
  session: ReadingSession,
  sourceText: string,
  chunks: string[],
  sourceManifest: SourceManifest
) {
  await cache.put(createNovelLocalCache(session, sourceText, chunks, sourceManifest));
}

function createNovelLocalCache(
  session: ReadingSession,
  sourceText: string,
  chunks: string[],
  sourceManifest: SourceManifest
): NovelLocalCache {
  return {
    metadata: {
      sessionId: session.id,
      type: "novel",
      title: session.title,
      cacheVersion: 2,
      remembered: true,
      itemCount: chunks.length,
      sourceManifest,
      approximateBytes: new Blob([sourceText]).size,
      updatedAt: new Date().toISOString()
    },
    sourceText,
    chunks
  };
}

async function restoreNovelFromCloudOnce(
  cloudSourceClient: CloudSourceClient,
  sourceEndpointBase: string,
  session: ReadingSession,
  timeoutMs = 7_000
): Promise<RestoredNovel> {
  const key = cloudRestoreKey(sourceEndpointBase, session);
  const activeJob = cloudRestoreJobs.get(key);
  if (activeJob) return activeJob;

  const job = (async () => {
    const restored = await withTimeout(
      cloudSourceClient.restoreNovelSource({ sessionId: session.id }),
      timeoutMs,
      "cloud source restore timed out"
    );
    const restoredChunks = splitNovelTextForVersion(
      restored.sourceText,
      restored.sourceManifest.segmentationVersion
    );
    const localManifest = {
      ...restored.sourceManifest,
      paragraphCount: restoredChunks.length
    };
    const restoredAvailability = getSourceAvailability(
      restored.sourceManifest,
      localManifest
    );
    if (restoredAvailability !== "available_local") {
      throw new Error("Restored source did not match its manifest");
    }
    const restoredSession = {
      ...session,
      sourceManifest: restored.sourceManifest
    };
    const localCache = createNovelLocalCache(
      restoredSession,
      restored.sourceText,
      restoredChunks,
      restored.sourceManifest
    );
    cloudRestoredSources.set(key, localCache);
    await cache.put(localCache).catch(() => undefined);
    return {
      session: restoredSession,
      sourceAvailability: "available_local" as const,
      localCache
    };
  })();

  cloudRestoreJobs.set(key, job);
  try {
    return await job;
  } finally {
    if (cloudRestoreJobs.get(key) === job) {
      cloudRestoreJobs.delete(key);
    }
  }
}

function cloudRestoreKey(sourceEndpointBase: string, session: ReadingSession) {
  return [
    sourceEndpointBase,
    session.id,
    session.sourceManifest?.contentHash ?? "unknown"
  ].join(":");
}

function getSourceContext(sourceManifest: SourceManifest | null | undefined) {
  if (!sourceManifest) return undefined;
  return {
    contentHash: sourceManifest.contentHash,
    segmentationVersion: sourceManifest.segmentationVersion,
    ...(sourceManifest.paragraphCount !== undefined
      ? { paragraphCount: sourceManifest.paragraphCount }
      : {}),
  };
}

function sourceSyncBlockedMessage(sourceAvailability: SourceAvailability) {
  if (
    sourceAvailability === "local_only_missing" ||
    sourceAvailability === "cloud_missing" ||
    sourceAvailability === "cloud_restore_failed"
  ) {
    return "当前设备缺少正文缓存，请重新导入同一份内容后再同步。";
  }
  if (sourceAvailability === "mismatch") {
    return "当前正文版本与原 session 不一致，不能自动补课。";
  }
  if (sourceAvailability === "segmentation_mismatch") {
    return "当前正文分段与原 session 不一致，不能自动补课。";
  }
  return "正文来源尚未验证，暂时不能自动补课。";
}

function sourceReimportMessage(sourceAvailability: SourceAvailability) {
  if (
    sourceAvailability === "local_only_missing" ||
    sourceAvailability === "cloud_missing" ||
    sourceAvailability === "cloud_restore_failed"
  ) {
    return "这本书的进度已同步，但当前设备还没有可用正文。请重新导入后同步到私人云端。";
  }
  if (sourceAvailability === "mismatch") {
    return "当前正文版本与原 session 不一致，可能导致段落错位。请重新导入正确版本。";
  }
  if (sourceAvailability === "segmentation_mismatch") {
    return "当前内容的分段版本不一致，请重新导入或重新分段。";
  }
  return "正文状态尚未验证，请在当前设备重新导入内容完成校验。";
}

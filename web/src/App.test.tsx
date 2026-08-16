import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NovelLocalCache, SessionBundle, SourceManifest } from "@ss/shared";
import { App } from "./App.js";
import { createNovelSourceManifest } from "./features/source-identity/source-manifest.js";
import { IndexedDbReadingCache } from "./storage/indexeddb-cache.js";

describe("App", () => {
  beforeEach(async () => {
    await deleteTestDatabase("ss-reading-nest");
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [] },
        callTool: vi.fn()
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the novel-only reading entry and bookshelf section", () => {
    render(<App />);
    expect(screen.getAllByText("阿雾和陆沉的共读小巢").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /小说共读/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "书架" })).toBeInTheDocument();
  });

  it("recovers the novel shelf when the opening result arrives late", async () => {
    const bundle = bookshelfBundle("late-output-book", "后来找回的小说", 2, "light_chat", manifest("late-output", "a"));
    const callTool = vi.fn(async (name: string) => {
      if (name === "get_novel_bookshelf") {
        return { structuredContent: { bookshelfSessions: [bundle], recentSessions: [bundle] } };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [] },
        callTool
      }
    });

    render(<App />);

    expect(await screen.findByText("后来找回的小说")).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith("get_novel_bookshelf", {});
  });

  it("recovers the bookshelf directly when the client bridge omits tool data", async () => {
    const bundle = bookshelfBundle(
      "direct-recovery-book",
      "客户端独立找回的小说",
      23,
      "light_chat",
      manifest("direct-recovery", "b")
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          bookshelfSessions: [bundle],
          recentSessions: [bundle],
          readingRecords: []
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: {
          sourceEndpointBase: "https://worker.example.test/source/private-token"
        },
        callTool: vi.fn().mockRejectedValue(new Error("client bridge unavailable"))
      }
    });

    render(<App />);

    expect(await screen.findByText("客户端独立找回的小说")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.example.test/source/private-token/bootstrap",
      expect.objectContaining({ method: "GET", cache: "no-store" })
    );
  });

  it("falls back to the launcher when a mobile host blocks the private bookshelf tool", async () => {
    const bundle = bookshelfBundle(
      "mobile-fallback-book",
      "手机端找回的小说",
      23,
      "light_chat",
      manifest("mobile-fallback", "m")
    );
    const callTool = vi.fn(async (name: string) => {
      if (name === "get_novel_bookshelf") {
        throw new Error("private app tool unavailable");
      }
      if (name === "open_reading_nest") {
        return {
          structuredContent: {
            count: 1,
            bookshelf: [
              {
                id: bundle.session.id,
                title: bundle.session.title,
                type: "novel",
                status: "active",
                currentPosition: "第 23 页",
                currentPositionIndex: 23
              }
            ]
          },
          _meta: {
            privateBookshelf: {
              bookshelfSessions: [bundle],
              recentSessions: [bundle]
            }
          }
        };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: {},
        callTool
      }
    });

    render(<App />);

    expect(await screen.findByText("手机端找回的小说")).toBeInTheDocument();
    expect(screen.getByText("1 本小说")).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith("open_reading_nest", {});
  });

  it("keeps a safe bookshelf visible when the client omits private tool metadata", async () => {
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: {
          count: 1,
          bookshelf: [
            {
              id: "summary-only-book",
              title: "只收到摘要也能找回的小说",
              type: "novel",
              status: "active",
              currentPosition: "第 23 页",
              currentPositionIndex: 23,
              updatedAt: "2026-07-23T15:40:36.147Z"
            }
          ]
        },
        callTool: vi.fn().mockRejectedValue(new Error("client bridge unavailable"))
      }
    });

    render(<App />);

    expect(await screen.findByText("只收到摘要也能找回的小说")).toBeInTheDocument();
    expect(screen.getByText("1 本小说")).toBeInTheDocument();
  });

  it("keeps the complete bookshelf and reading records when delayed host globals are partial", async () => {
    const bundle = bookshelfBundle(
      "stable-partial-book",
      "不会被晚到结果冲掉的小说",
      23,
      "light_chat",
      manifest("stable-partial-source", "s")
    );
    const readingRecord = {
      id: "stable-record",
      sessionId: bundle.session.id,
      bookTitle: bundle.session.title,
      startedAt: "2026-07-29T21:06:00.000+08:00",
      endedAt: "2026-07-29T21:49:00.000+08:00",
      durationSeconds: 43 * 60,
      startPosition: { kind: "paragraph" as const, index: 17, total: 83, label: "第 17 页" },
      endPosition: { kind: "paragraph" as const, index: 23, total: 83, label: "第 23 页" },
      pagesRead: 7,
      operationId: "stable-record-op",
      createdAt: "2026-07-29T21:49:01.000+08:00"
    };
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: {
          bookshelfSessions: [bundle],
          recentSessions: [bundle],
          readingRecords: [readingRecord]
        },
        callTool: vi.fn().mockRejectedValue(new Error("host refresh unavailable"))
      }
    });

    render(<App />);

    expect(await screen.findByText(bundle.session.title)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "阅读记录" })[0]!);
    expect(screen.getByRole("heading", { name: bundle.session.title })).toBeInTheDocument();
    expect(screen.getAllByText(/43 分钟/).length).toBeGreaterThan(0);

    if (window.openai) {
      window.openai.toolOutput = {
        count: 0,
        bookshelfSessions: [],
        recentSessions: [],
        readingRecords: []
      };
    }
    window.dispatchEvent(new Event("openai:set_globals"));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: bundle.session.title })).toBeInTheDocument();
      expect(screen.getAllByText(/43 分钟/).length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "我的书房" })[0]!);
    expect(screen.getByText(bundle.session.title)).toBeInTheDocument();
    expect(screen.getByText("1 本小说")).toBeInTheDocument();
  });

  it("keeps mobile book details and reading inline until fullscreen is explicitly requested", async () => {
    const deviceCache = new IndexedDbReadingCache();
    const sourceManifest = manifest("mobile-cover-source", "m");
    const bundle = bookshelfBundle(
      "mobile-cover-session",
      "手机封面稳定性测试",
      2,
      "light_chat",
      sourceManifest
    );
    await deviceCache.put(
      novelCache(bundle.session.id, bundle.session.title, sourceManifest, [
        "第一页。",
        "第二页。",
        "第三页。"
      ])
    );
    const requestDisplayMode = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("innerWidth", 390);
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle] },
        hostContext: {
          displayMode: "inline",
          availableDisplayModes: ["inline", "fullscreen"]
        },
        callTool: vi.fn(async () => ({
          structuredContent: { bookshelfSessions: [bundle] }
        })),
        requestDisplayMode
      }
    });

    render(<App />);

    await openBookProfile(bundle.session.title);
    expect(await screen.findByText("可以继续阅读")).toBeInTheDocument();
    expect(requestDisplayMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: `继续阅读《${bundle.session.title}》` }));
    expect(await screen.findByText("第二页。")).toBeInTheDocument();
    expect(requestDisplayMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "全屏阅读" }));
    await waitFor(() => {
      expect(requestDisplayMode).toHaveBeenCalledWith({ mode: "fullscreen" });
    });
    await deviceCache.remove(bundle.session.id);
  });

  it("continues from local text when the client host refresh never replies", async () => {
    const deviceCache = new IndexedDbReadingCache();
    const sourceManifest = manifest("stalled-host-source", "h");
    const bundle = bookshelfBundle(
      "stalled-host-session",
      "客户端失联仍可续读",
      2,
      "light_chat",
      sourceManifest
    );
    await deviceCache.put(
      novelCache(bundle.session.id, bundle.session.title, sourceManifest, [
        "第一页。",
        "第二页。",
        "第三页。"
      ])
    );
    const callTool = vi.fn(async () => ({
      structuredContent: { bookshelfSessions: [bundle] }
    }));
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle] },
        callTool
      }
    });

    render(<App />);
    await openBookProfile(bundle.session.title);
    expect(await screen.findByText("可以继续阅读")).toBeInTheDocument();

    callTool.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole("button", { name: `继续阅读《${bundle.session.title}》` })
    );
    await vi.advanceTimersByTimeAsync(2_600);
    vi.useRealTimers();

    expect(await screen.findByText("第二页。")).toBeInTheDocument();
    await deviceCache.remove(bundle.session.id);
  });

  it("continues reading inline on desktop instead of opening picture in picture automatically", async () => {
    const deviceCache = new IndexedDbReadingCache();
    const sourceManifest = manifest("desktop-inline-source", "d");
    const bundle = bookshelfBundle(
      "desktop-inline-session",
      "电脑端内嵌续读测试",
      2,
      "light_chat",
      sourceManifest
    );
    await deviceCache.put(
      novelCache(bundle.session.id, bundle.session.title, sourceManifest, [
        "第一页。",
        "第二页。",
        "第三页。"
      ])
    );
    const requestDisplayMode = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("innerWidth", 1200);
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle] },
        hostContext: {
          displayMode: "inline",
          availableDisplayModes: ["inline", "pip", "fullscreen"]
        },
        callTool: vi.fn(async () => ({
          structuredContent: { bookshelfSessions: [bundle] }
        })),
        requestDisplayMode,
        setWidgetState: vi.fn()
      }
    });

    render(<App />);

    await continueBook(bundle.session.title);
    expect(await screen.findByText("第二页。")).toBeInTheDocument();
    expect(requestDisplayMode).not.toHaveBeenCalledWith({ mode: "pip" });
    fireEvent.click(screen.getByRole("button", { name: "悬浮阅读" }));
    await waitFor(() => {
      expect(requestDisplayMode).toHaveBeenCalledWith({ mode: "pip" });
    });
    await deviceCache.remove(bundle.session.id);
  });

  it("shows the library instead of a blank shell when saved reader state has no session", () => {
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [] },
        widgetState: { screen: "novel" },
        callTool: vi.fn(async () => ({ structuredContent: { bookshelfSessions: [] } }))
      }
    });

    render(<App />);

    expect(screen.getByRole("heading", { name: "书架" })).toBeInTheDocument();
    expect(screen.getByText("正在找回你的小说书架…")).toBeInTheDocument();
  });

  it("keeps the library visible while restoring a saved reader after the shelf arrives late", async () => {
    const deviceCache = new IndexedDbReadingCache();
    const sourceManifest = manifest("late-reader-source", "r");
    const bundle = bookshelfBundle("late-reader-session", "晚到续读", 2, "light_chat", sourceManifest);
    await deviceCache.put(
      novelCache("late-reader-session", "晚到续读", sourceManifest, [
        "第一页。",
        "第二页。",
        "第三页。"
      ])
    );
    const callTool = vi.fn(async (name: string) => {
      if (name === "get_novel_bookshelf") {
        return { structuredContent: { bookshelfSessions: [bundle], recentSessions: [bundle] } };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [] },
        widgetState: { screen: "novel", sessionId: "late-reader-session", positionIndex: 2 },
        callTool,
        setWidgetState: vi.fn()
      }
    });

    render(<App />);

    expect(screen.getByRole("heading", { name: "书架" })).toBeInTheDocument();
    expect(await screen.findByText("第二页。")).toBeInTheDocument();
    await deviceCache.remove("late-reader-session");
  });

  it("opens the novel setup without exposing model API settings", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    expect(screen.getByLabelText("作品名")).toBeInTheDocument();
    expect(screen.queryByText(/API key/i)).not.toBeInTheDocument();
  });

  it.each([
    ["txt", "海边来信.txt", "第一段。\n\n第二段。"],
    ["Markdown", "雨夜书店.md", "# 第一章\n\n故事开始了。"]
  ])("imports a %s novel file into the existing title and body fields", async (_kind, name, content) => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));

    fireEvent.change(screen.getByLabelText("上传 TXT / Markdown"), {
      target: { files: [new File([content], name, { type: "text/plain" })] }
    });

    await waitFor(() => {
      expect(screen.getByLabelText("作品名")).toHaveValue(name.replace(/\.[^.]+$/, ""));
      expect(screen.getByLabelText("小说正文")).toHaveValue(content);
    });
  });

  it("keeps a title the user entered before importing a novel file", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "我的标题" } });

    fireEvent.change(screen.getByLabelText("上传 TXT / Markdown"), {
      target: { files: [new File(["正文内容。"], "文件标题.markdown", { type: "text/markdown" })] }
    });

    await waitFor(() => {
      expect(screen.getByLabelText("作品名")).toHaveValue("我的标题");
      expect(screen.getByLabelText("小说正文")).toHaveValue("正文内容。");
    });
  });

  it("rejects unsupported novel file formats", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));

    fireEvent.change(screen.getByLabelText("上传 TXT / Markdown"), {
      target: { files: [new File(["内容"], "小说.pdf", { type: "application/pdf" })] }
    });

    expect(await screen.findByText("目前支持 EPUB、TXT 和 Markdown 文档。")).toBeInTheDocument();
    expect(screen.getByLabelText("小说正文")).toHaveValue("");
  });

  it("accepts novel files between 2 and 5 MiB", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    const content = "x".repeat(2 * 1024 * 1024 + 1);

    fireEvent.change(screen.getByLabelText("上传 TXT / Markdown"), {
      target: { files: [new File([content], "长篇.txt", { type: "text/plain" })] }
    });

    expect(await screen.findByText("文档已导入，你仍然可以继续编辑正文。")).toBeInTheDocument();
    expect(screen.getByLabelText("作品名")).toHaveValue("长篇");
  });

  it("shows import diagnostics and enters the reader for a 3.5 MiB novel file", async () => {
    const deviceCache = new IndexedDbReadingCache();
    await deviceCache.remove("large-file-session");
    const content = makeChineseText(Math.floor(3.5 * 1024 * 1024));
    const cloudManifest: SourceManifest = {
      sourceId: "large-file-source",
      sourceKind: "pasted_text",
      contentHash: "e".repeat(64),
      segmentationVersion: 3,
      paragraphCount: 5,
      cloudSync: {
        enabled: true,
        provider: "r2",
        objectKey: "private/sources/large-file-source/source.txt",
        manifestObjectKey: "private/sources/large-file-source/manifest.json",
        sizeBytes: new Blob([content]).size,
        mimeType: "text/plain; charset=utf-8"
      }
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ sourceManifest: cloudManifest })));
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "start_reading_session") {
        return {
          structuredContent: {
            session: {
              id: "large-file-session",
              title: "大文件导入",
              type: "novel",
              status: "active",
              userCurrentPosition: { kind: "paragraph", index: 1, total: 5, label: "第 1 段" },
              assistantSyncedPosition: null,
              liveReadingEnabled: false,
              sourceManifest: null,
              createdAt: "2026-06-27T00:00:00.000Z",
              updatedAt: "2026-06-27T00:00:00.000Z",
              lastReadAt: "2026-06-27T00:00:00.000Z"
            }
          }
        };
      }
      if (name === "set_source_manifest") {
        return { structuredContent: { sourceManifest: args.sourceManifest } };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [], sourceEndpointBase: "https://worker.example.test/source/secret" },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("上传 TXT / Markdown"), {
      target: { files: [new File([content], "大文件导入.txt", { type: "text/plain" })] }
    });

    expect(await screen.findByText("导入诊断")).toBeInTheDocument();
    expect(await screen.findByText(/阶段：读取完成/)).toBeInTheDocument();
    expect(screen.getByLabelText("作品名")).toHaveValue("大文件导入");
    expect(screen.getByText(/文件：大文件导入.txt/)).toBeInTheDocument();
    expect(screen.getByText(/sourceEndpointBase：present/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));

    expect(await screen.findByText(/第 1 页 \/ 共 \d+ 页/)).toBeInTheDocument();
    expect(screen.getByText(content.slice(0, 20), { exact: false })).toBeInTheDocument();
    expect(await deviceCache.get("large-file-session")).toMatchObject({
      metadata: {
        sourceManifest: expect.objectContaining({
          cloudSync: expect.objectContaining({ enabled: true })
        })
      }
    });
    await deviceCache.remove("large-file-session");
  });

  it("keeps a newly imported book when an older bookshelf response arrives late", async () => {
    const oldBook = bookshelfBundle(
      "existing-session",
      "已经在书架里的书",
      2,
      "light_chat",
      manifest("existing-source", "a")
    );
    let resolveBookshelf: ((value: unknown) => void) | undefined;
    const delayedBookshelf = new Promise((resolve) => {
      resolveBookshelf = resolve;
    });
    const uploadedManifest: SourceManifest = {
      ...manifest("new-source", "b"),
      paragraphCount: 2,
      cloudSync: {
        enabled: true,
        provider: "r2",
        objectKey: "private/sources/new-source/source.txt",
        manifestObjectKey: "private/sources/new-source/manifest.json",
        sizeBytes: 32,
        mimeType: "text/plain; charset=utf-8"
      }
    };
    const newSession = bookshelfBundle(
      "new-session",
      "刚刚导入的新书",
      1,
      "light_chat",
      uploadedManifest
    ).session;
    newSession.sourceManifest = null;
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "get_novel_bookshelf") return await delayedBookshelf;
      if (name === "start_reading_session") {
        return { structuredContent: { session: newSession } };
      }
      if (name === "upload_cloud_source") {
        return {
          structuredContent: {
            uploaded: true,
            sessionId: args.sessionId,
            sourceId: uploadedManifest.sourceId,
            contentHash: uploadedManifest.contentHash,
            paragraphCount: uploadedManifest.paragraphCount,
            cloudSync: uploadedManifest.cloudSync
          },
          _meta: { sourceManifest: uploadedManifest }
        };
      }
      if (name === "set_source_manifest") {
        return { structuredContent: { sourceManifest: args.sourceManifest } };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [oldBook] },
        callTool,
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "刚刚导入的新书" } });
    fireEvent.change(screen.getByLabelText("小说正文"), {
      target: { value: "新书第一页。\n\n新书第二页。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));

    expect(await screen.findByText("新书第一页。")).toBeInTheDocument();
    resolveBookshelf?.({
      structuredContent: { bookshelfSessions: [oldBook], recentSessions: [oldBook] }
    });
    await waitFor(() => {
      expect(callTool).toHaveBeenCalledWith("get_novel_bookshelf", {});
    });
    fireEvent.click(screen.getByRole("button", { name: "返回上一页" }));

    expect(await screen.findByText("刚刚导入的新书")).toBeInTheDocument();
    expect(screen.getByText("已经在书架里的书")).toBeInTheDocument();
  });

  it("reports an empty decoded novel file instead of creating a blank reader", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));

    fireEvent.change(screen.getByLabelText("上传 TXT / Markdown"), {
      target: { files: [new File(["   \n\t"], "空文件.txt", { type: "text/plain" })] }
    });

    expect(
      await screen.findByText("文档解析为空；如果 EPUB 带有加密，请换无加密版本或转成 TXT。")
    ).toBeInTheDocument();
    expect(screen.getByText("导入诊断")).toBeInTheDocument();
    expect(screen.getByText(/阶段：失败/)).toBeInTheDocument();
  });

  it("rejects novel files larger than 5 MiB", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));

    fireEvent.change(screen.getByLabelText("上传 TXT / Markdown"), {
      target: {
        files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], "太长了.txt", { type: "text/plain" })]
      }
    });

    expect(await screen.findByText("文档超过 5 MB，请拆分后再导入。")).toBeInTheDocument();
    expect(screen.getByLabelText("小说正文")).toHaveValue("");
  });

  it("enters the novel reader and reports an error when IndexedDB cannot save the new book", async () => {
    const cacheWrite = vi
      .spyOn(IndexedDbReadingCache.prototype, "put")
      .mockRejectedValueOnce(new Error("quota exceeded"));
    const callTool = vi.fn(async (name: string) => {
      if (name === "start_reading_session") {
        return {
          structuredContent: {
            session: {
              id: "cache-write-failure-session",
              title: "缓存写入测试",
              type: "novel",
              status: "active",
              userCurrentPosition: { kind: "paragraph", index: 1, total: 1, label: "第 1 段" },
              assistantSyncedPosition: null,
              liveReadingEnabled: false,
              sourceManifest: null,
              createdAt: "2026-06-27T00:00:00.000Z",
              updatedAt: "2026-06-27T00:00:00.000Z",
              lastReadAt: "2026-06-27T00:00:00.000Z"
            }
          }
        };
      }
      if (name === "upload_cloud_source") {
        throw new Error("cloud unavailable");
      }
      if (name === "set_source_manifest") {
        return { structuredContent: {} };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [] },
        callTool,
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "缓存写入测试" } });
    fireEvent.change(screen.getByLabelText("小说正文"), {
      target: { value: "缓存失败时仍应进入阅读页。" }
    });
    fireEvent.click(screen.getByLabelText("在本设备记住这本书"));
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));

    expect(await screen.findByText("缓存失败时仍应进入阅读页。")).toBeInTheDocument();
    expect(await screen.findByText(/本设备正文缓存写入失败/)).toBeInTheDocument();
    cacheWrite.mockRestore();
  });

  it("includes the current paragraph in the follow-up when model-context sync is unavailable", async () => {
    const visualViewport = new EventTarget() as VisualViewport;
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      value: 900
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport
    });
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "start_reading_session") {
        return {
          structuredContent: {
            session: {
              id: "session-1",
              title: "测试小说",
              type: "novel",
              status: "active",
              userCurrentPosition: {
                kind: "paragraph",
                index: 1,
                total: 1,
                label: "第 1 段"
              },
              assistantSyncedPosition: null,
              liveReadingEnabled: false,
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:00.000Z",
              lastReadAt: "2026-06-22T00:00:00.000Z"
            }
          }
        };
      }
      if (name === "upload_cloud_source") {
        const sourceManifest = {
          sourceId: "bridge-source",
          sourceKind: "pasted_text" as const,
          contentHash: "a".repeat(64),
          segmentationVersion: 1,
          paragraphCount: 1,
          cloudSync: {
            enabled: true,
            provider: "r2" as const,
            objectKey: "private/sources/bridge-source/source.txt"
          }
        };
        return {
          structuredContent: {
            uploaded: true,
            sessionId: args.sessionId,
            sourceId: "bridge-source",
            contentHash: "a".repeat(64),
            paragraphCount: 1,
            cloudSync: { enabled: true, provider: "r2" }
          },
          _meta: { sourceManifest }
        };
      }
      if (name === "send_current_context") {
        return {
          structuredContent: {
            context: {
              title: "测试小说",
              position: args.position,
              currentText: args.currentText
            }
          }
        };
      }
      if (name === "set_source_manifest") {
        return {
          structuredContent: {
            sourceManifest: args.sourceManifest
          }
        };
      }
      return { structuredContent: {} };
    });
    const sendFollowUpMessage = vi.fn();
    const requestDisplayMode = vi.fn().mockResolvedValue(undefined);
    const setWidgetState = vi.fn();
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [] },
        callTool,
        sendFollowUpMessage,
        requestDisplayMode,
        setWidgetState
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "测试小说" } });
    fireEvent.change(screen.getByPlaceholderText("粘贴 TXT 或 Markdown 文本"), {
      target: { value: "这是 GPT 必须看到的当前段落。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));
    await screen.findByText("这是 GPT 必须看到的当前段落。");
    await waitFor(() => {
      expect(callTool).toHaveBeenCalledWith(
        "set_source_manifest",
        expect.objectContaining({
          sessionId: "session-1",
          sourceManifest: expect.objectContaining({
            sourceKind: "pasted_text",
            contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            segmentationVersion: 1,
            paragraphCount: 1
          })
        })
      );
      expect(requestDisplayMode).not.toHaveBeenCalledWith({ mode: "fullscreen" });
      expect(screen.getByRole("button", { name: "全屏阅读" })).toBeInTheDocument();
      expect(setWidgetState).toHaveBeenCalledWith(
        expect.objectContaining({
          screen: "novel",
          sessionId: "session-1",
          positionIndex: 1
        })
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "全屏阅读" }));
    await waitFor(() => {
      expect(requestDisplayMode).toHaveBeenCalledWith({ mode: "fullscreen" });
    });
    expect(screen.getByRole("button", { name: "全屏阅读" })).toBeInTheDocument();
    window.dispatchEvent(
      new CustomEvent("openai:host-context-changed", {
        detail: {
          displayMode: "fullscreen",
          availableDisplayModes: ["inline", "pip", "fullscreen"]
        }
      })
    );
    expect(await screen.findByRole("button", { name: "退出全屏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "悬浮阅读" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "悬浮阅读" }));
    await waitFor(() => {
      expect(requestDisplayMode).toHaveBeenCalledWith({ mode: "pip" });
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "退出全屏" }).closest("main")).toHaveClass(
        "reader-immersive"
      );
    });
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      value: 520
    });
    visualViewport.dispatchEvent(new Event("resize"));
    expect(requestDisplayMode).not.toHaveBeenCalledWith({ mode: "inline" });
    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    await waitFor(() => {
      expect(requestDisplayMode).toHaveBeenCalledWith({ mode: "inline" });
    });
    window.dispatchEvent(
      new CustomEvent("openai:host-context-changed", {
        detail: {
          displayMode: "inline",
          availableDisplayModes: ["inline", "pip", "fullscreen"]
        }
      })
    );
    expect(await screen.findByRole("button", { name: "全屏阅读" })).toBeInTheDocument();
    expect(screen.getByText("这是 GPT 必须看到的当前段落。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "和陆沉共读" }));

    await waitFor(() => {
      expect(callTool).toHaveBeenCalledWith(
        "send_current_context",
        expect.objectContaining({
          sourceContext: expect.objectContaining({
            contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            segmentationVersion: 1,
            paragraphCount: 1
          })
        })
      );
      expect(sendFollowUpMessage).toHaveBeenCalledWith({
        prompt: expect.stringContaining("想和你一起聊聊"),
        scrollToBottom: true
      });
      const prompt = String(sendFollowUpMessage.mock.calls.at(-1)?.[0]?.prompt ?? "");
      expect(prompt).toContain("这是 GPT 必须看到的当前段落。");
      expect(prompt).toContain("兼容模式本页节选");
      expect(
        requestDisplayMode.mock.calls.filter(([input]) => input.mode === "pip")
      ).toHaveLength(1);
    });
  });

  it("asks ChatGPT to preserve the explicit page reply in the book", async () => {
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "start_reading_session") {
        return {
          structuredContent: {
            session: {
              id: "session-no-dock",
              title: "No Dock Book",
              type: "novel",
              status: "active",
              userCurrentPosition: { kind: "paragraph", index: 1, total: 1, label: "ç¬¬ 1 æ®µ" },
              assistantSyncedPosition: { kind: "paragraph", index: 1, total: 1, label: "ç¬¬ 1 æ®µ" },
              liveReadingEnabled: false,
              sessionPreferences: {
                readingCommentMode: "reaction_only",
                commentLength: "short",
                allowDeepAnalysisByDefault: false,
                liveReadingStyle: "danmaku",
                autoSaveCompanionComments: false
              },
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:00.000Z",
              lastReadAt: "2026-06-22T00:00:00.000Z"
            }
          }
        };
      }
      if (name === "upload_cloud_source") {
        return {
          structuredContent: {
            uploaded: true,
            sessionId: args.sessionId,
            sourceId: "no-dock-source",
            contentHash: "c".repeat(64),
            paragraphCount: 1,
            cloudSync: { enabled: true, provider: "r2" }
          },
          _meta: {
            sourceManifest: {
              sourceId: "no-dock-source",
              sourceKind: "pasted_text",
              contentHash: "c".repeat(64),
              segmentationVersion: 1,
              paragraphCount: 1,
              cloudSync: { enabled: true, provider: "r2", objectKey: "private/sources/no-dock-source/source.txt" }
            }
          }
        };
      }
      if (name === "set_source_manifest") {
        return { structuredContent: { sourceManifest: args.sourceManifest } };
      }
      if (name === "send_current_context") {
        return {
          structuredContent: {
            context: {
              title: "No Dock Book",
              position: args.position,
              currentText: args.currentText
            }
          }
        };
      }
      return { structuredContent: {} };
    });
    const sendFollowUpMessage = vi.fn();
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [] },
        callTool,
        sendFollowUpMessage,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "No Dock Book" } });
    fireEvent.change(screen.getByPlaceholderText("粘贴 TXT 或 Markdown 文本"), {
      target: { value: "不要写回 Dock。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));
    fireEvent.click(await screen.findByRole("button", { name: "和陆沉共读" }));

    await waitFor(() => expect(sendFollowUpMessage).toHaveBeenCalled());
    expect(callTool).toHaveBeenCalledWith(
      "send_current_context",
      expect.objectContaining({ sessionId: "session-no-dock" })
    );
    const prompt = String(sendFollowUpMessage.mock.calls[0]?.[0]?.prompt ?? "");
    expect(prompt).not.toContain("publish_companion_comment");
    expect(prompt).toContain("save_shared_reading_reply");
    expect(prompt).toContain("sessionId=session-no-dock");
    expect(prompt).toContain("positionIndex=1");
    expect(prompt).toContain("想和你一起聊聊");
  });

  it("disables the current-paragraph action while a sync request is in flight", async () => {
    let resolveContext: ((value: unknown) => void) | undefined;
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "start_reading_session") {
        return {
          structuredContent: {
            session: {
              id: "session-pending",
              title: "Pending Book",
              type: "novel",
              status: "active",
              userCurrentPosition: { kind: "paragraph", index: 1, total: 1, label: "第 1 段" },
              assistantSyncedPosition: { kind: "paragraph", index: 1, total: 1, label: "第 1 段" },
              liveReadingEnabled: false,
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:00.000Z",
              lastReadAt: "2026-06-22T00:00:00.000Z"
            }
          }
        };
      }
      if (name === "upload_cloud_source") {
        return {
          structuredContent: {
            uploaded: true,
            sessionId: args.sessionId,
            sourceId: "pending-source",
            contentHash: "b".repeat(64),
            paragraphCount: 1,
            cloudSync: { enabled: true, provider: "r2" }
          },
          _meta: {
            sourceManifest: {
              sourceId: "pending-source",
              sourceKind: "pasted_text",
              contentHash: "b".repeat(64),
              segmentationVersion: 1,
              paragraphCount: 1,
              cloudSync: { enabled: true, provider: "r2", objectKey: "private/sources/pending-source/source.txt" }
            }
          }
        };
      }
      if (name === "set_source_manifest") {
        return { structuredContent: { sourceManifest: args.sourceManifest } };
      }
      if (name === "send_current_context") {
        return await new Promise((resolve) => {
          resolveContext = resolve;
        });
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [] },
        callTool,
        sendFollowUpMessage: vi.fn(),
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "Pending Book" } });
    fireEvent.change(screen.getByPlaceholderText("粘贴 TXT 或 Markdown 文本"), {
      target: { value: "等一下。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));
    const action = await screen.findByRole("button", { name: "和陆沉共读" });

    fireEvent.click(action);
    await waitFor(() => expect(action).toBeDisabled());
    fireEvent.click(action);
    expect(callTool.mock.calls.filter(([name]) => name === "send_current_context")).toHaveLength(1);

    resolveContext?.({
      structuredContent: {
        context: {
          title: "Pending Book",
          position: { kind: "paragraph", index: 1, label: "第 1 段" },
          currentText: "等一下。"
        }
      }
    });
    await waitFor(() => expect(action).not.toBeDisabled());
  });

  it.skip("shows dual-position status and asks before a large catch-up", async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === "start_reading_session") {
        return {
          structuredContent: {
            session: {
              id: "session-large",
              title: "长篇测试",
              type: "novel",
              status: "active",
              userCurrentPosition: {
                kind: "paragraph",
                index: 1,
                total: 28,
                label: "第 1 段"
              },
              assistantSyncedPosition: null,
              liveReadingEnabled: false,
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:00.000Z",
              lastReadAt: "2026-06-22T00:00:00.000Z"
            }
          }
        };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [] },
        callTool,
        sendFollowUpMessage: vi.fn(),
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "长篇测试" } });
    fireEvent.change(screen.getByPlaceholderText("粘贴 TXT 或 Markdown 文本"), {
      target: {
        value: Array.from({ length: 28 }, (_, index) => `第 ${index + 1} 章\n内容`).join("\n\n")
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));
    await screen.findByText(/陆沉确认读到：尚未同步/);

    for (let index = 0; index < 27; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "下一段" }));
    }
    await screen.findByText(/阿雾读到：第 28 页/);
    fireEvent.click(screen.getByRole("button", { name: "陪我看看这里" }));

    expect(await screen.findByText("中间有较多剧情，要怎么同步？")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /完整补课后再陪读/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "只看当前页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "补最近 5 页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /完整补课后再陪读/ }));
    const confirmButton = await screen.findByRole("button", {
      name: /我看到陆沉回复“已读到第 28 页”，开始正式陪读/
    });
    expect(callTool).not.toHaveBeenCalledWith(
      "confirm_assistant_synced_position",
      expect.anything()
    );

    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(callTool).toHaveBeenCalledWith(
        "confirm_assistant_synced_position",
        expect.objectContaining({
          confirmedPosition: expect.objectContaining({ index: 28 })
        })
      );
    });
  });


  it("updates the current bookshelf management records after saving a reading thought", async () => {
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "start_reading_session") {
        return {
          structuredContent: {
            session: {
              id: "session-records",
              title: "记录测试",
              type: "novel",
              status: "active",
              userCurrentPosition: { kind: "paragraph", index: 1, total: 1, label: "第 1 段" },
              assistantSyncedPosition: null,
              liveReadingEnabled: false,
              sessionPreferences: {
                readingCommentMode: "light_chat",
                commentLength: "normal",
                allowDeepAnalysisByDefault: false,
                liveReadingStyle: "danmaku",
                autoSaveCompanionComments: false
              },
              sourceManifest: null,
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:00.000Z",
              lastReadAt: "2026-06-22T00:00:00.000Z"
            }
          }
        };
      }
      if (name === "upload_cloud_source") {
        return {
          structuredContent: {
            uploaded: true,
            sessionId: args.sessionId,
            sourceId: "records-source",
            contentHash: "d".repeat(64),
            paragraphCount: 1,
            cloudSync: { enabled: true, provider: "r2" }
          },
          _meta: {
            sourceManifest: {
              sourceId: "records-source",
              sourceKind: "pasted_text",
              contentHash: "d".repeat(64),
              segmentationVersion: 2,
              paragraphCount: 1,
              cloudSync: { enabled: true, provider: "r2", objectKey: "private/sources/records-source/source.txt" }
            }
          }
        };
      }
      if (name === "set_source_manifest") {
        return { structuredContent: { sourceManifest: args.sourceManifest } };
      }
      if (name === "save_quote") {
        return {
          structuredContent: {
            quote: {
              id: "quote-records",
              sessionId: args.sessionId,
              content: args.content,
              position: args.position,
              createdAt: "2026-06-23T00:00:00.000Z"
            }
          }
        };
      }
      return { structuredContent: {} };
    });
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "值得保存的句子"
    } as Selection);
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { recentSessions: [] },
        callTool,
        sendFollowUpMessage: vi.fn(),
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "记录测试" } });
    fireEvent.change(screen.getByPlaceholderText("粘贴 TXT 或 Markdown 文本"), {
      target: { value: "值得保存的句子" }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));
    await screen.findByRole("button", { name: "和陆沉共读" });

    fireEvent.mouseUp(screen.getByText("值得保存的句子"));
    fireEvent.click(screen.getByRole("button", { name: "写想法" }));
    fireEvent.change(screen.getByRole("textbox", { name: "我的划线想法" }), {
      target: { value: "这句值得保存。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "存入本页想法" }));
    fireEvent.click(screen.getByRole("button", { name: "返回上一页" }));
    await manageBook("记录测试");

    expect(await screen.findByRole("dialog", { name: "管理《记录测试》" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "摘录" }));
    expect(screen.getByText("值得保存的句子")).toBeInTheDocument();
  });


  it("keeps a reimported existing novel available after an iPad-like widget refresh", async () => {
    const deviceCache = new IndexedDbReadingCache();
    await deviceCache.remove("ipad-refresh-session");
    const sourceText = `${"第一段".repeat(500)}\n\n${"第二段".repeat(500)}`;
    const sourceManifest = await createNovelSourceManifest({
      sourceId: "ipad-refresh-source",
      sourceKind: "pasted_text",
      title: "iPad Refresh Book",
      sourceText
    });
    const bundle = bookshelfBundle(
      "ipad-refresh-session",
      "iPad Refresh Book",
      2,
      "light_chat",
      sourceManifest
    );
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "set_source_manifest") {
        return { structuredContent: { sourceManifest: args.sourceManifest } };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle] },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    const firstRender = render(<App />);
    await reimportBook("iPad Refresh Book");
    fireEvent.change(screen.getByPlaceholderText("粘贴 TXT 或 Markdown 文本"), {
      target: { value: sourceText }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));
    expect(await screen.findByText(/第 2 页 \/ 共 \d+ 页/)).toBeInTheDocument();
    expect(await deviceCache.get("ipad-refresh-session")).not.toBeNull();

    firstRender.unmount();
    render(<App />);

    await openBookProfile("iPad Refresh Book");
    expect(await screen.findByText("可以继续阅读")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续阅读《iPad Refresh Book》" }));
    expect(await screen.findByText(/第 2 页 \/ 共 \d+ 页/)).toBeInTheDocument();
    await deviceCache.remove("ipad-refresh-session");
  });

  it("uploads new novels through the private source endpoint and keeps source text out of assistant-visible state", async () => {
    const deviceCache = new IndexedDbReadingCache();
    await deviceCache.remove("cloud-upload-session");
    const sourceText = "云端第一段。\n\n云端第二段。";
    const localManifest = await createNovelSourceManifest({
      sourceId: "cloud-upload-source",
      sourceKind: "pasted_text",
      title: "云端上传书",
      sourceText
    });
    const cloudManifest: SourceManifest = {
      ...localManifest,
      cloudSync: {
        enabled: true,
        provider: "r2",
        objectKey: "private/sources/cloud-upload-source/source.txt",
        manifestObjectKey: "private/sources/cloud-upload-source/manifest.json"
      }
    };
    const fetchMock = vi.fn(async () => jsonResponse({ sourceManifest: cloudManifest }));
    vi.stubGlobal("fetch", fetchMock);
    const setWidgetState = vi.fn();
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "start_reading_session") {
        return {
          structuredContent: {
            session: {
              id: "cloud-upload-session",
              title: "云端上传书",
              type: "novel",
              status: "active",
              userCurrentPosition: { kind: "paragraph", index: 1, total: 2, label: "第 1 段" },
              assistantSyncedPosition: null,
              liveReadingEnabled: false,
              sessionPreferences: undefined,
              sourceManifest: null,
              createdAt: "2026-06-24T00:00:00.000Z",
              updatedAt: "2026-06-24T00:00:00.000Z",
              lastReadAt: "2026-06-24T00:00:00.000Z"
            }
          }
        };
      }
      if (name === "set_source_manifest") {
        return { structuredContent: { sourceManifest: args.sourceManifest } };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: {
          recentSessions: [],
          sourceEndpointBase: "https://worker.example.test/source/secret"
        },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "云端上传书" } });
    fireEvent.change(screen.getByPlaceholderText("粘贴 TXT 或 Markdown 文本"), {
      target: { value: sourceText }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));

    expect(await screen.findByText(/第 1 页 \/ 共 \d+ 页/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.example.test/source/secret/upload",
      expect.objectContaining({ method: "POST" })
    );
    const uploadCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(
      ([url]) => String(url).endsWith("/upload")
    );
    const uploadRequest = uploadCall?.[1];
    expect(JSON.parse(String(uploadRequest?.body))).toMatchObject({
      sessionId: "cloud-upload-session",
      sourceKind: "pasted_text",
      sourceText
    });
    expect(callTool).not.toHaveBeenCalledWith("upload_cloud_source", expect.anything());
    expect(callTool).toHaveBeenCalledWith(
      "set_source_manifest",
      expect.objectContaining({
        sessionId: "cloud-upload-session",
        sourceManifest: expect.objectContaining({
          cloudSync: expect.objectContaining({ enabled: true })
        })
      })
    );
    expect(await deviceCache.get("cloud-upload-session")).toMatchObject({
      metadata: {
        sourceManifest: expect.objectContaining({
          cloudSync: expect.objectContaining({ enabled: true })
        })
      }
    });
    expect(JSON.stringify(setWidgetState.mock.calls)).not.toContain(sourceText);
    await deviceCache.remove("cloud-upload-session");
  });

  it("enters the reader after uploading a 3.5 MiB Chinese novel through the private endpoint", async () => {
    const deviceCache = new IndexedDbReadingCache();
    await deviceCache.remove("large-cloud-upload-session");
    const sourceText = makeChineseText(Math.floor(3.5 * 1024 * 1024));
    const cloudManifest: SourceManifest = {
      sourceId: "large-cloud-upload-source",
      sourceKind: "pasted_text",
      contentHash: "f".repeat(64),
      segmentationVersion: 3,
      paragraphCount: 8,
      cloudSync: {
        enabled: true,
        provider: "r2",
        objectKey: "private/sources/large-cloud-upload-source/source.txt",
        manifestObjectKey: "private/sources/large-cloud-upload-source/manifest.json",
        sizeBytes: new Blob([sourceText]).size,
        mimeType: "text/plain; charset=utf-8"
      }
    };
    const fetchMock = vi.fn(async () => jsonResponse({ sourceManifest: cloudManifest }));
    vi.stubGlobal("fetch", fetchMock);
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "start_reading_session") {
        return {
          structuredContent: {
            session: {
              id: "large-cloud-upload-session",
              title: "大文件测试",
              type: "novel",
              status: "active",
              userCurrentPosition: { kind: "paragraph", index: 1, total: 8, label: "第 1 段" },
              assistantSyncedPosition: null,
              liveReadingEnabled: false,
              sourceManifest: null,
              createdAt: "2026-06-27T00:00:00.000Z",
              updatedAt: "2026-06-27T00:00:00.000Z",
              lastReadAt: "2026-06-27T00:00:00.000Z"
            }
          }
        };
      }
      if (name === "set_source_manifest") {
        return { structuredContent: { sourceManifest: args.sourceManifest } };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: {
          recentSessions: [],
          sourceEndpointBase: "https://worker.example.test/source/secret"
        },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "大文件测试" } });
    fireEvent.change(screen.getByPlaceholderText("粘贴 TXT 或 Markdown 文本"), {
      target: { value: sourceText }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));

    expect(await screen.findByText(/第 1 页 \/ 共 \d+ 页/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.example.test/source/secret/upload",
      expect.objectContaining({ method: "POST" })
    );
    expect(callTool).not.toHaveBeenCalledWith("upload_cloud_source", expect.anything());
    expect(await deviceCache.get("large-cloud-upload-session")).toMatchObject({
      metadata: {
        sourceManifest: expect.objectContaining({
          cloudSync: expect.objectContaining({ enabled: true })
        })
      }
    });
    await deviceCache.remove("large-cloud-upload-session");
  });

  it("does not overwrite a server-side bridge upload when private manifest metadata is unavailable", async () => {
    const deviceCache = new IndexedDbReadingCache();
    await deviceCache.remove("bridge-no-meta-session");
    const sourceText = "bridge only paragraph";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "start_reading_session") {
        return {
          structuredContent: {
            session: {
              id: "bridge-no-meta-session",
              title: "Bridge No Meta",
              type: "novel",
              status: "active",
              userCurrentPosition: { kind: "paragraph", index: 1, total: 1, label: "第 1 段" },
              assistantSyncedPosition: null,
              liveReadingEnabled: false,
              sessionPreferences: undefined,
              sourceManifest: null,
              createdAt: "2026-06-24T00:00:00.000Z",
              updatedAt: "2026-06-24T00:00:00.000Z",
              lastReadAt: "2026-06-24T00:00:00.000Z"
            }
          }
        };
      }
      if (name === "upload_cloud_source") {
        return {
          structuredContent: {
            uploaded: true,
            sessionId: args.sessionId,
            sourceId: "bridge-no-meta-source",
            contentHash: "d".repeat(64),
            paragraphCount: 1,
            cloudSync: { enabled: true, provider: "r2" }
          }
        };
      }
      if (name === "get_cloud_source_status") {
        return { structuredContent: { status: "available" } };
      }
      if (name === "set_source_manifest") {
        throw new Error("set_source_manifest should not be called");
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: {
          recentSessions: []
        },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: "Bridge No Meta" } });
    fireEvent.change(screen.getByPlaceholderText("粘贴 TXT 或 Markdown 文本"), {
      target: { value: sourceText }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));

    await waitFor(() => {
      expect(screen.getByText("bridge only paragraph")).toBeInTheDocument();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(callTool).toHaveBeenCalledWith(
        "upload_cloud_source",
        expect.objectContaining({
          sessionId: "bridge-no-meta-session",
          sourceKind: "pasted_text",
          sourceText
        })
      );
      expect(callTool).toHaveBeenCalledWith("get_cloud_source_status", {
        sessionId: "bridge-no-meta-session"
      });
    });
    expect(callTool).not.toHaveBeenCalledWith("set_source_manifest", expect.anything());
    expect(screen.queryByText(/云端同步失败/)).not.toBeInTheDocument();
    await deviceCache.remove("bridge-no-meta-session");
  });

  it("automatically restores a cloud novel on Home when local cache is missing", async () => {
    const deviceCache = new IndexedDbReadingCache();
    await deviceCache.remove("cloud-restore-session");
    const sourceText = "恢复第一段。\n\n恢复第二段。";
    const baseManifest = await createNovelSourceManifest({
      sourceId: "cloud-restore-source",
      sourceKind: "pasted_text",
      title: "云端恢复书",
      sourceText
    });
    const cloudManifest = withCloudSync(baseManifest, "cloud-restore-source");
    const bundle = bookshelfBundle("cloud-restore-session", "云端恢复书", 2, "light_chat", cloudManifest);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ sourceText, sourceManifest: cloudManifest })
    );
    vi.stubGlobal("fetch", fetchMock);
    const callTool = vi.fn(async (_name: string) => {
      return { structuredContent: {} };
    });
    const setWidgetState = vi.fn();
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle], sourceEndpointBase: "/source/secret" },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/source/secret/restore",
        expect.objectContaining({ method: "POST" })
      );
    });
    await openBookProfile("云端恢复书");
    expect(await screen.findByText("可以继续阅读")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续阅读《云端恢复书》" })).toBeEnabled();
    expect(await deviceCache.get("cloud-restore-session")).toMatchObject({
      sourceText,
      metadata: { sourceManifest: expect.objectContaining({ sourceId: "cloud-restore-source" }) }
    });
    expect(JSON.stringify(callTool.mock.calls)).not.toContain(sourceText);
    expect(JSON.stringify(setWidgetState.mock.calls)).not.toContain(sourceText);
    await deviceCache.remove("cloud-restore-session");
  });

  it("restores a legacy v2 cloud novel with its original reading-unit indexes", async () => {
    const deviceCache = new IndexedDbReadingCache();
    await deviceCache.remove("legacy-cloud-restore-session");
    const sourceText = "旧版第一段。\n\n旧版第二段。";
    const currentManifest = await createNovelSourceManifest({
      sourceId: "legacy-cloud-restore-source",
      sourceKind: "pasted_text",
      title: "旧版云端书",
      sourceText
    });
    const legacyManifest = withCloudSync(
      {
        ...currentManifest,
        segmentationVersion: 2,
        paragraphCount: 2
      },
      "legacy-cloud-restore-source"
    );
    const bundle = bookshelfBundle(
      "legacy-cloud-restore-session",
      "旧版云端书",
      2,
      "light_chat",
      legacyManifest
    );
    const fetchMock = vi.fn(async () =>
      jsonResponse({ sourceText, sourceManifest: legacyManifest })
    );
    vi.stubGlobal("fetch", fetchMock);
    const callTool = vi.fn(async (_name: string) => {
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle], sourceEndpointBase: "/source/secret" },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);

    await openBookProfile("旧版云端书");
    expect(await screen.findByText("可以继续阅读")).toBeInTheDocument();
    expect(await deviceCache.get("legacy-cloud-restore-session")).toMatchObject({
      chunks: ["旧版第一段。", "旧版第二段。"],
      metadata: {
        sourceManifest: expect.objectContaining({
          segmentationVersion: 2,
          paragraphCount: 2
        })
      }
    });
    expect(callTool).not.toHaveBeenCalledWith("set_source_manifest", expect.anything());
    expect(JSON.stringify(callTool.mock.calls)).not.toContain(sourceText);
    await deviceCache.remove("legacy-cloud-restore-session");
  });

  it("shows restore failure without changing reading records or writing failed source text", async () => {
    const deviceCache = new IndexedDbReadingCache();
    await deviceCache.remove("cloud-fail-session");
    const cloudManifest = withCloudSync(manifest("cloud-fail-source", "f"), "cloud-fail-source");
    const bundle = bookshelfBundle("cloud-fail-session", "恢复失败书", 3, "cp_talk", cloudManifest);
    const fetchMock = vi.fn(async () => jsonResponse({ error: "missing" }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const callTool = vi.fn(async (_name: string) => {
      return { structuredContent: {} };
    });
    const setWidgetState = vi.fn();
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle], sourceEndpointBase: "/source/secret" },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState
      }
    });

    render(<App />);

    await openBookProfile("恢复失败书");
    expect(await screen.findByText("正文需要重新导入")).toBeInTheDocument();
    expect(screen.getByText(/读到 第 3 段/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新导入正文《恢复失败书》" })).toBeInTheDocument();
    expect(await deviceCache.get("cloud-fail-session")).toBeNull();
  });

  it("restores again after an iPad-like remount clears local cache", async () => {
    const deviceCache = new IndexedDbReadingCache();
    await deviceCache.remove("ipad-cloud-session");
    const sourceText = "刷新第一段。\n\n刷新第二段。";
    const baseManifest = await createNovelSourceManifest({
      sourceId: "ipad-cloud-source",
      sourceKind: "pasted_text",
      title: "iPad 云端书",
      sourceText
    });
    const cloudManifest = withCloudSync(baseManifest, "ipad-cloud-source");
    const bundle = bookshelfBundle("ipad-cloud-session", "iPad 云端书", 2, "light_chat", cloudManifest);
    const fetchMock = vi.fn(async () => jsonResponse({ sourceText, sourceManifest: cloudManifest }));
    vi.stubGlobal("fetch", fetchMock);
    const callTool = vi.fn(async (_name: string) => {
      return { structuredContent: {} };
    });
    const setWidgetState = vi.fn();
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle], sourceEndpointBase: "/source/secret" },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState
      }
    });

    const firstRender = render(<App />);
    await openBookProfile("iPad 云端书");
    expect(await screen.findByText("可以继续阅读")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    firstRender.unmount();
    const secondRender = render(<App />);
    await openBookProfile("iPad 云端书");
    expect(await screen.findByText("可以继续阅读")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await deviceCache.remove("ipad-cloud-session");
    secondRender.unmount();
    const thirdRender = render(<App />);
    await openBookProfile("iPad 云端书");
    expect(await screen.findByText("可以继续阅读")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/必须重新导入正文/)).not.toBeInTheDocument();
    thirdRender.unmount();
    await deviceCache.remove("ipad-cloud-session");
  });

  it("uses the host-confirmed display mode across remounts", async () => {
    const deviceCache = new IndexedDbReadingCache();
    const sessionId = "reader-route-session";
    const sourceText = "第一段。\n\n第二段。\n\n第三段。";
    const sourceManifest = await createNovelSourceManifest({
      sourceId: "reader-route-source",
      sourceKind: "pasted_text",
      title: "阅读路由测试",
      sourceText
    });
    await deviceCache.put(
      novelCache(sessionId, "阅读路由测试", sourceManifest, ["第一段。", "第二段。", "第三段。"])
    );
    const bundle = bookshelfBundle(sessionId, "阅读路由测试", 3, "light_chat", sourceManifest);
    let widgetState: ReaderWidgetState = {
      screen: "novel",
      sessionId,
      positionIndex: 3,
      scrollTop: 120
    };
    const setWidgetState = vi.fn((next: ReaderWidgetState) => {
      widgetState = next;
      if (window.openai) window.openai.widgetState = next;
    });
    const requestDisplayMode = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle] },
        widgetState,
        hostContext: { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] },
        callTool: vi.fn(async (_name: string) => {
          return { structuredContent: {} };
        }),
        requestDisplayMode,
        setWidgetState
      }
    });

    render(<App />);

    expect(await screen.findByText("第三段。")).toBeInTheDocument();
    expect(setWidgetState).not.toHaveBeenCalledWith(expect.objectContaining({ screen: "home" }));

    fireEvent.click(screen.getByRole("button", { name: "全屏阅读" }));

    await waitFor(() => {
      expect(requestDisplayMode).toHaveBeenCalledWith({ mode: "fullscreen" });
    });
    expect(screen.getByRole("button", { name: "全屏阅读" })).toBeInTheDocument();

    if (window.openai) {
      window.openai.hostContext = {
        displayMode: "fullscreen",
        availableDisplayModes: ["inline", "fullscreen"]
      };
    }
    window.dispatchEvent(
      new CustomEvent("openai:host-context-changed", {
        detail: { displayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"] }
      })
    );
    expect(await screen.findByRole("button", { name: "退出全屏" })).toBeInTheDocument();
    await waitFor(() => {
      expect(setWidgetState).toHaveBeenCalledWith(
        expect.objectContaining({ screen: "novel", sessionId, positionIndex: 3, immersive: true })
      );
    });

    cleanup();
    if (window.openai) window.openai.widgetState = widgetState;
    render(<App />);

    expect(await screen.findByText("第三段。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出全屏" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    await waitFor(() => {
      expect(requestDisplayMode).toHaveBeenCalledWith({ mode: "inline" });
    });
    if (window.openai) {
      window.openai.hostContext = {
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"]
      };
    }
    window.dispatchEvent(
      new CustomEvent("openai:host-context-changed", {
        detail: { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] }
      })
    );
    expect(await screen.findByRole("button", { name: "全屏阅读" })).toBeInTheDocument();

    requestDisplayMode.mockRejectedValueOnce(new Error("host rejected fullscreen"));
    fireEvent.click(screen.getByRole("button", { name: "全屏阅读" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "全屏阅读" })).toBeInTheDocument();
      expect(setWidgetState).toHaveBeenLastCalledWith(
        expect.objectContaining({ screen: "novel", sessionId, immersive: false })
      );
    });

    await deviceCache.remove(sessionId);
  });

  it("includes saved page thoughts when the host cannot update model context", async () => {
    const deviceCache = new IndexedDbReadingCache();
    const sourceManifest = manifest("thought-fallback-source", "f");
    const bundle = bookshelfBundle(
      "thought-fallback-session",
      "想法回退测试",
      1,
      "light_chat",
      sourceManifest
    );
    bundle.quotes = [
      {
        id: "thought-fallback-quote",
        sessionId: bundle.session.id,
        content: "这是我真正划线的句子",
        note: "我觉得这里说中了行动比等待更重要。",
        position: { kind: "paragraph", index: 1, label: "第 1 段" },
        createdAt: "2026-06-23T00:00:00.000Z"
      }
    ];
    await deviceCache.put(
      novelCache(bundle.session.id, bundle.session.title, sourceManifest, [
        "这是整页正文，不应该在已有想法时全部塞进兼容消息。"
      ])
    );
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "get_novel_bookshelf") {
        return { structuredContent: { bookshelfSessions: [bundle] } };
      }
      if (name === "send_current_context") {
        return {
          structuredContent: {
            context: {
              title: bundle.session.title,
              currentText: args.currentText,
              userNote: args.userNote
            }
          }
        };
      }
      return { structuredContent: {} };
    });
    const sendFollowUpMessage = vi.fn();
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle] },
        callTool,
        sendFollowUpMessage,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    await continueBook(bundle.session.title);
    fireEvent.click(await screen.findByRole("button", { name: "和陆沉共读" }));

    await waitFor(() => expect(sendFollowUpMessage).toHaveBeenCalled());
    const prompt = String(sendFollowUpMessage.mock.calls.at(-1)?.[0]?.prompt ?? "");
    expect(prompt).toContain("这是我真正划线的句子");
    expect(prompt).toContain("我觉得这里说中了行动比等待更重要。");
    expect(prompt).toContain("兼容模式共读资料");
    expect(prompt).not.toContain("这是整页正文，不应该在已有想法时全部塞进兼容消息。");
    await deviceCache.remove(bundle.session.id);
  });

  it("sends only the selected sentence and question to ChatGPT", async () => {
    const deviceCache = new IndexedDbReadingCache();
    const sourceManifest = manifest("question-source", "a");
    const bundle = bookshelfBundle(
      "question-session",
      "提问测试",
      1,
      "light_chat",
      sourceManifest
    );
    await deviceCache.put(
      novelCache("question-session", "提问测试", sourceManifest, [
        "上下文前句。只问这一句。上下文后句。"
      ])
    );
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "get_novel_bookshelf") {
        return { structuredContent: { bookshelfSessions: [bundle] } };
      }
      if (name === "send_current_context") {
        return {
          structuredContent: {
            context: {
              title: "提问测试",
              position: args.currentPosition,
              selectedText: args.selectedText,
              userNote: args.userNote
            }
          }
        };
      }
      return { structuredContent: {} };
    });
    const sendFollowUpMessage = vi.fn();
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundle] },
        callTool,
        sendFollowUpMessage,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    await continueBook("提问测试");
    const text = await screen.findByText("上下文前句。只问这一句。上下文后句。");
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "只问这一句。",
      anchorNode: text.firstChild,
      removeAllRanges: vi.fn()
    } as unknown as Selection);
    fireEvent.mouseUp(text);
    fireEvent.click(await screen.findByRole("button", { name: "直接提问" }));
    fireEvent.change(screen.getByRole("textbox", { name: "针对划线的问题" }), {
      target: { value: "这里为什么这样说？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "立即问陆沉" }));

    await waitFor(() => {
      expect(callTool).toHaveBeenCalledWith(
        "send_current_context",
        expect.objectContaining({
          sessionId: "question-session",
          mode: "selected_text",
          selectedText: "只问这一句。",
          userNote: "这里为什么这样说？"
        })
      );
    });
    const contextCall = callTool.mock.calls.find(([name]) => name === "send_current_context");
    expect(contextCall?.[1]).not.toHaveProperty("currentText");
    const prompt = String(sendFollowUpMessage.mock.calls.at(-1)?.[0]?.prompt ?? "");
    expect(prompt).toContain("只问这一句。");
    expect(prompt).toContain("这里为什么这样说？");
    expect(prompt).not.toContain("publish_companion_comment");
    expect(prompt).toContain("save_shared_reading_reply");
    expect(prompt).toContain("sessionId=question-session");
    expect(prompt).not.toContain("上下文前句");
    await deviceCache.remove("question-session");
  });

  it("reopens at the page saved by today-see-here", async () => {
    const deviceCache = new IndexedDbReadingCache();
    const sourceManifest = manifest("resume-source", "b");
    let authoritative = bookshelfBundle(
      "resume-session",
      "续读测试",
      1,
      "light_chat",
      sourceManifest
    );
    await deviceCache.put(
      novelCache("resume-session", "续读测试", sourceManifest, [
        "第一页内容",
        "第二页内容",
        "第三页内容"
      ])
    );
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "get_novel_bookshelf") {
        return { structuredContent: { bookshelfSessions: [authoritative] } };
      }
      if (name === "update_reading_position") {
        authoritative = {
          ...authoritative,
          session: { ...authoritative.session, userCurrentPosition: args.userCurrentPosition }
        };
        return { structuredContent: { session: authoritative.session } };
      }
      if (name === "finish_today_reading") {
        authoritative = {
          ...authoritative,
          session: { ...authoritative.session, userCurrentPosition: args.position }
        };
        return {
          structuredContent: {
            session: authoritative.session,
            bookmark: {
              id: "resume-bookmark",
              sessionId: "resume-session",
              position: args.position,
              label: "☆ 留在此页",
              createdAt: "2026-07-18T00:00:00.000Z"
            }
          }
        };
      }
      if (name === "save_reading_record") {
        return {
          structuredContent: {
            record: {
              id: "resume-record",
              sessionId: args.sessionId,
              bookTitle: "续读测试",
              startedAt: args.startedAt,
              endedAt: args.endedAt,
              durationSeconds: 60,
              startPosition: args.startPosition,
              endPosition: args.endPosition,
              pagesRead: args.pagesRead,
              operationId: args.operationId,
              createdAt: args.endedAt
            }
          }
        };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [authoritative] },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    await continueBook("续读测试");
    fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByText("第二页内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("第三页内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "留在此页" }));

    await continueBook("续读测试");
    expect(await screen.findByText("第 3 页 / 共 3 页")).toBeInTheDocument();
    expect(screen.getByText("第三页内容")).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith(
      "finish_today_reading",
      expect.objectContaining({
        sessionId: "resume-session",
        position: expect.objectContaining({ index: 3 }),
        createBookmark: true
      })
    );
    await waitFor(() => {
      expect(callTool).toHaveBeenCalledWith(
        "save_reading_record",
        expect.objectContaining({
          sessionId: "resume-session",
          startPosition: expect.objectContaining({ index: 1 }),
          endPosition: expect.objectContaining({ index: 3 }),
          pagesRead: 3
        })
      );
    });
    await deviceCache.remove("resume-session");
  });

  it("switches between cached bookshelf sessions without mixing reading positions", async () => {
    const deviceCache = new IndexedDbReadingCache();
    const manifestA = manifest("source-a", "a");
    const manifestB = manifest("source-b", "b");
    await deviceCache.put(novelCache("bookshelf-a", "A 书", manifestA, ["A 第一段", "A 第二段"]));
    await deviceCache.put(
      novelCache("bookshelf-b", "B 书", manifestB, ["B 第一段", "B 第二段", "B 第三段"])
    );
    const bundles = [
      bookshelfBundle("bookshelf-a", "A 书", 2, "light_chat", manifestA),
      bookshelfBundle("bookshelf-b", "B 书", 3, "cp_talk", manifestB)
    ];
    const callTool = vi.fn(async () => ({ structuredContent: {} }));
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: bundles },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    await continueBook("A 书");
    expect(await screen.findByText("第 2 页 / 共 2 页")).toBeInTheDocument();
    expect(screen.getByText("A 第二段")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回上一页" }));
    fireEvent.click(await screen.findByRole("button", { name: "返回书架" }));

    await continueBook("B 书");
    expect(await screen.findByText("第 3 页 / 共 3 页")).toBeInTheDocument();
    expect(screen.getByText("B 第三段")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();

    await deviceCache.remove("bookshelf-a");
    await deviceCache.remove("bookshelf-b");
  });

  it("manages and deletes one bookshelf session without affecting another or deleting cache by default", async () => {
    const deviceCache = new IndexedDbReadingCache();
    const manifestA = manifest("manage-source-a", "c");
    const manifestB = manifest("manage-source-b", "d");
    await deviceCache.put(novelCache("manage-a", "管理 A", manifestA, ["A 正文"]));
    await deviceCache.put(novelCache("manage-b", "管理 B", manifestB, ["B 正文"]));
    const bundleA = bookshelfBundle("manage-a", "管理 A", 1, "light_chat", manifestA);
    const bundleB = bookshelfBundle("manage-b", "管理 B", 1, "cp_talk", manifestB);
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "rename_reading_session") {
        return {
          structuredContent: {
            session: { ...bundleA.session, title: args.title }
          }
        };
      }
      if (name === "set_reading_session_status") {
        return {
          structuredContent: {
            session: { ...bundleA.session, title: "管理 A 新名", status: args.status }
          }
        };
      }
      if (name === "delete_reading_session") {
        return { structuredContent: { sessionId: args.sessionId, deleted: true } };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundleA, bundleB] },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    await manageBook("管理 A");
    fireEvent.change(screen.getByLabelText("新的书名"), {
      target: { value: "管理 A 新名" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存新书名" }));
    expect(await screen.findByText("书名已经改好啦。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "标记为已完成" }));
    expect(await screen.findByText("已经标记为完成。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除这本书" }));
    fireEvent.click(screen.getByRole("button", { name: "继续删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除这本书" }));
    expect(callTool).toHaveBeenCalledWith(
      "delete_reading_session",
      expect.not.objectContaining({ deleteCloudSource: true })
    );
    await waitFor(() => {
      expect(screen.queryByText("管理 A 新名")).not.toBeInTheDocument();
      expect(screen.getByText("管理 B")).toBeInTheDocument();
    });
    expect(await deviceCache.get("manage-a")).not.toBeNull();
    expect(await deviceCache.get("manage-b")).not.toBeNull();

    await manageBook("管理 B");
    fireEvent.click(screen.getByRole("button", { name: "删除这本书" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "同时删除本设备正文缓存" }));
    fireEvent.click(screen.getByRole("button", { name: "继续删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除这本书" }));
    await waitFor(async () => {
      expect(await deviceCache.get("manage-b")).toBeNull();
    });
    expect(await deviceCache.get("manage-a")).not.toBeNull();
    await deviceCache.remove("manage-a");
  });

  it("passes cloud deletion intent and reports cloud/local partial failures separately", async () => {
    const manifestA = manifest("failure-source", "e");
    const bundleA = bookshelfBundle("failure-book", "缓存失败书", 1, "light_chat", manifestA);
    const callTool = vi.fn(async (name: string, args: Record<string, any>) => {
      if (name === "delete_reading_session") {
        return {
          structuredContent: {
            sessionId: args.sessionId,
            deleted: true,
            cloudSourceDeleted: false,
            cloudSourceDeleteError: "manifest delete failed"
          }
        };
      }
      return { structuredContent: {} };
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { bookshelfSessions: [bundleA] },
        callTool,
        requestDisplayMode: vi.fn(),
        setWidgetState: vi.fn()
      }
    });

    render(<App />);
    await manageBook("缓存失败书");
    fireEvent.click(screen.getByRole("button", { name: "删除这本书" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "同时删除云端正文副本" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "同时删除本设备正文缓存" }));
    fireEvent.click(screen.getByRole("button", { name: "继续删除" }));
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined
    });
    fireEvent.click(screen.getByRole("button", { name: "确认删除这本书" }));
    expect(callTool).toHaveBeenCalledWith(
      "delete_reading_session",
      expect.objectContaining({
        sessionId: "failure-book",
        deleteCloudSource: true
      })
    );
    expect(JSON.stringify(callTool.mock.calls)).not.toMatch(/sourceText|imageData|data:image/);
    expect(
      await screen.findByText("云端阅读数据已删除，但云端正文副本删除失败；本设备正文缓存清除失败。")
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("缓存失败书")).not.toBeInTheDocument();
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: originalIndexedDb
    });
  });
});

function deleteTestDatabase(name: string) {
  return new Promise<void>((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function manifest(sourceId: string, hashCharacter: string): SourceManifest {
  return {
    sourceId,
    sourceKind: "pasted_text",
    contentHash: hashCharacter.repeat(64),
    segmentationVersion: 1,
    paragraphCount: sourceId === "source-a" ? 2 : 3,
    cloudSync: { enabled: false, provider: "r2" }
  };
}

function withCloudSync(sourceManifest: SourceManifest, sourceId: string): SourceManifest {
  return {
    ...sourceManifest,
    cloudSync: {
      enabled: true,
      provider: "r2",
      objectKey: `private/sources/${sourceId}/source.txt`,
      manifestObjectKey: `private/sources/${sourceId}/manifest.json`
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function openBookProfile(title: string) {
  fireEvent.click(
    await screen.findByRole("button", { name: `打开《${title}》的封面页` })
  );
}

async function continueBook(title: string) {
  await openBookProfile(title);
  fireEvent.click(
    await screen.findByRole("button", { name: `继续阅读《${title}》` })
  );
}

async function manageBook(title: string) {
  await openBookProfile(title);
  fireEvent.click(await screen.findByRole("button", { name: "管理这本书" }));
}

async function reimportBook(title: string) {
  await openBookProfile(title);
  fireEvent.click(
    await screen.findByRole("button", { name: `重新导入正文《${title}》` })
  );
}

function makeChineseText(targetBytes: number): string {
  const unit = "春";
  return unit.repeat(Math.ceil(targetBytes / new Blob([unit]).size));
}

function novelCache(
  sessionId: string,
  title: string,
  sourceManifest: SourceManifest,
  chunks: string[]
): NovelLocalCache {
  return {
    metadata: {
      sessionId,
      type: "novel",
      title,
      cacheVersion: 2,
      remembered: true,
      itemCount: chunks.length,
      sourceManifest,
      updatedAt: "2026-06-23T00:00:00.000Z"
    },
    sourceText: chunks.join("\n\n"),
    chunks
  };
}

function bookshelfBundle(
  id: string,
  title: string,
  position: number,
  readingCommentMode: "light_chat" | "cp_talk",
  sourceManifest: SourceManifest
): SessionBundle {
  return {
    session: {
      id,
      title,
      type: "novel",
      status: "active",
      userCurrentPosition: {
        kind: "paragraph",
        index: position,
        total: sourceManifest.paragraphCount,
        label: `第 ${position} 段`
      },
      assistantSyncedPosition: null,
      liveReadingEnabled: false,
      sessionPreferences: {
        readingCommentMode,
        commentLength: "normal",
        allowDeepAnalysisByDefault: false,
        liveReadingStyle: "danmaku"
      },
      sourceManifest,
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
      lastReadAt: "2026-06-23T00:00:00.000Z"
    },
    quotes: [{ id: `quote-${id}`, sessionId: id, content: `${title}摘录`, position: { kind: "paragraph", index: 1, label: "第 1 段" }, createdAt: "2026-06-23T00:00:00.000Z" }],
    reactions: [{ id: `reaction-${id}`, sessionId: id, content: `${title}反应`, position: { kind: "paragraph", index: 1, label: "第 1 段" }, speaker: "user", createdAt: "2026-06-23T00:00:00.000Z" }],
    bookmarks: [{ id: `bookmark-${id}`, sessionId: id, position: { kind: "paragraph", index: position, label: `第 ${position} 段` }, createdAt: "2026-06-23T00:00:00.000Z" }]
  };
}

describe("no-host (pure browser local reading)", () => {
  const NO_HOST_MESSAGE = "请在 ChatGPT 内打开小书房后再使用陆沉陪读功能。";
  let savedOpenai: unknown;
  let savedParent: Window["parent"];
  let savedGetSelection: typeof window.getSelection;

  beforeEach(async () => {
    await deleteTestDatabase("ss-reading-nest");
    localStorage.clear();
    sessionStorage.clear();
    savedOpenai = (window as unknown as { openai?: unknown }).openai;
    savedParent = window.parent;
    savedGetSelection = window.getSelection?.bind(window);
    // Pure browser: top-level window, no window.openai bridge at all.
    Object.defineProperty(window, "parent", { configurable: true, value: window });
    Object.defineProperty(window, "openai", {
      configurable: true,
      writable: true,
      value: undefined
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "parent", { configurable: true, value: savedParent });
    Object.defineProperty(window, "openai", {
      configurable: true,
      writable: true,
      value: savedOpenai
    });
    if (savedGetSelection) {
      Object.defineProperty(window, "getSelection", { configurable: true, value: savedGetSelection });
    }
  });

  function selectText(text: string) {
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => ({
        toString: () => text,
        anchorNode: document.querySelector("article.novel-paper"),
        removeAllRanges: () => {}
      })
    });
  }

  async function importLocal(text: string, title = "本地测试书") {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /小说共读/ }));
    fireEvent.change(screen.getByLabelText("作品名"), { target: { value: title } });
    fireEvent.change(screen.getByPlaceholderText("粘贴 TXT 或 Markdown 文本"), {
      target: { value: text }
    });
    fireEvent.click(screen.getByRole("button", { name: "进入阅读小窝" }));
    await screen.findByText(/第 1 页 \/ 共 \d+ 页/);
    // Wait for the import flow to fully settle (local-mode prompt) so that
    // later action toasts are not overwritten by the import-completion toast.
    await screen.findByText("已进入本地阅读模式；陆沉陪读与云端同步需在 ChatGPT 内使用。");
  }

  it("enters local reading mode on import and shows the local-mode prompt", async () => {
    await importLocal("这是一本只能在本地读的小说正文。");
    expect(screen.getByText(/这是一本只能在本地读的小说正文。/)).toBeInTheDocument();
    expect(await screen.findByText("已进入本地阅读模式；陆沉陪读与云端同步需在 ChatGPT 内使用。")).toBeInTheDocument();
  });

  it("shows NO_HOST_MESSAGE when sharing the page and does not report a successful send", async () => {
    await importLocal("分享这页的正文内容。");
    fireEvent.click(screen.getByRole("button", { name: "和陆沉共读" }));
    expect(await screen.findByText(NO_HOST_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("这一页和你的想法已经发给陆沉。你可以继续往下读。")).not.toBeInTheDocument();
  });

  it("shows NO_HOST_MESSAGE when saving a thought on a selection", async () => {
    await importLocal("一句可以划线保存想法的正文。");
    selectText("可以划线保存想法");
    fireEvent.mouseUp(document.querySelector("article.novel-paper")!);
    fireEvent.click(await screen.findByRole("button", { name: "写想法" }));
    fireEvent.change(screen.getByLabelText("我的划线想法"), { target: { value: "我的感受" } });
    fireEvent.click(screen.getByRole("button", { name: "存入本页想法" }));
    expect(await screen.findByText(NO_HOST_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("想法已经留在这句旁边。")).not.toBeInTheDocument();
  });

  it("shows NO_HOST_MESSAGE when asking about a selection and does not send", async () => {
    await importLocal("一句可以划线提问的正文。");
    selectText("可以划线提问");
    fireEvent.mouseUp(document.querySelector("article.novel-paper")!);
    fireEvent.click(await screen.findByRole("button", { name: "直接提问" }));
    fireEvent.change(screen.getByLabelText("针对划线的问题"), { target: { value: "为什么这样写？" } });
    fireEvent.click(screen.getByRole("button", { name: "立即问陆沉" }));
    expect(await screen.findByText(NO_HOST_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("只把这句和你的问题发给了陆沉。")).not.toBeInTheDocument();
  });

});

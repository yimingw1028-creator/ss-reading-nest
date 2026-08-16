import { describe, expect, it } from "vitest";
import {
  buildCurrentReadingContext,
  READING_NEST_COMPATIBILITY_URI,
  READING_NEST_URI,
  registerReadingTools,
  TOOL_CONFIGS
} from "./register-tools.js";

describe("tool descriptors", () => {
  it("routes Chinese co-reading requests to the private page-context reader", () => {
    expect(TOOL_CONFIGS.read_shared_page_context.title).toContain("共读当前书页");
    expect(TOOL_CONFIGS.read_shared_page_context.description).toMatch(
      /必须.*调用.*和星星共读.*读取我保存的想法.*不要等待/s
    );
  });

  it("binds the UI resource only to the primary render tool", () => {
    expect(TOOL_CONFIGS.open_reading_nest._meta?.ui).toEqual({
      resourceUri: READING_NEST_URI
    });
    expect(TOOL_CONFIGS.open_reading_nest._meta?.["openai/outputTemplate"]).toBe(
      READING_NEST_URI
    );
    for (const [name, config] of Object.entries(TOOL_CONFIGS)) {
      if (
        name !== "open_reading_nest" &&
        name !== "get_novel_bookshelf" &&
        name !== "check_reading_nest_app_compatibility" &&
        name !== "upload_cloud_source" &&
        name !== "start_reading_session" &&
        name !== "update_reading_position" &&
        name !== "save_quote" &&
        name !== "update_quote_note" &&
        name !== "save_reaction" &&
        name !== "save_bookmark" &&
        name !== "save_reading_record"
      ) {
        const meta = "_meta" in config ? (config._meta as Record<string, unknown>) : undefined;
        const ui = meta?.ui as { resourceUri?: string } | undefined;
        expect(ui?.resourceUri).toBeUndefined();
      }
    }
    expect(TOOL_CONFIGS.upload_cloud_source._meta.ui).toEqual({
      visibility: ["app"]
    });
    expect(TOOL_CONFIGS.get_novel_bookshelf._meta.ui).toEqual({
      visibility: ["app"]
    });
    expect(TOOL_CONFIGS.start_reading_session._meta.ui).toEqual({
      visibility: ["app"]
    });
    expect(TOOL_CONFIGS.update_reading_position._meta.ui).toEqual({
      visibility: ["app"]
    });
    expect(TOOL_CONFIGS.save_quote._meta.ui).toEqual({ visibility: ["app"] });
    expect(TOOL_CONFIGS.update_quote_note._meta.ui).toEqual({ visibility: ["app"] });
    expect(TOOL_CONFIGS.save_reaction._meta.ui).toEqual({ visibility: ["app"] });
    expect(TOOL_CONFIGS.save_bookmark._meta.ui).toEqual({ visibility: ["app"] });
    expect(TOOL_CONFIGS.save_reading_record._meta.ui).toEqual({ visibility: ["app"] });
    expect(TOOL_CONFIGS.open_reading_nest._meta["openai/widgetAccessible"]).toBe(true);
    expect(TOOL_CONFIGS.open_reading_nest._meta["openai/visibility"]).toBeUndefined();
    for (const name of [
      "get_novel_bookshelf",
      "start_reading_session",
      "update_reading_position",
      "confirm_assistant_synced_position",
      "set_source_manifest",
      "get_cloud_source_status",
      "upload_cloud_source",
      "delete_cloud_source",
      "update_session_preferences",
      "rename_reading_session",
      "set_reading_session_status",
      "delete_reading_session",
      "send_current_context",
      "save_quote",
      "update_quote_note",
      "save_bookmark",
      "finish_today_reading",
      "save_reading_record",
      "complete_reading_session",
      "generate_diary_context"
    ] as const) {
      expect(TOOL_CONFIGS[name]._meta["openai/widgetAccessible"]).toBe(true);
    }
    expect(TOOL_CONFIGS.check_reading_nest_app_compatibility._meta?.ui).toEqual({
      resourceUri: READING_NEST_COMPATIBILITY_URI,
      visibility: ["app"]
    });
    expect(
      TOOL_CONFIGS.check_reading_nest_app_compatibility._meta?.["openai/visibility"]
    ).toBe("private");

    const modelVisibleTools = Object.entries(TOOL_CONFIGS)
      .filter(([, config]) => {
        const meta = "_meta" in config ? (config._meta as Record<string, unknown>) : undefined;
        const ui = meta?.ui as { visibility?: readonly string[] } | undefined;
        return ui?.visibility === undefined || ui.visibility.includes("model");
      })
      .map(([name]) => name);
    expect(modelVisibleTools).toEqual([
      "open_reading_nest",
      "read_shared_page_context",
      "save_shared_reading_reply"
    ]);

    for (const [name, config] of Object.entries(TOOL_CONFIGS)) {
      if (
        name === "open_reading_nest" ||
        name === "read_shared_page_context" ||
        name === "save_shared_reading_reply"
      ) continue;
      const meta = "_meta" in config ? (config._meta as Record<string, unknown>) : undefined;
      const ui = meta?.ui as { visibility?: readonly string[] } | undefined;
      expect(ui?.visibility, `${name} must stay hidden from the model`).toEqual(["app"]);
      expect(meta?.["openai/visibility"], `${name} must stay private`).toBe("private");
    }
  });

  it("reads the current cloud page and saved thoughts without binding another UI", async () => {
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: any) => Promise<any>) => {
        handlers.set(name, handler);
      }
    };
    const session = {
      id: "shared-session",
      title: "共读测试",
      type: "novel",
      status: "active",
      userCurrentPosition: { kind: "paragraph", index: 2, total: 3, label: "第 2 页" },
      assistantSyncedPosition: null,
      liveReadingEnabled: false,
      sessionPreferences: {},
      sourceManifest: {
        sourceId: "shared-source",
        sourceKind: "pasted_text",
        contentHash: "a".repeat(64),
        segmentationVersion: 1,
        paragraphCount: 3,
        cloudSync: { enabled: true, provider: "r2" }
      },
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      lastReadAt: "2026-08-04T00:00:00.000Z"
    };
    const service = {
      getBookshelfSnapshot: async () => ({
        sessionBundles: [{
          session,
          quotes: [{
            id: "quote-1",
            sessionId: session.id,
            content: "第二页划线",
            position: session.userCurrentPosition,
            note: "这是我的想法",
            clearThought: "这是想清楚之后留下的清思",
            createdAt: "2026-08-04T00:01:00.000Z"
          }],
          reactions: [{
            id: "reply-1",
            sessionId: session.id,
            content: "我觉得这里更像是迟疑，不是告别。",
            position: session.userCurrentPosition,
            speaker: "assistant",
            quoteId: "quote-1",
            createdAt: "2026-08-04T00:02:00.000Z"
          }],
          bookmarks: []
        }],
        readingRecords: []
      })
    };
    const cloudSource = {
      restoreNovelSource: async () => ({
        sourceText: "第一页正文\n\n第二页正文\n\n第三页正文",
        sourceManifest: session.sourceManifest
      })
    };

    registerReadingTools(server as never, service as never, cloudSource as never);
    const result = await handlers.get("read_shared_page_context")?.({});

    expect(result.structuredContent).toMatchObject({
      available: true,
      sharedPage: {
        sessionId: "shared-session",
        title: "共读测试",
        position: { index: 2 },
        currentText: "第二页正文",
        savedThoughts: [{
          quoteId: "quote-1",
          quote: "第二页划线",
          thought: "这是我的想法",
          clearThought: "这是想清楚之后留下的清思"
        }],
        discussionEntries: [{
          id: "reply-1",
          speaker: "assistant",
          quoteId: "quote-1",
          content: "我觉得这里更像是迟疑，不是告别。"
        }]
      },
      responsePolicy: {
        doNotRepeatFullPage: true,
        doNotTranscribeThoughts: true,
        style: "natural-conversation"
      }
    });
    expect(result.content[0].text).toContain("不要复述正文");
    expect(TOOL_CONFIGS.read_shared_page_context).not.toHaveProperty("_meta.ui.resourceUri");
  });

  it("persists the model response through the dedicated no-UI tool", async () => {
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: any) => Promise<any>) => {
        handlers.set(name, handler);
      }
    };
    let received: Record<string, unknown> | undefined;
    const service = {
      saveSharedReadingReply: async (input: Record<string, unknown>) => {
        received = input;
        return {
          id: "reply-1",
          sessionId: input.sessionId,
          content: input.content,
          position: { kind: "paragraph", index: input.positionIndex, label: "第 2 页" },
          speaker: "assistant",
          operationId: input.operationId,
          createdAt: "2026-08-04T00:02:00.000Z"
        };
      }
    };

    registerReadingTools(server as never, service as never);
    const result = await handlers.get("save_shared_reading_reply")?.({
      sessionId: "shared-session",
      positionIndex: 2,
      content: "我觉得这里更像是迟疑，不是告别。",
      operationId: "save-reply-once"
    });

    expect(received).toEqual({
      sessionId: "shared-session",
      positionIndex: 2,
      content: "我觉得这里更像是迟疑，不是告别。",
      operationId: "save-reply-once"
    });
    expect(result.structuredContent).toMatchObject({
      saved: true,
      discussionEntry: {
        id: "reply-1",
        speaker: "assistant",
        operationId: "save-reply-once"
      }
    });
    expect(result.content[0].text).toContain("共读回应已经留在书里");
    expect(TOOL_CONFIGS.save_shared_reading_reply).not.toHaveProperty("_meta.ui.resourceUri");
  });

  it("returns the component-only source endpoint for the rendered widget", async () => {
    const handlers = new Map<string, () => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: () => Promise<unknown>) => {
        handlers.set(name, handler);
      }
    };
    const session =
        {
          id: "session-1",
          title: "云端书",
          type: "novel",
          status: "active",
          userCurrentPosition: { kind: "paragraph", index: 1, label: "第 1 段" },
          assistantSyncedPosition: null,
          liveReadingEnabled: false,
          sessionPreferences: {},
          sourceManifest: {
            sourceId: "source-1",
            sourceKind: "pasted_text",
            contentHash: "a".repeat(64),
            segmentationVersion: 4,
            paragraphCount: 12,
            cloudSync: {
              enabled: true,
              provider: "r2",
              objectKey: "private/sources/source-1/source.txt",
              manifestObjectKey: "private/sources/source-1/manifest.json",
              sizeBytes: 120,
              mimeType: "text/plain;charset=utf-8"
            }
          },
          createdAt: "2026-06-24T00:00:00.000Z",
          updatedAt: "2026-06-24T00:00:00.000Z",
          lastReadAt: "2026-06-24T00:00:00.000Z"
        };
    const readingRecord =
        {
          id: "record-1",
          sessionId: "session-1",
          bookTitle: "云端书",
          startedAt: "2026-06-24T00:00:00.000Z",
          endedAt: "2026-06-24T00:12:00.000Z",
          durationSeconds: 720,
          startPosition: { kind: "paragraph", index: 1, label: "第 1 页" },
          endPosition: { kind: "paragraph", index: 3, label: "第 3 页" },
          pagesRead: 3,
          operationId: "record-op-1",
          createdAt: "2026-06-24T00:12:01.000Z"
        };
    const service = {
      getBookshelfSnapshot: async (includeReadingRecords = true) => ({
        sessionBundles: [{ session, quotes: [], reactions: [], bookmarks: [] }],
        readingRecords: includeReadingRecords ? [readingRecord] : []
      })
    };

    registerReadingTools(server as never, service as never, undefined, {
      sourceEndpointBase: "https://worker.example.test/source/secret"
    });
    const result = (await handlers.get("open_reading_nest")?.()) as {
      structuredContent?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    };

    expect(result.structuredContent).toMatchObject({
      count: 1,
      bookshelf: [
        expect.objectContaining({
          id: "session-1",
          title: "云端书",
          type: "novel",
          currentPositionIndex: 1
        })
      ]
    });
    expect(result.structuredContent).not.toHaveProperty("sourceEndpointBase");
    expect(result.structuredContent).not.toHaveProperty("bookshelfSessions");
    expect(result._meta?.privateBookshelf).toMatchObject({
      sourceEndpointBase: "https://worker.example.test/source/secret",
      bookshelfSessions: [
        expect.objectContaining({ session: expect.objectContaining({ id: "session-1" }) })
      ]
    });
    expect(result._meta?.privateBookshelf).not.toHaveProperty("readingRecords");
    expect(result._meta).not.toHaveProperty("ui");
    expect(result._meta).not.toHaveProperty("ui/resourceUri");
    expect(result._meta).not.toHaveProperty("openai/outputTemplate");
    expect(JSON.stringify(result)).not.toMatch(
      /sourceText|bytesBase64|data:image|objectKey|manifestObjectKey|private\/sources\//
    );

    const refreshed = (await handlers.get("get_novel_bookshelf")?.()) as {
      structuredContent?: Record<string, unknown>;
    };
    expect(refreshed.structuredContent).toMatchObject({
      sourceEndpointBase: "https://worker.example.test/source/secret",
      bookshelfSessions: [expect.objectContaining({ session: expect.objectContaining({ id: "session-1" }) })],
      readingRecords: [expect.objectContaining({ id: "record-1", sessionId: "session-1" })]
    });
    expect(JSON.stringify(refreshed)).not.toMatch(
      /objectKey|manifestObjectKey|private\/sources\//
    );
  });

  it("returns a separate, data-free resource for the native App compatibility check", async () => {
    const handlers = new Map<string, () => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: () => Promise<unknown>) => {
        handlers.set(name, handler);
      }
    };
    const service = {
      getBookshelfSnapshot: async () => ({ sessionBundles: [], readingRecords: [] })
    };
    registerReadingTools(server as never, service as never);

    const result = (await handlers.get("check_reading_nest_app_compatibility")?.()) as {
      structuredContent?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    };

    expect(result.structuredContent).toEqual({
      resourceVersion: "app-compat-v1",
      purpose: "native_app_render_check"
    });
    expect(result._meta).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/sourceText|currentText|OPENAI_API_KEY|responses/i);
  });


  it("does not expose a model API or ambiguous end session tool", () => {
    expect(Object.keys(TOOL_CONFIGS)).not.toContain("end_reading_session");
    expect(JSON.stringify(TOOL_CONFIGS)).not.toMatch(/OPENAI_API_KEY|responses|chat completions/i);
  });

  it("exposes explicit assistant confirmation and live-reading tools", () => {
    expect(Object.keys(TOOL_CONFIGS)).toContain("confirm_assistant_synced_position");
    expect(Object.keys(TOOL_CONFIGS)).toContain("set_live_reading_mode");
    expect(
      TOOL_CONFIGS.confirm_assistant_synced_position.annotations.idempotentHint
    ).toBe(true);
  });

  it("exposes a metadata-only source manifest mutation tool", () => {
    expect(Object.keys(TOOL_CONFIGS)).toContain("set_source_manifest");
    expect(TOOL_CONFIGS.set_source_manifest.annotations.idempotentHint).toBe(true);
    expect(JSON.stringify(TOOL_CONFIGS.set_source_manifest)).not.toMatch(
      /currentText|selectedText|includedText|imageData|download_url/
    );
  });

  it("exposes an idempotent structured preference update tool", () => {
    expect(Object.keys(TOOL_CONFIGS)).toContain("update_session_preferences");
    expect(TOOL_CONFIGS.update_session_preferences.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true
    });
    expect(JSON.stringify(TOOL_CONFIGS.update_session_preferences)).not.toMatch(
      /currentText|selectedText|includedText/
    );
  });

  it("fills omitted comment preferences and preserves explicit values and source context", () => {
    const session = {
      id: "session-1",
      title: "偏好书",
      type: "novel" as const,
      status: "active" as const,
      userCurrentPosition: { kind: "paragraph" as const, index: 8, label: "第 8 段" },
      assistantSyncedPosition: null,
      liveReadingEnabled: false,
      sessionPreferences: {
        readingCommentMode: "cp_talk" as const,
        commentLength: "normal" as const,
        allowDeepAnalysisByDefault: false as const,
        liveReadingStyle: "danmaku" as const,
        autoSaveCompanionComments: true
      },
      sourceManifest: null,
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
      lastReadAt: "2026-06-22T00:00:00.000Z"
    };
    const sourceContext = {
      contentHash: "a".repeat(64),
      segmentationVersion: 1,
      paragraphCount: 12
    };

    const fallback = buildCurrentReadingContext(session, {
      sessionId: session.id,
      currentPosition: session.userCurrentPosition,
      currentText: "当前段落",
      sourceContext,
      mode: "current_only"
    });
    const explicit = buildCurrentReadingContext(session, {
      sessionId: session.id,
      currentPosition: session.userCurrentPosition,
      currentText: "当前段落",
      mode: "current_only",
      readingCommentMode: "plot_guess",
      commentLength: "short"
    });
    const live = buildCurrentReadingContext(session, {
      sessionId: session.id,
      currentPosition: session.userCurrentPosition,
      includedText: "当前段和前一段",
      mode: "live_reading"
    });

    expect(fallback).toMatchObject({
      readingCommentMode: "cp_talk",
      commentLength: "normal",
      sourceContext
    });
    expect(explicit).toMatchObject({
      readingCommentMode: "plot_guess",
      commentLength: "short"
    });
    expect(live).toMatchObject({
      readingCommentMode: "reaction_only",
      commentLength: "short"
    });
  });

  it("exposes the book-management tools and reaches twenty-eight tools", () => {
    expect(Object.keys(TOOL_CONFIGS)).toHaveLength(28);
    expect(TOOL_CONFIGS.get_novel_bookshelf.annotations.readOnlyHint).toBe(true);
    expect(TOOL_CONFIGS.rename_reading_session.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true
    });
    expect(TOOL_CONFIGS.set_reading_session_status.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true
    });
    expect(TOOL_CONFIGS.delete_reading_session.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true
    });
    expect(
      TOOL_CONFIGS.delete_reading_session.inputSchema.parse({
        sessionId: "session-1",
        operationId: "delete-op-1",
        deleteCloudSource: true
      })
    ).toMatchObject({ deleteCloudSource: true });
    expect(() =>
      TOOL_CONFIGS.delete_reading_session.inputSchema.parse({
        sessionId: "session-1",
        operationId: "delete-op-1",
        deleteLocalCache: true
      })
    ).toThrow();
    expect(JSON.stringify(TOOL_CONFIGS.delete_reading_session)).not.toMatch(
      /sourceText|imageData|data:image|publicUrl|signedUrl/
    );
  });

  it("exposes metadata-only cloud source tools without full-text restore", () => {
    expect(Object.keys(TOOL_CONFIGS)).toEqual(
      expect.arrayContaining(["get_cloud_source_status", "delete_cloud_source"])
    );
    expect(Object.keys(TOOL_CONFIGS)).not.toContain("restore_cloud_source");
    expect(JSON.stringify(TOOL_CONFIGS.get_cloud_source_status)).not.toMatch(
      /sourceText|publicUrl|signedUrl|currentText|includedText/
    );
    expect(JSON.stringify(TOOL_CONFIGS.delete_cloud_source)).not.toMatch(
      /sourceText|publicUrl|signedUrl|currentText|includedText/
    );
  });

  it("uploads cloud source through an app-only tool with metadata-only structured content", async () => {
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: any) => Promise<any>) => {
        handlers.set(name, handler);
      }
    };
    const service = {
      listAllSessions: async () => [],
      getSessionBundle: async () => ({
        session: {},
        quotes: [],
        reactions: [],
        bookmarks: []
      }),
      listReadingRecords: async () => []
    };
    const sourceManifest = {
      sourceId: "source-1",
      sourceKind: "pasted_text",
      contentHash: "a".repeat(64),
      segmentationVersion: 1,
      paragraphCount: 1,
      cloudSync: {
        enabled: true,
        provider: "r2",
        objectKey: "private/sources/source-1/source.txt",
        manifestObjectKey: "private/sources/source-1/manifest.json",
        sizeBytes: 12,
        mimeType: "text/plain;charset=utf-8"
      }
    };
    const cloudSource = {
      uploadNovelSource: async () => ({ sourceManifest }),
      getCloudSourceStatus: async () => ({ status: "available" }),
      deleteCloudSource: async () => ({ deleted: true, cloudSourceDeleted: true })
    };

    registerReadingTools(server as never, service as never, cloudSource as never);
    const result = await handlers.get("upload_cloud_source")?.({
      sessionId: "session-1",
      sourceKind: "pasted_text",
      sourceText: "private source text"
    });

    expect(result.structuredContent).toMatchObject({
      uploaded: true,
      sessionId: "session-1",
      sourceId: "source-1",
      contentHash: "a".repeat(64),
      paragraphCount: 1,
      cloudSync: {
        enabled: true,
        provider: "r2",
        sizeBytes: 12,
        mimeType: "text/plain;charset=utf-8"
      }
    });
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/private source text|objectKey|private\/sources/);
    expect(result._meta.sourceManifest.cloudSync.objectKey).toBe("private/sources/source-1/source.txt");
  });
});

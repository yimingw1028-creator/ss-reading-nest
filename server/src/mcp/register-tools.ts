import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  READING_NEST_RESOURCE_URI,
  completeReadingSessionInputSchema,
  deleteBookArchiveEntryInputSchema,
  deleteQuoteInputSchema,
  confirmAssistantSyncedPositionInputSchema,
  finishTodayReadingInputSchema,
  generateDiaryContextInputSchema,
  getCloudSourceStatusInputSchema,
  openReadingNestInputSchema,
  renameReadingSessionInputSchema,
  saveBookmarkInputSchema,
  saveQuoteInputSchema,
  saveReadingRecordInputSchema,
  saveSharedReadingReplyInputSchema,
  updateQuoteNoteInputSchema,
  saveReactionInputSchema,
  sendCurrentContextInputSchema,
  setLiveReadingModeInputSchema,
  setReadingSessionStatusInputSchema,
  setSourceManifestInputSchema,
  startReadingSessionInputSchema,
  deleteReadingSessionInputSchema,
  deleteCloudSourceInputSchema,
  uploadCloudSourceInputSchema,
  updateSessionPreferencesInputSchema,
  updateReadingPositionInputSchema,
  splitNovelTextForVersion
} from "@ss/shared";
import type { ReadingSession, SendCurrentContextInput, SourceManifest } from "@ss/shared";
import { sanitizeBookshelfBundle } from "../privacy/sanitize-bookshelf.js";
import { ReadingService } from "../services/reading-service.js";
import type { CloudSourceService } from "../services/cloud-source-service.js";
import { toolResult } from "./tool-result.js";

// ChatGPT connections cache component URIs. Keep old URI aliases registered so a
// previous connection can still fetch its template after a later app release.
export const READING_NEST_URI = READING_NEST_RESOURCE_URI;
export const READING_NEST_LEGACY_URIS = [
  "ui://ss-reading-nest/app-v78-context-fallback-remount.html",
  "ui://ss-reading-nest/app-v76-ios-remount.html",
  "ui://ss-reading-nest/app-v77-explicit-thought-delivery.html",
  "ui://ss-reading-nest/app-v74-fast-mobile-mount.html",
  "ui://ss-reading-nest/app-v75-privacy-host-fix.html",
  "ui://ss-reading-nest/app-v73-multi-book-stable.html",
  "ui://ss-reading-nest/app-v72-handshake-gate.html",
  "ui://ss-reading-nest/app-v71-three-host-stable.html",
  "ui://ss-reading-nest/app-v70-soft-ink-green.html",
  "ui://ss-reading-nest/app-v69-mobile-cover-recovery.html",
  "ui://ss-reading-nest/app-v68-pip-client-compat.html",
  "ui://ss-reading-nest/app-v67-stable-host-state.html",
  "ui://ss-reading-nest/app-v66-protected-bookshelf-bootstrap.html",
  "ui://ss-reading-nest/app-v65-mobile-bookshelf-fallback.html",
  "ui://ss-reading-nest/app-v64-official-resource-binding.html",
  "ui://ss-reading-nest/app-v62-mobile-ui-binding.html",
  "ui://ss-reading-nest/app-v61-tool-visibility.html",
  "ui://ss-reading-nest/app-v60-expand-icon.html",
  "ui://ss-reading-nest/app-v59-fullscreen-theme-fill.html",
  "ui://ss-reading-nest/app-v58-navigation-icons.html",
  "ui://ss-reading-nest/app-v57-cover-profile-layout.html",
  "ui://ss-reading-nest/app-v56-toc-narrow-layout.html",
  "ui://ss-reading-nest/app-v55-stable-reader-polish.html",
  "ui://ss-reading-nest/app-v54-host-envelope-fallback.html",
  "ui://ss-reading-nest/app-v53-client-bridge-recovery.html",
  "ui://ss-reading-nest/app-v52-gray-recovery.html",
  "ui://ss-reading-nest/app-v51-ios-bridge-send.html",
  "ui://ss-reading-nest/app-v50-send-visible.html",
  "ui://ss-reading-nest/app-v49-novel-only.html",
  "ui://ss-reading-nest/app-v48.html",
  "ui://ss-reading-nest/app-v47.html",
  "ui://ss-reading-nest/reader-mobile-diagnose-v1.html",
  "ui://ss-reading-nest/app-v46.html",
  "ui://ss-reading-nest/app-v45.html",
  "ui://ss-reading-nest/app-v44.html",
  "ui://ss-reading-nest/app-v43.html",
  "ui://ss-reading-nest/app-v42.html",
  "ui://ss-reading-nest/app-v41.html",
  "ui://ss-reading-nest/app-v40.html",
  "ui://ss-reading-nest/app-v39.html",
  "ui://ss-reading-nest/app-v38.html",
  "ui://ss-reading-nest/app-v37.html",
  "ui://ss-reading-nest/app-v19.html",
  "ui://ss-reading-nest/app-v35.html",
  "ui://ss-reading-nest/app-v36.html"
] as const;
export const READING_NEST_COMPATIBILITY_URI = "ui://ss-reading-nest/app-compat-v3.html";
export const READING_NEST_COMPATIBILITY_LEGACY_URIS = [
  "ui://ss-reading-nest/app-compat-v1.html",
  "ui://ss-reading-nest/app-compat-v2.html"
] as const;

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
};
const mutation = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false
};
const appOnlyToolMeta = {
  ui: { visibility: ["app"] },
  "openai/widgetAccessible": true,
  "openai/visibility": "private"
} as const;
const widgetCallableToolMeta = appOnlyToolMeta;
const readSharedPageContextInputSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    positionIndex: z.number().int().min(1).optional()
  })
  .strict();

export const TOOL_CONFIGS = {
  open_reading_nest: {
    title: "打开阿雾和陆沉的共读小巢",
    description: "Use this when the user wants to open the reading nest or continue recent reading.",
    inputSchema: openReadingNestInputSchema,
    annotations: readOnly,
    _meta: {
      ui: { resourceUri: READING_NEST_URI },
      "openai/outputTemplate": READING_NEST_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "正在点亮小窝…",
      "openai/toolInvocation/invoked": "小窝已经准备好"
    }
  },
  read_shared_page_context: {
    title: "共读当前书页与阿雾的想法",
    description:
      "必须在用户要求共读当前页时调用。触发语包括：和陆沉共读、读这一页、刚读完第几页、看看这一页、读取我保存的想法、聊聊当前内容。即使阅读组件已经打开，也要立即调用本工具读取当前页正文和阿雾保存的想法；不要等待组件再次推送，不要声称拿不到内容。读取后直接回应阿雾的想法，不要复述或概括整页，也不要逐条转抄想法。",
    inputSchema: readSharedPageContextInputSchema,
    annotations: readOnly
  },
  save_shared_reading_reply: {
    title: "把陆沉的共读回应留在书里",
    description:
      "Use this when the reading app asks you to preserve your response beside a shared page or saved quote. Save the substantive response before replying in chat. Use revisesId to add a visible revision without overwriting the earlier entry.",
    inputSchema: saveSharedReadingReplyInputSchema,
    annotations: { ...mutation, idempotentHint: true }
  },
  get_novel_bookshelf: {
    title: "读取小说书架",
    description: "Internal app-only refresh for the user's novel bookshelf.",
    inputSchema: openReadingNestInputSchema,
    annotations: readOnly,
    _meta: appOnlyToolMeta
  },
  check_reading_nest_app_compatibility: {
    title: "检查阿雾和陆沉的共读小巢 App 兼容性",
    description:
      "Use this only to verify whether the current ChatGPT client can render the minimal 阿雾和陆沉的共读小巢 App component. It does not read or modify any book data.",
    inputSchema: z.object({}),
    annotations: readOnly,
    _meta: {
      ui: {
        resourceUri: READING_NEST_COMPATIBILITY_URI,
        visibility: ["app"]
      },
      "openai/outputTemplate": READING_NEST_COMPATIBILITY_URI,
      "openai/widgetAccessible": true,
      "openai/visibility": "private",
      "openai/toolInvocation/invoking": "正在检查 App 组件…",
      "openai/toolInvocation/invoked": "App 组件检查已打开"
    }
  },
  start_reading_session: {
    title: "开始共读",
    description: "Use this when the user starts reading a new novel.",
    inputSchema: startReadingSessionInputSchema,
    annotations: mutation,
    _meta: appOnlyToolMeta
  },
  update_reading_position: {
    title: "更新阅读进度",
    description: "Use this when the current paragraph changes.",
    inputSchema: updateReadingPositionInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: appOnlyToolMeta
  },
  confirm_assistant_synced_position: {
    title: "确认陆沉已读位置",
    description:
      "Use this only after the user explicitly confirms that ChatGPT replied it has read through a batch end.",
    inputSchema: confirmAssistantSyncedPositionInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: widgetCallableToolMeta
  },
  set_live_reading_mode: {
    title: "设置实时陪读模式",
    description: "Use this when the user enables or disables lightweight live reading.",
    inputSchema: setLiveReadingModeInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: widgetCallableToolMeta
  },
  set_source_manifest: {
    title: "确认本设备阅读来源",
    description:
      "Use this when the app has computed source hash metadata for the current novel. Never send source text.",
    inputSchema: setSourceManifestInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: widgetCallableToolMeta
  },
  get_cloud_source_status: {
    title: "检查私人云端正文状态",
    description:
      "Use this to check whether a reading source exists in private cloud storage. Returns metadata only.",
    inputSchema: getCloudSourceStatusInputSchema,
    annotations: readOnly,
    _meta: widgetCallableToolMeta
  },
  upload_cloud_source: {
    title: "Upload private cloud source",
    description:
      "App-only bridge tool for uploading user-provided novel text to private R2. Returns metadata only and never returns source text.",
    inputSchema: uploadCloudSourceInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: appOnlyToolMeta
  },
  delete_cloud_source: {
    title: "删除私人云端正文副本",
    description:
      "Use this only after the user confirms deleting the private cloud source copy. Returns metadata only.",
    inputSchema: deleteCloudSourceInputSchema,
    annotations: {
      ...mutation,
      destructiveHint: true,
      idempotentHint: true
    },
    _meta: widgetCallableToolMeta
  },
  update_session_preferences: {
    title: "更新陪读偏好",
    description:
      "Use this when the user changes how ChatGPT should comment for this reading session.",
    inputSchema: updateSessionPreferencesInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: widgetCallableToolMeta
  },
  rename_reading_session: {
    title: "重命名书籍",
    description: "Use this when the user explicitly changes one reading session title.",
    inputSchema: renameReadingSessionInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: widgetCallableToolMeta
  },
  set_reading_session_status: {
    title: "更新作品状态",
    description: "Use this when the user explicitly marks a work completed or active again.",
    inputSchema: setReadingSessionStatusInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: widgetCallableToolMeta
  },
  delete_reading_session: {
    title: "删除书籍阅读数据",
    description: "Use this only after the user confirms deleting one session's structured data.",
    inputSchema: deleteReadingSessionInputSchema,
    annotations: {
      ...mutation,
      destructiveHint: true,
      idempotentHint: true
    },
    _meta: widgetCallableToolMeta
  },
  send_current_context: {
    title: "同步当前阅读内容",
    description:
      "Use this when the user explicitly asks ChatGPT to look at the current paragraph.",
    inputSchema: sendCurrentContextInputSchema,
    annotations: readOnly,
    _meta: widgetCallableToolMeta
  },
  save_quote: {
    title: "保存摘录",
    description: "Use this when the user explicitly saves a selected sentence.",
    inputSchema: saveQuoteInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: appOnlyToolMeta
  },
  update_quote_note: {
    title: "修改划线想法",
    description: "Use this when the user edits the thought attached to an existing saved quote.",
    inputSchema: updateQuoteNoteInputSchema,
    annotations: mutation,
    _meta: appOnlyToolMeta
  },
  delete_quote: {
    title: "删除划线记录",
    description: "Delete one saved quote and its attached thoughts.",
    inputSchema: deleteQuoteInputSchema,
    annotations: { ...mutation, destructiveHint: true },
    _meta: appOnlyToolMeta
  },
  delete_book_archive_entry: {
    title: "删除书内记录",
    description: "Delete one reaction, bookmark, legacy annotation, or reading checkpoint.",
    inputSchema: deleteBookArchiveEntryInputSchema,
    annotations: { ...mutation, destructiveHint: true },
    _meta: appOnlyToolMeta
  },
  save_reaction: {
    title: "保存吐槽",
    description: "Use this when the user saves their reaction to the current reading position.",
    inputSchema: saveReactionInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: appOnlyToolMeta
  },
  save_bookmark: {
    title: "保存书签",
    description: "Use this when the user wants to remember the current reading position.",
    inputSchema: saveBookmarkInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: appOnlyToolMeta
  },
  finish_today_reading: {
    title: "今天看到这里",
    description: "Use this when the user stops for today but has not completed the whole work.",
    inputSchema: finishTodayReadingInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: widgetCallableToolMeta
  },
  save_reading_record: {
    title: "保存阅读记录",
    description: "App-only metadata write for one real novel reading session.",
    inputSchema: saveReadingRecordInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: appOnlyToolMeta
  },
  complete_reading_session: {
    title: "完成这部作品",
    description: "Use this only when the user explicitly says they finished the whole work.",
    inputSchema: completeReadingSessionInputSchema,
    annotations: { ...mutation, idempotentHint: true },
    _meta: widgetCallableToolMeta
  },
  generate_diary_context: {
    title: "生成小窝日记素材",
    description: "Use this when the user wants ChatGPT to write today's copyable reading diary.",
    inputSchema: generateDiaryContextInputSchema,
    annotations: readOnly,
    _meta: widgetCallableToolMeta
  }
} as const;

const lightweightInputSchema = z.object({}).passthrough();

function createLightweightToolConfigs() {
  return Object.fromEntries(
    Object.entries(TOOL_CONFIGS).map(([name, config]) => [
      name,
      name === "open_reading_nest" ||
      name === "read_shared_page_context" ||
      name === "save_shared_reading_reply" ||
      name === "check_reading_nest_app_compatibility"
        ? config
        : {
            ...config,
            inputSchema: lightweightInputSchema
          }
    ])
  ) as typeof TOOL_CONFIGS;
}

export function registerReadingTools(
  server: McpServer,
  service: ReadingService,
  cloudSourceService?: CloudSourceService,
  options: { sourceEndpointBase?: string; lightweightSchemas?: boolean } = {}
) {
  const toolConfigs = options.lightweightSchemas
    ? createLightweightToolConfigs()
    : TOOL_CONFIGS;

  const loadNovelBookshelf = async (includeReadingRecords = true) => {
    const snapshot = await service.getBookshelfSnapshot(includeReadingRecords);
    const bookshelfSessions = snapshot.sessionBundles
      .filter(({ session }) => session.type === "novel")
      .map(sanitizeBookshelfBundle);
    return {
      bookshelfSessions,
      recentSessions: bookshelfSessions.slice(0, 10),
      ...(includeReadingRecords ? { readingRecords: snapshot.readingRecords } : {}),
      ...(options.sourceEndpointBase ? { sourceEndpointBase: options.sourceEndpointBase } : {})
    };
  };

  registerAppTool(server, "open_reading_nest", toolConfigs.open_reading_nest, async () => {
    const bookshelf = await loadNovelBookshelf(false);
    return {
      ...toolResult(
        summarizeNovelBookshelfForModel(bookshelf.bookshelfSessions),
        "已打开阿雾和陆沉的共读小巢。完整书架只显示在阅读组件内。后续如果阿雾要求共读、讨论当前页或读取已保存的想法，必须立即调用 read_shared_page_context；不要等待阅读组件再次推送内容。"
      ),
      _meta: { privateBookshelf: bookshelf }
    };
  });

  server.registerTool(
    "read_shared_page_context",
    toolConfigs.read_shared_page_context,
    async ({ sessionId, title, positionIndex }) => {
      const snapshot = await service.getBookshelfSnapshot(false);
      const novelBundles = snapshot.sessionBundles.filter(
        ({ session }) => session.type === "novel"
      );
      const bundle =
        (sessionId
          ? novelBundles.find(({ session }) => session.id === sessionId)
          : undefined) ??
        (title
          ? novelBundles.find(({ session }) => session.title === title)
          : undefined) ??
        novelBundles[0];

      if (!bundle) {
        return toolResult(
          { available: false, reason: "no-novel-session" },
          "当前没有可供共读的小说。"
        );
      }

      const index = positionIndex ?? bundle.session.userCurrentPosition.index;
      const savedThoughts = bundle.quotes
        .filter(
          (quote) =>
            quote.position.kind === bundle.session.userCurrentPosition.kind &&
            quote.position.index === index &&
            Boolean(quote.note?.trim() || quote.clearThought?.trim())
        )
        .map((quote) => ({
          quoteId: quote.id,
          quote: quote.content,
          ...(quote.note?.trim() ? { thought: quote.note.trim() } : {}),
          ...(quote.clearThought?.trim()
            ? { clearThought: quote.clearThought.trim() }
            : {})
        }));
      const discussionEntries = bundle.reactions
        .filter(
          (entry) =>
            entry.position.kind === bundle.session.userCurrentPosition.kind &&
            entry.position.index === index
        )
        .map((entry) => ({
          id: entry.id,
          speaker: entry.speaker,
          content: entry.content,
          ...(entry.quoteId ? { quoteId: entry.quoteId } : {}),
          ...(entry.replyToId ? { replyToId: entry.replyToId } : {}),
          ...(entry.revisesId ? { revisesId: entry.revisesId } : {}),
          createdAt: entry.createdAt
        }));

      let currentText: string | undefined;
      if (cloudSourceService && bundle.session.sourceManifest?.cloudSync.enabled) {
        try {
          const { sourceText, sourceManifest } = await cloudSourceService.restoreNovelSource(
            bundle.session.id
          );
          currentText = splitNovelTextForVersion(
            sourceText,
            sourceManifest.segmentationVersion
          )[index - 1];
        } catch {
          currentText = undefined;
        }
      }

      return toolResult(
        {
          available: Boolean(currentText || savedThoughts.length || discussionEntries.length),
          sharedPage: {
            sessionId: bundle.session.id,
            title: bundle.session.title,
            position: {
              ...bundle.session.userCurrentPosition,
              index
            },
            ...(currentText ? { currentText } : {}),
            savedThoughts,
            discussionEntries
          },
          responsePolicy: {
            prioritizeUserThoughts: true,
            doNotRepeatFullPage: true,
            doNotTranscribeThoughts: true,
            style: "natural-conversation"
          }
        },
        savedThoughts.length
          ? `已读取《${bundle.session.title}》当前页和 ${savedThoughts.length} 条想法。请直接回应用户的想法，不要复述正文或逐条转抄。`
          : `已读取《${bundle.session.title}》当前页。请直接聊天，不要复述或概括整页。`
      );
    }
  );

  server.registerTool(
    "save_shared_reading_reply",
    toolConfigs.save_shared_reading_reply,
    async (input) => {
      const reaction = await service.saveSharedReadingReply(input);
      return toolResult(
        { saved: true, discussionEntry: reaction },
        input.revisesId ? "修订已经并排留在书里。" : "共读回应已经留在书里。"
      );
    }
  );

  registerAppTool(server, "get_novel_bookshelf", toolConfigs.get_novel_bookshelf, async () =>
    toolResult(await loadNovelBookshelf(), "小说书架已更新。")
  );

  registerAppTool(
    server,
    "check_reading_nest_app_compatibility",
    toolConfigs.check_reading_nest_app_compatibility,
    async () => {
      return toolResult(
        { resourceVersion: "app-compat-v1", purpose: "native_app_render_check" },
        "已打开最小 App 兼容性检查。"
      );
    }
  );

  registerAppTool(
    server,
    "start_reading_session",
    toolConfigs.start_reading_session,
    async ({ title }) => {
      const session = await service.startSession(title);
      return toolResult({ session }, `已开始共读《${session.title}》。`);
    }
  );

  registerAppTool(
    server,
    "update_reading_position",
    toolConfigs.update_reading_position,
    async ({ sessionId, userCurrentPosition }) => {
      const session = await service.updateUserPosition(sessionId, userCurrentPosition);
      return toolResult(
        {
          sessionId,
          userCurrentPosition: session.userCurrentPosition,
          assistantSyncedPosition: session.assistantSyncedPosition,
          updatedAt: session.updatedAt
        },
        `用户进度已更新到${userCurrentPosition.label}。`
      );
    }
  );

  server.registerTool(
    "confirm_assistant_synced_position",
    toolConfigs.confirm_assistant_synced_position,
    async (input) => {
      const session = await service.confirmAssistantPosition(input);
      return toolResult(
        {
          sessionId: session.id,
          assistantSyncedPosition: session.assistantSyncedPosition,
          confirmedBatchId: input.batchId,
          updatedAt: session.updatedAt
        },
        `已由用户确认陆沉读到${input.confirmedPosition.label}。`
      );
    }
  );

  server.registerTool(
    "set_live_reading_mode",
    toolConfigs.set_live_reading_mode,
    async ({ sessionId, enabled }) => {
      const session = await service.setLiveReadingMode(sessionId, enabled);
      return toolResult(
        {
          sessionId,
          liveReadingEnabled: session.liveReadingEnabled,
          updatedAt: session.updatedAt
        },
        enabled ? "实时陪读模式已开启。" : "实时陪读模式已关闭。"
      );
    }
  );

  server.registerTool(
    "set_source_manifest",
    toolConfigs.set_source_manifest,
    async ({ sessionId, sourceManifest }) => {
      const session = await service.setSourceManifest(sessionId, sourceManifest);
      return toolResult(
        {
          sessionId,
          sourceManifest: session.sourceManifest,
          updatedAt: session.updatedAt
        },
        "本设备阅读来源已校验并保存。"
      );
    }
  );

  server.registerTool(
    "get_cloud_source_status",
    toolConfigs.get_cloud_source_status,
    async ({ sessionId }) => {
      if (!cloudSourceService) {
        return toolResult({ status: "disabled" as const }, "私人云端正文服务尚未启用。");
      }
      const result = await cloudSourceService.getCloudSourceStatus(sessionId);
      return toolResult(result, "已检查这本书的私人云端正文状态。");
    }
  );

  registerAppTool(server, "upload_cloud_source", toolConfigs.upload_cloud_source, async (input) => {
    if (!cloudSourceService) {
      return toolResult({ uploaded: false }, "私人云端正文服务尚未启用。");
    }
    const result = await cloudSourceService.uploadNovelSource({
      sessionId: input.sessionId,
      sourceKind: input.sourceKind,
      ...(input.title ? { title: input.title } : {}),
      sourceText: input.sourceText,
      ...(input.readingState ? { readingState: input.readingState } : {})
    });
    const response = toolResult(
      {
        uploaded: true,
        sessionId: input.sessionId,
        ...summarizeCloudSourceManifest(result.sourceManifest)
      },
      "私人云端正文已上传。"
    );
    return {
      ...response,
      _meta: { sourceManifest: result.sourceManifest }
    };
  });

  server.registerTool(
    "delete_cloud_source",
    toolConfigs.delete_cloud_source,
    async ({ sessionId }) => {
      if (!cloudSourceService) {
        return toolResult({ deleted: false }, "私人云端正文服务尚未启用。");
      }
      const result = await cloudSourceService.deleteCloudSource(sessionId);
      return toolResult(result, result.deleted ? "私人云端正文副本已删除。" : "没有可删除的私人云端正文副本。");
    }
  );

  server.registerTool(
    "update_session_preferences",
    toolConfigs.update_session_preferences,
    async ({ sessionId, preferences }) => {
      const session = await service.updateSessionPreferences(sessionId, preferences);
      return toolResult(
        {
          sessionId,
          sessionPreferences: session.sessionPreferences,
          updatedAt: session.updatedAt
        },
        "本书的陪读偏好已更新。"
      );
    }
  );

  server.registerTool(
    "rename_reading_session",
    toolConfigs.rename_reading_session,
    async ({ sessionId, title }) => {
      const session = await service.renameSession(sessionId, title);
      return toolResult({ session }, `已将作品重命名为《${session.title}》。`);
    }
  );

  server.registerTool(
    "set_reading_session_status",
    toolConfigs.set_reading_session_status,
    async ({ sessionId, status }) => {
      const session = await service.setSessionStatus(sessionId, status);
      return toolResult(
        { session },
        status === "completed" ? "已标记为完成。" : "已恢复为阅读中。"
      );
    }
  );

  server.registerTool(
    "delete_reading_session",
    toolConfigs.delete_reading_session,
    async ({ sessionId, operationId, deleteCloudSource }) => {
      let cloudResult:
        | {
            cloudSourceDeleted: boolean;
            cloudSourceDeleteError?: string;
          }
        | undefined;
      if (deleteCloudSource && cloudSourceService) {
        const result = await cloudSourceService.deleteCloudSource(sessionId);
        cloudResult = {
          cloudSourceDeleted: result.cloudSourceDeleted,
          ...(result.cloudSourceDeleteError
            ? { cloudSourceDeleteError: result.cloudSourceDeleteError }
            : {})
        };
      }
      const result = await service.deleteSession(sessionId, operationId, {
        deleteCloudSource: false
      });
      const combined = { ...result, ...cloudResult };
      return toolResult(combined, result.deleted ? "这本书的云端阅读数据已删除。" : "这本书已不在书架中。");
    }
  );

  server.registerTool(
    "send_current_context",
    toolConfigs.send_current_context,
    async (input) => {
      const { session } = await service.getSessionBundle(input.sessionId);
      const currentPosition = input.currentPosition ?? input.position!;
      const context = buildCurrentReadingContext(session, input);
      return toolResult(
        { context },
        `用户正在共读《${session.title}》，位置是${currentPosition.label}。请根据本次主动同步的内容回应。`
      );
    }
  );

  server.registerTool("save_quote", toolConfigs.save_quote, async (input) => {
    const quote = await service.saveQuote(input);
    return toolResult({ saved: true, quote }, "摘录已经放进小窝。");
  });

  server.registerTool("update_quote_note", toolConfigs.update_quote_note, async (input) => {
    const quote = await service.updateQuoteNote(input);
    return toolResult({ saved: true, quote }, "划线旁边的想法已经改好。");
  });

  server.registerTool("delete_quote", toolConfigs.delete_quote, async (input) => {
    const deleted = await service.deleteQuote(input);
    return toolResult({ deleted: true, ...deleted }, "这条书内记录已经删除。");
  });

  server.registerTool(
    "delete_book_archive_entry",
    toolConfigs.delete_book_archive_entry,
    async (input) => {
      if (input.source === "reaction" || input.source === "bookmark") {
        const deleted = await service.deleteArchiveRecord({
          sessionId: input.sessionId,
          source: input.source,
          recordId: input.recordId
        });
        return toolResult({ deleted: true, ...deleted }, "这条书内记录已经删除。");
      }
      if (!cloudSourceService) {
        throw new Error("Cloud source storage is unavailable.");
      }
      const bundle = await service.getSessionBundle(input.sessionId);
      const readingState = bundle.session.sourceManifest?.readingState;
      if (!readingState) throw new Error("Reading state is unavailable.");
      const nextState = structuredClone(readingState);
      if (input.source === "checkpoint") {
        if (nextState.checkpoint?.updatedAt !== input.recordId) {
          throw new Error("Reading checkpoint was not found.");
        }
        nextState.checkpoint = null;
      } else {
        const annotations = nextState.annotations ?? [];
        const annotation = annotations.find((item) => item.createdAt === input.recordId);
        if (!annotation) throw new Error("Reading annotation was not found.");
        if (input.source === "annotation-comment") delete annotation.comment;
        else delete annotation.assistantSummary;
        nextState.annotations = annotations.filter(
          (item) => Boolean(item.comment?.trim() || item.assistantSummary?.trim())
        );
      }
      const result = await cloudSourceService.updateNovelReadingState({
        sessionId: input.sessionId,
        readingState: nextState
      });
      return toolResult(
        { deleted: true, source: input.source, recordId: input.recordId, session: result.session },
        "这条书内记录已经删除。"
      );
    }
  );

  server.registerTool("save_reaction", toolConfigs.save_reaction, async (input) => {
    const reaction = await service.saveReaction(input);
    return toolResult({ saved: true, reaction }, "吐槽已经记下。");
  });

  server.registerTool("save_bookmark", toolConfigs.save_bookmark, async (input) => {
    const bookmark = await service.saveBookmark(input);
    return toolResult({ saved: true, bookmark }, "书签已经夹好。");
  });

  server.registerTool(
    "finish_today_reading",
    toolConfigs.finish_today_reading,
    async (input) => {
      const result = await service.finishToday(input);
      return toolResult(
        { ...result, message: `今天看到${input.position.label}，下次继续。` },
        `今天看到${input.position.label}，下次继续。`
      );
    }
  );

  server.registerTool(
    "save_reading_record",
    toolConfigs.save_reading_record,
    async (input) => {
      const record = await service.saveReadingRecord(input);
      return toolResult(
        { saved: true, record },
        `阅读记录已保存：${record.bookTitle}，${record.startPosition.label}到${record.endPosition.label}。`
      );
    }
  );

  server.registerTool(
    "complete_reading_session",
    toolConfigs.complete_reading_session,
    async ({ sessionId, finalPosition }) => {
      const session = await service.completeSession(sessionId, finalPosition);
      return toolResult({ session, message: `《${session.title}》已经标记为完成。` }, "作品已完成。");
    }
  );

  server.registerTool(
    "generate_diary_context",
    toolConfigs.generate_diary_context,
    async ({ sessionId }) => {
      const diaryContext = await service.diaryContext(sessionId);
      return toolResult(
        { diaryContext },
        "日记素材已经整理好。请在聊天里把这些素材写成一篇可复制的小窝日记。"
      );
    }
  );
}

function summarizeCloudSourceManifest(sourceManifest: SourceManifest) {
  return {
    sourceId: sourceManifest.sourceId,
    contentHash: sourceManifest.contentHash,
    ...(sourceManifest.paragraphCount !== undefined
      ? { paragraphCount: sourceManifest.paragraphCount }
      : {}),
    cloudSync: {
      enabled: sourceManifest.cloudSync.enabled,
      provider: sourceManifest.cloudSync.provider,
      ...(sourceManifest.cloudSync.sizeBytes !== undefined
        ? { sizeBytes: sourceManifest.cloudSync.sizeBytes }
        : {}),
      ...(sourceManifest.cloudSync.mimeType
        ? { mimeType: sourceManifest.cloudSync.mimeType }
        : {})
    }
  };
}

function summarizeNovelBookshelfForModel(
  bookshelfSessions: Array<Awaited<ReturnType<ReadingService["getSessionBundle"]>> & {
    cacheState: "unknown";
  }>
) {
  return {
    bookshelf: bookshelfSessions.slice(0, 10).map(({ session }) => ({
      id: session.id,
      title: session.title,
      type: session.type,
      status: session.status,
      currentPosition: session.userCurrentPosition.label,
      currentPositionIndex: session.userCurrentPosition.index,
      ...(session.userCurrentPosition.total !== undefined
        ? { currentPositionTotal: session.userCurrentPosition.total }
        : {}),
      lastReadAt: session.lastReadAt,
      updatedAt: session.updatedAt
    })),
    count: bookshelfSessions.length,
    privacy: "Private drafts and saved annotations are available only inside the reading component."
  };
}


export function buildCurrentReadingContext(
  session: ReadingSession,
  input: SendCurrentContextInput
) {
  const currentPosition = input.currentPosition ?? input.position!;
  const liveReading = input.mode === "live_reading";
  return {
    sessionId: session.id,
    title: session.title,
    type: session.type,
    previousSyncedPosition:
      input.previousSyncedPosition ?? session.assistantSyncedPosition,
    currentPosition,
    ...(input.contextRange ? { contextRange: input.contextRange } : {}),
    ...(input.includedText ? { includedText: input.includedText } : {}),
    ...(input.currentText ? { currentText: input.currentText } : {}),
    ...(input.selectedText ? { selectedText: input.selectedText } : {}),
    ...(input.userNote ? { userNote: input.userNote } : {}),
    ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
    mode: input.mode,
    readingCommentMode: liveReading
      ? "reaction_only"
      : input.readingCommentMode ?? session.sessionPreferences.readingCommentMode,
    commentLength: liveReading
      ? "short"
      : input.commentLength ?? session.sessionPreferences.commentLength,
    ...(input.batch ? { batch: input.batch } : {}),
    syncMode: "text"
  };
}

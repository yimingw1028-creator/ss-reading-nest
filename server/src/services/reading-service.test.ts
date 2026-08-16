import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JsonReadingRepository } from "../repositories/json-reading-repository.js";
import { ReadingService } from "./reading-service.js";

describe("ReadingService", () => {
  let service: ReadingService;
  let repository: JsonReadingRepository;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-reading-"));
    repository = new JsonReadingRepository(join(dir, "sessions.json"));
    service = new ReadingService(repository, {
      now: () => new Date("2026-06-22T10:00:00.000Z"),
      id: vi.fn()
        .mockReturnValueOnce("session-1")
        .mockReturnValueOnce("quote-1")
        .mockReturnValueOnce("bookmark-1")
    });
  });

  it("creates sessions with complete v3 repository defaults", async () => {
    const session = await service.startSession("雨夜里的信", "novel");

    expect(session.sessionPreferences).toEqual({
      readingCommentMode: "light_chat",
      commentLength: "normal",
      allowDeepAnalysisByDefault: false,
      liveReadingStyle: "danmaku"
    });
    expect(session.sourceManifest).toBeNull();
  });

  it("lists every session for the bookshelf with active sessions first", async () => {
    let id = 0;
    const bookshelfService = new ReadingService(repository, {
      now: () => new Date(Date.UTC(2026, 5, 1 + id, 10)),
      id: () => `bookshelf-${++id}`
    });
    const sessions = [];
    for (let index = 0; index < 24; index += 1) {
      sessions.push(await bookshelfService.startSession(`书 ${index + 1}`, "novel"));
    }
    for (const session of sessions.slice(20)) {
      await bookshelfService.completeSession(session.id);
    }

    const bookshelf = await bookshelfService.listAllSessions();

    expect(bookshelf).toHaveLength(24);
    expect(bookshelf.slice(0, 20).every((session) => session.status === "active")).toBe(true);
    expect(bookshelf.slice(20).every((session) => session.status === "completed")).toBe(true);
  });

  it("builds a many-book shelf from one repository snapshot", async () => {
    let id = 0;
    const bookshelfService = new ReadingService(repository, {
      now: () => new Date(Date.UTC(2026, 5, 1 + id, 10)),
      id: () => `snapshot-${++id}`
    });
    for (let index = 0; index < 24; index += 1) {
      await bookshelfService.startSession(`书 ${index + 1}`, "novel");
    }
    const read = vi.spyOn(repository, "read");

    const snapshot = await bookshelfService.getBookshelfSnapshot();

    expect(read).toHaveBeenCalledTimes(1);
    expect(snapshot.sessionBundles).toHaveLength(24);
    expect(snapshot.readingRecords).toEqual([]);
  });

  it("optionally deletes the private cloud source and exposes partial failure metadata", async () => {
    const cloudSource = {
      deleteCloudSource: vi.fn().mockResolvedValue({
        deleted: false,
        cloudSourceDeleted: false,
        cloudSourceDeleteError: "manifest delete failed"
      })
    };
    const deleteService = new ReadingService(
      repository,
      {
        now: () => new Date("2026-06-22T10:00:00.000Z"),
        id: vi.fn().mockReturnValueOnce("delete-cloud-session")
      },
      cloudSource
    );
    const session = await deleteService.startSession("云端书", "novel");

    const result = await deleteService.deleteSession(session.id, "delete-cloud", {
      deleteCloudSource: true
    });

    expect(cloudSource.deleteCloudSource).toHaveBeenCalledWith(session.id);
    expect(result).toEqual({
      sessionId: session.id,
      deleted: true,
      cloudSourceDeleted: false,
      cloudSourceDeleteError: "manifest delete failed"
    });
    expect((await deleteService.listAllSessions()).some((item) => item.id === session.id)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/sourceText|data:image|publicUrl|signedUrl/);
  });

  it("deduplicates quote writes by operationId", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    const input = {
      sessionId: session.id,
      content: "她把信折好。",
      position: { kind: "paragraph" as const, index: 2, label: "第 2 段" },
      operationId: "op-quote"
    };

    const first = await service.saveQuote(input);
    const second = await service.saveQuote(input);
    const bundle = await service.getSessionBundle(session.id);

    expect(second.id).toBe(first.id);
    expect(bundle.quotes).toHaveLength(1);
  });

  it("stores clear thinking separately from the original thought", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    const quote = await service.saveQuote({
      sessionId: session.id,
      content: "她把信折好。",
      note: "这是刚划线时的意绪",
      position: { kind: "paragraph", index: 2, label: "第 2 段" }
    });

    const updated = await service.updateQuoteNote({
      sessionId: session.id,
      quoteId: quote.id,
      clearThought: "聊完之后，我更清楚这里是在写告别。"
    });

    expect(updated.note).toBe("这是刚划线时的意绪");
    expect(updated.clearThought).toBe("聊完之后，我更清楚这里是在写告别。");
  });

  it("deletes one saved quote without touching the rest of the book", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    const first = await service.saveQuote({
      sessionId: session.id,
      content: "个",
      note: "误触保存",
      position: { kind: "paragraph", index: 2, label: "第 2 页" }
    });
    await service.saveQuote({
      sessionId: session.id,
      content: "她把信折好。",
      note: "保留这一条",
      position: { kind: "paragraph", index: 2, label: "第 2 页" }
    });

    await service.deleteQuote({ sessionId: session.id, quoteId: first.id });
    const bundle = await service.getSessionBundle(session.id);

    expect(bundle.quotes).toHaveLength(1);
    expect(bundle.quotes[0]?.content).toBe("她把信折好。");
  });

  it("deletes reaction and bookmark archive records independently", async () => {
    let id = 0;
    const archiveService = new ReadingService(repository, {
      now: () => new Date("2026-06-22T10:00:00.000Z"),
      id: () => `archive-${++id}`
    });
    const session = await archiveService.startSession("雨夜里的信", "novel");
    const reaction = await archiveService.saveReaction({
      sessionId: session.id,
      content: "这一句很有感觉",
      position: { kind: "paragraph", index: 2, label: "第 2 页" },
      speaker: "user"
    });
    const bookmark = await archiveService.saveBookmark({
      sessionId: session.id,
      position: { kind: "paragraph", index: 3, label: "第 3 页" },
      label: "第三页阶段纪要"
    });

    await archiveService.deleteArchiveRecord({
      sessionId: session.id,
      source: "reaction",
      recordId: reaction.id
    });
    await archiveService.deleteArchiveRecord({
      sessionId: session.id,
      source: "bookmark",
      recordId: bookmark.id
    });

    const bundle = await archiveService.getSessionBundle(session.id);
    expect(bundle.reactions).toEqual([]);
    expect(bundle.bookmarks).toEqual([]);
  });

  it("keeps assistant replies and later revisions as separate book records", async () => {
    let id = 0;
    const discussionService = new ReadingService(repository, {
      now: () => new Date("2026-06-22T10:00:00.000Z"),
      id: () => `discussion-${++id}`
    });
    const session = await discussionService.startSession("雨夜里的信", "novel");
    const quote = await discussionService.saveQuote({
      sessionId: session.id,
      content: "她把信折好。",
      note: "我觉得她已经决定告别。",
      position: { kind: "paragraph", index: 2, label: "第 2 段" }
    });
    const first = await discussionService.saveSharedReadingReply({
      sessionId: session.id,
      quoteId: quote.id,
      content: "我更倾向于把折信理解成暂时收起。",
      operationId: "reply-once"
    });
    const duplicate = await discussionService.saveSharedReadingReply({
      sessionId: session.id,
      quoteId: quote.id,
      content: "这一条不应重复写入。",
      operationId: "reply-once"
    });
    const revision = await discussionService.saveSharedReadingReply({
      sessionId: session.id,
      revisesId: first.id,
      content: "读到后文后，我改成认为这是一次有意的告别。"
    });

    const bundle = await discussionService.getSessionBundle(session.id);
    expect(duplicate.id).toBe(first.id);
    expect(bundle.reactions).toHaveLength(2);
    expect(bundle.reactions[0]).toMatchObject({
      speaker: "assistant",
      quoteId: quote.id,
      content: "我更倾向于把折信理解成暂时收起。"
    });
    expect(revision).toMatchObject({
      speaker: "assistant",
      quoteId: quote.id,
      revisesId: first.id
    });
  });

  it("does not let an assistant revision claim a user-authored reaction", async () => {
    let id = 0;
    const discussionService = new ReadingService(repository, {
      now: () => new Date("2026-06-22T10:00:00.000Z"),
      id: () => `ownership-${++id}`
    });
    const session = await discussionService.startSession("雨夜里的信", "novel");
    const userReaction = await discussionService.saveReaction({
      sessionId: session.id,
      content: "我觉得这一页是在告别。",
      position: { kind: "paragraph", index: 2, label: "第 2 页" },
      speaker: "user"
    });

    await expect(
      discussionService.saveSharedReadingReply({
        sessionId: session.id,
        revisesId: userReaction.id,
        content: "把这条改成另一种判断。"
      })
    ).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });

  it("keeps user and assistant positions separate", async () => {
    const session = await service.startSession("雨夜里的信", "novel");

    expect(session.userCurrentPosition.index).toBe(1);
    expect(session.assistantSyncedPosition).toBeNull();
    expect(session.liveReadingEnabled).toBe(false);

    await service.updateUserPosition(session.id, {
      kind: "paragraph",
      index: 12,
      label: "第 12 段"
    });
    const afterUserMove = await service.getSessionBundle(session.id);

    expect(afterUserMove.session.userCurrentPosition.index).toBe(12);
    expect(afterUserMove.session.assistantSyncedPosition).toBeNull();
  });

  it("persists source manifest without changing session or related records", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    await service.updateUserPosition(session.id, {
      kind: "paragraph",
      index: 12,
      label: "第 12 段"
    });
    await service.saveQuote({
      sessionId: session.id,
      content: "摘录",
      position: { kind: "paragraph", index: 2, label: "第 2 段" }
    });
    await service.saveReaction({
      sessionId: session.id,
      content: "反应",
      position: { kind: "paragraph", index: 3, label: "第 3 段" },
      speaker: "user"
    });
    await service.saveBookmark({
      sessionId: session.id,
      position: { kind: "paragraph", index: 4, label: "第 4 段" }
    });
    const before = await service.getSessionBundle(session.id);
    const manifest = {
      sourceId: "source-1",
      sourceKind: "pasted_text" as const,
      contentHash: "a".repeat(64),
      segmentationVersion: 1,
      paragraphCount: 12
    };

    const updated = await service.setSourceManifest(session.id, manifest);
    const after = await service.getSessionBundle(session.id);

    expect(updated.sourceManifest).toEqual(manifest);
    expect(updated.userCurrentPosition).toEqual(before.session.userCurrentPosition);
    expect(updated.assistantSyncedPosition).toEqual(before.session.assistantSyncedPosition);
    expect(updated.sessionPreferences).toEqual(before.session.sessionPreferences);
    expect(after.quotes).toEqual(before.quotes);
    expect(after.reactions).toEqual(before.reactions);
    expect(after.bookmarks).toEqual(before.bookmarks);
  });

  it("advances assistant position only through explicit idempotent confirmation", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    await service.updateUserPosition(session.id, {
      kind: "paragraph",
      index: 12,
      label: "第 12 段"
    });
    const input = {
      sessionId: session.id,
      confirmedPosition: { kind: "paragraph" as const, index: 8, label: "第 8 段" },
      batchId: "batch-1",
      operationId: "confirm-1"
    };

    const first = await service.confirmAssistantPosition(input);
    const second = await service.confirmAssistantPosition(input);

    expect(first.assistantSyncedPosition?.index).toBe(8);
    expect(second.assistantSyncedPosition?.index).toBe(8);
    expect(second.lastAssistantConfirmation?.operationId).toBe("confirm-1");
  });

  it("rejects confirmations beyond the user or behind the confirmed position", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    await service.updateUserPosition(session.id, {
      kind: "paragraph",
      index: 12,
      label: "第 12 段"
    });
    await expect(
      service.confirmAssistantPosition({
        sessionId: session.id,
        confirmedPosition: { kind: "paragraph", index: 13, label: "第 13 段" },
        batchId: "too-far",
        operationId: "confirm-too-far"
      })
    ).rejects.toMatchObject({ code: "INVALID_OPERATION" });

    await service.confirmAssistantPosition({
      sessionId: session.id,
      confirmedPosition: { kind: "paragraph", index: 8, label: "第 8 段" },
      batchId: "batch-1",
      operationId: "confirm-1"
    });
    await expect(
      service.confirmAssistantPosition({
        sessionId: session.id,
        confirmedPosition: { kind: "paragraph", index: 7, label: "第 7 段" },
        batchId: "backwards",
        operationId: "confirm-backwards"
      })
    ).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });

  it("persists live-reading preference without changing assistant position", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    const updated = await service.setLiveReadingMode(session.id, true);

    expect(updated.liveReadingEnabled).toBe(true);
    expect(updated.assistantSyncedPosition).toBeNull();
  });

  it("partially updates one session preference without changing reading data", async () => {
    const first = await service.startSession("第一本", "novel");
    const second = await service.startSession("第二本", "novel");
    await service.updateUserPosition(first.id, {
      kind: "paragraph",
      index: 12,
      label: "第 12 段"
    });
    await service.setSourceManifest(first.id, {
      sourceId: "source-1",
      sourceKind: "pasted_text",
      contentHash: "a".repeat(64),
      segmentationVersion: 1,
      paragraphCount: 12
    });
    const before = await service.getSessionBundle(first.id);

    const updated = await service.updateSessionPreferences(first.id, {
      readingCommentMode: "cp_talk",
      autoSaveCompanionComments: false
    });
    const firstAfter = await service.getSessionBundle(first.id);
    const secondAfter = await service.getSessionBundle(second.id);

    expect(updated.sessionPreferences).toEqual({
      readingCommentMode: "cp_talk",
      commentLength: "normal",
      allowDeepAnalysisByDefault: false,
      liveReadingStyle: "danmaku",
      autoSaveCompanionComments: false
    });
    expect(firstAfter.session.userCurrentPosition).toEqual(
      before.session.userCurrentPosition
    );
    expect(firstAfter.session.assistantSyncedPosition).toEqual(
      before.session.assistantSyncedPosition
    );
    expect(firstAfter.session.sourceManifest).toEqual(before.session.sourceManifest);
    expect(firstAfter.session.status).toBe(before.session.status);
    expect(secondAfter.session.sessionPreferences).toEqual(
      second.sessionPreferences
    );
  });

  it("keeps an empty or repeated preference patch idempotent", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    const first = await service.updateSessionPreferences(session.id, {
      commentLength: "short",
      liveReadingStyle: "danmaku"
    });
    const repeated = await service.updateSessionPreferences(session.id, {
      commentLength: "short",
      liveReadingStyle: "danmaku"
    });
    const empty = await service.updateSessionPreferences(session.id, {});

    expect(repeated.updatedAt).toBe(first.updatedAt);
    expect(empty.updatedAt).toBe(first.updatedAt);
    expect(empty.sessionPreferences).toEqual(first.sessionPreferences);
  });

  it("finishes today without completing the work and creates one dated bookmark", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    const input = {
      sessionId: session.id,
      position: { kind: "paragraph" as const, index: 8, label: "第 8 段" },
      createBookmark: true,
      operationId: "op-finish"
    };

    await service.finishToday(input);
    await service.finishToday(input);
    const bundle = await service.getSessionBundle(session.id);

    expect(bundle.session.status).toBe("active");
    expect(bundle.session.userCurrentPosition.index).toBe(8);
    expect(bundle.session.assistantSyncedPosition).toBeNull();
    expect(bundle.bookmarks).toHaveLength(1);
    expect(bundle.bookmarks[0]?.label).toBe("今天看到这里 · 2026-06-22");
  });

  it("records real reading sessions idempotently", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    const input = {
      sessionId: session.id,
      startedAt: "2026-06-22T09:40:00.000Z",
      endedAt: "2026-06-22T10:00:00.000Z",
      startPosition: { kind: "paragraph" as const, index: 2, total: 12, label: "第 2 页" },
      endPosition: { kind: "paragraph" as const, index: 5, total: 12, label: "第 5 页" },
      pagesRead: 4,
      operationId: "record-op-1"
    };

    const first = await service.saveReadingRecord(input);
    const second = await service.saveReadingRecord(input);
    const records = await service.listReadingRecords();
    const bundle = await service.getSessionBundle(session.id);

    expect(second.id).toBe(first.id);
    expect(records).toHaveLength(1);
    expect(first).toMatchObject({
      sessionId: session.id,
      bookTitle: "雨夜里的信",
      durationSeconds: 20 * 60,
      pagesRead: 4,
      startPosition: { index: 2 },
      endPosition: { index: 5 }
    });
    expect(bundle.session.userCurrentPosition.index).toBe(5);
    expect(bundle.session.lastReadAt).toBe(input.endedAt);
  });

  it("deletes reading records with their session", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    await service.saveReadingRecord({
      sessionId: session.id,
      startedAt: "2026-06-22T09:40:00.000Z",
      endedAt: "2026-06-22T10:00:00.000Z",
      startPosition: { kind: "paragraph", index: 1, label: "第 1 页" },
      endPosition: { kind: "paragraph", index: 3, label: "第 3 页" },
      pagesRead: 3,
      operationId: "record-op-delete"
    });

    await service.deleteSession(session.id, "delete-op");

    expect(await service.listReadingRecords()).toEqual([]);
  });

  it("only completes the work through completeSession", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    const completed = await service.completeSession(session.id);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe("2026-06-22T10:00:00.000Z");
  });

  it("persists only structured sync metadata", async () => {
    const session = await service.startSession("雨夜里的信", "novel");
    await service.updateUserPosition(session.id, {
      kind: "paragraph",
      index: 8,
      label: "第 8 段"
    });
    await service.confirmAssistantPosition({
      sessionId: session.id,
      confirmedPosition: { kind: "paragraph", index: 3, label: "第 3 段" },
      batchId: "batch-1",
      operationId: "confirm-1"
    });
    const stored = JSON.stringify(await repository.read());

    expect(stored).not.toMatch(
      /includedText|currentText|selectedText|download_url|file_id|ChatGPT reply|OPENAI_API_KEY|token/
    );
  });
});

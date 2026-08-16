import { randomUUID } from "node:crypto";
import { DEFAULT_SESSION_PREFERENCES } from "@ss/shared";
import type {
  Bookmark,
  Quote,
  Reaction,
  ReadingPosition,
  ReadingRecord,
  ReadingSession,
  SaveReadingRecordInput,
  SessionBundle,
  SessionPreferences,
  SourceManifest
} from "@ss/shared";
import { AppError } from "../errors/app-error.js";
import type { ReadingRepository } from "../repositories/reading-repository.js";

type Dependencies = {
  now: () => Date;
  id: () => string;
};

type CloudSourceDeletionService = {
  deleteCloudSource(sessionId: string): Promise<{
    deleted: boolean;
    cloudSourceDeleted: boolean;
    cloudSourceDeleteError?: string;
  }>;
};

const defaultDependencies: Dependencies = {
  now: () => new Date(),
  id: () => randomUUID()
};

export class ReadingService {
  constructor(
    private readonly repository: ReadingRepository,
    private readonly deps: Dependencies = defaultDependencies,
    private readonly cloudSourceService?: CloudSourceDeletionService
  ) {}

  async startSession(title: string, type: "novel" = "novel"): Promise<ReadingSession> {
    return this.repository.mutate((database) => {
      const now = this.deps.now().toISOString();
      const session: ReadingSession = {
        id: this.deps.id(),
        title,
        type,
        status: "active",
        userCurrentPosition: {
          kind: "paragraph",
          index: 1,
          label: "第 1 段"
        },
        assistantSyncedPosition: null,
        liveReadingEnabled: false,
        sessionPreferences: structuredClone(DEFAULT_SESSION_PREFERENCES),
        sourceManifest: null,
        createdAt: now,
        updatedAt: now,
        lastReadAt: now
      };
      database.sessions.push(session);
      return session;
    });
  }

  async listRecent(limit = 10): Promise<ReadingSession[]> {
    const database = await this.repository.read();
    return [...database.sessions]
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, Math.min(10, Math.max(5, limit)));
  }

  async listAllSessions(): Promise<ReadingSession[]> {
    const database = await this.repository.read();
    return [...database.sessions].sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      const left = a.lastReadAt || a.updatedAt;
      const right = b.lastReadAt || b.updatedAt;
      return right.localeCompare(left);
    });
  }

  async listReadingRecords(limit = 100): Promise<ReadingRecord[]> {
    const database = await this.repository.read();
    return [...database.readingRecords]
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
      .slice(0, Math.min(200, Math.max(1, limit)));
  }

  async getBookshelfSnapshot(includeReadingRecords = true): Promise<{
    sessionBundles: SessionBundle[];
    readingRecords: ReadingRecord[];
  }> {
    const database = await this.repository.read();
    const sessions = [...database.sessions].sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      const left = a.lastReadAt || a.updatedAt;
      const right = b.lastReadAt || b.updatedAt;
      return right.localeCompare(left);
    });
    return {
      sessionBundles: sessions.map((session) => ({
        session,
        quotes: database.quotes.filter((quote) => quote.sessionId === session.id),
        reactions: database.reactions.filter((reaction) => reaction.sessionId === session.id),
        bookmarks: database.bookmarks.filter((bookmark) => bookmark.sessionId === session.id)
      })),
      readingRecords: includeReadingRecords
        ? [...database.readingRecords]
            .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
            .slice(0, 120)
        : []
    };
  }

  async getSessionBundle(sessionId: string): Promise<SessionBundle> {
    const database = await this.repository.read();
    const session = this.requireSession(database.sessions, sessionId);
    return {
      session,
      quotes: database.quotes.filter((quote) => quote.sessionId === sessionId),
      reactions: database.reactions.filter((reaction) => reaction.sessionId === sessionId),
      bookmarks: database.bookmarks.filter((bookmark) => bookmark.sessionId === sessionId)
    };
  }

  async updateUserPosition(
    sessionId: string,
    userCurrentPosition: ReadingPosition
  ): Promise<ReadingSession> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, sessionId);
      session.userCurrentPosition = userCurrentPosition;
      session.updatedAt = this.deps.now().toISOString();
      return session;
    });
  }

  async confirmAssistantPosition(input: {
    sessionId: string;
    confirmedPosition: ReadingPosition;
    batchId: string;
    operationId: string;
  }): Promise<ReadingSession> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, input.sessionId);
      if (session.lastAssistantConfirmation?.operationId === input.operationId) return session;
      if (input.confirmedPosition.kind !== session.userCurrentPosition.kind) {
        throw new AppError("INVALID_OPERATION", "确认位置类型与当前阅读位置不一致。");
      }
      if (input.confirmedPosition.index > session.userCurrentPosition.index) {
        throw new AppError("INVALID_OPERATION", "不能确认星星读到了用户尚未读到的位置。");
      }
      if (
        session.assistantSyncedPosition &&
        input.confirmedPosition.index < session.assistantSyncedPosition.index
      ) {
        throw new AppError("INVALID_OPERATION", "星星确认位置不能倒退。");
      }
      const now = this.deps.now().toISOString();
      session.assistantSyncedPosition = input.confirmedPosition;
      session.lastAssistantConfirmation = {
        operationId: input.operationId,
        batchId: input.batchId,
        confirmedAt: now
      };
      session.updatedAt = now;
      return session;
    });
  }

  async setLiveReadingMode(sessionId: string, enabled: boolean): Promise<ReadingSession> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, sessionId);
      session.liveReadingEnabled = enabled;
      session.updatedAt = this.deps.now().toISOString();
      return session;
    });
  }

  async setSourceManifest(
    sessionId: string,
    sourceManifest: SourceManifest
  ): Promise<ReadingSession> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, sessionId);
      session.sourceManifest = structuredClone(sourceManifest);
      session.updatedAt = this.deps.now().toISOString();
      return session;
    });
  }

  async updateSessionPreferences(
    sessionId: string,
    patch: Partial<
      Pick<
        SessionPreferences,
        | "readingCommentMode"
        | "commentLength"
        | "liveReadingStyle"
      >
    >
  ): Promise<ReadingSession> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, sessionId);
      const nextPreferences = { ...session.sessionPreferences, ...patch };
      if (
        nextPreferences.readingCommentMode ===
          session.sessionPreferences.readingCommentMode &&
        nextPreferences.commentLength === session.sessionPreferences.commentLength &&
        nextPreferences.liveReadingStyle ===
          session.sessionPreferences.liveReadingStyle
      ) {
        return session;
      }
      session.sessionPreferences = nextPreferences;
      session.updatedAt = this.deps.now().toISOString();
      return session;
    });
  }

  async saveQuote(input: {
    sessionId: string;
    content: string;
    position: ReadingPosition;
    note?: string;
    clearThought?: string;
    operationId?: string;
  }): Promise<Quote> {
    return this.repository.mutate((database) => {
      this.requireSession(database.sessions, input.sessionId);
      const existing = input.operationId
        ? database.quotes.find((item) => item.operationId === input.operationId)
        : undefined;
      if (existing) return existing;
      const quote: Quote = {
        id: this.deps.id(),
        sessionId: input.sessionId,
        content: input.content,
        position: input.position,
        ...(input.note ? { note: input.note } : {}),
        ...(input.clearThought ? { clearThought: input.clearThought } : {}),
        ...(input.operationId ? { operationId: input.operationId } : {}),
        createdAt: this.deps.now().toISOString()
      };
      database.quotes.push(quote);
      return quote;
    });
  }

  async updateQuoteNote(input: {
    sessionId: string;
    quoteId: string;
    note?: string;
    clearThought?: string;
  }): Promise<Quote> {
    return this.repository.mutate((database) => {
      this.requireSession(database.sessions, input.sessionId);
      const quote = database.quotes.find(
        (item) => item.id === input.quoteId && item.sessionId === input.sessionId
      );
      if (!quote) throw new AppError("INVALID_OPERATION", "没有找到要修改的划线想法。");
      if (input.note !== undefined) quote.note = input.note;
      if (input.clearThought !== undefined) {
        const clearThought = input.clearThought.trim();
        if (clearThought) quote.clearThought = clearThought;
        else delete quote.clearThought;
      }
      return quote;
    });
  }

  async deleteQuote(input: { sessionId: string; quoteId: string }): Promise<{ quoteId: string }> {
    return this.repository.mutate((database) => {
      this.requireSession(database.sessions, input.sessionId);
      const exists = database.quotes.some(
        (item) => item.id === input.quoteId && item.sessionId === input.sessionId
      );
      if (!exists) throw new AppError("INVALID_OPERATION", "没有找到要删除的划线想法。");
      database.quotes = database.quotes.filter(
        (item) => !(item.id === input.quoteId && item.sessionId === input.sessionId)
      );
      return { quoteId: input.quoteId };
    });
  }

  async deleteArchiveRecord(input: {
    sessionId: string;
    source: "reaction" | "bookmark";
    recordId: string;
  }): Promise<{ source: "reaction" | "bookmark"; recordId: string }> {
    return this.repository.mutate((database) => {
      this.requireSession(database.sessions, input.sessionId);
      const collection = input.source === "reaction" ? database.reactions : database.bookmarks;
      const exists = collection.some(
        (item) => item.id === input.recordId && item.sessionId === input.sessionId
      );
      if (!exists) throw new AppError("INVALID_OPERATION", "没有找到要删除的书内记录。");
      if (input.source === "reaction") {
        database.reactions = database.reactions.filter(
          (item) => !(item.id === input.recordId && item.sessionId === input.sessionId)
        );
      } else {
        database.bookmarks = database.bookmarks.filter(
          (item) => !(item.id === input.recordId && item.sessionId === input.sessionId)
        );
      }
      return { source: input.source, recordId: input.recordId };
    });
  }

  async saveReaction(input: {
    sessionId: string;
    content: string;
    position: ReadingPosition;
    speaker: "user";
    operationId?: string;
  }): Promise<Reaction> {
    return this.repository.mutate((database) => {
      this.requireSession(database.sessions, input.sessionId);
      const existing = input.operationId
        ? database.reactions.find((item) => item.operationId === input.operationId)
        : undefined;
      if (existing) return existing;
      const reaction: Reaction = {
        id: this.deps.id(),
        sessionId: input.sessionId,
        content: input.content,
        position: input.position,
        speaker: "user",
        ...(input.operationId ? { operationId: input.operationId } : {}),
        createdAt: this.deps.now().toISOString()
      };
      database.reactions.push(reaction);
      return reaction;
    });
  }

  async saveSharedReadingReply(input: {
    sessionId: string;
    content: string;
    positionIndex?: number;
    quoteId?: string;
    replyToId?: string;
    revisesId?: string;
    operationId?: string;
  }): Promise<Reaction> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, input.sessionId);
      const existing = input.operationId
        ? database.reactions.find((item) => item.operationId === input.operationId)
        : undefined;
      if (existing) return existing;

      const quote = input.quoteId
        ? database.quotes.find(
            (item) => item.id === input.quoteId && item.sessionId === input.sessionId
          )
        : undefined;
      if (input.quoteId && !quote) {
        throw new AppError("INVALID_OPERATION", "没有找到这条共读划线。");
      }

      const referencedEntryId = input.revisesId ?? input.replyToId;
      const referencedEntry = referencedEntryId
        ? database.reactions.find(
            (item) => item.id === referencedEntryId && item.sessionId === input.sessionId
          )
        : undefined;
      if (referencedEntryId && !referencedEntry) {
        throw new AppError("INVALID_OPERATION", "没有找到要回应或修订的共读记录。");
      }
      if (input.revisesId && referencedEntry?.speaker !== "assistant") {
        throw new AppError("INVALID_OPERATION", "只能修订陆沉自己留下的共读回应。");
      }
      if (
        quote &&
        referencedEntry?.quoteId &&
        referencedEntry.quoteId !== quote.id
      ) {
        throw new AppError("INVALID_OPERATION", "共读回应与划线位置不一致。");
      }

      const position = quote?.position ?? referencedEntry?.position ?? {
        ...session.userCurrentPosition,
        index: input.positionIndex ?? session.userCurrentPosition.index,
        label: `第 ${input.positionIndex ?? session.userCurrentPosition.index} 段`
      };
      const reaction: Reaction = {
        id: this.deps.id(),
        sessionId: input.sessionId,
        content: input.content.trim(),
        position: structuredClone(position),
        speaker: "assistant",
        ...(quote?.id || referencedEntry?.quoteId
          ? { quoteId: quote?.id ?? referencedEntry?.quoteId }
          : {}),
        ...(input.replyToId ? { replyToId: input.replyToId } : {}),
        ...(input.revisesId ? { revisesId: input.revisesId } : {}),
        ...(input.operationId ? { operationId: input.operationId } : {}),
        createdAt: this.deps.now().toISOString()
      };
      database.reactions.push(reaction);
      return reaction;
    });
  }

  async saveBookmark(input: {
    sessionId: string;
    position: ReadingPosition;
    label?: string;
    operationId?: string;
  }): Promise<Bookmark> {
    return this.repository.mutate((database) => {
      this.requireSession(database.sessions, input.sessionId);
      const existing = input.operationId
        ? database.bookmarks.find((item) => item.operationId === input.operationId)
        : undefined;
      if (existing) return existing;
      const bookmark = this.createBookmark(
        input.sessionId,
        input.position,
        input.label,
        input.operationId
      );
      database.bookmarks.push(bookmark);
      return bookmark;
    });
  }

  async finishToday(input: {
    sessionId: string;
    position: ReadingPosition;
    createBookmark?: boolean;
    operationId?: string;
  }): Promise<{ session: ReadingSession; bookmark?: Bookmark }> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, input.sessionId);
      const existingBookmark = input.operationId
        ? database.bookmarks.find((item) => item.operationId === input.operationId)
        : undefined;
      if (existingBookmark) return { session, bookmark: existingBookmark };

      const now = this.deps.now();
      const iso = now.toISOString();
      session.userCurrentPosition = input.position;
      session.updatedAt = iso;
      session.lastReadAt = iso;
      session.status = "active";
      delete session.completedAt;

      let bookmark: Bookmark | undefined;
      if (input.createBookmark !== false) {
        const date = iso.slice(0, 10);
        bookmark = this.createBookmark(
          input.sessionId,
          input.position,
          `今天看到这里 · ${date}`,
          input.operationId
        );
        database.bookmarks.push(bookmark);
      }
      return { session, ...(bookmark ? { bookmark } : {}) };
    });
  }

  async saveReadingRecord(input: SaveReadingRecordInput): Promise<ReadingRecord> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, input.sessionId);
      const existing = database.readingRecords.find(
        (item) => item.operationId === input.operationId
      );
      if (existing) return existing;

      const durationSeconds = durationSecondsBetween(input.startedAt, input.endedAt);
      const now = this.deps.now().toISOString();
      const record: ReadingRecord = {
        id: this.deps.id(),
        sessionId: input.sessionId,
        bookTitle: session.title,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationSeconds,
        startPosition: structuredClone(input.startPosition),
        endPosition: structuredClone(input.endPosition),
        pagesRead: Math.max(
          1,
          Math.trunc(
            input.pagesRead ??
              Math.abs(input.endPosition.index - input.startPosition.index) + 1
          )
        ),
        operationId: input.operationId,
        createdAt: now
      };
      database.readingRecords.push(record);
      session.userCurrentPosition = structuredClone(input.endPosition);
      session.updatedAt = now;
      session.lastReadAt = input.endedAt;
      return record;
    });
  }

  async completeSession(
    sessionId: string,
    finalPosition?: ReadingPosition
  ): Promise<ReadingSession> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, sessionId);
      const now = this.deps.now().toISOString();
      if (finalPosition) session.userCurrentPosition = finalPosition;
      session.status = "completed";
      session.updatedAt = now;
      session.lastReadAt = now;
      session.completedAt = now;
      return session;
    });
  }

  async renameSession(sessionId: string, title: string): Promise<ReadingSession> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, sessionId);
      session.title = title.trim();
      session.updatedAt = this.deps.now().toISOString();
      return session;
    });
  }

  async setSessionStatus(
    sessionId: string,
    status: "active" | "completed"
  ): Promise<ReadingSession> {
    return this.repository.mutate((database) => {
      const session = this.requireSession(database.sessions, sessionId);
      const now = this.deps.now().toISOString();
      session.status = status;
      session.updatedAt = now;
      if (status === "completed") {
        session.completedAt = session.completedAt ?? now;
      } else {
        delete session.completedAt;
      }
      return session;
    });
  }

  async deleteSession(
    sessionId: string,
    _operationId: string,
    options: { deleteCloudSource?: boolean } = {}
  ): Promise<{
    sessionId: string;
    deleted: boolean;
    cloudSourceDeleted: boolean;
    cloudSourceDeleteError?: string;
  }> {
    let cloudSourceDeleted = false;
    let cloudSourceDeleteError: string | undefined;
    if (options.deleteCloudSource && this.cloudSourceService) {
      try {
        const result = await this.cloudSourceService.deleteCloudSource(sessionId);
        cloudSourceDeleted = result.cloudSourceDeleted;
        cloudSourceDeleteError = result.cloudSourceDeleteError;
      } catch (error) {
        cloudSourceDeleteError = error instanceof Error ? error.message : String(error);
      }
    }
    return this.repository.mutate((database) => {
      const exists = database.sessions.some((session) => session.id === sessionId);
      if (!exists) {
        return {
          sessionId,
          deleted: false,
          cloudSourceDeleted: false,
          ...(cloudSourceDeleteError ? { cloudSourceDeleteError } : {})
        };
      }
      database.sessions = database.sessions.filter((session) => session.id !== sessionId);
      database.quotes = database.quotes.filter((item) => item.sessionId !== sessionId);
      database.reactions = database.reactions.filter((item) => item.sessionId !== sessionId);
      database.bookmarks = database.bookmarks.filter((item) => item.sessionId !== sessionId);
      database.readingRecords = database.readingRecords.filter(
        (item) => item.sessionId !== sessionId
      );
      return {
        sessionId,
        deleted: true,
        cloudSourceDeleted,
        ...(cloudSourceDeleteError ? { cloudSourceDeleteError } : {})
      };
    });
  }

  async diaryContext(sessionId: string) {
    const bundle = await this.getSessionBundle(sessionId);
    return {
      ...bundle,
      userCurrentPosition: bundle.session.userCurrentPosition,
      assistantSyncedPosition: bundle.session.assistantSyncedPosition,
      summaryHints: [
        `今天读到${bundle.session.userCurrentPosition.label}`,
        "从保存的摘录中选择最有余味的一句",
        "根据用户吐槽概括今天的情绪",
        "用最近书签作为下次共读的开场"
      ]
    };
  }

  private requireSession(sessions: ReadingSession[], sessionId: string): ReadingSession {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      throw new AppError("SESSION_NOT_FOUND", `找不到共读 session：${sessionId}`);
    }
    return session;
  }

  private createBookmark(
    sessionId: string,
    position: ReadingPosition,
    label?: string,
    operationId?: string
  ): Bookmark {
    return {
      id: this.deps.id(),
      sessionId,
      position,
      ...(label ? { label } : {}),
      ...(operationId ? { operationId } : {}),
      createdAt: this.deps.now().toISOString()
    };
  }
}

function durationSecondsBetween(startedAt: string, endedAt: string): number {
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    throw new AppError("INVALID_OPERATION", "阅读记录的开始和结束时间不正确。");
  }
  return Math.max(1, Math.round((ended - started) / 1000));
}

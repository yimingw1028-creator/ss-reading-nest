import { describe, expect, it } from "vitest";
import { D1ReadingRepository, type D1DatabaseLike } from "./d1-reading-repository.js";

class FakeD1 implements D1DatabaseLike {
  state: { version: number; data: string } | null = null;

  prepare(sql: string) {
    const db = this;
    let values: unknown[] = [];
    return {
      bind(...next: unknown[]) {
        values = next;
        return this;
      },
      async first<T>() {
        if (sql.startsWith("SELECT")) return db.state as T | null;
        return null;
      },
      async run() {
        if (sql.startsWith("INSERT")) {
          if (!db.state) db.state = { version: 1, data: String(values[0]) };
          return { success: true, meta: { changes: db.state ? 1 : 0 } };
        }
        if (sql.startsWith("UPDATE")) {
          const [data, nextVersion, expectedVersion] = values as [string, number, number];
          if (db.state?.version !== expectedVersion) {
            return { success: true, meta: { changes: 0 } };
          }
          db.state = { version: nextVersion, data };
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
    };
  }
}

describe("D1ReadingRepository", () => {
  it("initializes an empty versioned state", async () => {
    const db = new FakeD1();
    const repository = new D1ReadingRepository(db);

    const state = await repository.read();

    expect(state.schemaVersion).toBe(5);
    expect(state.sessions).toEqual([]);
    expect(db.state?.version).toBe(1);
  });

  it("migrates and persists a v1 state on read", async () => {
    const db = new FakeD1();
    db.state = {
      version: 7,
      data: JSON.stringify({
        schemaVersion: 1,
        sessions: [
          {
            id: "session-1",
            title: "旧书",
            type: "novel",
            status: "active",
            currentPosition: { kind: "paragraph", index: 12, label: "第 12 段" },
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:00.000Z",
            lastReadAt: "2026-06-22T00:00:00.000Z"
          }
        ],
        quotes: [quote],
        reactions: [reaction],
        bookmarks: [bookmark],
        includedText: "绝不能写回的正文",
        prompt: "绝不能写回的提示"
      })
    };
    const repository = new D1ReadingRepository(db);

    const state = await repository.read();

    expect(state.schemaVersion).toBe(5);
    expect(state.sessions[0].userCurrentPosition.index).toBe(12);
    expect(state.sessions[0].assistantSyncedPosition).toBeNull();
    expect(state.sessions[0].sessionPreferences).toMatchObject({
      readingCommentMode: "light_chat",
      commentLength: "normal",
      allowDeepAnalysisByDefault: false,
      liveReadingStyle: "danmaku"
    });
    expect(state.sessions[0].sourceManifest).toBeNull();
    expect(state.quotes).toEqual([quote]);
    expect(state.reactions).toEqual([reaction]);
    expect(state.bookmarks).toEqual([bookmark]);
    expect(JSON.parse(db.state.data)).toEqual(state);
    expect(db.state.data).not.toContain("绝不能写回");
    expect(db.state.version).toBe(8);
  });

  it("migrates and persists v2 while preserving dual positions and completion metadata", async () => {
    const db = new FakeD1();
    db.state = { version: 4, data: JSON.stringify(v2Database) };
    const repository = new D1ReadingRepository(db);

    const state = await repository.read();

    expect(state.sessions[0]).toMatchObject({
      status: "completed",
      userCurrentPosition: { index: 20 },
      assistantSyncedPosition: { index: 18 },
      lastAssistantConfirmation: { batchId: "batch-3" },
      completedAt: NOW,
      sessionPreferences: {
        readingCommentMode: "light_chat",
        commentLength: "normal",
        allowDeepAnalysisByDefault: false,
        liveReadingStyle: "danmaku"
      },
      sourceManifest: null
    });
    expect(JSON.parse(db.state.data)).toEqual(state);
    expect(db.state.version).toBe(5);
  });

  it("repairs and writes back incomplete v3 without overwriting valid metadata", async () => {
    const db = new FakeD1();
    db.state = { version: 9, data: JSON.stringify(incompleteV3Database) };
    const repository = new D1ReadingRepository(db);

    const state = await repository.read();

    expect(state.sessions[0].sessionPreferences).toEqual({
      ...preferences
    });
    expect(state.sessions[0].sourceManifest).toEqual({
      ...sourceManifest,
      cloudSync: disabledCloudSync
    });
    expect(JSON.parse(db.state.data)).toEqual(state);
    expect(db.state.data).not.toContain("不要保存");
    expect(db.state.version).toBe(10);
  });

  it("preserves synced reading progress and annotations during normalization", async () => {
    const readingState = {
      schemaVersion: 1,
      position: { kind: "paragraph", index: 6, label: "第 6 页" },
      annotations: [
        {
          pageIndex: 6,
          text: "复利曲线",
          comment: "这里想问陆沉",
          createdAt: NOW
        }
      ],
      checkpoint: null,
      updatedAt: NOW
    };
    const db = new FakeD1();
    db.state = {
      version: 14,
      data: JSON.stringify({
        ...incompleteV3Database,
        sessions: [
          {
            ...incompleteV3Database.sessions[0],
            sourceManifest: {
              ...sourceManifest,
              cloudSync: disabledCloudSync,
              readingState
            }
          }
        ]
      })
    };

    const state = await new D1ReadingRepository(db).read();

    expect(state.sessions[0].sourceManifest?.readingState).toEqual(readingState);
    expect(JSON.parse(db.state.data).sessions[0].sourceManifest.readingState).toEqual(
      readingState
    );
  });

  it("persists a mutation with optimistic versioning", async () => {
    const db = new FakeD1();
    const repository = new D1ReadingRepository(db);

    await repository.mutate((state) => {
      state.sessions.push({
        id: "session-1",
        title: "雨夜里的信",
        type: "novel",
        status: "active",
        userCurrentPosition: { kind: "paragraph", index: 1, label: "第 1 段" },
        assistantSyncedPosition: null,
        liveReadingEnabled: false,
        sessionPreferences: {
          readingCommentMode: "light_chat",
          commentLength: "normal",
          allowDeepAnalysisByDefault: false,
          liveReadingStyle: "danmaku"
        },
        sourceManifest: null,
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
        lastReadAt: "2026-06-22T00:00:00.000Z"
      });
    });

    expect((await repository.read()).sessions).toHaveLength(1);
    expect(db.state?.version).toBe(2);
  });
});

const NOW = "2026-06-22T00:00:00.000Z";
const quote = {
  id: "quote-1",
  sessionId: "session-1",
  content: "旧摘录",
  position: { kind: "paragraph", index: 2, label: "第 2 段" },
  createdAt: NOW
};
const reaction = {
  id: "reaction-1",
  sessionId: "session-1",
  content: "旧反应",
  position: { kind: "paragraph", index: 3, label: "第 3 段" },
  speaker: "user",
  createdAt: NOW
};
const bookmark = {
  id: "bookmark-1",
  sessionId: "session-1",
  position: { kind: "paragraph", index: 4, label: "第 4 段" },
  label: "旧书签",
  createdAt: NOW
};
const preferences = {
  readingCommentMode: "cp_talk",
  commentLength: "normal",
  allowDeepAnalysisByDefault: false,
  liveReadingStyle: "danmaku"
};
const sourceManifest = {
  sourceId: "source-1",
  sourceKind: "pasted_text",
  title: "完整 v3",
  contentHash: "a".repeat(64),
  segmentationVersion: 1,
  paragraphCount: 20
};
const disabledCloudSync = {
  enabled: false,
  provider: "r2"
};
const v2Database = {
  schemaVersion: 2,
  sessions: [
    {
      id: "session-1",
      title: "双位置书",
      type: "novel",
      status: "completed",
      userCurrentPosition: { kind: "paragraph", index: 20, label: "第 20 段" },
      assistantSyncedPosition: { kind: "paragraph", index: 18, label: "第 18 段" },
      liveReadingEnabled: true,
      lastAssistantConfirmation: {
        operationId: "confirm-op-1",
        batchId: "batch-3",
        confirmedAt: NOW
      },
      createdAt: NOW,
      updatedAt: NOW,
      lastReadAt: NOW,
      completedAt: NOW
    }
  ],
  quotes: [quote],
  reactions: [reaction],
  bookmarks: [bookmark]
};
const incompleteV3Database = {
  schemaVersion: 3,
  sessions: [
    {
      ...v2Database.sessions[0],
      title: "完整 v3",
      status: "active",
      sessionPreferences: preferences,
      sourceManifest,
      currentText: "不要保存"
    }
  ],
  quotes: [quote],
  reactions: [reaction],
  bookmarks: [bookmark],
  fullChat: "不要保存"
};

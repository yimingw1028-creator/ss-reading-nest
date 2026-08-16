import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION_PREFERENCES, type ReadingDatabase } from "@ss/shared";
import type { ReadingRepository } from "./repositories/reading-repository.js";
import { MemorySourceObjectStorage } from "./storage/memory-source-object-storage.js";
import { CloudSourceService } from "./services/cloud-source-service.js";
import { ReadingService } from "./services/reading-service.js";
import { handleSourceRoute } from "./source-routes.js";

const NOW = "2026-06-24T00:00:00.000Z";

describe("handleSourceRoute", () => {
  it("allows browser component preflight and adds CORS headers to source responses", async () => {
    const { service } = setup();
    const preflight = await handleSourceRoute(
      new Request("https://example.test/source/secret/upload", {
        method: "OPTIONS",
        headers: {
          origin: "https://chatgpt.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type"
        }
      }),
      service
    );

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");

    const upload = await handleSourceRoute(
      new Request("https://example.test/source/secret/upload", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-1",
          sourceKind: "pasted_text",
          sourceText: "第一段\n\n第二段"
        })
      }),
      service
    );
    expect(upload.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("uploads novel source through a component-only response with metadata only", async () => {
    const { service, repository } = setup();
    const response = await handleSourceRoute(
      new Request("https://example.test/source/secret/upload", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-1",
          sourceKind: "pasted_text",
          title: "测试书",
          sourceText: "第一段\n\n第二段"
        })
      }),
      service
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("sourceManifest");
    expect(JSON.stringify(body)).not.toMatch(/sourceText|publicUrl|signedUrl|structuredContent/);
    expect(JSON.stringify(await repository.read())).not.toContain("第一段");
  });

  it("creates a cloud reading session when the component uploads a local-only novel", async () => {
    const { service, repository } = setup();
    const response = await handleSourceRoute(
      new Request("https://example.test/source/secret/upload", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "local-123",
          sourceKind: "file_import",
          title: "本机书",
          sourceText: "第一段\n\n第二段"
        })
      }),
      service
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.session).toMatchObject({
      id: "source-1",
      title: "本机书",
      type: "novel"
    });
    expect(body.sourceManifest).toMatchObject({
      sourceKind: "file_import",
      title: "本机书",
      paragraphCount: 1,
      cloudSync: { enabled: true }
    });
    const database = await repository.read();
    expect(database.sessions.some((session) => session.id === "source-1")).toBe(true);
  });

  it("uploads and restores synced novel reading state with the cloud source", async () => {
    const { service, repository } = setup();
    const readingState = {
      schemaVersion: 1,
      position: { kind: "paragraph", index: 6, total: 139, label: "第 6 页" },
      annotations: [
        {
          pageIndex: 5,
          text: "值得标记的一句",
          comment: "我的想法",
          createdAt: NOW
        }
      ],
      checkpoint: {
        pageIndex: 5,
        label: "第 6 页",
        summary: "读到这里，前面主要在讲行动。",
        updatedAt: NOW
      },
      updatedAt: NOW
    };

    const upload = await handleSourceRoute(
      new Request("https://example.test/source/secret/upload", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "local-123",
          sourceKind: "file_import",
          title: "本机书",
          sourceText: "第一段\n\n第二段",
          readingState
        })
      }),
      service
    );

    expect(upload.status).toBe(200);
    const uploaded = (await upload.json()) as Record<string, any>;
    expect(uploaded.sourceManifest.readingState).toMatchObject({
      position: { index: 6 },
      annotations: [{ text: "值得标记的一句", comment: "我的想法" }],
      checkpoint: { summary: "读到这里，前面主要在讲行动。" }
    });

    const database = await repository.read();
    const session = database.sessions.find((item) => item.id === "source-1")!;
    expect(session.userCurrentPosition).toMatchObject({ index: 6, label: "第 6 页" });

    const restore = await handleSourceRoute(
      new Request("https://example.test/source/secret/restore", {
        method: "POST",
        body: JSON.stringify({ sessionId: "source-1" })
      }),
      service
    );
    const restored = (await restore.json()) as Record<string, any>;
    expect(restored.sourceManifest.readingState).toMatchObject({
      position: { index: 6 },
      annotations: [{ pageIndex: 5 }],
      checkpoint: { label: "第 6 页" }
    });
  });

  it("updates synced novel reading state without re-uploading the source text", async () => {
    const { service } = setup();
    await service.uploadNovelSource({
      sessionId: "session-1",
      sourceKind: "pasted_text",
      title: "测试书",
      sourceText: "第一段\n\n第二段"
    });

    const state = await handleSourceRoute(
      new Request("https://example.test/source/secret/state", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-1",
          readingState: {
            schemaVersion: 1,
            position: { kind: "paragraph", index: 3, total: 10, label: "第 3 页" },
            annotations: [
              {
                pageIndex: 2,
                text: "后来补的一句",
                comment: "这里想问陆沉",
                createdAt: NOW
              }
            ],
            checkpoint: null,
            updatedAt: NOW
          }
        })
      }),
      service
    );

    expect(state.status).toBe(200);
    const body = (await state.json()) as Record<string, any>;
    expect(body.session.userCurrentPosition).toMatchObject({ index: 3 });
    expect(body.sourceManifest.readingState.annotations[0]).toMatchObject({
      pageIndex: 2,
      comment: "这里想问陆沉"
    });
    expect(JSON.stringify(body)).not.toContain("第一段");
  });

  it("restores novel source for the component without returning an MCP tool result", async () => {
    const { service } = setup();
    await service.uploadNovelSource({
      sessionId: "session-1",
      sourceKind: "pasted_text",
      title: "测试书",
      sourceText: "第一段\n\n第二段"
    });

    const response = await handleSourceRoute(
      new Request("https://example.test/source/secret/restore", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1" })
      }),
      service
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.sourceText).toBe("第一段\n\n第二段");
    expect(body).toHaveProperty("sourceManifest");
    expect(body).not.toHaveProperty("structuredContent");
    expect(body).not.toHaveProperty("content");
  });

  it("recovers bookshelf metadata over a private no-store endpoint", async () => {
    const { repository, service } = setup();
    await service.uploadNovelSource({
      sessionId: "session-1",
      sourceKind: "pasted_text",
      title: "测试书",
      sourceText: "绝不能出现在书架响应里的正文\n\n第二段"
    });
    const response = await handleSourceRoute(
      new Request("https://example.test/source/secret/bootstrap", { method: "GET" }),
      service,
      new ReadingService(repository)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as Record<string, any>;
    expect(body.bookshelfSessions[0].session).toMatchObject({
      id: "session-1",
      title: "测试书"
    });
    expect(body.readingRecords).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(
      /绝不能出现在书架响应里的正文|objectKey|manifestObjectKey|private\/sources/
    );
  });

  it("returns safe errors for disabled or missing cloud source", async () => {
    const { service, storage } = setup();
    const disabled = await handleSourceRoute(
      new Request("https://example.test/source/secret/restore", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1" })
      }),
      service
    );
    expect(disabled.status).toBe(400);
    expect(await disabled.text()).not.toContain("sourceText");

    const uploaded = await service.uploadNovelSource({
      sessionId: "session-1",
      sourceKind: "pasted_text",
      title: "测试书",
      sourceText: "第一段\n\n第二段"
    });
    await storage.deleteObject(uploaded.sourceManifest.cloudSync.objectKey!);
    const missing = await handleSourceRoute(
      new Request("https://example.test/source/secret/restore", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1" })
      }),
      service
    );
    expect(missing.status).toBe(400);
    expect(await missing.text()).not.toContain("第一段");
  });

  it("rejects unsupported source routes without leaking details", async () => {
    const { service } = setup();
    const response = await handleSourceRoute(
      new Request("https://example.test/source/secret/unknown", { method: "POST" }),
      service
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/objectKey|secret|sourceText/);
  });


});

function setup() {
  const repository = new MemoryReadingRepository();
  const storage = new MemorySourceObjectStorage();
  const service = new CloudSourceService(repository, storage, {
    now: () => new Date(NOW),
    id: () => "source-1"
  });
  return { repository, service, storage };
}

class MemoryReadingRepository implements ReadingRepository {
  private database: ReadingDatabase = {
    schemaVersion: 5,
    sessions: [
      {
        id: "session-1",
        title: "测试书",
        type: "novel",
        status: "active",
        userCurrentPosition: { kind: "paragraph", index: 1, label: "第 1 段" },
        assistantSyncedPosition: null,
        liveReadingEnabled: false,
        sessionPreferences: structuredClone(DEFAULT_SESSION_PREFERENCES),
        sourceManifest: null,
        createdAt: NOW,
        updatedAt: NOW,
        lastReadAt: NOW
      }
    ],
    quotes: [],
    reactions: [],
    bookmarks: [],
    readingRecords: []
  };

  async read(): Promise<ReadingDatabase> {
    return structuredClone(this.database);
  }

  async mutate<T>(change: (database: ReadingDatabase) => T | Promise<T>): Promise<T> {
    return change(this.database);
  }
}

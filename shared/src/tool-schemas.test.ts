import { describe, expect, it } from "vitest";
import {
  confirmAssistantSyncedPositionInputSchema,
  deleteReadingSessionInputSchema,
  deleteCloudSourceInputSchema,
  getCloudSourceStatusInputSchema,
  uploadCloudSourceInputSchema,
  renameReadingSessionInputSchema,
  saveReadingRecordInputSchema,
  saveSharedReadingReplyInputSchema,
  sendCurrentContextInputSchema,
  setReadingSessionStatusInputSchema,
  setSourceManifestInputSchema,
  setLiveReadingModeInputSchema,
  updateSessionPreferencesInputSchema,
  updateReadingPositionInputSchema
} from "./tool-schemas.js";

describe("shared reading reply schema", () => {
  it("anchors a persistent assistant reply to either a quote or a page", () => {
    expect(
      saveSharedReadingReplyInputSchema.parse({
        sessionId: "session-1",
        quoteId: "quote-1",
        content: "我想把这句留在书里。",
        operationId: "reply-1"
      })
    ).toMatchObject({ quoteId: "quote-1" });
    expect(
      saveSharedReadingReplyInputSchema.parse({
        sessionId: "session-1",
        positionIndex: 8,
        content: "这是这一页的共读回声。"
      })
    ).toMatchObject({ positionIndex: 8 });
    expect(
      saveSharedReadingReplyInputSchema.parse({
        sessionId: "session-1",
        revisesId: "reply-1",
        content: "这是上一条回应的修订。"
      })
    ).toMatchObject({ revisesId: "reply-1" });
  });

  it("rejects an unanchored reply", () => {
    expect(() =>
      saveSharedReadingReplyInputSchema.parse({
        sessionId: "session-1",
        content: "没有位置的回应"
      })
    ).toThrow();
  });

  it("rejects a reply that is also marked as a revision", () => {
    expect(() =>
      saveSharedReadingReplyInputSchema.parse({
        sessionId: "session-1",
        replyToId: "reply-1",
        revisesId: "reply-2",
        content: "含义不明确的回应"
      })
    ).toThrow();
  });
});

describe("sendCurrentContextInputSchema", () => {


  it("accepts range-sync metadata and the deprecated position alias", () => {
    const result = sendCurrentContextInputSchema.parse({
      sessionId: "session-1",
      position: { kind: "paragraph", index: 8, label: "第 8 段" },
      previousSyncedPosition: { kind: "paragraph", index: 2, label: "第 2 段" },
      contextRange: { start: 3, end: 8 },
      includedText: "第 3–8 段原文",
      mode: "range_sync",
      readingCommentMode: "reaction_only",
      commentLength: "short",
      sourceContext: {
        contentHash: "a".repeat(64),
        segmentationVersion: 1,
        paragraphCount: 20
      },
      batch: {
        id: "batch-1",
        ordinal: 1,
        total: 2,
        rangeStart: 3,
        rangeEnd: 8,
        hasMore: true
      }
    });

    expect(result.mode).toBe("range_sync");
    expect(result.readingCommentMode).toBe("reaction_only");
    expect(result.commentLength).toBe("short");
    expect(result.sourceContext?.paragraphCount).toBe(20);
  });

  it("keeps sourceContext optional for existing current-only calls", () => {
    const result = sendCurrentContextInputSchema.parse({
      sessionId: "session-1",
      currentPosition: { kind: "paragraph", index: 1, label: "第 1 段" },
      currentText: "第一段",
      mode: "current_only"
    });

    expect(result).not.toHaveProperty("sourceContext");
  });
});

describe("v0.2 position schemas", () => {
  it("updates only userCurrentPosition", () => {
    const result = updateReadingPositionInputSchema.parse({
      sessionId: "session-1",
      userCurrentPosition: { kind: "paragraph", index: 12, label: "第 12 段" }
    });
    expect(result.userCurrentPosition.index).toBe(12);
    expect(result).not.toHaveProperty("assistantSyncedPosition");
  });

  it("requires an operationId for assistant confirmation", () => {
    expect(() =>
      confirmAssistantSyncedPositionInputSchema.parse({
        sessionId: "session-1",
        confirmedPosition: { kind: "paragraph", index: 8, label: "第 8 段" },
        batchId: "batch-1"
      })
    ).toThrow();
  });

  it("accepts live-reading preference updates", () => {
    expect(
      setLiveReadingModeInputSchema.parse({ sessionId: "session-1", enabled: true })
    ).toEqual({ sessionId: "session-1", enabled: true });
  });

  it("accepts strict partial session preference updates", () => {
    expect(
      updateSessionPreferencesInputSchema.parse({
        sessionId: "session-1",
        preferences: {
          readingCommentMode: "cp_talk",
          commentLength: "normal",
          liveReadingStyle: "danmaku"
        }
      })
    ).toEqual({
      sessionId: "session-1",
      preferences: {
        readingCommentMode: "cp_talk",
        commentLength: "normal",
        liveReadingStyle: "danmaku"
      }
    });
  });

  it("rejects unknown preference fields and deep-analysis default changes", () => {
    expect(() =>
      updateSessionPreferencesInputSchema.parse({
        sessionId: "session-1",
        preferences: { unknownField: true }
      })
    ).toThrow();
    expect(() =>
      updateSessionPreferencesInputSchema.parse({
        sessionId: "session-1",
        preferences: { allowDeepAnalysisByDefault: true }
      })
    ).toThrow();
  });

  it("accepts an empty preference patch as an idempotent no-op", () => {
    expect(
      updateSessionPreferencesInputSchema.parse({
        sessionId: "session-1",
        preferences: {}
      })
    ).toEqual({ sessionId: "session-1", preferences: {} });
  });
});

describe("source manifest schemas", () => {
  const manifest = {
    sourceId: "source-1",
    sourceKind: "pasted_text" as const,
    title: "测试小说",
    contentHash: "a".repeat(64),
    segmentationVersion: 1,
    paragraphCount: 12,
    cloudSync: {
      enabled: false,
      provider: "r2" as const
    }
  };

  it("accepts metadata-only source manifests with disabled cloud sync", () => {
    expect(
      setSourceManifestInputSchema.parse({
        sessionId: "session-1",
        sourceManifest: manifest
      }).sourceManifest
    ).toEqual(manifest);
  });

  it("accepts cloud-synced novel source metadata", () => {
    const result = setSourceManifestInputSchema.parse({
      sessionId: "session-1",
      sourceManifest: {
        ...manifest,
        cloudSync: {
          enabled: true,
          provider: "r2",
          objectKey: "private/sources/source-1/source.txt",
          manifestObjectKey: "private/sources/source-1/manifest.json",
          uploadedAt: "2026-06-24T00:00:00.000Z",
          sizeBytes: 1234,
          mimeType: "text/plain;charset=utf-8"
        }
      }
    });

    expect(result.sourceManifest.cloudSync).toMatchObject({
      enabled: true,
      provider: "r2",
      objectKey: "private/sources/source-1/source.txt"
    });
  });


  it("requires objectKey for enabled novel cloud sync but not for disabled sync", () => {
    expect(
      setSourceManifestInputSchema.parse({
        sessionId: "session-1",
        sourceManifest: manifest
      }).sourceManifest.cloudSync.enabled
    ).toBe(false);

    expect(() =>
      setSourceManifestInputSchema.parse({
        sessionId: "session-1",
        sourceManifest: {
          ...manifest,
          cloudSync: {
            enabled: true,
            provider: "r2"
          }
        }
      })
    ).toThrow();
  });




  it("rejects source text, image data, and unknown manifest fields", () => {
    for (const forbidden of [
      { sourceText: "整本小说" },
      { currentText: "当前段落" },
      { selectedText: "选中文本" },
      { includedText: "补课原文" },
      { prompt: "提示词" },
      { fullChat: "完整聊天" },
      { deepAnalysisBody: "deep_analysis 正文" },
      { imageData: "data:image/png;base64,abc" }
    ]) {
      expect(() =>
        setSourceManifestInputSchema.parse({
          sessionId: "session-1",
          sourceManifest: { ...manifest, ...forbidden }
        })
      ).toThrow();
    }
  });
});

describe("cloud source metadata tool schemas", () => {
  it("accepts strict metadata-only status and delete inputs", () => {
    expect(
      getCloudSourceStatusInputSchema.parse({ sessionId: "session-1" })
    ).toEqual({ sessionId: "session-1" });
    expect(deleteCloudSourceInputSchema.parse({ sessionId: "session-1" })).toEqual({
      sessionId: "session-1"
    });
  });

  it("rejects source text and URL fields from metadata-only cloud inputs", () => {
    for (const schema of [getCloudSourceStatusInputSchema, deleteCloudSourceInputSchema]) {
      expect(() =>
        schema.parse({
          sessionId: "session-1",
          sourceText: "整本小说",
          publicUrl: "https://example.test/source.txt",
          signedUrl: "https://example.test/signed"
        })
      ).toThrow();
    }
  });
});

describe("cloud source upload tool schema", () => {
  it("accepts app bridge novel upload input", () => {
    expect(
      uploadCloudSourceInputSchema.parse({
        sessionId: "session-1",
        sourceKind: "pasted_text",
        title: "Bridge novel",
        sourceText: "第一段"
      })
    ).toMatchObject({
      sessionId: "session-1",
      sourceKind: "pasted_text",
      sourceText: "第一段"
    });
  });


  it("rejects unknown fields in app bridge upload input", () => {
    expect(() =>
      uploadCloudSourceInputSchema.parse({
        sessionId: "session-1",
        sourceKind: "pasted_text",
        sourceText: "第一段",
        objectKey: "private/sources/source-1/source.txt",
        publicUrl: "https://example.test/source.txt"
      })
    ).toThrow();
  });
});

describe("reading record tool schema", () => {
  const input = {
    sessionId: "session-1",
    startedAt: "2026-07-28T12:00:00.000Z",
    endedAt: "2026-07-28T12:17:00.000Z",
    startPosition: { kind: "paragraph" as const, index: 3, label: "第 3 页" },
    endPosition: { kind: "paragraph" as const, index: 8, label: "第 8 页" },
    pagesRead: 6,
    operationId: "record-op-1"
  };

  it("accepts one metadata-only reading record", () => {
    expect(saveReadingRecordInputSchema.parse(input)).toEqual(input);
  });

  it("rejects invalid timing and forbidden text/url fields", () => {
    expect(() =>
      saveReadingRecordInputSchema.parse({
        ...input,
        endedAt: "2026-07-28T11:59:00.000Z"
      })
    ).toThrow();
    for (const forbidden of [
      { currentText: "当前页正文" },
      { selectedText: "选中句子" },
      { sourceText: "整本小说" },
      { publicUrl: "https://example.test/source.txt" }
    ]) {
      expect(() =>
        saveReadingRecordInputSchema.parse({
          ...input,
          ...forbidden
        })
      ).toThrow();
    }
  });
});

describe("book management schema contracts", () => {
  it("accepts strict rename, status, and delete inputs", () => {
    expect(
      renameReadingSessionInputSchema.parse({
        sessionId: "session-1",
        title: "新书名"
      }).title
    ).toBe("新书名");
    expect(
      setReadingSessionStatusInputSchema.parse({
        sessionId: "session-1",
        status: "active"
      }).status
    ).toBe("active");
    expect(
      deleteReadingSessionInputSchema.parse({
        sessionId: "session-1",
        operationId: "delete-op-1",
        deleteCloudSource: true
      })
    ).toEqual({
      sessionId: "session-1",
      operationId: "delete-op-1",
      deleteCloudSource: true
    });
    expect(
      deleteReadingSessionInputSchema.parse({
        sessionId: "session-1",
        operationId: "delete-op-2"
      }).operationId
    ).toBe("delete-op-2");
    expect(() =>
      deleteReadingSessionInputSchema.parse({
        sessionId: "session-1",
        operationId: "delete-op-1",
        deleteLocalCache: true
      })
    ).toThrow();
    for (const forbidden of [
      { extra: true },
      { sourceText: "整本小说" },
      { imageData: "data:image/png;base64,AQID" },
      { publicUrl: "https://example.test/source.txt" },
      { signedUrl: "https://example.test/signed" }
    ]) {
      expect(() =>
        deleteReadingSessionInputSchema.parse({
          sessionId: "session-1",
          operationId: "delete-op-1",
          ...forbidden
        })
      ).toThrow();
    }
  });
});

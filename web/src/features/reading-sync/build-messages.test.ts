import { describe, expect, it } from "vitest";
import {
  buildBatchChatMessage,
  buildBatchUserNote,
  buildCurrentOnlyPrompt,
  buildRecentOnlyPrompt
} from "./build-messages.js";
import type { ReadingSyncJob, SyncBatch } from "./types.js";

const batch: SyncBatch = {
  id: "batch-1",
  ordinal: 1,
  totalBatches: 4,
  rangeStart: 3,
  rangeEnd: 8,
  characterCount: 100,
  text: "【第 3 页】\n原文",
  isFinal: false,
  oversizedParagraph: false,
  status: "pending"
};

const job: ReadingSyncJob = {
  sessionId: "session-1",
  title: "测试小说",
  type: "novel",
  mode: "range_sync",
  targetPosition: { kind: "paragraph", index: 28, label: "第 28 页" },
  confirmedThrough: { kind: "paragraph", index: 2, label: "第 2 页" },
  batches: [batch],
  activeBatchIndex: 0,
  createdAt: "2026-06-22T00:00:00.000Z"
};

describe("reading-sync messages", () => {
  it("formats a recognizable non-final catch-up message", () => {
    const message = buildBatchChatMessage(job, batch);

    expect(message).toContain("【补课第 1/4 批：第 3–8 页】");
    expect(message).toContain("陆沉先安静追到用户当前位置");
    expect(message).toContain("只简短回复：“已读到第 8 页。”");
    expect(message).toContain(batch.text);
    expect(message).not.toMatch(/剧情摘要|关键事件|人物关系/);
    expect(message).not.toContain("publish_companion_comment");
  });

  it("puts only factual synchronization metadata in userNote", () => {
    const note = buildBatchUserNote(job, batch);

    expect(note).toContain("sessionId=session-1");
    expect(note).toContain("batchRange=3-8");
    expect(note).toContain("hasMoreBatches=true");
    expect(note).not.toMatch(/总结|判断|推测/);
  });

  it("routes current-only and recent-only formal requests through prompt policy", () => {
    const current = buildCurrentOnlyPrompt({
      sessionId: "session-1",
      title: "测试小说",
      position: 8,
      text: "当前原文",
      hasUnconfirmedGap: true,
      mode: "reaction_only",
      length: "short",
      operationId: "current-op-1"
    });
    const recent = buildRecentOnlyPrompt({
      sessionId: "session-1",
      title: "测试小说",
      rangeStart: 4,
      rangeEnd: 8,
      text: "最近原文",
      mode: "plot_guess",
      length: "normal",
      operationId: "recent-op-1"
    });

    expect(current).toContain("当前原文");
    expect(current).toContain("中间存在未同步剧情");
    expect(current).toContain("1-5 句");
    expect(recent).toContain("最近原文");
    expect(recent).toContain("后续走向");
    expect(current).toContain("直接在聊天区回复即可");
    expect(recent).toContain("直接在聊天区回复即可");
    expect(current).toContain("不要调用任何应用写回工具");
    expect(recent).toContain("不要调用任何应用写回工具");
    // User/AI-visible text must use 「页」, not the old 「段」 unit label.
    expect(current).toContain("【只看当前页：第 8 页】");
    expect(recent).toContain("【补最近几页：第 4–8 页】");
    expect(current).not.toMatch(/当前段|第 \d+ 段/);
    expect(recent).not.toMatch(/补最近几段|第 \d+–\d+ 段/);
  });
});

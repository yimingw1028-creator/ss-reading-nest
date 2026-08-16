import type { ReadingSyncJob, SyncBatch } from "./types.js";
import type { CommentLength, ReadingCommentMode } from "@ss/shared";
import { buildReadingCommentPrompt } from "../reading-comments/prompt-policy.js";

export function buildBatchChatMessage(job: ReadingSyncJob, batch: SyncBatch) {
  return [
    batchHeader(batch),
    "",
    "这是 skipped range 分批补课，不是正式点评。",
    `用户当前已读到${job.targetPosition.label}，陆沉上次确认读到${confirmedLabel(job)}。`,
    "这是补课批次。陆沉先安静追到用户当前位置，不展开评论。",
    `只简短回复：“已读到第 ${batch.rangeEnd} 页。”`,
    "",
    batch.text
  ].join("\n");
}

export function buildBatchUserNote(job: ReadingSyncJob, batch: SyncBatch) {
  return [
    "syncType=skipped-range-batch",
    `sessionId=${job.sessionId}`,
    `userCurrentPosition=${job.targetPosition.index}`,
    `assistantSyncedPosition=${job.confirmedThrough?.index ?? "null"}`,
    `batchId=${batch.id}`,
    `batchRange=${batch.rangeStart}-${batch.rangeEnd}`,
    `batchOrdinal=${batch.ordinal}/${batch.totalBatches}`,
    `hasMoreBatches=${!batch.isFinal}`
  ].join("; ");
}

export function buildFormalReadingPrompt(
  job: ReadingSyncJob,
  preferences: {
    mode: ReadingCommentMode;
    length: CommentLength;
    operationId: string;
  }
) {
  const start = job.batches[0]?.rangeStart ?? job.targetPosition.index;
  return buildReadingCommentPrompt({
    sessionId: job.sessionId,
    mode: preferences.mode,
    length: preferences.length,
    title: job.title,
    position: job.targetPosition,
    syncedRange: { start, end: job.targetPosition.index },
    source: "catch_up_complete",
    operationId: preferences.operationId
  });
}

export function buildCurrentOnlyPrompt(input: {
  sessionId: string;
  title: string;
  position: number;
  text: string;
  hasUnconfirmedGap: boolean;
  mode: ReadingCommentMode;
  length: CommentLength;
  operationId: string;
}) {
  return [
    `【只看当前页：第 ${input.position} 页】`,
    `《${input.title}》`,
    input.hasUnconfirmedGap
      ? "中间存在未同步剧情，请不要假装知道未提供的内容。"
      : "请只分析当前页。",
    input.text,
    "",
    buildReadingCommentPrompt({
      sessionId: input.sessionId,
      mode: input.mode,
      length: input.length,
      title: input.title,
      position: {
        kind: "paragraph",
        index: input.position,
        label: `第 ${input.position} 页`
      },
      source: "current_only",
      operationId: input.operationId
    })
  ].join("\n");
}

export function buildRecentOnlyPrompt(input: {
  sessionId: string;
  title: string;
  rangeStart: number;
  rangeEnd: number;
  text: string;
  mode: ReadingCommentMode;
  length: CommentLength;
  operationId: string;
}) {
  return [
    `【补最近几页：第 ${input.rangeStart}–${input.rangeEnd} 页】`,
    `《${input.title}》`,
    "这是局部陪读，不代表中间未提供的剧情已经同步。",
    input.text,
    "",
    buildReadingCommentPrompt({
      sessionId: input.sessionId,
      mode: input.mode,
      length: input.length,
      title: input.title,
      position: {
        kind: "paragraph",
        index: input.rangeEnd,
        label: `第 ${input.rangeEnd} 页`
      },
      syncedRange: { start: input.rangeStart, end: input.rangeEnd },
      source: "quick_action",
      operationId: input.operationId
    })
  ].join("\n");
}

function batchHeader(batch: SyncBatch) {
  return `【补课第 ${batch.ordinal}/${batch.totalBatches} 批：第 ${batch.rangeStart}–${batch.rangeEnd} 页】`;
}

function confirmedLabel(job: ReadingSyncJob) {
  return job.confirmedThrough?.label ?? "尚未同步";
}

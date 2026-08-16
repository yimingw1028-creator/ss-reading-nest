export type ReadingType = "novel";
export type SessionStatus = "active" | "completed";
export type ReadingCommentMode =
  | "light_chat"
  | "reaction_only"
  | "cp_talk"
  | "plot_guess"
  | "deep_analysis"
  | "diary_summary";
export type CommentLength = "short" | "normal" | "long";
export type LiveReadingStyle = "danmaku";
export type SourceKind = "pasted_text" | "file_import";
export type SourceAvailability =
  | "available_local"
  | "available_cloud"
  | "restoring_from_cloud"
  | "cloud_missing"
  | "cloud_restore_failed"
  | "local_only_missing"
  | "mismatch"
  | "segmentation_mismatch"
  | "unknown";

export const NOVEL_SEGMENTATION_VERSION = 4;

export interface SessionPreferences {
  readingCommentMode: ReadingCommentMode;
  commentLength: CommentLength;
  allowDeepAnalysisByDefault: false;
  liveReadingStyle: LiveReadingStyle;
}

export const DEFAULT_SESSION_PREFERENCES: SessionPreferences = {
  readingCommentMode: "light_chat",
  commentLength: "normal",
  allowDeepAnalysisByDefault: false,
  liveReadingStyle: "danmaku"
};

export interface ReadingPosition {
  kind: "paragraph";
  index: number;
  total?: number;
  label: string;
}

export interface SourceManifest {
  sourceId: string;
  sourceKind: SourceKind;
  title?: string;
  contentHash: string;
  segmentationVersion: number;
  paragraphCount?: number;
  cloudSync: CloudSyncMetadata;
  readingState?: SyncedReadingState;
  createdOnDeviceId?: string;
  lastVerifiedAt?: string;
}

export interface SyncedReadingAnnotation {
  pageIndex: number;
  text: string;
  comment?: string;
  assistantSummary?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface SyncedReadingCheckpoint {
  pageIndex: number;
  label: string;
  summary: string;
  updatedAt: string;
}

export interface SyncedReadingState {
  schemaVersion: 1;
  position?: ReadingPosition;
  annotations?: SyncedReadingAnnotation[];
  checkpoint?: SyncedReadingCheckpoint | null;
  updatedAt: string;
}

export interface CloudSyncMetadata {
  enabled: boolean;
  provider: "r2";
  objectKey?: string;
  manifestObjectKey?: string;
  uploadedAt?: string;
  sizeBytes?: number;
  mimeType?: string;
}

export interface SourceContext {
  contentHash: string;
  segmentationVersion: number;
  paragraphCount?: number;
}

export interface ReadingSession {
  id: string;
  title: string;
  type: ReadingType;
  status: SessionStatus;
  userCurrentPosition: ReadingPosition;
  assistantSyncedPosition: ReadingPosition | null;
  liveReadingEnabled: boolean;
  sessionPreferences: SessionPreferences;
  sourceManifest: SourceManifest | null;
  lastAssistantConfirmation?: {
    operationId: string;
    batchId: string;
    confirmedAt: string;
  };
  createdAt: string;
  updatedAt: string;
  lastReadAt: string;
  completedAt?: string;
}

export interface Quote {
  id: string;
  sessionId: string;
  content: string;
  position: ReadingPosition;
  note?: string;
  clearThought?: string;
  operationId?: string;
  createdAt: string;
}

export interface Reaction {
  id: string;
  sessionId: string;
  content: string;
  position: ReadingPosition;
  speaker: "user" | "assistant";
  quoteId?: string;
  replyToId?: string;
  revisesId?: string;
  operationId?: string;
  createdAt: string;
}

export interface Bookmark {
  id: string;
  sessionId: string;
  position: ReadingPosition;
  label?: string;
  operationId?: string;
  createdAt: string;
}

export interface ReadingRecord {
  id: string;
  sessionId: string;
  bookTitle: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  startPosition: ReadingPosition;
  endPosition: ReadingPosition;
  pagesRead: number;
  operationId?: string;
  createdAt: string;
}

export interface ReadingDatabase {
  schemaVersion: 5;
  sessions: ReadingSession[];
  quotes: Quote[];
  reactions: Reaction[];
  bookmarks: Bookmark[];
  readingRecords: ReadingRecord[];
}

export type ReadingSyncMode =
  | "current_only"
  | "range_sync"
  | "recent_only"
  | "live_reading"
  | "selected_text";

export interface ReadingContextBatch {
  id: string;
  ordinal: number;
  total: number;
  rangeStart: number;
  rangeEnd: number;
  hasMore: boolean;
}

export interface SessionBundle {
  session: ReadingSession;
  quotes: Quote[];
  reactions: Reaction[];
  bookmarks: Bookmark[];
}

export interface LocalCacheMetadata {
  sessionId: string;
  type: ReadingType;
  title: string;
  cacheVersion: 2;
  remembered: boolean;
  itemCount: number;
  sourceManifest: SourceManifest;
  approximateBytes?: number;
  updatedAt: string;
}

export interface NovelLocalCache {
  metadata: LocalCacheMetadata & { type: "novel" };
  sourceText: string;
  chunks: string[];
}

export type ReadingLocalCache = NovelLocalCache;

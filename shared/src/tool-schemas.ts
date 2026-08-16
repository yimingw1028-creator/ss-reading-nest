import { z } from "zod";

export const readingTypeSchema = z.literal("novel");
export const readingSyncModeSchema = z.enum([
  "current_only",
  "range_sync",
  "recent_only",
  "live_reading",
  "selected_text"
]);
export const readingCommentModeSchema = z.enum([
  "light_chat",
  "reaction_only",
  "cp_talk",
  "plot_guess",
  "deep_analysis",
  "diary_summary"
]);
export const commentLengthSchema = z.enum(["short", "normal", "long"]);
export const liveReadingStyleSchema = z.literal("danmaku");
export const sourceKindSchema = z.enum(["pasted_text", "file_import"]);
export const sourceAvailabilitySchema = z.enum([
  "available_local",
  "available_cloud",
  "restoring_from_cloud",
  "cloud_missing",
  "cloud_restore_failed",
  "local_only_missing",
  "mismatch",
  "segmentation_mismatch",
  "unknown"
]);
export const readingPositionSchema = z.object({
  kind: z.literal("paragraph"),
  index: z.number().int().min(1),
  total: z.number().int().min(1).optional(),
  label: z.string().min(1).max(100)
});

export const cloudSyncMetadataSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.literal("r2"),
    objectKey: z.string().min(1).max(500).optional(),
    manifestObjectKey: z.string().min(1).max(500).optional(),
    uploadedAt: z.string().datetime().optional(),
    sizeBytes: z.number().int().min(0).optional(),
    mimeType: z.string().min(1).max(100).optional()
  })
  .strict();

export const syncedReadingAnnotationSchema = z
  .object({
    pageIndex: z.number().int().min(0),
    text: z.string().trim().min(1).max(10_000),
    comment: z.string().trim().max(4_000).optional(),
    assistantSummary: z.string().trim().max(4_000).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime().optional()
  })
  .strict();

export const syncedReadingCheckpointSchema = z
  .object({
    pageIndex: z.number().int().min(0),
    label: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(4_000),
    updatedAt: z.string().datetime()
  })
  .strict();

export const syncedReadingStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    position: readingPositionSchema.optional(),
    annotations: z.array(syncedReadingAnnotationSchema).max(1_000).optional(),
    checkpoint: syncedReadingCheckpointSchema.nullable().optional(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const sourceManifestSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    sourceKind: sourceKindSchema,
    title: z.string().trim().min(1).max(200).optional(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    segmentationVersion: z.number().int().min(1),
    paragraphCount: z.number().int().min(1).optional(),
    cloudSync: cloudSyncMetadataSchema,
    readingState: syncedReadingStateSchema.optional(),
    createdOnDeviceId: z.string().min(1).max(200).optional(),
    lastVerifiedAt: z.string().datetime().optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.cloudSync.enabled && !input.cloudSync.objectKey) {
      context.addIssue({
        code: "custom",
        path: ["cloudSync", "objectKey"],
        message: "Enabled novel cloud sync requires objectKey"
      });
    }
  });

export const sourceContextSchema = z
  .object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    segmentationVersion: z.number().int().min(1),
    paragraphCount: z.number().int().min(1).optional(),
  })
  .strict();

export const openReadingNestInputSchema = z.object({}).strict();
export const startReadingSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: readingTypeSchema
});
export const sessionIdSchema = z.string().min(1);
export const updateReadingPositionInputSchema = z.object({
  sessionId: sessionIdSchema,
  userCurrentPosition: readingPositionSchema
});
export const sendCurrentContextInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    currentPosition: readingPositionSchema.optional(),
    position: readingPositionSchema.optional(),
    previousSyncedPosition: readingPositionSchema.nullable().optional(),
    contextRange: z
      .object({
        start: z.number().int().min(1),
        end: z.number().int().min(1)
      })
      .optional(),
    includedText: z.string().max(20_000).optional(),
    currentText: z.string().max(20_000).optional(),
    selectedText: z.string().max(10_000).optional(),
    userNote: z.string().max(4_000).optional(),
    mode: readingSyncModeSchema,
    readingCommentMode: readingCommentModeSchema.optional(),
    commentLength: commentLengthSchema.optional(),
    sourceContext: sourceContextSchema.optional(),
    batch: z
      .object({
        id: z.string().min(1).max(200),
        ordinal: z.number().int().min(1),
        total: z.number().int().min(1),
        rangeStart: z.number().int().min(1),
        rangeEnd: z.number().int().min(1),
        hasMore: z.boolean()
      })
      .optional()
  })
  .strict()
  .refine((input) => input.currentPosition || input.position, {
    message: "currentPosition is required"
  });
export const confirmAssistantSyncedPositionInputSchema = z.object({
  sessionId: sessionIdSchema,
  confirmedPosition: readingPositionSchema,
  batchId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(200)
});
export const setLiveReadingModeInputSchema = z.object({
  sessionId: sessionIdSchema,
  enabled: z.boolean()
});
export const updateSessionPreferencesInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    preferences: z
      .object({
        readingCommentMode: readingCommentModeSchema.optional(),
        commentLength: commentLengthSchema.optional(),
        liveReadingStyle: liveReadingStyleSchema.optional()
      })
      .strict()
  })
  .strict();
export const setSourceManifestInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    sourceManifest: sourceManifestSchema
  })
  .strict();
export const getCloudSourceStatusInputSchema = z
  .object({
    sessionId: sessionIdSchema
  })
  .strict();
export const uploadCloudSourceInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    sourceKind: z.enum(["pasted_text", "file_import"]),
    title: z.string().trim().min(1).max(200).optional(),
    sourceText: z.string().min(1),
    readingState: syncedReadingStateSchema.optional()
  })
  .strict();
export const deleteCloudSourceInputSchema = z
  .object({
    sessionId: sessionIdSchema
  })
  .strict();
export const renameReadingSessionInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    title: z.string().trim().min(1).max(200)
  })
  .strict();
export const setReadingSessionStatusInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    status: z.enum(["active", "completed"])
  })
  .strict();
export const deleteReadingSessionInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    operationId: z.string().min(1).max(200),
    deleteCloudSource: z.boolean().optional()
  })
  .strict();
export const saveQuoteInputSchema = z.object({
  sessionId: sessionIdSchema,
  content: z.string().trim().min(1).max(20_000),
  position: readingPositionSchema,
  note: z.string().trim().max(4_000).optional(),
  clearThought: z.string().trim().max(12_000).optional(),
  operationId: z.string().min(1).max(200).optional()
});
export const updateQuoteNoteInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    quoteId: z.string().min(1),
    note: z.string().trim().min(1).max(4_000).optional(),
    clearThought: z.string().trim().max(12_000).optional()
  })
  .refine((input) => input.note !== undefined || input.clearThought !== undefined, {
    message: "note or clearThought is required"
  });
export const deleteQuoteInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    quoteId: z.string().min(1)
  })
  .strict();
export const deleteBookArchiveEntryInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    source: z.enum([
      "reaction",
      "bookmark",
      "annotation-comment",
      "annotation-summary",
      "checkpoint"
    ]),
    recordId: z.string().min(1)
  })
  .strict();
export const saveReactionInputSchema = z.object({
  sessionId: sessionIdSchema,
  content: z.string().trim().min(1).max(4_000),
  position: readingPositionSchema,
  speaker: z.literal("user"),
  operationId: z.string().min(1).max(200).optional()
});
export const saveSharedReadingReplyInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    content: z.string().trim().min(1).max(12_000),
    positionIndex: z.number().int().min(1).optional(),
    quoteId: z.string().min(1).optional(),
    replyToId: z.string().min(1).optional(),
    revisesId: z.string().min(1).optional(),
    operationId: z.string().min(1).max(200).optional()
  })
  .strict()
  .refine(
    (input) =>
      input.positionIndex !== undefined ||
      input.quoteId !== undefined ||
      input.replyToId !== undefined ||
      input.revisesId !== undefined,
    { message: "positionIndex, quoteId, replyToId, or revisesId is required" }
  )
  .refine((input) => !(input.replyToId && input.revisesId), {
    message: "replyToId and revisesId cannot be used together"
  });
export const saveBookmarkInputSchema = z.object({
  sessionId: sessionIdSchema,
  position: readingPositionSchema,
  label: z.string().trim().max(200).optional(),
  operationId: z.string().min(1).max(200).optional()
});
export const finishTodayReadingInputSchema = z.object({
  sessionId: sessionIdSchema,
  position: readingPositionSchema,
  createBookmark: z.boolean().optional().default(true),
  operationId: z.string().min(1).max(200).optional()
});
export const saveReadingRecordInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    startPosition: readingPositionSchema,
    endPosition: readingPositionSchema,
    pagesRead: z.number().int().min(1).max(100_000).optional(),
    operationId: z.string().min(1).max(200)
  })
  .strict()
  .superRefine((input, context) => {
    if (Date.parse(input.endedAt) < Date.parse(input.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "endedAt must be after startedAt"
      });
    }
    if (input.startPosition.kind !== input.endPosition.kind) {
      context.addIssue({
        code: "custom",
        path: ["endPosition"],
        message: "endPosition must use the same kind as startPosition"
      });
    }
  });
export const completeReadingSessionInputSchema = z.object({
  sessionId: sessionIdSchema,
  finalPosition: readingPositionSchema.optional()
});
export const generateDiaryContextInputSchema = z.object({
  sessionId: sessionIdSchema
});

export type SendCurrentContextInput = z.infer<typeof sendCurrentContextInputSchema>;
export type UploadCloudSourceInput = z.infer<typeof uploadCloudSourceInputSchema>;
export type SaveReadingRecordInput = z.infer<typeof saveReadingRecordInputSchema>;

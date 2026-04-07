import { integer, pgTable, real, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// ─── Recording Sessions ───────────────────────────────────────────────────────

export const recordingSessions = pgTable("recording_sessions", {
  id: uuid("id").primaryKey(),
  startedAt: timestamp("started_at").notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Recording Chunks ─────────────────────────────────────────────────────────

export const recordingChunks = pgTable(
  "recording_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .references(() => recordingSessions.id)
      .notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    filename: text("filename").notNull(),
    /** Key of the object in the MinIO bucket */
    bucketKey: text("bucket_key"),
    bucketUploadedAt: timestamp("bucket_uploaded_at"),
    /** Acked once bucket upload + DB write are both confirmed */
    ackedAt: timestamp("acked_at"),
    durationS: real("duration_s"),
    sizeBytes: integer("size_bytes"),
    transcript: text("transcript"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("session_chunk_unique").on(t.sessionId, t.chunkIndex)],
);

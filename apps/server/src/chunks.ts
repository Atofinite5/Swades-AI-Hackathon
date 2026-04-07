/**
 * chunks.ts — Reliable chunk storage API
 *
 * Pipeline:
 *   Client → POST /api/chunks/upload
 *     → MinIO bucket upload
 *     → Groq transcription (best-effort)
 *     → DB ack (session + chunk record)
 *     → return { text, bucketKey, ackedAt }
 *
 * Reconciliation:
 *   Client → POST /api/chunks/reconcile
 *     → Compare client's OPFS chunk list vs DB acks + bucket objects
 *     → Return which chunks need re-upload vs are already done
 *
 * Design:
 *   • Every chunk is stored in MinIO BEFORE the DB ack is written.
 *   • If bucket upload fails the request fails — client will retry.
 *   • Transcription is best-effort: failure doesn't block ack.
 *   • ON CONFLICT DO UPDATE means re-uploads are idempotent.
 */

import { db, recordingChunks, recordingSessions } from "@my-better-t-app/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { objectExists, uploadToBucket } from "./bucket";
import { transcribeWithGroq } from "./transcribe";

const chunksApp = new Hono();

// ─── Groq concurrency semaphore ───────────────────────────────────────────────
// Caps simultaneous Groq calls to avoid stampede under high user load.
const MAX_GROQ_CONCURRENT = 5;
let activeTranscriptions = 0;

const TRANSCRIPTION_TIMEOUT_MS = 8_000;

// ─── POST /api/sessions — initialise a recording session in DB ────────────────

chunksApp.post("/sessions", async (c) => {
  const { sessionId, startedAt } = (await c.req.json()) as {
    sessionId: string;
    startedAt: string;
  };

  if (!sessionId || !startedAt) {
    return c.json({ error: "sessionId and startedAt are required" }, 400);
  }

  await db
    .insert(recordingSessions)
    .values({ id: sessionId, startedAt: new Date(startedAt) })
    .onConflictDoNothing();

  return c.json({ sessionId });
});

// ─── POST /api/chunks/upload — store chunk in bucket + DB ─────────────────────

chunksApp.post("/upload", async (c) => {
  const body = await c.req.parseBody({ all: true });

  const audioFile = body.audio;
  const sessionId = body.sessionId as string;
  const chunkIndex = parseInt(body.chunkIndex as string, 10);
  const filename = body.filename as string;
  const durationS = parseFloat(body.durationS as string);

  if (
    !audioFile ||
    typeof audioFile === "string" ||
    !sessionId ||
    Number.isNaN(chunkIndex) ||
    !filename
  ) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  // Read the audio bytes
  const audioBuffer = await (
    audioFile as unknown as { arrayBuffer(): Promise<ArrayBuffer> }
  ).arrayBuffer();

  if (!audioBuffer || audioBuffer.byteLength < 44) {
    return c.json({ error: "Invalid or empty audio file" }, 400);
  }

  try {
    // 1. Upload to MinIO (must succeed — bucket is source of truth)
    const bucketKey = `sessions/${sessionId}/${filename}`;
    await uploadToBucket(bucketKey, audioBuffer);

    // 2. Ensure session row exists (upsert) — avoids FK failure if session init raced
    await db
      .insert(recordingSessions)
      .values({ id: sessionId, startedAt: new Date() })
      .onConflictDoNothing();

    // 3. Write DB ack immediately (transcript null — filled in async below)
    const now = new Date();
    await db
      .insert(recordingChunks)
      .values({
        ackedAt: now,
        bucketKey,
        bucketUploadedAt: now,
        chunkIndex,
        durationS: Number.isNaN(durationS) ? null : durationS,
        filename,
        sessionId,
        sizeBytes: audioBuffer.byteLength,
        transcript: null,
      })
      .onConflictDoUpdate({
        set: {
          ackedAt: now,
          bucketKey,
          bucketUploadedAt: now,
        },
        target: [recordingChunks.sessionId, recordingChunks.chunkIndex],
      });

    // 4. Transcribe with timeout — fast path: transcript in ack; slow path: async fallback
    let transcript = "";

    if (activeTranscriptions < MAX_GROQ_CONCURRENT) {
      activeTranscriptions++;
      const transcriptPromise = transcribeWithGroq(audioBuffer, filename)
        .then((r) => r.text)
        .catch(() => "")
        .finally(() => { activeTranscriptions--; });

      transcript = await Promise.race([
        transcriptPromise,
        new Promise<string>((resolve) => setTimeout(() => resolve(""), TRANSCRIPTION_TIMEOUT_MS)),
      ]);

      // Timed out — let the still-running promise update DB when it finishes
      if (!transcript) {
        void transcriptPromise
          .then(async (text) => {
            if (!text) return;
            await db
              .update(recordingChunks)
              .set({ transcript: text })
              .where(and(eq(recordingChunks.sessionId, sessionId), eq(recordingChunks.chunkIndex, chunkIndex)));
            console.log(`[chunks] Late transcript saved for ${filename}: "${text.slice(0, 60)}"`);
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[chunks] Late transcript DB update failed for ${filename}: ${msg}`);
          });
      }
    } else {
      console.warn(`[chunks] Groq at capacity (${activeTranscriptions}/${MAX_GROQ_CONCURRENT}), skipping transcription for ${filename}`);
    }

    // Update DB row with transcript if we got one synchronously
    if (transcript) {
      await db
        .update(recordingChunks)
        .set({ transcript })
        .where(and(eq(recordingChunks.sessionId, sessionId), eq(recordingChunks.chunkIndex, chunkIndex)));
    }

    return c.json({
      ackedAt: now.toISOString(),
      audio_duration: Number.isNaN(durationS) ? 0 : durationS,
      bucketKey,
      chunkIndex,
      language: "en",
      sessionId,
      text: transcript,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chunks] Upload failed for ${filename}:`, message);
    return c.json({ error: message }, 500);
  }
});

// ─── POST /api/chunks/reconcile — compare OPFS vs bucket+DB ──────────────────

interface ClientChunk {
  filename: string;
  index: number;
}

chunksApp.post("/reconcile", async (c) => {
  const { sessionId, chunks: clientChunks } = (await c.req.json()) as {
    chunks: ClientChunk[];
    sessionId: string;
  };

  if (!sessionId || !Array.isArray(clientChunks)) {
    return c.json({ error: "sessionId and chunks[] are required" }, 400);
  }

  // Fetch all DB acks for this session
  const dbChunks = await db.query.recordingChunks.findMany({
    where: eq(recordingChunks.sessionId, sessionId),
  });

  const dbMap = new Map(dbChunks.map((ch) => [ch.chunkIndex, ch]));

  const needsUpload: number[] = [];
  const alreadyDone: Array<{ index: number; transcript: string | null }> = [];

  // Check each chunk the client reports it has in OPFS
  await Promise.all(
    clientChunks.map(async (cc) => {
      const dbChunk = dbMap.get(cc.index);

      if (!dbChunk?.ackedAt) {
        // Not in DB yet → client must upload
        needsUpload.push(cc.index);
        return;
      }

      // In DB — verify bucket object actually exists (detect bucket purge)
      const inBucket = dbChunk.bucketKey ? await objectExists(dbChunk.bucketKey) : false;

      if (!inBucket) {
        // DB acked but object missing from bucket → re-upload needed
        needsUpload.push(cc.index);
      } else {
        alreadyDone.push({
          index: cc.index,
          transcript: dbChunk.transcript,
        });
      }
    }),
  );

  return c.json({ alreadyDone, needsUpload });
});

export { chunksApp };

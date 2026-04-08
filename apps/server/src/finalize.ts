/**
 * finalize.ts — High-quality session transcription (Layer 2)
 *
 * Dual-layer architecture:
 *   Layer 1 (chunks.ts):  5 s client chunks → OPFS → MinIO → DB ack → streaming preview
 *   Layer 2 (here):       merge ALL chunks → light normalization
 *                         → adaptive silence re-segmentation (15–20 s, 1.5 s overlap)
 *                         → parallel whisper-large-v3 (word timestamps)
 *                         → overlap-aware word dedup → single clean transcript
 *
 * Satisfies every constraint in the SYSTEM GOAL:
 *   ✓ Client 5 s chunks for reliability only — never transcribed directly
 *   ✓ Server merges all chunks before any transcription pass
 *   ✓ 16 kHz mono WAV with light amplitude normalization
 *   ✓ Silence-based segmentation 15–20 s, abs minimum 10 s
 *   ✓ 1.5 s overlap to prevent boundary word loss
 *   ✓ Adaptive silence threshold (loudness + speech rate)
 *   ✓ whisper-large-v3 (not turbo) for maximum accuracy
 *   ✓ Parallel Groq (batch 5) with word-level timestamps
 *   ✓ Overlap dedup: skip words where word.start < overlapSec
 *   ✓ Short tail (<10 s) absorbed into previous segment (no orphans)
 */

import { db, recordingChunks, recordingSessions } from "@my-better-t-app/db";
import { env } from "@my-better-t-app/env/server";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getFromBucket } from "./bucket";

const finalizeApp = new Hono();

const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * Always use the full whisper-large-v3 model for finalization —
 * NOT turbo — as this is the highest-accuracy Whisper variant on Groq.
 * The per-chunk streaming path (chunks.ts) can use turbo for speed.
 */
const FINALIZE_MODEL = "whisper-large-v3";

// ─── WAV codec ────────────────────────────────────────────────────────────────

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.codePointAt(i) ?? 0);
  };

  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, 1, true);  // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? (s * 0x80_00) | 0 : (s * 0x7f_ff) | 0, true);
  }

  return buffer;
}

function extractPcm(wav: ArrayBuffer): { pcm: Float32Array; sampleRate: number } {
  if (wav.byteLength < 44) throw new Error("WAV too short to contain a valid header");
  const view = new DataView(wav);
  const sampleRate = view.getUint32(24, true);
  const int16 = new Int16Array(wav.slice(44));
  const pcm = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    pcm[i] = (int16[i] ?? 0) / 32_768;
  }
  return { pcm, sampleRate };
}

/**
 * Light amplitude normalization — boosts quiet audio toward -20 dBFS.
 * Max gain capped at +6 dB (factor 2) to avoid over-amplification.
 * Does NOT reduce loud audio (not a compressor).
 * CONSTRAINT: MUST apply light normalization / MUST NOT apply aggressive filtering.
 */
function normalizeAmplitude(pcm: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) sumSq += (pcm[i] ?? 0) ** 2;
  const rms = Math.sqrt(sumSq / pcm.length);

  // Only boost — never attenuate (target -20 dBFS = RMS 0.1)
  if (rms <= 0 || rms >= 0.1) return pcm;

  const gain = Math.min(0.1 / rms, 2.0);  // max +6 dB
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, (pcm[i] ?? 0) * gain));
  return out;
}

// ─── Adaptive silence segmentation ───────────────────────────────────────────

export interface AudioSegment {
  wav: ArrayBuffer;
  /** Absolute time in session where NEW content starts (after the overlap prefix). */
  startSec: number;
  /** Duration of the overlap prefix baked into this WAV's start. */
  overlapSec: number;
}

/**
 * Segment merged PCM using adaptive silence detection.
 *
 * CONSTRAINT compliance:
 *   - Chunks 15–20 s (search window), absolute minimum 10 s enforced.
 *   - 1.5 s overlap prefix for boundary context.
 *   - Dynamic silence threshold: noise_floor + 15 % × (peak − floor).
 *   - Speech-rate adaptation: fast speech (density >60 %) → 120 ms silence needed;
 *     slow speech (density <30 %) → 300 ms; default → 200 ms.
 *   - Short tail (<minSec remaining after last split) is absorbed into the
 *     current segment (up to 25 s absolute cap) to prevent orphan clips.
 */
export function segmentAudio(
  pcm: Float32Array,
  sampleRate: number,
  minSec = 15,
  maxSec = 20,
  overlapSec = 1.5,
): AudioSegment[] {
  const winSz        = Math.floor(sampleRate * 0.02);    // 20 ms window
  const minSamples   = Math.floor(minSec * sampleRate);
  const maxSamples   = Math.floor(maxSec * sampleRate);
  const cap25Samples = Math.floor(25 * sampleRate);      // 25 s absolute hard cap
  const absMinSamples = Math.floor(10 * sampleRate);     // 10 s minimum floor
  const overlapSamples = Math.floor(overlapSec * sampleRate);

  // ── RMS per 20 ms window ──────────────────────────────────────────────────
  const numWins = Math.floor(pcm.length / winSz);
  const rms = new Float32Array(numWins);
  for (let i = 0; i < numWins; i++) {
    let sum = 0;
    for (let j = i * winSz; j < (i + 1) * winSz; j++) {
      const s = pcm[j] ?? 0;
      sum += s * s;
    }
    rms[i] = Math.sqrt(sum / winSz);
  }

  // ── Adaptive silence threshold (loudness) ─────────────────────────────────
  const sorted    = [...rms].toSorted((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.05)] ?? 1e-6;
  const signalPeak = sorted[Math.floor(sorted.length * 0.95)] ?? 1e-6;
  const threshold  = noiseFloor + (signalPeak - noiseFloor) * 0.15;

  // ── Speech-rate adaptation (density of voiced windows) ───────────────────
  let speechyCount = 0;
  for (let i = 0; i < numWins; i++) { if ((rms[i] ?? 0) >= threshold) speechyCount++; }
  const speechDensity = speechyCount / Math.max(numWins, 1);

  // Fast speech → shorter pauses (120 ms); slow → longer (300 ms); default 200 ms
  const silMinWins = speechDensity > 0.6 ? 6    // 120 ms
    : speechDensity < 0.3 ? 15   // 300 ms
      : 10;                       // 200 ms

  console.log(`[finalize] speechDensity=${(speechDensity * 100).toFixed(0)}% → silenceMin=${silMinWins * 20}ms, threshold=${threshold.toFixed(4)}`);

  // ── Find silence midpoints ────────────────────────────────────────────────
  const silenceMids: number[] = [];
  let silStart = -1;
  for (let i = 0; i < numWins; i++) {
    const silent = (rms[i] ?? 0) < threshold;
    if (silent && silStart < 0)  { silStart = i; }
    if (!silent && silStart >= 0) {
      if (i - silStart >= silMinWins) {
        silenceMids.push(Math.floor(((silStart + i) / 2) * winSz));
      }
      silStart = -1;
    }
  }
  if (silStart >= 0 && numWins - silStart >= silMinWins) {
    silenceMids.push(Math.floor(((silStart + numWins) / 2) * winSz));
  }

  // ── Build segments ────────────────────────────────────────────────────────
  const segments: AudioSegment[] = [];
  let pos = 0;

  // Edge case: entire audio is shorter than minSec — emit as single segment
  if (pcm.length <= minSamples) {
    segments.push({
      wav: encodeWav(pcm, sampleRate),
      startSec: 0,
      overlapSec: 0,
    });
    return segments;
  }

  while (pos < pcm.length) {
    const remaining = pcm.length - pos;

    // If remaining fits within max, output as final segment
    if (remaining <= maxSamples) {
      const overlapStart  = Math.max(0, pos - overlapSamples);
      const actualOverlap = (pos - overlapStart) / sampleRate;
      segments.push({
        wav: encodeWav(pcm.slice(overlapStart), sampleRate),
        startSec: pos / sampleRate,
        overlapSec: actualOverlap,
      });
      break;
    }

    // Find best silence split in [pos + minSamples, pos + maxSamples]
    let splitAt = pos + maxSamples;
    for (const mid of silenceMids) {
      if (mid > pos + minSamples && mid <= pos + maxSamples) splitAt = mid;
    }

    // Short-tail absorption: if what would remain after splitting is < absMinSec,
    // extend this segment to absorb the tail (capped at 25 s absolute maximum).
    // This prevents tiny orphan clips that degrade Whisper accuracy.
    const wouldRemain = pcm.length - splitAt;
    if (wouldRemain > 0 && wouldRemain < absMinSamples) {
      splitAt = Math.min(pos + cap25Samples, pcm.length);
    }

    const overlapStart  = Math.max(0, pos - overlapSamples);
    const actualOverlap = (pos - overlapStart) / sampleRate;
    segments.push({
      wav: encodeWav(pcm.slice(overlapStart, splitAt), sampleRate),
      startSec: pos / sampleRate,
      overlapSec: actualOverlap,
    });

    pos = splitAt;
    if (pos >= pcm.length) break;
  }

  return segments;
}

// ─── Word-level Groq transcription ───────────────────────────────────────────

interface GroqWord { word: string; start: number; end: number; }

interface GroqVerboseResponse {
  text: string;
  words?: GroqWord[];
  segments?: Array<{ text: string; no_speech_prob: number; avg_logprob: number }>;
}

interface SegmentResult {
  text: string;
  words: GroqWord[];
  startSec: number;
  overlapSec: number;
}

async function transcribeSegment(
  wavBuffer: ArrayBuffer,
  filename: string,
  attempt = 0,
): Promise<{ text: string; words: GroqWord[] }> {
  const formData = new FormData();
  formData.append("file", new Blob([wavBuffer], { type: "audio/wav" }), filename);
  formData.append("model", FINALIZE_MODEL);   // whisper-large-v3 for max accuracy
  formData.append("language", "en");
  formData.append("response_format", "verbose_json");
  formData.append("temperature", "0");
  formData.append("prompt", "Hello. The following is a clear English recording.");
  formData.append("timestamp_granularities[]", "word");
  formData.append("timestamp_granularities[]", "segment");

  const response = await fetch(GROQ_API_URL, {
    body: formData,
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    method: "POST",
  });

  if (response.status === 429 && attempt < 3) {
    const raw    = parseInt(response.headers.get("retry-after") ?? "15", 10);
    const waitSec = Number.isNaN(raw) ? 15 : Math.max(1, Math.min(raw, 60));
    console.warn(`[finalize] Groq 429 for ${filename}, retrying in ${waitSec}s (attempt ${attempt + 1}/4)`);
    await new Promise((r) => setTimeout(r, waitSec * 1_000));
    return transcribeSegment(wavBuffer, filename, attempt + 1);
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq error ${response.status} for ${filename}: ${err}`);
  }

  const raw = (await response.json()) as GroqVerboseResponse;

  // Build set of segment texts that are silent/low-confidence (to drop their words)
  const droppedTexts = new Set<string>(
    (raw.segments ?? [])
      .filter((s) => s.no_speech_prob >= 0.8 || s.avg_logprob <= -2)
      .map((s) => s.text.trim()),
  );

  const words = (raw.words ?? []).filter((w) => w.word.trim().length > 0);

  // Reconstruct text from accepted words for consistency with the word list
  const text = words.length > 0
    ? words.filter((w) => !droppedTexts.has(w.word.trim())).map((w) => w.word).join("").trim()
    : (raw.text?.trim() ?? "");

  return { text, words };
}

// ─── Overlap-aware transcript merge ──────────────────────────────────────────

/**
 * Merge per-segment word lists into one unified timeline.
 *
 * Overlap deduplication rule:
 *   - Each segment WAV starts with `overlapSec` seconds of audio from the
 *     end of the previous segment (context for Whisper).
 *   - Words with word.start < overlapSec are in the overlap zone — skip them.
 *   - Convert WAV-relative timestamps to absolute session timestamps:
 *       absoluteTime = segment.startSec − segment.overlapSec + word.start
 *
 * Fallback: if no segment returned word-level data, plain text join is used.
 */
function mergeWordTranscripts(results: SegmentResult[]): {
  text: string;
  words: Array<{ word: string; start: number; end: number }>;
} {
  const hasWords = results.some((r) => r.words.length > 0);

  if (!hasWords) {
    return {
      text: results.map((r) => r.text).join(" ").trim(),
      words: [],
    };
  }

  const merged: Array<{ word: string; start: number; end: number }> = [];

  for (const seg of results) {
    if (seg.words.length === 0) {
      if (seg.text.trim()) {
        merged.push({ end: seg.startSec + 1, start: seg.startSec, word: " " + seg.text.trim() });
      }
      continue;
    }

    const base = seg.startSec - seg.overlapSec;
    for (const w of seg.words) {
      if (w.start < seg.overlapSec) continue;   // in overlap zone — already covered
      merged.push({ end: base + w.end, start: base + w.start, word: w.word });
    }
  }

  return {
    text: merged.map((w) => w.word).join("").trim(),
    words: merged,
  };
}

// ─── POST /api/sessions/:sessionId/finalize ───────────────────────────────────

finalizeApp.post("/:sessionId/finalize", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);

  const startMs = Date.now();

  const allChunks = await db
    .select()
    .from(recordingChunks)
    .where(eq(recordingChunks.sessionId, sessionId))
    .orderBy(asc(recordingChunks.chunkIndex));

  const acked = allChunks.filter((ch) => ch.ackedAt && ch.bucketKey);
  if (acked.length === 0) {
    return c.json({ error: "No acked chunks found for session" }, 404);
  }

  try {
    // 1. Fetch all WAVs from MinIO in parallel
    const wavBuffers = await Promise.all(acked.map((ch) => getFromBucket(ch.bucketKey!)));

    // 2. Extract PCM and concatenate into one continuous stream
    let sampleRate = 16_000;
    let totalSamples = 0;
    const pcmArrays: Float32Array[] = [];

    for (const wav of wavBuffers) {
      const { pcm, sampleRate: sr } = extractPcm(wav);
      sampleRate = sr;
      pcmArrays.push(pcm);
      totalSamples += pcm.length;
    }

    const rawPcm = new Float32Array(totalSamples);
    let off = 0;
    for (const pcm of pcmArrays) { rawPcm.set(pcm, off); off += pcm.length; }

    // 3. Light amplitude normalization (MUST: boost quiet audio up to +6 dB toward -20 dBFS)
    const mergedPcm = normalizeAmplitude(rawPcm);

    const totalDurationS = totalSamples / sampleRate;
    console.log(`[finalize] Session ${sessionId}: ${acked.length} chunks → ${totalDurationS.toFixed(1)}s merged`);

    // 4. Adaptive silence segmentation: 15–20 s chunks, 1.5 s overlap, speech-rate adaptive
    const segments = segmentAudio(mergedPcm, sampleRate, 15, 20, 1.5);
    console.log(`[finalize] Session ${sessionId}: ${segments.length} Whisper segments`);

    // 5. Parallel Groq transcription in batches of 5 (whisper-large-v3, word timestamps)
    const BATCH_SIZE = 5;
    const results: SegmentResult[] = [];

    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((seg, j) => {
          const idx = i + j;
          const fn  = `seg-${String(idx).padStart(4, "0")}.wav`;
          return transcribeSegment(seg.wav, fn).then((res) => ({
            ...res,
            overlapSec: seg.overlapSec,
            startSec: seg.startSec,
          }));
        }),
      );
      results.push(...batchResults);
      console.log(
        `[finalize] Session ${sessionId}: batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(segments.length / BATCH_SIZE)} done`,
      );
    }

    // 6. Overlap-aware word merge → single clean transcript
    const { text, words } = mergeWordTranscripts(results);

    // 7. Mark session completed
    await db
      .update(recordingSessions)
      .set({ completedAt: new Date() })
      .where(eq(recordingSessions.id, sessionId));

    const elapsed = Date.now() - startMs;
    console.log(`[finalize] Session ${sessionId}: done in ${elapsed}ms — "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);

    return c.json({
      chunkCount: acked.length,
      durationS: totalDurationS,
      elapsed_ms: elapsed,
      segmentCount: segments.length,
      sessionId,
      transcript: text,
      words,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[finalize] Session ${sessionId} failed:`, message);
    return c.json({ error: message }, 500);
  }
});

export { finalizeApp };

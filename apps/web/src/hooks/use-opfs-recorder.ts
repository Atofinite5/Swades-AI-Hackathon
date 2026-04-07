/**
 * useOpfsRecorder
 *
 * Reliable chunking pipeline:
 *   Mic → AudioWorklet → WAV chunks → OPFS (durable buffer)
 *     → POST /api/chunks/upload (MinIO bucket + DB ack)
 *     → chunk cleared from "pending" only after bucket+DB both confirmed
 *
 * Recovery on mount:
 *   1. GET_PENDING_SESSIONS from OPFS (chunks not yet acked)
 *   2. POST /api/chunks/reconcile — server checks DB vs bucket
 *   3. Re-upload only what's actually missing; skip already-done
 *
 * Rate-limit safety:
 *   • UPLOAD_CONCURRENCY = 1 — sequential uploads to Groq / server
 *   • Exponential backoff on failure (1s, 2s, 4s)
 *   • Server handles Groq 429 with Retry-After internally
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { env } from "@my-better-t-app/env/web";

// ─── Constants ────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 16_000;
const CHUNK_DURATION = 5; // seconds
const OVERLAP_DURATION = 0.5; // seconds — kept from previous chunk
const OVERLAP_SAMPLES = Math.floor(SAMPLE_RATE * OVERLAP_DURATION);
const MAX_RETRIES = 3;
const UPLOAD_CONCURRENCY = 1; // sequential — one Groq request at a time

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChunkStatus = "recording" | "pending" | "uploading" | "done" | "failed";

export interface ChunkMeta {
  sessionId: string;
  index: number;
  filename: string;
  duration: number;
  timestamp: number;
  sampleRate: number;
  size: number;
  uploadStatus: ChunkStatus;
  retries: number;
  ackedAt: string | null;
  /** Local blob URL for playback — only available for current session */
  blobUrl?: string;
  /** Transcription text returned from server after ack */
  transcript?: string;
  /** Short error description if upload failed */
  errorMsg?: string;
}

export interface OPFSSession {
  sessionId: string;
  startedAt: string;
  completedAt: string | null;
  totalChunks: number;
  chunks: ChunkMeta[];
}

export type RecorderStatus = "idle" | "requesting" | "recording" | "paused" | "stopping";

// ─── WAV Encoding ─────────────────────────────────────────────────────────────

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.codePointAt(i) ?? 0);
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x80_00 : s * 0x7f_ff, true);
  }

  return buffer;
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.round(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = src - lo;
    output[i] = (input[lo] ?? 0) * (1 - frac) + (input[hi] ?? 0) * frac;
  }
  return output;
}

// ─── OPFS Worker Bridge ───────────────────────────────────────────────────────

type WorkerMessage = {
  id: string;
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

function createWorkerBridge(worker: Worker) {
  const pending = new Map<string, (msg: WorkerMessage) => void>();

  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const cb = pending.get(e.data.id);
    if (cb) {
      pending.delete(e.data.id);
      cb(e.data);
    }
  };

  return function send<T extends Record<string, unknown>>(
    type: string,
    payload?: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<WorkerMessage & T> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, (msg) => {
        if (msg.ok) resolve(msg as WorkerMessage & T);
        else reject(new Error(msg.error ?? `OPFS worker error: ${type}`));
      });
      worker.postMessage({ id, type, payload: payload ?? {} }, transfer);
    });
  };
}

// ─── Upload Helper — POST to bucket+DB pipeline ───────────────────────────────

async function uploadChunk(
  wavBuffer: ArrayBuffer,
  chunk: Pick<ChunkMeta, "sessionId" | "index" | "filename" | "duration">,
  serverUrl: string,
): Promise<{ text: string; language: string; audio_duration: number }> {
  const formData = new FormData();
  formData.append("audio", new Blob([wavBuffer], { type: "audio/wav" }), chunk.filename);
  formData.append("sessionId", chunk.sessionId);
  formData.append("chunkIndex", String(chunk.index));
  formData.append("filename", chunk.filename);
  formData.append("durationS", String(chunk.duration));

  const response = await fetch(`${serverUrl}/api/chunks/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let msg = `HTTP ${response.status}`;
    try {
      const json = JSON.parse(raw) as { error?: string };
      if (json.error) msg = json.error;
    } catch { /* raw text wasn't JSON */ }
    throw new Error(msg);
  }

  return response.json() as Promise<{ text: string; language: string; audio_duration: number }>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useOpfsRecorder(chunkDuration = CHUNK_DURATION) {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [chunks, setChunks] = useState<ChunkMeta[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recovering, setRecovering] = useState(false);

  // Refs — stable across renders
  const workerRef = useRef<Worker | null>(null);
  const sendRef = useRef<ReturnType<typeof createWorkerBridge> | null>(null);
  const sessionIdRef = useRef<string>("");
  const chunkIndexRef = useRef(0);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const samplesRef = useRef<Float32Array[]>([]);
  const sampleCountRef = useRef(0);
  const overlapBufRef = useRef<Float32Array>(new Float32Array(0));
  const statusRef = useRef<RecorderStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const pausedElapsedRef = useRef(0);

  const uploadQueueRef = useRef<ChunkMeta[]>([]);
  const activeUploadsRef = useRef(0);
  const onAudioSamplesRef = useRef<(s: Float32Array) => void>(() => {});

  statusRef.current = status;

  const chunkSamples = SAMPLE_RATE * chunkDuration;

  // ── Worker init + recovery ─────────────────────────────────────────────────

  useEffect(() => {
    const worker = new Worker("/opfs-worker.js");
    workerRef.current = worker;
    sendRef.current = createWorkerBridge(worker);

    (async () => {
      const send = sendRef.current;
      if (!send) return;
      setRecovering(true);

      try {
        // 1. Get all sessions that have pending/failed chunks in OPFS
        const { sessions } = await send<{ sessions: OPFSSession[] }>("GET_PENDING_SESSIONS");

        for (const session of sessions) {
          const pendingChunks = session.chunks.filter(
            (c) => c.uploadStatus === "pending" || c.uploadStatus === "failed",
          );
          if (pendingChunks.length === 0) continue;

          // 2. Ask server which of these actually need re-uploading
          //    (some may already be in bucket+DB from a previous tab/session)
          let needsUpload = pendingChunks.map((c) => c.index);
          try {
            const res = await fetch(`${env.NEXT_PUBLIC_SERVER_URL}/api/chunks/reconcile`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sessionId: session.sessionId,
                chunks: pendingChunks.map((c) => ({
                  index: c.index,
                  filename: c.filename,
                })),
              }),
            });

            if (res.ok) {
              const data = (await res.json()) as {
                needsUpload: number[];
                alreadyDone: Array<{ index: number; transcript: string | null }>;
              };
              needsUpload = data.needsUpload;

              // Chunks already in bucket+DB → ack them in OPFS and show done in UI
              for (const done of data.alreadyDone) {
                await send("ACK_CHUNK", {
                  sessionId: session.sessionId,
                  index: done.index,
                });
              }
              // Add already-done chunks to UI state so they appear in the transcript
              const doneMetas = pendingChunks
                .filter((c) => data.alreadyDone.some((d) => d.index === c.index))
                .map((c) => {
                  const doneEntry = data.alreadyDone.find((d) => d.index === c.index);
                  return {
                    ...c,
                    uploadStatus: "done" as ChunkStatus,
                    transcript: doneEntry?.transcript ?? undefined,
                    ackedAt: new Date().toISOString(),
                  };
                });
              if (doneMetas.length > 0) {
                setChunks((prev) => [...prev, ...doneMetas]);
              }
            }
          } catch {
            // Reconciliation failed (server offline?) — re-upload everything
          }

          // 3. Re-queue the chunks that still need uploading
          const toQueue = pendingChunks.filter((c) => needsUpload.includes(c.index));
          if (toQueue.length > 0) {
            setChunks((prev) => [
              ...prev,
              ...toQueue.map((c) => ({
                ...c,
                uploadStatus: "pending" as ChunkStatus,
              })),
            ]);
            for (const chunk of toQueue) {
              enqueueUpload({ ...chunk, uploadStatus: "pending" });
            }
          }
        }
      } finally {
        setRecovering(false);
        drainQueue();
      }
    })();

    return () => {
      worker.terminate();
    };
  }, []);

  // ── Upload queue ───────────────────────────────────────────────────────────

  function enqueueUpload(chunk: ChunkMeta) {
    uploadQueueRef.current.push(chunk);
  }

  const drainQueue = useCallback(() => {
    const send = sendRef.current;
    if (!send) return;

    while (uploadQueueRef.current.length > 0 && activeUploadsRef.current < UPLOAD_CONCURRENCY) {
      const chunk = uploadQueueRef.current.shift();
      if (!chunk) break;

      activeUploadsRef.current++;

      updateChunkStatus(chunk.sessionId, chunk.index, "uploading");
      send("SET_UPLOADING", { sessionId: chunk.sessionId, index: chunk.index });

      (async () => {
        try {
          const { buffer } = await send<{ buffer: ArrayBuffer }>("READ_CHUNK", {
            sessionId: chunk.sessionId,
            filename: chunk.filename,
          });

          const result = await uploadChunk(buffer, chunk, env.NEXT_PUBLIC_SERVER_URL);

          await send("ACK_CHUNK", { sessionId: chunk.sessionId, index: chunk.index });

          updateChunkStatus(chunk.sessionId, chunk.index, "done", result.text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const retries = chunk.retries ?? 0;
          updateChunkStatus(chunk.sessionId, chunk.index, "failed", undefined, msg);
          if (retries < MAX_RETRIES) {
            await send("FAIL_CHUNK", { sessionId: chunk.sessionId, index: chunk.index });
            // Exponential backoff: 1s, 2s, 4s
            await new Promise((r) => setTimeout(r, 2 ** retries * 1000));
            uploadQueueRef.current.push({ ...chunk, retries: retries + 1 });
          }
        } finally {
          activeUploadsRef.current--;
          drainQueue();
        }
      })();
    }
  }, []);

  function updateChunkStatus(
    sessionId: string,
    index: number,
    uploadStatus: ChunkStatus,
    transcript?: string,
    errorMsg?: string,
  ) {
    setChunks((prev) =>
      prev.map((c) =>
        c.sessionId === sessionId && c.index === index
          ? {
              ...c,
              uploadStatus,
              ...(transcript !== undefined ? { transcript } : {}),
              ...(errorMsg !== undefined ? { errorMsg } : {}),
            }
          : c,
      ),
    );
  }

  // ── Flush one WAV chunk ────────────────────────────────────────────────────

  const flushChunk = useCallback(
    async (pcm: Float32Array, isFinal = false) => {
      const send = sendRef.current;
      if (!send || pcm.length === 0) return;

      const sessionId = sessionIdRef.current;
      const index = chunkIndexRef.current++;
      const timestamp = Date.now();
      const duration = pcm.length / SAMPLE_RATE;
      const wavBuffer = encodeWav(pcm, SAMPLE_RATE);
      const blobUrl = URL.createObjectURL(new Blob([wavBuffer], { type: "audio/wav" }));

      const meta: ChunkMeta = {
        sessionId,
        index,
        filename: `chunk-${String(index).padStart(5, "0")}.wav`,
        duration,
        timestamp,
        sampleRate: SAMPLE_RATE,
        size: wavBuffer.byteLength,
        uploadStatus: "pending",
        retries: 0,
        ackedAt: null,
        blobUrl,
      };

      setChunks((prev) => [...prev, meta]);

      try {
        // Write to OPFS first (zero-copy transfer) — durable before any network call
        await send(
          "WRITE_CHUNK",
          { sessionId, index, wavBuffer, duration, timestamp, sampleRate: SAMPLE_RATE },
          [wavBuffer],
        );
        enqueueUpload(meta);
        drainQueue();
      } catch {
        updateChunkStatus(sessionId, index, "failed");
      }

      if (isFinal) {
        await send("CLOSE_SESSION", { sessionId });
      }
    },
    [drainQueue],
  );

  // ── AudioWorklet callback ─────────────────────────────────────────────────

  onAudioSamplesRef.current = (resampled: Float32Array) => {
    if (statusRef.current !== "recording") return;

    samplesRef.current.push(resampled);
    sampleCountRef.current += resampled.length;

    if (sampleCountRef.current >= chunkSamples) {
      const total = samplesRef.current.reduce((n, b) => n + b.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      for (const buf of samplesRef.current) {
        merged.set(buf, off);
        off += buf.length;
      }

      // Prepend overlap for transcription context continuity
      const overlap = overlapBufRef.current;
      const withOverlap = new Float32Array(overlap.length + merged.length);
      withOverlap.set(overlap, 0);
      withOverlap.set(merged, overlap.length);

      overlapBufRef.current = merged.slice(-OVERLAP_SAMPLES);
      samplesRef.current = [];
      sampleCountRef.current = 0;

      flushChunk(withOverlap);
    }
  };

  // ── Start ──────────────────────────────────────────────────────────────────

  const start = useCallback(async () => {
    if (statusRef.current === "recording") return;
    const send = sendRef.current;
    if (!send) return;

    setStatus("requesting");

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: { ideal: 48_000 } },
      });

      const audioCtx = new AudioContext();
      const nativeSampleRate = audioCtx.sampleRate;

      await audioCtx.audioWorklet.addModule("/recorder-processor.js");
      const processor = new AudioWorkletNode(audioCtx, "recorder-processor");
      const source = audioCtx.createMediaStreamSource(mediaStream);

      processor.port.onmessage = (e: MessageEvent<{ samples: Float32Array }>) => {
        const resampled = resample(e.data.samples, nativeSampleRate, SAMPLE_RATE);
        onAudioSamplesRef.current(resampled);
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      const sessionId = crypto.randomUUID();
      sessionIdRef.current = sessionId;
      chunkIndexRef.current = 0;
      overlapBufRef.current = new Float32Array(0);
      samplesRef.current = [];
      sampleCountRef.current = 0;

      await send("INIT_SESSION", { sessionId, startedAt: new Date().toISOString() });

      // Init session in DB (best-effort — chunk uploads will still work without it)
      fetch(`${env.NEXT_PUBLIC_SERVER_URL}/api/chunks/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, startedAt: new Date().toISOString() }),
      }).catch(() => {});

      streamRef.current = mediaStream;
      audioCtxRef.current = audioCtx;
      processorRef.current = processor;
      setStream(mediaStream);

      pausedElapsedRef.current = 0;
      startTimeRef.current = Date.now();
      setElapsed(0);
      setStatus("recording");

      timerRef.current = setInterval(() => {
        if (statusRef.current === "recording") {
          setElapsed(pausedElapsedRef.current + (Date.now() - startTimeRef.current) / 1000);
        }
      }, 100);
    } catch {
      setStatus("idle");
    }
  }, []);

  // ── Stop ───────────────────────────────────────────────────────────────────

  const stop = useCallback(() => {
    setStatus("stopping");

    if (samplesRef.current.length > 0) {
      const total = samplesRef.current.reduce((n, b) => n + b.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      for (const buf of samplesRef.current) {
        merged.set(buf, off);
        off += buf.length;
      }
      const overlap = overlapBufRef.current;
      const withOverlap = new Float32Array(overlap.length + merged.length);
      withOverlap.set(overlap, 0);
      withOverlap.set(merged, overlap.length);
      flushChunk(withOverlap, true);
    }

    processorRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (audioCtxRef.current?.state !== "closed") audioCtxRef.current?.close();
    if (timerRef.current) clearInterval(timerRef.current);

    processorRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;
    overlapBufRef.current = new Float32Array(0);
    samplesRef.current = [];
    sampleCountRef.current = 0;

    setStream(null);
    setStatus("idle");
  }, [flushChunk]);

  // ── Pause / Resume ─────────────────────────────────────────────────────────

  const pause = useCallback(() => {
    if (statusRef.current !== "recording") return;
    pausedElapsedRef.current += (Date.now() - startTimeRef.current) / 1000;
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    if (statusRef.current !== "paused") return;
    startTimeRef.current = Date.now();
    setStatus("recording");
  }, []);

  // ── Clear ──────────────────────────────────────────────────────────────────

  const clearChunks = useCallback(() => {
    setChunks((prev) => {
      for (const c of prev) {
        if (c.blobUrl) URL.revokeObjectURL(c.blobUrl);
      }
      return [];
    });
  }, []);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────

  useEffect(
    () => () => {
      processorRef.current?.disconnect();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current?.state !== "closed") audioCtxRef.current?.close();
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  // ── Derived state ──────────────────────────────────────────────────────────

  const pendingCount = chunks.filter(
    (c) => c.uploadStatus === "pending" || c.uploadStatus === "uploading",
  ).length;
  const doneCount = chunks.filter((c) => c.uploadStatus === "done").length;
  const failedCount = chunks.filter((c) => c.uploadStatus === "failed").length;
  const fullTranscript = chunks
    .filter((c) => c.transcript)
    .sort((a, b) => a.index - b.index)
    .map((c) => c.transcript)
    .join(" ")
    .trim();

  return {
    status,
    stream,
    elapsed,
    start,
    stop,
    pause,
    resume,
    chunks,
    clearChunks,
    pendingCount,
    doneCount,
    failedCount,
    fullTranscript,
    recovering,
  };
}

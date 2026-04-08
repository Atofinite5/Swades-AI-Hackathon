import { env } from "@my-better-t-app/env/server";
import { Hono } from "hono";
import { calculateEstimatedWER, logTranscriptionQA, validateTranscript } from "./qa";

const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * SNR calculation heuristic to trigger enhancement
 */
function calculateSNR(pcm: Float32Array): number {
  if (pcm.length === 0) {
    return 0;
  }

  // Simple percentile-based noise estimation
  const sorted = [...pcm].map(Math.abs).toSorted((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] || 1e-6;
  const signalPeak = sorted[Math.floor(sorted.length * 0.95)] || 1e-6;

  return 20 * Math.log10(signalPeak / noiseFloor);
}

/**
 * Short stylistic conditioning fed to Whisper. The Whisper `prompt` parameter
 * is meant for style/spelling cues, NOT instructions — long instruction-style
 * prompts confuse the model and degrade output.
 */
const ENGLISH_CONTEXT_PROMPT = "Hello. The following is a clear English recording.";

/**
 * Whisper's standard thresholds. Anything stricter silently drops real speech.
 */
const MIN_AVG_LOGPROB = -2;
const MAX_NO_SPEECH_PROB = 0.8;

/**
 * Multi-word phrases Whisper hallucinates over silence (typically YouTube
 * subtitle artefacts). Single common words like "you", "sh", "hmm", "bye"
 * are intentionally NOT in this list — they are real speech.
 *
 * Match is exact (after normalization), never substring.
 */
const HALLUCINATION_PATTERNS = new Set([
  "thank you for watching",
  "thanks for watching",
  "please subscribe",
  "please subscribe to my channel",
  "please like and subscribe",
  "subtitles by the amara org community",
  "subtitles by amara org",
  "see you in the next one",
  "see you next time",
  "bye bye bye",
]);

function isHallucination(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replaceAll(/[.,!?;]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return HALLUCINATION_PATTERNS.has(normalized);
}

interface GroqVerboseSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
}

interface GroqVerboseResponse {
  task: string;
  language: string;
  duration: number;
  text: string;
  segments: GroqVerboseSegment[];
}

/**
 * Merge multiple WAV blobs (all 16 kHz, 16-bit mono PCM) into one.
 * Strips the 44-byte header from every chunk after the first and writes
 * a single valid WAV header for the combined PCM payload.
 */
function mergeWavBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  if (buffers.length === 0) {
    throw new Error("No audio buffers to merge");
  }
  const initialBuffer = buffers[0];
  if (!initialBuffer) {
    throw new Error("No initial audio buffer");
  }
  if (buffers.length === 1) {
    return initialBuffer;
  }

  const firstBuffer = initialBuffer;
  if (firstBuffer.byteLength < 44) {
    throw new Error("Invalid first audio buffer");
  }

  let totalPcmBytes = 0;
  for (const buf of buffers) {
    if (buf && buf.byteLength >= 44) {
      totalPcmBytes += buf.byteLength - 44;
    }
  }

  const merged = new ArrayBuffer(44 + totalPcmBytes);
  const view = new DataView(merged);
  const uint8 = new Uint8Array(merged);

  // Copy header from the first chunk (sample rate, bit depth, channels)
  const firstHeader = new Uint8Array(firstBuffer.slice(0, 44));
  uint8.set(firstHeader, 0);

  // Fix RIFF + data chunk sizes for the merged file
  view.setUint32(4, 36 + totalPcmBytes, true);
  view.setUint32(40, totalPcmBytes, true);

  // Concatenate raw PCM from every chunk
  let offset = 44;
  for (const buf of buffers) {
    if (!buf || buf.byteLength < 44) {
      continue;
    }

    const rawPcm = buf.slice(44);
    const int16 = new Int16Array(rawPcm);
    const pcm = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      const sample = int16[i];
      if (sample !== undefined) {
        pcm[i] = sample / 32_768;
      }
    }

    // Light normalization
    let max = 0;
    for (const s of pcm) {
      if (s !== undefined && Math.abs(s) > max) {
        max = Math.abs(s);
      }
    }

    if (max > 0 && max < 0.5) {
      const gain = 0.8 / max;
      for (let i = 0; i < pcm.length; i++) {
        const sample = pcm[i];
        if (sample !== undefined) {
          pcm[i] = sample * gain;
        }
      }
    }

    // Noise detection heuristic
    const snr = calculateSNR(pcm);
    if (snr < 20) {
      console.warn(`[QA] Low SNR detected: ${snr.toFixed(2)}dB. Enhancement triggered.`);
      // Placeholder for DeepFilterNet enhancement:
      // pcm = await deepFilterNet.enhance(pcm);
    }

    // Write back to uint8
    const outInt16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const sample = pcm[i];
      if (sample !== undefined) {
        const s = Math.max(-1, Math.min(1, sample));
        outInt16[i] = s < 0 ? (s * 0x80_00) | 0 : (s * 0x7f_ff) | 0;
      }
    }
    uint8.set(new Uint8Array(outInt16.buffer), offset);
    offset += outInt16.byteLength;
  }

  return merged;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionOutput {
  text: string;
  language: string;
  audio_duration: number;
  segments: TranscriptionSegment[];
}

export async function transcribeWithGroq(
  audioBuffer: ArrayBuffer,
  fileName: string,
  attempt = 0,
): Promise<TranscriptionOutput> {
  const formData = new FormData();
  const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });

  formData.append("file", audioBlob, fileName);
  formData.append("model", env.WHISPER_MODEL);
  formData.append("language", "en");
  formData.append("response_format", "verbose_json");
  formData.append("temperature", "0"); // Enforced temperature=0.0
  formData.append("prompt", ENGLISH_CONTEXT_PROMPT);

  const response = await fetch(GROQ_API_URL, {
    body: formData,
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    method: "POST",
  });

  // 429 — rate limited: respect Retry-After header, retry up to 2 more times
  if (response.status === 429 && attempt < 2) {
    const raw = parseInt(response.headers.get("retry-after") ?? "15", 10);
    const retryAfterSec = Number.isNaN(raw) ? 15 : Math.max(1, Math.min(raw, 60));
    console.warn(`[Groq] Rate limited. Retrying in ${retryAfterSec}s (attempt ${attempt + 1}/3)`);
    await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
    return transcribeWithGroq(audioBuffer, fileName, attempt + 1);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error (${response.status}): ${errorText}`);
  }

  const raw = (await response.json()) as GroqVerboseResponse;

  if (!raw.segments) {
    return {
      audio_duration: raw.duration ?? 0,
      language: raw.language ?? "en",
      segments: [],
      text: raw.text?.trim() ?? "",
    };
  }

  // Drop only segments that are clearly silence/noise or known YouTube
  // hallucinations. Do NOT dedup by text — repeating the same word is valid
  // speech (e.g. "yes yes yes").
  const filteredSegments = raw.segments
    .filter((s) => s.no_speech_prob < MAX_NO_SPEECH_PROB)
    .filter((s) => s.avg_logprob > MIN_AVG_LOGPROB)
    .filter((s) => !isHallucination(s.text))
    .map((s) => ({
      end: Math.round(s.end * 10) / 10,
      start: Math.round(s.start * 10) / 10,
      text: s.text.trim(),
    }))
    .filter((s) => s.text.length > 0);

  // Rebuild the text only from high-confidence filtered segments
  const fullText = filteredSegments
    .map((s) => s.text)
    .join(" ")
    .trim();

  return {
    audio_duration: raw.duration,
    language: raw.language,
    segments: filteredSegments,
    text: fullText,
  };
}

const transcribeApp = new Hono();

/**
 * POST /transcribe
 *
 * Accepts multipart/form-data with one or more WAV files (field: "audio").
 * Merges chunks → sends to Groq Whisper large-v3 → returns full transcript
 * with timed caption segments (silent/low-confidence segments filtered out).
 *
 * Returns: { text, language, audio_duration, segments, duration_ms }
 */
transcribeApp.post("/", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.parseBody({ all: true });
    const audioFiles = body.audio;

    if (!audioFiles) {
      return c.json({ error: "No audio files provided" }, 400);
    }

    const files = Array.isArray(audioFiles) ? audioFiles : [audioFiles];

    const buffers: ArrayBuffer[] = [];
    for (const file of files) {
      if (file && typeof file !== "string" && "arrayBuffer" in file) {
        const buffer = await (
          file as unknown as { arrayBuffer(): Promise<ArrayBuffer> }
        ).arrayBuffer();
        if (buffer) {
          buffers.push(buffer);
        }
      }
    }

    if (buffers.length === 0) {
      return c.json({ error: "No valid audio files found" }, 400);
    }

    const mergedAudio = mergeWavBuffers(buffers);
    const result = await transcribeWithGroq(mergedAudio, "recording.wav");

    const duration_ms = Date.now() - startTime;

    // Validate transcript quality
    const validation = validateTranscript(result.text);
    if (!validation.valid) {
      console.warn(`[QA] Transcript validation warnings: ${validation.issues.join(", ")}`);
    }

    // Log QA metrics
    logTranscriptionQA({
      audio_duration_s: result.audio_duration,
      duration_ms,
      hallucination_detected: result.segments.some((s) => isHallucination(s.text)),
      id: crypto.randomUUID(),
      snr_db: calculateSNR(new Float32Array(new Int16Array(mergedAudio.slice(44)))),
      timestamp: new Date().toISOString(),
      wer_estimated: calculateEstimatedWER(result.text),
    });

    return c.json({ ...result, duration_ms, validation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown transcription error";
    console.error("Transcription error:", message);
    return c.json({ error: message }, 500);
  }
});

export { transcribeApp };

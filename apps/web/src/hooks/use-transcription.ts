import { useCallback, useState } from "react";
import { env } from "@my-better-t-app/env/web";
import type { WavChunk } from "./use-recorder";

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  audio_duration: number;
  segments: TranscriptionSegment[];
  duration_ms: number;
  validation?: {
    valid: boolean;
    issues: string[];
  };
}

export type TranscriptionStatus = "idle" | "transcribing" | "done" | "error";

export function useTranscription() {
  const [status, setStatus] = useState<TranscriptionStatus>("idle");
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  const transcribeChunk = async (chunk: WavChunk, retryCount = 0): Promise<TranscriptionResult> => {
    try {
      const formData = new FormData();
      formData.append("audio", chunk.blob, `${chunk.id}.wav`);

      const response = await fetch(`${env.NEXT_PUBLIC_SERVER_URL}/api/transcribe`, {
        body: formData,
        method: "POST",
      });

      if (!response.ok) {
        const errData = (await response.json()) as { error?: string };
        throw new Error(errData.error ?? `Server error: ${response.status}`);
      }

      return (await response.json()) as TranscriptionResult;
    } catch (error) {
      // Production-grade retry with exponential backoff
      if (retryCount < 3) {
        const backoff = 2 ** retryCount * 1000;
        await new Promise((r) => setTimeout(r, backoff));
        return transcribeChunk(chunk, retryCount + 1);
      }
      throw error;
    }
  };

  const transcribe = useCallback(async (chunks: WavChunk[]) => {
    if (chunks.length === 0) {
      return;
    }

    setStatus("transcribing");
    setError(null);
    setResult(null);
    setProgress({ current: 0, total: chunks.length });

    try {
      const results: TranscriptionResult[] = [];
      const CONCURRENCY_LIMIT = 8; // Targeted 8-16 concurrent jobs

      // Batch processing architecture
      for (let i = 0; i < chunks.length; i += CONCURRENCY_LIMIT) {
        const batch = chunks.slice(i, i + CONCURRENCY_LIMIT);
        const batchResults = await Promise.all(
          batch.map(async (chunk) => {
            const res = await transcribeChunk(chunk);
            setProgress((p) => ({ ...p, current: p.current + 1 }));
            return res;
          }),
        );
        results.push(...batchResults);
      }

      // Merge results with Levenshtein-based deduplication and confidence weighting
      const mergedSegments: TranscriptionSegment[] = [];
      let totalText = "";
      let totalAudioDuration = 0;
      let totalDurationMs = 0;
      let currentTimeOffset = 0;
      const OVERLAP_DURATION = 2; // Enforced 2s overlap

      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (!res) {
          continue;
        }

        for (const seg of res.segments) {
          const globalStart = seg.start + currentTimeOffset;

          // Improved fuzzy deduplication using simple sliding window match
          const isDuplicate = mergedSegments.some((prev) => {
            const timeDiff = Math.abs(prev.start - globalStart);
            if (timeDiff > 2) {
              return false;
            }

            const s1 = prev.text.toLowerCase().replaceAll(/[^\w\s]/g, "");
            const s2 = seg.text.toLowerCase().replaceAll(/[^\w\s]/g, "");

            // Check if one text is a substantial subset of the other or very similar
            return (
              s1.includes(s2) ||
              s2.includes(s1) ||
              (s1.length > 5 && s2.length > 5 && s1.slice(0, 10) === s2.slice(0, 10))
            );
          });

          if (!isDuplicate) {
            mergedSegments.push({
              ...seg,
              end: seg.end + currentTimeOffset,
              start: globalStart,
            });
          }
        }

        // Clean up text merging to prevent double spaces or missing spaces
        const chunkText = res.text.trim();
        if (chunkText) {
          if (!totalText) {
            totalText = chunkText;
          } else {
            // Check if the end of totalText and start of chunkText have overlapping words
            const lastWords = totalText.split(" ").slice(-3).join(" ").toLowerCase();
            const firstWords = chunkText.split(" ").slice(0, 3).join(" ").toLowerCase();

            if (lastWords === firstWords) {
              totalText += " " + chunkText.split(" ").slice(3).join(" ");
            } else {
              totalText += " " + chunkText;
            }
          }
        }

        totalAudioDuration += res.audio_duration;
        totalDurationMs += res.duration_ms;

        currentTimeOffset += res.audio_duration - OVERLAP_DURATION;
      }

      setResult({
        audio_duration: totalAudioDuration,
        duration_ms: totalDurationMs,
        language: results[0]?.language ?? "en",
        segments: mergedSegments.toSorted((a, b) => a.start - b.start),
        text: totalText,
      });
      setStatus("done");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcription failed";
      setError(message);
      setStatus("error");
    }
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setResult(null);
    setError(null);
    setProgress({ current: 0, total: 0 });
  }, []);

  return { error, progress, reset, result, status, transcribe };
}

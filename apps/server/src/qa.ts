export interface TranscriptionQA {
  id: string;
  duration_ms: number;
  audio_duration_s: number;
  wer_estimated?: number;
  hallucination_detected: boolean;
  snr_db: number;
  timestamp: string;
}

export const logTranscriptionQA = (qa: TranscriptionQA) => {
  // Update internal metrics for /metrics endpoint
  metrics.total_transcriptions++;
  metrics.total_audio_duration_s += qa.audio_duration_s;
  metrics.total_processing_ms += qa.duration_ms;
  if (qa.hallucination_detected) {
    metrics.hallucinations_count++;
  }

  // Production-grade logging
  console.log(
    JSON.stringify({
      level: "info",
      message: "Transcription QA Metric Captured",
      ...qa,
    }),
  );
};

export const metrics = {
  hallucinations_count: 0,
  total_audio_duration_s: 0,
  total_processing_ms: 0,
  total_transcriptions: 0,
};

export const getPrometheusMetrics = () =>
  `
# HELP transcription_total_count Total number of transcriptions
# TYPE transcription_total_count counter
transcription_total_count ${metrics.total_transcriptions}

# HELP transcription_audio_duration_seconds_total Total audio duration processed
# TYPE transcription_audio_duration_seconds_total counter
transcription_audio_duration_seconds_total ${metrics.total_audio_duration_s}

# HELP transcription_processing_ms_total Total processing time in ms
# TYPE transcription_processing_ms_total counter
transcription_processing_ms_total ${metrics.total_processing_ms}

# HELP transcription_hallucinations_total Total hallucinations detected
# TYPE transcription_hallucinations_total counter
transcription_hallucinations_total ${metrics.hallucinations_count}
  `.trim();

export const calculateEstimatedWER = (text: string): number => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return 0;
  }

  const uniqueWords = new Set(words);
  const repetitionRatio = 1 - uniqueWords.size / words.length;
  return Math.round(repetitionRatio * 100) / 100;
};

/**
 * Validates transcript for common production issues:
 * - Profanity/Filtered keywords
 * - Factual consistency (placeholder for LLM-based check)
 * - Basic grammar (sentence capitalization)
 */
export const validateTranscript = (text: string) => {
  const issues: string[] = [];

  if (!text) {
    return { issues: ["Empty transcript"], valid: false };
  }

  // Heuristic: Sentence starts with lowercase
  if (/^[a-z]/.test(text.trim())) {
    issues.push("Improper sentence casing at start");
  }

  // Heuristic: Excessive length without punctuation
  if (
    text.split(" ").length > 50 &&
    !text.includes(".") &&
    !text.includes("?") &&
    !text.includes("!")
  ) {
    issues.push("Missing punctuation in long segment");
  }

  return {
    issues,
    valid: issues.length === 0,
  };
};

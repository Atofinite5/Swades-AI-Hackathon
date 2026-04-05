"use client";

import { useCallback, useRef, useState } from "react";
import { Download, Mic, Pause, Play, Square, Trash2, FileText, Loader2 } from "lucide-react";

import { Button } from "@my-better-t-app/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { useRecorder } from "@/hooks/use-recorder";
import { useTranscription } from "@/hooks/use-transcription";
import type { WavChunk } from "@/hooks/use-recorder";

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
}

function formatDuration(seconds: number) {
  return `${seconds.toFixed(1)}s`;
}

function ChunkRow({ chunk, index }: { chunk: WavChunk; index: number }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) {
      return;
    }
    if (playing) {
      el.pause();
      el.currentTime = 0;
      setPlaying(false);
    } else {
      el.play();
      setPlaying(true);
    }
  };

  const download = () => {
    const a = document.createElement("a");
    a.href = chunk.url;
    a.download = `chunk-${index + 1}.wav`;
    a.click();
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-muted/30 px-3 py-2">
      <audio ref={audioRef} src={chunk.url} onEnded={() => setPlaying(false)} preload="none" />
      <span className="text-xs font-medium text-muted-foreground tabular-nums">#{index + 1}</span>
      <span className="text-xs tabular-nums">{formatDuration(chunk.duration)}</span>
      <span className="text-[10px] text-muted-foreground">16kHz PCM</span>
      <div className="ml-auto flex gap-1">
        <Button variant="ghost" size="icon-xs" onClick={toggle}>
          {playing ? <Square className="size-3" /> : <Play className="size-3" />}
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={download}>
          <Download className="size-3" />
        </Button>
      </div>
    </div>
  );
}

export default function RecorderPage() {
  const [deviceId] = useState<string | undefined>();
  const { status, start, stop, pause, resume, chunks, elapsed, stream, clearChunks } = useRecorder({
    chunkDuration: 5,
    deviceId,
  });

  const {
    status: transcriptionStatus,
    result,
    error: transcriptionError,
    progress,
    transcribe,
    reset: resetTranscription,
  } = useTranscription();

  const isRecording = status === "recording";
  const isPaused = status === "paused";
  const isActive = isRecording || isPaused;

  const handlePrimary = useCallback(() => {
    if (isActive) {
      stop();
    } else {
      start();
    }
  }, [isActive, stop, start]);

  const handleTranscribe = useCallback(() => {
    if (chunks.length > 0) {
      transcribe(chunks);
    }
  }, [chunks, transcribe]);

  const handleClearAll = useCallback(() => {
    clearChunks();
    resetTranscription();
  }, [clearChunks, resetTranscription]);

  return (
    <div className="container mx-auto flex max-w-lg flex-col items-center gap-6 px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recorder</CardTitle>
          <CardDescription>16 kHz / 16-bit PCM WAV — chunked every 5 s</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {/* Waveform */}
          <div className="overflow-hidden rounded-sm border border-border/50 bg-muted/20 text-foreground">
            <LiveWaveform
              active={isRecording}
              processing={isPaused}
              stream={stream}
              height={80}
              barWidth={3}
              barGap={1}
              barRadius={2}
              sensitivity={1.8}
              smoothingTimeConstant={0.85}
              fadeEdges
              fadeWidth={32}
              mode="static"
            />
          </div>

          {/* Timer */}
          <div className="text-center font-mono text-3xl tabular-nums tracking-tight">
            {formatTime(elapsed)}
          </div>

          {/* Controls */}
          <div className="flex items-center justify-center gap-3">
            {/* Record / Stop */}
            <Button
              size="lg"
              variant={isActive ? "destructive" : "default"}
              className="gap-2 px-5"
              onClick={handlePrimary}
              disabled={status === "requesting"}
            >
              {isActive ? (
                <>
                  <Square className="size-4" />
                  Stop
                </>
              ) : (
                <>
                  <Mic className="size-4" />
                  {status === "requesting" ? "Requesting..." : "Record"}
                </>
              )}
            </Button>

            {/* Pause / Resume */}
            {isActive && (
              <Button
                size="lg"
                variant="outline"
                className="gap-2"
                onClick={isPaused ? resume : pause}
              >
                {isPaused ? (
                  <>
                    <Play className="size-4" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="size-4" />
                    Pause
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Chunks */}
      {chunks.length > 0 && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Chunks</CardTitle>
            <CardDescription>{chunks.length} recorded</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {chunks.map((chunk, i) => (
              <ChunkRow key={chunk.id} chunk={chunk} index={i} />
            ))}
            <div className="mt-2 flex gap-2">
              <Button
                variant="default"
                size="sm"
                className="gap-1.5"
                onClick={handleTranscribe}
                disabled={transcriptionStatus === "transcribing"}
              >
                {transcriptionStatus === "transcribing" ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    Transcribing {progress.current}/{progress.total}
                  </>
                ) : (
                  <>
                    <FileText className="size-3" />
                    Transcribe
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto gap-1.5 text-destructive"
                onClick={handleClearAll}
              >
                <Trash2 className="size-3" />
                Clear all
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Transcription Result */}
      {transcriptionStatus === "done" && result && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
            <CardDescription>
              {result.language.toUpperCase()} • {result.audio_duration.toFixed(1)}s audio •{" "}
              {result.duration_ms}ms processing • {result.segments.length} segments
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* Full Text */}
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{result.text}</p>
            </div>

            {/* Validation Issues */}
            {result.validation && !result.validation.valid && (
              <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
                <p className="text-xs font-medium text-yellow-600 dark:text-yellow-400">
                  Quality Issues:
                </p>
                <ul className="mt-1 list-inside list-disc text-xs text-yellow-600/80 dark:text-yellow-400/80">
                  {result.validation.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Segments */}
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                View Segments ({result.segments.length})
              </summary>
              <div className="mt-2 flex flex-col gap-1">
                {result.segments.map((seg, i) => (
                  <div
                    key={i}
                    className="flex gap-2 rounded-sm border border-border/30 bg-muted/20 px-2 py-1.5 text-xs"
                  >
                    <span className="font-mono text-muted-foreground tabular-nums">
                      {seg.start.toFixed(1)}s - {seg.end.toFixed(1)}s
                    </span>
                    <span className="flex-1">{seg.text}</span>
                  </div>
                ))}
              </div>
            </details>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(result.text);
                }}
              >
                Copy Text
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const srt = result.segments
                    .map((seg, i) => {
                      const formatTime = (seconds: number) => {
                        const h = Math.floor(seconds / 3600);
                        const m = Math.floor((seconds % 3600) / 60);
                        const s = Math.floor(seconds % 60);
                        const ms = Math.floor((seconds % 1) * 1000);
                        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
                      };
                      return `${i + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text}\n`;
                    })
                    .join("\n");
                  const blob = new Blob([srt], { type: "text/plain" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "transcript.srt";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download SRT
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Transcription Error */}
      {transcriptionStatus === "error" && transcriptionError && (
        <Card className="w-full border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Transcription Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{transcriptionError}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={resetTranscription}>
              Try Again
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

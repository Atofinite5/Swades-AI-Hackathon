"use client";

import { useCallback } from "react";
import {
  CheckCircle2,
  Download,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";

import { Button } from "@my-better-t-app/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { useOpfsRecorder } from "@/hooks/use-opfs-recorder";
import type { ChunkMeta } from "@/hooks/use-opfs-recorder";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${ms}`;
}

function StatusIcon({ status }: { status: ChunkMeta["uploadStatus"] }) {
  if (status === "done") return <CheckCircle2 className="size-3 text-green-500" />;
  if (status === "failed") return <XCircle className="size-3 text-destructive" />;
  if (status === "uploading") return <Loader2 className="size-3 animate-spin text-blue-500" />;
  return <RefreshCw className="size-3 text-muted-foreground" />;
}

function ChunkRow({ chunk, index }: { chunk: ChunkMeta; index: number }) {
  const download = () => {
    if (!chunk.blobUrl) return;
    const a = document.createElement("a");
    a.href = chunk.blobUrl;
    a.download = `chunk-${index + 1}.wav`;
    a.click();
  };

  return (
    <div className="flex items-center gap-3 rounded-sm border border-border/50 bg-muted/30 px-3 py-2">
      <StatusIcon status={chunk.uploadStatus} />
      <span className="text-xs font-medium text-muted-foreground tabular-nums">#{index + 1}</span>
      <span className="text-xs tabular-nums">{chunk.duration.toFixed(1)}s</span>
      <span className="text-[10px] text-muted-foreground">{(chunk.size / 1024).toFixed(0)} KB</span>
      {chunk.transcript && (
        <span className="flex-1 truncate text-[10px] text-muted-foreground italic">
          {chunk.transcript}
        </span>
      )}
      {chunk.errorMsg && !chunk.transcript && (
        <span className="flex-1 truncate text-[10px] text-destructive" title={chunk.errorMsg}>
          {chunk.errorMsg}
        </span>
      )}
      {chunk.retries > 0 && (
        <span className="text-[10px] text-yellow-500">retry {chunk.retries}</span>
      )}
      {chunk.blobUrl && (
        <Button variant="ghost" size="icon-xs" onClick={download} className="ml-auto">
          <Download className="size-3" />
        </Button>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecorderPage() {
  const {
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
  } = useOpfsRecorder(5);

  const isRecording = status === "recording";
  const isPaused = status === "paused";
  const isActive = isRecording || isPaused;

  const handlePrimary = useCallback(() => {
    if (isActive) stop();
    else start();
  }, [isActive, stop, start]);

  return (
    <div className="container mx-auto flex max-w-lg flex-col items-center gap-6 px-4 py-8">
      {/* Recovery banner */}
      {recovering && (
        <div className="flex w-full items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-sm text-blue-600 dark:text-blue-400">
          <Loader2 className="size-3 animate-spin" />
          Recovering unfinished uploads from previous session…
        </div>
      )}

      {/* Recorder card */}
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recorder</CardTitle>
          <CardDescription>
            16 kHz · 16-bit PCM WAV · 5 s chunks · 0.5 s overlap · OPFS-backed
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {/* Waveform */}
          <div className="overflow-hidden rounded-sm border border-border/50 bg-muted/20">
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
            <Button
              size="lg"
              variant={isActive ? "destructive" : "default"}
              className="gap-2 px-5"
              onClick={handlePrimary}
              disabled={status === "requesting" || status === "stopping"}
            >
              {status === "requesting" ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Requesting…
                </>
              ) : status === "stopping" ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Stopping…
                </>
              ) : isActive ? (
                <>
                  <Square className="size-4" /> Stop
                </>
              ) : (
                <>
                  <Mic className="size-4" /> Record
                </>
              )}
            </Button>

            {isActive && (
              <Button
                size="lg"
                variant="outline"
                className="gap-2"
                onClick={isPaused ? resume : pause}
              >
                {isPaused ? (
                  <>
                    <Play className="size-4" /> Resume
                  </>
                ) : (
                  <>
                    <Pause className="size-4" /> Pause
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Chunk list */}
      {chunks.length > 0 && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Chunks</CardTitle>
            <CardDescription className="flex gap-3 text-xs">
              <span>{chunks.length} total</span>
              {doneCount > 0 && (
                <span className="text-green-600 dark:text-green-400">{doneCount} uploaded</span>
              )}
              {pendingCount > 0 && (
                <span className="text-blue-600 dark:text-blue-400">{pendingCount} pending</span>
              )}
              {failedCount > 0 && <span className="text-destructive">{failedCount} failed</span>}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {chunks.map((chunk, i) => (
              <ChunkRow key={`${chunk.sessionId}-${chunk.index}`} chunk={chunk} index={i} />
            ))}
            <div className="mt-2 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-destructive"
                onClick={clearChunks}
              >
                <Trash2 className="size-3" />
                Clear all
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Full transcript */}
      {fullTranscript && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
            <CardDescription>
              Built live as chunks are acknowledged · {doneCount} / {chunks.length} chunks
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{fullTranscript}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => navigator.clipboard.writeText(fullTranscript)}
            >
              Copy
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

# Modern Chunked Recording Pipeline

Zero-loss audio recording with real-time transcription. Every chunk is durably stored in the browser before any network call. Transcription never blocks upload. Reconciliation heals any gap between client, bucket, and database automatically.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  BROWSER (per user tab)                                                  │
│                                                                          │
│  ┌──────────────┐   PCM frames    ┌─────────────────────────────────┐   │
│  │  Microphone  │ ─────────────►  │  AudioWorklet                   │   │
│  │  (getUserMedia)│               │  RecorderProcessor               │   │
│  └──────────────┘                 │  • batches 4096 samples (~85ms) │   │
│                                   │  • zero-copy Transferable        │   │
│                                   └──────────────┬──────────────────┘   │
│                                                  │ Float32Array          │
│                                                  ▼                       │
│                                   ┌─────────────────────────────────┐   │
│                                   │  useOpfsRecorder (main thread)  │   │
│                                   │  • resample to 16 kHz           │   │
│                                   │  • accumulate until 5s chunk    │   │
│                                   │  • prepend 0.5s overlap         │   │
│                                   │  • encode to WAV (16-bit mono)  │   │
│                                   └──────────────┬──────────────────┘   │
│                                                  │ ArrayBuffer           │
│                                       ┌──────────┘                       │
│                                       │  WRITE (zero-copy transfer)      │
│                                       ▼                                  │
│                          ┌────────────────────────┐                     │
│                          │  OPFS Worker            │                     │
│                          │  (serialized queue)     │                     │
│                          │                         │                     │
│                          │  sessions/              │                     │
│                          │  └── {sessionId}/       │                     │
│                          │      ├── manifest.json  │                     │
│                          │      ├── chunk-00000.wav│                     │
│                          │      └── chunk-00001.wav│                     │
│                          │                         │                     │
│                          │  SyncAccessHandle write │  ◄─ durable before  │
│                          │  (fastest possible I/O) │     any network call│
│                          └────────────┬────────────┘                     │
│                                       │ ack: WRITE_CHUNK ok              │
│                                       ▼                                  │
│                          ┌────────────────────────┐                     │
│                          │  Upload Queue           │                     │
│                          │  CONCURRENCY = 1        │                     │
│                          │  (sequential, one Groq  │                     │
│                          │   request at a time)    │                     │
│                          └────────────┬────────────┘                     │
└───────────────────────────────────────┼─────────────────────────────────┘
                                        │
                            POST /api/chunks/upload
                            multipart/form-data
                            • audio (WAV blob)
                            • sessionId
                            • chunkIndex
                            • filename
                            • durationS
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  SERVER  (Bun + Hono, port 3000)                                         │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  POST /api/chunks/upload                                          │   │
│  │                                                                   │   │
│  │  1. Parse multipart body                                          │   │
│  │  2. Validate: audio ≥ 44 bytes, sessionId, chunkIndex, filename  │   │
│  │  3. ──────────────────────────────────────────────────────────   │   │
│  │     UPLOAD TO MINIO (must succeed — source of truth)             │   │
│  │     key: sessions/{sessionId}/{filename}                         │   │
│  │     PUT Object → MinIO :9000                                     │   │
│  │     if fail → 500, client retries with backoff                   │   │
│  │  4. ──────────────────────────────────────────────────────────   │   │
│  │     UPSERT recording_sessions (FK safety, ON CONFLICT NOTHING)   │   │
│  │  5. ──────────────────────────────────────────────────────────   │   │
│  │     INSERT recording_chunks (ackedAt=now, transcript=null)       │   │
│  │     ON CONFLICT (sessionId, chunkIndex) DO UPDATE               │   │
│  │  6. ──────────────────────────────────────────────────────────   │   │
│  │     TRANSCRIPTION RACE (8 000 ms timeout)                        │   │
│  │                                                                   │   │
│  │     activeTranscriptions < 5 ?                                   │   │
│  │           │ yes                      │ no                        │   │
│  │           ▼                          ▼                           │   │
│  │     Promise.race([               skip, return text: ""           │   │
│  │       transcribeWithGroq(),                                      │   │
│  │       timeout(8s)                                                │   │
│  │     ])                                                           │   │
│  │           │                                                       │   │
│  │     Groq wins (<8s)       Timeout wins (>8s)                     │   │
│  │           │                     │                                │   │
│  │     transcript = text    transcript = ""                         │   │
│  │     UPDATE DB row        background: when Groq finishes          │   │
│  │                          → UPDATE DB row (late transcript)       │   │
│  │                                                                   │   │
│  │  7. Return 200 immediately ◄──── never waits for Groq to block   │   │
│  │     { ackedAt, bucketKey, chunkIndex, sessionId, text }          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌────────────────────┐   ┌────────────────────┐                        │
│  │  MinIO  :9000       │   │  PostgreSQL  :5433  │                       │
│  │  bucket: audio-chunks│  │  recording_sessions │                       │
│  │  path-style: true  │   │  recording_chunks   │                       │
│  │  S3-compatible     │   │  (Drizzle ORM)      │                       │
│  └────────────────────┘   └────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────────┘
                                        │
                              200 OK: { text, bucketKey, ackedAt }
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  BROWSER — after 200 ack                                                 │
│                                                                          │
│  ACK_CHUNK → OPFS worker                                                 │
│    chunk.uploadStatus = "done"                                           │
│    chunk.ackedAt = now                                                   │
│    if all chunks done → remove session dir (OPFS auto-cleanup)          │
│                                                                          │
│  updateChunkStatus(index, "done", text)                                  │
│  → fullTranscript = chunks.sort(index).map(c.transcript).join(" ")      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Transcription Pipeline

```
                    audioBuffer (WAV, 16 kHz, 16-bit mono)
                              │
                              ▼
                 ┌─────────────────────────┐
                 │   transcribeWithGroq()   │
                 │                         │
                 │  FormData:              │
                 │  • file: blob           │
                 │  • model: whisper-      │
                 │    large-v3-turbo        │
                 │  • language: en         │
                 │  • response_format:     │
                 │    verbose_json          │
                 │  • temperature: 0       │
                 │  • prompt: English      │
                 │    context hint         │
                 └────────────┬────────────┘
                              │
                    POST api.groq.com
                    /openai/v1/audio/transcriptions
                              │
                   ┌──────────┴──────────┐
                   │                     │
               200 OK                429 Rate Limit
                   │                     │
                   ▼                     ▼
          verbose_json response    attempt < 2 ?
          {                              │
            segments: [...],        yes  │  no
            text, language,         │    │
            duration                ▼    ▼
          }                    wait    throw
                               Retry-After     (client catches →
                               (1–60s,          transcript = "")
                               NaN → 15s)
                               retry
                                   │
              ┌────────────────────┘
              │
              ▼
     Per-segment filtering:
     ┌─────────────────────────────────────┐
     │  deduplicate (avg_logprob < -0.3)   │
     │  filter no_speech_prob ≥ 0.45       │
     │  filter avg_logprob ≤ -1.0          │
     │  filter hallucination patterns      │
     │    ("thank you", "bye", "hmm"...)   │
     └──────────────────┬──────────────────┘
                        │
                        ▼
              filteredSegments[]
              fullText = segments.map(s.text).join(" ")
                        │
                        ▼
              { text, language, audio_duration, segments }
```

### Transcription Guarantees

| Condition | Behaviour |
|-----------|-----------|
| Groq responds < 8s | Transcript included in upload ack response |
| Groq responds > 8s (slow) | Client gets `text: ""` immediately; DB updated when Groq finishes |
| Groq 429 rate limit | Waits `Retry-After` seconds (clamped 1–60s), retries up to 2× |
| 3× 429 exhausted | Error thrown; caught by best-effort wrapper; `transcript = null` in DB |
| >5 concurrent Groq calls | Excess requests skip transcription; chunk still fully acked |
| Groq down entirely | Upload + bucket + DB all succeed; transcript stays null |

---

## Recovery & Reconciliation

On every browser mount, the client checks OPFS for sessions that never fully uploaded:

```
Browser mount
      │
      ▼
GET_PENDING_SESSIONS (OPFS worker)
  → sessions with uploadStatus "pending" or "failed"
      │
      ▼
POST /api/chunks/reconcile
  body: { sessionId, chunks: [{ index, filename }, ...] }
      │
      ▼
Server checks each chunk:
  ┌──────────────────────────────────────────────────────┐
  │  for each client chunk:                              │
  │                                                      │
  │  DB.ackedAt exists?                                  │
  │    no  → needsUpload.push(index)                     │
  │    yes → HeadObject(bucketKey) in MinIO?             │
  │            no  → needsUpload.push(index)             │
  │            yes → alreadyDone.push({ index, transcript }) │
  └──────────────────────────────────────────────────────┘
      │
      ▼
{ needsUpload: [2, 5], alreadyDone: [0, 1, 3, 4] }
      │
      ├── alreadyDone → ACK_CHUNK in OPFS + add to UI state (with transcript)
      │
      └── needsUpload → enqueue for upload with exponential backoff
                        1s → 2s → 4s (MAX_RETRIES = 3)
```

---

## Failure Modes & Guarantees

```
Failure Point          What Happens                          Recovery
─────────────────────  ────────────────────────────────────  ───────────────────────────
Tab closes mid-record  WAV already in OPFS                   On re-open: reconcile + re-upload
Network drops          Upload fails → backoff retry           Up to 3 retries, then "failed" state
MinIO down             500 → client retries (bucket = truth)  Chunk stays in OPFS until MinIO up
Groq 429              Server waits Retry-After (1-60s)        Up to 2 retries; transcript null if all fail
Groq slow (>8s)        Response returned immediately          Late transcript written to DB async
DB write fails         500 → client retries                   Bucket already written; re-upload is idempotent
Bucket purge           reconcile detects HeadObject miss      needsUpload → re-upload from OPFS
Duplicate upload       ON CONFLICT DO UPDATE (idempotent)     Safe, no double-write
Session FK race        Server upserts session before chunk    FK constraint never violated
```

---

## Database Schema

```sql
-- recording_sessions
CREATE TABLE recording_sessions (
  id           UUID PRIMARY KEY,
  started_at   TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  created_at   TIMESTAMP DEFAULT NOW() NOT NULL
);

-- recording_chunks
CREATE TABLE recording_chunks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID REFERENCES recording_sessions(id) NOT NULL,
  chunk_index        INTEGER NOT NULL,
  filename           TEXT NOT NULL,
  bucket_key         TEXT,                    -- MinIO object key
  bucket_uploaded_at TIMESTAMP,
  acked_at           TIMESTAMP,               -- set once bucket + DB both confirmed
  duration_s         REAL,
  size_bytes         INTEGER,
  transcript         TEXT,                    -- null until Groq responds
  created_at         TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE (session_id, chunk_index)            -- idempotent re-uploads
);
```

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | Next.js 16 (App Router) | `/recorder` page |
| Backend | Hono on Bun | Native Bun server — NOT `@hono/node-server` |
| Audio capture | AudioWorklet + RecorderProcessor | 4096-sample batches, zero-copy Transferable |
| Client buffer | OPFS (Origin Private File System) | SyncAccessHandle writes, serialized queue |
| Object storage | MinIO (S3-compatible) | `forcePathStyle: true`, port 9000 |
| Database | PostgreSQL + Drizzle ORM | Port 5433 (Docker), avoids conflict with system postgres |
| Transcription | Groq Whisper large-v3-turbo | verbose_json, segment filtering, 5-slot semaphore |
| Monorepo | Turborepo + Bun workspaces | `apps/web`, `apps/server`, `packages/*` |
| Env validation | @t3-oss/env-core + Zod | Type-safe, fails fast on missing vars |

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Docker](https://docker.com) (for Postgres + MinIO)
- Groq API key — [console.groq.com](https://console.groq.com)

### 1. Install

```bash
bun install
```

### 2. Start infrastructure

```bash
cd packages/db
docker compose up -d
# starts: postgres on :5433, minio on :9000, creates audio-chunks bucket
```

### 3. Environment

```bash
cp .env.example .env
# then set GROQ_API_KEY in apps/server/.env
```

Required variables:

```env
# apps/server/.env
GROQ_API_KEY=gsk_...
DATABASE_URL=postgresql://postgres:password@localhost:5433/my-better-t-app
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=audio-chunks
CORS_ORIGIN=http://localhost:3001

# apps/web/.env.local
NEXT_PUBLIC_SERVER_URL=http://localhost:3000
```

### 4. Push DB schema

```bash
bun run db:push
```

### 5. Run

```bash
bun run dev
```

- Web app: [http://localhost:3001/recorder](http://localhost:3001/recorder)
- API server: [http://localhost:3000](http://localhost:3000)

---

## API Reference

### `POST /api/chunks/sessions`

Initialise a recording session in the database. Fire-and-forget from client — upload handler also upserts the session as a safety net.

```json
{ "sessionId": "uuid", "startedAt": "2026-04-08T10:00:00Z" }
```

### `POST /api/chunks/upload`

Upload one WAV chunk. Multipart form-data.

| Field | Type | Description |
|-------|------|-------------|
| `audio` | File (WAV) | Raw audio, 16 kHz mono, min 44 bytes |
| `sessionId` | string | UUID |
| `chunkIndex` | number | 0-based position in session |
| `filename` | string | `chunk-00000.wav` |
| `durationS` | number | Duration in seconds |

**Response:**

```json
{
  "ackedAt": "2026-04-08T10:00:05.123Z",
  "audio_duration": 5.0,
  "bucketKey": "sessions/{sessionId}/chunk-00000.wav",
  "chunkIndex": 0,
  "language": "en",
  "sessionId": "uuid",
  "text": "Hello world this is the transcript"
}
```

`text` is `""` if Groq timed out or was at capacity — the DB row is updated async.

### `POST /api/chunks/reconcile`

Compare what the client has in OPFS against what the server has in bucket + DB.

```json
{
  "sessionId": "uuid",
  "chunks": [{ "index": 0, "filename": "chunk-00000.wav" }]
}
```

**Response:**

```json
{
  "needsUpload": [2, 5],
  "alreadyDone": [
    { "index": 0, "transcript": "Hello world" },
    { "index": 1, "transcript": "This is chunk one" }
  ]
}
```

---

## Load Testing

```
Target: 300 concurrent users × 1 chunk / 5s = 60 uploads/s sustained
```

Each upload does:
1. MinIO PutObject (~10–50ms local)
2. Postgres upsert × 2 (~5ms each)
3. Groq call (async, non-blocking on response path)

Server-side limits:
- Max 5 concurrent Groq transcription calls (semaphore)
- Groq free tier: 20 RPM / paid: 100–200 RPM — transcripts degrade gracefully under load, uploads never block

### k6 script

```js
import http from "k6/http";
import { check, sleep } from "k6";
import { FormData } from "https://jslib.k6.io/formdata/0.0.2/index.js";
import { randomBytes } from "k6/crypto";

export const options = {
  scenarios: {
    chunk_uploads: {
      executor: "constant-arrival-rate",
      rate: 60,          // 60 uploads/s (300 users × 1 chunk/5s)
      timeUnit: "1s",
      duration: "5m",
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
};

export default function () {
  const sessionId = `test-session-${__VU}`;
  const chunkIndex = __ITER;
  const filename = `chunk-${String(chunkIndex).padStart(5, "0")}.wav`;

  // Minimal valid WAV header (44 bytes) + 16000 samples of silence
  const wavHeader = new Uint8Array(44 + 32000);
  // RIFF header
  wavHeader.set([0x52,0x49,0x46,0x46], 0); // "RIFF"
  wavHeader.set([0x57,0x41,0x56,0x45], 8); // "WAVE"

  const fd = new FormData();
  fd.append("audio", http.file(wavHeader.buffer, filename, "audio/wav"));
  fd.append("sessionId", sessionId);
  fd.append("chunkIndex", String(chunkIndex));
  fd.append("filename", filename);
  fd.append("durationS", "2.0");

  const res = http.post("http://localhost:3000/api/chunks/upload", fd.body(), {
    headers: { "Content-Type": "multipart/form-data; boundary=" + fd.boundary },
    timeout: "15s",
  });

  check(res, {
    "status 200": (r) => r.status === 200,
    "has ackedAt": (r) => JSON.parse(r.body).ackedAt !== undefined,
  });

  sleep(5); // simulate real user cadence
}
```

### What to validate after load test

```bash
# Verify every DB ack has a matching MinIO object
# In psql:
SELECT session_id, chunk_index, bucket_key
FROM recording_chunks
WHERE acked_at IS NOT NULL
  AND bucket_key IS NOT NULL;

# Cross-check with MinIO (via mc):
mc ls local/audio-chunks --recursive | wc -l
# should match the row count above

# Check for orphaned DB acks (no bucket object):
# Run a reconcile request for each session and verify needsUpload is empty
```

---

## Project Structure

```
Swades-AI-Hackathon/
├── apps/
│   ├── web/                         # Next.js frontend
│   │   ├── src/
│   │   │   └── hooks/
│   │   │       └── use-opfs-recorder.ts   # Recording + OPFS + upload queue
│   │   └── public/
│   │       ├── recorder-processor.js       # AudioWorklet (4096-sample batcher)
│   │       └── opfs-worker.js              # OPFS serialized message handler
│   └── server/                      # Hono API server (Bun)
│       └── src/
│           ├── index.ts             # App setup, CORS, routes
│           ├── chunks.ts            # /api/chunks — upload, reconcile, sessions
│           ├── transcribe.ts        # Groq Whisper client + segment filtering
│           ├── bucket.ts            # MinIO S3 client (PutObject, HeadObject)
│           └── qa.ts                # Transcript quality metrics
├── packages/
│   ├── db/
│   │   ├── src/
│   │   │   ├── schema/index.ts      # Drizzle table definitions
│   │   │   └── index.ts             # db singleton + exports
│   │   └── docker-compose.yml       # Postgres :5433 + MinIO :9000
│   └── env/
│       └── src/
│           ├── server.ts            # Server env schema (Zod)
│           └── web.ts               # Client env schema (Zod)
```

---

## Available Scripts

```bash
bun run dev              # Start all apps (web + server) in watch mode
bun run build            # Build all apps
bun run dev:web          # Start only the web app
bun run dev:server       # Start only the API server
bun run check-types      # TypeScript type check across all packages
bun run db:push          # Push Drizzle schema to database (no migration files)
bun run db:generate      # Generate migration SQL files
bun run db:migrate       # Apply pending migrations
bun run db:studio        # Open Drizzle Studio (local DB browser)
```

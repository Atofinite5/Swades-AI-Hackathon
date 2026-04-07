/**
 * OPFS Worker — Origin Private File System
 *
 * Key design decisions:
 *  1. Root handle is cached — no repeated navigator.storage.getDirectory() calls.
 *  2. Message queue is serialised — handlers never interleave, so manifest
 *     read-modify-write is always atomic (no race conditions).
 *  3. READ_CHUNK uses FileSystemSyncAccessHandle for zero-copy reads.
 *  4. Auto-cleanup: once all chunks in a session are acked, the session
 *     directory is removed from OPFS.
 *
 * OPFS layout:
 *   sessions/
 *     {sessionId}/
 *       manifest.json
 *       chunk-00000.wav
 *       chunk-00001.wav
 *       ...
 */

// ─── Root cache ───────────────────────────────────────────────────────────────

let _root = null;

async function getRoot() {
  if (!_root) _root = await navigator.storage.getDirectory();
  return _root;
}

async function getSessionDir(sessionId, create = false) {
  const root = await getRoot();
  const sessions = await root.getDirectoryHandle("sessions", { create: true });
  return sessions.getDirectoryHandle(sessionId, { create });
}

// ─── Manifest helpers ─────────────────────────────────────────────────────────

async function readManifest(sessionDir) {
  try {
    const fh = await sessionDir.getFileHandle("manifest.json");
    const file = await fh.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function writeManifest(sessionDir, manifest) {
  const fh = await sessionDir.getFileHandle("manifest.json", { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(manifest));
  await writable.close();
}

function pad(n, len = 5) {
  return String(n).padStart(len, "0");
}

// ─── Auto-cleanup helper ──────────────────────────────────────────────────────

async function maybeCleanupSession(sessionDir, sessionId) {
  const manifest = await readManifest(sessionDir);
  if (!manifest) return;
  const allDone = manifest.chunks.every((c) => c.uploadStatus === "done");
  if (!allDone) return;

  try {
    const root = await getRoot();
    const sessionsDir = await root.getDirectoryHandle("sessions");
    await sessionsDir.removeEntry(sessionId, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

const handlers = {
  async INIT_SESSION({ sessionId, startedAt }) {
    const sessionDir = await getSessionDir(sessionId, true);
    await writeManifest(sessionDir, {
      sessionId,
      startedAt,
      completedAt: null,
      totalChunks: 0,
      chunks: [],
    });
    return { sessionId };
  },

  async WRITE_CHUNK({ sessionId, index, wavBuffer, duration, timestamp, sampleRate }) {
    const sessionDir = await getSessionDir(sessionId, true);
    const filename = `chunk-${pad(index)}.wav`;

    // Write WAV using sync access handle — fastest possible OPFS write
    const fh = await sessionDir.getFileHandle(filename, { create: true });
    let sync;
    try {
      sync = await fh.createSyncAccessHandle();
      sync.truncate(0);
      sync.write(new DataView(wavBuffer), { at: 0 });
      sync.flush();
    } finally {
      sync?.close();
    }

    // Update manifest
    const manifest = await readManifest(sessionDir);
    if (!manifest) throw new Error(`No manifest for session ${sessionId} — was INIT_SESSION called?`);
    manifest.chunks.push({
      index,
      filename,
      duration,
      timestamp,
      sampleRate: sampleRate ?? 16000,
      size: wavBuffer.byteLength,
      uploadStatus: "pending",
      retries: 0,
      ackedAt: null,
    });
    manifest.totalChunks = manifest.chunks.length;
    await writeManifest(sessionDir, manifest);

    return { filename, size: wavBuffer.byteLength };
  },

  async READ_CHUNK({ sessionId, filename }) {
    const sessionDir = await getSessionDir(sessionId);
    const fh = await sessionDir.getFileHandle(filename);
    // Async API — compatible with all supporting browsers, no exclusive lock needed
    const file = await fh.getFile();
    const buffer = await file.arrayBuffer();
    return { buffer };
  },

  async SET_UPLOADING({ sessionId, index }) {
    const sessionDir = await getSessionDir(sessionId);
    const manifest = await readManifest(sessionDir);
    const chunk = manifest?.chunks.find((c) => c.index === index);
    if (chunk) chunk.uploadStatus = "uploading";
    if (manifest) await writeManifest(sessionDir, manifest);
    return { index };
  },

  async ACK_CHUNK({ sessionId, index }) {
    const sessionDir = await getSessionDir(sessionId);
    const manifest = await readManifest(sessionDir);
    const chunk = manifest?.chunks.find((c) => c.index === index);
    if (chunk) {
      chunk.uploadStatus = "done";
      chunk.ackedAt = new Date().toISOString();
    }
    if (manifest) await writeManifest(sessionDir, manifest);
    // Clean up OPFS if every chunk is now done
    await maybeCleanupSession(sessionDir, sessionId);
    return { index };
  },

  async FAIL_CHUNK({ sessionId, index }) {
    const sessionDir = await getSessionDir(sessionId);
    const manifest = await readManifest(sessionDir);
    const chunk = manifest?.chunks.find((c) => c.index === index);
    if (chunk) {
      chunk.uploadStatus = "failed";
      chunk.retries = (chunk.retries ?? 0) + 1;
    }
    if (manifest) await writeManifest(sessionDir, manifest);
    return { index };
  },

  async CLOSE_SESSION({ sessionId }) {
    const sessionDir = await getSessionDir(sessionId);
    const manifest = await readManifest(sessionDir);
    if (manifest) {
      manifest.completedAt = new Date().toISOString();
      await writeManifest(sessionDir, manifest);
    }
    return { sessionId };
  },

  async GET_PENDING_SESSIONS() {
    let sessionsDir;
    try {
      const root = await getRoot();
      sessionsDir = await root.getDirectoryHandle("sessions");
    } catch {
      return { sessions: [] };
    }
    const sessions = [];
    for await (const [, dirHandle] of sessionsDir) {
      const manifest = await readManifest(dirHandle);
      if (!manifest) continue;
      const hasPending = manifest.chunks.some(
        (c) => c.uploadStatus === "pending" || c.uploadStatus === "failed",
      );
      if (hasPending) sessions.push(manifest);
    }
    return { sessions };
  },

  async GET_STATS() {
    const est = await navigator.storage.estimate();
    return { usedBytes: est.usage ?? 0, quotaBytes: est.quota ?? 0 };
  },
};

// ─── Serialised message queue (prevents manifest race conditions) ──────────────

let _queue = Promise.resolve();

self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  // Chain onto the queue so handlers never run concurrently
  _queue = _queue.then(async () => {
    try {
      const handler = handlers[type];
      if (!handler) throw new Error(`Unknown OPFS message: ${type}`);
      const result = await handler(payload ?? {});
      // Transfer any ArrayBuffer in the result to avoid a structured-clone copy
      const transfers = result?.buffer instanceof ArrayBuffer ? [result.buffer] : [];
      self.postMessage({ id, ok: true, ...result }, transfers);
    } catch (err) {
      self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
    }
  });
};

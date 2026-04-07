/**
 * RecorderProcessor — AudioWorklet
 *
 * Batches raw input frames before posting to the main thread.
 * Default batch: 4096 samples ≈ 85 ms at 48 kHz → ~12 messages/sec
 * instead of one per 128-sample quantum (375 messages/sec).
 *
 * Sends Float32Array via Transferable (zero-copy across threads).
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this._batchSize = options?.processorOptions?.batchSize ?? 4096;
    this._buffer = [];
    this._count = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    this._buffer.push(channel.slice());
    this._count += channel.length;

    if (this._count >= this._batchSize) {
      const merged = new Float32Array(this._count);
      let offset = 0;
      for (const frame of this._buffer) {
        merged.set(frame, offset);
        offset += frame.length;
      }
      this._buffer = [];
      this._count = 0;
      // Transfer ownership — zero-copy from worklet thread to main thread
      this.port.postMessage({ samples: merged }, [merged.buffer]);
    }

    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);

/**
 * QR-Stream Pro — Reception Session
 */

class ReceiverSession {
  constructor() {
    this.streamId = null;
    this.K = 0;
    this.blockSize = 0;
    this.decoder = null;
    this.manifest = null;
    this.completed = false;
    this.receivedBlocks = 0;
  }

  /**
   * Ingest a decoded QR payload (Uint8Array).
   * Returns { status, progress, result? }
   */
  ingest(bytes) {
    if (this.completed) return { status: 'complete' };

    const frame = decodeFrame(bytes);
    if (!frame) return { status: 'ignored' };

    // New stream: reset
    if (frame.streamId !== this.streamId) {
      if (this.streamId !== null && this.decoder && !this.decoder.isComplete()) {
        // Ignore different stream if we're mid-transfer
        return { status: 'ignored' };
      }
      this._reset(frame.streamId);
    }

    if (frame.type === 'manifest') {
      this.manifest = frame;
      if (!this.decoder && frame.K > 0 && frame.blockSize > 0) {
        this._initDecoder(frame.K, frame.blockSize);
      }
      return { status: 'manifest' };
    }

    if (frame.type === 'block') {
      if (!this.decoder) {
        this._initDecoder(frame.K, frame.blockSize);
      }
      const wasComplete = this.decoder.isComplete();
      const symIndices = this._recoverIndices(frame.seed, frame.K);
      this.decoder.addSymbol(frame.seed, symIndices, frame.data);
      this.receivedBlocks = this.decoder.recoveredCount;

      if (!wasComplete && this.decoder.isComplete()) {
        return this._finalize();
      }
      return { status: 'block', progress: this.receivedBlocks / this.K };
    }

    return { status: 'ignored' };
  }

  _reset(streamId) {
    this.streamId = streamId;
    this.K = 0;
    this.blockSize = 0;
    this.decoder = null;
    this.manifest = null;
    this.completed = false;
    this.receivedBlocks = 0;
  }

  _initDecoder(K, blockSize) {
    if (K <= 0 || blockSize <= 0 || K > 65535) return;
    this.K = K;
    this.blockSize = blockSize;
    this.decoder = new LtDecoder(K, blockSize);
  }

  /**
   * Reconstruct which source block indices a seed refers to.
   * Must match the encoder's degree distribution exactly.
   */
  _recoverIndices(seed, K) {
    if (seed < K) return [seed]; // systematic
    const cdf = buildDegreeDistribution(K);
    const rand = splitmix32(seed);
    const degree = sampleDegree(cdf, rand);
    const indices = [];
    const used = new Set();
    for (let i = 0; i < degree; i++) {
      let idx;
      do { idx = rand() % K; } while (used.has(idx) && used.size < K);
      used.add(idx);
      indices.push(idx);
    }
    return indices;
  }

  async _finalize() {
    this.completed = true;
    let data = this.decoder.getPayload();

    // Decrypt if needed
    if (this.manifest && (this.manifest.flags & 0x02)) {
      if (!this._password) {
        return { status: 'need_password' };
      }
      try {
        data = await decryptPayload(data, this._password, this.streamId);
      } catch (e) {
        return { status: 'error', error: e.message };
      }
    }

    // Decompress if needed
    if (this.manifest && (this.manifest.flags & 0x01)) {
      try {
        data = await inflate(data);
      } catch (e) {
        return { status: 'error', error: 'Decompression failed' };
      }
    }

    // Trim to original size (manifest payloadCrc is over original)
    // Actually we don't know original size from manifest; we stored CRC.
    // The decompressed data should be the original. Verify CRC.
    if (this.manifest && this.manifest.payloadCrc) {
      const actualCrc = crc32(data);
      if (actualCrc !== this.manifest.payloadCrc) {
        return { status: 'error', error: 'Checksum mismatch — data corrupt' };
      }
    }

    return {
      status: 'complete',
      result: {
        data,
        name: this.manifest ? this.manifest.name : 'received.bin',
        mime: this.manifest ? this.manifest.mime : 'application/octet-stream',
      },
    };
  }
}
/**
 * QR-Stream Pro — Transmission Session
 */

class Transmission {
  constructor(payload, options = {}) {
    this.options = {
      blockSize: 1000,
      ecc: 'M',
      compress: true,
      encrypt: false,
      password: '',
      fps: 12,
      ...options,
    };

    this.streamId = (Math.random() * 0xFFFFFFFF) >>> 0;
    this.manifestSeq = 0;
    this.blockSeq = 0;
    this.frameIndex = 0;
    this.manifestInterval = 8; // re-send manifest every 8 frames

    this._build(payload);
  }

  async _build(payload) {
    // 1. Compress if beneficial
    let data = payload;
    let flags = 0;
    if (this.options.compress && data.length > 128) {
      try {
        const compressed = await deflate(data);
        if (compressed.length < data.length * 0.95) {
          data = compressed;
          flags |= 0x01;
        }
      } catch (e) { /* fall through */ }
    }

    // 2. Encrypt if requested
    if (this.options.encrypt && this.options.password) {
      data = await encryptPayload(data, this.options.password, this.streamId);
      flags |= 0x02;
    }

    this.payloadCrc = crc32(payload);
    this.originalSize = payload.length;

    // 3. Split into blocks
    const blockSize = this.options.blockSize;
    const K = Math.ceil(data.length / blockSize);
    this.K = K;
    this.blockSize = blockSize;

    const blocks = [];
    for (let i = 0; i < K; i++) {
      const start = i * blockSize;
      const end = Math.min(start + blockSize, data.length);
      const block = new Uint8Array(blockSize);
      block.set(data.subarray(start, end), 0);
      blocks.push(block);
    }

    this.encoder = new LtEncoder(blocks, K);
    this.manifest = {
      name: this.options.name || 'received.bin',
      mime: this.options.mime || 'application/octet-stream',
      flags,
    };
  }

  /**
   * Generate the next frame. Returns a Uint8Array ready for QR encoding.
   */
  nextFrame() {
    const useManifest = (this.frameIndex % this.manifestInterval === 0);

    if (useManifest) {
      this.frameIndex++;
      return encodeManifest(
        this.streamId,
        this.manifestSeq++,
        this.K,
        this.blockSize,
        this.payloadCrc,
        this.manifest.name,
        this.manifest.mime,
        this.manifest.flags
      );
    }

    const sym = this.encoder.nextSymbol();
    this.frameIndex++;
    return encodeBlock(
      this.streamId,
      this.blockSeq++,
      this.K,
      this.blockSize,
      sym.seed,
      sym.data
    );
  }

  get totalFrames() {
    return this.K + Math.ceil(this.K / this.manifestInterval) + 1;
  }
}

// ── DEFLATE via CompressionStream ────────────────────────────────
async function deflate(data) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream not available');
  }
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function inflate(data) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
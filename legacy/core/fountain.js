/**
 * QR-Stream Pro — Systematic LT Fountain Code
 * 
 * Implements a systematic Luby Transform code with robust soliton
 * degree distribution optimized for small K (QR-stream regime).
 * 
 * Key properties:
 * - Systematic: first K frames are raw source blocks
 * - Rateless: unlimited repair symbols after K
 * - Peeling decoder with belief propagation
 * - Deterministic: same seed always produces same symbol
 */

// ── PRNG: SplitMix32 for deterministic, fast random ──────────────
function splitmix32(seed) {
  let state = seed >>> 0;
  return function() {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

// ── Degree Distribution: Robust Soliton (optimized for small K) ──
function buildDegreeDistribution(K) {
  // Ideal soliton: rho(1)=1/K, rho(d)=1/(d(d-1))
  const rho = new Float64Array(K + 1);
  rho[1] = 1 / K;
  for (let d = 2; d <= K; d++) rho[d] = 1 / (d * (d - 1));

  // Robust soliton: tau(d) for the "ripple" of degree-1 nodes
  const c = 0.03;        // tuning constant
  const delta = 0.05;    // failure probability
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const tau = new Float64Array(K + 1);
  const threshold = Math.max(1, Math.floor(K / R));
  for (let d = 1; d < threshold; d++) tau[d] = R / (d * K);
  tau[threshold] = R * Math.log(R / delta) / K;

  // Combined distribution, normalized
  const mu = new Float64Array(K + 1);
  let Z = 0;
  for (let d = 1; d <= K; d++) {
    mu[d] = rho[d] + tau[d];
    Z += mu[d];
  }
  for (let d = 1; d <= K; d++) mu[d] /= Z;

  // Build CDF for O(log K) sampling
  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += mu[d];
    cdf[d] = acc;
  }
  cdf[K] = 1.0; // ensure exact 1.0

  return cdf;
}

function sampleDegree(cdf, rand) {
  const u = (rand() >>> 8) / 0x1000000; // [0,1)
  let lo = 1, hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ── LT Encoder (Systematic) ──────────────────────────────────────
class LtEncoder {
  constructor(sourceBlocks, K) {
    this.K = K;
    this.blocks = sourceBlocks; // Array of Uint8Array
    this.cdf = buildDegreeDistribution(K);
    this.seedCounter = 0;
  }

  /**
   * Generate the next encoded symbol.
   * Seeds 0..K-1 are systematic (raw blocks).
   * Seeds >= K use robust soliton degree distribution.
   * Returns { seed, indices, data }
   */
  nextSymbol() {
    const seed = this.seedCounter++;
    let indices;
    let data;

    if (seed < this.K) {
      // Systematic phase: emit raw source block
      indices = [seed];
      data = this.blocks[seed];
    } else {
      // Repair phase: XOR random subset according to degree distribution
      const rand = splitmix32(seed);
      const degree = sampleDegree(this.cdf, rand);
      indices = new Array(degree);
      const used = new Set();
      for (let i = 0; i < degree; i++) {
        let idx;
        do {
          idx = rand() % this.K;
        } while (used.has(idx) && used.size < this.K);
        used.add(idx);
        indices[i] = idx;
      }
      // XOR the selected blocks
      data = new Uint8Array(this.blocks[0].length);
      for (const idx of indices) {
        const block = this.blocks[idx];
        for (let i = 0; i < data.length; i++) {
          data[i] ^= block[i];
        }
      }
    }

    return { seed, indices, data };
  }
}

// ── LT Decoder (Peeling) ─────────────────────────────────────────
class LtDecoder {
  constructor(K, blockSize) {
    this.K = K;
    this.blockSize = blockSize;
    this.recovered = new Array(K).fill(null);
    this.recoveredCount = 0;
    this.pending = [];       // { indices: Set, data: Uint8Array }
    this.seenSeeds = new Set();
  }

  /**
   * Ingest a received symbol. Returns true if decoding is complete.
   */
  addSymbol(seed, indices, data) {
    if (this.seenSeeds.has(seed)) return this.isComplete();
    this.seenSeeds.add(seed);

    // Systematic block: direct recovery
    if (indices.length === 1 && seed === indices[0] && this.recovered[indices[0]] === null) {
      this.recovered[indices[0]] = data;
      this.recoveredCount++;
      this._tryPeel();
      return this.isComplete();
    }

    // Repair symbol: store for peeling
    const unknown = new Set(indices.filter(i => this.recovered[i] === null));
    if (unknown.size === 0) return this.isComplete(); // redundant
    if (unknown.size === 1) {
      const idx = unknown.values().next().value;
      this.recovered[idx] = data;
      this.recoveredCount++;
      this._tryPeel();
      return this.isComplete();
    }

    this.pending.push({ indices: unknown, data });
    this._tryPeel();
    return this.isComplete();
  }

  _tryPeel() {
    let progress = true;
    while (progress) {
      progress = false;
      const nextPending = [];
      for (const pkt of this.pending) {
        // Remove already-recovered indices
        for (const idx of pkt.indices) {
          if (this.recovered[idx] !== null) {
            pkt.indices.delete(idx);
            const block = this.recovered[idx];
            for (let i = 0; i < pkt.data.length; i++) pkt.data[i] ^= block[i];
          }
        }
        if (pkt.indices.size === 0) continue; // fully redundant
        if (pkt.indices.size === 1) {
          const idx = pkt.indices.values().next().value;
          this.recovered[idx] = pkt.data;
          this.recoveredCount++;
          progress = true;
        } else {
          nextPending.push(pkt);
        }
      }
      this.pending = nextPending;
    }
  }

  isComplete() {
    return this.recoveredCount >= this.K;
  }

  getPayload() {
    if (!this.isComplete()) return null;
    let totalLen = 0;
    for (let i = 0; i < this.K - 1; i++) totalLen += this.recovered[i].length;
    // Last block may be shorter
    let lastLen = this.recovered[this.K - 1].length;
    totalLen += lastLen;

    const out = new Uint8Array(totalLen);
    let off = 0;
    for (let i = 0; i < this.K; i++) {
      out.set(this.recovered[i], off);
      off += this.recovered[i].length;
    }
    return out;
  }
}

// ── Export ───────────────────────────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = { LtEncoder, LtDecoder, splitmix32, buildDegreeDistribution, sampleDegree };
}
/**
 * QR-Stream — shared codec (browser + Node)
 * Protocol v5
 *
 * One file, used by sender.html, receiver.html and the Node tests, so the
 * encoder and decoder can never drift apart.
 *
 * Wire format (all little-endian, CRC-32 covers everything before it):
 *
 *   FILE MANIFEST  type 0x01
 *     0  4 magic 'Q','S',ver=0x05,type      16 totalRounds u16
 *     4  4 streamId u32                     20 flags u16   (1=deflate, 2=encrypted)
 *     8  4 origSize u32  (file)             22 txSize u32  (on-wire payload)
 *    12  4 payloadCrc u32                   26 nameLen u16
 *    24? ... see encodeFileManifest
 *
 *   BLOCK  type 0x02                         ROUND MANIFEST type 0x04
 *     0  4 magic/ver/type                    0  4 magic/ver/type
 *     4  4 streamId u32                      4  4 streamId u32
 *     8  2 round u16                         8  2 round u16
 *    10  2 K u16                            10  2 totalRounds u16
 *    12  4 seed u32 (round-local)           12  2 K u16
 *    16  N data                             14  2 blockSize u16
 *    end-4 crc32                            16  4 offset u32
 *                                           20  4 length u32
 *                                           24  4 roundCrc u32
 *                                           28  1 ecc code
 *                                           29  1 reserved
 *                                           30  4 crc32  (34 total)
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.QSC = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ── constants ───────────────────────────────────────────────────────────
  var VER = 0x05;
  var T_FILE = 0x01, T_BLOCK = 0x02, T_ROUND = 0x04;
  var MAGIC_0 = 0x51, MAGIC_1 = 0x53;

  // LT degree distribution is a protocol constant, not negotiated: the
  // receiver must know it before the first block arrives.
  var LT_C = 0.03, LT_DELTA = 0.5;

  var ECC_ORDER = ['L', 'M', 'Q', 'H'];
  function eccCode(e) { var i = ECC_ORDER.indexOf(e); return i < 0 ? 1 : i; }
  function eccName(c) { return ECC_ORDER[c] || 'M'; }

  // ── CRC-32 ──────────────────────────────────────────────────────────────
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    var s = start || 0, e = (end === undefined) ? bytes.length : end;
    var crc = 0xFFFFFFFF;
    for (var i = s; i < e; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ── little-endian helpers ───────────────────────────────────────────────
  function wU16(b, o, v) { b[o] = v & 0xFF; b[o + 1] = (v >>> 8) & 0xFF; }
  function wU32(b, o, v) {
    b[o] = v & 0xFF; b[o + 1] = (v >>> 8) & 0xFF;
    b[o + 2] = (v >>> 16) & 0xFF; b[o + 3] = (v >>> 24) & 0xFF;
  }
  function rU16(b, o) { return b[o] | (b[o + 1] << 8); }
  function rU32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  // ── base45 (RFC 9285) ───────────────────────────────────────────────────
  // Why base45 and not base64: QR "alphanumeric" mode packs 2 chars into 11
  // bits (5.5 bits/char) while "byte" mode is 8 bits/char. base45 carries
  // 16 bits in 3 chars = 16.5 bits, so it costs ~3% instead of base64's 33%.
  // Net: ~29% more file bytes per QR code. ASCII-only, so no UTF-8 mangling
  // between zbar and BarcodeDetector.
  var B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  var B45_INV = (function () {
    var m = new Int16Array(128); m.fill(-1);
    for (var i = 0; i < B45.length; i++) m[B45.charCodeAt(i)] = i;
    return m;
  })();

  function base45Encode(bytes) {
    var out = '', i = 0, len = bytes.length;
    for (; i + 1 < len; i += 2) {
      var v = (bytes[i] << 8) | bytes[i + 1];
      out += B45[v % 45] + B45[(v / 45 | 0) % 45] + B45[(v / 2025 | 0)];
    }
    if (i < len) { var r = bytes[i]; out += B45[r % 45] + B45[(r / 45 | 0)]; }
    return out;
  }

  function base45Decode(str) {
    var n = str.length;
    var out = new Uint8Array((n * 2 / 3 | 0) + 1);
    var o = 0, i = 0;
    for (; i + 3 <= n; i += 3) {
      var a = B45_INV[str.charCodeAt(i)], b = B45_INV[str.charCodeAt(i + 1)], c = B45_INV[str.charCodeAt(i + 2)];
      if (a < 0 || b < 0 || c < 0) throw new Error('bad base45');
      var v = a + b * 45 + c * 2025;
      if (v > 0xFFFF) throw new Error('bad base45');
      out[o++] = v >>> 8; out[o++] = v & 0xFF;
    }
    var rem = n - i;
    if (rem === 2) {
      var x = B45_INV[str.charCodeAt(i)], y = B45_INV[str.charCodeAt(i + 1)];
      if (x < 0 || y < 0) throw new Error('bad base45');
      out[o++] = x + y * 45;
    } else if (rem === 1) {
      throw new Error('bad base45');
    }
    return out.subarray(0, o);
  }

  // ── PRNG + LT symbols ───────────────────────────────────────────────────
  function splitmix32(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x9e3779b9) >>> 0;
      var z = state;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
  }

  var cdfCache = {};
  function degreeCdf(K) {
    var hit = cdfCache[K];
    if (hit) return hit;
    var cdf = new Float64Array(K + 1);
    if (K <= 1) { cdf[1] = 1; cdfCache[K] = cdf; return cdf; }
    var rho = new Float64Array(K + 1);
    rho[1] = 1 / K;
    for (var d = 2; d <= K; d++) rho[d] = 1 / (d * (d - 1));
    var R = LT_C * Math.log(K / LT_DELTA) * Math.sqrt(K);
    var tau = new Float64Array(K + 1);
    var t = Math.max(1, Math.floor(K / R));
    for (var d1 = 1; d1 < t && d1 <= K; d1++) tau[d1] = R / (d1 * K);
    if (t <= K) tau[t] += R * Math.log(R / LT_DELTA) / K;
    var total = 0, i;
    for (i = 1; i <= K; i++) { cdf[i] = rho[i] + tau[i]; total += cdf[i]; }
    if (!(total > 0)) { cdf[1] = 1; cdfCache[K] = cdf; return cdf; }
    var acc = 0;
    for (i = 1; i <= K; i++) { acc += cdf[i] / total; cdf[i] = acc; }
    cdf[K] = 1;
    cdfCache[K] = cdf;
    return cdf;
  }

  function sampleDegree(cdf, rand) {
    var u = (rand() >>> 8) / 0x1000000;
    var lo = 1, hi = cdf.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >>> 1;
      if (cdf[mid] < u) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // Same (round, seed) always yields the same index set on both sides.
  function symbolIndices(seed, round, K) {
    if (seed < K) return [seed];
    var rand = splitmix32((seed ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0);
    var cdf = degreeCdf(K);
    var degree = Math.min(sampleDegree(cdf, rand), K);
    var used = new Set(), out = [], tries = 0;
    while (out.length < degree && used.size < K && tries < degree * 8 + 64) {
      var idx = rand() % K; tries++;
      if (!used.has(idx)) { used.add(idx); out.push(idx); }
    }
    return out;
  }

  function xorInto(dst, src) {
    var n = dst.length < src.length ? dst.length : src.length;
    for (var i = 0; i < n; i++) dst[i] ^= src[i];
  }

  function padTo(data, size) {
    if (data.length === size) return data;
    var p = new Uint8Array(size);
    p.set(data.subarray(0, Math.min(data.length, size)), 0);
    return p;
  }

  // ── frame encoders ──────────────────────────────────────────────────────
  function utf8(s) { return new TextEncoder().encode(s); }
  function fromUtf8(b) { return new TextDecoder().decode(b); }

  function encodeFileManifest(sid, totalRounds, origSize, txSize, payloadCrc, flags, name, mime) {
    var nB = utf8(name || 'file.bin'), mB = utf8(mime || 'application/octet-stream');
    var len = 28 + nB.length + mB.length;
    var buf = new Uint8Array(len + 4), o = 0;
    buf[o++] = MAGIC_0; buf[o++] = MAGIC_1; buf[o++] = VER; buf[o++] = T_FILE;
    wU32(buf, o, sid); o += 4;
    wU16(buf, o, totalRounds); o += 2;
    wU16(buf, o, flags); o += 2;
    wU32(buf, o, origSize); o += 4;
    wU32(buf, o, txSize); o += 4;
    wU32(buf, o, payloadCrc); o += 4;
    wU16(buf, o, nB.length); o += 2;
    wU16(buf, o, mB.length); o += 2;
    buf.set(nB, o); o += nB.length;
    buf.set(mB, o); o += mB.length;
    wU32(buf, o, crc32(buf, 0, o));
    return buf;
  }

  function encodeRoundManifest(sid, round, totalRounds, K, blockSize, offset, length, roundCrc, ecc) {
    var buf = new Uint8Array(34), o = 0;
    buf[o++] = MAGIC_0; buf[o++] = MAGIC_1; buf[o++] = VER; buf[o++] = T_ROUND;
    wU32(buf, o, sid); o += 4;
    wU16(buf, o, round); o += 2;
    wU16(buf, o, totalRounds); o += 2;
    wU16(buf, o, K); o += 2;
    wU16(buf, o, blockSize); o += 2;
    wU32(buf, o, offset); o += 4;
    wU32(buf, o, length); o += 4;
    wU32(buf, o, roundCrc); o += 4;
    buf[o++] = eccCode(ecc);
    buf[o++] = 0;
    wU32(buf, o, crc32(buf, 0, o));
    return buf;
  }

  function encodeBlock(sid, round, K, seed, data) {
    var buf = new Uint8Array(20 + data.length), o = 0;
    buf[o++] = MAGIC_0; buf[o++] = MAGIC_1; buf[o++] = VER; buf[o++] = T_BLOCK;
    wU32(buf, o, sid); o += 4;
    wU16(buf, o, round); o += 2;
    wU16(buf, o, K); o += 2;
    wU32(buf, o, seed); o += 4;
    buf.set(data, o); o += data.length;
    wU32(buf, o, crc32(buf, 0, o));
    return buf;
  }

  // ── frame decoder ───────────────────────────────────────────────────────
  function decodeFrame(bytes) {
    var n = bytes.length;
    if (n < 24) return null;
    if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1 || bytes[2] !== VER) return null;
    var end = n - 4;
    if (crc32(bytes, 0, end) !== rU32(bytes, end)) return null;
    var type = bytes[3];
    var sid = rU32(bytes, 4);

    if (type === T_FILE) {
      if (n < 32) return null;
      var totalRounds = rU16(bytes, 8), flags = rU16(bytes, 10);
      var origSize = rU32(bytes, 12), txSize = rU32(bytes, 16), payloadCrc = rU32(bytes, 20);
      var nameLen = rU16(bytes, 24), mimeLen = rU16(bytes, 26);
      var o = 28;
      if (o + nameLen + mimeLen > end) return null;
      var name = fromUtf8(bytes.subarray(o, o + nameLen)); o += nameLen;
      var mime = fromUtf8(bytes.subarray(o, o + mimeLen));
      return { type: 'file', streamId: sid, totalRounds: totalRounds, flags: flags,
               origSize: origSize, txSize: txSize, payloadCrc: payloadCrc, name: name, mime: mime };
    }

    if (type === T_ROUND) {
      if (n < 34) return null;
      return {
        type: 'round', streamId: sid,
        round: rU16(bytes, 8), totalRounds: rU16(bytes, 10),
        K: rU16(bytes, 12), blockSize: rU16(bytes, 14),
        offset: rU32(bytes, 16), length: rU32(bytes, 20), roundCrc: rU32(bytes, 24),
        ecc: eccName(bytes[28]),
      };
    }

    if (type === T_BLOCK) {
      if (n < 24) return null;
      var K = rU16(bytes, 10);
      if (K < 1) return null;
      return { type: 'block', streamId: sid, round: rU16(bytes, 8), K: K,
               seed: rU32(bytes, 12), data: bytes.subarray(16, end) };
    }

    return null;
  }

  // ── compression (pako in browser, zlib in Node) ─────────────────────────
  function deflateBytes(data) {
    if (root.pako) return root.pako.deflate(data);
    /* eslint-disable-next-line */
    if (typeof require === 'function') return require('zlib').deflateSync(data);
    throw new Error('deflate unavailable');
  }
  function inflateBytes(data) {
    if (root.pako) return root.pako.inflate(data);
    /* eslint-disable-next-line */
    if (typeof require === 'function') return require('zlib').inflateSync(data);
    throw new Error('inflate unavailable');
  }

  // ── AES-GCM ─────────────────────────────────────────────────────────────
  var PBKDF2_ITERATIONS = 600000;
  function subtle() {
    var c = root.crypto;
    if (!c || !c.subtle) throw new Error('WebCrypto unavailable — need https or localhost');
    return c.subtle;
  }
  function deriveKey(password, sid) {
    var enc = new TextEncoder();
    var salt = enc.encode('qr-stream-v2:' + sid);
    return subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (km) {
        return subtle().deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
          km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }
  function encryptBytes(plain, password, sid) {
    return deriveKey(password, sid).then(function (key) {
      var iv = root.crypto.getRandomValues(new Uint8Array(12));
      return subtle().encrypt({ name: 'AES-GCM', iv: iv }, key, plain).then(function (ct) {
        var out = new Uint8Array(12 + ct.byteLength);
        out.set(iv, 0); out.set(new Uint8Array(ct), 12);
        return out;
      });
    });
  }
  function decryptBytes(cipher, password, sid) {
    return deriveKey(password, sid).then(function (key) {
      var iv = cipher.subarray(0, 12), ct = cipher.subarray(12);
      return subtle().decrypt({ name: 'AES-GCM', iv: iv }, key, ct).then(function (pt) {
        return new Uint8Array(pt);
      });
    }).catch(function () {
      throw new Error('Wrong password, or the data was tampered with');
    });
  }

  // ── Transmission (sender) ───────────────────────────────────────────────
  var ROUND_TARGET_BYTES = 48 * 1024;
  var MAX_ROUNDS = 30;       // keeps the "done" bitmask inside a 32-bit int
  var OVER_SEND = 1.15;      // symbols per round we *expect* to need for the ETA
  var HARD_CAP = 2.2;        // stop a round only if feedback goes silent this long
  var FILE_EVERY = 32;       // file manifest airtime share
  var ROUND_EVERY = 64;      // round manifest airtime share

  function pickRounds(size) {
    return Math.max(1, Math.min(MAX_ROUNDS, Math.ceil(size / ROUND_TARGET_BYTES)));
  }

  function Transmission(payload, opts) {
    opts = opts || {};
    this.opts = {
      blockSize: 500, ecc: 'M', compress: true,
      password: '', name: 'file.bin', mime: 'application/octet-stream',
      overSend: OVER_SEND,
      ...opts,
    };
    this.streamId = (Math.random() * 0xFFFFFFFF) >>> 0;
    this.origSize = payload.length;
    this.payloadCrc = crc32(payload);
    this.source = payload;
    this.flags = 0;
    this.data = payload;
    this.txSize = payload.length;
    this.rounds = [];
    this.roundIndex = 0;
    this.frameIndex = 0;
    this.sinceFile = 0;
    this.sinceRound = 0;
    this.queue = [];
    this.doneMask = 0;
    this.wanted = [];
    this.wantedRound = -1;
    this.wantedAt = 0;
  }

  Transmission.prototype.init = async function () {
    var data = this.source;
    if (this.opts.compress && data.length > 128) {
      try {
        var c = deflateBytes(data);
        if (c.length < data.length * 0.95) { data = c; this.flags |= 1; }
      } catch (e) { /* keep raw */ }
    }
    if (this.opts.password) {
      data = await encryptBytes(data, this.opts.password, this.streamId);
      this.flags |= 2;
    }
    this.data = data;
    this.txSize = data.length;

    var n = pickRounds(data.length);
    var chunk = Math.ceil(data.length / n);
    this.rounds = [];
    for (var i = 0; i < n; i++) {
      var offset = i * chunk;
      if (i > 0 && offset >= data.length) break;
      this.rounds.push({
        index: i, offset: offset,
        length: Math.min(chunk, data.length - offset),
        blockSize: 0, ecc: 'M', K: 0, seed: 0, emitted: 0,
        blocks: [], roundCrc: 0, qrVersion: 0, startedAt: 0,
      });
    }
    this.startRound(0, this.opts.blockSize, this.opts.ecc);
    this.roundIndex = 0;
    this.queue.push({ kind: 'file' });
    this.queue.push({ kind: 'round', round: 0 });
    return this;
  };

  Transmission.prototype.startRound = function (index, blockSize, ecc) {
    var r = this.rounds[index];
    if (!r) return;
    r.blockSize = blockSize;
    r.ecc = ecc;
    r.K = Math.max(1, Math.ceil(r.length / blockSize));
    r.seed = 0;
    r.emitted = 0;
    r.startedAt = Date.now();
    var slice = this.data.subarray(r.offset, r.offset + r.length);
    r.roundCrc = crc32(slice);
    r.blocks = [];
    for (var i = 0; i < r.K; i++) {
      var b = new Uint8Array(blockSize);
      var s = i * blockSize;
      if (s < slice.length) b.set(slice.subarray(s, Math.min(s + blockSize, slice.length)), 0);
      r.blocks.push(b);
    }
  };

  Transmission.prototype.current = function () { return this.rounds[this.roundIndex]; };

  /** Point the stream at a round. Initialises it once, never rewinds its seeds. */
  Transmission.prototype.enterRound = function (index) {
    var r = this.rounds[index];
    if (!r) return;
    if (!r.blockSize) this.startRound(index, this.opts.blockSize, this.opts.ecc);
    this.roundIndex = index;
    this.queue.push({ kind: 'round', round: index });
    this.sinceRound = 0;
  };

  Transmission.prototype.fileFrame = function () {
    return encodeFileManifest(this.streamId, this.rounds.length, this.origSize,
      this.txSize, this.payloadCrc, this.flags, this.opts.name, this.opts.mime);
  };

  Transmission.prototype.roundFrame = function (r) {
    return encodeRoundManifest(this.streamId, r.index, this.rounds.length, r.K,
      r.blockSize, r.offset, r.length, r.roundCrc, r.ecc);
  };

  /** Which round should be on screen next? Skips rounds already confirmed. */
  Transmission.prototype.nextRound = function () {
    var n = this.rounds.length, cur = this.roundIndex;
    for (var i = 1; i < n; i++) {
      var idx = (cur + i) % n;
      if (!(this.doneMask & (1 << idx))) return idx;
    }
    return cur;
  };

  Transmission.prototype.nextFrame = function () {
    if (this.queue.length) {
      var q = this.queue.shift();
      this.frameIndex++;
      return q.kind === 'file' ? this.fileFrame() : this.roundFrame(this.rounds[q.round]);
    }

    this.sinceFile++;
    this.sinceRound++;
    if (this.sinceFile >= FILE_EVERY) {
      this.sinceFile = 0;
      this.frameIndex++;
      return this.fileFrame();
    }
    if (this.sinceRound >= ROUND_EVERY) {
      this.sinceRound = 0;
      this.frameIndex++;
      var cr = this.current();
      return this.roundFrame(cr);
    }

    var r = this.current();

    // 1. re-send blocks the receiver explicitly asked for (cheap, exact)
    if (this.wantedRound === r.index && this.wanted.length) {
      var w = this.wanted[this.wantedAt % this.wanted.length];
      this.wantedAt++;
      if (w >= 0 && w < r.K) {
        r.emitted++;
        this.frameIndex++;
        return encodeBlock(this.streamId, r.index, r.K, w, r.blocks[w]);
      }
    }

    if (r.emitted >= Math.ceil(r.K * HARD_CAP) && this.rounds.length > 1) {
      var next = this.nextRound();
      if (next !== this.roundIndex) this.enterRound(next);
      r = this.current();
    }

    var seed = r.seed++;
    var data;
    if (seed < r.K) {
      data = r.blocks[seed];
    } else {
      var idx = symbolIndices(seed, r.index, r.K);
      data = new Uint8Array(r.blockSize);
      for (var i = 0; i < idx.length; i++) xorInto(data, r.blocks[idx[i]]);
    }
    r.emitted++;
    this.frameIndex++;
    return encodeBlock(this.streamId, r.index, r.K, seed, data);
  };

  /** Feedback from the receiver: leave finished rounds, revisit missing ones. */
  Transmission.prototype.applyFeedback = function (fb) {
    if (!fb) return null;
    if (typeof fb.doneMask === 'number') this.doneMask = fb.doneMask;
    var n = this.rounds.length;
    if (this.doneMask === ((1 << n) - 1)) return 'done';

    // current round finished -> move on immediately, no oversending
    if (this.doneMask & (1 << this.roundIndex)) {
      var nxt = this.nextRound();
      if (nxt !== this.roundIndex) { this.enterRound(nxt); return 'advance'; }
      return null;
    }
    // receiver is behind us -> go back and top that round up
    var target = fb.roundIndex;
    if (typeof target === 'number' && target >= 0 && target < n &&
        target !== this.roundIndex && !(this.doneMask & (1 << target))) {
      this.enterRound(target);
      this.setWanted(target, fb.miss);
      return 'jump';
    }
    if (fb.roundIndex === this.roundIndex && fb.miss) this.setWanted(fb.roundIndex, fb.miss);
    return null;
  };

  /**
   * The receiver names the source blocks it is still missing. Re-sending a
   * raw block (seed = index) costs one frame and always lands, which beats
   * throwing random fountain symbols at the tail.
   */
  Transmission.prototype.setWanted = function (round, list) {
    if (typeof round !== 'number' || !Array.isArray(list) || !list.length) {
      this.wanted = []; this.wantedRound = -1; return;
    }
    if (round === this.wantedRound && list.length === this.wanted.length) {
      var same = true;
      for (var i = 0; i < list.length; i++) if (list[i] !== this.wanted[i]) { same = false; break; }
      if (same) return;
    }
    this.wanted = list.slice(0, 200);
    this.wantedRound = round;
    this.wantedAt = 0;
  };

  Transmission.prototype.adapt = function (finishedRound, redundancy) {
    var r = this.rounds[finishedRound];
    if (!r) return;
    var bs = r.blockSize, ecc = r.ecc;
    if (redundancy <= 1.12) {
      bs = Math.min(700, bs + 100);
      ecc = ECC_ORDER[Math.max(0, ECC_ORDER.indexOf(ecc) - 1)];
    } else if (redundancy >= 1.6) {
      bs = Math.max(200, bs - 100);
      ecc = ECC_ORDER[Math.min(3, ECC_ORDER.indexOf(ecc) + 1)];
    }
    this.opts.blockSize = bs;
    this.opts.ecc = ecc;
  };

  Transmission.prototype.expectedFrames = function () {
    var t = 0;
    for (var i = 0; i < this.rounds.length; i++) {
      var r = this.rounds[i];
      var K = Math.max(1, Math.ceil(r.length / (r.blockSize || this.opts.blockSize)));
      t += Math.ceil(K * OVER_SEND);
    }
    return t + Math.ceil(t / FILE_EVERY) + Math.ceil(t / ROUND_EVERY) + 2;
  };

  // ── RoundDecoder (LT + peeling + Gaussian fallback) ─────────────────────
  var SOLVE_MAX_K = 1024;   // bitset solver stays small enough to finish instantly
  var useGaussian = true;

  function RoundDecoder(K, blockSize, round) {
    this.K = K;
    this.blockSize = blockSize;
    this.round = round;
    this.recovered = new Array(K).fill(null);
    this.count = 0;
    this.pending = [];
    this.seen = new Set();
    this.stall = 0;
    this.solves = 0;
  }

  RoundDecoder.prototype.isComplete = function () { return this.count >= this.K; };

  RoundDecoder.prototype.addSymbol = function (seed, data) {
    if (this.seen.has(seed)) return false;
    this.seen.add(seed);
    var block = padTo(data, this.blockSize);

    if (seed < this.K) {
      if (this.recovered[seed] === null) {
        this.recovered[seed] = block;
        this.count++;
        this._peel();
      }
      return true;
    }

    var idx = symbolIndices(seed, this.round, this.K);
    var xor = new Uint8Array(block);
    var unknown = [];
    for (var i = 0; i < idx.length; i++) {
      var b = this.recovered[idx[i]];
      if (b !== null) xorInto(xor, b); else unknown.push(idx[i]);
    }
    if (unknown.length === 0) return true;
    if (unknown.length === 1) {
      this.recovered[unknown[0]] = xor;
      this.count++;
      this._peel();
      return true;
    }
    this.pending.push({ idx: new Set(unknown), data: xor });
    var before = this.count;
    this._peel();
    if (this.count === before) {
      // back off as the solver grows: each retry rebuilds a bigger matrix
      if (++this.stall >= 3 + Math.min(this.solves, 5)) { this.stall = 0; this._solve(); }
    } else this.stall = 0;
    return true;
  };

  RoundDecoder.prototype._peel = function () {
    var progress = true;
    while (progress && !this.isComplete()) {
      progress = false;
      var keep = [];
      for (var p = 0; p < this.pending.length; p++) {
        var pkt = this.pending[p], dead = [];
        var it = pkt.idx.values(), v;
        while (!(v = it.next()).done) {
          var idx = v.value, b = this.recovered[idx];
          if (b !== null) { xorInto(pkt.data, b); dead.push(idx); }
        }
        for (var d = 0; d < dead.length; d++) pkt.idx.delete(dead[d]);
        if (pkt.idx.size === 0) continue;
        if (pkt.idx.size === 1) {
          var only = pkt.idx.values().next().value;
          if (this.recovered[only] === null) {
            this.recovered[only] = pkt.data;
            this.count++;
            progress = true;
          }
          continue;
        }
        keep.push(pkt);
      }
      this.pending = keep;
    }
  };

  /**
   * Gaussian elimination over GF(2). Peeling stalls when no pending symbol has
   * degree 1, which is exactly where plain LT wastes 30-50% extra frames.
   * K is small (rounds are ~48 KB), so a bitmask solve is cheap and recovers
   * everything as soon as the equations reach full rank.
   */
  RoundDecoder.prototype._solve = function () {
    if (!useGaussian || this.K > SOLVE_MAX_K || this.pending.length < 2) return;
    this.solves++;
    var K = this.K, W = (K + 31) >>> 5;
    var rows = new Array(this.pending.length);
    var i, j;
    for (i = 0; i < this.pending.length; i++) {
      var bits = new Uint32Array(W);
      var it = this.pending[i].idx.values(), v;
      while (!(v = it.next()).done) {
        var idx = v.value;
        bits[idx >>> 5] |= (1 << (idx & 31));
      }
      rows[i] = { bits: bits, data: this.pending[i].data };
    }

    var rank = 0;
    for (var col = 0; col < K && rank < rows.length; col++) {
      var word = col >>> 5, mask = 1 << (col & 31);
      var sel = -1, best = 0;
      for (var r = rank; r < rows.length; r++) {
        if (rows[r].bits[word] & mask) {
          var wt = 0, k;
          for (k = 0; k < W; k++) wt += popcount(rows[r].bits[k]);
          if (sel < 0 || wt < best) { sel = r; best = wt; }
        }
      }
      if (sel < 0) continue;
      if (sel !== rank) { var tmp = rows[sel]; rows[sel] = rows[rank]; rows[rank] = tmp; }
      var pivot = rows[rank];
      for (var q = 0; q < rows.length; q++) {
        if (q === rank) continue;
        if (rows[q].bits[word] & mask) {
          for (j = 0; j < W; j++) rows[q].bits[j] ^= pivot.bits[j];
          xorInto(rows[q].data, pivot.data);
        }
      }
      rank++;
    }

    var left = [];
    for (i = 0; i < rows.length; i++) {
      var row = rows[i], first = -1, many = 0;
      for (var jw = 0; jw < W; jw++) {
        var w = row.bits[jw];
        while (w) {
          var bit = w & -w;
          if (many === 0) first = (jw << 5) + (31 - Math.clz32(bit));
          many++;
          w ^= bit;
        }
      }
      if (many === 0) continue;
      if (many === 1) {
        if (first < K && this.recovered[first] === null) {
          this.recovered[first] = row.data;
          this.count++;
        }
      } else {
        var set = new Set();
        for (var js = 0; js < W; js++) {
          var x = row.bits[js];
          while (x) {
            var bb = x & -x;
            set.add((js << 5) + (31 - Math.clz32(bb)));
            x ^= bb;
          }
        }
        left.push({ idx: set, data: row.data });
      }
    }
    this.pending = left;
    this._peel();
  };

  function popcount(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
  }

  RoundDecoder.prototype.getPayload = function () {
    if (!this.isComplete()) return null;
    var out = new Uint8Array(this.K * this.blockSize);
    for (var i = 0; i < this.K; i++) out.set(this.recovered[i], i * this.blockSize);
    return out;
  };

  // ── ReceiverSession ─────────────────────────────────────────────────────
  function ReceiverSession() {
    this.streamId = null;
    this.fileMeta = null;
    this.totalRounds = 0;
    this.rounds = new Map();
    this.completed = false;
    this.symbols = 0;
    this.frames = 0;
  }

  ReceiverSession.prototype.roundsDone = function () {
    var mask = 0;
    this.rounds.forEach(function (r) {
      if (r.complete) mask |= (1 << r.index);
    });
    return mask;
  };

  ReceiverSession.prototype.doneCount = function () {
    var c = 0;
    this.rounds.forEach(function (r) { if (r.complete) c++; });
    return c;
  };

  ReceiverSession.prototype.roundAt = function (index, K, blockSize) {
    var r = this.rounds.get(index);
    if (!r) {
      r = {
        index: index, K: K, blockSize: blockSize,
        dec: new RoundDecoder(K, blockSize, index),
        offset: null, length: null, roundCrc: null,
        ecc: '', complete: false, pendingPayload: null,
      };
      this.rounds.set(index, r);
    }
    return r;
  };

  ReceiverSession.prototype.ingest = function (bytes) {
    this.frames++;
    if (this.completed) return { status: 'done' };
    var f = decodeFrame(bytes);
    if (!f) return { status: 'bad' };

    if (this.streamId === null) {
      this.streamId = f.streamId;
      return this._adopt(f);
    }
    if (f.streamId !== this.streamId) {
      // A receiver that has not decoded anything yet should follow the sender.
      if (this.symbols === 0 && !this.fileMeta) {
        this.reset();
        this.streamId = f.streamId;
        return this._adopt(f);
      }
      return { status: 'other-stream' };
    }
    return this._adopt(f);
  };

  ReceiverSession.prototype._adopt = function (f) {
    if (f.type === 'file') {
      this.fileMeta = f;
      if (f.totalRounds) this.totalRounds = f.totalRounds;
      return this._verifyWaiting() || { status: 'file' };
    }
    if (f.type === 'round') {
      if (!f.totalRounds) return { status: 'bad' };
      this.totalRounds = f.totalRounds;
      var r = this.rounds.get(f.round);
      if (!r) {
        this.rounds.set(f.round, {
          index: f.round, K: f.K, blockSize: f.blockSize,
          dec: new RoundDecoder(f.K, f.blockSize, f.round),
          offset: f.offset, length: f.length, roundCrc: f.roundCrc,
          ecc: f.ecc, complete: false, pendingPayload: null,
        });
      } else {
        r.K = f.K; r.blockSize = f.blockSize;
        r.offset = f.offset; r.length = f.length; r.roundCrc = f.roundCrc; r.ecc = f.ecc;
      }
      return this._verifyWaiting() || { status: 'round', round: f.round };
    }
    if (f.type === 'block') {
      if (f.round >= MAX_ROUNDS) return { status: 'bad' };
      var r = this.roundAt(f.round, f.K, f.data.length);
      if (r.complete) return { status: 'block', round: r.index, progress: 1, known: r.K };
      if (r.dec.addSymbol(f.seed, f.data)) this.symbols++;
      if (r.dec.isComplete()) {
        if (r.roundCrc === null) {
          r.pendingPayload = r.dec.getPayload();
        } else {
          var res = this._finishRound(r);
          if (res) return res;
        }
      }
      return { status: 'block', round: r.index, progress: r.dec.count / r.K, known: r.dec.count };
    }
    return { status: 'bad' };
  };

  ReceiverSession.prototype._finishRound = function (r) {
    var payload = r.pendingPayload || r.dec.getPayload();
    r.pendingPayload = null;
    if (!payload) return null;
    payload = payload.subarray(0, r.length);
    if (crc32(payload) !== r.roundCrc) {
      r.dec = new RoundDecoder(r.K, r.blockSize, r.index);
      return { status: 'round-corrupt', round: r.index };
    }
    r.complete = true;
    r.payload = payload;
    if (this._allDone()) return { status: 'complete' };
    return { status: 'round-complete', round: r.index, done: this.doneCount(), total: this.totalRounds };
  };

  ReceiverSession.prototype._verifyWaiting = function () {
    var self = this;
    this.rounds.forEach(function (r) {
      if (!r.complete && r.pendingPayload && r.roundCrc !== null) self._finishRound(r);
    });
    return this._allDone() ? { status: 'complete' } : null;
  };

  ReceiverSession.prototype._allDone = function () {
    if (!this.totalRounds) return false;
    for (var i = 0; i < this.totalRounds; i++) {
      var r = this.rounds.get(i);
      if (!r || !r.complete) return false;
    }
    return true;
  };

  ReceiverSession.prototype.missing = function (round) {
    var r = this.rounds.get(round);
    if (!r || r.complete) return [];
    var out = [];
    for (var i = 0; i < r.K && out.length < 200; i++) {
      if (r.dec.recovered[i] === null) out.push(i);
    }
    return out;
  };

  ReceiverSession.prototype.assemble = function () {
    if (!this._allDone()) return null;
    var total = 0, i, r;
    for (i = 0; i < this.totalRounds; i++) total += this.rounds.get(i).length;
    var out = new Uint8Array(total);
    for (i = 0; i < this.totalRounds; i++) {
      r = this.rounds.get(i);
      out.set(r.payload, r.offset);
    }
    return out;
  };

  /**
   * Turn the assembled bytes back into the original file.
   * Returns { data }, { needPassword: true } or { error }.
   */
  ReceiverSession.prototype.finalize = async function (password) {
    if (this.completed && this.result) return this.result;
    var data = this.assemble();
    if (!data) return { error: 'Not all rounds received yet' };
    var flags = this.fileMeta ? this.fileMeta.flags : 0;

    if (flags & 2) {
      if (!password) return { needPassword: true };
      try { data = await decryptBytes(data, password, this.streamId); }
      catch (e) { return { error: e.message }; }
    }
    if (flags & 1) {
      try { data = inflateBytes(data); }
      catch (e) { return { error: 'Decompression failed' }; }
    }
    if (this.fileMeta && crc32(data) !== this.fileMeta.payloadCrc) {
      return { error: 'Checksum mismatch — data is corrupt' };
    }
    this.completed = true;
    this.result = {
      data: data,
      name: (this.fileMeta && this.fileMeta.name) || 'received.bin',
      mime: (this.fileMeta && this.fileMeta.mime) || 'application/octet-stream',
    };
    return this.result;
  };

  ReceiverSession.prototype.reset = function () {
    this.streamId = null;
    this.fileMeta = null;
    this.totalRounds = 0;
    this.rounds = new Map();
    this.completed = false;
    this.result = null;
    this.symbols = 0;
    this.frames = 0;
  };

  // ── rate controller (pure, unit-testable) ───────────────────────────────
  function RateController(cfg) {
    cfg = cfg || {};
    this.min = cfg.min || 60;
    this.max = cfg.max || 500;
    this.start = cfg.start || 140;
    this.interval = this.start;
    this.up = 0;
    this.down = 0;
    this.fastUp = 0;
    this.fastDown = 0;
  }
  /**
   * ratio = unique symbols decoded per second / frames shown per second.
   * < 0.85 means frames are being missed -> slow down.
   * > 0.97 means everything is landing -> speed up.
   * Multiplicative both ways so a deep cut recovers as fast as it happened.
   */
  RateController.prototype.update = function (ratio) {
    if (!isFinite(ratio) || ratio <= 0 || ratio > 1.5) return this.interval;
    if (ratio < 0.85) {
      this.up++; this.down = 0;
      if (this.up >= 2) {
        this.interval = Math.min(this.max, Math.round(this.interval * 1.5));
        this.up = 0; this.fastUp = 0; this.fastDown++;
      }
      return this.interval;
    }
    if (ratio > 0.97) {
      this.down++; this.up = 0;
      if (this.down >= 2) {
        this.interval = Math.max(this.min, Math.round(this.interval / 1.5));
        this.down = 0; this.fastDown = 0; this.fastUp++;
      }
      return this.interval;
    }
    this.up = 0; this.down = 0;
    return this.interval;
  };
  RateController.prototype.reset = function () {
    this.interval = this.start; this.up = 0; this.down = 0;
  };

  return {
    VER, T_FILE, T_BLOCK, T_ROUND,
    crc32, base45Encode, base45Decode,
    splitmix32, degreeCdf, symbolIndices, xorInto,
    encodeFileManifest, encodeRoundManifest, encodeBlock, decodeFrame,
    deflateBytes, inflateBytes, encryptBytes, decryptBytes,
    Transmission, ReceiverSession, RoundDecoder, RateController,
    pickRounds, ECC_ORDER,
    setGaussian: function (on) { useGaussian = !!on; },
  };
});

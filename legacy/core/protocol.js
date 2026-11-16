/**
 * QR-Stream Pro — Wire Protocol
 * 
 * Compact binary format. Every frame is self-describing.
 * 
 * Frame layout:
 *   Offset  Size  Field
 *   ──────  ────  ─────────────────────────────────────────
 *   0       2     Magic bytes: 0x51 0x53 ('Q','S')
 *   2       1     Protocol version (0x02)
 *   3       1     Frame type: 0x01=Manifest, 0x02=Block
 *   4       4     Stream ID (random 32-bit)
 *   8       4     Sequence number (0..2^32-1)
 *   12      2     Total block count K
 *   14      2     Block size (bytes)
 *   16      4     Payload CRC-32 (whole file, only in Manifest)
 *   20      4     Frame CRC-32 (this frame, excluding last 4 bytes)
 *   24      ...   Payload data
 *   ──────  ────  ─────────────────────────────────────────
 *   Header: 24 bytes (Manifest), 16 bytes (Block)
 */

const PROTOCOL_VERSION = 0x02;
const FRAME_MANIFEST = 0x01;
const FRAME_BLOCK = 0x02;
const MAGIC_0 = 0x51; // 'Q'
const MAGIC_1 = 0x53; // 'S'
const HEADER_SIZE_MANIFEST = 24;
const HEADER_SIZE_BLOCK = 16;

// ── CRC-32 (IEEE 802.3) ─────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let crc = 0xFFFFFFFF;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Variable-length integer encoding (LEB128) ────────────────────
function writeU16(buf, off, val) {
  buf[off] = val & 0xFF;
  buf[off + 1] = (val >>> 8) & 0xFF;
}
function readU16(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}
function writeU32(buf, off, val) {
  buf[off] = val & 0xFF;
  buf[off + 1] = (val >>> 8) & 0xFF;
  buf[off + 2] = (val >>> 16) & 0xFF;
  buf[off + 3] = (val >>> 24) & 0xFF;
}
function readU32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

// ── Manifest Frame ───────────────────────────────────────────────
function encodeManifest(streamId, seq, K, blockSize, payloadCrc, name, mime, flags) {
  const nameBytes = new TextEncoder().encode(name || '');
  const mimeBytes = new TextEncoder().encode(mime || 'application/octet-stream');
  const payloadLen = nameBytes.length + mimeBytes.length + 4; // +2 length fields
  const total = HEADER_SIZE_MANIFEST + payloadLen;

  const buf = new Uint8Array(total);
  let off = 0;

  buf[off++] = MAGIC_0;
  buf[off++] = MAGIC_1;
  buf[off++] = PROTOCOL_VERSION;
  buf[off++] = FRAME_MANIFEST;
  writeU32(buf, off, streamId); off += 4;
  writeU32(buf, off, seq); off += 4;
  writeU16(buf, off, K); off += 2;
  writeU16(buf, off, blockSize); off += 2;
  writeU32(buf, off, payloadCrc); off += 4;

  // Flags: bit 0 = compressed, bit 1 = encrypted
  buf[off++] = flags & 0xFF;
  buf[off++] = 0; // reserved
  writeU16(buf, off, nameBytes.length); off += 2;
  writeU16(buf, off, mimeBytes.length); off += 2;

  buf.set(nameBytes, off); off += nameBytes.length;
  buf.set(mimeBytes, off); off += mimeBytes.length;

  // Frame CRC-32 over everything before the last 4 bytes
  // (We'll reserve last 4 bytes, but here we're not appending)
  // Actually, let's append CRC at the end.
  const withCrc = new Uint8Array(total + 4);
  withCrc.set(buf, 0);
  writeU32(withCrc, total, crc32(buf, 0, total));

  return withCrc;
}

// ── Block Frame ──────────────────────────────────────────────────
function encodeBlock(streamId, seq, K, blockSize, seed, data) {
  const total = HEADER_SIZE_BLOCK + data.length;
  const buf = new Uint8Array(total + 4);
  let off = 0;

  buf[off++] = MAGIC_0;
  buf[off++] = MAGIC_1;
  buf[off++] = PROTOCOL_VERSION;
  buf[off++] = FRAME_BLOCK;
  writeU32(buf, off, streamId); off += 4;
  writeU32(buf, off, seq); off += 4;
  writeU16(buf, off, K); off += 2;
  writeU16(buf, off, blockSize); off += 2;
  writeU32(buf, off, seed); off += 4;

  buf.set(data, off); off += data.length;

  writeU32(buf, off, crc32(buf, 0, off));
  return buf;
}

// ── Decode ───────────────────────────────────────────────────────
function decodeFrame(bytes) {
  if (bytes.length < HEADER_SIZE_BLOCK + 4) return null;
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) return null;
  if (bytes[2] !== PROTOCOL_VERSION) return null;

  const type = bytes[3];

  if (type === FRAME_MANIFEST) {
    if (bytes.length < HEADER_SIZE_MANIFEST + 4) return null;
    const payloadEnd = bytes.length - 4;
    const expectedCrc = readU32(bytes, payloadEnd);
    if (crc32(bytes, 0, payloadEnd) !== expectedCrc) return null;

    const streamId = readU32(bytes, 4);
    const seq = readU32(bytes, 8);
    const K = readU16(bytes, 12);
    const blockSize = readU16(bytes, 14);
    const payloadCrc = readU32(bytes, 16);
    const flags = bytes[20];
    let off = 24;
    const nameLen = readU16(bytes, off); off += 2;
    const mimeLen = readU16(bytes, off); off += 2;
    const name = new TextDecoder().decode(bytes.subarray(off, off + nameLen)); off += nameLen;
    const mime = new TextDecoder().decode(bytes.subarray(off, off + mimeLen));

    return {
      type: 'manifest',
      streamId, seq, K, blockSize, payloadCrc, flags,
      name, mime,
      headerSize: HEADER_SIZE_MANIFEST,
    };
  }

  if (type === FRAME_BLOCK) {
    if (bytes.length < HEADER_SIZE_BLOCK + 4) return null;
    const payloadEnd = bytes.length - 4;
    const expectedCrc = readU32(bytes, payloadEnd);
    if (crc32(bytes, 0, payloadEnd) !== expectedCrc) return null;

    const streamId = readU32(bytes, 4);
    const seq = readU32(bytes, 8);
    const K = readU16(bytes, 12);
    const blockSize = readU16(bytes, 14);
    const seed = readU32(bytes, 16);
    const data = bytes.subarray(HEADER_SIZE_BLOCK, payloadEnd);

    return { type: 'block', streamId, seq, K, blockSize, seed, data };
  }

  return null;
}

// ── Export ───────────────────────────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = {
    crc32, encodeManifest, encodeBlock, decodeFrame,
    PROTOCOL_VERSION, FRAME_MANIFEST, FRAME_BLOCK,
    HEADER_SIZE_MANIFEST, HEADER_SIZE_BLOCK,
  };
}
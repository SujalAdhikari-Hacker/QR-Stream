/**
 * QR-Stream Pro — Optional AES-GCM Encryption
 * 
 * Password-derived key via PBKDF2 (600k iterations, SHA-256).
 * Authenticated encryption: decryption fails loudly if tampered.
 * Format: [12-byte IV][ciphertext + 16-byte tag]
 */

const PBKDF2_ITERATIONS = 600000;
const SALT_PREFIX = 'qr-stream-pro-v1';

async function deriveKey(password, streamId) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  const salt = enc.encode(SALT_PREFIX + ':' + streamId);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptPayload(plaintext, password, streamId) {
  const key = await deriveKey(password, streamId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, plaintext
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

async function decryptPayload(ciphertext, password, streamId) {
  const key = await deriveKey(password, streamId);
  const iv = ciphertext.subarray(0, 12);
  const ct = ciphertext.subarray(12);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, ct
    );
    return new Uint8Array(pt);
  } catch (e) {
    throw new Error('Decryption failed — wrong password or tampered data');
  }
}
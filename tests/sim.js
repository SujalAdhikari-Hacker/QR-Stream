/**
 * Experiment runner. Produces the numbers for the paper.
 *
 *   node tests/sim.js
 *
 * Models a lossy screen->camera link as a per-frame erasure channel: a frame
 * is either decoded (all its bytes arrive) or lost. That is what the real
 * system sees after QR error correction, so it is the right abstraction for
 * comparing coding and control strategies.
 */
const Q = require('../codec.js');

function rnd(n, seed) {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = s >>> 24; }
  return out;
}

const MB = 1024 * 1024;

async function run(size, blockSize, eccOver, lossRate, useFeedback, trials) {
  let framesSum = 0, symbolsSum = 0, kSum = 0, completed = 0, wallSum = 0;
  for (let t = 0; t < trials; t++) {
    const payload = rnd(size, 1000 + t * 7919 + size);
    const tx = new Q.Transmission(payload, { blockSize, ecc: eccOver, compress: false });
    await tx.init();
    const rx = new Q.ReceiverSession();
    let frames = 0, done = false, symbols0 = 0;
    const limit = 400000;
    while (!done && frames < limit) {
      const frame = tx.nextFrame();
      frames++;
      const keep = (Math.imul(frames + t * 12345, 2654435761) >>> 0) / 4294967296 >= lossRate;
      if (keep) {
        const res = rx.ingest(Q.base45Decode(Q.base45Encode(frame)));
        if (res.status === 'complete') done = true;
      }
      if (useFeedback && frames % 4 === 0) {
        let cur = 0;
        for (let i = 0; i < rx.totalRounds; i++) {
          const r = rx.rounds.get(i);
          if (!r || !r.complete) { cur = i; break; }
        }
        tx.applyFeedback({ doneMask: rx.roundsDone(), roundIndex: cur, miss: rx.missing(cur) });
      }
    }
    if (done) {
      const out = await rx.finalize();
      if (!out || out.error) throw new Error('finalize: ' + (out && out.error));
      if (out.data.length !== payload.length) throw new Error('length mismatch');
      completed++;
      framesSum += frames;
      symbolsSum += rx.symbols;
      kSum += tx.rounds.reduce((s, r) => s + r.K, 0);
      wallSum += frames; // frames are the currency; convert with fps outside
    }
  }
  return {
    completed,
    trials,
    frames: framesSum / Math.max(1, completed),
    symbols: symbolsSum / Math.max(1, completed),
    K: kSum / Math.max(1, completed),
    overhead: symbolsSum / Math.max(1, kSum),
  };
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

(async () => {
  const size = 100 * 1024;
  const trials = 12;

  console.log('\n=== 1. Symbol overhead vs loss (100 KB file, 500 B blocks) ===');
  console.log(pad('loss', 7) + pad('frames', 9) + pad('symbols', 9) + pad('K', 7) + pad('overhead', 10) + 'done');
  for (const loss of [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]) {
    const r = await run(size, 500, 'M', loss, true, trials);
    console.log(pad(pct(loss), 7) + pad(r.frames.toFixed(0), 9) + pad(r.symbols.toFixed(0), 9) +
      pad(r.K.toFixed(0), 7) + pad(r.overhead.toFixed(3) + 'x', 10) + r.completed + '/' + r.trials);
  }

  console.log('\n=== 2. Gaussian fallback: open loop (no feedback), 100 KB, 500 B ===');
  console.log(pad('loss', 7) + pad('peeling', 10) + pad('+gauss', 10) + 'symbols saved');
  for (const loss of [0.1, 0.2, 0.3, 0.4]) {
    Q.setGaussian(false);
    const a = await run(size, 500, 'M', loss, false, trials);
    Q.setGaussian(true);
    const b = await run(size, 500, 'M', loss, false, trials);
    const gain = a.frames > 0 ? (1 - b.frames / a.frames) : 0;
    console.log(pad(pct(loss), 7) + pad(a.frames.toFixed(0) + ' fr', 10) +
      pad(b.frames.toFixed(0) + ' fr', 10) + pct(gain));
  }
  Q.setGaussian(true);

  console.log('\n=== 3. Bytes per QR: base64 (old) vs base45 (new) ===');
  // For a fixed QR (fixed data-bit budget B):
  //   base64 -> byte mode     : 8 bits/char, 3 bytes per 4 chars
  //   base45 -> alphanumeric  : 11 bits per 2 chars, 2 bytes per 3 chars
  const per64 = (3 / 4) / 8;            // bytes per data bit
  const per45 = (2 / 3) / 5.5;
  console.log('  base64 + byte mode    : ' + (per64 * 1000).toFixed(2) + ' bytes per 1000 data bits');
  console.log('  base45 + alphanumeric : ' + (per45 * 1000).toFixed(2) + ' bytes per 1000 data bits');
  console.log('  payload gain          : ' + pct(per45 / per64 - 1));
  console.log('  100 KB in 500 B QRs   : ' + Math.ceil(102400 / 500) + ' -> ' +
    Math.ceil(102400 / (500 * per45 / per64)) + ' QR frames');

  console.log('\n=== 4. Open loop (no feedback) vs closed loop, 30% loss ===');
  for (const fb of [false, true]) {
    const r = await run(size, 500, 'M', 0.3, fb, trials);
    console.log('  ' + pad(fb ? 'closed loop' : 'open loop', 14) +
      pad(r.frames.toFixed(0) + ' frames', 14) + pad(r.overhead.toFixed(3) + 'x', 10) +
      r.completed + '/' + r.trials + ' completed');
  }

  console.log('\n=== 5. Time to send at 8 / 12 / 16 frames per second (5% loss) ===');
  console.log('  ' + pad('file', 10) + pad('QR frames', 14) + pad('8 fps', 11) + pad('12 fps', 11) + pad('16 fps', 11));
  for (const size2 of [50 * 1024, 100 * 1024, 500 * 1024, 1 * MB]) {
    const r = await run(size2, 500, 'M', 0.05, true, 4);
    let line = '  ' + pad((size2 / 1024) + ' KB', 10) + pad(r.frames.toFixed(0), 14);
    for (const fps of [8, 12, 16]) {
      const sec = r.frames / fps;
      line += pad((sec / 60 >= 1 ? (sec / 60).toFixed(1) + ' min' : sec.toFixed(0) + ' s'), 11);
    }
    console.log(line);
  }

  console.log('\n(500 B blocks, 12 trials per cell unless noted. A frame = one QR code shown.)\n');
})();

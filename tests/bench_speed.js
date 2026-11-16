/**
 * Max-Speed Multi-MB Benchmark (Spatial + RGB 3-Channel Multiplexing + 32-bit XOR)
 * Run: node tests/bench_speed.js
 */
const { performance } = require('perf_hooks');
const Q = require('../codec.js');

function rnd(n, seed) {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = s >>> 24; }
  return out;
}

async function benchMode(label, { size, blockSize, ecc, gridCount, refreshFps, lossRate }) {
  const payload = rnd(size, 4242);
  const tx = new Q.Transmission(payload, { blockSize, ecc, compress: false });
  await tx.init();
  const rx = new Q.ReceiverSession();
  let refreshes = 0, framesSent = 0, done = false;
  const t0 = performance.now();
  while (!done && refreshes < 50000) {
    const batch = tx.nextBatch(gridCount);
    refreshes++;
    for (let i = 0; i < batch.length; i++) {
      framesSent++;
      const drop = ((framesSent * 2654435761) >>> 0) / 4294967296 < lossRate;
      if (!drop) {
        const res = rx.ingest(Q.base45Decode(Q.base45Encode(batch[i])));
        if (res.status === 'complete') { done = true; break; }
      }
    }
    if (!done && refreshes % 2 === 0) {
      let cur = 0;
      for (let i = 0; i < rx.totalRounds; i++) {
        const r = rx.rounds.get(i);
        if (!r || !r.complete) { cur = i; break; }
      }
      tx.applyFeedback({ doneMask: rx.roundsDone(), roundIndex: cur, miss: rx.missing(cur) });
    }
  }
  const cpuMs = performance.now() - t0;
  const wallSec = refreshes / refreshFps;
  const goodputKBps = (size / 1024) / wallSec;
  console.log(
    label.padEnd(38) +
    `${refreshes} refr`.padEnd(11) +
    `${wallSec.toFixed(1)} s`.padEnd(9) +
    `${goodputKBps.toFixed(2)} KB/s`.padEnd(13) +
    `CPU=${cpuMs.toFixed(1)} ms`
  );
  return { label, refreshes, wallSec, goodputKBps, cpuMs };
}

(async () => {
  const MB = 1024 * 1024;
  console.log('\n=== 1 MB File Transfer (5% optical loss) ===');
  const b0 = await benchMode('Baseline 1x1 Mono (500B, M, 10fps)', { size: MB, blockSize: 500, ecc: 'M', gridCount: 1, refreshFps: 10, lossRate: 0.05 });
  const b1 = await benchMode('Turbo 2x1 Mono (2x700B, L, 15fps)', { size: MB, blockSize: 700, ecc: 'L', gridCount: 2, refreshFps: 15, lossRate: 0.05 });
  const b2 = await benchMode('Turbo 2x1 RGB  (6x700B, L, 15fps)', { size: MB, blockSize: 700, ecc: 'L', gridCount: 6, refreshFps: 15, lossRate: 0.05 });
  const b3 = await benchMode('Turbo 2x2 RGB  (12x600B, L, 15fps)', { size: MB, blockSize: 600, ecc: 'L', gridCount: 12, refreshFps: 15, lossRate: 0.05 });
  const b4 = await benchMode('Turbo 2x2 RGB  (12x700B, L, 20fps)', { size: MB, blockSize: 700, ecc: 'L', gridCount: 12, refreshFps: 20, lossRate: 0.05 });

  console.log('\nSpeedup vs Baseline (1 MB):');
  for (const b of [b1, b2, b3, b4]) {
    console.log(`  ${b.label.padEnd(38)} ${(b.goodputKBps / b0.goodputKBps).toFixed(2)}x faster (${b.wallSec.toFixed(1)} s)`);
  }

  console.log('\n=== Multi-MB Scaling (Turbo 2x2 RGB, 12x700B, 15 fps vs 20 fps, 5% loss) ===');
  for (const mb of [1, 2, 3, 5]) {
    const r15 = await benchMode(`${mb} MB @ 15 fps (2x2 RGB)`, { size: mb * MB, blockSize: 700, ecc: 'L', gridCount: 12, refreshFps: 15, lossRate: 0.05 });
    const r20 = await benchMode(`${mb} MB @ 20 fps (2x2 RGB)`, { size: mb * MB, blockSize: 700, ecc: 'L', gridCount: 12, refreshFps: 20, lossRate: 0.05 });
  }
})();

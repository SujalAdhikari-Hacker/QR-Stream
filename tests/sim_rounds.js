/**
 * Realistic closed-loop sim matching the phone log: 2 QRs per refresh, whole
 * refreshes dropped together (~12%), feedback every ~120 ms with ~10 frames of lag.
 *   node tests/sim_rounds.js
 */
const Q = require('../codec.js');

function rnd(n, seed) {
  let s = seed >>> 0; const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = s >>> 24; }
  return out;
}
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

async function run(size, { perRefresh = 2, loss = 0.12, fbEvery = 3, lag = 5, trials = 6, blockSize = 600 } = {}) {
  let refSum = 0, done = 0, symSum = 0, kSum = 0;
  for (let t = 0; t < trials; t++) {
    const payload = rnd(size, 77 + t);
    const tx = new Q.Transmission(payload, { blockSize, ecc: 'L', compress: false });
    await tx.init();
    const rx = new Q.ReceiverSession();
    const rand = lcg(1000 + t);
    const q = [];
    let refreshes = 0, fin = false;
    while (!fin && refreshes < 20000) {
      const batch = tx.nextBatch(perRefresh);
      refreshes++;
      if (rand() >= loss) {
        for (const f of batch) { if (rx.ingest(f).status === 'complete') { fin = true; break; } }
      }
      if (refreshes % fbEvery === 0) {
        let cur = 0;
        for (let i = 0; i < rx.totalRounds; i++) { const r = rx.rounds.get(i); if (!r || !r.complete) { cur = i; break; } }
        q.push({ at: refreshes + lag, fb: { doneMask: rx.roundsDone(), doneRounds: rx.doneRoundsList(), roundIndex: cur, miss: rx.missing(cur), needManifest: rx.needManifest ? rx.needManifest() : undefined } });
      }
      while (q.length && q[0].at <= refreshes) tx.applyFeedback(q.shift().fb);
    }
    if (fin) {
      const out = await rx.finalize();
      if (out.error || out.data.length !== payload.length) throw new Error('bad output');
      for (let i = 0; i < out.data.length; i++) if (out.data[i] !== payload[i]) throw new Error('corrupt');
      done++; refSum += refreshes; symSum += rx.symbols; kSum += tx.rounds.reduce((s, r) => s + r.K, 0);
    }
  }
  return { done, trials, refreshes: refSum / Math.max(1, done), K: kSum / Math.max(1, done), eff: kSum / Math.max(1, done) / perRefresh };
}

(async () => {
  console.log('=== 1) 2x2 Mono 1800B @ 18.2 fps (55ms), 12% refresh loss, 65ms feedback ===');
  console.log('size      refreshes  ideal(K/4)  ratio   @18.2fps   goodput     done');
  for (const kb of [1024, 5120, 10240]) {
    const r = await run(kb * 1024, { perRefresh: 4, loss: 0.12, fbEvery: 2, lag: 2, trials: 4, blockSize: 1800 });
    const sec = r.refreshes / 18.18;
    const kbps = (kb / sec).toFixed(1) + ' KB/s';
    console.log(`${String(kb + ' KB').padEnd(10)}${r.refreshes.toFixed(0).padEnd(11)}${r.eff.toFixed(0).padEnd(12)}${(r.refreshes / r.eff).toFixed(3).padEnd(8)}${(sec.toFixed(1) + 's').padEnd(11)}${kbps.padEnd(12)}${r.done}/${r.trials}`);
  }

  console.log('\n=== 2) 2x2 RGB 850B (12 QRs/fr) @ 14.3 fps (70ms), 15% refresh loss, 65ms feedback ===');
  console.log('size      refreshes  ideal(K/12) ratio   @14.3fps   goodput     done');
  for (const kb of [1024, 5120, 10240]) {
    const r = await run(kb * 1024, { perRefresh: 12, loss: 0.15, fbEvery: 2, lag: 2, trials: 4, blockSize: 850 });
    const sec = r.refreshes / 14.29;
    const kbps = (kb / sec).toFixed(1) + ' KB/s';
    console.log(`${String(kb + ' KB').padEnd(10)}${r.refreshes.toFixed(0).padEnd(11)}${r.eff.toFixed(0).padEnd(12)}${(r.refreshes / r.eff).toFixed(3).padEnd(8)}${(sec.toFixed(1) + 's').padEnd(11)}${kbps.padEnd(12)}${r.done}/${r.trials}`);
  }
})();

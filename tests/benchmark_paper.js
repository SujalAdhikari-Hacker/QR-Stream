/**
 * Comprehensive Paper Evaluation Suite for QR-Stream
 * Run: node tests/benchmark_paper.js
 * Outputs: paper/results.json + console summary tables
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const Q = require('../codec.js');

function rnd(n, seed) {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

async function simTransfer({ size, blockSize = 500, ecc = 'M', lossRate = 0, bursty = false, feedback = true, trials = 10, password = '', injectRate = 0, authRx = false }) {
  let framesSum = 0, symbolsSum = 0, kSum = 0, completed = 0, corruptRounds = 0, authRejected = 0;
  for (let t = 0; t < trials; t++) {
    const payload = rnd(size, 2000 + t * 7919 + size);
    const tx = new Q.Transmission(payload, { blockSize, ecc, compress: false, password });
    await tx.init();
    const rx = new Q.ReceiverSession(authRx && tx.macKey ? { macKey: tx.macKey } : {});
    const rand = lcg(9000 + t * 31337 + Math.round(lossRate * 1000));
    let frames = 0, done = false, inBurst = false;
    const limit = 20000;
    while (!done && frames < limit) {
      const frame = tx.nextFrame();
      frames++;
      let drop = false;
      if (bursty) {
        // Gilbert-Elliott 2-state bursty optical channel (e.g. hand jitter / defocus)
        if (!inBurst && rand() < lossRate * 0.25) inBurst = true;
        else if (inBurst && rand() < 0.25) inBurst = false;
        drop = inBurst ? (rand() < 0.85) : (rand() < lossRate * 0.3);
      } else {
        drop = rand() < lossRate;
      }
      if (!drop) {
        const res = rx.ingest(Q.base45Decode(Q.base45Encode(frame)));
        if (res.status === 'round-corrupt') corruptRounds++;
        if (res.status === 'complete') done = true;
      }
      // Active attacker injects forged frame with valid CRC-32 & streamId
      if (!done && injectRate > 0 && rand() < injectRate) {
        const rIdx = tx.roundIndex;
        const rObj = tx.rounds[rIdx];
        const forged = Q.encodeBlock(tx.streamId, rIdx, rObj.K, Math.floor(rand() * rObj.K), rnd(blockSize, frames + t));
        const rInj = rx.ingest(forged);
        if (rInj.status === 'round-corrupt') corruptRounds++;
        if (rInj.status === 'complete') done = true;
      }
      if (feedback && frames % 4 === 0) {
        let cur = 0;
        for (let i = 0; i < rx.totalRounds; i++) {
          const r = rx.rounds.get(i);
          if (!r || !r.complete) { cur = i; break; }
        }
        tx.applyFeedback({ doneMask: rx.roundsDone(), roundIndex: cur, miss: rx.missing(cur) });
      }
    }
    authRejected += rx.authRejected;
    if (done) {
      const out = await rx.finalize(password || undefined);
      if (out && !out.error && out.data.length === payload.length) {
        completed++;
        framesSum += frames;
        symbolsSum += rx.symbols;
        kSum += tx.rounds.reduce((s, r) => s + r.K, 0);
      }
    }
  }
  return {
    completed, trials,
    completionRate: completed / trials,
    avgFrames: completed ? framesSum / completed : null,
    avgSymbols: completed ? symbolsSum / completed : null,
    avgK: completed ? kSum / completed : null,
    overhead: completed ? symbolsSum / kSum : null,
    corruptRoundsPerTrial: corruptRounds / trials,
    authRejectedPerTrial: authRejected / trials,
  };
}

function benchAimdDynamic() {
  // Simulate a 30-second optical link trace:
  // 0-10s: sharp focus (camera max 12 fps, 5% optical loss)
  // 10-20s: defocus / motion blur (camera max 4 fps, 45% optical loss)
  // 20-30s: refocused (camera max 12 fps, 5% optical loss)
  function runPolicy(adaptive) {
    const ctl = new Q.RateController({ start: 100, min: 60, max: 500 });
    let interval = 100; // 10 fps start
    let t = 0, decoded = 0, sent = 0, wasted = 0;
    const trace = [];
    const rand = lcg(4242);
    let lastSampleT = 0, lastDec = 0, lastSent = 0;
    while (t < 30000) {
      const camCapFps = (t >= 10000 && t < 20000) ? 4 : 12;
      const optLoss = (t >= 10000 && t < 20000) ? 0.45 : 0.05;
      const sendFps = 1000 / interval;
      // Probability a sent frame is captured & decoded by camera
      const capProb = Math.min(1, camCapFps / sendFps) * (1 - optLoss);
      sent++;
      if (rand() < capProb) decoded++;
      else wasted++;
      t += interval;
      if (t - lastSampleT >= 250) {
        const dt = (t - lastSampleT) / 1000;
        const dRate = (decoded - lastDec) / dt;
        const sRate = (sent - lastSent) / dt;
        if (adaptive && sRate > 0) interval = ctl.update(dRate / sRate);
        trace.push({ tSec: +(t / 1000).toFixed(2), intervalMs: interval, sendFps: +(1000 / interval).toFixed(2), decodeFps: +dRate.toFixed(2) });
        lastSampleT = t; lastDec = decoded; lastSent = sent;
      }
    }
    return { sent, decoded, wasted, deliveryRatio: +(decoded / sent).toFixed(3), goodputKBps: +((decoded * 500) / 30 / 1024).toFixed(2), trace };
  }
  return { fixed10fps: runPolicy(false), aimdAdaptive: runPolicy(true) };
}

async function benchMicro() {
  const cryptoBench = [];
  for (const size of [10 * 1024, 100 * 1024, 500 * 1024, 1024 * 1024]) {
    const data = rnd(size, size);
    const t0 = performance.now();
    const tx = new Q.Transmission(data, { password: 'bench-password', compress: false });
    await tx.init();
    const initMs = performance.now() - t0;

    const f0 = tx.nextFrame();
    const t1 = performance.now();
    for (let i = 0; i < 200; i++) tx.nextFrame();
    const frameGenUs = ((performance.now() - t1) / 200) * 1000;

    const t2 = performance.now();
    for (let i = 0; i < 200; i++) Q.decodeFrame(f0, tx.macKey);
    const frameAuthUs = ((performance.now() - t2) / 200) * 1000;

    const b45 = Q.base45Encode(f0);
    const t3 = performance.now();
    for (let i = 0; i < 500; i++) Q.base45Decode(b45);
    const b45Us = ((performance.now() - t3) / 500) * 1000;

    cryptoBench.push({
      sizeKB: size / 1024,
      pbkdf2AesInitMs: +initMs.toFixed(1),
      frameGenAndHmacUs: +frameGenUs.toFixed(1),
      frameVerifyHmacUs: +frameAuthUs.toFixed(1),
      base45DecodeUs: +b45Us.toFixed(1),
    });
  }

  // GF(2) Gaussian solve time vs K
  const gaussBench = [];
  for (const K of [32, 64, 100, 150, 200]) {
    const trials = 5;
    let totalMs = 0;
    for (let t = 0; t < trials; t++) {
      const dec = new Q.RoundDecoder(K, 500, 0);
      const t0 = performance.now();
      for (let s = K; s < K * 2 + 20 && !dec.isComplete(); s++) {
        dec.addSymbol(s, rnd(500, s + t * 1000));
      }
      totalMs += performance.now() - t0;
    }
    gaussBench.push({ K, avgDecodeMs: +(totalMs / trials).toFixed(2) });
  }
  return { cryptoBench, gaussBench };
}

(async () => {
  const outDir = path.join(__dirname, '..', 'paper');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Running QR-Stream Paper Benchmark Suite...\n');

  // 1. Open-loop (Peeling vs +Gauss) vs Closed-loop across IID loss
  const exp1 = [];
  for (const loss of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
    Q.setGaussian(false);
    const openPeel = await simTransfer({ size: 100 * 1024, lossRate: loss, feedback: false, trials: 10 });
    Q.setGaussian(true);
    const openGauss = await simTransfer({ size: 100 * 1024, lossRate: loss, feedback: false, trials: 10 });
    const closed = await simTransfer({ size: 100 * 1024, lossRate: loss, feedback: true, trials: 10 });
    exp1.push({ lossPct: loss * 100, openPeel, openGauss, closed });
    console.log(`Loss ${(loss * 100).toFixed(0).padStart(2)}%: OpenPeel=${openPeel.avgFrames?.toFixed(0) || 'FAIL'} fr | OpenGauss=${openGauss.avgFrames?.toFixed(0)} fr (${openGauss.overhead?.toFixed(3)}x) | Closed=${closed.avgFrames?.toFixed(0)} fr (${closed.overhead?.toFixed(3)}x)`);
  }

  // 2. Bursty Gilbert-Elliott channel
  const exp2 = [];
  for (const loss of [0.1, 0.2, 0.3, 0.4]) {
    const burstOpen = await simTransfer({ size: 100 * 1024, lossRate: loss, bursty: true, feedback: false, trials: 10 });
    const burstClosed = await simTransfer({ size: 100 * 1024, lossRate: loss, bursty: true, feedback: true, trials: 10 });
    exp2.push({ lossPct: loss * 100, burstOpen, burstClosed });
    console.log(`Bursty ${(loss * 100).toFixed(0)}%: Open=${burstOpen.avgFrames?.toFixed(0)} fr (${burstOpen.completionRate * 100}%) | Closed=${burstClosed.avgFrames?.toFixed(0)} fr (${burstClosed.completionRate * 100}%)`);
  }

  // 3. Adversarial Frame-Poisoning Attack (CRC-32 only vs Per-Frame HMAC-SHA256)
  const exp3 = [];
  for (const inj of [0, 0.01, 0.05, 0.10, 0.20]) {
    const noAuth = await simTransfer({ size: 50 * 1024, lossRate: 0.05, feedback: true, trials: 10, password: '', injectRate: inj, authRx: false });
    const withAuth = await simTransfer({ size: 50 * 1024, lossRate: 0.05, feedback: true, trials: 10, password: 'audit-key', injectRate: inj, authRx: true });
    exp3.push({ injectPct: inj * 100, noAuth, withAuth });
    console.log(`Poison ${(inj * 100).toFixed(0).padStart(2)}%: NoAuth comp=${(noAuth.completionRate * 100).toFixed(0)}% corrupt=${noAuth.corruptRoundsPerTrial.toFixed(1)} | HMAC comp=${(withAuth.completionRate * 100).toFixed(0)}% corrupt=${withAuth.corruptRoundsPerTrial.toFixed(1)} rejected=${withAuth.authRejectedPerTrial.toFixed(1)}`);
  }

  // 4. Dynamic channel AIMD vs Fixed-Rate
  const exp4 = benchAimdDynamic();
  console.log(`\nDynamic Channel (30s): Fixed10fps delivery=${exp4.fixed10fps.deliveryRatio} goodput=${exp4.fixed10fps.goodputKBps} KB/s | AIMD delivery=${exp4.aimdAdaptive.deliveryRatio} goodput=${exp4.aimdAdaptive.goodputKBps} KB/s`);

  // 5. Microbenchmarks
  const exp5 = await benchMicro();
  console.log('\nMicrobenchmarks:', JSON.stringify(exp5.cryptoBench));
  console.log('GF(2) Solve:', JSON.stringify(exp5.gaussBench));

  // 6. Spatial & RGB Multiplexing Throughput Comparison (1 MB, 5% optical loss)
  async function benchGrid(label, { size, blockSize, ecc, gridCount, refreshFps, lossRate }) {
    const payload = rnd(size, 7000 + gridCount + size);
    const tx = new Q.Transmission(payload, { blockSize, ecc, compress: false });
    await tx.init();
    const rx = new Q.ReceiverSession();
    const rand = lcg(8000 + gridCount);
    let refreshes = 0, done = false;
    while (!done && refreshes < 25000) {
      const batch = tx.nextBatch(gridCount);
      refreshes++;
      for (const f of batch) {
        if (rand() >= lossRate) {
          if (rx.ingest(Q.base45Decode(Q.base45Encode(f))).status === 'complete') { done = true; break; }
        }
      }
      if (!done && refreshes % 2 === 0) {
        let cur = 0;
        for (let i = 0; i < rx.totalRounds; i++) {
          const r = rx.rounds.get(i);
          if (!r || !r.complete) { cur = i; break; }
        }
        tx.applyFeedback({ doneMask: rx.roundsDone(), doneRounds: rx.doneRoundsList(), roundIndex: cur, miss: rx.missing(cur) });
      }
    }
    const wallSec = refreshes / refreshFps;
    return {
      label,
      sizeKB: Math.round(size / 1024),
      refreshes,
      wallSec: +wallSec.toFixed(2),
      goodputKBps: +((size / 1024) / wallSec).toFixed(2),
    };
  }

  const MB = 1024 * 1024;
  const exp6Modes = [
    await benchGrid('1x1 Mono (500B, M, 10fps)', { size: MB, blockSize: 500, ecc: 'M', gridCount: 1, refreshFps: 10, lossRate: 0.05 }),
    await benchGrid('2x1 Mono (650B, L, 13.3fps)', { size: MB, blockSize: 650, ecc: 'L', gridCount: 2, refreshFps: 13.33, lossRate: 0.05 }),
    await benchGrid('2x2 Mono (900B, L, 15fps)', { size: MB, blockSize: 900, ecc: 'L', gridCount: 4, refreshFps: 15, lossRate: 0.05 }),
    await benchGrid('2x1 RGB  (650B, L, 13.3fps)', { size: MB, blockSize: 650, ecc: 'L', gridCount: 6, refreshFps: 13.33, lossRate: 0.05 }),
    await benchGrid('2x2 RGB  (750B, L, 14fps)', { size: MB, blockSize: 750, ecc: 'L', gridCount: 12, refreshFps: 14, lossRate: 0.05 }),
  ];
  const exp6Scaling = [
    await benchGrid('0.25 MB', { size: 256 * 1024, blockSize: 650, ecc: 'L', gridCount: 2, refreshFps: 13.33, lossRate: 0.05 }),
    await benchGrid('1 MB', { size: MB, blockSize: 650, ecc: 'L', gridCount: 2, refreshFps: 13.33, lossRate: 0.05 }),
    await benchGrid('3 MB', { size: 3 * MB, blockSize: 650, ecc: 'L', gridCount: 2, refreshFps: 13.33, lossRate: 0.05 }),
    await benchGrid('5 MB', { size: 5 * MB, blockSize: 650, ecc: 'L', gridCount: 2, refreshFps: 13.33, lossRate: 0.05 }),
  ];
  const exp6 = { modes: exp6Modes, scaling2x1: exp6Scaling };
  console.log('\nMultiplexing (1 MB):', exp6Modes.map(x => `${x.label}=${x.goodputKBps} KB/s (${x.wallSec}s)`).join(' | '));

  const results = { generatedAt: new Date().toISOString(), exp1, exp2, exp3, exp4, exp5, exp6 };
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved paper/results.json');
})();

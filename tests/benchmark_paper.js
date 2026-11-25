/**
 * Comprehensive Evaluation Suite for QR-Stream
 * Run: node tests/benchmark_paper.js
 * Outputs: paper/results.json + console summary tables
 *
 * Benchmarks the actual codec.js and vendor/qrcode.js modules using the
 * current sender defaults (2x1 Mono, 650 B blocks, ECC L, 75 ms interval).
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const Q = require('../codec.js');
const qrcode = require('../vendor/qrcode.js');

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

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function currentRound(rx) {
  for (let i = 0; i < rx.totalRounds; i++) {
    const r = rx.rounds.get(i);
    if (!r || !r.complete) return i;
  }
  return 0;
}

async function simTransfer({ size, blockSize = 650, ecc = 'L', lossRate = 0, bursty = false, feedback = true, trials = 10, password = '', injectRate = 0, authRx = false }) {
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
        const cur = currentRound(rx);
        tx.applyFeedback({
          doneMask: rx.roundsDone(),
          doneRounds: rx.doneRoundsList(),
          totalRounds: rx.totalRounds,
          roundIndex: cur,
          miss: rx.missing(cur),
        });
      }
    }
    authRejected += rx.authRejected;
    if (done) {
      const out = await rx.finalize(password || undefined);
      if (out && !out.error) {
        if (!sameBytes(out.data, payload)) {
          throw new Error(`Payload byte mismatch in simTransfer (size=${size}, trial=${t})`);
        }
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

function benchRateControlDynamic() {
  // Simulate a 30-second optical link trace matching sender.html (2x1 Mono, 650 B/QR, 2 QRs/refresh = 1300 B/refresh)
  // RateController defaults in sender.html: start=75 ms (13.33 fps), min=40 ms (25 fps), max=180 ms (5.56 fps), step=1.4x
  // 0-10s: sharp focus (camera max 20 refreshes/s, 5% optical loss)
  // 10-20s: defocus / motion blur (camera max 6 refreshes/s, 45% optical loss)
  // 20-30s: refocused (camera max 20 refreshes/s, 5% optical loss)
  function runPolicy(adaptive) {
    const ctl = new Q.RateController({ start: 75, min: 40, max: 180 });
    let interval = 75;
    let t = 0, decoded = 0, sent = 0, wasted = 0;
    const trace = [];
    const rand = lcg(4242);
    let lastSampleT = 0, lastDec = 0, lastSent = 0;
    while (t < 30000) {
      const camCapFps = (t >= 10000 && t < 20000) ? 6 : 20;
      const optLoss = (t >= 10000 && t < 20000) ? 0.45 : 0.05;
      const sendFps = 1000 / interval;
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
        trace.push({
          tSec: +(t / 1000).toFixed(2),
          intervalMs: interval,
          sendFps: +(1000 / interval).toFixed(2),
          decodeFps: +dRate.toFixed(2),
        });
        lastSampleT = t; lastDec = decoded; lastSent = sent;
      }
    }
    return {
      sentRefreshes: sent,
      decodedRefreshes: decoded,
      wastedRefreshes: wasted,
      deliveryRatio: +(decoded / sent).toFixed(3),
      goodputKBps: +((decoded * 2 * 650) / 30 / 1024).toFixed(2),
      trace,
    };
  }
  return { fixed75ms: runPolicy(false), adaptive: runPolicy(true) };
}

async function benchMicro() {
  const cryptoBench = [];
  for (const size of [10 * 1024, 100 * 1024, 500 * 1024, 1024 * 1024]) {
    const data = rnd(size, size);
    const t0 = performance.now();
    const tx = new Q.Transmission(data, { password: 'bench-password', compress: false, blockSize: 650, ecc: 'L' });
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

  // GF(2) Gaussian solve time vs K at current default 650 B blocks
  const gaussBench = [];
  for (const K of [32, 64, 100, 150, 200]) {
    const trials = 5;
    let totalMs = 0;
    for (let t = 0; t < trials; t++) {
      const dec = new Q.RoundDecoder(K, 650, 0);
      const t0 = performance.now();
      for (let s = K; s < K * 2 + 20 && !dec.isComplete(); s++) {
        dec.addSymbol(s, rnd(650, s + t * 1000));
      }
      totalMs += performance.now() - t0;
    }
    gaussBench.push({ K, avgDecodeMs: +(totalMs / trials).toFixed(2) });
  }

  // Real vendor/qrcode.js matrix encode timings
  const encodeConfigs = [
    { label: '1x1 Mono (500B, M)', blockSize: 500, ecc: 'M', gridCount: 1 },
    { label: '1x1 Mono (650B, L)', blockSize: 650, ecc: 'L', gridCount: 1 },
    { label: '2x1 Mono (650B, L)', blockSize: 650, ecc: 'L', gridCount: 2 },
    { label: '2x2 Mono (650B, L)', blockSize: 650, ecc: 'L', gridCount: 4 },
    { label: '2x1 RGB (650B, L)',  blockSize: 650, ecc: 'L', gridCount: 6 },
    { label: '2x2 RGB (650B, L)',  blockSize: 650, ecc: 'L', gridCount: 12 },
  ];
  const qrEncodeBench = [];
  for (const cfg of encodeConfigs) {
    const texts = [];
    for (let i = 0; i < cfg.gridCount; i++) {
      texts.push(Q.base45Encode(rnd(cfg.blockSize + 20, 5000 + cfg.blockSize + i)));
    }
    const probe = qrcode(0, cfg.ecc);
    probe.addData(texts[0], 'Alphanumeric');
    probe.make();
    const modules = probe.getModuleCount();
    const qrVersion = (modules - 17) / 4;

    // 2 warmup iterations
    for (let w = 0; w < 2; w++) {
      for (let i = 0; i < cfg.gridCount; i++) {
        const q = qrcode(qrVersion, cfg.ecc);
        q.addData(texts[i], 'Alphanumeric');
        q.make();
      }
    }
    const iters = 15;
    const t0 = performance.now();
    for (let k = 0; k < iters; k++) {
      for (let i = 0; i < cfg.gridCount; i++) {
        const q = qrcode(qrVersion, cfg.ecc);
        q.addData(texts[i], 'Alphanumeric');
        q.make();
      }
    }
    const batchEncodeMs = (performance.now() - t0) / iters;
    qrEncodeBench.push({
      label: cfg.label,
      blockSize: cfg.blockSize,
      ecc: cfg.ecc,
      gridCount: cfg.gridCount,
      qrVersion,
      modules,
      batchEncodeMs: +batchEncodeMs.toFixed(2),
      maxEncodeFps: +(1000 / batchEncodeMs).toFixed(2),
    });
  }

  // Real Base45 + Alphanumeric vs Base64 + Byte comparison on a 670 B frame (650 B payload + 20 B header/CRC)
  const sampleFrame = Q.encodeBlock(0x12345678, 0, 152, 0, rnd(650, 99));
  const b45Text = Q.base45Encode(sampleFrame);
  const b64Text = Buffer.from(sampleFrame).toString('base64');
  const qrB45 = qrcode(0, 'L');
  qrB45.addData(b45Text, 'Alphanumeric');
  qrB45.make();
  const qrB64 = qrcode(0, 'L');
  qrB64.addData(b64Text, 'Byte');
  qrB64.make();

  const per64 = (3 / 4) / 8;
  const per45 = (2 / 3) / 5.5;
  const encodingCompare = {
    frameBytes: sampleFrame.length,
    ecc: 'L',
    base45: {
      chars: b45Text.length,
      qrVersion: (qrB45.getModuleCount() - 17) / 4,
      modules: qrB45.getModuleCount(),
      bytesPer1000DataBits: +(per45 * 1000).toFixed(2),
    },
    base64: {
      chars: b64Text.length,
      qrVersion: (qrB64.getModuleCount() - 17) / 4,
      modules: qrB64.getModuleCount(),
      bytesPer1000DataBits: +(per64 * 1000).toFixed(2),
    },
    theoreticalGainPct: +(((per45 / per64) - 1) * 100).toFixed(1),
  };

  return { cryptoBench, gaussBench, qrEncodeBench, encodingCompare };
}

(async () => {
  const outDir = path.join(__dirname, '..', 'paper');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Running QR-Stream Verified Benchmark Suite (current code defaults: 2x1 Mono, 650 B, ECC L, 75 ms)...\n');

  // 1. Open-loop (Peeling vs +Gauss) vs Closed-loop across IID loss (650 B, ECC L)
  const exp1 = [];
  for (const loss of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
    Q.setGaussian(false);
    const openPeel = await simTransfer({ size: 100 * 1024, blockSize: 650, ecc: 'L', lossRate: loss, feedback: false, trials: 10 });
    Q.setGaussian(true);
    const openGauss = await simTransfer({ size: 100 * 1024, blockSize: 650, ecc: 'L', lossRate: loss, feedback: false, trials: 10 });
    const closed = await simTransfer({ size: 100 * 1024, blockSize: 650, ecc: 'L', lossRate: loss, feedback: true, trials: 10 });
    exp1.push({ lossPct: loss * 100, openPeel, openGauss, closed });
    console.log(`Loss ${(loss * 100).toFixed(0).padStart(2)}%: OpenPeel=${openPeel.avgFrames?.toFixed(1) || 'FAIL'} fr | OpenGauss=${openGauss.avgFrames?.toFixed(1)} fr (${openGauss.overhead?.toFixed(3)}x) | Closed=${closed.avgFrames?.toFixed(1)} fr (${closed.overhead?.toFixed(3)}x)`);
  }

  // 2. Bursty Gilbert-Elliott channel (650 B, ECC L)
  const exp2 = [];
  for (const loss of [0.1, 0.2, 0.3, 0.4]) {
    const burstOpen = await simTransfer({ size: 100 * 1024, blockSize: 650, ecc: 'L', lossRate: loss, bursty: true, feedback: false, trials: 10 });
    const burstClosed = await simTransfer({ size: 100 * 1024, blockSize: 650, ecc: 'L', lossRate: loss, bursty: true, feedback: true, trials: 10 });
    exp2.push({ lossPct: loss * 100, burstOpen, burstClosed });
    console.log(`Bursty ${(loss * 100).toFixed(0)}%: Open=${burstOpen.avgFrames?.toFixed(1)} fr (${(burstOpen.completionRate * 100).toFixed(0)}%) | Closed=${burstClosed.avgFrames?.toFixed(1)} fr (${(burstClosed.completionRate * 100).toFixed(0)}%)`);
  }

  // 3. Adversarial Frame-Poisoning Attack (CRC-32 only vs Per-Frame 64-bit HMAC-SHA256)
  const exp3 = [];
  for (const inj of [0, 0.01, 0.05, 0.10, 0.20]) {
    const noAuth = await simTransfer({ size: 50 * 1024, blockSize: 650, ecc: 'L', lossRate: 0.05, feedback: true, trials: 10, password: '', injectRate: inj, authRx: false });
    const withAuth = await simTransfer({ size: 50 * 1024, blockSize: 650, ecc: 'L', lossRate: 0.05, feedback: true, trials: 10, password: 'audit-key', injectRate: inj, authRx: true });
    exp3.push({ injectPct: inj * 100, noAuth, withAuth });
    console.log(`Poison ${(inj * 100).toFixed(0).padStart(2)}%: NoAuth comp=${(noAuth.completionRate * 100).toFixed(0)}% corrupt=${noAuth.corruptRoundsPerTrial.toFixed(1)} | HMAC comp=${(withAuth.completionRate * 100).toFixed(0)}% corrupt=${withAuth.corruptRoundsPerTrial.toFixed(1)} rejected=${withAuth.authRejectedPerTrial.toFixed(1)}`);
  }

  // 4. Dynamic channel RateController (1.4x step) vs Fixed 75 ms
  const exp4 = benchRateControlDynamic();
  console.log(`\nDynamic Channel (30s, 2x1 Mono 650B): Fixed75ms delivery=${exp4.fixed75ms.deliveryRatio} goodput=${exp4.fixed75ms.goodputKBps} KB/s | Adaptive delivery=${exp4.adaptive.deliveryRatio} goodput=${exp4.adaptive.goodputKBps} KB/s`);

  // 5. Microbenchmarks (Crypto + GF(2) + Real vendor/qrcode.js encode + Base45 vs Base64)
  const exp5 = await benchMicro();
  console.log('\nCrypto Microbenchmarks:', JSON.stringify(exp5.cryptoBench));
  console.log('GF(2) Solve (650B):', JSON.stringify(exp5.gaussBench));
  console.log('QR Encode (vendor/qrcode.js):', exp5.qrEncodeBench.map(x => `${x.label}=v${x.qrVersion} ${x.batchEncodeMs}ms (${x.maxEncodeFps}fps)`).join(' | '));
  console.log('Base45 vs Base64 (670B frame, ECC L):', JSON.stringify(exp5.encodingCompare));

  // 6. Spatial & RGB Multiplexing Protocol Goodput (excludes phone camera optics; FPS capped by measured qrcode.js encode)
  const encodeCapMap = new Map(exp5.qrEncodeBench.map(x => [`${x.blockSize}:${x.ecc}:${x.gridCount}`, x.maxEncodeFps]));

  async function benchGrid(label, { size, blockSize, ecc, gridCount, targetFps, lossRate }) {
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
        const cur = currentRound(rx);
        tx.applyFeedback({
          doneMask: rx.roundsDone(),
          doneRounds: rx.doneRoundsList(),
          totalRounds: rx.totalRounds,
          roundIndex: cur,
          miss: rx.missing(cur),
        });
      }
    }
    if (!done) throw new Error(`benchGrid failed to complete: ${label}`);
    const out = await rx.finalize();
    if (!out || out.error || !sameBytes(out.data, payload)) {
      throw new Error(`benchGrid byte verification failed: ${label} (${out && out.error})`);
    }
    const maxEncodeFps = encodeCapMap.get(`${blockSize}:${ecc}:${gridCount}`) || targetFps;
    const effectiveFps = +Math.min(targetFps, maxEncodeFps).toFixed(2);
    const wallSec = refreshes / effectiveFps;
    const kTotal = tx.rounds.reduce((s, r) => s + r.K, 0);
    return {
      label,
      sizeKB: Math.round(size / 1024),
      rounds: tx.rounds.length,
      K: kTotal,
      symbols: rx.symbols,
      overhead: +(rx.symbols / kTotal).toFixed(3),
      refreshes,
      targetFps: +targetFps.toFixed(2),
      effectiveFps,
      wallSec: +wallSec.toFixed(2),
      goodputKBps: +((size / 1024) / wallSec).toFixed(2),
      verified: true,
    };
  }

  const MB = 1024 * 1024;
  const exp6Modes = [
    await benchGrid('1x1 Mono (500B, M, 10fps)',  { size: MB, blockSize: 500, ecc: 'M', gridCount: 1,  targetFps: 10,    lossRate: 0.05 }),
    await benchGrid('1x1 Mono (650B, L, 75ms)',   { size: MB, blockSize: 650, ecc: 'L', gridCount: 1,  targetFps: 13.33, lossRate: 0.05 }),
    await benchGrid('2x1 Mono (650B, L, 75ms)',   { size: MB, blockSize: 650, ecc: 'L', gridCount: 2,  targetFps: 13.33, lossRate: 0.05 }),
    await benchGrid('2x2 Mono (650B, L, 75ms)',   { size: MB, blockSize: 650, ecc: 'L', gridCount: 4,  targetFps: 13.33, lossRate: 0.05 }),
    await benchGrid('2x1 RGB (650B, L, 75ms)',    { size: MB, blockSize: 650, ecc: 'L', gridCount: 6,  targetFps: 13.33, lossRate: 0.05 }),
    await benchGrid('2x2 RGB (650B, L, 75ms)',    { size: MB, blockSize: 650, ecc: 'L', gridCount: 12, targetFps: 13.33, lossRate: 0.05 }),
  ];
  const exp6Scaling = [
    await benchGrid('0.25 MB', { size: 256 * 1024, blockSize: 650, ecc: 'L', gridCount: 2, targetFps: 13.33, lossRate: 0.05 }),
    await benchGrid('1 MB',    { size: MB,         blockSize: 650, ecc: 'L', gridCount: 2, targetFps: 13.33, lossRate: 0.05 }),
    await benchGrid('3 MB',    { size: 3 * MB,     blockSize: 650, ecc: 'L', gridCount: 2, targetFps: 13.33, lossRate: 0.05 }),
    await benchGrid('5 MB',    { size: 5 * MB,     blockSize: 650, ecc: 'L', gridCount: 2, targetFps: 13.33, lossRate: 0.05 }),
  ];
  const exp6 = { modes: exp6Modes, scaling2x1: exp6Scaling };
  console.log('\nProtocol Goodput (1 MB, 5% loss, encode-capped):', exp6Modes.map(x => `${x.label}=${x.goodputKBps} KB/s (${x.wallSec}s @ ${x.effectiveFps}fps)`).join(' | '));
  console.log('2x1 Mono Scaling:', exp6Scaling.map(x => `${x.label}=${x.goodputKBps} KB/s (${x.wallSec}s, ${x.rounds}r)`).join(' | '));

  const results = {
    generatedAt: new Date().toISOString(),
    env: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    senderDefaults: {
      gridMode: '2x1',
      colorMode: 'mono',
      blockSize: 650,
      ecc: 'L',
      intervalMs: 75,
    },
    exp1,
    exp2,
    exp3,
    exp4,
    exp5,
    exp6,
  };
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved paper/results.json');
})();

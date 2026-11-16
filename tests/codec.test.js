/**
 * Codec tests. Run: node tests/codec.test.js
 * No framework: plain asserts so it runs anywhere Node does.
 */
const assert = require('assert');
const Q = require('../codec.js');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

function rnd(n, seed) {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

// ── crc ──────────────────────────────────────────────────────────────────
ok('crc32 known vector', () => {
  assert.strictEqual(Q.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.strictEqual(Q.crc32(new Uint8Array(0)), 0);
});

// ── base45 ───────────────────────────────────────────────────────────────
ok('base45 RFC 9285 vectors', () => {
  const enc = (s) => Q.base45Encode(new TextEncoder().encode(s));
  assert.strictEqual(enc('AB'), 'BB8');
  assert.strictEqual(enc('Hello!!'), '%69 VD92EX0');
  assert.strictEqual(enc('base-45'), 'UJCLQE7W581');
  assert.strictEqual(enc('ietf!'), 'QED8WEX0');
});

ok('base45 round-trips every length 0..300, all byte values', () => {
  for (let n = 0; n <= 300; n++) {
    const src = rnd(n, 1234 + n);
    if (n > 0) { src[0] = 0; src[n - 1] = 255; }
    const back = Q.base45Decode(Q.base45Encode(src));
    assert.strictEqual(back.length, n, 'length ' + n);
    for (let i = 0; i < n; i++) assert.strictEqual(back[i], src[i], `byte ${i} of ${n}`);
  }
});

ok('base45 is alphanumeric-QR safe', () => {
  const s = Q.base45Encode(rnd(200, 7));
  assert.ok(/^[0-9A-Z $%*+\-./:]+$/.test(s), 'unexpected chars: ' + s);
});

ok('base45 rejects corrupt input', () => {
  assert.throws(() => Q.base45Decode('A'));
  assert.throws(() => Q.base45Decode('ZZZ'));
  assert.throws(() => Q.base45Decode('ab0'));
});

// ── frames ───────────────────────────────────────────────────────────────
ok('file manifest round-trip (unicode name)', () => {
  const b = Q.encodeFileManifest(0xDEADBEEF, 7, 123456, 99999, 0xAABBCCDD, 3, 'résumé ✓.bin', 'application/pdf');
  const f = Q.decodeFrame(b);
  assert.strictEqual(f.type, 'file');
  assert.strictEqual(f.streamId, 0xDEADBEEF);
  assert.strictEqual(f.totalRounds, 7);
  assert.strictEqual(f.origSize, 123456);
  assert.strictEqual(f.txSize, 99999);
  assert.strictEqual(f.name, 'résumé ✓.bin');
  assert.strictEqual(f.mime, 'application/pdf');
  assert.strictEqual(f.flags, 3);
});

ok('round manifest round-trip', () => {
  const b = Q.encodeRoundManifest(42, 3, 9, 137, 700, 200000, 70000, 0x12345678, 'H');
  const f = Q.decodeFrame(b);
  assert.deepStrictEqual(
    { t: f.type, r: f.round, n: f.totalRounds, K: f.K, bs: f.blockSize,
      off: f.offset, len: f.length, crc: f.roundCrc, ecc: f.ecc },
    { t: 'round', r: 3, n: 9, K: 137, bs: 700, off: 200000, len: 70000, crc: 0x12345678, ecc: 'H' });
});

ok('block round-trip', () => {
  const data = rnd(500, 99);
  const b = Q.encodeBlock(7, 2, 61, 1234, data);
  assert.strictEqual(b.length, 20 + 500);
  const f = Q.decodeFrame(b);
  assert.strictEqual(f.type, 'block');
  assert.strictEqual(f.round, 2);
  assert.strictEqual(f.K, 61);
  assert.strictEqual(f.seed, 1234);
  assert.deepStrictEqual(Buffer.from(f.data), Buffer.from(data));
});

ok('every single-bit corruption is rejected', () => {
  const b = Q.encodeBlock(7, 2, 61, 5, rnd(300, 3));
  for (let i = 0; i < b.length; i++) {
    const c = Uint8Array.from(b); c[i] ^= 0x40;
    assert.strictEqual(Q.decodeFrame(c), null, 'byte ' + i);
  }
});

ok('garbage / truncated input never throws', () => {
  for (let n = 0; n < 40; n++) {
    assert.strictEqual(Q.decodeFrame(rnd(n, n)), null);
  }
  const b = Q.encodeBlock(1, 0, 1, 0, rnd(100, 1));
  for (let cut = 0; cut < b.length; cut++) assert.strictEqual(Q.decodeFrame(b.subarray(0, cut)), null);
});

// ── symbol determinism ───────────────────────────────────────────────────
ok('symbolIndices is deterministic and in range', () => {
  for (const K of [1, 2, 5, 40, 137]) {
    for (let seed = 0; seed < 60; seed++) {
      const a = Q.symbolIndices(seed, 3, K);
      const b = Q.symbolIndices(seed, 3, K);
      assert.deepStrictEqual(a, b);
      for (const i of a) assert.ok(i >= 0 && i < K, `idx ${i} for K=${K}`);
      assert.strictEqual(new Set(a).size, a.length, 'duplicate index');
      if (seed < K) assert.deepStrictEqual(a, [seed]);
    }
  }
});

ok('different rounds give different index sets', () => {
  const a = Q.symbolIndices(50, 0, 40).join();
  const b = Q.symbolIndices(50, 1, 40).join();
  assert.notStrictEqual(a, b);
});

// ── full pipeline ────────────────────────────────────────────────────────
async function transfer(payload, opts, lossPlan, withFeedback) {
  const tx = new Q.Transmission(payload, opts);
  await tx.init();
  const rx = new Q.ReceiverSession();
  let frames = 0, done = false;
  const limit = 200000;
  while (!done && frames < limit) {
    const frame = tx.nextFrame();
    frames++;
    if (lossPlan && lossPlan(frame, frames)) {
      // dropped frame: the sender still counts it as airtime
    } else {
      const wire = Q.base45Decode(Q.base45Encode(frame));
      const res = rx.ingest(wire);
      if (res.status === 'complete') done = true;
    }
    if (withFeedback && frames % 4 === 0) {
      let cur = 0;
      for (let i = 0; i < rx.totalRounds; i++) {
        const r = rx.rounds.get(i);
        if (!r || !r.complete) { cur = i; break; }
      }
      tx.applyFeedback({ doneMask: rx.roundsDone(), roundIndex: cur, miss: rx.missing(cur) });
    }
  }
  if (!done) return { done: false, frames };
  const out = await rx.finalize(opts && opts.password ? opts.password : undefined);
  return { done: true, frames, out, tx, rx };
}

function sameBytes(a, b) {
  if (a.length !== b.length) return 'length ' + a.length + ' vs ' + b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return 'byte ' + i;
  return null;
}

(async () => {
  const cases = [
    ['clean', rnd(50000, 1), {}, null],
    ['5% loss', rnd(50000, 2), {}, (f, n) => n % 20 === 0],
    ['15% loss', rnd(50000, 3), {}, (f, n) => n % 7 === 0],
    ['35% bursty loss', rnd(50000, 4), {}, (f, n) => (n % 100) < 35],
    ['start scanning mid-stream (drop first 60 frames)', rnd(50000, 5), {}, (f, n) => n <= 60],
    ['start scanning very late (drop 300)', rnd(120000, 6), {}, (f, n) => n <= 300],
    ['compressed text', Uint8Array.from(rnd(200000, 77), (b) => b & 0x0f), { compress: true }, null],
    ['compression disabled', rnd(30000, 7), { compress: false }, null],
    ['encrypted + compressed', rnd(80000, 78), { compress: true, password: 'hunter2' }, null],
    ['encrypted mid-stream loss', rnd(50000, 79), { password: 'hunter2' }, (f, n) => n % 6 === 0],
    ['tiny file (1 byte)', new Uint8Array([0x42]), {}, null],
    ['empty file', new Uint8Array(0), {}, null],
    ['small blocks (200B)', rnd(20000, 8), { blockSize: 200, ecc: 'H' }, (f, n) => n % 5 === 0],
    ['big blocks (700B)', rnd(200000, 9), { blockSize: 700, ecc: 'L' }, (f, n) => n % 9 === 0],
    ['many rounds', rnd(400000, 10), { blockSize: 400 }, (f, n) => n % 11 === 0],
  ];

  for (const [name, payload, opts, loss] of cases) {
    const r = await transfer(payload, opts, loss, true);
    ok('transfer: ' + name, () => {
      assert.ok(r.done, 'never completed (frames=' + r.frames + ')');
      assert.ok(!r.out.error, 'finalize error: ' + r.out.error);
      const diff = sameBytes(r.out.data, payload);
      assert.strictEqual(diff, null, diff);
    });
    if (r.done) {
      const K = r.tx.rounds.reduce((s, x) => s + x.K, 0);
      console.log(`         frames=${r.frames} symbols=${r.rx.symbols} K=${K} overhead=${(r.rx.symbols / K).toFixed(3)}x`);
    }
  }

  // ── wrong password ─────────────────────────────────────────────────────
  {
    const tx = new Q.Transmission(new TextEncoder().encode('hello world'.repeat(50)), { password: 'right' });
    await tx.init();
    const rx = new Q.ReceiverSession();
    for (let i = 0; i < 5000; i++) {
      const res = rx.ingest(Q.base45Decode(Q.base45Encode(tx.nextFrame())));
      if (res.status === 'complete') break;
    }
    const bad = await rx.finalize('wrong');
    ok('wrong password rejected', () => assert.ok(bad.error, 'should have errored'));
    const need = await rx.finalize();
    ok('password required is reported', () => assert.strictEqual(need.needPassword, true));
    const good = await rx.finalize('right');
    ok('right password accepted', () => assert.strictEqual(good.data.length, 'hello world'.repeat(50).length));
  }

  // ── rate controller ────────────────────────────────────────────────────
  ok('rate controller slows down on loss, speeds up on clean', () => {
    const c = new Q.RateController({ start: 140, min: 60, max: 500 });
    for (let i = 0; i < 40; i++) c.update(0.4);
    assert.strictEqual(c.interval, 500, 'should hit the ceiling');
    const up = [];
    for (let i = 0; i < 40; i++) { c.update(0.99); up.push(c.interval); }
    assert.strictEqual(c.interval, 60, 'should hit the floor');
    assert.ok(up.filter((v, i) => i && v !== up[i - 1]).length <= 8, 'should recover in <=8 steps, took ' + JSON.stringify(up));
  });

  ok('rate controller ignores silence and noise', () => {
    const c = new Q.RateController({ start: 140 });
    c.update(0); c.update(NaN); c.update(-1); c.update(99);
    assert.strictEqual(c.interval, 140);
  });

  ok('round selection skips confirmed rounds', () => {
    const tx = new Q.Transmission(rnd(400000, 11), { blockSize: 500 });
    tx.rounds = [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }];
    tx.roundIndex = 0;
    tx.doneMask = 0b0001;
    assert.strictEqual(tx.nextRound(), 1);
    tx.doneMask = 0b1111;
    assert.strictEqual(tx.nextRound(), 0, 'stays put when everything is confirmed');
    tx.doneMask = 0b1011;
    tx.roundIndex = 1;
    assert.strictEqual(tx.nextRound(), 2, 'picks the next unfinished round');
  });

  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})();

# QR-Stream

Send a file from a PC screen to a phone camera using only QR codes.
The file never travels over the network; only a tiny feedback channel does.

## Run

```bash
python make_cert.py     # once: creates cert.pem / key.pem
python serve.py
```

Then open:

- PC: `https://localhost:8443/sender.html` — click **Advanced → Proceed** once (self-signed cert).
- Phone: `https://<the LAN IP printed by serve.py>:8443/receiver.html` — same one-time warning, then **Start receiver**.

Everything is served from this folder. No internet needed.

### Camera focus (the biggest real-world speed factor)

Continuous autofocus hunts between the bright screen and the darker room, so the
QR goes soft and frames stop decoding. On the phone:

- Tap the QR on the preview once — the camera focuses at that point and the lens
  **stays there** (amber box, "· locked"). Tap again anywhere to refocus. It no
  longer drops back to hunting autofocus, which was the whole problem.
- If no frame decodes for 2.5 s the receiver refocuses the centre by itself.
- **`−` / `+` zoom** (top-left of the preview) crops into the sensor so the code
  gets more pixels per module. Zoom is remembered between runs.
- The small line under the preview shows the resolution the phone actually gave
  you (e.g. `1920×1080`) and the current zoom.
- Hold the phone ~20–30 cm away, fill the preview with the code, and use
  **torch** when the room is dim.

Measured with a synthetic camera (1280 px scan width, 12 fps stream, one QR
filling 32 % of the frame):

| Lens state | QR decoded per second |
|---|---|
| sharp | 10.7 |
| 2 px of defocus | 1.2 |

Defocus costs ~89 % of throughput — far more than coding, protocol or frame
rate. That is why focus lock matters more than any setting on the PC.

## How it works

```
file → compress → encrypt (optional) → split into ~48 KB rounds
     → LT fountain symbols → base45 → QR (alphanumeric mode) → screen
                                                                  ↓ camera
phone ← zbar decode ← base45 ← LT peel + CRC ← QR frame ←────────┘
```

The phone POSTs a 250 ms progress report (which rounds/blocks are missing) and
the sender re-sends exactly those blocks, so a good frame is never wasted.
`/feedback` is the only network traffic; it carries no file data.

## Numbers (100 KB file, 500 B blocks, 12 runs per cell)

| Link loss | QR frames shown | Symbols sent | Coding overhead |
|-----------|-----------------|--------------|-----------------|
| 0 %       | 225             | 207          | 1.000×          |
| 20 %      | 281             | 207          | 1.000×          |
| 50 %      | 441             | 207          | 1.000×          |

| File  | QR frames | 8 fps  | 12 fps | 16 fps |
|-------|-----------|--------|--------|--------|
| 100 KB| 236       | 30 s   | 20 s   | 15 s   |
| 1 MB  | 2374      | 4.9 min| 3.3 min| 2.5 min|

base45 + QR alphanumeric mode carries **29 % more file bytes per QR** than
base64 + byte mode: 100 KB needs 159 QRs instead of 205.

### A 252 KB photo, 0 % loss, ~9 decodes/s

| Bytes per QR | QR frames | Time |
|--------------|-----------|------|
| 500 B (default) | ~529 | ~59 s |
| 700 B | ~379 | ~42 s |
| 900 B | ~295 | ~33 s |

Denser QRs are bigger and therefore more blur-sensitive: only raise the slider
on the PC once the picture is crisp and the counter stays above ~8/s.

## Test

```bash
node tests/codec.test.js   # 33 checks: framing, crypto, fountains, lossy transfers
node tests/sim.js          # the experiment tables above
```

## Files

| Path | What |
|------|------|
| `codec.js` | wire format, LT fountain, CRC, AES-GCM, compression, rate control — shared by both pages and the tests |
| `sender.html` | PC UI: file picker, QR renderer, feedback client, adaptation |
| `receiver.html` | phone UI: camera, zbar worker, decoder, feedback |
| `serve.py` | static files + `/feedback` + `/metrics` (HTTP/1.1 keep-alive) |
| `vendor/` | pako, qrcode-generator, zbar wasm, vue, tailwind — all local |
| `tests/` | codec tests + experiment runner |
| `legacy/` | the old v2 implementation, kept for reference |
| `metrics.jsonl` | one JSON line per finished transfer (created on demand) |

## Honest limits

- The feedback channel needs both devices on the same WiFi. The *file* is
  air-gapped; the *control* channel is not. A visual back-channel (phone shows
  an ack QR) is the natural next step.
- A phone camera typically decodes 6–12 QR/s, not 16; the rate controller finds
  the real ceiling in the first few seconds.
- Gaussian elimination is a safety net, not a win: measured 0–2 % fewer frames.
- LT degree distribution is fixed at the sender; only rate, block size and ECC
  adapt.

"""
Simulates the sender's AIMD controller from Phase 1.
Mirrors the exact logic in sender.html:decideInterval()
"""
MIN_INTERVAL = 60
MAX_INTERVAL = 600
AI_STEP = 10
MD_FACTOR = 1.5
GOOD_RATIO = 0.85
BAD_RATIO = 0.50
MIN_ADAPT_GAP_MS = 1000
WARMUP_MS = 3000

def decide(current, decode_rate, send_rate):
    if not send_rate or not decode_rate:
        return current
    ratio = decode_rate / send_rate
    if ratio >= GOOD_RATIO:
        return max(MIN_INTERVAL, current - AI_STEP)
    if ratio < BAD_RATIO:
        return min(MAX_INTERVAL, round(current * MD_FACTOR))
    return current

def simulate(quality_fn, duration_s=40, start=140):
    interval = start
    log = []
    last_adapt = 0.0
    t = 0.0
    dt = 0.1
    while t < duration_s:
        t += dt
        if t < WARMUP_MS / 1000:
            continue
        if t - last_adapt < MIN_ADAPT_GAP_MS / 1000:
            continue
        last_adapt = t
        send_rate = 1000 / interval
        q = quality_fn(t)
        decode_rate = send_rate * q
        old = interval
        interval = decide(interval, decode_rate, send_rate)
        log.append((t, old, interval, q))
    return interval, log

def show(title, final, log, keep=lambda t: True):
    print(f"\n{title}")
    for t, old, new, q in log:
        if keep(t) and old != new:
            print(f"  t={t:5.1f}s  quality={q:.2f}  {old:>3}->{new:>3} ms")
    print(f"  final interval: {final} ms  (send rate: {1000/final:.1f} fps)")

# Scenario 1: clean channel (95% decode success) — should converge to MIN
final, log = simulate(lambda t: 0.95)
show("Scenario 1 — Clean channel (95% decode success)", final, log)

# Scenario 2: degradation at t=10, stays bad
final, log = simulate(lambda t: 0.95 if t < 10 else 0.40)
show("Scenario 2 — Channel degrades to 40% at t=10s", final, log, keep=lambda t: t > 9)

# Scenario 3: degrade at 10, recover at 15 — how fast does it come back?
final, log = simulate(lambda t: 0.95 if t < 10 else (0.30 if t < 15 else 0.95),
                      duration_s=60)
show("Scenario 3 — Degrade at 10s, recover at 15s (60s total)", final, log,
     keep=lambda t: t > 9)
#!/usr/bin/env python3
"""
Generate publication-quality figures from paper/results.json.
Run: python tests/plot_paper.py
Outputs PNG figures to paper/figures/
"""
import json
import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS_PATH = os.path.join(ROOT, 'paper', 'results.json')
FIG_DIR = os.path.join(ROOT, 'paper', 'figures')
os.makedirs(FIG_DIR, exist_ok=True)

with open(RESULTS_PATH, 'r', encoding='utf-8') as f:
    data = json.load(f)

plt.rcParams.update({
    'font.size': 10.5,
    'axes.titlesize': 11.5,
    'axes.labelsize': 10.5,
    'legend.fontsize': 9.0,
    'figure.dpi': 160,
    'axes.grid': True,
    'grid.alpha': 0.3,
})

# ── Fig 1: Frames vs Loss Rate (Open-Peel vs Open-Gauss vs Closed-Loop) ──
exp1 = data['exp1']
losses = [r['lossPct'] for r in exp1]
open_peel = [r['openPeel']['avgFrames'] for r in exp1]
open_gauss = [r['openGauss']['avgFrames'] for r in exp1]
closed = [r['closed']['avgFrames'] for r in exp1]

fig, ax = plt.subplots(figsize=(7.2, 4.4))
ax.plot(losses, open_peel, 'o--', color='#ef4444', linewidth=2, label='Open-Loop (Peeling Only)')
ax.plot(losses, open_gauss, 's-', color='#f59e0b', linewidth=2.2, label='Open-Loop (Hybrid + GF(2) Gauss)')
ax.plot(losses, closed, '^-', color='#0ea5e9', linewidth=2.2, label='Closed-Loop (Feedback + Targeted Resend)')
ax.set_xlabel('Optical Frame Loss Rate (%)')
ax.set_ylabel('Total QR Frames Required (10 trials/point)')
ax.set_title('Transfer Efficiency vs. Optical Frame Loss (Simulated: 100 KB, 650 B, ECC L)')
ax.legend()
fig.tight_layout()
fig.savefig(os.path.join(FIG_DIR, 'fig1_frames_vs_loss.png'))
plt.close(fig)

# ── Fig 2: Adversarial Frame-Poisoning Attack ────────────────────────────
exp3 = data['exp3']
inj = [r['injectPct'] for r in exp3]
no_auth_comp = [r['noAuth']['completionRate'] * 100 for r in exp3]
hmac_comp = [r['withAuth']['completionRate'] * 100 for r in exp3]
no_auth_corrupt = [r['noAuth']['corruptRoundsPerTrial'] for r in exp3]
hmac_corrupt = [r['withAuth']['corruptRoundsPerTrial'] for r in exp3]

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.8, 4.3))
ax1.plot(inj, no_auth_comp, 'o--', color='#ef4444', linewidth=2, label='CRC-32 Only (Baseline)')
ax1.plot(inj, hmac_comp, 's-', color='#10b981', linewidth=2.2, label='Per-Frame 64-bit HMAC-SHA256 (0x85)')
ax1.set_xlabel('Attacker Frame Injection Rate (%)')
ax1.set_ylabel('Transfer Completion Rate (%)')
ax1.set_ylim(-5, 112)
ax1.set_title('Transfer Survivability Under Injection')
ax1.legend()

ax2.plot(inj, no_auth_corrupt, 'o--', color='#ef4444', linewidth=2, label='CRC-32 Only (Baseline)')
ax2.plot(inj, hmac_corrupt, 's-', color='#10b981', linewidth=2.2, label='Per-Frame 64-bit HMAC-SHA256 (0x85)')
ax2.set_xlabel('Attacker Frame Injection Rate (%)')
ax2.set_ylabel('Corrupted Rounds per Transfer')
ax2.set_title('Round Poisoning Incidents')
ax2.legend()

fig.suptitle('Adversarial Frame-Poisoning Defense (Simulated: 50 KB, 650 B, 5% Loss, 10 trials/point)', fontsize=12)
fig.tight_layout(rect=[0, 0, 1, 0.94])
fig.savefig(os.path.join(FIG_DIR, 'fig2_poisoning_attack.png'))
plt.close(fig)

# ── Fig 3: Dynamic Channel Multiplicative Rate Controller vs Fixed 75ms ──
exp4 = data['exp4']
fixed = exp4['fixed75ms']
adapt = exp4['adaptive']
t_adapt = [p['tSec'] for p in adapt['trace']]
send_adapt = [p['sendFps'] for p in adapt['trace']]
dec_adapt = [p['decodeFps'] for p in adapt['trace']]

fig, ax = plt.subplots(figsize=(8.0, 4.5))
ax.plot(t_adapt, send_adapt, '-', color='#0ea5e9', linewidth=2.1, label='RateController Send Rate (fps)')
ax.plot(t_adapt, dec_adapt, '--', color='#10b981', linewidth=1.8, label='RateController Decode Rate (fps)')
ax.axhline(1000.0 / 75.0, color='#ef4444', linestyle=':', linewidth=1.9, label='Fixed Default Baseline (13.3 fps / 75 ms)')
ax.axvspan(10, 20, color='#fef3c7', alpha=0.45, label='Defocus Burst (45% loss, 6 fps cap)')
ax.set_xlabel('Time (seconds)')
ax.set_ylabel('Refresh Rate (fps)')
ax.set_title('Multiplicative Rate Controller (1.4× Step) Under Dynamic Defocus (Simulated 30s Trace)')
ax.set_ylim(0, max(max(send_adapt), max(dec_adapt)) * 1.18)
ax.legend(loc='upper right')
summary_txt = (
    f"Fixed 75ms:  delivery={fixed['deliveryRatio']:.3f} · goodput={fixed['goodputKBps']:.2f} KB/s\n"
    f"Adaptive:    delivery={adapt['deliveryRatio']:.3f} · goodput={adapt['goodputKBps']:.2f} KB/s"
)
ax.text(
    0.02, 0.96, summary_txt,
    transform=ax.transAxes, va='top', ha='left', fontsize=8.5, family='monospace',
    bbox=dict(boxstyle='round,pad=0.35', facecolor='white', edgecolor='#cbd5e1', alpha=0.92),
)
fig.tight_layout()
fig.savefig(os.path.join(FIG_DIR, 'fig3_aimd_adaptation.png'))
plt.close(fig)

# ── Fig 4: Measured GF(2) Solve Latency & QR Matrix Encode Latency ───────
gauss = data['exp5']['gaussBench']
qr_bench = data['exp5']['qrEncodeBench']

ks = [r['K'] for r in gauss]
gauss_ms = [r['avgDecodeMs'] for r in gauss]

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12.2, 4.4))

bars1 = ax1.bar([str(k) for k in ks], gauss_ms, color='#6366f1', width=0.52)
ax1.set_xlabel('Source Symbols per Round (K)')
ax1.set_ylabel('Total Round Decode Time (ms)')
ax1.set_title('GF(2) Peeling + Gaussian Decode Latency (650 B blocks)')
ax1.set_ylim(0, max(gauss_ms) * 1.18)
for b, v in zip(bars1, gauss_ms):
    ax1.text(b.get_x() + b.get_width() / 2, v + max(gauss_ms) * 0.025, f'{v:.2f} ms', ha='center', va='bottom', fontsize=8.5)

enc_labels = [
    m['label'].replace(' (', '\n').replace(')', '') + f"\nv{m['qrVersion']}"
    for m in qr_bench
]
enc_ms = [m['batchEncodeMs'] for m in qr_bench]
enc_colors = ['#64748b', '#38bdf8', '#0ea5e9', '#0284c7', '#10b981', '#059669']
bars2 = ax2.bar(range(len(qr_bench)), enc_ms, color=enc_colors[:len(qr_bench)], width=0.56)
ax2.axhline(75.0, color='#ef4444', linestyle='--', linewidth=1.6, label='75 ms sender interval budget')
ax2.set_xticks(range(len(qr_bench)))
ax2.set_xticklabels(enc_labels, fontsize=7.8)
ax2.set_ylabel('Single-Thread Encode Time per Batch (ms)')
ax2.set_title('QR Matrix Encode Latency (Measured vendor/qrcode.js)')
ax2.set_ylim(0, max(max(enc_ms), 75.0) * 1.18)
ax2.legend(loc='upper left')
for b, v in zip(bars2, enc_ms):
    ax2.text(b.get_x() + b.get_width() / 2, v + max(enc_ms) * 0.025, f'{v:.1f} ms', ha='center', va='bottom', fontsize=8.2)

fig.tight_layout()
fig.savefig(os.path.join(FIG_DIR, 'fig4_gf2_latency.png'))
plt.close(fig)

# ── Fig 5: Spatial & RGB Multiplexing Protocol Goodput + Multi-MB Scaling ─
exp6 = data['exp6']
modes = exp6['modes']
scaling = exp6['scaling2x1']
enc_by_label = {m['label']: m for m in qr_bench}

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12.4, 4.5))

mode_labels = []
for m in modes:
    short = m['label'].replace(', 75ms)', '').replace(', 10fps)', '').replace(' (', '\n')
    base_key = m['label'].split(' (')[0] + ' (' + m['label'].split('(')[1].rsplit(', ', 1)[0] + ')'
    qinfo = enc_by_label.get(base_key)
    ver_str = f"v{qinfo['qrVersion']} · " if qinfo else ''
    mode_labels.append(f"{short}\n{ver_str}{m['effectiveFps']:.1f}fps")

vals = [m['goodputKBps'] for m in modes]
colors = ['#64748b', '#38bdf8', '#0ea5e9', '#0284c7', '#10b981', '#059669']
bars = ax1.bar(range(len(modes)), vals, color=colors[:len(modes)], width=0.58)
ax1.set_xticks(range(len(modes)))
ax1.set_xticklabels(mode_labels, fontsize=7.6)
ax1.set_ylabel('Simulated Protocol Goodput (KB/s)')
ax1.set_title('Simulated 1 MB Protocol Goodput (5% Per-QR Loss · Excludes Camera Optics)')
ax1.set_ylim(0, max(vals) * 1.18)
for b, v in zip(bars, vals):
    ax1.text(b.get_x() + b.get_width() / 2, v + max(vals) * 0.02, f'{v:.1f}', ha='center', va='bottom', fontsize=8.5)

sizes = [s['label'] for s in scaling]
rates = [s['goodputKBps'] for s in scaling]
ax2.plot(sizes, rates, 'o-', color='#0ea5e9', linewidth=2.2, markersize=7)
ax2.set_xlabel('File Size (2×1 Mono Default, 650 B, 75 ms, 5% Loss)')
ax2.set_ylabel('Sustained Simulated Goodput (KB/s)')
ax2.set_title('Simulated Multi-MB Scaling (Excludes Camera Optics)')
ax2.set_ylim(0, max(rates) * 1.38)
for x, s_obj in zip(sizes, scaling):
    y = s_obj['goodputKBps']
    ax2.text(x, y + max(rates) * 0.055, f"{y:.1f} KB/s\n({s_obj['rounds']}r)", ha='center', va='bottom', fontsize=8.3)

fig.tight_layout()
fig.savefig(os.path.join(FIG_DIR, 'fig5_throughput_multiplexing.png'))
plt.close(fig)

print('Generated 5 figures in', FIG_DIR)

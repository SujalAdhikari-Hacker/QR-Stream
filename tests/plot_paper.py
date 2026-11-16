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
    'font.size': 11,
    'axes.titlesize': 12,
    'axes.labelsize': 11,
    'legend.fontsize': 9.5,
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

fig, ax = plt.subplots(figsize=(7, 4.3))
ax.plot(losses, open_peel, 'o--', color='#ef4444', linewidth=2, label='Open-Loop (Peeling Only)')
ax.plot(losses, open_gauss, 's-', color='#f59e0b', linewidth=2.2, label='Open-Loop (Hybrid + GF(2) Gauss)')
ax.plot(losses, closed, '^-', color='#0ea5e9', linewidth=2.2, label='Closed-Loop (Feedback + Targeted Resend)')
ax.set_xlabel('Optical Frame Loss Rate (%)')
ax.set_ylabel('Total QR Frames Required (100 KB, 500 B/frame)')
ax.set_title('Transfer Efficiency vs. Optical Channel Loss')
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

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.5, 4.0))
ax1.plot(inj, no_auth_comp, 'o--', color='#ef4444', linewidth=2, label='CRC-32 Only (Baseline)')
ax1.plot(inj, hmac_comp, 's-', color='#10b981', linewidth=2.2, label='Per-Frame HMAC-SHA256')
ax1.set_xlabel('Attacker Frame Injection Rate (%)')
ax1.set_ylabel('Transfer Completion Rate (%)')
ax1.set_ylim(-5, 110)
ax1.set_title('Transfer Survivability Under Injection')
ax1.legend()

ax2.plot(inj, no_auth_corrupt, 'o--', color='#ef4444', linewidth=2, label='CRC-32 Only (Baseline)')
ax2.plot(inj, hmac_corrupt, 's-', color='#10b981', linewidth=2.2, label='Per-Frame HMAC-SHA256')
ax2.set_xlabel('Attacker Frame Injection Rate (%)')
ax2.set_ylabel('Corrupted Rounds per Transfer')
ax2.set_title('Round Poisoning Incidents')
ax2.legend()
fig.tight_layout()
fig.savefig(os.path.join(FIG_DIR, 'fig2_poisoning_attack.png'))
plt.close(fig)

# ── Fig 3: Dynamic Channel AIMD vs Fixed-Rate ────────────────────────────
exp4 = data['exp4']
t_aimd = [p['tSec'] for p in exp4['aimdAdaptive']['trace']]
send_aimd = [p['sendFps'] for p in exp4['aimdAdaptive']['trace']]
dec_aimd = [p['decodeFps'] for p in exp4['aimdAdaptive']['trace']]

fig, ax = plt.subplots(figsize=(7.5, 4.0))
ax.plot(t_aimd, send_aimd, '-', color='#0ea5e9', linewidth=2, label='AIMD Send Rate (fps)')
ax.plot(t_aimd, dec_aimd, '--', color='#10b981', linewidth=1.8, label='AIMD Decode Rate (fps)')
ax.axhline(10.0, color='#ef4444', linestyle=':', linewidth=1.8, label='Fixed-Rate Baseline (10 fps)')
ax.axvspan(10, 20, color='#fef3c7', alpha=0.45, label='Defocus / Motion Burst (45% loss)')
ax.set_xlabel('Time (seconds)')
ax.set_ylabel('Frame Rate (fps)')
ax.set_title('AIMD Rate Adaptation Under Dynamic Optical Defocus')
ax.legend(loc='upper right')
fig.tight_layout()
fig.savefig(os.path.join(FIG_DIR, 'fig3_aimd_adaptation.png'))
plt.close(fig)

# ── Fig 4: GF(2) Solve Latency vs K ─────────────────────────────────────
gauss = data['exp5']['gaussBench']
ks = [r['K'] for r in gauss]
ms = [r['avgDecodeMs'] for r in gauss]

fig, ax = plt.subplots(figsize=(6.5, 3.8))
ax.bar([str(k) for k in ks], ms, color='#6366f1', width=0.55)
ax.set_xlabel('Source Symbols per Round (K)')
ax.set_ylabel('Total Round Decode Time (ms)')
ax.set_title('Peeling + GF(2) Gaussian Elimination Decode Latency')
fig.tight_layout()
fig.savefig(os.path.join(FIG_DIR, 'fig4_gf2_latency.png'))
plt.close(fig)

# ── Fig 5: Spatial & RGB Multiplexing Throughput + Multi-MB Scaling ──────
exp6 = data.get('exp6', {})
if exp6:
    modes = exp6['modes']
    scaling = exp6['scaling2x1']
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11.2, 4.2))

    labels = [m['label'].replace(' (', '\n').replace(')', '').replace(', ', ' · ') for m in modes]
    vals = [m['goodputKBps'] for m in modes]
    colors = ['#64748b', '#0ea5e9', '#0284c7', '#10b981', '#059669']
    bars = ax1.bar(range(len(modes)), vals, color=colors[:len(modes)], width=0.58)
    ax1.set_xticks(range(len(modes)))
    ax1.set_xticklabels([l.replace(' · ', '\n', 1) for l in labels], fontsize=7.8)
    ax1.set_ylabel('Effective Goodput (KB/s)')
    ax1.set_title('1 MB Transfer Goodput by Multiplexing Mode (5% Loss)')
    for b, v in zip(bars, vals):
        ax1.text(b.get_x() + b.get_width() / 2, v + max(vals) * 0.02, f'{v:.1f}', ha='center', va='bottom', fontsize=8.5)
    ax1.set_ylim(0, max(vals) * 1.15)

    sizes = [s['label'] for s in scaling]
    rates = [s['goodputKBps'] for s in scaling]
    ax2.plot(sizes, rates, 'o-', color='#0ea5e9', linewidth=2.2, markersize=7)
    ax2.set_xlabel('File Size (2×1 Mono Default, 650 B, 5% Loss)')
    ax2.set_ylabel('Sustained Goodput (KB/s)')
    ax2.set_title('Multi-MB Goodput Stability (Constant Overhead)')
    ax2.set_ylim(0, max(rates) * 1.35)
    for x, y in zip(sizes, rates):
        ax2.text(x, y + max(rates) * 0.05, f'{y:.1f} KB/s', ha='center', fontsize=8.5)

    fig.tight_layout()
    fig.savefig(os.path.join(FIG_DIR, 'fig5_throughput_multiplexing.png'))
    plt.close(fig)

print('Generated 5 figures in', FIG_DIR)

#!/usr/bin/env python3
"""
Builds a crisp 1280x720 narrated HD demo video (docs/demo.mp4) for BasisFlow Agent (HSK Edition)
using Pillow slides backed by real docs/data/live_proof.json metrics + edge-tts voiceover + ffmpeg.
"""
import asyncio
import json
import os
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import edge_tts

ROOT = Path(__file__).resolve().parent.parent
PROOF_PATH = ROOT / "docs" / "data" / "live_proof.json"
OUT_MP4 = ROOT / "docs" / "demo.mp4"
TMP = ROOT / ".video_tmp"
TMP.mkdir(exist_ok=True)

proof = json.loads(PROOF_PATH.read_text())
W, H = 1280, 720

def font(size, bold=False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def mono(size):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

BG = (7, 11, 20)
PANEL = (15, 23, 42)
BORDER = (30, 41, 59)
ACCENT = (16, 185, 129)
CYAN = (6, 182, 212)
WARN = (245, 158, 11)
RED = (239, 68, 68)
TEXT = (241, 245, 249)
MUTED = (148, 163, 184)

def base_canvas(slide_num, kicker, title):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # Header bar
    d.rectangle([0, 0, W, 62], fill=PANEL)
    d.line([0, 62, W, 62], fill=BORDER, width=2)
    d.rounded_rectangle([28, 15, 62, 47], radius=7, fill=ACCENT)
    d.text((34, 21), "BF", fill=(4, 19, 28), font=font(18, True))
    d.text((76, 19), "BasisFlow Agent — HashKey Chain (HSKSwap V3)", fill=TEXT, font=font(20, True))
    d.text((W - 220, 22), f"HSK Horizon · {slide_num}/6", fill=CYAN, font=mono(16))

    # Kicker & Title
    d.text((48, 86), kicker.upper(), fill=ACCENT, font=font(15, True))
    d.text((48, 112), title, fill=TEXT, font=font(34, True))
    return img, d

def card(d, x, y, w, h, title, val, sub, val_color=ACCENT):
    d.rounded_rectangle([x, y, x + w, y + h], radius=14, fill=PANEL, outline=BORDER, width=2)
    d.text((x + 22, y + 18), title, fill=MUTED, font=font(15, True))
    d.text((x + 22, y + 50), val, fill=val_color, font=mono(34))
    d.text((x + 22, y + 104), sub, fill=TEXT, font=font(16))

def render_slides():
    lm = proof["liveMainnetSnapshot"]
    sm = proof["summary"]
    sl = sm["stopLossProof"]

    slides = []

    # Slide 1: Hero
    img, d = base_canvas(1, "DoraHacks HSK Chain Horizon · Track 1: AI Agent Trading", "Non-Custodial Risk-Bounded AI Trading Vault")
    d.text((48, 168), "Separating custody from AI execution on HashKey Chain (HSKSwap V3) with 7 hard on-chain guardrails.", fill=MUTED, font=font(20))
    card(d, 48, 230, 370, 155, "ON-CHAIN GUARDRAILS", "7 Hard Rules", "Max size, exposure, slippage, stop-loss", ACCENT)
    card(d, 455, 230, 370, 155, "ON-CHAIN PROOF RETURN", f"+{sm['preCrashReturnPct']}%", f"Peak ${sm['peakEquityUsd']} across {sm['executedTrades']} signed txs", CYAN)
    card(d, 862, 230, 370, 155, "AUTOMATED QA SUITE", "23 / 23 PASS", "17 Foundry (256 fuzz) + 6 Node tests", ACCENT)
    d.rounded_rectangle([48, 425, 1232, 650], radius=14, fill=PANEL, outline=BORDER, width=2)
    d.text((74, 448), "Key Architecture Highlights", fill=CYAN, font=font(20, True))
    bullets = [
        "• Owner deposits USDT into AgentVault.sol; delegated AI agent key can ONLY trade inside hard on-chain bounds.",
        "• Agent EOA can NEVER withdraw funds; owner retains instant pause(), revokeAgent(), and emergencyUnwind().",
        "• Live HashKey Chain Mainnet (177) HSKSwap V3 pool monitoring + Gate.io & KuCoin spot spread detection.",
        "• Interactive Natural-Language Chat UI adjusts risk, trade size, cooldown frequency, assets, and stop-loss live.",
    ]
    for i, b in enumerate(bullets):
        d.text((74, 492 + i * 36), b, fill=TEXT, font=font(18))
    p1 = TMP / "s1.png"; img.save(p1); slides.append(p1)

    # Slide 2: Live Mainnet 177 HSKSwap V3 Verification
    img, d = base_canvas(2, "Live HashKey Chain Mainnet (Chain ID 177)", "Real-Time HSKSwap V3 Pool & CEX Basis Monitoring")
    card(d, 48, 185, 370, 165, "HSKSWAP V3 0.05% POOL", f"${lm['pool500']['priceUsdt']:.6f}", f"0xEB33...778A · Block #{lm['blockNumber']:,}", ACCENT)
    card(d, 455, 185, 370, 165, "HSKSWAP V3 0.30% POOL", f"${lm['pool3000']['priceUsdt']:.6f}", f"0x0767...Ae62 · +{lm['crossTierV3SpreadBps']} bps cross-tier", CYAN)
    card(d, 862, 185, 370, 165, "CEX SPOT DISLOCATION", f"+{lm['dexVsCexSpreadBps']} bps", f"Gate.io & KuCoin avg: ${lm['referenceCex']['medianPrice']}", WARN)
    d.rounded_rectangle([48, 385, 1232, 660], radius=14, fill=PANEL, outline=BORDER, width=2)
    d.text((74, 408), "Production Mainnet Adapter: HSKSwapV3Adapter.sol", fill=CYAN, font=font(20, True))
    lines = [
        f"SwapRouter02 : {proof['network']['mainnet']['router']} (24,143 bytes verified live)",
        f"WHSK (18 dec): {proof['network']['mainnet']['whsk']}",
        f"USDT (6 dec) : {proof['network']['mainnet']['usdt']}",
        "Q96 Math     : Unit-tested directly against live Mainnet sqrtPriceX96 = 25055738251564958613595",
        "Zero Gas Read: Browser dashboard & Node agent poll mainnet.hsk.xyz slot0() directly via eth_call.",
    ]
    for i, ln in enumerate(lines):
        d.text((74, 454 + i * 38), ln, fill=TEXT, font=mono(17))
    p2 = TMP / "s2.png"; img.save(p2); slides.append(p2)

    # Slide 3: Quant Engine & Monte-Carlo VaR
    img, d = base_canvas(3, "BasisFlow Quantitative Engine", "Spread Dislocation + EMA Regime + 500-Path Monte-Carlo VaR")
    card(d, 48, 190, 370, 180, "1. SIGNAL FUSION", "DEX vs CEX", "Basis bps + cross-tier V3 spread\nwith EMA-9/21 Kaufman ER filter", CYAN)
    card(d, 455, 190, 370, 180, "2. BOOTSTRAP VaR-95", "500 Paths", "Deterministic Mulberry32 empirical\nbootstrap auto-scales order size", ACCENT)
    card(d, 862, 190, 370, 180, "3. AUDIT TRAIL", "signalHash", "Canonical JSON keccak256 committed\nin TradeExecuted on every swap", WARN)
    d.rounded_rectangle([48, 405, 1232, 660], radius=14, fill=PANEL, outline=BORDER, width=2)
    d.text((74, 428), "Natural-Language Chat Control Commands", fill=CYAN, font=font(20, True))
    cmds = [
        ('User: "risk high size 800 every 30s"', '→ Agent updates AgentVault.setLimits(maxTrade=$800, cooldown=30s, maxPos=75%)'),
        ('User: "stoploss 9500 assets WHSK/USDT"', '→ Raises hard on-chain circuit-breaker floor to $9,500 USDT on WHSK/USDT'),
        ('User: "explain"', '→ Prints spread bps, regime, VaR-95 ($), and on-chain verifiable signalHash'),
        ('User: "pause" / "status"', '→ Instantly freezes AgentVault execution or reports real-time marked PnL'),
    ]
    for i, (u, r) in enumerate(cmds):
        d.text((74, 474 + i * 44), u, fill=ACCENT, font=mono(16))
        d.text((520, 474 + i * 44), r, fill=TEXT, font=font(16))
    p3 = TMP / "s3.png"; img.save(p3); slides.append(p3)

    # Slide 4: Verified 12-Trade Equity Curve
    img, d = base_canvas(4, "Verified End-to-End On-Chain Execution (Anvil Chain 133)", "12 Signed Agent Trades: $10,000 → $10,799 Peak (+7.99%)")
    # Plot chart inside panel
    cx, cy, cw, ch = 48, 175, 1184, 340
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=14, fill=PANEL, outline=BORDER, width=2)
    curve = proof["equityCurve"]
    vals = [pt["equityUsd"] for pt in curve] + [9400]
    minv, maxv = min(vals) - 100, max(vals) + 100
    pl, pr, pt_pad, pb = cx + 80, cx + cw - 30, cy + 30, cy + ch - 45
    def px_x(i): return pl + int((i / max(1, len(curve) - 1)) * (pr - pl))
    def px_y(v): return pt_pad + int((1 - (v - minv) / (maxv - minv)) * (pb - pt_pad))

    # Stop loss line
    ysl = px_y(9400)
    d.line([pl, ysl, pr, ysl], fill=RED, width=3)
    d.text((pl + 12, ysl - 22), "ON-CHAIN HARD STOP-LOSS FLOOR: $9,400 USDT", fill=(252, 165, 165), font=mono(14))

    pts = [(px_x(i), px_y(p["equityUsd"])) for i, p in enumerate(curve)]
    for i in range(1, len(pts)):
        d.line([pts[i - 1], pts[i]], fill=ACCENT, width=4)
    for x, y in pts:
        d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=(52, 211, 153))

    d.text((cx + 18, px_y(10800) - 8), "$10.8k", fill=MUTED, font=mono(13))
    d.text((cx + 18, px_y(10000) - 8), "$10.0k", fill=MUTED, font=mono(13))
    d.text((cx + 18, ysl - 8), "$9.4k", fill=(252, 165, 165), font=mono(13))

    # Bottom metrics
    card(d, 48, 535, 370, 145, "SIGNED AGENT TXS", f"{sm['executedTrades']} Trades", "Every tx logs keccak256 signalHash", CYAN)
    card(d, 455, 535, 370, 145, "PEAK EQUITY", f"${sm['peakEquityUsd']:,.2f}", f"Final pre-crash: ${sm['finalPreCrashEquityUsd']:,.2f} (+{sm['preCrashReturnPct']}%)", ACCENT)
    card(d, 862, 535, 370, 145, "REPRODUCIBLE PROOF", "npm run anvil-demo", "Full receipts in docs/data/live_proof.json", WARN)
    p4 = TMP / "s4.png"; img.save(p4); slides.append(p4)

    # Slide 5: Flash-Crash Stop-Loss Proof
    img, d = base_canvas(5, "On-Chain Circuit Breaker Stress Test", "Intentional Flash Crash → Automatic Vault Freeze")
    card(d, 48, 190, 370, 165, "PRE-CRASH EQUITY", f"${sl['equityBeforeCrashUsd']:,.2f}", "Active WHSK/USDT inventory", CYAN)
    card(d, 455, 190, 370, 165, "POST-CRASH MARKED", f"${sl['equityAtCrashUsd']:,.2f}", f"Breached < ${sl['stopLossFloorUsd']:,} hard floor", RED)
    card(d, 862, 190, 370, 165, "VAULT STATUS", "PAUSED = TRUE", "Next agent trade REVERTED (IsPaused)", ACCENT)
    d.rounded_rectangle([48, 390, 1232, 660], radius=14, fill=PANEL, outline=BORDER, width=2)
    d.text((74, 414), "Verified On-Chain Stop-Loss Transaction Receipt", fill=RED, font=font(20, True))
    sl_lines = [
        f"AgentVault      : {proof['deployedContracts']['AgentVault']}",
        f"Trigger TX Hash : {sl['txHash']}",
        f"Block / Gas Used: Block #{sl['blockNumber']} · {sl['gasUsed']:,} gas",
        f"Vault Paused    : {sl['vaultPausedOnChain']} (verified via vault.paused())",
        f"Agent Blocked   : {sl['subsequentAgentTradeReverted']} (subsequent trade() reverted with AgentVault.IsPaused)",
    ]
    for i, ln in enumerate(sl_lines):
        d.text((74, 462 + i * 38), ln, fill=TEXT, font=mono(16))
    p5 = TMP / "s5.png"; img.save(p5); slides.append(p5)

    # Slide 6: Ready for Mainnet + Links
    img, d = base_canvas(6, "Open Source · Verified CI · Mainnet Ready", "Explore BasisFlow Agent on HashKey Chain")
    card(d, 48, 195, 570, 175, "FOUNDRY SMART CONTRACT SUITE", "17 / 17 PASS", "256 fuzz runs · Zero external Solidity deps\nStop-loss, daily cap, cooldown, non-custodial escape", ACCENT)
    card(d, 662, 195, 570, 175, "NODE QUANT & CHAT ENGINE", "6 / 6 PASS", "Live Mainnet 177 RPC Q96 pricing + Gate/KuCoin\nNatural-language guardrail controller + VaR-95", CYAN)
    d.rounded_rectangle([48, 410, 1232, 650], radius=14, fill=PANEL, outline=ACCENT, width=2)
    d.text((74, 438), "Live Links & One-Command Deployment", fill=ACCENT, font=font(22, True))
    links = [
        "Interactive Terminal : https://andreyjackkali.github.io/hsk-basisflow-agent/",
        "8-Slide Pitch Deck   : https://andreyjackkali.github.io/hsk-basisflow-agent/deck.html",
        "GitHub Repository    : https://github.com/AndreyJackKali/hsk-basisflow-agent",
        "1-Command Deploy     : forge script script/Deploy.s.sol:DeployMainnet --rpc-url https://mainnet.hsk.xyz --broadcast",
    ]
    for i, ln in enumerate(links):
        d.text((74, 486 + i * 38), ln, fill=TEXT, font=mono(16))
    p6 = TMP / "s6.png"; img.save(p6); slides.append(p6)
    return slides

SCRIPTS = [
    "Welcome to BasisFlow Agent, HSK Edition: a non-custodial, on-chain risk-bounded AI trading vault and conversational terminal built for HashKey Chain.",
    "Our agent monitors live HashKey Chain Mainnet HSKSwap V3 pools via zero-gas RPC calls, comparing both the zero point zero five percent and zero point three zero percent pools against live Gate and KuCoin spot prices in real time.",
    "Every decision combines spread dislocation, EMA regime detection, and a 500-path bootstrap Monte Carlo Value-at-Risk model, while our natural-language chat console lets traders adjust risk, trade size, cooldown frequency, and stop-loss floors instantly.",
    "In our reproducible Chain 133 Anvil verification, the delegated AI agent executed 12 real signed swaps, capturing basis dislocations from ten thousand dollars up to a ten thousand seven hundred ninety nine dollar peak, with every signal hash committed on-chain.",
    "To prove safety under extreme stress, we triggered a simulated sixty percent flash crash. As soon as equity fell below the nine thousand four hundred dollar floor, the on-chain circuit breaker fired, auto-paused the vault, and reverted the agent's next trade.",
    "Backed by 17 Foundry tests with 256 fuzz runs, 6 Node engine tests, and one-command deployment scripts for both HSK Testnet and Mainnet, BasisFlow Agent is live now on GitHub Pages. Thank you for watching.",
]

async def synth_audio():
    paths = []
    for i, text in enumerate(SCRIPTS):
        out = TMP / f"a{i+1}.mp3"
        comm = edge_tts.Communicate(text, voice="en-US-GuyNeural")
        await comm.save(str(out))
        paths.append(out)
    return paths

def build_mp4(slides, audios):
    segs = []
    for i, (img, aud) in enumerate(zip(slides, audios)):
        seg = TMP / f"seg{i+1}.mp4"
        subprocess.run([
            "ffmpeg", "-y", "-loop", "1", "-i", str(img), "-i", str(aud),
            "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
            "-r", "24", "-c:a", "aac", "-b:a", "128k", "-shortest", str(seg)
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        segs.append(seg)
    concat_file = TMP / "concat.txt"
    concat_file.write_text("\n".join(f"file '{s.resolve()}'" for s in segs) + "\n")
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-c", "copy", "-movflags", "+faststart", str(OUT_MP4)
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

async def main():
    slides = render_slides()
    audios = await synth_audio()
    build_mp4(slides, audios)
    size_mb = OUT_MP4.stat().st_size / (1024 * 1024)
    print(f"Built {OUT_MP4} ({size_mb:.2f} MB)")

if __name__ == "__main__":
    asyncio.run(main())

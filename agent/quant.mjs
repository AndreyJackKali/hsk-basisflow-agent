import crypto from 'node:crypto';

/**
 * BasisFlow Agent (HSK Edition) — Quantitative Signal & Monte-Carlo Risk Engine
 * Ported from BasisFlow Terminal (SoSoValue / SoDEX) for HashKey Chain (HSKSwap V3).
 */

export function computeSpreadBps(dexPrice, refPrice) {
  if (!Number.isFinite(dexPrice) || !Number.isFinite(refPrice) || dexPrice <= 0 || refPrice <= 0) return 0;
  return Number((((refPrice - dexPrice) / dexPrice) * 10_000).toFixed(2));
}

export function computeEma(values, period) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export function detectRegime(prices) {
  if (!Array.isArray(prices) || prices.length < 10) {
    return { regime: 'CHOP', emaFast: 0, emaSlow: 0, slopePct: 0, efficiencyRatio: 0 };
  }
  const fast = computeEma(prices, 9);
  const slow = computeEma(prices, 21);
  const fastNow = fast[fast.length - 1];
  const slowNow = slow[slow.length - 1];
  const slowPrev = slow[Math.max(0, slow.length - 6)];
  const slopePct = slowPrev > 0 ? ((slowNow - slowPrev) / slowPrev) * 100 : 0;

  const lookback = Math.min(15, prices.length - 1);
  const netMove = Math.abs(prices[prices.length - 1] - prices[prices.length - 1 - lookback]);
  let path = 0;
  for (let i = prices.length - lookback; i < prices.length; i++) {
    path += Math.abs(prices[i] - prices[i - 1]);
  }
  const efficiencyRatio = path > 0 ? netMove / path : 0;

  let regime = 'CHOP';
  if (fastNow > slowNow && slopePct > 0.1 && efficiencyRatio >= 0.25) regime = 'UPTREND';
  else if (fastNow < slowNow && slopePct < -0.1 && efficiencyRatio >= 0.25) regime = 'DOWNTREND';

  return {
    regime,
    emaFast: Number(fastNow.toFixed(6)),
    emaSlow: Number(slowNow.toFixed(6)),
    slopePct: Number(slopePct.toFixed(3)),
    efficiencyRatio: Number(efficiencyRatio.toFixed(3)),
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Deterministic empirical bootstrap Monte Carlo VaR-95 & CVaR-99 risk model.
 */
export function runBootstrapMonteCarlo({
  entryPrice,
  side = 'BUY',
  equityUsd = 10_000,
  notionalUsd = 500,
  prices = [],
  feeBps = 5,
  slippageBps = 15,
  stopLossPct = 8,
  takeProfitPct = 12,
  horizonSteps = 24,
  numPaths = 500,
  seedTag = 'HSK/USDT',
}) {
  const safeEntry = Math.max(1e-8, entryPrice);
  const safeEq = Math.max(1, equityUsd);
  const qty = notionalUsd / safeEntry;
  const roundTripCostUsd = notionalUsd * ((feeBps * 2 + slippageBps) / 10_000);

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  const pool =
    returns.length >= 6
      ? returns
      : [-0.014, -0.008, -0.003, 0.001, 0.004, 0.009, -0.005, 0.003, -0.011, 0.008, 0.002, -0.006];

  const rng = mulberry32(hashSeed(`${seedTag}:${side}:${safeEntry.toFixed(5)}:${notionalUsd.toFixed(0)}`));
  const slPx = side === 'BUY' ? safeEntry * (1 - stopLossPct / 100) : safeEntry * (1 + stopLossPct / 100);
  const tpPx = side === 'BUY' ? safeEntry * (1 + takeProfitPct / 100) : safeEntry * (1 - takeProfitPct / 100);

  const pnls = [];
  let wins = 0;
  let slHits = 0;
  let tpHits = 0;

  for (let p = 0; p < numPaths; p++) {
    let px = safeEntry;
    let active = true;
    let finalPnl = -roundTripCostUsd;

    for (let h = 1; h <= horizonSteps; h++) {
      if (!active) break;
      px *= Math.exp(pool[Math.floor(rng() * pool.length)]);
      const hitSl = side === 'BUY' ? px <= slPx : px >= slPx;
      const hitTp = side === 'BUY' ? px >= tpPx : px <= tpPx;
      if (hitSl) {
        finalPnl = (side === 'BUY' ? slPx - safeEntry : safeEntry - slPx) * qty - roundTripCostUsd;
        slHits++;
        active = false;
      } else if (hitTp) {
        finalPnl = (side === 'BUY' ? tpPx - safeEntry : safeEntry - tpPx) * qty - roundTripCostUsd;
        tpHits++;
        active = false;
      }
    }
    if (active) {
      finalPnl = (side === 'BUY' ? px - safeEntry : safeEntry - px) * qty - roundTripCostUsd;
    }
    const clamped = Math.max(-safeEq, finalPnl);
    pnls.push(clamped);
    if (clamped > 0) wins++;
  }

  const sorted = [...pnls].sort((a, b) => a - b);
  const meanPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const p05 = percentile(sorted, 0.05);
  const var95Usd = Math.max(0, -p05);
  const tailN = Math.max(1, Math.floor(sorted.length * 0.01));
  const cvar99Usd = Math.max(var95Usd, -(sorted.slice(0, tailN).reduce((a, b) => a + b, 0) / tailN));

  return {
    numPaths,
    expectedPnlUsd: Number(meanPnl.toFixed(2)),
    var95Usd: Number(var95Usd.toFixed(2)),
    var95Pct: Number(((var95Usd / safeEq) * 100).toFixed(2)),
    cvar99Usd: Number(cvar99Usd.toFixed(2)),
    cvar99Pct: Number(((cvar99Usd / safeEq) * 100).toFixed(2)),
    winRatePct: Number(((wins / numPaths) * 100).toFixed(1)),
    slHitRatePct: Number(((slHits / numPaths) * 100).toFixed(1)),
    tpHitRatePct: Number(((tpHits / numPaths) * 100).toFixed(1)),
  };
}

export const RISK_PROFILES = {
  low: { label: 'Conservative', sizeFactor: 0.3, minEdgeBps: 55, maxVar95Pct: 1.5, maxPositionPct: 35 },
  mid: { label: 'Balanced', sizeFactor: 0.6, minEdgeBps: 35, maxVar95Pct: 3.0, maxPositionPct: 55 },
  high: { label: 'Aggressive', sizeFactor: 1.0, minEdgeBps: 20, maxVar95Pct: 5.0, maxPositionPct: 75 },
};

export function hashSignalPayload(payload) {
  const canonical = JSON.stringify(payload);
  return '0x' + crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Full BasisFlow AI Decision Engine for HashKey Chain (HSKSwap V3).
 */
export function evaluateSignal({
  pair = 'WHSK/USDT',
  dexPrice,
  dexPool3000Price = null,
  refPrice,
  priceHistory = [],
  baseBalance = 0,
  quoteBalance = 10_000,
  config = {},
}) {
  const riskKey = RISK_PROFILES[config.riskAppetite] ? config.riskAppetite : 'low';
  const profile = RISK_PROFILES[riskKey];
  const maxTradeQuote = Number(config.maxTradeQuote ?? 500);
  const edgeBps = Number(config.edgeBps ?? profile.minEdgeBps);
  const stopLossEquity = Number(config.stopLossEquity ?? 9_200);
  const paused = Boolean(config.paused);

  const baseValueUsdt = baseBalance * (dexPrice || 0);
  const equityUsd = quoteBalance + baseValueUsdt;
  const positionPct = equityUsd > 0 ? (baseValueUsdt / equityUsd) * 100 : 0;

  const spreadBps = computeSpreadBps(dexPrice, refPrice);
  const crossTierBps =
    dexPool3000Price && dexPrice ? computeSpreadBps(dexPrice, dexPool3000Price) : 0;
  const regimeInfo = detectRegime(priceHistory);

  let action = 'HOLD';
  let reason = `Spread ${spreadBps} bps inside +/-${edgeBps} bps deadband (${regimeInfo.regime} regime).`;
  let rawSize = 0;

  if (paused) {
    reason = 'Vault is PAUSED (manual pause or on-chain stop-loss circuit breaker engaged).';
  } else if (equityUsd < stopLossEquity) {
    action = 'TRIGGER_STOPLOSS';
    reason = `Portfolio equity $${equityUsd.toFixed(2)} breached hard stop-loss floor $${stopLossEquity.toFixed(2)} — triggering on-chain pause.`;
  } else if (spreadBps >= edgeBps) {
    // DEX is cheap relative to reference spot -> BUY WHSK on DEX
    const strength = Math.min(1.5, Math.abs(spreadBps) / Math.max(edgeBps, 20));
    rawSize = Math.min(maxTradeQuote, maxTradeQuote * profile.sizeFactor * Math.min(1, strength));
    const roomUsdt = Math.max(0, (equityUsd * profile.maxPositionPct) / 100 - baseValueUsdt);
    rawSize = Math.min(rawSize, roomUsdt, quoteBalance * 0.95);
    if (rawSize >= 10) {
      action = 'BUY';
      reason = `DEX trades ${spreadBps.toFixed(1)} bps BELOW ref ($${dexPrice.toFixed(5)} vs $${refPrice.toFixed(5)}); cross-tier ${crossTierBps.toFixed(1)} bps; ${regimeInfo.regime} regime.`;
    } else {
      reason = `Bullish spread (+${spreadBps.toFixed(1)} bps) capped by ${profile.maxPositionPct}% max base-exposure limit.`;
    }
  } else if (spreadBps <= -edgeBps) {
    // DEX is rich relative to reference spot -> SELL WHSK for USDT on DEX
    const strength = Math.min(1.5, Math.abs(spreadBps) / Math.max(edgeBps, 20));
    rawSize = Math.min(maxTradeQuote, maxTradeQuote * profile.sizeFactor * Math.min(1, strength), baseValueUsdt);
    if (rawSize >= 10) {
      action = 'SELL';
      reason = `DEX trades ${Math.abs(spreadBps).toFixed(1)} bps ABOVE ref ($${dexPrice.toFixed(5)} vs $${refPrice.toFixed(5)}); taking profit into USDT.`;
    } else {
      reason = `Negative spread (${spreadBps.toFixed(1)} bps) — no WHSK inventory to sell.`;
    }
  }

  // Run Monte-Carlo VaR pre-trade gate on proposed order
  const mc = runBootstrapMonteCarlo({
    entryPrice: dexPrice || 0.1,
    side: action === 'SELL' ? 'SELL' : 'BUY',
    equityUsd,
    notionalUsd: Math.max(rawSize, 50),
    prices: priceHistory,
    seedTag: `${pair}:${Math.round((dexPrice || 0) * 1e5)}`,
  });

  // Scale down size if VaR-95 exceeds risk profile ceiling
  let sizedUsdt = rawSize;
  if ((action === 'BUY' || action === 'SELL') && mc.var95Pct > profile.maxVar95Pct && mc.var95Pct > 0) {
    const scale = profile.maxVar95Pct / mc.var95Pct;
    sizedUsdt = Number((rawSize * scale).toFixed(2));
    reason += ` VaR-95 scaled size by ${(scale * 100).toFixed(0)}% to stay under ${profile.maxVar95Pct}% budget.`;
  } else {
    sizedUsdt = Number(rawSize.toFixed(2));
  }

  const baseQty = dexPrice > 0 ? Number((sizedUsdt / dexPrice).toFixed(4)) : 0;
  const confidence = Number(
    Math.min(99, Math.max(15, 50 + Math.min(45, (Math.abs(spreadBps) / Math.max(edgeBps, 25)) * 22))).toFixed(1),
  );

  const signalPayload = {
    pair,
    action,
    dexPrice: Number((dexPrice || 0).toFixed(6)),
    refPrice: Number((refPrice || 0).toFixed(6)),
    spreadBps,
    crossTierBps,
    regime: regimeInfo.regime,
    riskAppetite: riskKey,
    sizeUsdt: sizedUsdt,
    var95Usd: mc.var95Usd,
  };

  return {
    ...signalPayload,
    baseQty,
    confidence,
    equityUsd: Number(equityUsd.toFixed(2)),
    positionPct: Number(positionPct.toFixed(2)),
    regimeDetail: regimeInfo,
    monteCarlo: mc,
    explanation: reason,
    signalHash: hashSignalPayload(signalPayload),
  };
}

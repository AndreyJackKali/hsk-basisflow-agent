import { RISK_PROFILES } from './quant.mjs';

/**
 * Natural-Language Chat Controller for BasisFlow Agent (HSK Edition).
 * Supports interactive adjustment of risk appetite, trade size, execution frequency,
 * trading pairs, stop-loss floors, pause/resume, and real-time PnL/position inspection.
 */

const SUPPORTED_PAIRS = ['WHSK/USDT', 'HSK/USDT', 'HSK/USDC', 'ETH/USDT'];

export function parseChatCommand(input, state) {
  const raw = String(input || '').trim();
  const lower = raw.toLowerCase();
  const next = { ...state };
  const changes = [];

  if (!raw || lower === 'help' || lower === '?') {
    return {
      state: next,
      intent: 'HELP',
      reply:
        'Available commands: "risk low|mid|high", "size 250", "every 60s" (or "every 5m"), "assets WHSK/USDT", "stoploss 9300", "edge 40", "pause", "resume", "status", "pnl", "explain".',
    };
  }

  // Emergency pause / stop
  if (/\b(pause|stop|halt|freeze|kill)\b/.test(lower) && !/stoploss|stop-loss|stop loss/.test(lower)) {
    next.paused = true;
    return {
      state: next,
      intent: 'PAUSE',
      onChainAction: 'setPaused(true)',
      reply: 'Vault PAUSED. Agent execution is halted; owner retain full non-custodial withdrawal rights.',
    };
  }

  // Resume
  if (/\b(resume|unpause|start|go)\b/.test(lower)) {
    next.paused = false;
    return {
      state: next,
      intent: 'RESUME',
      onChainAction: 'setPaused(false)',
      reply: `Vault RESUMED on ${next.pair} (${RISK_PROFILES[next.riskAppetite]?.label} risk, max $${next.maxTradeQuote}/trade, every ${next.intervalSec}s).`,
    };
  }

  // Status / positions / PnL
  if (/\b(status|positions?|pnl|portfolio|balance|equity)\b/.test(lower)) {
    const eq = (next.quoteBalance ?? 10_000) + (next.baseBalance ?? 0) * (next.lastDexPrice ?? 0.1);
    const pnl = eq - (next.initialEquity ?? 10_000);
    const pnlPct = ((pnl / (next.initialEquity ?? 10_000)) * 100).toFixed(2);
    return {
      state: next,
      intent: 'STATUS',
      reply: `Equity: $${eq.toFixed(2)} (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} / ${pnlPct}%) | Cash: ${(next.quoteBalance ?? 0).toFixed(2)} USDT | Position: ${(next.baseBalance ?? 0).toFixed(1)} WHSK | Status: ${next.paused ? 'PAUSED' : 'ACTIVE'} | Risk: ${next.riskAppetite.toUpperCase()} | Stop-Loss: $${next.stopLossEquity}.`,
    };
  }

  // Explain last decision
  if (/\b(explain|why|signal|audit|last)\b/.test(lower)) {
    const last = next.lastDecision;
    return {
      state: next,
      intent: 'EXPLAIN',
      reply: last
        ? `Last decision: ${last.action} ($${last.sizeUsdt} | conf ${last.confidence}%). ${last.explanation} VaR-95: $${last.monteCarlo?.var95Usd} (${last.monteCarlo?.var95Pct}%). Audit signalHash: ${last.signalHash.slice(0, 18)}...`
        : 'No trades evaluated yet. Run a tick to generate a verifiable signalHash.',
    };
  }

  // Risk appetite
  const riskMatch = lower.match(/\b(?:risk|appetite|profile)\s*(?:to|=|:)?\s*(low|conservative|mid|medium|balanced|high|aggressive)\b/);
  if (riskMatch) {
    const map = {
      low: 'low',
      conservative: 'low',
      mid: 'mid',
      medium: 'mid',
      balanced: 'mid',
      high: 'high',
      aggressive: 'high',
    };
    const key = map[riskMatch[1]];
    next.riskAppetite = key;
    next.edgeBps = RISK_PROFILES[key].minEdgeBps;
    changes.push(`risk=${key} (${RISK_PROFILES[key].label}, edge>=${next.edgeBps}bps, maxPos=${RISK_PROFILES[key].maxPositionPct}%)`);
  }

  // Trade size
  const sizeMatch = lower.match(/\b(?:size|amount|notional|max\s*trade|trade\s*size)\s*(?:to|=|:|\$)?\s*(\d+(?:\.\d+)?)\b/);
  if (sizeMatch) {
    const val = Math.max(10, Math.min(5_000, Number(sizeMatch[1])));
    next.maxTradeQuote = val;
    changes.push(`maxTradeQuote=$${val} USDT`);
  }

  // Frequency / interval
  const freqMatch = lower.match(/\b(?:every|freq|frequency|interval|cooldown)\s*(?:to|=|:)?\s*(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hours)?\b/);
  if (freqMatch) {
    let sec = Number(freqMatch[1]);
    const unit = freqMatch[2] || 's';
    if (unit.startsWith('m')) sec *= 60;
    else if (unit.startsWith('h')) sec *= 3600;
    next.intervalSec = Math.max(10, Math.min(86_400, sec));
    changes.push(`interval=${next.intervalSec}s`);
  }

  // Stop-loss floor
  const slMatch = lower.match(/\b(?:stoploss|stop-loss|stop\s*loss|floor)\s*(?:to|=|:|\$)?\s*(\d+(?:\.\d+)?)\b/);
  if (slMatch) {
    const sl = Math.max(100, Number(slMatch[1]));
    next.stopLossEquity = sl;
    changes.push(`stopLossEquity=$${sl} USDT`);
  }

  // Spread threshold (edge bps)
  const edgeMatch = lower.match(/\b(?:edge|spread|threshold)\s*(?:to|=|:)?\s*(\d+)\s*(?:bps)?\b/);
  if (edgeMatch) {
    next.edgeBps = Math.max(5, Math.min(500, Number(edgeMatch[1])));
    changes.push(`minEdge=${next.edgeBps} bps`);
  }

  // Assets / pair
  const pairMatch = raw.match(/\b(W?HSK\s*\/\s*USDT|HSK\s*\/\s*USDC|ETH\s*\/\s*USDT)\b/i);
  if (pairMatch) {
    const normalized = pairMatch[1].replace(/\s+/g, '').toUpperCase();
    const canonical = normalized === 'HSK/USDT' ? 'WHSK/USDT' : normalized;
    if (SUPPORTED_PAIRS.includes(canonical)) {
      next.pair = canonical;
      changes.push(`pair=${canonical}`);
    }
  }

  if (changes.length > 0) {
    return {
      state: next,
      intent: 'UPDATE_CONFIG',
      onChainAction: 'setLimits(...)',
      changes,
      reply: `Updated strategy guardrails: ${changes.join(' | ')}.`,
    };
  }

  return {
    state: next,
    intent: 'UNKNOWN',
    reply: `Command not recognized: "${raw}". Type "help" for risk, size, frequency, pair, stop-loss, pause, or status commands.`,
  };
}

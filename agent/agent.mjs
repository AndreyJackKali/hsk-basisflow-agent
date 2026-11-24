#!/usr/bin/env node
/**
 * BasisFlow Agent (HSK Edition) — Autonomous Trading Loop & Live HSKSwap V3 Monitor
 *
 * Usage:
 *   node agent/agent.mjs --once              # Single live HSK Mainnet (177) + CEX reference evaluation
 *   node agent/agent.mjs --loop              # Continuous monitoring loop
 *   node agent/agent.mjs --chat "risk mid size 600"  # Evaluate a chat guardrail command
 */

import { fetchLiveHskSwapSnapshot, fetchReferenceHskPrice } from './hsk_rpc.mjs';
import { evaluateSignal } from './quant.mjs';
import { parseChatCommand } from './chat.mjs';

const state = {
  pair: 'WHSK/USDT',
  riskAppetite: process.env.RISK || 'mid',
  maxTradeQuote: Number(process.env.SIZE || 500),
  intervalSec: Number(process.env.EVERY || 60),
  stopLossEquity: Number(process.env.STOPLOSS || 9200),
  edgeBps: Number(process.env.EDGE_BPS || 35),
  paused: false,
  initialEquity: 10_000,
  quoteBalance: Number(process.env.QUOTE_BAL || 8_500),
  baseBalance: Number(process.env.BASE_BAL || 15_000),
  lastDexPrice: 0.1,
  priceHistory: [],
  lastDecision: null,
};

async function runTick() {
  const [hskSnap, refSnap] = await Promise.all([
    fetchLiveHskSwapSnapshot(),
    fetchReferenceHskPrice(),
  ]);

  const dexPrice = hskSnap.pool500.priceUsdt;
  const dexPool3000Price = hskSnap.pool3000.priceUsdt;
  const refPrice = refSnap.medianPrice ?? dexPrice;
  state.lastDexPrice = dexPrice;
  state.priceHistory.push(dexPrice);
  if (state.priceHistory.length > 60) state.priceHistory.shift();

  const decision = evaluateSignal({
    pair: state.pair,
    dexPrice,
    dexPool3000Price,
    refPrice,
    priceHistory: state.priceHistory,
    baseBalance: state.baseBalance,
    quoteBalance: state.quoteBalance,
    config: state,
  });
  state.lastDecision = decision;

  const output = {
    timestamp: new Date().toISOString(),
    mode: process.env.EXECUTE === '1' ? 'live-testnet' : 'live-readonly-mainnet',
    hskMainnetBlock: hskSnap.blockNumber,
    hskSwapPool500: hskSnap.pool500,
    hskSwapPool3000: hskSnap.pool3000,
    referenceCex: refSnap,
    decision,
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

const args = process.argv.slice(2);
const chatIdx = args.indexOf('--chat');
if (chatIdx !== -1 && args[chatIdx + 1]) {
  const res = parseChatCommand(args[chatIdx + 1], state);
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}

await runTick();
if (args.includes('--loop')) {
  setInterval(() => {
    runTick().catch((err) => console.error('Tick error:', err.message));
  }, state.intervalSec * 1000);
}

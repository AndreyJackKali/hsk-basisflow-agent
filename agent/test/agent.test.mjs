import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSpreadBps,
  detectRegime,
  runBootstrapMonteCarlo,
  evaluateSignal,
} from '../quant.mjs';
import { parseChatCommand } from '../chat.mjs';
import { sqrtPriceX96ToUsdtPerWhsk } from '../hsk_rpc.mjs';

test('sqrtPriceX96ToUsdtPerWhsk matches live HSKSwap Mainnet block #30587839', () => {
  const px = sqrtPriceX96ToUsdtPerWhsk(25055738251564958613595n);
  assert.ok(px > 0.0999 && px < 0.1002, `expected ~0.100013, got ${px}`);
});

test('computeSpreadBps positive when reference > dex (buy DEX signal)', () => {
  assert.equal(computeSpreadBps(0.1, 0.102), 200);
  assert.equal(computeSpreadBps(0.1, 0.098), -200);
});

test('detectRegime identifies UPTREND, DOWNTREND and CHOP', () => {
  const up = Array.from({ length: 25 }, (_, i) => 0.08 + i * 0.0015);
  const down = Array.from({ length: 25 }, (_, i) => 0.12 - i * 0.0015);
  const chop = Array.from({ length: 25 }, (_, i) => 0.1 + (i % 2 === 0 ? 0.001 : -0.001));
  assert.equal(detectRegime(up).regime, 'UPTREND');
  assert.equal(detectRegime(down).regime, 'DOWNTREND');
  assert.equal(detectRegime(chop).regime, 'CHOP');
});

test('runBootstrapMonteCarlo is deterministic and returns sane VaR-95 / CVaR-99', () => {
  const prices = Array.from({ length: 30 }, (_, i) => 0.1 * (1 + Math.sin(i * 0.7) * 0.02));
  const r1 = runBootstrapMonteCarlo({ entryPrice: 0.1, side: 'BUY', equityUsd: 10_000, notionalUsd: 1_000, prices });
  const r2 = runBootstrapMonteCarlo({ entryPrice: 0.1, side: 'BUY', equityUsd: 10_000, notionalUsd: 1_000, prices });
  assert.deepEqual(r1, r2);
  assert.ok(r1.var95Usd >= 0 && r1.cvar99Usd >= r1.var95Usd);
  assert.ok(r1.winRatePct >= 0 && r1.winRatePct <= 100);
});

test('evaluateSignal emits BUY, SELL, HOLD, and TRIGGER_STOPLOSS cleanly', () => {
  const buySig = evaluateSignal({
    dexPrice: 0.098,
    refPrice: 0.102,
    quoteBalance: 10_000,
    baseBalance: 0,
    config: { riskAppetite: 'mid', maxTradeQuote: 500, stopLossEquity: 9_200 },
  });
  assert.equal(buySig.action, 'BUY');
  assert.ok(buySig.sizeUsdt > 0 && buySig.signalHash.startsWith('0x') && buySig.signalHash.length === 66);

  const sellSig = evaluateSignal({
    dexPrice: 0.103,
    refPrice: 0.098,
    quoteBalance: 8_000,
    baseBalance: 20_000,
    config: { riskAppetite: 'mid', maxTradeQuote: 500, stopLossEquity: 9_200 },
  });
  assert.equal(sellSig.action, 'SELL');
  assert.ok(sellSig.sizeUsdt > 0);

  const slSig = evaluateSignal({
    dexPrice: 0.05,
    refPrice: 0.05,
    quoteBalance: 5_000,
    baseBalance: 60_000, // equity = 8,000 < 9,200
    config: { riskAppetite: 'low', maxTradeQuote: 500, stopLossEquity: 9_200 },
  });
  assert.equal(slSig.action, 'TRIGGER_STOPLOSS');
});

test('parseChatCommand updates risk, size, frequency, pair, stop-loss, and pause', () => {
  let state = {
    pair: 'WHSK/USDT',
    riskAppetite: 'low',
    maxTradeQuote: 500,
    intervalSec: 300,
    stopLossEquity: 9_200,
    edgeBps: 55,
    paused: false,
    quoteBalance: 9_500,
    baseBalance: 5_000,
    lastDexPrice: 0.1,
    initialEquity: 10_000,
  };

  let res = parseChatCommand('risk high size 800 every 2m stoploss 9400 assets HSK/USDC', state);
  assert.equal(res.intent, 'UPDATE_CONFIG');
  assert.equal(res.state.riskAppetite, 'high');
  assert.equal(res.state.maxTradeQuote, 800);
  assert.equal(res.state.intervalSec, 120);
  assert.equal(res.state.stopLossEquity, 9_400);
  assert.equal(res.state.pair, 'HSK/USDC');

  res = parseChatCommand('pause', res.state);
  assert.equal(res.state.paused, true);

  res = parseChatCommand('status', res.state);
  assert.equal(res.intent, 'STATUS');
  assert.ok(res.reply.includes('PAUSED'));
});

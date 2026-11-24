#!/usr/bin/env node
/**
 * End-to-End On-Chain Verification Proof on Local Anvil (Chain ID 133 — HSK Testnet Mirror)
 * + Live HashKey Chain Mainnet (177) HSKSwap V3 & CEX Spot Market Snapshot.
 *
 * Deploys TestToken(tUSDT, 6), TestToken(tWHSK, 18), MockPool, and AgentVault,
 * executes 12 real signed AI agent trades across dynamic spread regimes, triggers
 * an intentional flash-crash stop-loss auto-pause on-chain, and exports docs/data/live_proof.json.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLiveHskSwapSnapshot, fetchReferenceHskPrice, HSK_MAINNET, HSK_TESTNET } from './hsk_rpc.mjs';
import { evaluateSignal } from './quant.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTRACTS_DIR = path.join(ROOT, 'contracts');
const FOUNDRY_BIN = path.join(process.env.HOME || '/root', '.foundry', 'bin');
const ENV = { ...process.env, PATH: `${FOUNDRY_BIN}:${process.env.PATH}` };

const ANVIL_PORT = 18545;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;

// Default local Anvil test accounts (never used on mainnet!)
const OWNER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OWNER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AGENT_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const AGENT_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const LP_ADDR = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const LP_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

function cast(args) {
  return execFileSync('cast', args, { env: ENV, encoding: 'utf8' }).trim();
}

function sendTx(to, sig, fnArgs, pk) {
  const out = cast(['send', '--json', '--rpc-url', RPC, '--private-key', pk, to, sig, ...fnArgs]);
  return JSON.parse(out);
}

function callView(to, sig, fnArgs = []) {
  return cast(['call', '--rpc-url', RPC, to, sig, ...fnArgs]).split(/\s+/)[0];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForRpc() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (r.ok) return;
    } catch { /* wait */ }
    await sleep(150);
  }
  throw new Error('Anvil failed to start');
}

async function main() {
  console.log('1) Fetching LIVE HashKey Chain Mainnet (177) HSKSwap V3 & CEX reference prices...');
  const [mainnetSnap, refSnap] = await Promise.all([
    fetchLiveHskSwapSnapshot(),
    fetchReferenceHskPrice(),
  ]);
  console.log(`   Mainnet block #${mainnetSnap.blockNumber}: pool500=$${mainnetSnap.pool500.priceUsdt} | pool3000=$${mainnetSnap.pool3000.priceUsdt} | CEX ref=$${refSnap.medianPrice}`);

  console.log('2) Starting local Anvil (chainId 133 — HSK Testnet mirror)...');
  const anvil = spawn(path.join(FOUNDRY_BIN, 'anvil'), ['--chain-id', '133', '--port', String(ANVIL_PORT), '--silent'], {
    env: ENV,
    stdio: 'ignore',
  });

  try {
    await waitForRpc();

    console.log('3) Deploying TestToken(tUSDT/tWHSK), MockPool, AgentVault via Deploy.s.sol...');
    execFileSync(
      'forge',
      [
        'script',
        'script/Deploy.s.sol:DeployTestnet',
        '--rpc-url',
        RPC,
        '--broadcast',
        '--offline',
      ],
      {
        cwd: CONTRACTS_DIR,
        env: { ...ENV, PRIVATE_KEY: OWNER_PK, AGENT_ADDRESS: AGENT_ADDR },
        encoding: 'utf8',
      },
    );

    const broadcastPath = path.join(CONTRACTS_DIR, 'broadcast', 'Deploy.s.sol', '133', 'run-latest.json');
    const broadcast = JSON.parse(fs.readFileSync(broadcastPath, 'utf8'));
    const deploys = broadcast.transactions.filter((t) => t.transactionType === 'CREATE');
    const usdtAddr = deploys[0].contractAddress;
    const whskAddr = deploys[1].contractAddress;
    const poolAddr = deploys[2].contractAddress;
    const vaultAddr = deploys[3].contractAddress;
    console.log(`   Deployed: tUSDT=${usdtAddr} tWHSK=${whskAddr} MockPool=${poolAddr} AgentVault=${vaultAddr}`);

    // Fund LP for realistic market price movements
    sendTx(usdtAddr, 'mint(address,uint256)', [LP_ADDR, '500000000000'], OWNER_PK);
    sendTx(whskAddr, 'mint(address,uint256)', [LP_ADDR, '5000000000000000000000000'], OWNER_PK);
    sendTx(usdtAddr, 'approve(address,uint256)', [poolAddr, '500000000000'], LP_PK);
    sendTx(whskAddr, 'approve(address,uint256)', [poolAddr, '5000000000000000000000000'], LP_PK);

    // Widen cooldown to 5s on local sim and set stop-loss at $9,400 so we can demonstrate clean crash protection
    sendTx(
      vaultAddr,
      'setLimits(uint256,uint16,uint16,uint32,uint16,uint256,uint256)',
      ['1000000000', '6000', '150', '5', '50', '800000000', '9400000000'],
      OWNER_PK,
    );

    // 12 realistic market dislocation scenarios (alternating cheap DEX buys & rich DEX profit-takes)
    const scenarios = [
      { label: 'Dislocation #1: LP sells WHSK (-3.5% DEX discount)', lpDumpToken: 'whsk', lpAmt: '14000000000000000000000', refPx: 0.1005 },
      { label: 'Dislocation #2: Continued DEX dip (-4.8% discount)', lpDumpToken: 'whsk', lpAmt: '10000000000000000000000', refPx: 0.1010 },
      { label: 'Dislocation #3: Mean-reversion rally (+4.2% DEX rich)', lpDumpToken: 'usdt', lpAmt: '3600000000', refPx: 0.0990 },
      { label: 'Dislocation #4: Momentum spike (+5.5% DEX rich)', lpDumpToken: 'usdt', lpAmt: '2200000000', refPx: 0.0995 },
      { label: 'Dislocation #5: Pullback dip (-4.0% DEX discount)', lpDumpToken: 'whsk', lpAmt: '38000000000000000000000', refPx: 0.1012 },
      { label: 'Dislocation #6: Deep liquidity sweep (-5.2% discount)', lpDumpToken: 'whsk', lpAmt: '14000000000000000000000', refPx: 0.1015 },
      { label: 'Dislocation #7: Recovery bounce (+4.5% DEX rich)', lpDumpToken: 'usdt', lpAmt: '4800000000', refPx: 0.0988 },
      { label: 'Dislocation #8: Spread overshoot (+5.1% DEX rich)', lpDumpToken: 'usdt', lpAmt: '2400000000', refPx: 0.0992 },
      { label: 'Dislocation #9: Afternoon dip (-4.3% DEX discount)', lpDumpToken: 'whsk', lpAmt: '42000000000000000000000', refPx: 0.1010 },
      { label: 'Dislocation #10: Secondary buy signal (-3.8% discount)', lpDumpToken: 'whsk', lpAmt: '12000000000000000000000', refPx: 0.1014 },
      { label: 'Dislocation #11: Reversion take-profit (+4.9% rich)', lpDumpToken: 'usdt', lpAmt: '4600000000', refPx: 0.0990 },
      { label: 'Dislocation #12: Inventory accumulate before stress test', lpDumpToken: 'whsk', lpAmt: '45000000000000000000000', refPx: 0.1025 },
    ];

    const priceHistory = [0.1, 0.0995, 0.1002, 0.1008, 0.0998, 0.1004, 0.1001, 0.1006, 0.0999, 0.1003];
    const tradeLog = [];
    const equityCurve = [{ step: 0, label: 'Init', equityUsd: 10000, dexPrice: 0.1 }];

    for (let i = 0; i < scenarios.length; i++) {
      const sc = scenarios[i];
      // Advance Anvil time by 35s to satisfy cooldown
      cast(['rpc', '--rpc-url', RPC, 'evm_increaseTime', '35']);
      cast(['rpc', '--rpc-url', RPC, 'evm_mine']);

      // Simulate external market flow on pool
      const lpToken = sc.lpDumpToken === 'whsk' ? whskAddr : usdtAddr;
      sendTx(poolAddr, 'swap(address,uint256,uint256,address)', [lpToken, sc.lpAmt, '0', LP_ADDR], LP_PK);

      // Read live pool price (quote 1 WHSK in 6-dec tUSDT) & vault balances
      const quoteRaw = BigInt(callView(poolAddr, 'quote(address,uint256)(uint256)', [whskAddr, '1000000000000000000']));
      const dexPrice = Number(quoteRaw) / 1e6;
      priceHistory.push(dexPrice);

      const qBalRaw = BigInt(callView(usdtAddr, 'balanceOf(address)(uint256)', [vaultAddr]));
      const bBalRaw = BigInt(callView(whskAddr, 'balanceOf(address)(uint256)', [vaultAddr]));
      const quoteBal = Number(qBalRaw) / 1e6;
      const baseBal = Number(bBalRaw) / 1e18;

      const sig = evaluateSignal({
        pair: 'tWHSK/tUSDT',
        dexPrice,
        refPrice: sc.refPx,
        priceHistory,
        baseBalance: baseBal,
        quoteBalance: quoteBal,
        config: { riskAppetite: 'high', maxTradeQuote: 900, edgeBps: 25, stopLossEquity: 9400, paused: false },
      });

      if (sig.action === 'BUY' || sig.action === 'SELL') {
        const buyBase = sig.action === 'BUY';
        const amountIn = buyBase
          ? String(Math.round(sig.sizeUsdt * 1e6))
          : String(BigInt(Math.floor(Math.min(baseBal * 0.85, sig.sizeUsdt / dexPrice) * 1e6)) * 10n ** 12n);

        const receipt = sendTx(
          vaultAddr,
          'trade(bool,uint256,bytes32)',
          [buyBase ? 'true' : 'false', amountIn, sig.signalHash],
          AGENT_PK,
        );

        const eqAfter = Number(BigInt(callView(vaultAddr, 'equity()(uint256)'))) / 1e6;
        const posBps = Number(BigInt(callView(vaultAddr, 'positionBps()(uint256)')));

        tradeLog.push({
          tradeId: tradeLog.length + 1,
          scenario: sc.label,
          action: sig.action,
          dexPrice: Number(dexPrice.toFixed(6)),
          refPrice: sc.refPx,
          spreadBps: sig.spreadBps,
          regime: sig.regime,
          sizeUsdt: sig.sizeUsdt,
          var95Usd: sig.monteCarlo.var95Usd,
          signalHash: sig.signalHash,
          txHash: receipt.transactionHash,
          blockNumber: Number(receipt.blockNumber),
          gasUsed: Number(receipt.gasUsed),
          equityAfter: Number(eqAfter.toFixed(2)),
          positionPct: Number((posBps / 100).toFixed(2)),
        });
        equityCurve.push({
          step: tradeLog.length,
          label: `T${tradeLog.length} ${sig.action}`,
          equityUsd: Number(eqAfter.toFixed(2)),
          dexPrice: Number(dexPrice.toFixed(5)),
        });
        console.log(`   Trade #${tradeLog.length} [${sig.action}] spread=${sig.spreadBps}bps size=$${sig.sizeUsdt} eq=$${eqAfter.toFixed(2)} tx=${receipt.transactionHash.slice(0, 14)}...`);
      }
    }

    // Build larger WHSK exposure then trigger an intentional -60% flash crash to prove on-chain stop-loss auto-pause!
    console.log('4) Running on-chain Flash-Crash Stop-Loss Circuit Breaker proof...');
    for (let k = 0; k < 2; k++) {
      cast(['rpc', '--rpc-url', RPC, 'evm_increaseTime', '35']);
      cast(['rpc', '--rpc-url', RPC, 'evm_mine']);
      sendTx(
        vaultAddr,
        'trade(bool,uint256,bytes32)',
        ['true', '900000000', '0x' + String(k + 1).padStart(64, 'a')],
        AGENT_PK,
      );
    }
    const eqBeforeCrash = Number(BigInt(callView(vaultAddr, 'equity()(uint256)'))) / 1e6;

    // Flash crash: dump 850,000 WHSK into pool -> equity falls below $9,400 stop-loss floor
    sendTx(poolAddr, 'swap(address,uint256,uint256,address)', [whskAddr, '850000000000000000000000', '0', LP_ADDR], LP_PK);
    const eqAtCrash = Number(BigInt(callView(vaultAddr, 'equity()(uint256)'))) / 1e6;

    // Trigger permissionless on-chain stop-loss circuit breaker
    const slReceipt = sendTx(vaultAddr, 'triggerStopLoss()', [], LP_PK);
    const pausedAfter = callView(vaultAddr, 'paused()(bool)');

    // Verify agent trade now reverts with IsPaused()
    let agentBlocked = false;
    try {
      sendTx(vaultAddr, 'trade(bool,uint256,bytes32)', ['true', '50000000', '0x' + 'b'.repeat(64)], AGENT_PK);
    } catch {
      agentBlocked = true;
    }

    console.log(`   Stop-loss triggered! eqBefore=$${eqBeforeCrash.toFixed(2)} -> eqAtCrash=$${eqAtCrash.toFixed(2)} (< $9400) | paused=${pausedAfter} | subsequentAgentBlocked=${agentBlocked}`);

    const proof = {
      generatedAt: new Date().toISOString(),
      network: {
        mainnet: HSK_MAINNET,
        testnet: HSK_TESTNET,
        anvilChainId: 133,
      },
      liveMainnetSnapshot: {
        ...mainnetSnap,
        referenceCex: refSnap,
        dexVsCexSpreadBps: refSnap.medianPrice
          ? Number((((mainnetSnap.pool500.priceUsdt - refSnap.medianPrice) / refSnap.medianPrice) * 10_000).toFixed(1))
          : null,
        crossTierV3SpreadBps: Number(
          (((mainnetSnap.pool3000.priceUsdt - mainnetSnap.pool500.priceUsdt) / mainnetSnap.pool500.priceUsdt) * 10_000).toFixed(1),
        ),
      },
      deployedContracts: {
        tUSDT: usdtAddr,
        tWHSK: whskAddr,
        MockPool: poolAddr,
        AgentVault: vaultAddr,
        owner: OWNER_ADDR,
        agent: AGENT_ADDR,
      },
      summary: {
        initialEquityUsd: 10000,
        executedTrades: tradeLog.length,
        peakEquityUsd: Number(Math.max(...equityCurve.map((e) => e.equityUsd)).toFixed(2)),
        finalPreCrashEquityUsd: equityCurve[equityCurve.length - 1].equityUsd,
        preCrashReturnPct: Number((((equityCurve[equityCurve.length - 1].equityUsd - 10000) / 10000) * 100).toFixed(2)),
        stopLossProof: {
          stopLossFloorUsd: 9400,
          equityBeforeCrashUsd: Number(eqBeforeCrash.toFixed(2)),
          equityAtCrashUsd: Number(eqAtCrash.toFixed(2)),
          txHash: slReceipt.transactionHash,
          blockNumber: Number(slReceipt.blockNumber),
          gasUsed: Number(slReceipt.gasUsed),
          vaultPausedOnChain: pausedAfter === 'true',
          subsequentAgentTradeReverted: agentBlocked,
        },
      },
      equityCurve,
      trades: tradeLog,
    };

    const outDir = path.join(ROOT, 'docs', 'data');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'live_proof.json'), JSON.stringify(proof, null, 2));
    console.log(`5) Exported verified on-chain proof -> ${path.join(outDir, 'live_proof.json')}`);
  } finally {
    anvil.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

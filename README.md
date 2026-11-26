# BasisFlow Agent (HSK Edition)

[![BasisFlow HSK Agent CI](https://github.com/AndreyJackKali/hsk-basisflow-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/AndreyJackKali/hsk-basisflow-agent/actions/workflows/ci.yml)
[![Live Terminal](https://img.shields.io/badge/Live%20Terminal-GitHub%20Pages-10b981?style=flat-square)](https://andreyjackkali.github.io/hsk-basisflow-agent/)
[![Judge Brief](https://img.shields.io/badge/1--Page%20Judge%20Brief-Live%20Card-06b6d4?style=flat-square)](https://andreyjackkali.github.io/hsk-basisflow-agent/judge-brief.html)

**Non-Custodial, On-Chain Risk-Bounded AI Trading Vault & Conversational Terminal for HashKey Chain (HSKSwap V3).**

Built for **DoraHacks HSK Chain Horizon · Seoul — Track 1: AI Agent Trading**.

- **Live Interactive Web & Chat Terminal:** https://andreyjackkali.github.io/hsk-basisflow-agent/
- **1-Page Printable Judge Brief (Rubric + Mainnet Contracts + Demo Video):** https://andreyjackkali.github.io/hsk-basisflow-agent/judge-brief.html
- **8-Slide Interactive Pitch Deck:** https://andreyjackkali.github.io/hsk-basisflow-agent/deck.html
- **Narrated HD Demo Video (82s, 1280×720):** https://andreyjackkali.github.io/hsk-basisflow-agent/demo.mp4

---

## Why BasisFlow Agent?

Autonomous DeFi trading agents fail in production when they hold raw user private keys or rely purely on off-chain risk checks. **BasisFlow Agent** separates custody from intelligence and enforces **7 hard risk guardrails directly in Solidity** on HashKey Chain:

1. **`maxTradeQuote`** — hard cap on quote notional per single trade.
2. **`maxPositionBps`** — hard ceiling on base-asset (`WHSK`) exposure as a % of total marked vault equity.
3. **`maxSlippageBps`** — hard execution floor relative to live executable venue quote (`<= 10%`).
4. **`cooldownSecs`** — minimum interval between consecutive agent trades (adjustable trading frequency).
5. **`maxDailyTrades`** — hard UTC daily trade count ceiling.
6. **`dailyLossCapQuote`** — hard UTC daily equity drawdown limit (reverts if breached).
7. **`stopLossEquity`** — hard portfolio equity floor that triggers **automatic on-chain pause** (`StopLossTriggered`) either post-trade or via permissionless keeper `triggerStopLoss()`.

The delegated AI agent EOA can **never** withdraw user funds. The owner retains unconditional `setPaused()`, `revokeAgent()`, `emergencyUnwind()`, and `withdrawAll()` escape hatches. Every executed trade commits a verifiable `keccak256(signalJSON)` audit hash (`signalHash`) on-chain.

---

## Architecture

```mermaid
flowchart LR
  HSKMainnet["HashKey Chain Mainnet (177)<br/>HSKSwap V3 WHSK/USDT Pools<br/>slot0() + liquidity()"] -->|Read-Only eth_call| Quant["BasisFlow Quant Engine<br/>Spread/Basis + EMA Regime<br/>+ 500-Path Bootstrap Monte Carlo VaR"]
  CEX["Reference Spot Feeds<br/>Gate.io + KuCoin HSK/USDT"] --> Quant
  Chat["Natural-Language Chat UI<br/>risk / size / freq / assets / stoploss / pause"] --> Quant
  Quant -->|Signed trade(buyBase, amtIn, signalHash)| Vault["AgentVault.sol<br/>7 On-Chain Risk Guardrails<br/>+ Auto Stop-Loss Breaker"]
  Vault --> Adapter["HSKSwapV3Adapter.sol (Mainnet 177)<br/>or MockPool.sol (Testnet 133)"]
  Adapter --> DEX["HSKSwap SwapRouter02<br/>0x1f38...dc64"]
```

---

## Verified Live HashKey Chain Mainnet (177) Contracts

Our agent reads live on-chain state from verified HashKey Chain Mainnet (Chain ID `177`) contracts with zero gas:

| Contract | Mainnet (177) Address | Verified Live State |
|---|---|---|
| **WHSK** (18 dec) | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` | `symbol() = "WHSK"`, `decimals() = 18` |
| **USDT** (6 dec) | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` | `symbol() = "USDT"`, `decimals() = 6` |
| **HSKSwap V3 Factory** | `0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4` | Active V3 pools at fee 500 & 3000 |
| **HSKSwap SwapRouter02** | `0x1f3858C46F8F6fE76260b8208995D228C5cddc64` | 24,143 bytes verified bytecode |
| **WHSK/USDT 0.05% Pool** | `0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A` | Block `#30,588,010`: `$0.100013 USDT/WHSK` |
| **WHSK/USDT 0.30% Pool** | `0x0767F7b1af495D245EA00219cFB8B2Ed6EafAe62` | Block `#30,588,010`: `$0.100193 USDT/WHSK` (+18 bps) |

---

## Verified End-to-End Execution & Stop-Loss Proof

Reproduce everything locally in seconds:

```bash
# 1. Run 17 Foundry smart contract + 256-run fuzz tests (including live Mainnet Q96 quote check)
cd contracts && forge test --offline -vv

# 2. Run 6 Node.js quant, Monte-Carlo VaR, chat parser, and RPC tests
cd .. && npm test

# 3. Probe LIVE HashKey Chain Mainnet (177) HSKSwap V3 pools + Gate.io/KuCoin CEX reference
npm run probe

# 4. Run full Anvil (Chain ID 133 mirror) 12-trade + flash-crash stop-loss on-chain proof
npm run anvil-demo
```

Latest verified proof (`docs/data/live_proof.json`):
- **12 signed on-chain trades** executed by the delegated AI agent EOA on a HashKey Chain Testnet (133) mirror (`tUSDT` 6 dec / `tWHSK` 18 dec): **`$10,000.00 -> $10,799.31` peak (`+7.99%`)**, **`$10,748.37` pre-crash (`+7.48%`)**.
- **On-chain flash-crash stop-loss verification:** LP flash-crash pushed marked equity from `$10,746.68` to `$8,204.70` (`< $9,400` hard floor) -> `triggerStopLoss()` executed on-chain -> `vault.paused() == true` -> subsequent agent trade **reverted (`IsPaused`)**.

---

## One-Command Deployment to HashKey Chain Testnet (133) or Mainnet (177)

```bash
# HashKey Chain Testnet (Chain ID 133, RPC https://testnet.hsk.xyz)
cd contracts
PRIVATE_KEY=0x<OWNER_KEY> AGENT_ADDRESS=0x<AGENT_EOA> \
  forge script script/Deploy.s.sol:DeployTestnet \
  --rpc-url https://testnet.hsk.xyz --broadcast

# HashKey Chain Mainnet (Chain ID 177, wired directly to live HSKSwap V3)
PRIVATE_KEY=0x<OWNER_KEY> AGENT_ADDRESS=0x<AGENT_EOA> \
  forge script script/Deploy.s.sol:DeployMainnet \
  --rpc-url https://mainnet.hsk.xyz --broadcast
```

## License

MIT

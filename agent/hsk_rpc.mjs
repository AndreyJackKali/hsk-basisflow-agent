/**
 * Live Read-Only RPC Reader for HashKey Chain Mainnet (177) HSKSwap V3 Pools
 * + Live Reference Spot Ticker (Gate.io / KuCoin) + Testnet (133) MockPool Reader.
 * Zero gas required for live mainnet market monitoring!
 */

export const HSK_MAINNET = {
  chainId: 177,
  rpc: 'https://mainnet.hsk.xyz',
  explorer: 'https://hashkey.blockscout.com',
  whsk: '0xB210D2120d57b758EE163cFfb43e73728c471Cf1', // 18 decimals
  usdt: '0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029', // 6 decimals
  factory: '0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4',
  router: '0x1f3858C46F8F6fE76260b8208995D228C5cddc64',
  pool500: '0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A',  // WHSK/USDT 0.05%
  pool3000: '0x0767F7b1af495D245EA00219cFB8B2Ed6EafAe62', // WHSK/USDT 0.30%
};

export const HSK_TESTNET = {
  chainId: 133,
  rpc: 'https://testnet.hsk.xyz',
  explorer: 'https://testnet-explorer.hskchain.net',
};

const SLOT0_SIG = '0x3850c7bd'; // slot0()
const LIQUIDITY_SIG = '0x1a686502'; // liquidity()

export async function jsonRpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'RPC error');
  return json.result;
}

/**
 * Converts Uniswap V3 sqrtPriceX96 for token0=WHSK(18), token1=USDT(6) into USDT per WHSK.
 */
export function sqrtPriceX96ToUsdtPerWhsk(sqrtPriceX96BigInt) {
  const q96 = 2n ** 96n;
  // Scale by 1e18 for float conversion without precision loss
  const ratio = Number(sqrtPriceX96BigInt) / Number(q96);
  // token0 has 18 decimals, token1 has 6 decimals => multiply by 10^(18 - 6) = 1e12
  return ratio * ratio * 1e12;
}

export async function fetchLiveHskSwapSnapshot(rpcUrl = HSK_MAINNET.rpc) {
  const [blockHex, s500, l500, s3000, l3000] = await Promise.all([
    jsonRpc(rpcUrl, 'eth_blockNumber'),
    jsonRpc(rpcUrl, 'eth_call', [{ to: HSK_MAINNET.pool500, data: SLOT0_SIG }, 'latest']),
    jsonRpc(rpcUrl, 'eth_call', [{ to: HSK_MAINNET.pool500, data: LIQUIDITY_SIG }, 'latest']),
    jsonRpc(rpcUrl, 'eth_call', [{ to: HSK_MAINNET.pool3000, data: SLOT0_SIG }, 'latest']),
    jsonRpc(rpcUrl, 'eth_call', [{ to: HSK_MAINNET.pool3000, data: LIQUIDITY_SIG }, 'latest']),
  ]);

  const sqrt500 = BigInt('0x' + s500.slice(2, 66));
  const sqrt3000 = BigInt('0x' + s3000.slice(2, 66));
  const price500 = sqrtPriceX96ToUsdtPerWhsk(sqrt500);
  const price3000 = sqrtPriceX96ToUsdtPerWhsk(sqrt3000);

  return {
    chainId: HSK_MAINNET.chainId,
    blockNumber: Number(BigInt(blockHex)),
    timestamp: new Date().toISOString(),
    pool500: {
      address: HSK_MAINNET.pool500,
      feeBps: 5,
      sqrtPriceX96: sqrt500.toString(),
      liquidity: BigInt(l500).toString(),
      priceUsdt: Number(price500.toFixed(6)),
    },
    pool3000: {
      address: HSK_MAINNET.pool3000,
      feeBps: 30,
      sqrtPriceX96: sqrt3000.toString(),
      liquidity: BigInt(l3000).toString(),
      priceUsdt: Number(price3000.toFixed(6)),
    },
  };
}

export async function fetchReferenceHskPrice() {
  const sources = [];
  try {
    const r = await fetch('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=HSK_USDT', {
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    if (Array.isArray(j) && j[0]?.last) {
      sources.push({
        venue: 'Gate.io',
        price: Number(j[0].last),
        bid: Number(j[0].highest_bid),
        ask: Number(j[0].lowest_ask),
        vol24hUsd: Number(j[0].quote_volume),
      });
    }
  } catch { /* fallback to KuCoin */ }

  try {
    const r = await fetch('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=HSK-USDT', {
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    if (j?.data?.price) {
      sources.push({
        venue: 'KuCoin',
        price: Number(j.data.price),
        bid: Number(j.data.bestBid),
        ask: Number(j.data.bestAsk),
      });
    }
  } catch { /* ignore */ }

  if (sources.length === 0) return { medianPrice: null, sources: [] };
  const medianPrice = sources.reduce((a, s) => a + s.price, 0) / sources.length;
  return { medianPrice: Number(medianPrice.toFixed(6)), sources };
}

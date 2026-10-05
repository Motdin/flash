import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFlashbotsSignatureHeader,
  buildMevBundleRpcPayload,
  formatBlockNumberHex,
} from '../agent/mev-bundle.js';
import { resolveChainWssUrl } from '../agent/ws-listener.js';
import {
  decodeCurveIndices,
  encodeCurveIndices,
} from '../config/dex-routers.js';
import {
  applySlippageBps,
  computeClosedFormV2OptimalLoan,
  computeLoanAmountForUsd,
  evaluateArbitrageQuote,
  evaluateMultiHopArbitrageQuote,
  interpolateParabolicOptimalLoanUsd,
  selectOptimalArbitrageTier,
} from './dex-scanner.js';
import {
  clearWatchlistMemory,
  computeLiquidationIncentiveBps,
  evaluateLiquidationCandidate,
  getAtRiskWatchlist,
} from './liquidation-scanner.js';
import type { ScannedAsset } from './scanner.js';

const mockUsdc: ScannedAsset = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  decimals: 6,
  balance: 1_000_000_000_000n, // 1,000,000 USDC
  formattedBalance: '1000000',
  priceUsd: 1.0,
  priceTimestamp: Math.floor(Date.now() / 1000),
  priceSource: 'morpho-api',
  usdValue: 1_000_000,
  eligible: true,
  sources: ['morpho-market-loan'],
};

const mockWeth: ScannedAsset = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  decimals: 18,
  balance: 500n * 10n ** 18n,
  formattedBalance: '500',
  priceUsd: 2500.0,
  priceTimestamp: Math.floor(Date.now() / 1000),
  priceSource: 'morpho-api',
  usdValue: 1_250_000,
  eligible: true,
  sources: ['morpho-market-loan'],
};

const mockCbBtc: ScannedAsset = {
  address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  symbol: 'cbBTC',
  decimals: 8,
  balance: 50n * 10n ** 8n,
  formattedBalance: '50',
  priceUsd: 65000.0,
  priceTimestamp: Math.floor(Date.now() / 1000),
  priceSource: 'morpho-api',
  usdValue: 3_250_000,
  eligible: true,
  sources: ['morpho-market-loan'],
};

test('applySlippageBps reduces amount by basis points accurately', () => {
  assert.equal(applySlippageBps(10_000n, 30), 9_970n);
  assert.equal(applySlippageBps(1_000_000n, 100), 990_000n);
  assert.equal(applySlippageBps(0n, 50), 0n);
});

test('computeLoanAmountForUsd caps at max pool share and computes USD', () => {
  const { amount, actualUsd } = computeLoanAmountForUsd(mockUsdc, 10_000);
  assert.equal(amount, 10_000_000_000n);
  assert.equal(actualUsd, 10_000);

  const capped = computeLoanAmountForUsd(mockUsdc, 800_000, 5_000);
  assert.equal(capped.amount, 500_000_000_000n);
  assert.equal(capped.actualUsd, 500_000);
});

test('computeClosedFormV2OptimalLoan calculates analytical optimal input for V2 reserves', () => {
  // Pool A has cheaper WETH (1,000,000 USDC : 420 WETH), Pool B has pricier WETH (380 WETH : 1,000,000 USDC)
  const optimalLoan = computeClosedFormV2OptimalLoan({
    reserveAIn: 1_000_000n * 10n ** 6n,
    reserveAOut: 420n * 10n ** 18n,
    reserveBIn: 380n * 10n ** 18n,
    reserveBOut: 1_000_000n * 10n ** 6n,
    feeBpsA: 30,
    feeBpsB: 30,
  });
  assert.ok(optimalLoan > 15_000n * 10n ** 6n && optimalLoan < 35_000n * 10n ** 6n);
});

test('evaluateArbitrageQuote, parabolic interpolation, & selectOptimalArbitrageTier pick peak profit', () => {
  const makeTier = (loanUsd: number, grossUsd: number) =>
    evaluateArbitrageQuote({
      chainKey: 'base',
      loanAsset: mockUsdc,
      intermediateAsset: mockWeth,
      firstRouter: {
        name: 'Uniswap V3 (Base 5bps)',
        address: '0x2626664c2603336E57B271c5C0b26F421741e481',
        protocol: 'uniswap-v3',
        kind: 2,
        feeBps: 5,
        v3FeeTier: 500,
      },
      secondRouter: {
        name: 'Aerodrome Volatile',
        address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
        protocol: 'aerodrome',
        kind: 3,
        feeBps: 30,
        factoryAddress: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
        aeroStable: false,
      },
      loanAmount: BigInt(loanUsd) * 1_000_000n,
      loanAmountUsd: loanUsd,
      intermediateOut: 4n * 10n ** 18n,
      finalOut: BigInt(loanUsd + grossUsd) * 1_000_000n,
      gasCostUsd: 0.25,
      minProfitUsd: 5,
      maxSlippageBps: 20,
      tokensWhitelistedOnArb: true,
      routersWhitelistedOnArb: true,
    });

  const t1 = makeTier(4_500, 18);
  const t2 = makeTier(10_000, 42);
  const t3 = makeTier(18_500, 29);

  const continuousPeak = interpolateParabolicOptimalLoanUsd([t1, t2, t3]);
  assert.ok(continuousPeak && continuousPeak > 9_000 && continuousPeak < 14_000);

  const selected = selectOptimalArbitrageTier([t1, t2, t3]);
  assert.equal(selected?.loanAmountUsd, 10_000);
  assert.equal(selected?.netProfitUsd, 41.75);
  assert.ok(selected?.optimalContinuousLoanUsd);
});

test('evaluateMultiHopArbitrageQuote builds 3-hop triangular arbitrage steps', () => {
  const router1 = {
    name: 'Uniswap V3 (Base 5bps)',
    address: '0x2626664c2603336E57B271c5C0b26F421741e481' as const,
    protocol: 'uniswap-v3' as const,
    kind: 2 as const,
    feeBps: 5,
    v3FeeTier: 500,
  };
  const router2 = {
    name: 'Aerodrome Volatile',
    address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' as const,
    protocol: 'aerodrome' as const,
    kind: 3 as const,
    feeBps: 30,
    factoryAddress: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as const,
    aeroStable: false,
  };

  const triCandidate = evaluateMultiHopArbitrageQuote({
    chainKey: 'base',
    loanAsset: mockUsdc,
    intermediateAssets: [mockWeth, mockCbBtc],
    routers: [router1, router2, router1],
    loanAmount: 10_000_000_000n,
    loanAmountUsd: 10_000,
    hopOutputs: [4n * 10n ** 18n, 15_500_000n, 10_055_000_000n], // +$55 gross
    gasCostUsd: 0.3,
    minProfitUsd: 5,
    maxSlippageBps: 25,
    tokensWhitelistedOnArb: true,
    routersWhitelistedOnArb: true,
  });

  assert.equal(triCandidate.isMultiHop, true);
  assert.equal(triCandidate.steps?.length, 3);
  assert.equal(triCandidate.profitable, true);
  assert.equal(triCandidate.steps?.[2].tokenOut, mockUsdc.address);
});

test('encodeCurveIndices & decodeCurveIndices pack and unpack coin indices accurately', () => {
  const packed = encodeCurveIndices(1, 2);
  const decoded = decodeCurveIndices(packed);
  assert.equal(decoded.i, 1);
  assert.equal(decoded.j, 2);
});

test('evaluateLiquidationCandidate indexes At-Risk borrowers (1.00 <= HF <= 1.12) into Watchlist', () => {
  clearWatchlistMemory();

  // At-Risk borrower: borrow = $8,200, collateral = $10,000, LLTV = 86% -> maxBorrow = $8,600 -> HF = 1.0488
  const atRiskResult = evaluateLiquidationCandidate({
    chainKey: 'base',
    market: {
      marketId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      loanToken: mockUsdc.address,
      loanSymbol: 'USDC',
      loanDecimals: 6,
      loanPriceUsd: 1.0,
      collateralToken: mockWeth.address,
      collateralSymbol: 'WETH',
      collateralDecimals: 18,
      collateralPriceUsd: 2500.0,
      oracle: '0x2222222222222222222222222222222222222222',
      irm: '0x3333333333333333333333333333333333333333',
      lltv: 860_000_000_000_000_000n,
    },
    borrower: '0x5555555555555555555555555555555555555555',
    borrowUsd: 8_200,
    collateralUsd: 10_000,
    swapRouter: {
      name: 'Uniswap V3 (Base 5bps)',
      address: '0x2626664c2603336E57B271c5C0b26F421741e481',
      protocol: 'uniswap-v3',
      kind: 2,
      feeBps: 5,
      v3FeeTier: 500,
    },
    gasCostUsd: 0.1,
    minProfitUsd: 10,
    maxSlippageBps: 30,
  });

  // Not yet liquidatable (HF > 1.0), so returns null, but IS stored in watchlist!
  assert.equal(atRiskResult, null);
  const watchlist = getAtRiskWatchlist('base');
  assert.equal(watchlist.length, 1);
  assert.equal(watchlist[0].status, 'at-risk');
  assert.equal(watchlist[0].healthFactor, 1.0488);

  // Liquidatable borrower (HF < 1.0)
  const lifBps = computeLiquidationIncentiveBps(860_000_000_000_000_000n);
  assert.equal(lifBps, 10_438);

  const candidate = evaluateLiquidationCandidate({
    chainKey: 'base',
    market: {
      marketId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      loanToken: mockUsdc.address,
      loanSymbol: 'USDC',
      loanDecimals: 6,
      loanPriceUsd: 1.0,
      collateralToken: mockWeth.address,
      collateralSymbol: 'WETH',
      collateralDecimals: 18,
      collateralPriceUsd: 2500.0,
      oracle: '0x2222222222222222222222222222222222222222',
      irm: '0x3333333333333333333333333333333333333333',
      lltv: 860_000_000_000_000_000n,
    },
    borrower: '0x4444444444444444444444444444444444444444',
    borrowUsd: 9_000,
    collateralUsd: 10_000,
    swapRouter: {
      name: 'Uniswap V3 (Base 5bps)',
      address: '0x2626664c2603336E57B271c5C0b26F421741e481',
      protocol: 'uniswap-v3',
      kind: 2,
      feeBps: 5,
      v3FeeTier: 500,
    },
    gasCostUsd: 0.1,
    minProfitUsd: 10,
    maxSlippageBps: 30,
  });

  assert.ok(candidate);
  assert.equal(candidate.profitable, true);
  assert.equal(getAtRiskWatchlist('base').length, 2);
});

test('buildFlashbotsSignatureHeader and buildMevBundleRpcPayload format EIP-191 bundle auth', async () => {
  const testPk = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const payload = buildMevBundleRpcPayload('eth_sendBundle', {
    txs: ['0x1234abcd'],
    targetBlockNumber: 20_000_000n,
  });

  assert.equal(formatBlockNumberHex(20_000_000n), '0x1312d00');
  const parsed = JSON.parse(payload) as { method: string; params: Array<{ blockNumber: string }> };
  assert.equal(parsed.method, 'eth_sendBundle');
  assert.equal(parsed.params[0].blockNumber, '0x1312d00');

  const sig = await buildFlashbotsSignatureHeader(testPk, payload);
  assert.ok(sig.headerValue.startsWith(`${sig.signerAddress}:0x`));
});

test('resolveChainWssUrl detects standard WSS and Base Flashblocks WSS URLs', () => {
  process.env.BASE_FLASHBLOCKS_WSS_URL = 'wss://mainnet.flashblocks.base.org/ws';
  const resolved = resolveChainWssUrl('base');
  assert.equal(resolved.wssUrl, 'wss://mainnet.flashblocks.base.org/ws');
  assert.equal(resolved.isFlashblocks, true);
  delete process.env.BASE_FLASHBLOCKS_WSS_URL;
});

import { getRoutersForChain, routerSupportsPair } from '../config/dex-routers.js';
import { readSingleRouterQuote } from './dex-scanner.js';
import type { PublicClient } from 'viem';

test('small/unrepresentable USD targets do not expand into half the pool', () => {
  const result = computeLoanAmountForUsd({ balance: 1000n * 10n ** 18n, decimals: 18, priceUsd: 1e12 }, 1);
  assert.equal(result.amount, 1_000_000n); // 1e-12 token, not 500 tokens
  assert.equal(result.actualUsd, 1);
  assert.equal(computeLoanAmountForUsd({ balance: 1000n, decimals: 0, priceUsd: 1000 }, 1).amount, 0n);
  assert.equal(computeLoanAmountForUsd({ balance: 1000n, decimals: 0, priceUsd: 1 }, 100).amount, 100n);
  assert.equal(computeLoanAmountForUsd(mockUsdc, NaN).amount, 0n);
});

test('custom V3/Aero fields survive registry normalization and incomplete adapters are rejected', () => {
  const address = '0x1111111111111111111111111111111111111111' as const;
  const quoter = '0x2222222222222222222222222222222222222222' as const;
  const list = getRoutersForChain('fixture', [
    { address, kind: 2, quoterAddress: quoter, v3FeeTier: 500 },
    { address, kind: 3, factoryAddress: quoter, aeroStable: true },
    { address, kind: 3, factoryAddress: quoter, aeroStable: false },
  ]);
  assert.equal(list.length, 3); assert.equal(list[0].quoterAddress, quoter);
  assert.equal(list[1].factoryAddress, quoter); assert.equal(list[1].aeroStable, true);
  assert.throws(() => getRoutersForChain('fixture', [{ address, kind: 2 }]), /quoterAddress/);
  assert.throws(() => getRoutersForChain('fixture', [{ address, kind: 4 }]), /curveCoins/);
});

test('Curve quotes never reinterpret unrelated/reversed token amounts as configured pool direction', async () => {
  const pool = { name: 'Curve', address: mockUsdc.address, protocol: 'curve' as const, kind: 4 as const,
    feeBps: 1, v3FeeTier: encodeCurveIndices(0,1), curveCoins: [mockUsdc.address, mockWeth.address] };
  assert.equal(routerSupportsPair(pool, mockUsdc.address, mockWeth.address), true);
  assert.equal(routerSupportsPair(pool, mockWeth.address, mockUsdc.address), false);
  let calls = 0;
  const client = { readContract: async () => { calls++; return 1n; } } as unknown as PublicClient;
  assert.equal(await readSingleRouterQuote(client, { router: pool, amountIn: 1n, tokenIn: mockCbBtc.address, tokenOut: mockWeth.address }), 0n);
  assert.equal(calls, 0);
});

test('direct V3 pool uses the matching pool tokens/fee and Quoter, never getAmountsOut', async () => {
  const methods: string[] = [];
  const client = { readContract: async (request: { functionName: string }) => {
    methods.push(request.functionName);
    if (request.functionName === 'token0') return mockUsdc.address;
    if (request.functionName === 'token1') return mockWeth.address;
    if (request.functionName === 'fee') return 500;
    if (request.functionName === 'quoteExactInputSingle') return [123n, 0n, 0, 0n];
    throw new Error('unexpected ABI');
  } } as unknown as PublicClient;
  assert.equal(await readSingleRouterQuote(client, { router: { name: 'pool', address: mockCbBtc.address,
    protocol: 'v3-direct-pool', kind: 5, feeBps: 5, quoterAddress: mockWeth.address },
    amountIn: 1n, tokenIn: mockUsdc.address, tokenOut: mockWeth.address }), 123n);
  assert.ok(!methods.includes('getAmountsOut'));
});

test('healthy/repaid borrowers are removed from the watchlist', () => {
  clearWatchlistMemory();
  const params = { chainKey: 'base', market: { marketId: `0x${'aa'.repeat(32)}` as const,
    loanToken: mockUsdc.address, loanSymbol: 'USDC', loanDecimals: 6, loanPriceUsd: 1,
    collateralToken: mockWeth.address, collateralSymbol: 'WETH', collateralDecimals: 18, collateralPriceUsd: 2500,
    oracle: mockUsdc.address, irm: mockWeth.address, lltv: 860000000000000000n }, borrower: mockCbBtc.address,
    borrowUsd: 9000, collateralUsd: 10000, swapRouter: getRoutersForChain('base')[0], gasCostUsd: 1, minProfitUsd: 5, maxSlippageBps: 30 };
  evaluateLiquidationCandidate(params); assert.equal(getAtRiskWatchlist().length, 1);
  evaluateLiquidationCandidate({ ...params, borrowUsd: 1000 }); assert.equal(getAtRiskWatchlist().length, 0);
  evaluateLiquidationCandidate(params);
  evaluateLiquidationCandidate({ ...params, borrowUsd: 0 }); assert.equal(getAtRiskWatchlist().length, 0);
});

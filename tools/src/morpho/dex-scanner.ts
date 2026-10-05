import {
  createPublicClient,
  formatGwei,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseUnits,
  type PublicClient,
} from 'viem';
import type { EvmChainConfig } from '../config/chains.js';
import {
  decodeCurveIndices,
  routerSupportsPair,
  type CustomDexRouter,
  getRoutersForChain,
  type DexRouterConfig,
  type RouterKindId,
} from '../config/dex-routers.js';
import type { Address } from '../config/registry.js';
import {
  scanMorphoLiquidations,
  type LiquidationCandidate,
} from './liquidation-scanner.js';
import type { ScannedAsset } from './scanner.js';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const REQUEST_TIMEOUT_MS = 15_000;
const ESTIMATED_ARB_GAS_UNITS = 280_000n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

const flashLoanExecutorAbi = parseAbi([
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function allowedToken(address) view returns (bool)',
]);

const arbExecutorAbi = parseAbi([
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function allowedToken(address) view returns (bool)',
  'function allowedRouter(address) view returns (bool)',
]);

const v2RouterAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
]);

const v3QuoterV2Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const aeroRouterAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
]);

const curvePoolAbi = parseAbi([
  'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
]);

export type TokenWhitelistState = {
  symbol: string;
  address: Address;
  decimals: number;
  usdValue: number | null;
  priceUsd: number | null;
  balance: bigint;
  formattedBalance: string;
  allowedOnFlashExecutor: boolean;
  allowedOnArbExecutor: boolean;
  matchesPolicyTarget: boolean;
  needsFlashWhitelist: boolean;
  needsArbWhitelist: boolean;
};

export type RouterWhitelistState = {
  name: string;
  address: Address;
  protocol: string;
  kind: RouterKindId;
  feeBps: number;
  hasBytecode: boolean;
  allowedOnArbExecutor: boolean;
  needsArbWhitelist: boolean;
};

export type SwapHopStepQuote = {
  router: Address;
  routerName: string;
  kind: RouterKindId;
  fee: number;
  stable: boolean;
  factory: Address;
  tokenIn: Address;
  tokenInSymbol: string;
  tokenOut: Address;
  tokenOutSymbol: string;
  expectedAmountOut: bigint;
  minAmountOut: bigint;
};

export type ArbitrageCandidate = {
  id: string;
  chain: string;
  loanToken: Address;
  loanSymbol: string;
  loanDecimals: number;
  intermediateToken: Address;
  intermediateSymbol: string;
  intermediateDecimals: number;
  firstRouter: Address;
  firstRouterName: string;
  firstRouterKind: RouterKindId;
  firstRouterFee: number;
  firstRouterStable: boolean;
  firstRouterFactory: Address;
  secondRouter: Address;
  secondRouterName: string;
  secondRouterKind: RouterKindId;
  secondRouterFee: number;
  secondRouterStable: boolean;
  secondRouterFactory: Address;
  /** Optional N-hop steps for triangular / multi-hop arbitrage (`executeMultiHopArbitrage`) */
  steps?: SwapHopStepQuote[];
  isMultiHop?: boolean;
  optimalContinuousLoanUsd?: number;
  loanAmount: bigint;
  formattedLoanAmount: string;
  loanAmountUsd: number;
  expectedIntermediateOut: bigint;
  formattedIntermediateOut: string;
  expectedFinalOut: bigint;
  formattedFinalOut: string;
  grossProfit: bigint;
  formattedGrossProfit: string;
  grossProfitUsd: number;
  estimatedGasCostUsd: number;
  netProfitUsd: number;
  spreadBps: number;
  minIntermediateAmount: bigint;
  minFinalAmount: bigint;
  minProfit: bigint;
  profitable: boolean;
  tokensWhitelistedOnArb: boolean;
  routersWhitelistedOnArb: boolean;
  readyToExecute: boolean;
};

export type ChainOpportunityReport = {
  chain: EvmChainConfig;
  blockNumber: bigint;
  gasPriceWei: bigint;
  gasPriceGwei: string;
  nativePriceUsd: number;
  flashExecutor?: Address;
  flashExecutorOwner?: Address;
  flashExecutorPaused?: boolean;
  arbExecutor?: Address;
  arbExecutorOwner?: Address;
  arbExecutorPaused?: boolean;
  tokenWhitelists: TokenWhitelistState[];
  routerWhitelists: RouterWhitelistState[];
  whitelistedAssets: TokenWhitelistState[];
  pendingWhitelistAssets: TokenWhitelistState[];
  pendingWhitelistRouters: RouterWhitelistState[];
  arbitrageCandidates: ArbitrageCandidate[];
  profitableCandidates: ArbitrageCandidate[];
  liquidationCandidates: LiquidationCandidate[];
  profitableLiquidations: LiquidationCandidate[];
  warnings: string[];
};

export type OpportunityScanOptions = {
  chain: EvmChainConfig;
  rpcUrl: string;
  assets: ScannedAsset[];
  flashExecutor?: Address;
  arbExecutor?: Address;
  targetWhitelistSymbols?: string[];
  arbLoanUsd?: number;
  loanSizeTiersUsd?: number[];
  minProfitUsd?: number;
  maxSlippageBps?: number;
  maxAssetsToPair?: number;
  enableTriangularArb?: boolean;
  extraRouters?: CustomDexRouter[];
};

export function applySlippageBps(amount: bigint, slippageBps: number): bigint {
  if (amount <= 0n) return 0n;
  const clampedBps = Math.max(0, Math.min(5_000, Math.floor(slippageBps)));
  return (amount * BigInt(10_000 - clampedBps)) / 10_000n;
}

export function bigintSqrt(value: bigint): bigint {
  if (value <= 0n) return 0n;
  if (value < 4n) return 1n;
  let z = value;
  let x = value / 2n + 1n;
  while (x < z) {
    z = x;
    x = (value / x + x) / 2n;
  }
  return z;
}

/**
 * Exact closed-form analytical optimal loan amount for two constant-product (V2) pools:
 * Pool A reserves: (reserveAIn, reserveAOut) with feeBpsA (e.g. 30 bps)
 * Pool B reserves: (reserveBIn, reserveBOut) with feeBpsB (e.g. 30 bps)
 * Returns the exact input amount in `loanToken` units that maximizes gross profit.
 */
export function computeClosedFormV2OptimalLoan(params: {
  reserveAIn: bigint;
  reserveAOut: bigint;
  reserveBIn: bigint;
  reserveBOut: bigint;
  feeBpsA?: number;
  feeBpsB?: number;
  maxLoanAmount?: bigint;
}): bigint {
  const {
    reserveAIn,
    reserveAOut,
    reserveBIn,
    reserveBOut,
    feeBpsA = 30,
    feeBpsB = 30,
    maxLoanAmount,
  } = params;

  if (reserveAIn <= 0n || reserveAOut <= 0n || reserveBIn <= 0n || reserveBOut <= 0n) {
    return 0n;
  }

  const gammaA = BigInt(10_000 - Math.max(0, Math.min(1_000, feeBpsA)));
  const gammaB = BigInt(10_000 - Math.max(0, Math.min(1_000, feeBpsB)));
  const scale = 10_000n;

  // Effective virtual reserves:
  // E_0 = R_aIn * R_bIn * scale^2
  // E_1 = R_aOut * R_bOut * gammaA * gammaB
  const e0 = reserveAIn * reserveBIn * scale * scale;
  const e1 = reserveAOut * reserveBOut * gammaA * gammaB;
  if (e1 <= e0) return 0n;

  const numerator = bigintSqrt(e0 * e1) - e0;
  const denominator = gammaA * scale * reserveBIn + gammaA * gammaB * reserveAOut;
  if (denominator <= 0n || numerator <= 0n) return 0n;

  const optimal = numerator / denominator;
  if (maxLoanAmount && maxLoanAmount > 0n && optimal > maxLoanAmount) {
    return maxLoanAmount;
  }
  return optimal;
}

/**
 * Estimates the continuous optimal loan USD via parabolic / golden-section curve interpolation
 * across sampled liquidity tiers `(loanAmountUsd, netProfitUsd)`.
 */
export function interpolateParabolicOptimalLoanUsd(
  candidates: ArbitrageCandidate[],
): number | undefined {
  if (candidates.length === 0) return undefined;
  const sortedBySize = [...candidates].sort((a, b) => a.loanAmountUsd - b.loanAmountUsd);
  let bestIdx = 0;
  for (let i = 1; i < sortedBySize.length; i++) {
    if (sortedBySize[i].netProfitUsd > sortedBySize[bestIdx].netProfitUsd) {
      bestIdx = i;
    }
  }
  const best = sortedBySize[bestIdx];
  if (bestIdx <= 0 || bestIdx >= sortedBySize.length - 1) {
    return best.loanAmountUsd;
  }

  const left = sortedBySize[bestIdx - 1];
  const mid = best;
  const right = sortedBySize[bestIdx + 1];

  const x1 = left.loanAmountUsd;
  const y1 = left.netProfitUsd;
  const x2 = mid.loanAmountUsd;
  const y2 = mid.netProfitUsd;
  const x3 = right.loanAmountUsd;
  const y3 = right.netProfitUsd;

  const denom = (x1 - x2) * (x1 - x3) * (x2 - x3);
  if (Math.abs(denom) < 1e-6) return mid.loanAmountUsd;

  const A = (x3 * (y2 - y1) + x2 * (y1 - y3) + x1 * (y3 - y2)) / denom;
  const B = (x3 * x3 * (y1 - y2) + x2 * x2 * (y3 - y1) + x1 * x1 * (y2 - y3)) / denom;

  // For a concave parabola (A < 0), vertex is at -B / (2A)
  if (A < 0) {
    const vertexX = -B / (2 * A);
    if (Number.isFinite(vertexX) && vertexX >= x1 && vertexX <= x3) {
      return Math.round(vertexX);
    }
  }
  return mid.loanAmountUsd;
}

export function computeLoanAmountForUsd(
  asset: Pick<ScannedAsset, 'balance' | 'decimals' | 'priceUsd'>,
  targetUsd: number,
  maxPoolShareBps = 5_000,
): { amount: bigint; actualUsd: number } {
  if (asset.balance <= 0n || !asset.priceUsd || asset.priceUsd <= 0 || targetUsd <= 0) {
    return { amount: 0n, actualUsd: 0 };
  }
  const desiredTokens = targetUsd / asset.priceUsd;
  const precision = Math.min(asset.decimals, 100);
  if (!Number.isFinite(desiredTokens) || !Number.isInteger(asset.decimals) || asset.decimals < 0
      || !Number.isFinite(maxPoolShareBps) || maxPoolShareBps <= 0 || maxPoolShareBps > 10000) return { amount: 0n, actualUsd: 0 };
  const formatted = desiredTokens.toFixed(precision);
  let requested = 0n;
  try {
    requested = parseUnits(formatted, asset.decimals);
  } catch {
    requested = 0n;
  }
  if (requested <= 0n) return { amount: 0n, actualUsd: 0 };
  const maxPoolAmount = (asset.balance * BigInt(maxPoolShareBps)) / 10_000n;
  const cap = maxPoolAmount;
  const finalAmount = requested <= cap ? requested : cap;
  const actualTokens = Number(formatUnits(finalAmount, asset.decimals));
  return {
    amount: finalAmount,
    actualUsd: actualTokens * asset.priceUsd,
  };
}

/**
 * Selects the optimal loan size tier from multiple candidate quotes for the same route,
 * maximizing netProfitUsd after gas and annotating the parabolic continuous peak.
 */
export function selectOptimalArbitrageTier(
  candidates: ArbitrageCandidate[],
): ArbitrageCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const continuousPeakUsd = interpolateParabolicOptimalLoanUsd(candidates);
  const best = [...candidates].sort(
    (a, b) => b.netProfitUsd - a.netProfitUsd || b.spreadBps - a.spreadBps,
  )[0];
  return {
    ...best,
    optimalContinuousLoanUsd: continuousPeakUsd ?? best.loanAmountUsd,
  };
}

/** Route identity never depends on untrusted/non-unique token symbols or display names. */
export function arbitrageRouteKey(chainKey: string, loanToken: Address, steps: SwapHopStepQuote[]): string {
  return [chainKey, loanToken.toLowerCase(), ...steps.map(s =>
    [s.tokenIn.toLowerCase(), s.tokenOut.toLowerCase(), s.router.toLowerCase(), s.kind, s.fee, s.stable, s.factory.toLowerCase()].join('/'))].join(':');
}

export function evaluateArbitrageQuote(params: {
  chainKey: string;
  loanAsset: ScannedAsset;
  intermediateAsset: ScannedAsset;
  firstRouter: DexRouterConfig;
  secondRouter: DexRouterConfig;
  loanAmount: bigint;
  loanAmountUsd: number;
  intermediateOut: bigint;
  finalOut: bigint;
  gasCostUsd: number;
  minProfitUsd: number;
  maxSlippageBps: number;
  tokensWhitelistedOnArb: boolean;
  routersWhitelistedOnArb: boolean;
}): ArbitrageCandidate {
  const {
    chainKey,
    loanAsset,
    intermediateAsset,
    firstRouter,
    secondRouter,
    loanAmount,
    loanAmountUsd,
    intermediateOut,
    finalOut,
    gasCostUsd,
    minProfitUsd,
    maxSlippageBps,
    tokensWhitelistedOnArb,
    routersWhitelistedOnArb,
  } = params;

  const grossProfit = finalOut > loanAmount ? finalOut - loanAmount : 0n;
  const grossTokens = Number(formatUnits(grossProfit, loanAsset.decimals));
  const grossProfitUsd = grossTokens * (loanAsset.priceUsd ?? 0);
  const netProfitUsd = grossProfitUsd - gasCostUsd;
  const spreadBps = loanAmount > 0n
    ? Number(((finalOut - loanAmount) * 10_000n) / loanAmount)
    : 0;

  const minIntermediateAmount = applySlippageBps(intermediateOut, maxSlippageBps);
  const minFinalFromSlippage = applySlippageBps(finalOut, maxSlippageBps);

  let requiredProfitUnits = 1n;
  if (loanAsset.priceUsd && loanAsset.priceUsd > 0) {
    const requiredUsd = Math.max(0, minProfitUsd + gasCostUsd);
    const reqTokens = requiredUsd / loanAsset.priceUsd;
    const precision = Math.min(loanAsset.decimals, 8);
    const formatted = reqTokens.toFixed(precision) || '0';
    try {
      const parsed = parseUnits(formatted, loanAsset.decimals);
      if (parsed > 0n) requiredProfitUnits = parsed;
    } catch {
      requiredProfitUnits = 1n;
    }
  }

  const minFinalAmount = minFinalFromSlippage > loanAmount + requiredProfitUnits
    ? minFinalFromSlippage
    : loanAmount + requiredProfitUnits;

  const profitable = grossProfit >= requiredProfitUnits && netProfitUsd >= minProfitUsd;

  const steps: SwapHopStepQuote[] = [
    {
      router: firstRouter.address,
      routerName: firstRouter.name,
      kind: firstRouter.kind ?? 0,
      fee: firstRouter.v3FeeTier ?? 0,
      stable: Boolean(firstRouter.aeroStable),
      factory: firstRouter.factoryAddress ?? ZERO_ADDRESS,
      tokenIn: loanAsset.address,
      tokenInSymbol: loanAsset.symbol,
      tokenOut: intermediateAsset.address,
      tokenOutSymbol: intermediateAsset.symbol,
      expectedAmountOut: intermediateOut,
      minAmountOut: minIntermediateAmount,
    },
    {
      router: secondRouter.address,
      routerName: secondRouter.name,
      kind: secondRouter.kind ?? 0,
      fee: secondRouter.v3FeeTier ?? 0,
      stable: Boolean(secondRouter.aeroStable),
      factory: secondRouter.factoryAddress ?? ZERO_ADDRESS,
      tokenIn: intermediateAsset.address,
      tokenInSymbol: intermediateAsset.symbol,
      tokenOut: loanAsset.address,
      tokenOutSymbol: loanAsset.symbol,
      expectedAmountOut: finalOut,
      minAmountOut: minFinalAmount,
    },
  ];

  return {
    id: `${arbitrageRouteKey(chainKey, loanAsset.address, steps)}:${loanAmount}`,
    chain: chainKey,
    loanToken: loanAsset.address,
    loanSymbol: loanAsset.symbol,
    loanDecimals: loanAsset.decimals,
    intermediateToken: intermediateAsset.address,
    intermediateSymbol: intermediateAsset.symbol,
    intermediateDecimals: intermediateAsset.decimals,
    firstRouter: firstRouter.address,
    firstRouterName: firstRouter.name,
    firstRouterKind: firstRouter.kind ?? 0,
    firstRouterFee: firstRouter.v3FeeTier ?? 0,
    firstRouterStable: Boolean(firstRouter.aeroStable),
    firstRouterFactory: firstRouter.factoryAddress ?? ZERO_ADDRESS,
    secondRouter: secondRouter.address,
    secondRouterName: secondRouter.name,
    secondRouterKind: secondRouter.kind ?? 0,
    secondRouterFee: secondRouter.v3FeeTier ?? 0,
    secondRouterStable: Boolean(secondRouter.aeroStable),
    secondRouterFactory: secondRouter.factoryAddress ?? ZERO_ADDRESS,
    steps,
    isMultiHop: false,
    loanAmount,
    formattedLoanAmount: formatUnits(loanAmount, loanAsset.decimals),
    loanAmountUsd,
    expectedIntermediateOut: intermediateOut,
    formattedIntermediateOut: formatUnits(intermediateOut, intermediateAsset.decimals),
    expectedFinalOut: finalOut,
    formattedFinalOut: formatUnits(finalOut, loanAsset.decimals),
    grossProfit,
    formattedGrossProfit: formatUnits(grossProfit, loanAsset.decimals),
    grossProfitUsd,
    estimatedGasCostUsd: gasCostUsd,
    netProfitUsd,
    spreadBps,
    minIntermediateAmount,
    minFinalAmount,
    minProfit: requiredProfitUnits,
    profitable,
    tokensWhitelistedOnArb,
    routersWhitelistedOnArb,
    readyToExecute: profitable && tokensWhitelistedOnArb && routersWhitelistedOnArb,
  };
}

/**
 * Evaluates a 3-hop (Triangular) or N-hop arbitrage cycle returning to `loanAsset`.
 */
export function evaluateMultiHopArbitrageQuote(params: {
  chainKey: string;
  loanAsset: ScannedAsset;
  intermediateAssets: ScannedAsset[];
  routers: DexRouterConfig[];
  loanAmount: bigint;
  loanAmountUsd: number;
  hopOutputs: bigint[];
  gasCostUsd: number;
  minProfitUsd: number;
  maxSlippageBps: number;
  tokensWhitelistedOnArb: boolean;
  routersWhitelistedOnArb: boolean;
}): ArbitrageCandidate {
  const {
    chainKey,
    loanAsset,
    intermediateAssets,
    routers,
    loanAmount,
    loanAmountUsd,
    hopOutputs,
    gasCostUsd,
    minProfitUsd,
    maxSlippageBps,
    tokensWhitelistedOnArb,
    routersWhitelistedOnArb,
  } = params;

  const finalOut = hopOutputs[hopOutputs.length - 1] ?? 0n;
  const firstOut = hopOutputs[0] ?? 0n;
  const grossProfit = finalOut > loanAmount ? finalOut - loanAmount : 0n;
  const grossTokens = Number(formatUnits(grossProfit, loanAsset.decimals));
  const grossProfitUsd = grossTokens * (loanAsset.priceUsd ?? 0);
  // Multi-hop uses ~1.35x gas of 2-hop
  const multiHopGasCostUsd = gasCostUsd * 1.35;
  const netProfitUsd = grossProfitUsd - multiHopGasCostUsd;
  const spreadBps = loanAmount > 0n
    ? Number(((finalOut - loanAmount) * 10_000n) / loanAmount)
    : 0;

  let requiredProfitUnits = 1n;
  if (loanAsset.priceUsd && loanAsset.priceUsd > 0) {
    const requiredUsd = Math.max(0, minProfitUsd + multiHopGasCostUsd);
    const reqTokens = requiredUsd / loanAsset.priceUsd;
    const precision = Math.min(loanAsset.decimals, 8);
    const formatted = reqTokens.toFixed(precision) || '0';
    try {
      const parsed = parseUnits(formatted, loanAsset.decimals);
      if (parsed > 0n) requiredProfitUnits = parsed;
    } catch {
      requiredProfitUnits = 1n;
    }
  }

  const allAssets = [loanAsset, ...intermediateAssets, loanAsset];
  const steps: SwapHopStepQuote[] = routers.map((router, idx) => {
    const tokenIn = allAssets[idx];
    const tokenOut = allAssets[idx + 1];
    const expectedOut = hopOutputs[idx] ?? 0n;
    const isFinal = idx === routers.length - 1;
    const minFromSlippage = applySlippageBps(expectedOut, maxSlippageBps);
    const minAmountOut =
      isFinal && minFromSlippage < loanAmount + requiredProfitUnits
        ? loanAmount + requiredProfitUnits
        : minFromSlippage;

    return {
      router: router.address,
      routerName: router.name,
      kind: router.kind ?? 0,
      fee: router.v3FeeTier ?? 0,
      stable: Boolean(router.aeroStable),
      factory: router.factoryAddress ?? ZERO_ADDRESS,
      tokenIn: tokenIn.address,
      tokenInSymbol: tokenIn.symbol,
      tokenOut: tokenOut.address,
      tokenOutSymbol: tokenOut.symbol,
      expectedAmountOut: expectedOut,
      minAmountOut,
    };
  });

  const pathSymbols = intermediateAssets.map((a) => a.symbol).join('->');
  const routerNames = routers.map((r) => r.name).join('->');
  const firstRouter = routers[0];
  const lastRouter = routers[routers.length - 1];
  const firstIntermediate = intermediateAssets[0];
  const profitable = grossProfit >= requiredProfitUnits && netProfitUsd >= minProfitUsd;

  return {
    id: `${arbitrageRouteKey(chainKey, loanAsset.address, steps)}:${loanAmount}`,
    chain: chainKey,
    loanToken: loanAsset.address,
    loanSymbol: loanAsset.symbol,
    loanDecimals: loanAsset.decimals,
    intermediateToken: firstIntermediate.address,
    intermediateSymbol: pathSymbols,
    intermediateDecimals: firstIntermediate.decimals,
    firstRouter: firstRouter.address,
    firstRouterName: firstRouter.name,
    firstRouterKind: firstRouter.kind ?? 0,
    firstRouterFee: firstRouter.v3FeeTier ?? 0,
    firstRouterStable: Boolean(firstRouter.aeroStable),
    firstRouterFactory: firstRouter.factoryAddress ?? ZERO_ADDRESS,
    secondRouter: lastRouter.address,
    secondRouterName: routerNames,
    secondRouterKind: lastRouter.kind ?? 0,
    secondRouterFee: lastRouter.v3FeeTier ?? 0,
    secondRouterStable: Boolean(lastRouter.aeroStable),
    secondRouterFactory: lastRouter.factoryAddress ?? ZERO_ADDRESS,
    steps,
    isMultiHop: true,
    loanAmount,
    formattedLoanAmount: formatUnits(loanAmount, loanAsset.decimals),
    loanAmountUsd,
    expectedIntermediateOut: firstOut,
    formattedIntermediateOut: formatUnits(firstOut, firstIntermediate.decimals),
    expectedFinalOut: finalOut,
    formattedFinalOut: formatUnits(finalOut, loanAsset.decimals),
    grossProfit,
    formattedGrossProfit: formatUnits(grossProfit, loanAsset.decimals),
    grossProfitUsd,
    estimatedGasCostUsd: multiHopGasCostUsd,
    netProfitUsd,
    spreadBps,
    minIntermediateAmount: steps[0]?.minAmountOut ?? 0n,
    minFinalAmount: steps[steps.length - 1]?.minAmountOut ?? 0n,
    minProfit: requiredProfitUnits,
    profitable,
    tokensWhitelistedOnArb,
    routersWhitelistedOnArb,
    readyToExecute: profitable && tokensWhitelistedOnArb && routersWhitelistedOnArb,
  };
}

function inferNativePriceUsd(chain: EvmChainConfig, assets: ScannedAsset[]): number {
  const wrapped: Record<string, string> = {
    ethereum: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    base: '0x4200000000000000000000000000000000000006',
    optimism: '0x4200000000000000000000000000000000000006',
    arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  };
  const now = Date.now() / 1000;
  return assets.find(a => a.address.toLowerCase() === wrapped[chain.key]
    && a.priceUsd !== null && Number.isFinite(a.priceUsd) && a.priceUsd > 0
    && a.priceTimestamp !== null && a.priceTimestamp <= now + 300 && now - a.priceTimestamp <= 3600)?.priceUsd ?? 0;
}

type QuoteCallRequest = {
  router: DexRouterConfig;
  amountIn: bigint;
  tokenIn: Address;
  tokenOut: Address;
};

export async function readSingleRouterQuote(
  client: PublicClient,
  req: QuoteCallRequest,
): Promise<bigint> {
  const { router, amountIn, tokenIn, tokenOut } = req;
  if (!routerSupportsPair(router, tokenIn, tokenOut)) return 0n;
  try {
    if (router.kind === 5) {
      if (!router.quoterAddress) return 0n;
      const abi = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)']);
      const [token0, token1, fee] = await Promise.all([
        client.readContract({ address: router.address, abi, functionName: 'token0' }),
        client.readContract({ address: router.address, abi, functionName: 'token1' }),
        client.readContract({ address: router.address, abi, functionName: 'fee' }),
      ]);
      if (!([token0.toLowerCase(), token1.toLowerCase()].includes(tokenIn.toLowerCase())
        && [token0.toLowerCase(), token1.toLowerCase()].includes(tokenOut.toLowerCase()))) return 0n;
      return readSingleRouterQuote(client, { ...req, router: { ...router, kind: 2, v3FeeTier: fee } });
    }
    if (router.kind === 4) {
      const { i, j } = decodeCurveIndices(router.v3FeeTier ?? 1);
      const abi = parseAbi(['function coins(uint256) view returns (address)']);
      const [coinIn, coinOut] = await Promise.all([i, j].map(index => client.readContract({ address: router.address, abi, functionName: 'coins', args: [BigInt(index)] })));
      if (coinIn.toLowerCase() !== tokenIn.toLowerCase() || coinOut.toLowerCase() !== tokenOut.toLowerCase()) return 0n;
    }
    if ((router.kind === 1 || router.kind === 2) && router.quoterAddress) {
      const res = await client.readContract({
        address: router.quoterAddress,
        abi: v3QuoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn,
            fee: router.v3FeeTier ?? 3000,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      return res[0] ?? 0n;
    }

    if (router.kind === 3 && router.factoryAddress) {
      const amounts = await client.readContract({
        address: router.address,
        abi: aeroRouterAbi,
        functionName: 'getAmountsOut',
        args: [
          amountIn,
          [
            {
              from: tokenIn,
              to: tokenOut,
              stable: Boolean(router.aeroStable),
              factory: router.factoryAddress,
            },
          ],
        ],
      });
      return amounts[amounts.length - 1] ?? 0n;
    }

    if (router.kind === 4) {
      const { i, j } = decodeCurveIndices(router.v3FeeTier ?? 1);
      return await client.readContract({
        address: router.address,
        abi: curvePoolAbi,
        functionName: 'get_dy',
        args: [BigInt(i), BigInt(j), amountIn],
      });
    }

    const amounts = await client.readContract({
      address: router.address,
      abi: v2RouterAbi,
      functionName: 'getAmountsOut',
      args: [amountIn, [tokenIn, tokenOut]],
    });
    return amounts[amounts.length - 1] ?? 0n;
  } catch {
    return 0n;
  }
}

async function batchReadMultiDexQuotes(
  client: PublicClient,
  calls: QuoteCallRequest[],
): Promise<bigint[]> {
  if (calls.length === 0) return [];
  if (calls.some(c => c.router.kind === 4 || c.router.kind === 5)) {
    const normal = calls.filter(c => c.router.kind !== 4 && c.router.kind !== 5);
    const outputs = await batchReadMultiDexQuotes(client, normal);
    let index = 0;
    const result: bigint[] = [];
    for (const call of calls) result.push(call.router.kind === 4 || call.router.kind === 5
      ? await readSingleRouterQuote(client, call) : outputs[index++]);
    return result;
  }
  try {
    const contracts = calls.map((req) => {
      const { router, amountIn, tokenIn, tokenOut } = req;
      if ((router.kind === 1 || router.kind === 2) && router.quoterAddress) {
        return {
          address: router.quoterAddress,
          abi: v3QuoterV2Abi,
          functionName: 'quoteExactInputSingle' as const,
          args: [
            {
              tokenIn,
              tokenOut,
              amountIn,
              fee: router.v3FeeTier ?? 3000,
              sqrtPriceLimitX96: 0n,
            },
          ] as const,
        };
      }
      if (router.kind === 3 && router.factoryAddress) {
        return {
          address: router.address,
          abi: aeroRouterAbi,
          functionName: 'getAmountsOut' as const,
          args: [
            amountIn,
            [
              {
                from: tokenIn,
                to: tokenOut,
                stable: Boolean(router.aeroStable),
                factory: router.factoryAddress,
              },
            ],
          ] as const,
        };
      }
      if (router.kind === 4) {
        const { i, j } = decodeCurveIndices(router.v3FeeTier ?? 1);
        return {
          address: router.address,
          abi: curvePoolAbi,
          functionName: 'get_dy' as const,
          args: [BigInt(i), BigInt(j), amountIn] as const,
        };
      }
      return {
        address: router.address,
        abi: v2RouterAbi,
        functionName: 'getAmountsOut' as const,
        args: [amountIn, [tokenIn, tokenOut]] as const,
      };
    });

    const results = await client.multicall({
      allowFailure: true,
      batchSize: 2_048,
      multicallAddress: MULTICALL3,
      contracts,
    });

    return results.map((res, idx) => {
      if (res.status !== 'success' || !res.result) return 0n;
      const kind = calls[idx].router.kind;
      if (kind === 1 || kind === 2) {
        const tuple = res.result as readonly [bigint, bigint, number, bigint];
        return tuple[0] ?? 0n;
      }
      if (kind === 4) {
        return BigInt(res.result as bigint);
      }
      const arr = res.result as readonly bigint[];
      return arr[arr.length - 1] ?? 0n;
    });
  } catch {
    const output: bigint[] = [];
    for (const call of calls) {
      output.push(await readSingleRouterQuote(client, call));
    }
    return output;
  }
}

export async function scanChainOpportunities(
  options: OpportunityScanOptions,
): Promise<ChainOpportunityReport> {
  const warnings: string[] = [];
  const arbLoanUsd = options.arbLoanUsd ?? 10_000;
  // 5-Point Golden-Section / Liquidity Curve Sampling Grid
  const loanSizeTiersUsd = options.loanSizeTiersUsd ?? [
    Math.max(500, Math.round(arbLoanUsd * 0.15)),
    Math.max(1_000, Math.round(arbLoanUsd * 0.45)),
    arbLoanUsd,
    Math.round(arbLoanUsd * 1.85),
    Math.round(arbLoanUsd * 3.0),
  ];
  const minProfitUsd = options.minProfitUsd ?? 5;
  const maxSlippageBps = options.maxSlippageBps ?? 30;
  const maxAssetsToPair = options.maxAssetsToPair ?? 6;
  const enableTriangularArb = options.enableTriangularArb ?? (process.env.TRIANGULAR_ARB_ENABLED !== 'false');

  const client = createPublicClient({
    transport: http(options.rpcUrl, {
      batch: { batchSize: 5 },
      retryCount: 1,
      timeout: REQUEST_TIMEOUT_MS,
    }),
  });

  const [blockNumber, gasPriceWei] = await Promise.all([
    client.getBlockNumber(),
    client.getGasPrice().catch(() => 1_000_000_000n),
  ]);

  const nativePriceUsd = inferNativePriceUsd(options.chain, options.assets);
  const gasCostNative = Number(formatUnits(gasPriceWei * ESTIMATED_ARB_GAS_UNITS, 18));
  const estimatedGasCostUsd = gasCostNative * nativePriceUsd;

  const eligibleAssets = options.assets.filter((asset) => asset.eligible);
  const targetSymbols = new Set(
    (options.targetWhitelistSymbols ?? []).map((sym) => sym.trim().toUpperCase()).filter(Boolean),
  );

  let flashExecutor: Address | undefined;
  let flashExecutorOwner: Address | undefined;
  let flashExecutorPaused: boolean | undefined;
  const flashAllowedMap = new Map<string, boolean>();

  if (options.flashExecutor) {
    try {
      const normalized = getAddress(options.flashExecutor) as Address;
      const code = await client.getBytecode({ address: normalized });
      if (code && code !== '0x') {
        flashExecutor = normalized;
        const [owner, paused] = await Promise.all([
          client.readContract({ address: normalized, abi: flashLoanExecutorAbi, functionName: 'owner' }),
          client.readContract({ address: normalized, abi: flashLoanExecutorAbi, functionName: 'paused' }).catch(() => false),
        ]);
        flashExecutorOwner = getAddress(owner) as Address;
        flashExecutorPaused = paused;

        await Promise.all(
          eligibleAssets.map(async (asset) => {
            try {
              const allowed = await client.readContract({
                address: normalized,
                abi: flashLoanExecutorAbi,
                functionName: 'allowedToken',
                args: [asset.address],
              });
              flashAllowedMap.set(asset.address.toLowerCase(), Boolean(allowed));
            } catch {
              flashAllowedMap.set(asset.address.toLowerCase(), false);
            }
          }),
        );
      }
    } catch (error) {
      warnings.push(`Gagal memeriksa FlashLoanExecutor: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let arbExecutor: Address | undefined;
  let arbExecutorOwner: Address | undefined;
  let arbExecutorPaused: boolean | undefined;
  const arbAllowedTokenMap = new Map<string, boolean>();
  const arbAllowedRouterMap = new Map<string, boolean>();

  if (options.arbExecutor) {
    try {
      const normalized = getAddress(options.arbExecutor) as Address;
      const code = await client.getBytecode({ address: normalized });
      if (code && code !== '0x') {
        arbExecutor = normalized;
        const [owner, paused] = await Promise.all([
          client.readContract({ address: normalized, abi: arbExecutorAbi, functionName: 'owner' }),
          client.readContract({ address: normalized, abi: arbExecutorAbi, functionName: 'paused' }).catch(() => false),
        ]);
        arbExecutorOwner = getAddress(owner) as Address;
        arbExecutorPaused = paused;

        await Promise.all(
          eligibleAssets.map(async (asset) => {
            try {
              const allowed = await client.readContract({
                address: normalized,
                abi: arbExecutorAbi,
                functionName: 'allowedToken',
                args: [asset.address],
              });
              arbAllowedTokenMap.set(asset.address.toLowerCase(), Boolean(allowed));
            } catch {
              arbAllowedTokenMap.set(asset.address.toLowerCase(), false);
            }
          }),
        );
      }
    } catch (error) {
      warnings.push(`Gagal memeriksa MorphoAtomicArbPOC: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const configuredRouters = getRoutersForChain(options.chain.key, options.extraRouters);
  const routerWhitelists: RouterWhitelistState[] = [];

  for (const router of configuredRouters) {
    let hasBytecode = false;
    let allowedOnArb = false;
    try {
      const code = await client.getBytecode({ address: router.address });
      hasBytecode = Boolean(code && code !== '0x');
      if (arbExecutor && hasBytecode) {
        allowedOnArb = Boolean(
          await client.readContract({
            address: arbExecutor,
            abi: arbExecutorAbi,
            functionName: 'allowedRouter',
            args: [router.address],
          }),
        );
      }
    } catch {
      hasBytecode = false;
    }
    arbAllowedRouterMap.set(router.address.toLowerCase(), allowedOnArb);
    routerWhitelists.push({
      name: router.name,
      address: router.address,
      protocol: router.protocol,
      kind: router.kind,
      feeBps: router.feeBps,
      hasBytecode,
      allowedOnArbExecutor: allowedOnArb,
      needsArbWhitelist: Boolean(arbExecutor && hasBytecode && !allowedOnArb),
    });
  }

  const tokenWhitelists: TokenWhitelistState[] = eligibleAssets.map((asset) => {
    const key = asset.address.toLowerCase();
    const allowedFlash = flashAllowedMap.get(key) ?? false;
    const allowedArb = arbAllowedTokenMap.get(key) ?? false;
    const matchesTarget = targetSymbols.size === 0
      || targetSymbols.has('ALL')
      || targetSymbols.has(asset.symbol.toUpperCase())
      || targetSymbols.has(asset.address.toUpperCase());

    return {
      symbol: asset.symbol,
      address: asset.address,
      decimals: asset.decimals,
      usdValue: asset.usdValue,
      priceUsd: asset.priceUsd,
      balance: asset.balance,
      formattedBalance: asset.formattedBalance,
      allowedOnFlashExecutor: allowedFlash,
      allowedOnArbExecutor: allowedArb,
      matchesPolicyTarget: matchesTarget,
      needsFlashWhitelist: Boolean(flashExecutor && matchesTarget && !allowedFlash),
      needsArbWhitelist: Boolean(arbExecutor && matchesTarget && !allowedArb),
    };
  });

  const whitelistedAssets = tokenWhitelists.filter(
    (item) => item.allowedOnFlashExecutor || item.allowedOnArbExecutor,
  );
  const pendingWhitelistAssets = tokenWhitelists.filter(
    (item) => item.needsFlashWhitelist || item.needsArbWhitelist,
  );
  const pendingWhitelistRouters = routerWhitelists.filter((item) => item.needsArbWhitelist);

  // Scan Multi-DEX (V2 + V3 + Aerodrome + Curve) arbitrage quotes across 5-point Golden-Section loan tiers
  const activeRouters = configuredRouters.filter((_, idx) => routerWhitelists[idx]?.hasBytecode);
  const topAssets = eligibleAssets.slice(0, maxAssetsToPair);
  const allTierCandidates: ArbitrageCandidate[] = [];

  if (activeRouters.length >= 2 && topAssets.length >= 2) {
    type FirstLegTask = {
      loanAsset: ScannedAsset;
      intermediateAsset: ScannedAsset;
      firstRouter: DexRouterConfig;
      loanAmount: bigint;
      loanAmountUsd: number;
    };

    const firstLegTasks: FirstLegTask[] = [];
    for (const loanAsset of topAssets) {
      const seenAmounts = new Set<string>();
      for (const tierUsd of loanSizeTiersUsd) {
        const { amount: loanAmount, actualUsd: loanAmountUsd } = computeLoanAmountForUsd(
          loanAsset,
          tierUsd,
        );
        if (loanAmount <= 0n || seenAmounts.has(loanAmount.toString())) continue;
        seenAmounts.add(loanAmount.toString());

        for (const intermediateAsset of topAssets) {
          if (loanAsset.address.toLowerCase() === intermediateAsset.address.toLowerCase()) continue;
          for (const firstRouter of activeRouters) {
            firstLegTasks.push({
              loanAsset,
              intermediateAsset,
              firstRouter,
              loanAmount,
              loanAmountUsd,
            });
          }
        }
      }
    }

    const firstLegOutputs = await batchReadMultiDexQuotes(
      client,
      firstLegTasks.map((task) => ({
        router: task.firstRouter,
        amountIn: task.loanAmount,
        tokenIn: task.loanAsset.address,
        tokenOut: task.intermediateAsset.address,
      })),
    );

    type SecondLegTask = FirstLegTask & {
      intermediateOut: bigint;
      secondRouter: DexRouterConfig;
    };

    const secondLegTasks: SecondLegTask[] = [];
    for (let i = 0; i < firstLegTasks.length; i++) {
      const intermediateOut = firstLegOutputs[i] ?? 0n;
      if (intermediateOut <= 0n) continue;
      const task = firstLegTasks[i];
      for (const secondRouter of activeRouters) {
        const sameVenue =
          secondRouter.address.toLowerCase() === task.firstRouter.address.toLowerCase() &&
          (secondRouter.v3FeeTier ?? 0) === (task.firstRouter.v3FeeTier ?? 0) &&
          Boolean(secondRouter.aeroStable) === Boolean(task.firstRouter.aeroStable);
        if (sameVenue) continue;
        secondLegTasks.push({
          ...task,
          intermediateOut,
          secondRouter,
        });
      }
    }

    const secondLegOutputs = await batchReadMultiDexQuotes(
      client,
      secondLegTasks.map((task) => ({
        router: task.secondRouter,
        amountIn: task.intermediateOut,
        tokenIn: task.intermediateAsset.address,
        tokenOut: task.loanAsset.address,
      })),
    );

    for (let i = 0; i < secondLegTasks.length; i++) {
      const finalOut = secondLegOutputs[i] ?? 0n;
      if (finalOut <= 0n) continue;
      const task = secondLegTasks[i];
      const tokensWhitelistedOnArb = Boolean(
        arbAllowedTokenMap.get(task.loanAsset.address.toLowerCase()) &&
        arbAllowedTokenMap.get(task.intermediateAsset.address.toLowerCase()),
      );
      const routersWhitelistedOnArb = Boolean(
        arbAllowedRouterMap.get(task.firstRouter.address.toLowerCase()) &&
        arbAllowedRouterMap.get(task.secondRouter.address.toLowerCase()),
      );

      allTierCandidates.push(
        evaluateArbitrageQuote({
          chainKey: options.chain.key,
          loanAsset: task.loanAsset,
          intermediateAsset: task.intermediateAsset,
          firstRouter: task.firstRouter,
          secondRouter: task.secondRouter,
          loanAmount: task.loanAmount,
          loanAmountUsd: task.loanAmountUsd,
          intermediateOut: task.intermediateOut,
          finalOut,
          gasCostUsd: estimatedGasCostUsd,
          minProfitUsd,
          maxSlippageBps,
          tokensWhitelistedOnArb,
          routersWhitelistedOnArb,
        }),
      );
    }

    // Scan 3-Hop Triangular Arbitrage (Token A -> Token B -> Token C -> Token A)
    if (enableTriangularArb && topAssets.length >= 3) {
      const triAssets = topAssets.slice(0, 4);
      const bestRouter = activeRouters[0];
      const altRouter = activeRouters[1] ?? activeRouters[0];
      const triRouters = [bestRouter, altRouter, bestRouter];

      type TriStep1 = {
        loanAsset: ScannedAsset;
        assetB: ScannedAsset;
        assetC: ScannedAsset;
        loanAmount: bigint;
        loanAmountUsd: number;
      };
      const triTasks: TriStep1[] = [];
      for (const loanAsset of triAssets.slice(0, 2)) {
        const { amount: loanAmount, actualUsd: loanAmountUsd } = computeLoanAmountForUsd(
          loanAsset,
          arbLoanUsd,
        );
        if (loanAmount <= 0n) continue;
        for (const assetB of triAssets) {
          if (assetB.address.toLowerCase() === loanAsset.address.toLowerCase()) continue;
          for (const assetC of triAssets) {
            if (
              assetC.address.toLowerCase() === loanAsset.address.toLowerCase() ||
              assetC.address.toLowerCase() === assetB.address.toLowerCase()
            ) {
              continue;
            }
            triTasks.push({ loanAsset, assetB, assetC, loanAmount, loanAmountUsd });
          }
        }
      }

      if (triTasks.length > 0) {
        const hop1Out = await batchReadMultiDexQuotes(
          client,
          triTasks.map((t) => ({
            router: triRouters[0],
            amountIn: t.loanAmount,
            tokenIn: t.loanAsset.address,
            tokenOut: t.assetB.address,
          })),
        );

        const validHop1 = triTasks
          .map((t, idx) => ({ ...t, out1: hop1Out[idx] ?? 0n }))
          .filter((t) => t.out1 > 0n);

        const hop2Out = await batchReadMultiDexQuotes(
          client,
          validHop1.map((t) => ({
            router: triRouters[1],
            amountIn: t.out1,
            tokenIn: t.assetB.address,
            tokenOut: t.assetC.address,
          })),
        );

        const validHop2 = validHop1
          .map((t, idx) => ({ ...t, out2: hop2Out[idx] ?? 0n }))
          .filter((t) => t.out2 > 0n);

        const hop3Out = await batchReadMultiDexQuotes(
          client,
          validHop2.map((t) => ({
            router: triRouters[2],
            amountIn: t.out2,
            tokenIn: t.assetC.address,
            tokenOut: t.loanAsset.address,
          })),
        );

        for (let i = 0; i < validHop2.length; i++) {
          const out3 = hop3Out[i] ?? 0n;
          if (out3 <= 0n) continue;
          const t = validHop2[i];
          const tokensWhitelisted = Boolean(
            arbAllowedTokenMap.get(t.loanAsset.address.toLowerCase()) &&
            arbAllowedTokenMap.get(t.assetB.address.toLowerCase()) &&
            arbAllowedTokenMap.get(t.assetC.address.toLowerCase()),
          );
          const routersWhitelisted = triRouters.every((r) =>
            Boolean(arbAllowedRouterMap.get(r.address.toLowerCase())),
          );

          allTierCandidates.push(
            evaluateMultiHopArbitrageQuote({
              chainKey: options.chain.key,
              loanAsset: t.loanAsset,
              intermediateAssets: [t.assetB, t.assetC],
              routers: triRouters,
              loanAmount: t.loanAmount,
              loanAmountUsd: t.loanAmountUsd,
              hopOutputs: [t.out1, t.out2, out3],
              gasCostUsd: estimatedGasCostUsd,
              minProfitUsd,
              maxSlippageBps,
              tokensWhitelistedOnArb: tokensWhitelisted,
              routersWhitelistedOnArb: routersWhitelisted,
            }),
          );
        }
      }
    }
  }

  // Group by route pair and pick the optimal loan size tier + parabolic interpolation
  const byRouteKey = new Map<string, ArbitrageCandidate[]>();
  for (const cand of allTierCandidates) {
    const routeKey = arbitrageRouteKey(options.chain.key, cand.loanToken, cand.steps ?? []);
    const list = byRouteKey.get(routeKey) ?? [];
    list.push(cand);
    byRouteKey.set(routeKey, list);
  }

  const arbitrageCandidates: ArbitrageCandidate[] = [];
  for (const group of byRouteKey.values()) {
    const optimal = selectOptimalArbitrageTier(group);
    if (optimal) arbitrageCandidates.push(optimal);
  }
  arbitrageCandidates.sort((a, b) => b.netProfitUsd - a.netProfitUsd || b.spreadBps - a.spreadBps);

  const profitableCandidates = arbitrageCandidates.filter((item) => item.profitable);

  // Scan Morpho Blue Liquidations (GraphQL + On-Chain Indexer + Pre-Liquidation Watchlist)
  const liquidationScan = await scanMorphoLiquidations({
    chain: options.chain,
    rpcUrl: options.rpcUrl,
    routers: activeRouters,
    assets: options.assets,
    gasCostUsd: estimatedGasCostUsd,
    minProfitUsd,
    maxSlippageBps,
  });
  const liquidationCandidates = liquidationScan.candidates;
  warnings.push(...liquidationScan.warnings);
  const profitableLiquidations = liquidationCandidates.filter((item) => item.profitable);

  return {
    chain: options.chain,
    blockNumber,
    gasPriceWei,
    gasPriceGwei: formatGwei(gasPriceWei),
    nativePriceUsd,
    flashExecutor,
    flashExecutorOwner,
    flashExecutorPaused,
    arbExecutor,
    arbExecutorOwner,
    arbExecutorPaused,
    tokenWhitelists,
    routerWhitelists,
    whitelistedAssets,
    pendingWhitelistAssets,
    pendingWhitelistRouters,
    arbitrageCandidates,
    profitableCandidates,
    liquidationCandidates,
    profitableLiquidations,
    warnings,
  };
}

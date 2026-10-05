import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  parseAbiItem,
  parseAbi,
  type PublicClient,
  parseUnits,
} from 'viem';
import type { EvmChainConfig } from '../config/chains.js';
import type { DexRouterConfig } from '../config/dex-routers.js';
import { morphoForChain, type Address } from '../config/registry.js';
import type { ScannedAsset } from './scanner.js';
import { applySlippageBps, readSingleRouterQuote } from './dex-scanner.js';



const MORPHO_APIS = [
  'https://blue-api.morpho.org/graphql',
  'https://api.morpho.org/graphql',
];
const REQUEST_TIMEOUT_MS = 10_000;
const WAD = 10n ** 18n;
const MAX_LIF_BPS = 11_500; // 1.15x max liquidation incentive in Morpho Blue
const LIF_CURSOR = 0.3;

export type MorphoMarketParamsConfig = {
  marketId: `0x${string}`;
  loanToken: Address;
  loanSymbol: string;
  loanDecimals: number;
  loanPriceUsd: number;
  collateralToken: Address;
  collateralSymbol: string;
  collateralDecimals: number;
  collateralPriceUsd: number;
  oracle: Address;
  irm: Address;
  lltv: bigint;
};

export type MorphoBorrowerWatchlistEntry = {
  key: string;
  chain: string;
  borrower: Address;
  marketId: `0x${string}`;
  loanSymbol: string;
  collateralSymbol: string;
  borrowUsd: number;
  collateralUsd: number;
  healthFactor: number;
  status: 'liquidatable' | 'critical' | 'at-risk';
  source: 'graphql-indexer' | 'onchain-events' | 'manual';
  updatedAt: string;
  marketParams: MorphoMarketParamsConfig;
};

export type LiquidationCandidate = {
  id: string;
  chain: string;
  marketParams: MorphoMarketParamsConfig;
  borrower: Address;
  healthFactor: number;
  seizedAssets: bigint;
  formattedSeizedAssets: string;
  repaidAssets: bigint;
  formattedRepaidAssets: string;
  repaidUsd: number;
  incentiveBps: number;
  swapRouter: DexRouterConfig;
  expectedLoanTokenOut: bigint;
  minLoanTokenOut: bigint;
  grossProfit: bigint;
  formattedGrossProfit: string;
  grossProfitUsd: number;
  estimatedGasCostUsd: number;
  netProfitUsd: number;
  minProfit: bigint;
  profitable: boolean;
};

const watchlistMemory = new Map<string, MorphoBorrowerWatchlistEntry>();

export function upsertWatchlistEntry(entry: MorphoBorrowerWatchlistEntry): void {
  watchlistMemory.set(entry.key, entry);
}

export function getAtRiskWatchlist(chainKey?: string): MorphoBorrowerWatchlistEntry[] {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [key, entry] of watchlistMemory) {
    if (!Number.isFinite(Date.parse(entry.updatedAt)) || Date.parse(entry.updatedAt) < cutoff) watchlistMemory.delete(key);
  }
  const all = [...watchlistMemory.values()];
  const filtered = chainKey ? all.filter((item) => item.chain === chainKey) : all;
  return filtered.sort((a, b) => a.healthFactor - b.healthFactor || b.borrowUsd - a.borrowUsd);
}

export function clearWatchlistMemory(): void {
  watchlistMemory.clear();
}

export async function persistWatchlistToDisk(): Promise<void> {
  try {
    const filePath = resolve(process.cwd(), 'logs', 'morpho-watchlist.json');
    await mkdir(dirname(filePath), { recursive: true });
    const serialized = JSON.stringify(
      getAtRiskWatchlist(),
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    );
    await writeFile(filePath, serialized, 'utf8');
  } catch {
    // Non-fatal in read-only or ephemeral environments
  }
}

export async function loadWatchlistFromDisk(): Promise<MorphoBorrowerWatchlistEntry[]> {
  try {
    const filePath = resolve(process.cwd(), 'logs', 'morpho-watchlist.json');
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Array<
      Omit<MorphoBorrowerWatchlistEntry, 'marketParams'> & {
        marketParams: Omit<MorphoBorrowerWatchlistEntry['marketParams'], 'lltv'> & { lltv: string };
      }
    >;
    for (const item of parsed) {
      upsertWatchlistEntry({
        ...item,
        marketParams: {
          ...item.marketParams,
          lltv: BigInt(item.marketParams.lltv),
        },
      });
    }
    return getAtRiskWatchlist();
  } catch {
    return [];
  }
}

/**
 * Exact Morpho Blue Liquidation Incentive Factor (LIF) in basis points (10000 = 1.00x).
 * Formula: min(1.15, 1 / (1 - cursor * (1 - lltv)))
 */
export function computeLiquidationIncentiveBps(lltv: bigint): number {
  const lltvFloat = Number(lltv) / Number(WAD);
  if (!Number.isFinite(lltvFloat) || lltvFloat <= 0 || lltvFloat >= 1) {
    return 10_400;
  }
  const denominator = 1 - LIF_CURSOR * (1 - lltvFloat);
  if (denominator <= 0) return MAX_LIF_BPS;
  const lif = 1 / denominator;
  return Math.min(MAX_LIF_BPS, Math.round(lif * 10_000));
}

export function classifyHealthFactorStatus(
  healthFactor: number,
): 'liquidatable' | 'critical' | 'at-risk' | 'healthy' {
  if (healthFactor < 1.0) return 'liquidatable';
  if (healthFactor <= 1.03) return 'critical';
  if (healthFactor <= 1.12) return 'at-risk';
  return 'healthy';
}

export function evaluateLiquidationCandidate(params: {
  chainKey: string;
  market: MorphoMarketParamsConfig;
  borrower: Address;
  borrowUsd: number;
  collateralUsd: number;
  swapRouter: DexRouterConfig;
  gasCostUsd: number;
  minProfitUsd: number;
  maxSlippageBps: number;
}): LiquidationCandidate | null {
  const {
    chainKey,
    market,
    borrower,
    borrowUsd,
    collateralUsd,
    swapRouter,
    gasCostUsd,
    minProfitUsd,
    maxSlippageBps,
  } = params;

  const watchKey = `${chainKey}:${market.marketId}:${borrower.toLowerCase()}`;
  if (borrowUsd <= 0 || collateralUsd <= 0) { watchlistMemory.delete(watchKey); return null; }
  const lltvRatio = Number(market.lltv) / Number(WAD);
  const maxBorrowUsd = collateralUsd * lltvRatio;
  const healthFactor = maxBorrowUsd / borrowUsd;

  const status = classifyHealthFactorStatus(healthFactor);
  if (status === 'healthy') watchlistMemory.delete(watchKey);
  if (status !== 'healthy') {
    upsertWatchlistEntry({
      key: `${chainKey}:${market.marketId}:${borrower.toLowerCase()}`,
      chain: chainKey,
      borrower,
      marketId: market.marketId,
      loanSymbol: market.loanSymbol,
      collateralSymbol: market.collateralSymbol,
      borrowUsd,
      collateralUsd,
      healthFactor: Number(healthFactor.toFixed(4)),
      status,
      source: 'graphql-indexer',
      updatedAt: new Date().toISOString(),
      marketParams: market,
    });
  }

  if (healthFactor >= 1.0) return null;

  const incentiveBps = computeLiquidationIncentiveBps(market.lltv);
  // Liquidate up to 50% of debt or available collateral covered by LIF
  const maxRepayByCollateralUsd = collateralUsd / (incentiveBps / 10_000);
  const targetRepayUsd = Math.min(borrowUsd * 0.5, maxRepayByCollateralUsd);
  if (targetRepayUsd <= 10) return null;

  const seizedUsd = targetRepayUsd * (incentiveBps / 10_000);
  const swapFeeMultiplier = (10_000 - swapRouter.feeBps) / 10_000;
  const expectedOutUsd = seizedUsd * swapFeeMultiplier;
  const grossProfitUsd = Math.max(0, expectedOutUsd - targetRepayUsd);
  const netProfitUsd = grossProfitUsd - gasCostUsd;

  const repayTokensFloat = targetRepayUsd / Math.max(0.000001, market.loanPriceUsd);
  const seizedTokensFloat = seizedUsd / Math.max(0.000001, market.collateralPriceUsd);
  const outTokensFloat = expectedOutUsd / Math.max(0.000001, market.loanPriceUsd);

  const repaidAssets = parseUnits(
    repayTokensFloat.toFixed(Math.min(market.loanDecimals, 6)) || '1',
    market.loanDecimals,
  );
  const seizedAssets = parseUnits(
    seizedTokensFloat.toFixed(Math.min(market.collateralDecimals, 6)) || '1',
    market.collateralDecimals,
  );
  const expectedLoanTokenOut = parseUnits(
    outTokensFloat.toFixed(Math.min(market.loanDecimals, 6)) || '1',
    market.loanDecimals,
  );

  const grossProfit =
    expectedLoanTokenOut > repaidAssets ? expectedLoanTokenOut - repaidAssets : 0n;
  const minLoanTokenOut = applySlippageBps(expectedLoanTokenOut, maxSlippageBps);

  const requiredProfitUsd = Math.max(0, minProfitUsd + gasCostUsd);
  const requiredProfitTokens = requiredProfitUsd / Math.max(0.000001, market.loanPriceUsd);
  const minProfit = parseUnits(
    requiredProfitTokens.toFixed(Math.min(market.loanDecimals, 6)) || '1',
    market.loanDecimals,
  );

  const profitable = grossProfit >= minProfit && netProfitUsd >= minProfitUsd;

  return {
    id: `liq:${chainKey}:${market.marketId.toLowerCase()}:${borrower.toLowerCase()}`,
    chain: chainKey,
    marketParams: market,
    borrower,
    healthFactor: Number(healthFactor.toFixed(4)),
    seizedAssets,
    formattedSeizedAssets: formatUnits(seizedAssets, market.collateralDecimals),
    repaidAssets,
    formattedRepaidAssets: formatUnits(repaidAssets, market.loanDecimals),
    repaidUsd: targetRepayUsd,
    incentiveBps,
    swapRouter,
    expectedLoanTokenOut,
    minLoanTokenOut,
    grossProfit,
    formattedGrossProfit: formatUnits(grossProfit, market.loanDecimals),
    grossProfitUsd,
    estimatedGasCostUsd: gasCostUsd,
    netProfitUsd,
    minProfit,
    profitable,
  };
}

const liquidationPositionsQuery = `
  query ScanLiquidatableAndAtRiskPositions($chainId: Int!) {
    marketPositions(
      first: 100
      where: { chainId_in: [$chainId], healthFactor_lte: 1.12, borrowAssetsUsd_gte: 100 }
    ) {
      items {
        healthFactor
        borrowAssetsUsd
        collateralUsd
        user { address }
        market {
          uniqueKey
          lltv
          oracleAddress
          irmAddress
          loanAsset { address symbol decimals priceUsd }
          collateralAsset { address symbol decimals priceUsd }
        }
      }
    }
  }
`;

const borrowEventAbi = parseAbiItem(
  'event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)',
);

/**
 * Discovers recent active borrowers directly from on-chain Morpho Blue `Borrow` event logs.
 */
export async function discoverOnChainMorphoBorrowers(params: {
  chain: EvmChainConfig;
  rpcUrl: string;
  blockLookback?: bigint;
}): Promise<Array<{ marketId: `0x${string}`; borrower: Address }>> {
  const { chain, rpcUrl, blockLookback = 250n } = params;
  try {
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 6_000, retryCount: 0 }),
    });
    const head = await client.getBlockNumber();
    const fromBlock = head > blockLookback ? head - blockLookback : 0n;
    const logs = await client.getLogs({
      address: await morphoForChain(chain.key),
      event: borrowEventAbi,
      fromBlock,
      toBlock: head,
    });

    const unique = new Map<string, { marketId: `0x${string}`; borrower: Address }>();
    for (const log of logs) {
      const marketId = log.args.id;
      const borrower = log.args.onBehalf;
      if (!marketId || !borrower) continue;
      const normBorrower = getAddress(borrower) as Address;
      unique.set(`${marketId}:${normBorrower.toLowerCase()}`, {
        marketId,
        borrower: normBorrower,
      });
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

export async function scanMorphoLiquidations(params: {
  chain: EvmChainConfig;
  rpcUrl?: string;
  assets?: ScannedAsset[];
  routers: DexRouterConfig[];
  gasCostUsd: number;
  minProfitUsd: number;
  maxSlippageBps: number;
}): Promise<LiquidationCandidate[]> {
  const { chain, rpcUrl, routers, gasCostUsd, minProfitUsd, maxSlippageBps } = params;
  if (routers.length === 0) return [];
  // Pick the lowest-fee router for collateral liquidation swap
  const sortedRouters = [...routers].sort((a, b) => a.feeBps - b.feeBps);
  const bestRouter = sortedRouters[0];

  const candidates: LiquidationCandidate[] = [];
  const discovered = new Map<string, { marketId: `0x${string}`; borrower: Address }>();
  const discover = (marketId: `0x${string}`, borrower: Address) => discovered.set(`${marketId}:${borrower.toLowerCase()}`, { marketId, borrower });

  // 1. Check custom / manual liquidation candidates from MORPHO_LIQUIDATION_CANDIDATES_JSON if configured
  const rawManual = process.env.MORPHO_LIQUIDATION_CANDIDATES_JSON;
  if (rawManual) {
    try {
      const parsed = JSON.parse(rawManual) as Record<
        string,
        Array<{
          borrower: string;
          borrowUsd: number;
          collateralUsd: number;
          market: Omit<MorphoMarketParamsConfig, 'lltv'> & { lltv: string };
        }>
      >;
      for (const item of parsed[chain.key] ?? []) {
        const marketConfig: MorphoMarketParamsConfig = {
          ...item.market,
          loanToken: getAddress(item.market.loanToken) as Address,
          collateralToken: getAddress(item.market.collateralToken) as Address,
          oracle: getAddress(item.market.oracle) as Address,
          irm: getAddress(item.market.irm) as Address,
          lltv: BigInt(item.market.lltv),
        };
        discover(marketConfig.marketId, getAddress(item.borrower) as Address);
      }
    } catch {
      // Ignore malformed manual JSON
    }
  }

  // 2. Query Morpho Blue GraphQL API (Indexes both liquidatable < 1.0 and at-risk 1.00..1.12 positions)
  for (const apiEndpoint of MORPHO_APIS) {
    try {
      const res = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: liquidationPositionsQuery,
          variables: { chainId: chain.chainId },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        data?: {
          marketPositions?: {
            items?: Array<{
              healthFactor?: number;
              borrowAssetsUsd?: number;
              collateralUsd?: number;
              user?: { address?: string };
              market?: {
                uniqueKey?: string;
                lltv?: string;
                oracleAddress?: string;
                irmAddress?: string;
                loanAsset?: { address?: string; symbol?: string; decimals?: number; priceUsd?: number };
                collateralAsset?: { address?: string; symbol?: string; decimals?: number; priceUsd?: number };
              };
            }>;
          };
        };
      };

      const items = body.data?.marketPositions?.items;
      if (!items) continue;

      for (const item of items) {
        const m = item.market;
        if (
          !item.user?.address ||
          !m?.uniqueKey ||
          !m.loanAsset?.address ||
          !m.collateralAsset?.address ||
          !m.oracleAddress ||
          !m.irmAddress
        ) {
          continue;
        }

        const marketConfig: MorphoMarketParamsConfig = {
          marketId: m.uniqueKey as `0x${string}`,
          loanToken: getAddress(m.loanAsset.address) as Address,
          loanSymbol: m.loanAsset.symbol ?? 'LOAN',
          loanDecimals: m.loanAsset.decimals ?? 18,
          loanPriceUsd: m.loanAsset.priceUsd ?? 1,
          collateralToken: getAddress(m.collateralAsset.address) as Address,
          collateralSymbol: m.collateralAsset.symbol ?? 'COLL',
          collateralDecimals: m.collateralAsset.decimals ?? 18,
          collateralPriceUsd: m.collateralAsset.priceUsd ?? 1,
          oracle: getAddress(m.oracleAddress) as Address,
          irm: getAddress(m.irmAddress) as Address,
          lltv: BigInt(m.lltv ?? '860000000000000000'),
        };

        discover(marketConfig.marketId, getAddress(item.user.address) as Address);
      }
      break;
    } catch {
      // Try next GraphQL endpoint
    }
  }

  // 3. Optionally index recent on-chain Borrow events if RPC is provided
  if (rpcUrl && process.env.ONCHAIN_BORROW_INDEXER_ENABLED === 'true') {
    for (const entry of await discoverOnChainMorphoBorrowers({ chain, rpcUrl })) discover(entry.marketId, entry.borrower);
  }

  // Recheck previous borrowers as well, including positions no longer returned by the API.
  for (const entry of getAtRiskWatchlist(chain.key)) discover(entry.marketId, entry.borrower);
  if (rpcUrl) {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: REQUEST_TIMEOUT_MS, retryCount: 0 }) });
    if (await client.getChainId() !== chain.chainId) throw new Error('Liquidation RPC chain mismatch');
    const morpho = await morphoForChain(chain.key);
    for (const entry of discovered.values()) {
      try {
        const candidate = await quoteVerifiedLiquidation({ client, morpho, chainKey: chain.key,
          ...entry, assets: params.assets ?? [], routers, gasCostUsd, minProfitUsd, maxSlippageBps });
        if (candidate) candidates.push(candidate);
      } catch {
        // No verified position / fresh prices / executable quote means no execution candidate.
      }
    }
  }

  // Also persist an empty list after positions recover; never resurrect stale entries on restart.
  {
    await persistWatchlistToDisk();
  }

  candidates.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return candidates;
}

const positionAbi = parseAbi([
  'function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function accrueInterest((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams)',
  'function market(bytes32) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)',
  'function position(bytes32,address) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)',
]);
const oracleAbi = parseAbi(['function price() view returns (uint256)']);
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** Integer rounding matches the seized-assets branch of Morpho Blue liquidate(). */
export function liquidationRepayment(seized: bigint, oraclePrice: bigint, lif: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  const quotedAssets = ceilDiv(ceilDiv(seized * oraclePrice, 10n ** 36n) * WAD, lif);
  const shares = ceilDiv(quotedAssets * (totalShares + 1_000_000n), totalAssets + 1n);
  return ceilDiv(shares * (totalAssets + 1n), totalShares + 1_000_000n);
}

export async function quoteVerifiedLiquidation(params: {
  client: PublicClient; morpho: Address; chainKey: string; marketId: `0x${string}`; borrower: Address;
  assets: ScannedAsset[]; routers: DexRouterConfig[]; gasCostUsd: number; minProfitUsd: number; maxSlippageBps: number;
}): Promise<LiquidationCandidate | null> {
  const { client, morpho, marketId, borrower, chainKey } = params;
  const key = `${chainKey}:${marketId}:${borrower.toLowerCase()}`;
  const [loanToken, collateralToken, oracle, irm, lltv] = await client.readContract({
    address: morpho, abi: positionAbi, functionName: 'idToMarketParams', args: [marketId],
  });
  if (lltv <= 0n || lltv >= WAD) return null;
  const marketParams = { loanToken, collateralToken, oracle, irm, lltv };
  // One eth_call: accrue interest transiently, then read updated debt and oracle in the same state.
  const snapshot = await client.multicall({ allowFailure: false,
    multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11', batchSize: 0,
    contracts: [
      { address: morpho, abi: positionAbi, functionName: 'accrueInterest', args: [marketParams] },
      { address: morpho, abi: positionAbi, functionName: 'market', args: [marketId] },
      { address: morpho, abi: positionAbi, functionName: 'position', args: [marketId, borrower] },
      { address: oracle, abi: oracleAbi, functionName: 'price' },
    ],
  });
  const [, , totalBorrowAssets, totalBorrowShares] = snapshot[1];
  const [, borrowShares, collateral] = snapshot[2];
  const oraclePrice = snapshot[3];
  if (borrowShares === 0n || collateral === 0n) { watchlistMemory.delete(key); return null; }
  if (oraclePrice <= 0n) return null;
  const debt = ceilDiv(borrowShares * (totalBorrowAssets + 1n), totalBorrowShares + 1_000_000n);
  const maxBorrow = (collateral * oraclePrice / (10n ** 36n)) * lltv / WAD;
  const healthFactor = Number(maxBorrow) / Number(debt);
  if (healthFactor > 1.12) { watchlistMemory.delete(key); return null; }
  const freshAsset = (address: Address) => params.assets.find(a => a.address.toLowerCase() === address.toLowerCase()
    && a.priceUsd !== null && Number.isFinite(a.priceUsd) && a.priceUsd > 0 && a.priceTimestamp !== null
    && Date.now() / 1000 - a.priceTimestamp <= 3600 && a.priceTimestamp <= Date.now() / 1000 + 300);
  const loan = freshAsset(loanToken);
  const coll = freshAsset(collateralToken);
  if (!loan || !coll) return null;
  const market: MorphoMarketParamsConfig = { marketId, ...marketParams, loanSymbol: loan.symbol,
    loanDecimals: loan.decimals, loanPriceUsd: loan.priceUsd!, collateralSymbol: coll.symbol,
    collateralDecimals: coll.decimals, collateralPriceUsd: coll.priceUsd! };
  upsertWatchlistEntry({ key, chain: chainKey, borrower, marketId, loanSymbol: loan.symbol,
    collateralSymbol: coll.symbol, borrowUsd: Number(formatUnits(debt, loan.decimals)) * loan.priceUsd!,
    collateralUsd: Number(formatUnits(collateral, coll.decimals)) * coll.priceUsd!, healthFactor,
    status: classifyHealthFactorStatus(healthFactor) as 'liquidatable' | 'critical' | 'at-risk',
    source: 'onchain-events', updatedAt: new Date().toISOString(), marketParams: market });
  if (maxBorrow >= debt) return null;
  const rawLif = WAD * WAD / (WAD - (3n * 10n ** 17n) * (WAD - lltv) / WAD);
  const lif = rawLif < 115n * 10n ** 16n ? rawLif : 115n * 10n ** 16n;
  const halfDebtSeizure = (debt / 2n) * lif / WAD * (10n ** 36n) / oraclePrice;
  const seizedAssets = halfDebtSeizure < collateral ? halfDebtSeizure : collateral;
  if (seizedAssets === 0n) return null;
  const repaidAssets = liquidationRepayment(seizedAssets, oraclePrice, lif, totalBorrowAssets, totalBorrowShares);
  let best: { router: DexRouterConfig; output: bigint } | undefined;
  for (const router of params.routers) {
    const output = await readSingleRouterQuote(client, { router, amountIn: seizedAssets, tokenIn: collateralToken, tokenOut: loanToken });
    if (output > (best?.output ?? 0n)) best = { router, output };
  }
  if (!best) return null;
  const grossProfit = best.output - repaidAssets;
  const grossProfitUsd = Number(formatUnits(grossProfit, loan.decimals)) * loan.priceUsd!;
  const minProfit = parseUnits(((params.minProfitUsd + params.gasCostUsd) / loan.priceUsd!).toFixed(loan.decimals), loan.decimals) + 1n;
  const requiredOut = repaidAssets + minProfit;
  const slippageOut = applySlippageBps(best.output, params.maxSlippageBps);
  return { id: `liq:${chainKey}:${marketId.toLowerCase()}:${borrower.toLowerCase()}`, chain: chainKey,
    marketParams: market, borrower, healthFactor, seizedAssets, formattedSeizedAssets: formatUnits(seizedAssets, coll.decimals),
    repaidAssets, formattedRepaidAssets: formatUnits(repaidAssets, loan.decimals),
    repaidUsd: Number(formatUnits(repaidAssets, loan.decimals)) * loan.priceUsd!, incentiveBps: Number(lif * 10000n / WAD),
    swapRouter: best.router, expectedLoanTokenOut: best.output, minLoanTokenOut: slippageOut > requiredOut ? slippageOut : requiredOut,
    grossProfit, formattedGrossProfit: formatUnits(grossProfit, loan.decimals), grossProfitUsd,
    estimatedGasCostUsd: params.gasCostUsd, netProfitUsd: grossProfitUsd - params.gasCostUsd,
    minProfit, profitable: grossProfit >= minProfit && grossProfitUsd - params.gasCostUsd >= params.minProfitUsd };
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  parseAbiItem,
  parseUnits,
} from 'viem';
import type { EvmChainConfig } from '../config/chains.js';
import { deploymentFor, loadDeployments } from '../config/registry.js';
import type { DexRouterConfig } from '../config/dex-routers.js';
import type { Address } from '../config/registry.js';
import { applySlippageBps } from './dex-scanner.js';


const MORPHO_APIS = [
  'https://blue-api.morpho.org/graphql',
  'https://api.morpho.org/graphql',
];
const REQUEST_TIMEOUT_MS = 10_000;
const POSITION_PAGE_SIZE = 100;
const DEFAULT_MAX_POSITION_PAGES = 50;
const WAD = 10n ** 18n;

function configuredMaxPositionPages(): number {
  const configured = Number(process.env.MORPHO_LIQUIDATION_MAX_PAGES ?? DEFAULT_MAX_POSITION_PAGES);
  const pages = Math.floor(configured);
  return Number.isFinite(configured) && pages > 0 ? pages : DEFAULT_MAX_POSITION_PAGES;
}
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

function watchlistEntryKey(chainKey: string, marketId: string, borrower: string): string {
  return `${chainKey}:${marketId.toLowerCase()}:${borrower.toLowerCase()}`;
}

export function pruneGraphqlWatchlist(chainKey: string, seenKeys: Set<string>): void {
  for (const [key, entry] of watchlistMemory) {
    if (entry.chain === chainKey && entry.source === 'graphql-indexer' && !seenKeys.has(key)) {
      watchlistMemory.delete(key);
    }
  }
}

export function upsertWatchlistEntry(entry: MorphoBorrowerWatchlistEntry): void {
  watchlistMemory.set(entry.key, entry);
}

export function getAtRiskWatchlist(chainKey?: string): MorphoBorrowerWatchlistEntry[] {
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

  if (borrowUsd <= 0 || collateralUsd <= 0) return null;
  const lltvRatio = Number(market.lltv) / Number(WAD);
  const maxBorrowUsd = collateralUsd * lltvRatio;
  const healthFactor = maxBorrowUsd / borrowUsd;

  const status = classifyHealthFactorStatus(healthFactor);
  if (status !== 'healthy') {
    upsertWatchlistEntry({
      key: watchlistEntryKey(chainKey, market.marketId, borrower),
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
    repayTokensFloat.toFixed(Math.min(market.loanDecimals, 6)).replace(/\.?0+$/, '') || '1',
    market.loanDecimals,
  );
  const seizedAssets = parseUnits(
    seizedTokensFloat.toFixed(Math.min(market.collateralDecimals, 6)).replace(/\.?0+$/, '') || '1',
    market.collateralDecimals,
  );
  const expectedLoanTokenOut = parseUnits(
    outTokensFloat.toFixed(Math.min(market.loanDecimals, 6)).replace(/\.?0+$/, '') || '1',
    market.loanDecimals,
  );

  const grossProfit =
    expectedLoanTokenOut > repaidAssets ? expectedLoanTokenOut - repaidAssets : 0n;
  const minLoanTokenOut = applySlippageBps(expectedLoanTokenOut, maxSlippageBps);

  const requiredProfitUsd = Math.max(0, minProfitUsd + gasCostUsd);
  const requiredProfitTokens = requiredProfitUsd / Math.max(0.000001, market.loanPriceUsd);
  const minProfit = parseUnits(
    requiredProfitTokens.toFixed(Math.min(market.loanDecimals, 6)).replace(/\.?0+$/, '') || '1',
    market.loanDecimals,
  );

  const profitable = grossProfit >= minProfit && netProfitUsd >= minProfitUsd;

  return {
    id: `liq:${chainKey}:${market.collateralSymbol}->${market.loanSymbol}:${borrower.slice(0, 8)}`,
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

type MorphoApiPosition = {
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
};

type MorphoPositionsPageResult = {
  items: MorphoApiPosition[];
  complete: boolean;
};

const liquidationPositionsQuery = `
  query ScanLiquidatableAndAtRiskPositions($chainId: Int!, $first: Int!, $skip: Int!) {
    marketPositions(
      first: $first
      skip: $skip
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

export async function fetchLiquidationPositionPages(
  endpoint: string,
  chainId: number,
): Promise<MorphoPositionsPageResult> {
  const maxPages = configuredMaxPositionPages();
  const items: MorphoApiPosition[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: liquidationPositionsQuery,
        variables: { chainId, first: POSITION_PAGE_SIZE, skip: page * POSITION_PAGE_SIZE },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Morpho API HTTP ${res.status}`);
    const body = await res.json() as {
      errors?: Array<{ message?: string }>;
      data?: { marketPositions?: { items?: MorphoApiPosition[] } };
    };
    if (body.errors?.length) {
      throw new Error(body.errors.map((error) => error.message ?? 'GraphQL error').join('; '));
    }
    const pageItems = body.data?.marketPositions?.items;
    if (!Array.isArray(pageItems)) throw new Error('Morpho API tidak mengembalikan marketPositions.items');
    items.push(...pageItems);
    if (pageItems.length < POSITION_PAGE_SIZE) return { items, complete: true };
  }

  return { items, complete: false };
}

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
    const deployments = await loadDeployments();
    const morphoAddress = deploymentFor(deployments, chain.key)?.morpho;
    if (!morphoAddress) return [];
    const head = await client.getBlockNumber();
    const fromBlock = head > blockLookback ? head - blockLookback : 0n;
    const logs = await client.getLogs({
      address: getAddress(morphoAddress) as Address,
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

export type LiquidationScanResult = {
  candidates: LiquidationCandidate[];
  warnings: string[];
};

export async function scanMorphoLiquidations(params: {
  chain: EvmChainConfig;
  routers: DexRouterConfig[];
  gasCostUsd: number;
  minProfitUsd: number;
  maxSlippageBps: number;
}): Promise<LiquidationScanResult> {
  const { chain, routers, gasCostUsd, minProfitUsd, maxSlippageBps } = params;
  const warnings: string[] = [];
  if (routers.length === 0) {
    warnings.push('Morpho liquidation scan dilewati: tidak ada router DEX dengan quote yang valid pada chain ini.');
    return { candidates: [], warnings };
  }
  // Pick the lowest-fee router for collateral liquidation swap
  const sortedRouters = [...routers].sort((a, b) => a.feeBps - b.feeBps);
  const bestRouter = sortedRouters[0];

  const candidates: LiquidationCandidate[] = [];

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
        const cand = evaluateLiquidationCandidate({
          chainKey: chain.key,
          market: marketConfig,
          borrower: getAddress(item.borrower) as Address,
          borrowUsd: item.borrowUsd,
          collateralUsd: item.collateralUsd,
          swapRouter: bestRouter,
          gasCostUsd,
          minProfitUsd,
          maxSlippageBps,
        });
        if (cand) candidates.push(cand);
      }
    } catch {
      // Ignore malformed manual JSON
    }
  }

  // 2. Query every page of Morpho positions at-risk or currently liquidatable.
  let indexedPositions: MorphoApiPosition[] | undefined;
  let positionSnapshotComplete = false;
  let lastApiError: unknown;
  for (const apiEndpoint of MORPHO_APIS) {
    try {
      const result = await fetchLiquidationPositionPages(apiEndpoint, chain.chainId);
      indexedPositions = result.items;
      positionSnapshotComplete = result.complete;
      break;
    } catch (error) {
      lastApiError = error;
    }
  }

  if (!indexedPositions) {
    warnings.push(
      `Morpho GraphQL liquidation scan gagal: ${lastApiError instanceof Error ? lastApiError.message : String(lastApiError ?? 'API tidak tersedia')}`,
    );
  } else {
    const seenWatchlistKeys = new Set<string>();
    let malformedPositionCount = 0;
    for (const item of indexedPositions) {
      try {
        const market = item.market;
        const borrowerAddress = item.user?.address;
        if (!borrowerAddress || !market?.uniqueKey) {
          malformedPositionCount += 1;
          continue;
        }
        const normalizedBorrower = getAddress(borrowerAddress) as Address;
        seenWatchlistKeys.add(watchlistEntryKey(chain.key, market.uniqueKey, normalizedBorrower));
        if (
          !market.loanAsset?.address ||
          !market.collateralAsset?.address ||
          !market.oracleAddress ||
          !market.irmAddress
        ) {
          malformedPositionCount += 1;
          continue;
        }

        const marketConfig: MorphoMarketParamsConfig = {
          marketId: market.uniqueKey as `0x${string}`,
          loanToken: getAddress(market.loanAsset.address) as Address,
          loanSymbol: market.loanAsset.symbol ?? 'LOAN',
          loanDecimals: market.loanAsset.decimals ?? 18,
          loanPriceUsd: market.loanAsset.priceUsd ?? 1,
          collateralToken: getAddress(market.collateralAsset.address) as Address,
          collateralSymbol: market.collateralAsset.symbol ?? 'COLL',
          collateralDecimals: market.collateralAsset.decimals ?? 18,
          collateralPriceUsd: market.collateralAsset.priceUsd ?? 1,
          oracle: getAddress(market.oracleAddress) as Address,
          irm: getAddress(market.irmAddress) as Address,
          lltv: BigInt(market.lltv ?? '860000000000000000'),
        };

        const candidate = evaluateLiquidationCandidate({
          chainKey: chain.key,
          market: marketConfig,
          borrower: getAddress(borrowerAddress) as Address,
          borrowUsd: item.borrowAssetsUsd ?? 0,
          collateralUsd: item.collateralUsd ?? 0,
          swapRouter: bestRouter,
          gasCostUsd,
          minProfitUsd,
          maxSlippageBps,
        });
        if (candidate) candidates.push(candidate);
      } catch {
        malformedPositionCount += 1;
      }
    }

    if (positionSnapshotComplete && malformedPositionCount === 0) {
      pruneGraphqlWatchlist(chain.key, seenWatchlistKeys);
      await persistWatchlistToDisk();
    } else if (positionSnapshotComplete) {
      warnings.push(
        `Morpho snapshot berisi ${malformedPositionCount} posisi tidak valid; watchlist tidak direkonsiliasi agar entri yang sah tidak terhapus.`,
      );
    } else {
      const maxPages = configuredMaxPositionPages();
      warnings.push(
        `Morpho liquidation scan mencapai batas ${POSITION_PAGE_SIZE * maxPages} posisi; hasil mungkin belum lengkap. Naikkan MORPHO_LIQUIDATION_MAX_PAGES.`,
      );
    }
  }

  if (watchlistMemory.size > 0) {
    await persistWatchlistToDisk();
  }

  candidates.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return { candidates, warnings };
}

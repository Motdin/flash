import assert from 'node:assert/strict';
import test from 'node:test';
import { evmChains } from '../config/chains.js';
import type { Address } from '../config/registry.js';
import {
  clearWatchlistMemory,
  fetchLiquidationPositionPages,
  getAtRiskWatchlist,
  pruneGraphqlWatchlist,
  upsertWatchlistEntry,
  type MorphoBorrowerWatchlistEntry,
} from './liquidation-scanner.js';

const marketId = `0x${'a'.repeat(64)}` as `0x${string}`;
const borrowerA = '0x1111111111111111111111111111111111111111' as Address;
const borrowerB = '0x2222222222222222222222222222222222222222' as Address;

function watchlistEntry(params: {
  key: string;
  chain: string;
  borrower: Address;
  source: MorphoBorrowerWatchlistEntry['source'];
}): MorphoBorrowerWatchlistEntry {
  return {
    ...params,
    marketId,
    loanSymbol: 'USDC',
    collateralSymbol: 'WETH',
    borrowUsd: 8_200,
    collateralUsd: 10_000,
    healthFactor: 1.04,
    status: 'at-risk',
    updatedAt: new Date().toISOString(),
    marketParams: {
      marketId,
      loanToken: '0x3333333333333333333333333333333333333333' as Address,
      loanSymbol: 'USDC',
      loanDecimals: 6,
      loanPriceUsd: 1,
      collateralToken: '0x4444444444444444444444444444444444444444' as Address,
      collateralSymbol: 'WETH',
      collateralDecimals: 18,
      collateralPriceUsd: 2_500,
      oracle: '0x5555555555555555555555555555555555555555' as Address,
      irm: '0x6666666666666666666666666666666666666666' as Address,
      lltv: 860_000_000_000_000_000n,
    },
  };
}

test('liquidation GraphQL scan fetches subsequent pages using skip offsets', async () => {
  const originalFetch = globalThis.fetch;
  const originalMaxPages = process.env.MORPHO_LIQUIDATION_MAX_PAGES;
  process.env.MORPHO_LIQUIDATION_MAX_PAGES = '2';
  const skips: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      variables: { chainId: number; first: number; skip: number };
    };
    skips.push(request.variables.skip);
    assert.equal(request.variables.chainId, evmChains.find((chain) => chain.key === 'base')?.chainId);
    assert.equal(request.variables.first, 100);
    const items = request.variables.skip === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: i })) : [];
    return new Response(JSON.stringify({ data: { marketPositions: { items } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await fetchLiquidationPositionPages(
      'https://morpho.test/graphql',
      evmChains.find((chain) => chain.key === 'base')!.chainId,
    );
    assert.deepEqual(skips, [0, 100]);
    assert.equal(result.items.length, 100);
    assert.equal(result.complete, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMaxPages === undefined) delete process.env.MORPHO_LIQUIDATION_MAX_PAGES;
    else process.env.MORPHO_LIQUIDATION_MAX_PAGES = originalMaxPages;
  }
});

test('liquidation pagination reports an incomplete snapshot when the configured page cap is reached', async () => {
  const originalFetch = globalThis.fetch;
  const originalMaxPages = process.env.MORPHO_LIQUIDATION_MAX_PAGES;
  process.env.MORPHO_LIQUIDATION_MAX_PAGES = '1';
  globalThis.fetch = async () => new Response(
    JSON.stringify({ data: { marketPositions: { items: Array.from({ length: 100 }, (_, i) => ({ id: i })) } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  try {
    const result = await fetchLiquidationPositionPages('https://morpho.test/graphql', 8453);
    assert.equal(result.items.length, 100);
    assert.equal(result.complete, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMaxPages === undefined) delete process.env.MORPHO_LIQUIDATION_MAX_PAGES;
    else process.env.MORPHO_LIQUIDATION_MAX_PAGES = originalMaxPages;
  }
});

test('watchlist reconciliation removes recovered GraphQL positions but preserves manual and other-chain rows', () => {
  clearWatchlistMemory();
  const keptKey = `base:${marketId}:${borrowerA.toLowerCase()}`;
  const staleKey = `base:${marketId}:${borrowerB.toLowerCase()}`;
  upsertWatchlistEntry(watchlistEntry({
    key: keptKey,
    chain: 'base',
    borrower: borrowerA,
    source: 'graphql-indexer',
  }));
  upsertWatchlistEntry(watchlistEntry({
    key: staleKey,
    chain: 'base',
    borrower: borrowerB,
    source: 'graphql-indexer',
  }));
  upsertWatchlistEntry(watchlistEntry({
    key: 'ethereum:manual-entry',
    chain: 'ethereum',
    borrower: borrowerB,
    source: 'graphql-indexer',
  }));
  upsertWatchlistEntry(watchlistEntry({
    key: 'base:manual-entry',
    chain: 'base',
    borrower: borrowerB,
    source: 'manual',
  }));

  pruneGraphqlWatchlist('base', new Set([keptKey]));

  assert.deepEqual(
    getAtRiskWatchlist().map((entry) => entry.key).sort(),
    ['base:manual-entry', keptKey, 'ethereum:manual-entry'].sort(),
  );
  clearWatchlistMemory();
});

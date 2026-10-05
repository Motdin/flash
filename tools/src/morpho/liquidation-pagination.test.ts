import assert from 'node:assert/strict';
import test from 'node:test';
import { evmChains } from '../config/chains.js';
import { fetchLiquidationPositionPages } from './liquidation-scanner.js';
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

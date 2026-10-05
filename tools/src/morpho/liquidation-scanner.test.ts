import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicClient, Address } from 'viem';
import { quoteVerifiedLiquidation, liquidationRepayment, clearWatchlistMemory, getAtRiskWatchlist } from './liquidation-scanner.js';
import type { ScannedAsset } from './scanner.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const asset = (n: number): ScannedAsset => ({ address: addr(n), symbol: `T${n}`, decimals: 18,
  balance: 10000n * 10n ** 18n, formattedBalance: '10000', priceUsd: 1,
  priceTimestamp: Math.floor(Date.now()/1000), priceSource: 'morpho-api', usdValue: 10000, eligible: true, sources: [] });
const UNIT = 10n ** 18n;
function fixture(healthy = false, quote = true) {
  let calls = 0;
  const client = {
    readContract: async (r: {functionName: string; args: unknown[]}) => {
      if (r.functionName === 'idToMarketParams') return [addr(1), addr(2), addr(3), addr(4), 86n * 10n ** 16n];
      assert.equal(r.functionName, 'getAmountsOut'); calls++;
      return quote ? [r.args[0], r.args[0]] : [0n, 0n];
    },
    multicall: async (r: {contracts: {functionName: string}[]; batchSize: number}) => {
      assert.deepEqual(r.contracts.map(c => c.functionName), ['accrueInterest', 'market', 'position', 'price']);
      assert.equal(r.batchSize, 0);
      return [undefined, [0n,0n,9000n*UNIT,9000n*UNIT*1_000_000n,0n,0n],
        [0n,9000n*UNIT*1_000_000n, (healthy ? 20000n : 10000n)*UNIT], 10n**36n];
    }
  } as unknown as PublicClient;
  return { params: { client, morpho: addr(8), chainKey: 'base', marketId: `0x${'ab'.repeat(32)}` as const, borrower: addr(9),
    assets: [asset(1), asset(2)], routers: [{name: 'fixture', address: addr(7), protocol: 'custom-v2' as const, kind: 0 as const, feeBps: 30}],
    gasCostUsd: 1, minProfitUsd: 5, maxSlippageBps: 30 }, calls: () => calls };
}
test('verified liquidation uses transiently accrued debt and actual collateral swap quote', async () => {
  clearWatchlistMemory(); const f = fixture();
  const result = await quoteVerifiedLiquidation(f.params);
  assert.ok(result); assert.equal(f.calls(), 1);
  assert.ok(result.profitable); assert.ok(result.seizedAssets < 10000n*UNIT);
  assert.equal(result.expectedLoanTokenOut, result.seizedAssets);
  assert.equal(result.grossProfit, result.expectedLoanTokenOut - result.repaidAssets);
  assert.equal(getAtRiskWatchlist().length, 1);
  assert.equal(await quoteVerifiedLiquidation(fixture(true).params), null);
  assert.equal(getAtRiskWatchlist().length, 0);
});
test('missing swap quote or stale USD prices cannot create liquidation candidates', async () => {
  assert.equal(await quoteVerifiedLiquidation(fixture(false, false).params), null);
  const f = fixture(); f.params.assets[0].priceTimestamp = 1;
  assert.equal(await quoteVerifiedLiquidation(f.params), null); assert.equal(f.calls(), 0);
});
test('liquidation repayment rounds upward through virtual shares', () => {
  const repayment = liquidationRepayment(101n, 10n**36n, 10n**18n, 1000n, 30n);
  assert.ok(repayment >= 101n);
  assert.equal(liquidationRepayment(0n, 10n**36n, 10n**18n, 1000n, 30n), 0n);
});

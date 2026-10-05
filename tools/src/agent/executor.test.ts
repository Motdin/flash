import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address } from '../config/registry.js';
import type {
  ArbitrageExecutionPlan,
} from './llm-operator.js';
import type { SwapHopStepQuote } from '../morpho/dex-scanner.js';
import { isAutomaticAllowlistBlocked, resolveAutoAllowlistTargets } from './executor.js';
import { loadLlmOperatorConfig } from './llm-operator.js';

const TOKEN_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Address;
const TOKEN_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Address;
const TOKEN_C = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as Address;
const TOKEN_D = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' as Address;
const ROUTER_1 = '0x1111111111111111111111111111111111111111' as Address;
const ROUTER_2 = '0x2222222222222222222222222222222222222222' as Address;
const ROUTER_3 = '0x3333333333333333333333333333333333333333' as Address;

function makeHop(router: Address, tokenIn: Address, tokenOut: Address): SwapHopStepQuote {
  return {
    router,
    routerName: `router-${router.slice(-2)}`,
    kind: 0,
    fee: 0,
    stable: false,
    factory: '0x0000000000000000000000000000000000000000' as Address,
    tokenIn,
    tokenInSymbol: 'IN',
    tokenOut,
    tokenOutSymbol: 'OUT',
    expectedAmountOut: 1n,
    minAmountOut: 1n,
  };
}

function makePlan(overrides: Partial<ArbitrageExecutionPlan>): ArbitrageExecutionPlan {
  return {
    candidateId: 'base:arb:test',
    loanToken: TOKEN_A,
    loanSymbol: 'A',
    loanDecimals: 18,
    intermediateToken: TOKEN_B,
    intermediateSymbol: 'B',
    firstRouter: ROUTER_1,
    firstRouterName: 'router-1',
    firstRouterKind: 0,
    firstRouterFee: 0,
    firstRouterStable: false,
    firstRouterFactory: '0x0000000000000000000000000000000000000000' as Address,
    secondRouter: ROUTER_2,
    secondRouterName: 'router-2',
    secondRouterKind: 0,
    secondRouterFee: 0,
    secondRouterStable: false,
    secondRouterFactory: '0x0000000000000000000000000000000000000000' as Address,
    loanAmount: 1n,
    formattedLoanAmount: '1',
    minIntermediateAmount: 1n,
    minFinalAmount: 1n,
    minProfit: 1n,
    expectedGrossProfitUsd: 10,
    expectedNetProfitUsd: 5,
    spreadBps: 25,
    deadlineSeconds: 120,
    autoAllowlistBeforeExec: true,
    ...overrides,
  };
}

test('2-hop plan allowlists exactly the loan token, intermediate token, and both routers', () => {
  const plan = makePlan({ isMultiHop: false });

  const { tokens, routers } = resolveAutoAllowlistTargets(plan);

  assert.deepEqual(tokens, [TOKEN_A, TOKEN_B]);
  assert.deepEqual(routers, [ROUTER_1, ROUTER_2]);
});

test('triangular 3-hop plan allowlists every hop token, not just the first intermediate', () => {
  // Route: A -> B -> C -> A (the final hop returns to the loan token)
  const plan = makePlan({
    isMultiHop: true,
    intermediateToken: TOKEN_B,
    intermediateSymbol: 'B->C',
    steps: [
      makeHop(ROUTER_1, TOKEN_A, TOKEN_B),
      makeHop(ROUTER_2, TOKEN_B, TOKEN_C),
      makeHop(ROUTER_1, TOKEN_C, TOKEN_A),
    ],
  });

  const { tokens } = resolveAutoAllowlistTargets(plan);

  // Regression guard: TOKEN_C used to be omitted, causing executeMultiHopArbitrage to revert
  // with TokenNotAllowed() on the third hop.
  assert.deepEqual(tokens, [TOKEN_A, TOKEN_B, TOKEN_C]);
});

test('triangular plan allowlists the alternate middle router instead of only first/last', () => {
  // firstRouter === secondRouter === ROUTER_1, the middle hop uses ROUTER_2.
  const plan = makePlan({
    isMultiHop: true,
    firstRouter: ROUTER_1,
    secondRouter: ROUTER_1,
    steps: [
      makeHop(ROUTER_1, TOKEN_A, TOKEN_B),
      makeHop(ROUTER_2, TOKEN_B, TOKEN_C),
      makeHop(ROUTER_1, TOKEN_C, TOKEN_A),
    ],
  });

  const { routers } = resolveAutoAllowlistTargets(plan);

  // Regression guard: ROUTER_2 used to be omitted, causing RouterNotAllowed().
  assert.deepEqual(routers, [ROUTER_1, ROUTER_2]);
});

test('4-hop plan covers all tokens and routers with duplicates removed', () => {
  const plan = makePlan({
    isMultiHop: true,
    steps: [
      makeHop(ROUTER_1, TOKEN_A, TOKEN_B),
      makeHop(ROUTER_2, TOKEN_B, TOKEN_C),
      makeHop(ROUTER_3, TOKEN_C, TOKEN_D),
      makeHop(ROUTER_1, TOKEN_D, TOKEN_A),
    ],
  });

  const { tokens, routers } = resolveAutoAllowlistTargets(plan);

  assert.deepEqual(tokens, [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D]);
  assert.deepEqual(routers, [ROUTER_1, ROUTER_2, ROUTER_3]);
});

test('de-duplication is case-insensitive so checksum variants do not double-spend gas', () => {
  // Identical address to TOKEN_D, only the hex casing differs (EIP-55 checksum variants).
  const TOKEN_D_MIXED_CASE = '0xdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdD' as Address;
  const plan = makePlan({
    isMultiHop: true,
    steps: [
      makeHop(ROUTER_1, TOKEN_A, TOKEN_D_MIXED_CASE),
      makeHop(ROUTER_1, TOKEN_D, TOKEN_A),
    ],
  });

  const { tokens, routers } = resolveAutoAllowlistTargets(plan);

  assert.equal(
    TOKEN_D_MIXED_CASE.toLowerCase(),
    TOKEN_D.toLowerCase(),
    'fixture sanity: both spellings must be the same address',
  );
  assert.equal(tokens.length, 2, 'A + D must not yield a duplicate casing variant of D');
  assert.deepEqual(
    tokens.map((t) => t.toLowerCase()),
    [TOKEN_A.toLowerCase(), TOKEN_D.toLowerCase()],
  );
  assert.deepEqual(routers, [ROUTER_1], 'a router repeated across every hop must appear once');
});

test('empty steps array falls back to the 2-hop field set', () => {
  const plan = makePlan({ isMultiHop: true, steps: [] });

  const { tokens, routers } = resolveAutoAllowlistTargets(plan);

  assert.deepEqual(tokens, [TOKEN_A, TOKEN_B]);
  assert.deepEqual(routers, [ROUTER_1, ROUTER_2]);
});


test('WHITELIST_AUTO_SYNC=false blocks SYNC_WHITELIST and arbitrage auto-allowlisting', () => {
  const config = loadLlmOperatorConfig({ whitelistAutoSync: false });
  const syncDecision = { action: 'SYNC_WHITELIST' } as const;
  const arbDecision = {
    action: 'EXECUTE_ARBITRAGE',
    arbitragePlan: makePlan({ autoAllowlistBeforeExec: true }),
  } as const;
  const preWhitelistedArbDecision = {
    action: 'EXECUTE_ARBITRAGE',
    arbitragePlan: makePlan({ autoAllowlistBeforeExec: false }),
  } as const;

  assert.equal(isAutomaticAllowlistBlocked(syncDecision as never, config), true);
  assert.equal(isAutomaticAllowlistBlocked(arbDecision as never, config), true);
  assert.equal(isAutomaticAllowlistBlocked(preWhitelistedArbDecision as never, config), false);
  assert.equal(
    isAutomaticAllowlistBlocked(syncDecision as never, loadLlmOperatorConfig({ whitelistAutoSync: true })),
    false,
  );
});
